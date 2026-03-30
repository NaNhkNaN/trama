import { createServer, type Server } from "http";
import { spawn, type ChildProcess } from "child_process";
import {
  readFileSync, writeFileSync, appendFileSync,
  readdirSync, copyFileSync, mkdirSync, existsSync,
  symlinkSync, rmSync, lstatSync, readlinkSync,
  cpSync, mkdtempSync,
} from "fs";
import { join, dirname } from "path";
import { homedir, tmpdir } from "os";
import { fileURLToPath } from "url";
import type { Ctx, Agent, Tools, RunOptions, ChildResult, TramaConfig } from "./types.js";
import { PiAdapter } from "./pi-adapter.js";
import { createContext } from "./context.js";
import { createAgent } from "./agent.js";
import { createTools, cappedBuffer, type ToolsWithCleanup } from "./tools.js";

// --- Module resolution for child processes ---

/**
 * Find the node_modules directory that contains @trama-dev/runtime.
 * Works for both global install and monorepo development.
 */
function findRuntimeNodeModules(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    const candidate = join(dir, "node_modules");
    if (existsSync(join(candidate, "@trama-dev", "runtime"))) {
      return candidate;
    }
    dir = dirname(dir);
  }
  throw new Error("Could not locate node_modules containing @trama-dev/runtime");
}

const TRAMA_NODE_MODULES = findRuntimeNodeModules();
const TSX_CLI = join(TRAMA_NODE_MODULES, "tsx", "dist", "cli.mjs");

export const PI_VERSION: string = JSON.parse(
  readFileSync(join(TRAMA_NODE_MODULES, "@mariozechner", "pi-coding-agent", "package.json"), "utf-8"),
).version;

/**
 * Ensure the project directory has a node_modules symlink to @trama-dev/runtime.
 * Only replaces the path if it is a symlink (ours) or doesn't exist.
 * Refuses to touch a real directory to avoid destroying user content.
 */
function ensureRuntimeLink(projectDir: string): void {
  const linkDir = join(projectDir, "node_modules", "@trama-dev");
  const linkPath = join(linkDir, "runtime");
  const target = join(TRAMA_NODE_MODULES, "@trama-dev", "runtime");

  try {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      // Ours — check if already correct
      if (readlinkSync(linkPath) === target) return;
      rmSync(linkPath);
    } else {
      // Real directory/file — not ours, refuse to destroy it
      throw new Error(
        `${linkPath} exists and is not a symlink. ` +
        `trama needs this path for module resolution. ` +
        `Remove it manually or rename it to proceed.`
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // ENOENT — path doesn't exist, proceed to create
  }

  mkdirSync(linkDir, { recursive: true });
  symlinkSync(target, linkPath, "dir");
}

/**
 * Ensure project has ESM package.json and .gitignore.
 * If package.json exists but lacks "type": "module", patches it in.
 */
function ensureProjectScaffold(projectDir: string): void {
  const pkgPath = join(projectDir, "package.json");
  if (existsSync(pkgPath)) {
    let pkg: unknown;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    } catch (err) {
      throw new Error(
        `Malformed package.json at ${pkgPath}. ` +
        `trama will not overwrite it automatically; fix or remove it and try again.\n` +
        `Parse error: ${err instanceof Error ? err.message : err}`
      );
    }
    if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) {
      throw new Error(
        `Malformed package.json at ${pkgPath} — expected a JSON object but got ${
          Array.isArray(pkg) ? "an array" : typeof pkg
        }. trama will not overwrite it automatically; fix or remove it and try again.`
      );
    }
    const pkgObj = pkg as Record<string, unknown>;
    if (pkgObj.type !== "module") {
      pkgObj.type = "module";
      writeFileSync(pkgPath, JSON.stringify(pkgObj, null, 2));
    }
  } else {
    writeFileSync(pkgPath, JSON.stringify({ type: "module" }, null, 2));
  }
  const giPath = join(projectDir, ".gitignore");
  const requiredEntries = ["node_modules/", "state.json", "logs/", "history/"];
  if (existsSync(giPath)) {
    const existing = readFileSync(giPath, "utf-8");
    const missing = requiredEntries.filter(e => !existing.split("\n").some(line => line.trim() === e));
    if (missing.length > 0) {
      const suffix = existing.endsWith("\n") ? "" : "\n";
      writeFileSync(giPath, existing + suffix + missing.join("\n") + "\n");
    }
  } else {
    writeFileSync(giPath, requiredEntries.join("\n") + "\n");
  }
}

// --- Runtime type definitions (included in system prompts) ---

/**
 * Simplified API reference for LLM system prompts.
 * NOT the canonical type definitions (those live in types.ts).
 * Kept as a readable string rather than auto-generated, because the LLM
 * needs a concise reference, not the full implementation types.
 * If types.ts changes, review whether this summary needs updating.
 */
export const RUNTIME_TYPES = `// @trama-dev/runtime - Complete API

export interface Ctx {
  input: { prompt: string; args: Record<string, unknown> };
  state: Record<string, unknown>;
  iteration: number;
  maxIterations: number;
  log(message: string, data?: Record<string, unknown>): Promise<void>;
  checkpoint(): Promise<void>;
  done(result?: Record<string, unknown>): Promise<void>;
}

export interface Agent {
  ask(prompt: string, options?: { system?: string }): Promise<string>;
  generate<T>(input: {
    prompt: string;
    schema: Record<string, string>;
    system?: string;
  }): Promise<T>;
}

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface Tools {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  shell(command: string, options?: { cwd?: string; timeout?: number }): Promise<ShellResult>;
  fetch(url: string, options?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ status: number; body: string; headers: Record<string, string> }>;
}

export declare const ctx: Ctx;
export declare const agent: Agent;
export declare const tools: Tools;`;

// --- Config & state loaders ---

export function loadConfig(): TramaConfig {
  const configPath = join(homedir(), ".trama", "config.json");
  const defaults: TramaConfig = {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
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

export function loadState(projectDir: string): Record<string, unknown> {
  const statePath = join(projectDir, "state.json");
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

// --- IPC Server ---

function createIPCServer(ctx: Ctx, agentImpl: Agent, toolsImpl: Tools): Server {
  return createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end("Method not allowed");
      return;
    }

    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk; });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        let result: unknown;

        switch (req.url) {
          case "/agent/ask":
            result = await agentImpl.ask(data.prompt, { system: data.system });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ result }));
            break;

          case "/agent/generate":
            result = await agentImpl.generate(data);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ result }));
            break;

          case "/tools/read":
            result = await toolsImpl.read(data.path);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ result }));
            break;

          case "/tools/write":
            await toolsImpl.write(data.path, data.content);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ result: null }));
            break;

          case "/tools/shell":
            result = await toolsImpl.shell(data.command, { cwd: data.cwd, timeout: data.timeout });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ result }));
            break;

          case "/tools/fetch":
            result = await toolsImpl.fetch(data.url, {
              method: data.method, headers: data.headers, body: data.body,
            });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ result }));
            break;

          case "/ctx/checkpoint":
            ctx.state = data.state;
            await ctx.checkpoint();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ result: null }));
            break;

          case "/ctx/log":
            await ctx.log(data.message, data.data);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ result: null }));
            break;

          case "/ctx/done":
            ctx.state = data.state;
            await ctx.done(data.result);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ result: null }));
            break;

          default:
            res.writeHead(404);
            res.end("Not found");
        }
      } catch (err) {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(err));
      }
    });
  });
}

function startServer(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve(addr.port);
      } else {
        reject(new Error("Failed to get server port"));
      }
    });
    server.on("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(err => {
      if (!err || (err as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") {
        resolve();
      } else {
        reject(err);
      }
    });
  });
}

/** Abort in-flight operations, kill orphan shells, drop HTTP connections, then close. */
function forceCloseServer(server: Server, toolsImpl: ToolsWithCleanup, abortController?: AbortController): Promise<void> {
  abortController?.abort();
  toolsImpl.killActiveShells();
  server.closeAllConnections();
  return closeServer(server);
}

// --- Child process management ---

/**
 * Collect stdout/stderr as strings and wait for exit.
 * Enforces wall-clock timeout via explicit setTimeout + kill.
 */
function waitForChild(
  child: ChildProcess,
  timeout: number,
  sinks?: { stdout?: (chunk: string) => void; stderr?: (chunk: string) => void },
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const out = cappedBuffer();
    const err = cappedBuffer();
    let timedOut = false;
    let exited = false;
    let killFallbackTimer: ReturnType<typeof setTimeout> | null = null;

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      out.append(text);
      sinks?.stdout?.(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      err.append(text);
      sinks?.stderr?.(text);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killFallbackTimer = setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, 5000);
      killFallbackTimer.unref?.();
    }, timeout);

    child.on("error", (err) => {
      clearTimeout(timer);
      if (killFallbackTimer) clearTimeout(killFallbackTimer);
      reject(err);
    });

    child.on("close", (code) => {
      exited = true;
      clearTimeout(timer);
      if (killFallbackTimer) clearTimeout(killFallbackTimer);
      if (timedOut) {
        resolve({ exitCode: 1, stdout: out.value, stderr: err.value + "\n[trama] program killed: timeout" });
      } else {
        resolve({ exitCode: code ?? 1, stdout: out.value, stderr: err.value });
      }
    });
  });
}

// --- History management ---

/**
 * Copy current program.ts to history/NNNN.ts and append to index.jsonl.
 *
 * WARNING: Do NOT use this for create-time repair attempts.
 * Create-time repairs go to index.jsonl only (reason: "create-repair").
 */
export function copyToHistory(projectDir: string, reason: string, detail?: string) {
  const historyDir = join(projectDir, "history");
  const existing = readdirSync(historyDir).filter(f => /^\d+\.ts$/.test(f));

  const nums = existing.map(f => parseInt(f.replace(".ts", ""), 10));
  const nextNum = nums.length > 0 ? nums.reduce((a, b) => Math.max(a, b), 0) + 1 : 1;
  const next = String(nextNum).padStart(Math.max(4, String(nextNum).length), "0");

  copyFileSync(join(projectDir, "program.ts"), join(historyDir, `${next}.ts`));

  const entry: Record<string, unknown> = { version: nextNum, reason, timestamp: new Date().toISOString() };
  if (reason === "repair" && detail) entry.error = detail;
  if (reason === "update" && detail) entry.prompt = detail;
  appendFileSync(join(historyDir, "index.jsonl"), JSON.stringify(entry) + "\n");
}

// --- Helpers ---

/**
 * Snapshot a directory, run fn, restore from snapshot if fn returns false.
 * Always cleans up the snapshot. Returns whatever fn returns.
 */
async function withSnapshot<T>(dir: string, fn: () => Promise<{ keep: boolean; value: T }>): Promise<T> {
  const snap = mkdtempSync(join(tmpdir(), "trama-snapshot-"));
  try {
    cpSync(dir, snap, { recursive: true });
    const result = await fn();
    if (!result.keep) {
      rmSync(dir, { recursive: true, force: true });
      cpSync(snap, dir, { recursive: true });
    }
    return result.value;
  } finally {
    rmSync(snap, { recursive: true, force: true });
  }
}

/** Run fn in a temp directory, clean up afterwards regardless of outcome. */
export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Attempt a single repair call with its own timeout and cancellation.
 * Returns true if repair succeeded, false if it failed (error is appended to repairErrors).
 */
async function repairWithTimeout(
  adapter: PiAdapter,
  input: { programSource: string; error: string; runtimeTypes: string },
  timeout: number,
  repairErrors: string[],
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await adapter.repair(input, controller.signal);
  } catch (err) {
    repairErrors.push(err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- Single program execution ---

interface RunOnceOptions {
  projectDir: string;
  adapter: PiAdapter;
  timeout: number;
  maxIterations: number;
  argsOverride?: Record<string, unknown>;
  streamOutput?: boolean;
}

/**
 * Run program.ts once in the given directory. Sets up scaffolding, IPC server,
 * writes init file, spawns child, waits for result, and cleans up.
 * Returns the child process result — does NOT throw on non-zero exit.
 */
async function runProgramOnce(options: RunOnceOptions): Promise<ChildResult> {
  const { projectDir, adapter, timeout, maxIterations, argsOverride, streamOutput } = options;

  ensureProjectScaffold(projectDir);
  ensureRuntimeLink(projectDir);
  writeFileSync(join(projectDir, "logs", "latest.jsonl"), "");

  const abortController = new AbortController();
  const { signal } = abortController;
  const ctx = createContext(projectDir, loadState(projectDir), { maxIterations, argsOverride });
  const agentImpl = createAgent(adapter, signal);
  const toolsImpl = createTools(projectDir, signal);
  const server = createIPCServer(ctx, agentImpl, toolsImpl);

  // Infrastructure setup — errors here are NOT program bugs.
  let port: number;
  try {
    port = await startServer(server);
  } catch (infraError) {
    await forceCloseServer(server, toolsImpl, abortController);
    throw infraError;
  }

  // Write init data to a temp file instead of env vars to avoid OS size limits.
  const initFile = join(tmpdir(), `trama-init-${port}.json`);
  writeFileSync(initFile, JSON.stringify({
    input: ctx.input,
    state: ctx.state,
    iteration: ctx.iteration,
    maxIterations: ctx.maxIterations,
  }));

  const child = spawn(process.execPath, [TSX_CLI, join(projectDir, "program.ts")], {
    cwd: projectDir,
    env: {
      ...process.env,
      TRAMA_PORT: String(port),
      TRAMA_INIT: initFile,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let result: ChildResult;
  try {
    result = await waitForChild(child, timeout, streamOutput ? {
      stdout: chunk => { process.stdout.write(chunk); },
      stderr: chunk => { process.stderr.write(chunk); },
    } : undefined);
  } catch (spawnError) {
    await forceCloseServer(server, toolsImpl, abortController);
    try { rmSync(initFile); } catch { /* best-effort */ }
    throw spawnError;
  }

  try { rmSync(initFile); } catch { /* best-effort */ }

  if (result.exitCode === 0) {
    try { await closeServer(server); } catch { await forceCloseServer(server, toolsImpl, abortController); }
  } else {
    try { await forceCloseServer(server, toolsImpl, abortController); } catch { /* best-effort */ }
  }

  return result;
}

// --- Shared execution core ---

interface ExecuteOptions {
  projectDir: string;
  adapter: PiAdapter;
  maxRepairAttempts: number;
  timeout: number;
  maxIterations: number;
  argsOverride?: Record<string, unknown>;
  /** Called after a successful repair. Receives attempt index and original error string. */
  onRepair?: (attempt: number, maxAttempts: number, error: string) => void;
}

const formatError = (r: ChildResult) =>
  `program.ts exited with code ${r.exitCode}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;

async function executeProgram(options: ExecuteOptions): Promise<void> {
  const { projectDir, adapter, maxRepairAttempts, timeout, maxIterations } = options;

  mkdirSync(join(projectDir, "history"), { recursive: true });
  mkdirSync(join(projectDir, "logs"), { recursive: true });

  // Phase 1: Run in the real project directory.
  const result = await runProgramOnce({
    projectDir, adapter, timeout, maxIterations,
    argsOverride: options.argsOverride,
    streamOutput: true,
  });
  if (result.exitCode === 0) return;

  if (maxRepairAttempts === 0) {
    throw new Error(`Failed after 0 repair attempts: ${formatError(result)}`);
  }

  // Phase 2: Repair loop — both LLM repair call and verification run
  // are fully isolated in temp dirs to prevent side effects on the real project.
  let lastError = formatError(result);
  const originalSource = readFileSync(join(projectDir, "program.ts"), "utf-8");
  let currentSource = originalSource;
  const repairErrors: string[] = [];
  const repairDetails = () => repairErrors.length > 0
    ? `\nRepair errors:\n${repairErrors.map((e, i) => `  [${i + 1}] ${e}`).join("\n")}` : "";

  for (let attempt = 0; attempt < maxRepairAttempts; attempt++) {
    const repairResult = await withTempDir("trama-repair-", async (tempDir) => {
      cpSync(projectDir, tempDir, { recursive: true });
      const tempAdapter = adapter.withCwd(tempDir);

      const fixed = await repairWithTimeout(
        tempAdapter,
        { programSource: currentSource, error: lastError, runtimeTypes: RUNTIME_TYPES },
        timeout,
        repairErrors,
      );
      if (!fixed) return null;

      writeFileSync(join(tempDir, "program.ts"), fixed);
      const verifyResult = await runProgramOnce({
        projectDir: tempDir, adapter: tempAdapter, timeout, maxIterations,
        argsOverride: options.argsOverride,
      });
      return { fixed, verifyResult };
    });

    if (!repairResult) {
      // Repair LLM call itself failed — don't re-run the same broken program.
      throw new Error(`Failed after ${attempt + 1} repair attempt(s): ${lastError}${repairDetails()}`);
    }

    if (repairResult.verifyResult.exitCode === 0) {
      // Repair verified in isolation — now run in the real project for actual output.
      // Snapshot first so we can restore cleanly if the real run fails.
      const realResult = await withSnapshot(projectDir, async () => {
        writeFileSync(join(projectDir, "program.ts"), repairResult.fixed);
        const r = await runProgramOnce({
          projectDir, adapter, timeout, maxIterations,
          argsOverride: options.argsOverride,
          streamOutput: true,
        });
        return { keep: r.exitCode === 0, value: r };
      });
      if (realResult.exitCode === 0) {
        options.onRepair?.(attempt, maxRepairAttempts, lastError);
        return;
      }
      // Passed in isolation but failed in real dir — project already restored by withSnapshot.
      currentSource = repairResult.fixed;
      lastError = formatError(realResult);
      continue;
    }

    // Repair produced broken code — update context for next attempt.
    currentSource = repairResult.fixed;
    lastError = formatError(repairResult.verifyResult);
  }

  throw new Error(`Failed after ${maxRepairAttempts} repair attempts: ${lastError}${repairDetails()}`);
}

// --- Smoke run (used by create and update) ---

/** Copy new history entries from src to dst (appends only entries added after the shared prefix). */
function propagateHistoryEntries(srcDir: string, dstDir: string): void {
  const srcPath = join(srcDir, "history", "index.jsonl");
  const dstPath = join(dstDir, "history", "index.jsonl");
  if (!existsSync(srcPath)) return;

  const srcHistory = readFileSync(srcPath, "utf-8");
  const dstHistory = existsSync(dstPath) ? readFileSync(dstPath, "utf-8") : "";
  if (!srcHistory.startsWith(dstHistory)) return; // History diverged — cannot safely propagate
  const newEntries = srcHistory.slice(dstHistory.length);
  if (newEntries.length > 0) {
    mkdirSync(join(dstDir, "history"), { recursive: true });
    appendFileSync(dstPath, newEntries);
  }
}

export async function smokeRunAndRepair(
  projectDir: string,
  adapter: PiAdapter,
  reason: "create" | "update",
  options?: { timeout?: number; maxRepairAttempts?: number; maxIterations?: number },
): Promise<void> {
  const smokeTimeout = options?.timeout ?? 30_000;
  // Run validation in a temp copy so side effects don't persist in the real project
  await withTempDir("trama-smoke-", async (smokeDir) => {
    cpSync(projectDir, smokeDir, { recursive: true });
    const smokeAdapter = adapter.withCwd(smokeDir);

    try {
      await executeProgram({
        projectDir: smokeDir,
        adapter: smokeAdapter,
        maxRepairAttempts: options?.maxRepairAttempts ?? 3,
        timeout: smokeTimeout,
        maxIterations: options?.maxIterations ?? 100,
        onRepair(_attempt, _max, error) {
          appendFileSync(
            join(smokeDir, "history", "index.jsonl"),
            JSON.stringify({ reason: `${reason}-repair`, timestamp: new Date().toISOString(), error }) + "\n"
          );
        },
      });

      // Smoke passed — copy back program.ts (may have been repaired)
      copyFileSync(join(smokeDir, "program.ts"), join(projectDir, "program.ts"));
    } finally {
      // Always propagate repair history, whether smoke passed or failed
      propagateHistoryEntries(smokeDir, projectDir);
    }
  });
}

// --- Core execution ---

export async function runProgram(options: RunOptions) {
  const { projectDir } = options;

  if (!existsSync(join(projectDir, "meta.json"))) {
    throw new Error(
      `Project not found at ${projectDir}. ` +
      `Run \`trama list\` to see available projects.`
    );
  }

  const config = loadConfig();
  const maxRepairAttempts = options.maxRepairAttempts ?? config.maxRepairAttempts;
  const timeout = options.timeout ?? config.defaultTimeout;
  const maxIterations = config.defaultMaxIterations;

  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`Invalid timeout: ${timeout}. Must be a positive number.`);
  }
  if (!Number.isInteger(maxRepairAttempts) || maxRepairAttempts < 0) {
    throw new Error(`Invalid maxRepairAttempts: ${maxRepairAttempts}. Must be a non-negative integer.`);
  }

  const adapter = new PiAdapter(config, projectDir);

  await executeProgram({
    projectDir,
    adapter,
    maxRepairAttempts,
    timeout,
    maxIterations,
    argsOverride: options.args,
    onRepair(attempt, max, error) {
      // Log repair attempts (appends to already-open logs file)
      const logsPath = join(projectDir, "logs", "latest.jsonl");
      const entry = { ts: Date.now(), message: `Repair attempt ${attempt + 1}/${max}`, data: { error } };
      appendFileSync(logsPath, JSON.stringify(entry) + "\n");
      console.log(`[trama] Repair attempt ${attempt + 1}/${max}`);

      copyToHistory(projectDir, "repair", error);
    },
  });
}
