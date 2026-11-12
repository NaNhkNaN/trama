import { spawn } from "child_process";
import {
  readFileSync, writeFileSync, appendFileSync,
  readdirSync, copyFileSync, mkdirSync, existsSync, statSync,
  symlinkSync, rmSync, lstatSync, readlinkSync,
  cpSync, mkdtempSync, openSync, closeSync, realpathSync,
} from "fs";
import { join, dirname } from "path";
import { homedir, tmpdir } from "os";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";
import type { ShellResult, Workspace } from "./types.js";
import type { RunOptions, TramaConfig, ProgramResult } from "./runner-types.js";
import { rejectOnAbort, type AgentBackend } from "./agent-backend.js";
import { PiAdapter } from "./pi-adapter.js";
import { createContext } from "./context.js";
import { createAgent, stripCodeFences } from "./agent.js";
import { createTools } from "./tools.js";
import { createWorkspace } from "./workspace.js";
import { guardPath } from "./path-guard.js";
import { createAllowance, stopGroups, superviseChild, type ChildExit } from "./child-process.js";
import { removeTempDir, removeWithThisProcess, requireWatchdog, stopWithThisProcess } from "./watchdog.js";
import { createIPCServer, listen, closeServer } from "./ipc-server.js";

// --- Locating the runtime itself ---

/** The installed @trama-dev/runtime package — this file lives in its dist/. */
const RUNTIME_PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * tsx lets node run program.ts. Resolved through the module system, so any
 * install layout works. It is loaded into the program's own node process
 * rather than run as the `tsx` command, which puts a process of its own in
 * front of the program: one that kills the program some 60 ms after a SIGTERM
 * it has not acted on, and reports its death by signal as an exit code.
 */
const TSX_LOADER = import.meta.resolve("tsx");

/**
 * The @trama-dev packages a program.ts can import, and where they are installed.
 * The runtime always; the session layer when it is installed alongside (as it
 * is with the CLI). The runtime never imports the session layer itself — it
 * only makes it reachable from projects.
 */
const IMPORTABLE_PACKAGES: Record<string, string> = { runtime: RUNTIME_PACKAGE_DIR };
try {
  // Resolves to <package>/dist/index.js
  IMPORTABLE_PACKAGES.session = dirname(dirname(fileURLToPath(import.meta.resolve("@trama-dev/session"))));
} catch { /* not installed — programs simply cannot import it */ }

// --- Project scaffolding ---

/**
 * Point the project's node_modules/@trama-dev/<name> at an installed package,
 * so program.ts can import it. Replaces any existing symlink whose target
 * differs (including user-managed ones). Only refuses to touch a real
 * directory/file to avoid destroying user content.
 */
function linkPackage(projectDir: string, name: string, target: string): void {
  // The link deliberately points OUTSIDE the project — do not apply guardPath here.
  const linkDir = join(projectDir, "node_modules", "@trama-dev");
  const linkPath = join(linkDir, name);

  try {
    if (!lstatSync(linkPath).isSymbolicLink()) {
      throw new Error(
        `${linkPath} exists and is not a symlink. ` +
        `trama needs this path for module resolution. ` +
        `Remove it manually or rename it to proceed.`
      );
    }
    if (readlinkSync(linkPath) === target) return;
    rmSync(linkPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  mkdirSync(linkDir, { recursive: true });
  symlinkSync(target, linkPath, "dir");
}

/** Make sure package.json exists and declares an ES module (program.ts uses top-level await). */
function ensureModulePackageJson(projectDir: string): void {
  const pkgPath = guardPath(projectDir, "package.json");
  if (!existsSync(pkgPath)) {
    writeFileSync(pkgPath, JSON.stringify({ type: "module" }, null, 2));
    return;
  }
  const advice = "trama will not overwrite it automatically; fix or remove it and try again.";
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `Malformed package.json at ${pkgPath}. ${advice}\n` +
      `Parse error: ${err instanceof Error ? err.message : err}`
    );
  }
  if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) {
    throw new Error(
      `Malformed package.json at ${pkgPath} — expected a JSON object but got ${
        Array.isArray(pkg) ? "an array" : typeof pkg
      }. ${advice}`
    );
  }
  const pkgObj = pkg as Record<string, unknown>;
  if (pkgObj.type !== "module") {
    pkgObj.type = "module";
    writeFileSync(pkgPath, JSON.stringify(pkgObj, null, 2));
  }
}

/** Make sure .gitignore excludes what trama generates, without disturbing existing entries. */
function ensureGitignore(projectDir: string): void {
  const giPath = guardPath(projectDir, ".gitignore");
  const required = ["node_modules/", "state.json", "logs/", "history/"];
  const existing = existsSync(giPath) ? readFileSync(giPath, "utf-8") : "";
  const present = new Set(existing.split("\n").map(line => line.trim()));
  const missing = required.filter(entry => !present.has(entry));
  if (missing.length === 0) return;
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  writeFileSync(giPath, existing + separator + missing.join("\n") + "\n");
}

/**
 * Everything a project directory needs around program.ts before it can run:
 * history/ and logs/, an ESM package.json, .gitignore entries, and links to the
 * @trama-dev packages it can import.
 * Idempotent — called before every run, so a freshly cloned project just works.
 */
export function ensureProjectScaffold(projectDir: string): void {
  mkdirSync(guardPath(projectDir, "history"), { recursive: true });
  mkdirSync(guardPath(projectDir, "logs"), { recursive: true });
  ensureModulePackageJson(projectDir);
  ensureGitignore(projectDir);
  for (const [name, target] of Object.entries(IMPORTABLE_PACKAGES)) linkPackage(projectDir, name, target);
}

// --- The API reference shown to the LLM ---

/**
 * The program-facing API, as shown to the LLM when it writes or repairs a
 * program. This is the declaration file generated from types.ts, so the prompt
 * cannot drift from the real API — doc comments included.
 */
export const RUNTIME_TYPES = [
  "// @trama-dev/runtime - Complete API",
  readFileSync(new URL("./types.d.ts", import.meta.url), "utf-8").trim(),
  [
    "export declare const ctx: Ctx;",
    "export declare const agent: Agent;",
    "export declare const tools: Tools;",
    "export declare const workspace: Workspace;",
  ].join("\n"),
].join("\n\n");

// --- Config & state loaders ---

export function loadConfig(): TramaConfig {
  const configPath = join(homedir(), ".trama", "config.json");
  const defaults: TramaConfig = {
    provider: "anthropic",
    model: "claude-opus-5-5",
    maxRepairAttempts: 3,
    defaultTimeout: 300_000,
    defaultMaxIterations: 100,
  };
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaults;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Malformed config at ${configPath} — fix or delete it.\n` +
      `Parse error: ${err instanceof Error ? err.message : err}`
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Malformed config at ${configPath} — expected a JSON object but got ${
        Array.isArray(parsed) ? "an array" : typeof parsed
      }. Fix or delete it to proceed.`
    );
  }
  const merged: TramaConfig = { ...defaults, ...(parsed as Record<string, unknown>) };
  const s = (v: unknown) => typeof v === "string" && v.length > 0;
  const pint = (v: unknown) => Number.isInteger(v) && (v as number) > 0;
  const checks: Array<[boolean, string]> = [
    [s(merged.provider), `"provider" must be a non-empty string (got ${JSON.stringify(merged.provider)})`],
    [s(merged.model), `"model" must be a non-empty string (got ${JSON.stringify(merged.model)})`],
    [Number.isInteger(merged.maxRepairAttempts) && merged.maxRepairAttempts >= 0, `"maxRepairAttempts" must be a non-negative integer (got ${merged.maxRepairAttempts})`],
    [Number.isFinite(merged.defaultTimeout) && merged.defaultTimeout > 0, `"defaultTimeout" must be a positive number (got ${merged.defaultTimeout})`],
    [pint(merged.defaultMaxIterations), `"defaultMaxIterations" must be a positive integer (got ${merged.defaultMaxIterations})`],
  ];
  for (const [ok, msg] of checks) {
    if (!ok) throw new Error(`Invalid config: ${msg}`);
  }
  return merged;
}

/** The global config, with the model/provider a project was created with taking precedence. */
export function loadProjectConfig(projectDir: string): TramaConfig {
  const config = loadConfig();
  const meta = JSON.parse(readFileSync(guardPath(projectDir, "meta.json"), "utf-8"));
  if (meta.model) config.model = meta.model;
  if (meta.provider) config.provider = meta.provider;
  return config;
}

/**
 * What does the LLM work for a project. The only place that picks a backend:
 * everything else is handed one and does not know which it is.
 */
export function createBackend(config: TramaConfig): AgentBackend {
  const backend = new PiAdapter(config);
  // The interface promises that a cancelled call rejects, and a run's end
  // waits on that. Every backend is held to it here, rather than trusted with it.
  return { ask: (prompt, call) => rejectOnAbort(backend.ask(prompt, call), call.signal) };
}

export function loadState(projectDir: string): Record<string, unknown> {
  const statePath = guardPath(projectDir, "state.json");
  if (!existsSync(statePath)) return {};
  const raw = readFileSync(statePath, "utf-8");
  const fail = (reason: string): never => {
    throw new Error(
      `Corrupt state.json in ${projectDir} — cannot safely continue.\n${reason}\n` +
      `Back up or delete state.json to reset state.`
    );
  };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (err) {
    fail(`Parse error: ${err instanceof Error ? err.message : err}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(`Expected a JSON object but got ${Array.isArray(parsed) ? "array" : typeof parsed}.`);
  }
  return parsed as Record<string, unknown>;
}

// --- History management ---

/** Append one metadata line to history/index.jsonl. */
function appendHistoryIndex(projectDir: string, entry: Record<string, unknown>): void {
  appendFileSync(guardPath(projectDir, join("history", "index.jsonl")), JSON.stringify(entry) + "\n");
}

/** The index.jsonl field that carries the detail for each kind of versioned change. */
const HISTORY_DETAIL_FIELD: Record<string, string> = { create: "prompt", update: "prompt", repair: "error" };

/**
 * Save the current program.ts as the next version: copy it to history/NNNN.ts
 * and record why in index.jsonl.
 *
 * (See installValidatedProgram for how a create or update is recorded.)
 */
export function copyToHistory(projectDir: string, reason: string, detail?: string) {
  const historyDir = guardPath(projectDir, "history");
  const versions = readdirSync(historyDir)
    .filter(f => /^\d+\.ts$/.test(f))
    .map(f => parseInt(f, 10));
  const version = versions.reduce((a, b) => Math.max(a, b), 0) + 1;
  const fileName = `${String(version).padStart(4, "0")}.ts`;

  copyFileSync(guardPath(projectDir, "program.ts"), guardPath(projectDir, join("history", fileName)));

  const entry: Record<string, unknown> = { version, reason, timestamp: new Date().toISOString() };
  const detailField = HISTORY_DETAIL_FIELD[reason];
  if (detailField && detail) entry[detailField] = detail;
  appendHistoryIndex(projectDir, entry);
}

// --- Staging: run against a copy, merge back what worked ---

type DirSnapshot = Map<string, { size: number; mtimeMs: number }>;

/** Record all files in a directory with their size and mtime for change detection. */
export function snapshotDir(dir: string, prefix = ""): DirSnapshot {
  const result: DirSnapshot = new Map();
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [k, v] of snapshotDir(fullPath, relPath)) result.set(k, v);
    } else if (entry.isFile()) {
      try {
        const st = statSync(fullPath);
        result.set(relPath, { size: st.size, mtimeMs: st.mtimeMs });
      } catch { /* skip */ }
    }
  }
  return result;
}

const sameStat = (a: { size: number; mtimeMs: number }, b: { size: number; mtimeMs: number }) =>
  a.size === b.size && a.mtimeMs === b.mtimeMs;

/**
 * Merge what a run did to a staged copy back into the real directory, with a
 * three-way check so that nothing changed in the real directory meanwhile —
 * by the user, or by another run of the same project — is overwritten.
 *
 * @param stagedDir - the copy after the run (source of changes)
 * @param realDir - the real directory (destination)
 * @param stagedBefore - snapshot of the copy before the run (detects what the run changed)
 * @param realSeed - snapshot of the real directory when the copy was taken (detects concurrent changes)
 *
 * For each file the run touched in the copy:
 * - Created: copied, unless that path has meanwhile appeared in the real directory.
 * - Modified: copied only if the real file still matches realSeed.
 * - Deleted: deleted only if the real file still matches realSeed.
 * Best-effort: anything that cannot be merged safely is skipped, never thrown.
 */
export function commitStagedChanges(
  stagedDir: string,
  realDir: string,
  stagedBefore: DirSnapshot,
  realSeed: DirSnapshot,
): void {
  const stagedAfter = snapshotDir(stagedDir);
  /** The real file as it is now — but only if nobody has touched it since the copy was taken. */
  const untouchedSinceSeed = (relPath: string, dstPath: string): boolean => {
    const seedStat = realSeed.get(relPath);
    const realNow = statSync(dstPath, { throwIfNoEntry: false });
    return seedStat === undefined || (realNow !== undefined && sameStat(realNow, seedStat));
  };

  for (const relPath of new Set([...stagedBefore.keys(), ...stagedAfter.keys()])) {
    const beforeStat = stagedBefore.get(relPath);
    const afterStat = stagedAfter.get(relPath);
    if (beforeStat && afterStat && sameStat(beforeStat, afterStat)) continue; // the run didn't touch it

    try {
      // A symlink placed at this path, or in a parent directory, could point
      // outside the real directory — guardPath throws.
      const dstPath = guardPath(realDir, relPath);

      if (!afterStat) {
        if (untouchedSinceSeed(relPath, dstPath)) rmSync(dstPath, { force: true });
      } else if (beforeStat) {
        if (!untouchedSinceSeed(relPath, dstPath)) continue; // changed or removed concurrently
        copyFileSync(join(stagedDir, relPath), dstPath);
      } else {
        if (statSync(dstPath, { throwIfNoEntry: false })) continue; // someone else created it first — keep theirs
        mkdirSync(dirname(dstPath), { recursive: true });
        copyFileSync(join(stagedDir, relPath), dstPath);
      }
    } catch {
      // Escapes the directory, path-shape conflict, permissions — skip
    }
  }
}

/** Run fn in a temp directory, clean up afterwards regardless of outcome — including this process being stopped. */
export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const settled = removeWithThisProcess(dir);
  try {
    return await fn(dir);
  } finally {
    removeTempDir(dir);
    settled();
  }
}

/** Copy a directory's contents into an existing one, keeping symlinks as they are written. */
function copyDirInto(srcDir: string, dstDir: string): void {
  // realpath: a project directory may itself be a symlink.
  cpSync(realpathSync(srcDir), dstDir, { recursive: true, verbatimSymlinks: true });
}

/**
 * Run fn against a private copy of a directory. What fn does there stays
 * invisible to the real directory unless fn asks to commit it — then it is
 * merged back (see commitStagedChanges). If fn fails, or this process is
 * stopped half-way, the real directory was never touched.
 */
async function withStagedCopy<T>(
  realDir: string,
  fn: (stagedDir: string) => Promise<{ commit: boolean; value: T }>,
): Promise<T> {
  const realSeed = snapshotDir(realDir);
  return withTempDir("trama-staged-", async (stagedDir) => {
    copyDirInto(realDir, stagedDir);
    const stagedBefore = snapshotDir(stagedDir);
    const { commit, value } = await fn(stagedDir);
    if (commit) commitStagedChanges(stagedDir, realDir, stagedBefore, realSeed);
    return value;
  });
}

// --- Single program execution ---

interface RunOnceOptions {
  /** The project to run. It is also where the program's agent calls work. */
  projectDir: string;
  backend: AgentBackend;
  timeout: number;
  maxIterations: number;
  argsOverride?: Record<string, unknown>;
  /**
   * The run is a validation: it only has to show that the program works, and
   * goes no further than the program's own work. The program is stopped
   *  - once it has called ctx.ready() and stayed up for readyGraceMs (a
   *    program that runs until it is stopped). It passes if it then shuts
   *    down properly: stopping cleanly is part of what such a program is for.
   *  - the moment it asks for another program to be run. That run is not
   *    started — what happens between programs is not what is being
   *    validated, and would be a real run with real effects — and the program
   *    has passed there and then. How it goes down, cut off in mid-flow, says
   *    nothing about it.
   */
  validating?: { readyGraceMs: number };
  /** Shared workspace directory. When set, the workspace.* API is enabled. */
  workspaceDir?: string;
  /** How many runs deep this one is: 0 for a run nobody's program asked for. */
  depth: number;
  /** Shown in front of each line of the program's output. */
  label?: string;
  /** Stops the run. */
  signal?: AbortSignal;
}

interface RunOnceResult {
  /** How the run ended, or null if it failed (non-zero exit with no terminal signal). */
  outcome: ProgramResult | null;
  /** A description of the failure, for the repair prompt and for the user. */
  failure: string;
}

/** The end of a long output — where the error is — with a note of how much was dropped. */
function tail(text: string, max = 20_000): string {
  return text.length <= max ? text : `[… ${text.length - max} earlier characters omitted]\n${text.slice(-max)}`;
}

/** A line as it is shown for a run: under the run's name, if it has one. */
const tagged = (label: string | undefined, line: string) => label ? `[${label}] ${line}` : line;

/** The longest stretch of output held back while waiting for its line to end. */
const MAX_HELD_LINE = 64 * 1024;

/** Put a label in front of each line written to a stream. `flush` writes out a last line that had no newline. */
function labelled(label: string, write: (text: string) => void) {
  let held = "";
  const flush = () => {
    if (held) write(tagged(label, held) + "\n");
    held = "";
  };
  return {
    sink(chunk: string) {
      const end = chunk.lastIndexOf("\n");
      if (end === -1) {
        held += chunk;
        if (held.length > MAX_HELD_LINE) flush(); // a line with no end in sight is shown in pieces
        return;
      }
      const lines = (held + chunk.slice(0, end)).split("\n");
      held = chunk.slice(end + 1);
      write(lines.map(line => tagged(label, line) + "\n").join(""));
    },
    flush,
  };
}

const describeFailure = (r: ShellResult) =>
  `program.ts exited with code ${r.exitCode}\nstdout: ${tail(r.stdout)}\nstderr: ${tail(r.stderr)}`;

/**
 * Hand the program its starting state through a private temp file rather than
 * env vars — no OS size limit, and mode 0600 in an unpredictable directory
 * keeps it (and the bridge secret in it) from other local users.
 */
function writeInitFile(dir: string, payload: unknown): string {
  const file = join(dir, "init.json");
  const fd = openSync(file, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(payload));
  } finally {
    closeSync(fd);
  }
  return file;
}

function toChildResult(exit: ChildExit): ShellResult {
  const { stdout, stderr } = exit;
  if (exit.timedOut) return { exitCode: 1, stdout, stderr: stderr + "\n[trama] program killed: timeout" };
  // Stopped by us at the end of a validation — going down on SIGTERM is the expected outcome.
  if (exit.stopped && (exit.code === 0 || exit.signal === "SIGTERM")) return { exitCode: 0, stdout, stderr };
  return { exitCode: exit.code ?? 1, stdout, stderr };
}

/**
 * Decide how a finished run ended. A terminal signal the program completed
 * takes precedence over its exit code: a program that called ctx.done() and
 * then crashed is done. Returns null for a failure (non-zero exit, no signal).
 */
function settle(projectDir: string, child: ShellResult, terminalSignal: ProgramResult | null): ProgramResult | null {
  // Read state first: if the program left state.json corrupt, say so now
  // rather than report an outcome (or start a repair) on top of it.
  const state = loadState(projectDir);
  if (terminalSignal) return terminalSignal;
  if (child.exitCode !== 0) return null;

  // Natural success without done() or yield(): if this run was the resumption
  // of an earlier yield, that yield is now over — don't let its marker make
  // the next run look resumed.
  if (state.__trama_yield != null) {
    delete state.__trama_yield;
    writeFileSync(guardPath(projectDir, "state.json"), JSON.stringify(state, null, 2));
  }
  return { status: "done" };
}

/**
 * Run program.ts once in the given directory: scaffold, start the IPC server,
 * spawn the program, wait for it, tear everything down, and say how it ended.
 * The program's output is echoed as it runs. A program that fails is a result,
 * not an exception — this throws only when the run could not happen at all
 * (bad project, server or spawn failure) or left state.json unreadable.
 */
async function runProgramOnce(options: RunOnceOptions): Promise<RunOnceResult> {
  const { projectDir, backend, timeout, maxIterations, argsOverride, validating, workspaceDir, label, signal } = options;

  if (signal?.aborted) return { outcome: null, failure: "The run was stopped before its program started." };
  requireWatchdog();
  ensureProjectScaffold(projectDir);

  // Cancels in-flight LLM calls, fetches and observes once the run is over.
  const runEnded = new AbortController();
  // Ends a validation: the program has shown what it had to, and is asked to stop.
  const validated = new AbortController();
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  let terminalSignal: ProgramResult | null = null;

  const ctx = createContext(projectDir, loadState(projectDir), {
    maxIterations,
    argsOverride,
    onReady: validating && (() => {
      readyTimer ??= setTimeout(() => validated.abort(), validating.readyGraceMs).unref();
    }),
    print: line => console.log(tagged(label, line)),
  });
  // Truncate logs only after preflight succeeds — preserves the prior run's
  // diagnostics if scaffolding, state loading, or context creation fails.
  writeFileSync(guardPath(projectDir, join("logs", "latest.jsonl")), "");

  // The program's own time. It stops while a run the program asked for is in flight.
  const allowance = createAllowance(timeout);
  // Set when a validation ended because the program asked for another to be run.
  let handedOff = false;
  // Runs the program has asked for and that are still going. They belong to this run.
  const nestedRuns = new Set<Promise<unknown>>();
  const workspaces = new Map<string, Workspace>();
  const tools = createTools(projectDir, runEnded.signal);
  // Known only to this run's program, through its init file.
  const token = randomBytes(32).toString("hex");
  const server = createIPCServer({
    token,
    ctx,
    agent: createAgent(backend, projectDir, runEnded.signal),
    tools,
    workspace: workspaceDir ? createWorkspace(workspaceDir, runEnded.signal) : null,
    workspaceAt: (dir) => {
      let workspace = workspaces.get(dir);
      if (!workspace) workspaces.set(dir, workspace = createWorkspace(dir, runEnded.signal));
      return workspace;
    },
    run: (request, stop) => {
      if (validating) {
        // As far as a validation goes. The call is left unanswered — an answer
        // would only send the program on to do more — until the program,
        // which is being stopped, lets go of it.
        handedOff = true;
        validated.abort();
        return rejectOnAbort(new Promise<never>(() => {}), stop);
      }
      // The program is waiting, not working: its clock stops for as long as
      // the run it asked for lasts, which has a timeout of its own. That run
      // is stopped when this one ends, or when the program no longer wants it.
      const release = allowance.hold();
      const nested = runProgram(
        { ...request, signal: AbortSignal.any([runEnded.signal, stop]) },
        options.depth + 1,
      ).finally(() => {
        release();
        nestedRuns.delete(nested);
      });
      nestedRuns.add(nested);
      return nested;
    },
    // The first terminal signal wins; ctx itself rejects a conflicting second one.
    onTerminalSignal: result => { terminalSignal ??= result; },
  });

  // A participant's output is shown under its name. It is not its parent's
  // output: the runner writes it out itself, wherever in the tree it runs.
  const out = label ? labelled(label, text => process.stdout.write(text)) : null;
  const err = label ? labelled(label, text => process.stderr.write(text)) : null;

  // The program leads a process group of its own, so that everything it starts is in it.
  let programGroup: number | undefined;
  // If this process ends while the program is running, the watchdog stops the program.
  let programSettled = () => {};
  // Asked to stop while its program had not ended. Everything it has in flight
  // goes at once — the runs it asked for among them, so that a tree of runs is
  // stopped together rather than one level after another.
  let programOver = false;
  let stopped = false;
  const stopProgram = () => {
    if (programOver) return;
    stopped = true;
    runEnded.abort();
    if (programGroup) void stopGroups([programGroup]);
  };
  signal?.addEventListener("abort", stopProgram, { once: true });
  try {
    const child = await withTempDir("trama-init-", async (initDir) => {
      const port = await listen(server);
      const initFile = writeInitFile(initDir, {
        token,
        input: ctx.input,
        state: ctx.state,
        iteration: ctx.iteration,
        maxIterations: ctx.maxIterations,
        inSession: workspaceDir !== undefined,
        resumed: ctx.resumed,
        yieldReason: ctx.yieldReason,
      });

      const program = spawn(process.execPath, ["--import", TSX_LOADER, guardPath(projectDir, "program.ts")], {
        cwd: projectDir,
        env: { ...process.env, TRAMA_PORT: String(port), TRAMA_INIT: initFile },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      programGroup = program.pid;
      if (programGroup) programSettled = stopWithThisProcess(programGroup);
      if (signal?.aborted) stopProgram(); // asked to stop while the program was being started

      const exit = await superviseChild(program, {
        timeout: allowance,
        stopSignal: validating ? validated.signal : undefined,
        sinks: {
          stdout: out ? out.sink : chunk => { process.stdout.write(chunk); },
          stderr: err ? err.sink : chunk => { process.stderr.write(chunk); },
        },
      });
      programOver = true;
      // A validation that reached a hand-off in time was decided there.
      if (handedOff && !exit.timedOut) {
        console.log(tagged(label, "[trama] validated up to where it starts another program"));
        return { exitCode: 0, stdout: exit.stdout, stderr: exit.stderr };
      }
      return toChildResult(exit);
    });
    // A program that was stopped did not finish, whatever its exit code says —
    // unless it had already said it was done.
    const outcome = stopped && !terminalSignal ? null : settle(projectDir, child, terminalSignal);
    return { outcome, failure: describeFailure(child) };
  } finally {
    // The program is gone (or never started). Nothing it started outlives its
    // run: cancel the calls it left in flight — the runs it asked for among
    // them — and stop what is left of its process group and of its shell
    // commands. Only once they are gone is the run over: whoever called will
    // merge or delete what they were writing to.
    signal?.removeEventListener("abort", stopProgram);
    out?.flush();
    err?.flush();
    if (readyTimer) clearTimeout(readyTimer);
    runEnded.abort();
    await Promise.all([
      stopGroups(programGroup ? [programGroup] : []),
      tools.stopActiveShells(),
      Promise.allSettled([...nestedRuns]),
    ]);
    programSettled();
    server.closeAllConnections();
    await closeServer(server).catch(() => { /* best-effort */ });
  }
}

// --- Execution with repair ---

interface ExecuteOptions extends RunOnceOptions {
  maxRepairAttempts: number;
}

interface Execution {
  result: ProgramResult;
  /** Set when the program only worked after a repair: which attempt, and the failure it fixed. */
  repair?: { attempt: number; error: string };
}

/** The instructions a request for a fix is made under. (Exported so the tests' stand-in LLM can tell one from any other call.) */
export const REPAIR_SYSTEM_PROMPT = "You are a TypeScript repair tool.";

const repairPrompt = (input: { programSource: string; error: string }) =>
  `Fix this program so it runs.\n\n` +
  `Runtime types:\n${RUNTIME_TYPES}\n\n` +
  `Broken program:\n${input.programSource}\n\n` +
  `Error:\n${input.error}\n\n` +
  `Output ONLY the fixed program. No explanation.`;

/**
 * Ask the LLM for a fix. The agent has tools, so it works in a throwaway copy
 * of the project that holds the program it is asked to fix — whatever it reads
 * is real, whatever it writes is discarded; only the program text it returns
 * is used. Bounded by its own timeout.
 * Returns null (and records why) if no usable fix came back.
 */
async function requestRepair(
  options: ExecuteOptions,
  input: { programSource: string; error: string },
  repairErrors: string[],
): Promise<string | null> {
  return withTempDir("trama-repair-", async (tempDir) => {
    copyDirInto(options.projectDir, tempDir);
    writeFileSync(guardPath(tempDir, "program.ts"), input.programSource);
    const timedOut = new AbortController();
    const limit = createAllowance(options.timeout);
    limit.start(() => timedOut.abort());
    const signal = options.signal ? AbortSignal.any([timedOut.signal, options.signal]) : timedOut.signal;
    try {
      const fixed = stripCodeFences(await options.backend.ask(repairPrompt(input), {
        cwd: tempDir, system: REPAIR_SYSTEM_PROMPT, signal,
      }));
      if (fixed.trim() === "") throw new Error("The repair returned an empty program.");
      if (fixed === input.programSource) throw new Error("The repair returned the program unchanged.");
      return fixed;
    } catch (err) {
      repairErrors.push(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      limit.cancel();
    }
  });
}

/**
 * Try a proposed fix.
 *
 * The project is the program's own, so the fix runs on a private copy of it.
 * Only if it works does anything reach the real one — the fix becomes
 * program.ts, and what the run wrote is merged back. A fix that fails, or a
 * runner that is stopped half-way, leaves the project exactly as it was,
 * because it was never touched: its state is only ever written by code that
 * is, or becomes, its program.
 *
 * The shared workspace is not copied. It is how the participants of a session
 * talk to each other, and a program that is being fixed still has to be heard
 * and answered — a fix that wrote its requests where nobody could see them
 * would wait for replies forever. So what a fix writes there is written,
 * whether or not the fix works: like anything a run wrote before it failed.
 */
async function tryFix(options: ExecuteOptions, fixed: string): Promise<RunOnceResult> {
  const { projectDir } = options;
  const run = await withStagedCopy(projectDir, async (stagedProject) => {
    writeFileSync(guardPath(stagedProject, "program.ts"), fixed);
    // If the copy cannot be run at all, or is left unusable, this fix did not work either.
    const trial = await runProgramOnce({ ...options, projectDir: stagedProject }).catch((err): RunOnceResult => ({
      outcome: null,
      failure: `The repaired program could not be run: ${err instanceof Error ? err.message : err}`,
    }));
    return { commit: trial.outcome !== null, value: trial };
  });

  // The merge above carries over what the run changed; the fix itself was
  // written before the run started, so it is installed explicitly.
  if (run.outcome) writeFileSync(guardPath(projectDir, "program.ts"), fixed);
  return run;
}

/**
 * Run a program to an outcome. If it crashes, ask the LLM to repair it and try
 * the fix — up to maxRepairAttempts times.
 */
async function executeProgram(options: ExecuteOptions): Promise<Execution> {
  const { projectDir, maxRepairAttempts } = options;
  const failed = (reason: string): Execution => ({ result: { status: "failed", reason } });

  // A run that is stopped fails without a repair — there is nothing wrong with
  // the program. Checked after each step; a step that had already reached an
  // outcome keeps it.
  const stopped = () => options.signal?.aborted === true;
  const wasStopped = () => failed("The run was stopped before it finished.");
  if (stopped()) return wasStopped();

  const firstRun = await runProgramOnce(options);
  if (firstRun.outcome) return { result: firstRun.outcome };
  if (stopped()) return wasStopped();

  let lastError = firstRun.failure;
  if (maxRepairAttempts === 0) return failed(`Program failed (repair disabled): ${lastError}`);

  // Each attempt builds on the previous one's source, though a fix that failed never reached the project.
  let currentSource = readFileSync(guardPath(projectDir, "program.ts"), "utf-8");
  const repairErrors: string[] = [];
  const repairDetails = () => repairErrors.length > 0
    ? `\nRepair errors:\n${repairErrors.map((e, i) => `  [${i + 1}] ${e}`).join("\n")}` : "";

  for (let attempt = 0; attempt < maxRepairAttempts; attempt++) {
    const fixed = await requestRepair(options, { programSource: currentSource, error: lastError }, repairErrors);
    if (stopped()) return wasStopped();
    if (!fixed) return failed(`Failed after ${attempt + 1} repair attempt(s): ${lastError}${repairDetails()}`);
    currentSource = fixed;

    const run = await tryFix(options, fixed);
    if (run.outcome) return { result: run.outcome, repair: { attempt, error: lastError } };
    if (stopped()) return wasStopped();
    lastError = run.failure;
  }

  return failed(`Failed after ${maxRepairAttempts} repair attempts: ${lastError}${repairDetails()}`);
}

// --- Validating a candidate program (used by create and update) ---

const VALIDATION_READY_GRACE_MS = 2_000;

/**
 * Validate a candidate program.ts for a project without touching the project:
 * run it (with repair) in a throwaway copy. Returns the program that worked —
 * the candidate itself, or a repaired version of it, with the failure that was
 * repaired. Throws if it cannot be made to run.
 *
 * Only the project's own files are shielded. What the program does beyond
 * them — network calls, shell commands, agent calls — is real. A run it asks
 * its runner for is not started: the validation ends where it asks for the
 * first.
 */
export async function validateProgram(
  projectDir: string,
  backend: AgentBackend,
  candidate: string,
  options: { timeout: number; maxRepairAttempts: number; maxIterations: number },
): Promise<{ source: string; repairedError?: string }> {
  return withTempDir("trama-validate-", async (trialDir) => {
    copyDirInto(projectDir, trialDir);
    const programPath = guardPath(trialDir, "program.ts");
    writeFileSync(programPath, candidate);

    const { result, repair } = await executeProgram({
      ...options,
      projectDir: trialDir,
      backend,
      depth: 0,
      validating: { readyGraceMs: VALIDATION_READY_GRACE_MS },
    });
    if (result.status === "failed") {
      throw new Error(`Program failed: ${result.reason}`);
    }
    return { source: readFileSync(programPath, "utf-8"), repairedError: repair?.error };
  });
}

/**
 * Make a validated program the project's program.ts and record it as a new
 * version. A repair made while validating is not a version of its own — it is
 * noted in the history index only.
 */
export function installValidatedProgram(
  projectDir: string,
  validated: { source: string; repairedError?: string },
  reason: "create" | "update",
  prompt: string,
): void {
  writeFileSync(guardPath(projectDir, "program.ts"), validated.source);
  if (validated.repairedError) {
    appendHistoryIndex(projectDir, {
      reason: `${reason}-repair`, timestamp: new Date().toISOString(), error: validated.repairedError,
    });
  }
  copyToHistory(projectDir, reason, prompt);
}

// --- Core execution ---

/** How deep programs may run programs, and how many runs one runner carries at a time. */
const MAX_RUN_DEPTH = 16;
const MAX_RUNS_IN_FLIGHT = 128;
let runsInFlight = 0;

/**
 * Run a project, in this process: this is what a runner does.
 *
 * `depth` is how many runs deep this one is — 0 unless a program asked for it
 * (see the "/run/program" call), in which case it is one more than that
 * program's own. One runner carries the whole tree, so it is also where the
 * tree is kept from growing without bound.
 */
export async function runProgram(options: RunOptions, depth = 0): Promise<ProgramResult> {
  if (depth > MAX_RUN_DEPTH) {
    throw new Error(
      `Not running ${options.projectDir}: programs are running programs more than ${MAX_RUN_DEPTH} deep. ` +
      `A program that runs itself, or two that run each other, never ends.`
    );
  }
  if (runsInFlight >= MAX_RUNS_IN_FLIGHT) {
    throw new Error(`Not running ${options.projectDir}: ${MAX_RUNS_IN_FLIGHT} runs are already in flight.`);
  }
  runsInFlight += 1;
  try {
    return await runProject(options, depth);
  } finally {
    runsInFlight -= 1;
  }
}

async function runProject(options: RunOptions, depth: number): Promise<ProgramResult> {
  const { projectDir } = options;

  if (!existsSync(join(projectDir, "meta.json"))) {
    throw new Error(
      `Project not found at ${projectDir}. ` +
      `Run \`trama list\` to see available projects.`
    );
  }

  const config = loadProjectConfig(projectDir);
  const maxRepairAttempts = options.maxRepairAttempts ?? config.maxRepairAttempts;
  const timeout = options.timeout ?? config.defaultTimeout;

  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`Invalid timeout: ${timeout}. Must be a positive number.`);
  }
  if (!Number.isInteger(maxRepairAttempts) || maxRepairAttempts < 0) {
    throw new Error(`Invalid maxRepairAttempts: ${maxRepairAttempts}. Must be a non-negative integer.`);
  }

  const { result, repair } = await executeProgram({
    projectDir,
    backend: createBackend(config),
    maxRepairAttempts,
    timeout,
    maxIterations: config.defaultMaxIterations,
    argsOverride: options.args,
    workspaceDir: options.workspaceDir,
    depth,
    label: options.label,
    signal: options.signal,
  });

  if (repair) {
    // The program is fixed and has run; failing to write this down must not turn that into an error.
    try {
      const entry = { ts: Date.now(), message: `Repair attempt ${repair.attempt + 1}/${maxRepairAttempts}`, data: { error: repair.error } };
      appendFileSync(guardPath(projectDir, join("logs", "latest.jsonl")), JSON.stringify(entry) + "\n");
      console.log(tagged(options.label, `[trama] Repair attempt ${repair.attempt + 1}/${maxRepairAttempts}`));
      copyToHistory(projectDir, "repair", repair.error);
    } catch (err) {
      console.warn(tagged(options.label, `[trama] repair bookkeeping failed: ${err instanceof Error ? err.message : err}`));
    }
  }
  return result;
}
