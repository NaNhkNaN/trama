import { spawn } from "child_process";
import {
  readFileSync, writeFileSync, appendFileSync,
  readdirSync, mkdirSync, existsSync, statSync,
  symlinkSync, rmSync, lstatSync, readlinkSync,
  mkdtempSync, openSync, closeSync,
  accessSync, constants, truncateSync,
} from "fs";
import { join, dirname } from "path";
import { homedir, tmpdir } from "os";
import { fileURLToPath } from "url";
import { createHash, randomBytes } from "crypto";
import type { ShellResult, Workspace } from "./types.js";
import type { RunOptions, TramaConfig, ProgramResult } from "./runner-types.js";
import { onAbort, rejectOnAbort } from "./abort.js";
import type { AgentBackend } from "./agent-backend.js";
import { PiAdapter } from "./pi-adapter.js";
import { LATEST_LOG_PATH, appendLogEntry, createContext } from "./context.js";
import { createAgent, stripCodeFences } from "./agent.js";
import { createTools } from "./tools.js";
import { createWorkspace } from "./workspace.js";
import { guardPath, identityOf, realRootOf } from "./path-guard.js";
import { copyTree, entryAt, mergeTree, pathAsListed, readTree, type Tree } from "./tree.js";
import { stageFile, type StagedFile } from "./replace-file.js";
import { readProjectMeta } from "./meta.js";
import { describeJson, isJsonObject } from "./serializable.js";
import { createAllowance, superviseChild, type ChildExit } from "./child-process.js";
import { removeTempDir, removeWithThisProcess, requireWatchdog, stopGroups, stopWithThisProcess } from "./stopping.js";
import { createIPCServer, listen, closeServer } from "./ipc-server.js";
import { journalDirOf, openJournal, type Journal } from "./journal.js";

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
 *
 * The link points outside the project, and is meant to. Where it is put is
 * inside it, like everything else the runtime writes: a project whose
 * node_modules leads somewhere else is refused, not followed there.
 */
function linkPackage(projectDir: string, name: string, target: string): void {
  const linkDir = guardPath(projectDir, join("node_modules", "@trama-dev"));
  // Not through the guard: it is the link itself that is looked at and replaced, not what it points at.
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
  if (!isJsonObject(pkg)) {
    throw new Error(`Malformed package.json at ${pkgPath} — expected a JSON object but got ${describeJson(pkg)}. ${advice}`);
  }
  if (pkg.type !== "module") {
    pkg.type = "module";
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
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
    journalRuns: 20,
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
  if (!isJsonObject(parsed)) {
    throw new Error(
      `Malformed config at ${configPath} — expected a JSON object but got ${describeJson(parsed)}. Fix or delete it to proceed.`
    );
  }
  // null is how JSON says a field is not there.
  const given = Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== null));
  return checkedConfig({ ...defaults, ...given }, "config");
}

/** A config that holds what the runtime can work with — or an error naming what does not, and where it came from. */
function checkedConfig(merged: TramaConfig, source: string): TramaConfig {
  const s = (v: unknown) => typeof v === "string" && v.length > 0;
  const pint = (v: unknown) => Number.isInteger(v) && (v as number) > 0;
  const checks: Array<[boolean, string]> = [
    [s(merged.provider), `"provider" must be a non-empty string (got ${JSON.stringify(merged.provider)})`],
    [s(merged.model), `"model" must be a non-empty string (got ${JSON.stringify(merged.model)})`],
    [Number.isInteger(merged.maxRepairAttempts) && merged.maxRepairAttempts >= 0, `"maxRepairAttempts" must be a non-negative integer (got ${merged.maxRepairAttempts})`],
    [Number.isFinite(merged.defaultTimeout) && merged.defaultTimeout > 0, `"defaultTimeout" must be a positive number (got ${merged.defaultTimeout})`],
    [pint(merged.defaultMaxIterations), `"defaultMaxIterations" must be a positive integer (got ${merged.defaultMaxIterations})`],
    [Number.isInteger(merged.journalRuns) && merged.journalRuns >= 0, `"journalRuns" must be a non-negative integer (got ${merged.journalRuns})`],
  ];
  for (const [ok, msg] of checks) {
    if (!ok) throw new Error(`Invalid ${source}: ${msg}`);
  }
  return merged;
}

/** The global config, with the model/provider a project was created with taking precedence. */
export function loadProjectConfig(projectDir: string, meta = readProjectMeta(projectDir)): TramaConfig {
  const config = loadConfig();
  // null is how JSON says a field is not there. Anything else a project says
  // is taken, and held to what the global config is held to — an empty or
  // mistyped name is an error here, not a quiet return to another model.
  if (meta.model != null) config.model = meta.model;
  if (meta.provider != null) config.provider = meta.provider;
  return checkedConfig(config, `meta.json in ${projectDir}`);
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
  let raw: string;
  try {
    raw = readFileSync(statePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  function fail(reason: string): never {
    throw new Error(
      `Corrupt state.json in ${projectDir} — cannot safely continue.\n${reason}\n` +
      `Back up or delete state.json to reset state.`
    );
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (err) {
    fail(`Parse error: ${err instanceof Error ? err.message : err}`);
  }
  if (!isJsonObject(parsed)) {
    fail(`Expected a JSON object but got ${describeJson(parsed)}.`);
  }
  return parsed;
}

// --- History management ---

/** The index.jsonl field that carries the detail for each kind of versioned change. */
const HISTORY_DETAIL_FIELD: Record<string, string> = { create: "prompt", update: "prompt", repair: "error" };

/**
 * Add a version to a project's history: its text as history/NNNN.ts, and a
 * line in index.jsonl saying why (after `notes`, lines that belong with it).
 * Either all of it is written or none of it. Returns how to take it back, for
 * a caller whose own next step may still fail.
 */
function recordVersion(
  projectDir: string,
  source: string | Buffer,
  reason: string,
  detail?: string,
  notes: Array<Record<string, unknown>> = [],
): () => void {
  const historyDir = guardPath(projectDir, "history");
  const indexPath = guardPath(projectDir, join("history", "index.jsonl"));
  const versions = readdirSync(historyDir)
    .filter(f => /^\d+\.ts$/.test(f))
    .map(f => parseInt(f, 10));
  const version = versions.reduce((a, b) => Math.max(a, b), 0) + 1;
  const snapshot = guardPath(projectDir, join("history", `${String(version).padStart(4, "0")}.ts`));

  const entry: Record<string, unknown> = { version, reason, timestamp: new Date().toISOString() };
  const detailField = HISTORY_DETAIL_FIELD[reason];
  if (detailField && detail) entry[detailField] = detail;

  const lines = Buffer.from([...notes, entry].map(line => JSON.stringify(line) + "\n").join(""));
  const sizeBefore = statSync(indexPath, { throwIfNoEntry: false })?.size;
  let wroteSnapshot = false;
  let appended = false;

  // Takes back what was written here and nothing else. Another run of the
  // project may be recording a version of its own at the same moment: if the
  // index no longer ends with these lines alone, they are left in it, and the
  // version file with them — a version on record that was never installed,
  // rather than someone else's record cut out of the history.
  const undo = () => {
    try {
      const index = readFileSync(indexPath);
      const start = sizeBefore ?? 0;
      const sinceThen = index.subarray(Math.min(start, index.length));
      // What was appended is the end of the index — whole, or as far as a failed write got.
      const cutTo = index.subarray(-lines.length).equals(lines) ? index.length - lines.length
        : lines.subarray(0, sinceThen.length).equals(sinceThen) ? start
        : null;
      if (cutTo === null) return;
      if (cutTo === 0 && sizeBefore === undefined) rmSync(indexPath, { force: true });
      else if (cutTo < index.length) truncateSync(indexPath, cutTo);
    } catch (err) {
      // The index cannot be looked at. If the lines went into it, they stay,
      // and the version file with them; if they never did, there is only the file.
      if (appended && (err as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    if (wroteSnapshot) try { rmSync(snapshot, { force: true }); } catch { /* best-effort */ }
  };
  try {
    // Never over a version file that is already there: that one is someone else's.
    const fd = openSync(snapshot, "wx");
    wroteSnapshot = true;
    try { writeFileSync(fd, source); } finally { closeSync(fd); }
    appendFileSync(indexPath, lines);
    appended = true;
  } catch (err) {
    undo();
    throw err;
  }
  return undo;
}

/** Save the current program.ts as the next version of the project, and record why. */
export function copyToHistory(projectDir: string, reason: string, detail?: string): void {
  recordVersion(projectDir, readFileSync(guardPath(projectDir, "program.ts")), reason, detail);
}

// --- Staging: run against a copy, merge back what worked (see tree.ts) ---

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

/**
 * Make `copyDir` a copy of a project to try a program in: what the project
 * holds (see copyTree), with `program` as its program.ts. Returns what the
 * project held when it was copied.
 *
 * The project's journals are not carried over: they are the record of its
 * runs, not part of what a run works on, and a copy is where a run is tried.
 *
 * In everything else the copy is as the project is, so that what a program
 * can do in the one it can do in the other: what a run did in a copy is
 * merged back into the project, and must not have been possible only there.
 * The one exception is the program: the one to be tried, in the place of
 * the project's. It allows what the project's allows — and its owner to
 * replace it: a copy is where programs are tried and replaced, and whether
 * the project's own may be is said of the project, where one is to take its
 * place (see whyNotReplaceable). A project with a directory where its
 * program should be has no place for one, and is not copied to try one in.
 */
function copyProjectWith(projectDir: string, copyDir: string, program: string): Tree {
  // Two directories the copy must know when it comes to them — by what they are, since neither
  // need be spelled as the walk would spell it, or lie where its name suggests.
  let journals: string | undefined;
  try {
    journals = identityOf(journalDirOf(projectDir));
  } catch {
    // Where the journals would be is no place the project may use (a link out of it, say): it has none to leave out.
  }
  const theCopy = identityOf(copyDir);
  const held = copyTree(projectDir, copyDir, (at, entry) => {
    if (entry.kind !== "dir") return false;
    const identity = identityOf(at);
    if (identity === undefined) return false; // gone since it was looked at
    if (identity === theCopy) {
      throw new Error(`A copy of ${realRootOf(projectDir)} cannot be made inside it, at ${at}. (Is the temp directory in the project?)`);
    }
    return identity === journals;
  });
  const had = statSync(guardPath(copyDir, "program.ts"), { throwIfNoEntry: false });
  if (had?.isDirectory()) throw new Error(`No program can be tried in a copy of ${realRootOf(projectDir)}: its program.ts is a directory.`);
  stageFile(copyDir, "program.ts", program, had && (had.mode | 0o200)).commit();
  return held;
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
  /** Where the run is written down. One journal covers every attempt of a run. */
  journal: Journal;
  /** Which attempt of the run this is: 0 for the program as it was, 1 and up for fixes. */
  attempt?: number;
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

/** How much of each of a program's output streams goes into the journal. */
const MAX_JOURNALLED_OUTPUT = 64 * 1024;

/** What identifies a program text without quoting it. */
function fingerprint(programPath: string): { sha256: string; bytes: number } | null {
  try {
    const source = readFileSync(programPath);
    return { sha256: createHash("sha256").update(source).digest("hex"), bytes: source.length };
  } catch {
    return null; // no program to speak of; the attempt will say so itself
  }
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
function settle(projectDir: string, child: ShellResult, ended: ProgramResult | null): ProgramResult | null {
  // Read state first: if the program left state.json corrupt, say so now
  // rather than report an outcome (or start a repair) on top of it.
  const state = loadState(projectDir);
  if (ended) return ended;
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
  const { projectDir, backend, timeout, maxIterations, argsOverride, validating, workspaceDir, label, signal, journal } = options;
  const attempt = options.attempt ?? 0;

  if (signal?.aborted) return { outcome: null, failure: "The run was stopped before its program started." };
  requireWatchdog();
  ensureProjectScaffold(projectDir);

  // Cancels in-flight LLM calls, fetches and observes once the run is over.
  const runEnded = new AbortController();
  // Ends a validation: the program has shown what it had to, and is asked to stop.
  const validated = new AbortController();
  let readyTimer: ReturnType<typeof setTimeout> | null = null;

  // The state the program starts from. From here on it is the program's: the
  // runner sees it again only as the program hands it over to be persisted.
  const state = loadState(projectDir);
  const ctx = createContext(projectDir, state, {
    maxIterations,
    argsOverride,
    onReady: validating && (() => {
      readyTimer ??= setTimeout(() => validated.abort(), validating.readyGraceMs).unref();
    }),
    print: line => console.log(tagged(label, line)),
  });
  journal.note("attempt", {
    attempt,
    // Where it runs — a copy of the project, when a fix is being tried or a candidate validated.
    dir: projectDir,
    program: fingerprint(guardPath(projectDir, "program.ts")),
    iteration: ctx.iteration,
    resumed: ctx.resumed,
  });
  // Truncate logs only after preflight succeeds — preserves the prior run's
  // diagnostics if scaffolding, state loading, or context creation fails.
  writeFileSync(guardPath(projectDir, LATEST_LOG_PATH), "");

  // The program's own time. It stops while a run the program asked for is in flight.
  const allowance = createAllowance(timeout);
  // Set when a validation ended because the program asked for another to be run.
  let handedOff = false;
  // Runs the program has asked for and that are still going. They belong to this run.
  const nestedRuns = new Set<Promise<unknown>>();
  const workspaces = new Map<string, Workspace>();
  const workspaceAt = (dir: string): Workspace => {
    let workspace = workspaces.get(dir);
    if (!workspace) workspaces.set(dir, workspace = createWorkspace(dir, runEnded.signal));
    return workspace;
  };
  // The workspace of the session this run is part of, if it is part of one.
  const sessionWorkspace = workspaceDir ? workspaceAt(workspaceDir) : null;
  const tools = createTools(projectDir, runEnded.signal);
  // Known only to this run's program, through its init file.
  const token = randomBytes(32).toString("hex");
  const server = createIPCServer({
    token,
    ctx,
    agent: createAgent(backend, projectDir, runEnded.signal),
    tools,
    workspace: sessionWorkspace,
    workspaceAt,
    journal,
    run: (request, stop, seq) => {
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
      const nested = runProgram({ ...request, signal: AbortSignal.any([runEnded.signal, stop]) }, {
        depth: options.depth + 1,
        // The two journals point at each other: this one says which run the call started…
        started: (run, path) => { if (run) journal.note("child", { seq, run, journal: path }); },
        // …and that run's journal says which call started it.
        parent: { run: journal.run, journal: journal.path, seq },
      }).finally(() => {
        release();
        nestedRuns.delete(nested);
      });
      nestedRuns.add(nested);
      return nested;
    },
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
  const offStop = onAbort(signal, stopProgram);
  try {
    const { child, exited } = await withTempDir("trama-init-", async (initDir) => {
      const port = await listen(server);
      const initFile = writeInitFile(initDir, {
        token,
        input: ctx.input,
        state,
        iteration: ctx.iteration,
        maxIterations: ctx.maxIterations,
        inSession: sessionWorkspace !== null,
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
      // A validation that reached a hand-off in time was decided there: how the
      // program goes down, cut off in mid-flow, says nothing about it.
      const passedAtHandOff = handedOff && !exit.timedOut;
      if (passedAtHandOff) console.log(tagged(label, "[trama] validated up to where it starts another program"));
      return {
        child: passedAtHandOff ? { exitCode: 0, stdout: exit.stdout, stderr: exit.stderr } : toChildResult(exit),
        // How the program's process ended, for the record.
        exited: {
          code: exit.code,
          signal: exit.signal,
          ...(exit.timedOut ? { timedOut: true } : {}),
          // Stopped by the runner at the end of a validation: at a hand-off, or once it had been ready a while.
          ...(exit.stopped ? { validated: handedOff ? "hand-off" : "ready" } : {}),
        },
      };
    });
    // How the attempt ended goes on record whatever comes of it — also when
    // what the program left behind cannot be made sense of.
    const noteExit = (verdict: Record<string, unknown>) => journal.note("exit", {
      attempt,
      ...exited,
      ...(stopped ? { stopped: true } : {}),
      // What the program printed is part of what it did. The end of it, where a failure shows.
      stdout: tail(child.stdout, MAX_JOURNALLED_OUTPUT),
      stderr: tail(child.stderr, MAX_JOURNALLED_OUTPUT),
      ...verdict,
    });
    let outcome: ProgramResult | null;
    try {
      // A program that was stopped did not finish, whatever its exit code
      // says — unless it had already said it was done.
      outcome = stopped && !ctx.ended ? null : settle(projectDir, child, ctx.ended);
    } catch (err) {
      noteExit({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    noteExit({ outcome });
    return { outcome, failure: describeFailure(child) };
  } finally {
    // The program is gone (or never started). Nothing it started outlives its
    // run: cancel the calls it left in flight — the runs it asked for among
    // them — and stop what is left of its process group and of its shell
    // commands. Only once they are gone is the run over: whoever called will
    // merge or delete what they were writing to.
    offStop();
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
  /** Set when the program only worked after a repair: which attempt it was (1 for the first fix), and the failure it fixed. */
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
 * Returns the fixed program, or why no usable one came back.
 */
async function requestRepair(
  options: ExecuteOptions,
  input: { programSource: string; error: string },
): Promise<{ fixed: string } | { error: string }> {
  options.journal.note("fix-request", { error: input.error });
  return withTempDir("trama-repair-", async (tempDir) => {
    const timedOut = new AbortController();
    const limit = createAllowance(options.timeout);
    const signal = options.signal ? AbortSignal.any([timedOut.signal, options.signal]) : timedOut.signal;
    try {
      copyProjectWith(options.projectDir, tempDir, input.programSource);
      limit.start(() => timedOut.abort());
      const fixed = stripCodeFences(await options.backend.ask(repairPrompt(input), {
        cwd: tempDir, system: REPAIR_SYSTEM_PROMPT, signal,
      }));
      if (fixed.trim() === "") throw new Error("The repair returned an empty program.");
      if (fixed === input.programSource) throw new Error("The repair returned the program unchanged.");
      options.journal.note("fix", { ok: true, source: fixed });
      return { fixed };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      options.journal.note("fix", { ok: false, error });
      return { error };
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
 * program.ts, and what its run did is merged back. A fix that fails, or a
 * runner that is stopped while one is tried, leaves the project exactly as
 * it was, because it was never touched: its state is only ever written by
 * code that is, or becomes, its program.
 *
 * The shared workspace is not copied. It is how the participants of a session
 * talk to each other, and a program that is being fixed still has to be heard
 * and answered — a fix that wrote its requests where nobody could see them
 * would wait for replies forever. So what a fix writes there is written,
 * whether or not the fix works: like anything a run wrote before it failed.
 */
async function tryFix(options: ExecuteOptions, fixed: string, attempt: number): Promise<RunOnceResult> {
  const { projectDir } = options;
  return withTempDir("trama-staged-", async (stagedProject) => {
    // What the project held when it was copied: what its places are compared with when the run's work is merged in.
    const held = copyProjectWith(projectDir, stagedProject, fixed);
    // Taken with the fix in place: what differs from this afterwards is what the run did.
    const before = readTree(stagedProject);
    // The fix in the copy, as the copy has it: under which name, at which place — which is the place of
    // the project's program in the project — and what it allows there.
    const fixAt = guardPath(stagedProject, "program.ts");
    const itsName = pathAsListed(stagedProject, join(realRootOf(stagedProject), "program.ts")) ?? "program.ts";
    const itsPlace = pathAsListed(stagedProject, fixAt);
    const allowed = statSync(fixAt).mode;
    // If the copy cannot be run at all, or is left unusable, this fix did not work either.
    const trial = await runProgramOnce({ ...options, projectDir: stagedProject, attempt }).catch((err): RunOnceResult => ({
      outcome: null,
      failure: `The repaired program could not be run: ${err instanceof Error ? err.message : err}`,
    }));
    if (trial.outcome === null) return trial;

    // The fix worked, and becomes the project's program — as it ran, first,
    // and in one move; only then is what its run did merged in. What the run
    // did to its own file is among that: a program may rewrite itself, give
    // itself other permissions, make program.ts lead elsewhere, and here as
    // in any run what it made of itself is what it is. (So a runner stopped
    // between the two leaves the fix beside the state it started from: the
    // program that would do the same again, not the one it turns into.)
    //
    // The project is to have a program afterwards. One that removed itself is
    // still the fix that ran: a file of its name is put back where the run
    // ended (the name itself, not what a link left there leads to). A run that
    // left, at program.ts, nothing that can be read as a program has not left
    // a project that has one, and was no fix.
    try {
      if (programIn(stagedProject) === null) {
        rmSync(join(realRootOf(stagedProject), itsName), { force: true });
        stageFile(stagedProject, itsName, fixed, allowed).commit();
      }
    } catch (err) {
      return {
        outcome: null,
        failure: `The repaired program ran, but left no program.ts that can be read: ${err instanceof Error ? err.message : err}`,
      };
    }
    // If it cannot be put in place, that is an error, and it is thrown from
    // here with nothing of the run in the project: a state the old program
    // did not write, beside the old program, is worse than either.
    const program = stageProgram(projectDir, fixed);
    program.commit();
    // The project now holds, where its program was, what the copy held there before the run — and the merge is
    // told so: that is what the place is taken to have held when the copy was made.
    const installed = entryAt(program.destination);
    if (itsPlace !== undefined && installed) held.set(itsPlace, installed);
    const unmerged = mergeTree(stagedProject, projectDir, before, held);
    if (unmerged.length > 0) {
      // The run is done and its program installed; what it did that is not in the project is said, not passed over.
      options.journal.note("unmerged", { attempt, files: unmerged });
      console.warn(tagged(options.label, `[trama] ${unmerged.length} change(s) the repaired run made did not reach the project:`));
      for (const { path, why } of unmerged) console.warn(tagged(options.label, `[trama]   ${path} — ${why}`));
    }
    return trial;
  });
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
  // A fix is worth asking for, and trying, only where it could become the program.
  const refusal = whyNotReplaceable(projectDir);
  if (refusal) return failed(`Program failed, and no repair was tried. ${refusal}\n${lastError}`);

  // Each attempt builds on the previous one's source, though a fix that failed never reached the project.
  let currentSource = programIn(projectDir);
  if (currentSource === null) return failed(`Program failed (there is no program.ts to repair): ${lastError}`);

  // The program as it was is attempt 0; each fix is the next.
  for (let attempt = 1; attempt <= maxRepairAttempts; attempt++) {
    const fix = await requestRepair(options, { programSource: currentSource, error: lastError });
    if (stopped()) return wasStopped();
    // Without a fix there is nothing more to try: asking again would be asking the same thing.
    if ("error" in fix) {
      return failed(`Failed after ${attempt} repair attempt(s): ${lastError}\nNo fix came back: ${fix.error}`);
    }
    currentSource = fix.fixed;

    const run = await tryFix(options, fix.fixed, attempt);
    if (run.outcome) return { result: run.outcome, repair: { attempt, error: lastError } };
    if (stopped()) return wasStopped();
    lastError = run.failure;
  }

  return failed(`Failed after ${maxRepairAttempts} repair attempts: ${lastError}`);
}

/**
 * Carry out a run under its journal. However it goes, the journal's last
 * record says so: the run's result, or why it could not be carried out.
 */
async function journalled<T extends Execution>(journal: Journal, run: () => Promise<T>): Promise<T> {
  try {
    const execution = await run();
    journal.note("end", { result: execution.result });
    return execution;
  } catch (err) {
    journal.note("end", { error: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    journal.close();
  }
}

// --- Validating a candidate program (used by create and update) ---

const VALIDATION_READY_GRACE_MS = 2_000;

/**
 * Validate a candidate program.ts for a project without touching what the
 * project holds: run it (with repair) in a throwaway copy. The one thing left
 * in the project is the journal of the validation. Returns the program that worked —
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
  options: { timeout: number; maxRepairAttempts: number; maxIterations: number; journalRuns?: number },
): Promise<{ source: string; repairedError?: string }> {
  const { journalRuns = 0, ...limits } = options;
  // Recorded with the project, though run in a copy of it.
  const journal = openJournal(projectDir, journalRuns, { purpose: "validate", ...limits });
  const { result, repair, left } = await journalled(journal, () => withTempDir("trama-validate-", async (trialDir) => {
    copyProjectWith(projectDir, trialDir, candidate);

    const execution = await executeProgram({
      ...limits,
      projectDir: trialDir,
      backend,
      depth: 0,
      validating: { readyGraceMs: VALIDATION_READY_GRACE_MS },
      journal,
    });
    // The program as its run left it: the candidate, or what a repair or the program itself
    // made of it. (One that removed itself is still the candidate that ran.)
    return { ...execution, left: programIn(trialDir) ?? candidate };
  }));
  if (result.status === "failed") throw new Error(`Program failed: ${result.reason}`);
  return { source: left, repairedError: repair?.error };
}

/** A project's program text — null if it has none. Throws if what is in its place is no file. */
function programIn(projectDir: string): string | null {
  const place = guardPath(projectDir, "program.ts");
  try {
    return readFileSync(place, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "EISDIR") throw new Error(`${place} is a directory, not a program.`);
    throw err;
  }
}

/**
 * Why a project's program cannot be given a successor — or null if it can.
 *
 * A program is replaced by a new file taking its place, which the system
 * allows whatever the old file's permissions say. So the old file is asked: a
 * program its owner has made read-only is not replaced. A directory in its
 * place is no program, and no file takes the place of one. And the new file
 * has to be made beside it, in a directory that is there or can be made.
 *
 * This is the rule stageProgram enforces. It is also asked before work whose
 * only use is a new program — an update, a repair — is begun.
 */
export function whyNotReplaceable(projectDir: string): string | null {
  const place = guardPath(projectDir, "program.ts");
  const allows = (path: string, what: number) => {
    try { accessSync(path, what); return true; } catch { return false; }
  };
  const there = statSync(place, { throwIfNoEntry: false });
  if (there?.isDirectory()) return `The program cannot be replaced: ${place} is a directory.`;
  if (there && !allows(place, constants.W_OK)) return `The program cannot be replaced: ${place} is read-only.`;
  // The directory the new file is made in — or, if that is still to be made, the one it is made in.
  let dir = dirname(place);
  while (!existsSync(dir)) dir = dirname(dir);
  if (!allows(dir, constants.W_OK | constants.X_OK)) return `The program cannot be replaced: nothing can be created in ${dir}.`;
  return null;
}

/**
 * Get a program ready to become a project's program.ts: written beside the
 * one that is there, to take its place in one move — so program.ts is never
 * half a program, whatever happens in the middle of writing it.
 *
 * It is a new file that takes the place: the old one's permissions are carried
 * over, but not a second hard link to it, or its owner.
 */
function stageProgram(projectDir: string, source: string): StagedFile {
  const refusal = whyNotReplaceable(projectDir);
  if (refusal) throw Object.assign(new Error(refusal), { code: "EACCES" });
  return stageFile(projectDir, "program.ts", source);
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
  // Three steps, ordered so that a failure at any of them leaves the project
  // as it was: the new program is written beside the old one (nothing else is
  // touched if even that cannot be done), the version is recorded, and only
  // then does the new program take the old one's place — in one move, so
  // program.ts is never half-written, and never a program that is not on record.
  const program = stageProgram(projectDir, validated.source);
  let unrecord = () => {};
  try {
    unrecord = recordVersion(projectDir, validated.source, reason, prompt, validated.repairedError
      ? [{ reason: `${reason}-repair`, timestamp: new Date().toISOString(), error: validated.repairedError }]
      : []);
    program.commit();
  } catch (err) {
    unrecord();
    program.discard();
    throw err;
  }
}

// --- Core execution ---

/** How deep programs may run programs, and how many runs one runner carries at a time. */
const MAX_RUN_DEPTH = 16;
const MAX_RUNS_IN_FLIGHT = 128;
let runsInFlight = 0;

/** What a run is told when a program asked for it, rather than a person or a host. */
interface AskedFor {
  /** How many runs deep it is: one more than the run that asked. */
  depth: number;
  /** The call that asked for it: which run's, and which of that run's calls. */
  parent: { run: string; journal: string; seq: number };
  /** Called once this run has a journal of its own. */
  started(run: string, journal: string): void;
}

/**
 * Run a project, in this process: this is what a runner does.
 *
 * `askedFor` is set when a program asked for the run (see the "/run/program"
 * call). One runner carries the whole tree of runs, so it is also where the
 * tree is kept from growing without bound.
 */
export async function runProgram(options: RunOptions, askedFor?: AskedFor): Promise<ProgramResult> {
  const depth = askedFor?.depth ?? 0;
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
    return await runProject(options, depth, askedFor);
  } finally {
    runsInFlight -= 1;
  }
}

async function runProject(options: RunOptions, depth: number, askedFor?: AskedFor): Promise<ProgramResult> {
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

  const journal = openJournal(projectDir, config.journalRuns, {
    purpose: "run",
    label: options.label,
    depth,
    parent: askedFor?.parent,
    workspace: options.workspaceDir,
    timeout,
    maxRepairAttempts,
    args: options.args, // last: it is the one field of unknown size
  });
  askedFor?.started(journal.run, journal.path);

  const { result, repair } = await journalled(journal, () => executeProgram({
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
    journal,
  }));

  if (repair) {
    // The program is fixed and has run; failing to write this down must not turn that into an error.
    try {
      const message = `Repair attempt ${repair.attempt}/${maxRepairAttempts}`;
      appendLogEntry(guardPath(projectDir, LATEST_LOG_PATH), message, { error: repair.error });
      console.log(tagged(options.label, `[trama] ${message}`));
      copyToHistory(projectDir, "repair", repair.error);
    } catch (err) {
      console.warn(tagged(options.label, `[trama] repair bookkeeping failed: ${err instanceof Error ? err.message : err}`));
    }
  }
  return result;
}
