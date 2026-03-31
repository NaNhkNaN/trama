import { createServer, type Server } from "http";
import { spawn, type ChildProcess } from "child_process";
import {
  readFileSync, writeFileSync, appendFileSync,
  readdirSync, copyFileSync, mkdirSync, existsSync,
  symlinkSync, rmSync, lstatSync, readlinkSync,
  cpSync, mkdtempSync, openSync, closeSync,
} from "fs";
import { join, dirname } from "path";
import { homedir, tmpdir } from "os";
import { fileURLToPath } from "url";
import { StringDecoder } from "string_decoder";
import type { Ctx, Agent, Tools, RunOptions, ChildResult, TramaConfig } from "./types.js";
import { PiAdapter } from "./pi-adapter.js";
import { createContext } from "./context.js";
import { createAgent } from "./agent.js";
import { createTools, cappedBuffer, type ToolsWithCleanup } from "./tools.js";
import { guardPath } from "./path-guard.js";
import { assertSerializable } from "./serializable.js";

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
 * Replaces any existing symlink whose target differs (including user-managed ones).
 * Only refuses to touch a real directory/file to avoid destroying user content.
 */
function ensureRuntimeLink(projectDir: string): void {
  // node_modules/@trama-dev/runtime is deliberately a symlink pointing OUTSIDE
  // the project (to the global trama install). Do not apply guardPath here.
  const linkDir = join(projectDir, "node_modules", "@trama-dev");
  const linkPath = join(linkDir, "runtime");
  const target = join(TRAMA_NODE_MODULES, "@trama-dev", "runtime");

  try {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      // Symlink exists — replace if target doesn't match
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
export function ensureProjectScaffold(projectDir: string): void {
  const pkgPath = guardPath(projectDir, "package.json");
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
  const giPath = guardPath(projectDir, ".gitignore");
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
  ready(data?: Record<string, unknown>): Promise<void>;
  checkpoint(): Promise<void>;
  done(result?: Record<string, unknown>): Promise<void>;
}

export interface Agent {
  instruct(prompt: string, options?: { system?: string }): Promise<string>;
  /** @deprecated Use instruct() instead */
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

// --- IPC Server ---

const MAX_IPC_BODY = 50 * 1024 * 1024; // 50 MB

/** Validate required fields in IPC request body. Returns error message or null. */
function validateIPC(data: Record<string, unknown>, fields: Record<string, string>): string | null {
  for (const [name, type] of Object.entries(fields)) {
    const val = data[name];
    if (type === "object") {
      if (typeof val !== "object" || val === null || Array.isArray(val)) {
        return `Missing or invalid field: ${name} (expected object)`;
      }
    } else if (typeof val !== type) {
      return `Missing or invalid field: ${name} (expected ${type})`;
    }
  }
  return null;
}

function createIPCServer(ctx: Ctx, agentImpl: Agent, toolsImpl: Tools): Server {
  return createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end("Method not allowed");
      return;
    }

    const chunks: Buffer[] = [];
    let byteCount = 0;
    let overflow = false;
    req.on("data", (chunk: Buffer) => {
      if (overflow) return;
      chunks.push(chunk);
      byteCount += chunk.length;
      if (byteCount > MAX_IPC_BODY) {
        overflow = true;
        res.writeHead(413);
        res.end("IPC request body exceeds 50MB limit");
        req.destroy();
      }
    });
    req.on("end", async () => {
      if (overflow) return;
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        let result: unknown;

        // Per-endpoint field validation
        const validationRules: Record<string, Record<string, string>> = {
          "/agent/ask": { prompt: "string" },
          "/agent/generate": { prompt: "string", schema: "object" },
          "/tools/read": { path: "string" },
          "/tools/write": { path: "string", content: "string" },
          "/tools/shell": { command: "string" },
          "/tools/fetch": { url: "string" },
          "/ctx/checkpoint": { state: "object" },
          "/ctx/log": { message: "string" },
          "/ctx/done": { state: "object" },
        };
        const rules = req.url ? validationRules[req.url] : undefined;
        if (rules) {
          const validationError = validateIPC(data, rules);
          if (validationError) {
            res.writeHead(400);
            res.end(validationError);
            return;
          }
        }

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
            assertSerializable(data.state, "ctx.state");
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

          case "/ctx/ready":
            if (data.data !== undefined && (typeof data.data !== "object" || data.data === null || Array.isArray(data.data))) {
              res.writeHead(400);
              res.end("Invalid field: data (expected object or undefined)");
              break;
            }
            await ctx.ready(data.data);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ result: null }));
            break;

          case "/ctx/done":
            assertSerializable(data.state, "ctx.state");
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
  options: WaitForChildOptions,
): Promise<ChildResult> {
  const { timeout, sinks, stopSignal } = options;
  return new Promise((resolve, reject) => {
    const out = cappedBuffer();
    const err = cappedBuffer();
    const outDecoder = new StringDecoder("utf-8");
    const errDecoder = new StringDecoder("utf-8");
    let timedOut = false;
    let exited = false;
    let stopRequested = false;
    let killFallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const killChild = (sig: NodeJS.Signals) => {
      if (child.pid) {
        try { process.kill(-child.pid, sig); } catch { /* already gone */ }
      } else {
        child.kill(sig);
      }
    };

    const scheduleKill = (reason: "timeout" | "stop-request") => {
      if (exited) return;
      if (reason === "timeout") {
        timedOut = true;
      } else if (stopRequested || timedOut) {
        return;
      } else {
        stopRequested = true;
      }
      killChild("SIGTERM");
      if (killFallbackTimer) clearTimeout(killFallbackTimer);
      killFallbackTimer = setTimeout(() => {
        if (!exited) killChild("SIGKILL");
      }, 5000);
      killFallbackTimer.unref?.();
    };

    const onStopRequest = () => scheduleKill("stop-request");
    stopSignal?.addEventListener("abort", onStopRequest, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = outDecoder.write(chunk);
      out.append(text);
      sinks?.stdout?.(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = errDecoder.write(chunk);
      err.append(text);
      sinks?.stderr?.(text);
    });

    const timer = setTimeout(() => {
      scheduleKill("timeout");
    }, timeout);

    child.on("error", (err) => {
      clearTimeout(timer);
      if (killFallbackTimer) clearTimeout(killFallbackTimer);
      stopSignal?.removeEventListener("abort", onStopRequest);
      reject(err);
    });

    child.on("close", (code, signal) => {
      exited = true;
      clearTimeout(timer);
      if (killFallbackTimer) clearTimeout(killFallbackTimer);
      stopSignal?.removeEventListener("abort", onStopRequest);
      const outFlush = outDecoder.end();
      const errFlush = errDecoder.end();
      if (outFlush) { out.append(outFlush); sinks?.stdout?.(outFlush); }
      if (errFlush) { err.append(errFlush); sinks?.stderr?.(errFlush); }
      if (timedOut) {
        resolve({ exitCode: 1, stdout: out.value, stderr: err.value + "\n[trama] program killed: timeout" });
      } else if (stopRequested && (code === 0 || signal === "SIGTERM")) {
        resolve({ exitCode: 0, stdout: out.value, stderr: err.value });
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
  const historyDir = guardPath(projectDir, "history");
  const existing = readdirSync(historyDir).filter(f => /^\d+\.ts$/.test(f));

  const nums = existing.map(f => parseInt(f.replace(".ts", ""), 10));
  const nextNum = nums.length > 0 ? nums.reduce((a, b) => Math.max(a, b), 0) + 1 : 1;
  const next = String(nextNum).padStart(Math.max(4, String(nextNum).length), "0");

  const srcPath = guardPath(projectDir, "program.ts");
  const dstPath = guardPath(projectDir, join("history", `${next}.ts`));
  copyFileSync(srcPath, dstPath);

  const entry: Record<string, unknown> = { version: nextNum, reason, timestamp: new Date().toISOString() };
  if (reason === "repair" && detail) entry.error = detail;
  if (reason === "update" && detail) entry.prompt = detail;
  const indexPath = guardPath(projectDir, join("history", "index.jsonl"));
  appendFileSync(indexPath, JSON.stringify(entry) + "\n");
}

// --- Helpers ---

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
  stopOnReady?: {
    graceMs: number;
  };
}

interface WaitForChildOptions {
  timeout: number;
  sinks?: { stdout?: (chunk: string) => void; stderr?: (chunk: string) => void };
  stopSignal?: AbortSignal;
}

/**
 * Run program.ts once in the given directory. Sets up scaffolding, IPC server,
 * writes init file, spawns child, waits for result, and cleans up.
 * Returns the child process result — does NOT throw on non-zero exit.
 */
async function runProgramOnce(options: RunOnceOptions): Promise<ChildResult> {
  const { projectDir, adapter, timeout, maxIterations, argsOverride, streamOutput, stopOnReady } = options;

  ensureProjectScaffold(projectDir);
  ensureRuntimeLink(projectDir);

  const abortController = new AbortController();
  const stopController = new AbortController();
  const { signal } = abortController;
  let readyStopScheduled = false;
  let readyStopTimer: ReturnType<typeof setTimeout> | null = null;
  // When set, the grace period is active — child exit should cancel the timer
  // so that the natural exit code flows through instead of being masked by SIGTERM.
  let graceActive = false;
  const ctx = createContext(projectDir, loadState(projectDir), {
    maxIterations,
    argsOverride,
    onReady: stopOnReady ? () => {
      if (readyStopScheduled) return;
      readyStopScheduled = true;
      graceActive = true;
      readyStopTimer = setTimeout(() => {
        graceActive = false;
        stopController.abort();
      }, stopOnReady.graceMs);
      readyStopTimer.unref?.();
    } : undefined,
  });
  // Truncate logs only after preflight succeeds — preserves prior run's diagnostics
  // if scaffolding, state loading, or context creation fails.
  writeFileSync(guardPath(projectDir, join("logs", "latest.jsonl")), "");
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
  // Use mkdtempSync for an unpredictable path and mode 0o600 to prevent local disclosure.
  const initDir = mkdtempSync(join(tmpdir(), "trama-init-"));
  const initFile = join(initDir, "init.json");
  const fd = openSync(initFile, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify({
      input: ctx.input,
      state: ctx.state,
      iteration: ctx.iteration,
      maxIterations: ctx.maxIterations,
    }));
  } finally {
    closeSync(fd);
  }

  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [TSX_CLI, guardPath(projectDir, "program.ts")], {
      cwd: projectDir,
      env: {
        ...process.env,
        TRAMA_PORT: String(port),
        TRAMA_INIT: initFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
  } catch (spawnError) {
    if (readyStopTimer) clearTimeout(readyStopTimer);
    await forceCloseServer(server, toolsImpl, abortController);
    try { rmSync(initDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw spawnError;
  }

  // If the child exits on its own during the grace period (before we send
  // SIGTERM), cancel the grace timer so the real exit code flows through
  // waitForChild instead of being masked by a subsequent SIGTERM.
  if (stopOnReady) {
    child.on("close", () => {
      if (graceActive && readyStopTimer) {
        clearTimeout(readyStopTimer);
        readyStopTimer = null;
        graceActive = false;
      }
    });
  }

  let result: ChildResult;
  try {
    result = await waitForChild(child, {
      timeout,
      stopSignal: stopOnReady ? stopController.signal : undefined,
      sinks: streamOutput ? {
        stdout: chunk => { process.stdout.write(chunk); },
        stderr: chunk => { process.stderr.write(chunk); },
      } : undefined,
    });
  } catch (spawnError) {
    if (readyStopTimer) clearTimeout(readyStopTimer);
    await forceCloseServer(server, toolsImpl, abortController);
    try { rmSync(initDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw spawnError;
  }

  if (readyStopTimer) clearTimeout(readyStopTimer);
  try { rmSync(initDir, { recursive: true, force: true }); } catch { /* best-effort */ }

  // Always kill background shells — even on success, spawned background
  // processes would otherwise outlive the runner and leak.
  toolsImpl.killActiveShells();

  if (result.exitCode === 0) {
    abortController.abort(); // cancel any in-flight LLM/fetch requests
    try { await closeServer(server); } catch { await forceCloseServer(server, toolsImpl); }
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
  stopOnReady?: {
    graceMs: number;
  };
  /** Called after a successful repair. Receives attempt index and original error string. */
  onRepair?: (attempt: number, maxAttempts: number, error: string) => void;
}

const formatError = (r: ChildResult) =>
  `program.ts exited with code ${r.exitCode}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;

async function executeProgram(options: ExecuteOptions): Promise<void> {
  const { projectDir, adapter, maxRepairAttempts, timeout, maxIterations } = options;

  mkdirSync(guardPath(projectDir, "history"), { recursive: true });
  mkdirSync(guardPath(projectDir, "logs"), { recursive: true });

  // Phase 1: Run in the real project directory.
  const result = await runProgramOnce({
    projectDir, adapter, timeout, maxIterations,
    argsOverride: options.argsOverride,
    streamOutput: true,
    stopOnReady: options.stopOnReady,
  });
  if (result.exitCode === 0) return;

  if (maxRepairAttempts === 0) {
    throw new Error(`Program failed (repair disabled): ${formatError(result)}`);
  }

  // Phase 2: Repair loop — both LLM repair call and verification run
  // are fully isolated in temp dirs to prevent side effects on the real project.
  let lastError = formatError(result);
  const originalSource = readFileSync(guardPath(projectDir, "program.ts"), "utf-8");
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

      writeFileSync(guardPath(tempDir, "program.ts"), fixed);
      const verifyResult = await runProgramOnce({
        projectDir: tempDir, adapter: tempAdapter, timeout, maxIterations,
        argsOverride: options.argsOverride,
        stopOnReady: options.stopOnReady,
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
        writeFileSync(guardPath(projectDir, "program.ts"), repairResult.fixed);
        const r = await runProgramOnce({
          projectDir, adapter, timeout, maxIterations,
          argsOverride: options.argsOverride,
          streamOutput: true,
          stopOnReady: options.stopOnReady,
        });
        return { keep: r.exitCode === 0, value: r };
      });
      if (realResult.exitCode === 0) {
        // Bookkeeping is best-effort — program already succeeded and side effects
        // are committed. Don't mask success with a history/log write failure.
        try {
          options.onRepair?.(attempt, maxRepairAttempts, lastError);
        } catch (bookkeepingErr) {
          console.warn(`[trama] repair bookkeeping failed: ${bookkeepingErr instanceof Error ? bookkeepingErr.message : bookkeepingErr}`);
        }
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
  const srcPath = guardPath(srcDir, join("history", "index.jsonl"));
  const dstPath = guardPath(dstDir, join("history", "index.jsonl"));
  if (!existsSync(srcPath)) return;

  const srcHistory = readFileSync(srcPath, "utf-8");
  const dstHistory = existsSync(dstPath) ? readFileSync(dstPath, "utf-8") : "";
  if (!srcHistory.startsWith(dstHistory)) return; // History diverged — cannot safely propagate
  const newEntries = srcHistory.slice(dstHistory.length);
  if (newEntries.length > 0) {
    mkdirSync(guardPath(dstDir, "history"), { recursive: true });
    appendFileSync(dstPath, newEntries);
  }
}

const DEFAULT_SMOKE_TIMEOUT = 30_000;
const SMOKE_READY_GRACE_MS = 2_000;

export function resolveSmokeTimeout(timeout?: number): number {
  return timeout ?? DEFAULT_SMOKE_TIMEOUT;
}

export async function smokeRunAndRepair(
  projectDir: string,
  adapter: PiAdapter,
  reason: "create" | "update",
  options?: { timeout?: number; maxRepairAttempts?: number; maxIterations?: number },
): Promise<void> {
  const smokeTimeout = resolveSmokeTimeout(options?.timeout);
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
        stopOnReady: {
          graceMs: SMOKE_READY_GRACE_MS,
        },
        onRepair(_attempt, _max, error) {
          appendFileSync(
            guardPath(smokeDir, join("history", "index.jsonl")),
            JSON.stringify({ reason: `${reason}-repair`, timestamp: new Date().toISOString(), error }) + "\n"
          );
        },
      });

      // Smoke passed — copy back program.ts (may have been repaired)
      copyFileSync(guardPath(smokeDir, "program.ts"), guardPath(projectDir, "program.ts"));
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
  // Use per-project model/provider if saved, else fall back to global config
  const metaPath = guardPath(projectDir, "meta.json");
  const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
  if (meta.model) config.model = meta.model;
  if (meta.provider) config.provider = meta.provider;

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
      const logsPath = guardPath(projectDir, join("logs", "latest.jsonl"));
      const entry = { ts: Date.now(), message: `Repair attempt ${attempt + 1}/${max}`, data: { error } };
      appendFileSync(logsPath, JSON.stringify(entry) + "\n");
      console.log(`[trama] Repair attempt ${attempt + 1}/${max}`);

      copyToHistory(projectDir, "repair", error);
    },
  });
}
