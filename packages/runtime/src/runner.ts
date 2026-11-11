import { spawn } from "child_process";
import {
  readFileSync, writeFileSync, appendFileSync,
  readdirSync, copyFileSync, mkdirSync, existsSync, statSync,
  symlinkSync, rmSync, lstatSync, readlinkSync,
  cpSync, mkdtempSync, openSync, closeSync,
} from "fs";
import { join, dirname } from "path";
import { homedir, tmpdir } from "os";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import type { ShellResult } from "./types.js";
import type { RunOptions, TramaConfig, ProgramResult } from "./runner-types.js";
import { PiAdapter } from "./pi-adapter.js";
import { createContext } from "./context.js";
import { createAgent } from "./agent.js";
import { createTools } from "./tools.js";
import { createWorkspace } from "./workspace.js";
import { guardPath } from "./path-guard.js";
import { superviseChild, type ChildExit } from "./child-process.js";
import { createIPCServer, listen, closeServer } from "./ipc-server.js";

// --- Locating the runtime itself ---

/** The installed @trama-dev/runtime package — this file lives in its dist/. */
const RUNTIME_PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** tsx executes program.ts. Resolved through the module system, so any install layout works. */
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");

// --- Project scaffolding ---

/**
 * Point the project's node_modules/@trama-dev/runtime at this runtime, so
 * program.ts can import it. Replaces any existing symlink whose target differs
 * (including user-managed ones). Only refuses to touch a real directory/file
 * to avoid destroying user content.
 */
function linkRuntime(projectDir: string): void {
  // The link deliberately points OUTSIDE the project — do not apply guardPath here.
  const linkDir = join(projectDir, "node_modules", "@trama-dev");
  const linkPath = join(linkDir, "runtime");

  try {
    if (!lstatSync(linkPath).isSymbolicLink()) {
      throw new Error(
        `${linkPath} exists and is not a symlink. ` +
        `trama needs this path for module resolution. ` +
        `Remove it manually or rename it to proceed.`
      );
    }
    if (readlinkSync(linkPath) === RUNTIME_PACKAGE_DIR) return;
    rmSync(linkPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  mkdirSync(linkDir, { recursive: true });
  symlinkSync(RUNTIME_PACKAGE_DIR, linkPath, "dir");
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
 * history/ and logs/, an ESM package.json, .gitignore entries, and the runtime link.
 * Idempotent — called before every run, so a freshly cloned project just works.
 */
export function ensureProjectScaffold(projectDir: string): void {
  mkdirSync(guardPath(projectDir, "history"), { recursive: true });
  mkdirSync(guardPath(projectDir, "logs"), { recursive: true });
  ensureModulePackageJson(projectDir);
  ensureGitignore(projectDir);
  linkRuntime(projectDir);
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
    model: "claude-opus-4-6",
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
 * Repairs made while validating a create or update are NOT versions of their
 * own — they are noted in index.jsonl only (reason "create-repair" /
 * "update-repair"), and the validated program becomes the create/update version.
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

// --- Snapshots and staging ---

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
 * Commit workspace changes from a temp workspace back to the real workspace,
 * using a three-way check to avoid overwriting concurrent updates by other participants.
 *
 * @param tempDir - temp workspace after the run (source of changes)
 * @param realDir - real shared workspace (destination)
 * @param tempBefore - temp workspace snapshot before the run (detects what the run changed)
 * @param realSeed - real workspace snapshot at seed time (detects concurrent changes)
 *
 * For each file the run created or modified in the temp workspace:
 * - New file: copied unless that path has meanwhile appeared in the real workspace.
 * - Modified file: copied only if the real workspace's copy still matches realSeed.
 *   If it doesn't, another participant changed or removed it concurrently — skip.
 * Best-effort: anything that cannot be committed safely is skipped, never thrown.
 */
export function commitWorkspaceChanges(
  tempDir: string,
  realDir: string,
  tempBefore: DirSnapshot,
  realSeed: DirSnapshot,
): void {
  for (const [relPath, afterStat] of snapshotDir(tempDir)) {
    const beforeStat = tempBefore.get(relPath);
    if (beforeStat && sameStat(beforeStat, afterStat)) continue; // the run didn't touch it

    try {
      // A concurrent participant could have placed a symlink at this path or in
      // a parent directory, pointing outside the workspace — guardPath throws.
      const dstPath = guardPath(realDir, relPath);
      const realNow = statSync(dstPath, { throwIfNoEntry: false });

      if (beforeStat) {
        const seedStat = realSeed.get(relPath);
        if (seedStat && (!realNow || !sameStat(realNow, seedStat))) continue; // changed or removed concurrently
      } else if (realNow) {
        continue; // someone else created the same path first — keep theirs
      }

      mkdirSync(dirname(dstPath), { recursive: true });
      copyFileSync(join(tempDir, relPath), dstPath);
    } catch {
      // Escapes the workspace, path-shape conflict, permissions — skip
    }
  }
}

/**
 * Snapshot a directory, run fn, restore from snapshot if fn returns false
 * or if fn throws. Always cleans up the snapshot. Returns whatever fn returns.
 */
export async function withSnapshot<T>(dir: string, fn: () => Promise<{ keep: boolean; value: T }>): Promise<T> {
  const snap = mkdtempSync(join(tmpdir(), "trama-snapshot-"));
  const restore = () => {
    rmSync(dir, { recursive: true, force: true });
    cpSync(snap, dir, { recursive: true });
  };
  try {
    cpSync(dir, snap, { recursive: true });
    let result: { keep: boolean; value: T };
    try {
      result = await fn();
    } catch (err) {
      restore();
      throw err;
    }
    if (!result.keep) restore();
    return result.value;
  } finally {
    rmSync(snap, { recursive: true, force: true });
  }
}

/** Remove a temp directory. Best-effort: failing to clean up must never change a run's outcome. */
function removeTempDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* left for the OS to reap */ }
}

/** Run fn in a temp directory, clean up afterwards regardless of outcome. */
export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    removeTempDir(dir);
  }
}

/**
 * Run fn against a private copy of the shared workspace, so its writes stay
 * invisible to other participants unless fn asks to commit them — in which
 * case what it created or changed is merged back (see commitWorkspaceChanges).
 * Outside a session there is no workspace and fn simply runs.
 */
async function withStagedWorkspace<T>(
  workspaceDir: string | undefined,
  fn: (stagedDir: string | undefined) => Promise<{ commit: boolean; value: T }>,
): Promise<T> {
  if (!workspaceDir) return (await fn(undefined)).value;
  const realSeed = snapshotDir(workspaceDir);
  return withTempDir("trama-repair-ws-", async (stagedDir) => {
    cpSync(workspaceDir, stagedDir, { recursive: true });
    const stagedBefore = snapshotDir(stagedDir);
    const { commit, value } = await fn(stagedDir);
    if (commit) commitWorkspaceChanges(stagedDir, workspaceDir, stagedBefore, realSeed);
    return value;
  });
}

// --- Single program execution ---

interface RunOnceOptions {
  projectDir: string;
  adapter: PiAdapter;
  timeout: number;
  maxIterations: number;
  argsOverride?: Record<string, unknown>;
  /** Echo the program's stdout/stderr to ours as it runs. */
  streamOutput?: boolean;
  /**
   * Treat the run as successful once the program has called ctx.ready() and
   * stayed up for graceMs — used to validate long-running programs.
   */
  stopOnReady?: { graceMs: number };
  /** Shared workspace directory. When set, the workspace.* API is enabled. */
  workspaceDir?: string;
}

interface RunOnceResult {
  child: ShellResult;
  /** Set if the program called ctx.done() or ctx.yield() during this run. */
  terminalSignal: ProgramResult | null;
}

const formatError = (r: ShellResult) =>
  `program.ts exited with code ${r.exitCode}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;

/**
 * Hand the program its starting state through a private temp file rather than
 * env vars — no OS size limit, and mode 0600 in an unpredictable directory
 * keeps it from other local users. Returns the directory to remove afterwards.
 */
function writeInitFile(payload: unknown): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "trama-init-"));
  const file = join(dir, "init.json");
  const fd = openSync(file, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(payload));
  } finally {
    closeSync(fd);
  }
  return { dir, file };
}

function toChildResult(exit: ChildExit): ShellResult {
  const { stdout, stderr } = exit;
  if (exit.timedOut) return { exitCode: 1, stdout, stderr: stderr + "\n[trama] program killed: timeout" };
  // Stopped by us after ctx.ready() — going down on SIGTERM is the expected outcome.
  if (exit.stopped && (exit.code === 0 || exit.signal === "SIGTERM")) return { exitCode: 0, stdout, stderr };
  return { exitCode: exit.code ?? 1, stdout, stderr };
}

/**
 * Run program.ts once in the given directory: scaffold, start the IPC server,
 * spawn the program, wait for it, and tear everything down.
 * Reports how the program ended — does NOT throw on non-zero exit. Throws only
 * when the run could not happen at all (bad project, server or spawn failure).
 */
async function runProgramOnce(options: RunOnceOptions): Promise<RunOnceResult> {
  const { projectDir, adapter, timeout, maxIterations, argsOverride, streamOutput, stopOnReady, workspaceDir } = options;

  ensureProjectScaffold(projectDir);

  // Cancels in-flight LLM calls, fetches and observes once the run is over.
  const runEnded = new AbortController();
  // Asks the program to stop once it has been ready for the grace period.
  const readyStop = new AbortController();
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  let terminalSignal: ProgramResult | null = null;

  const ctx = createContext(projectDir, loadState(projectDir), {
    maxIterations,
    argsOverride,
    onReady: stopOnReady && (() => {
      readyTimer ??= setTimeout(() => readyStop.abort(), stopOnReady.graceMs).unref();
    }),
  });
  // Truncate logs only after preflight succeeds — preserves the prior run's
  // diagnostics if scaffolding, state loading, or context creation fails.
  writeFileSync(guardPath(projectDir, join("logs", "latest.jsonl")), "");

  const tools = createTools(projectDir, runEnded.signal);
  const server = createIPCServer({
    ctx,
    agent: createAgent(adapter, runEnded.signal),
    tools,
    workspace: workspaceDir ? createWorkspace(workspaceDir, runEnded.signal) : null,
    // The first terminal signal wins; ctx itself rejects a conflicting second one.
    onTerminalSignal: result => { terminalSignal ??= result; },
  });

  let initDir: string | undefined;
  try {
    const port = await listen(server);
    const init = writeInitFile({
      input: ctx.input,
      state: ctx.state,
      iteration: ctx.iteration,
      maxIterations: ctx.maxIterations,
      workspace: workspaceDir ?? null,
      resumed: ctx.resumed,
      yieldReason: ctx.yieldReason,
    });
    initDir = init.dir;

    const child = spawn(process.execPath, [TSX_CLI, guardPath(projectDir, "program.ts")], {
      cwd: projectDir,
      env: { ...process.env, TRAMA_PORT: String(port), TRAMA_INIT: init.file },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const exit = await superviseChild(child, {
      timeout,
      stopSignal: stopOnReady ? readyStop.signal : undefined,
      sinks: streamOutput ? {
        stdout: chunk => { process.stdout.write(chunk); },
        stderr: chunk => { process.stderr.write(chunk); },
      } : undefined,
    });
    return { child: toChildResult(exit), terminalSignal };
  } finally {
    // The program is gone (or never started): cancel what it left in flight,
    // kill shells it left running in the background, and drop its connections.
    if (readyTimer) clearTimeout(readyTimer);
    runEnded.abort();
    tools.killActiveShells();
    server.closeAllConnections();
    await closeServer(server).catch(() => { /* best-effort */ });
    if (initDir) removeTempDir(initDir);
  }
}

/**
 * Decide how a finished run ended. A terminal signal the program persisted
 * takes precedence over its exit code: a program that called ctx.done() and
 * then crashed is done. Returns null for a failure (non-zero exit, no signal).
 */
function settle(projectDir: string, run: RunOnceResult): ProgramResult | null {
  // Read state first: if the program left state.json corrupt, say so now
  // rather than report an outcome (or start a repair) on top of it.
  const state = loadState(projectDir);
  if (run.terminalSignal) return run.terminalSignal;
  if (run.child.exitCode !== 0) return null;

  // Natural success without done() or yield(): if this run was the resumption
  // of an earlier yield, that yield is now over — don't let its marker make
  // the next run look resumed.
  if (state.__trama_yield != null) {
    delete state.__trama_yield;
    writeFileSync(guardPath(projectDir, "state.json"), JSON.stringify(state, null, 2));
  }
  return { status: "done" };
}

// --- Execution with repair ---

interface ExecuteOptions extends Omit<RunOnceOptions, "streamOutput"> {
  maxRepairAttempts: number;
  /** Called after a repaired program has succeeded. Receives the attempt index and the error that was fixed. */
  onRepair?: (attempt: number, maxAttempts: number, error: string) => void;
}

/** One LLM repair call, bounded by its own timeout. Returns null (and records why) if it fails. */
async function requestRepair(
  adapter: PiAdapter,
  input: { programSource: string; error: string },
  timeout: number,
  repairErrors: string[],
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await adapter.repair({ ...input, runtimeTypes: RUNTIME_TYPES }, controller.signal);
  } catch (err) {
    repairErrors.push(err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the LLM for a fix and try it out on throwaway copies of the project and
 * workspace, so neither the repair agent's side effects nor a still-broken
 * program can touch the real ones. Returns null if the LLM produced no fix.
 */
async function tryRepairInIsolation(
  options: ExecuteOptions,
  input: { programSource: string; error: string },
  repairErrors: string[],
): Promise<{ fixed: string; verified: boolean; error: string } | null> {
  return withTempDir("trama-repair-", async (tempDir) => {
    cpSync(options.projectDir, tempDir, { recursive: true });
    const tempAdapter = options.adapter.withCwd(tempDir);

    const fixed = await requestRepair(tempAdapter, input, options.timeout, repairErrors);
    if (!fixed) return null;
    writeFileSync(guardPath(tempDir, "program.ts"), fixed);

    const run = await withStagedWorkspace(options.workspaceDir, async (stagedWorkspace) => ({
      commit: false,
      value: await runProgramOnce({
        ...options, projectDir: tempDir, adapter: tempAdapter, workspaceDir: stagedWorkspace,
      }),
    }));
    return { fixed, verified: settle(tempDir, run) !== null, error: formatError(run.child) };
  });
}

/**
 * Run a fix that passed in isolation for real. If it fails here after all, the
 * project is rolled back to its pre-repair state and its workspace writes are
 * dropped; if it succeeds, they are merged into the shared workspace.
 */
async function applyRepair(
  options: ExecuteOptions,
  fixed: string,
): Promise<{ outcome: ProgramResult | null; error: string }> {
  const { projectDir } = options;
  return withStagedWorkspace(options.workspaceDir, async (stagedWorkspace) => {
    const value = await withSnapshot(projectDir, async () => {
      writeFileSync(guardPath(projectDir, "program.ts"), fixed);
      const run = await runProgramOnce({ ...options, streamOutput: true, workspaceDir: stagedWorkspace });
      const outcome = settle(projectDir, run);
      return { keep: outcome !== null, value: { outcome, error: formatError(run.child) } };
    });
    return { commit: value.outcome !== null, value };
  });
}

/**
 * Run a program to an outcome. If it crashes, ask the LLM to repair it — up to
 * maxRepairAttempts times, each fix first proven on a throwaway copy and only
 * then run for real.
 */
async function executeProgram(options: ExecuteOptions): Promise<ProgramResult> {
  const { projectDir, maxRepairAttempts } = options;

  const firstRun = await runProgramOnce({ ...options, streamOutput: true });
  const outcome = settle(projectDir, firstRun);
  if (outcome) return outcome;

  let lastError = formatError(firstRun.child);
  if (maxRepairAttempts === 0) {
    return { status: "failed", reason: `Program failed (repair disabled): ${lastError}` };
  }

  // Each attempt builds on the previous one's source, even though a failed
  // attempt leaves the real project untouched.
  let currentSource = readFileSync(guardPath(projectDir, "program.ts"), "utf-8");
  const repairErrors: string[] = [];
  const repairDetails = () => repairErrors.length > 0
    ? `\nRepair errors:\n${repairErrors.map((e, i) => `  [${i + 1}] ${e}`).join("\n")}` : "";

  for (let attempt = 0; attempt < maxRepairAttempts; attempt++) {
    const repair = await tryRepairInIsolation(options, { programSource: currentSource, error: lastError }, repairErrors);
    if (!repair) {
      return { status: "failed", reason: `Failed after ${attempt + 1} repair attempt(s): ${lastError}${repairDetails()}` };
    }
    currentSource = repair.fixed;
    if (!repair.verified) {
      lastError = repair.error;
      continue;
    }

    const applied = await applyRepair(options, repair.fixed);
    if (applied.outcome) {
      try {
        // lastError is still the failure this repair fixed.
        options.onRepair?.(attempt, maxRepairAttempts, lastError);
      } catch (bookkeepingErr) {
        console.warn(`[trama] repair bookkeeping failed: ${bookkeepingErr instanceof Error ? bookkeepingErr.message : bookkeepingErr}`);
      }
      return applied.outcome;
    }
    lastError = applied.error;
  }

  return { status: "failed", reason: `Failed after ${maxRepairAttempts} repair attempts: ${lastError}${repairDetails()}` };
}

// --- Smoke run (used by create and update) ---

const DEFAULT_SMOKE_TIMEOUT = 30_000;
const SMOKE_READY_GRACE_MS = 2_000;

export function resolveSmokeTimeout(timeout?: number): number {
  return timeout ?? DEFAULT_SMOKE_TIMEOUT;
}

/**
 * Validate a freshly generated program.ts by running it (with repair) in a
 * throwaway copy of the project, so the validation run's file side effects
 * don't persist. On success the validated — possibly repaired — program is
 * copied back. Throws if it cannot be made to run.
 */
export async function smokeRunAndRepair(
  projectDir: string,
  adapter: PiAdapter,
  reason: "create" | "update",
  options: { timeout?: number; maxRepairAttempts: number; maxIterations: number },
): Promise<void> {
  await withTempDir("trama-smoke-", async (smokeDir) => {
    cpSync(projectDir, smokeDir, { recursive: true });

    const result = await executeProgram({
      projectDir: smokeDir,
      adapter: adapter.withCwd(smokeDir),
      maxRepairAttempts: options.maxRepairAttempts,
      timeout: resolveSmokeTimeout(options.timeout),
      maxIterations: options.maxIterations,
      stopOnReady: { graceMs: SMOKE_READY_GRACE_MS },
      onRepair(_attempt, _max, error) {
        appendHistoryIndex(projectDir, { reason: `${reason}-repair`, timestamp: new Date().toISOString(), error });
      },
    });
    if (result.status === "failed") {
      throw new Error(`Program failed: ${result.reason}`);
    }

    copyFileSync(guardPath(smokeDir, "program.ts"), guardPath(projectDir, "program.ts"));
  });
}

// --- Core execution ---

export async function runProgram(options: RunOptions): Promise<ProgramResult> {
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

  return executeProgram({
    projectDir,
    adapter: new PiAdapter(config, projectDir),
    maxRepairAttempts,
    timeout,
    maxIterations: config.defaultMaxIterations,
    argsOverride: options.args,
    workspaceDir: options.workspaceDir,
    onRepair(attempt, max, error) {
      // Runs after the repaired program's own run, so this lands at the end of its log.
      const entry = { ts: Date.now(), message: `Repair attempt ${attempt + 1}/${max}`, data: { error } };
      appendFileSync(guardPath(projectDir, join("logs", "latest.jsonl")), JSON.stringify(entry) + "\n");
      console.log(`[trama] Repair attempt ${attempt + 1}/${max}`);

      copyToHistory(projectDir, "repair", error);
    },
  });
}
