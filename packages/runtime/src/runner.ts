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
import { createTools, type ToolsWithCleanup } from "./tools.js";

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
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.type !== "module") {
        pkg.type = "module";
        writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
      }
    } catch (err) {
      throw new Error(
        `Malformed package.json at ${pkgPath}. ` +
        `trama will not overwrite it automatically; fix or remove it and try again.\n` +
        `Parse error: ${err instanceof Error ? err.message : err}`
      );
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
  try {
    return { ...defaults, ...JSON.parse(raw) };
  } catch (err) {
    throw new Error(
      `Malformed config at ${configPath} — fix or delete it.\n` +
      `Parse error: ${err instanceof Error ? err.message : err}`
    );
  }
}

export function loadState(projectDir: string): Record<string, unknown> {
  const statePath = join(projectDir, "state.json");
  if (!existsSync(statePath)) return {};
  const raw = readFileSync(statePath, "utf-8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Corrupt state.json in ${projectDir} — cannot safely continue.\n` +
      `Parse error: ${err instanceof Error ? err.message : err}\n` +
      `Back up or delete state.json to reset state.`
    );
  }
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
        res.writeHead(500);
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
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let exited = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      sinks?.stdout?.(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      sinks?.stderr?.(text);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, 5000);
    }, timeout);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      exited = true;
      clearTimeout(timer);
      if (timedOut) {
        resolve({ exitCode: 1, stdout, stderr: stderr + "\n[trama] program killed: timeout" });
      } else {
        resolve({ exitCode: code ?? 1, stdout, stderr });
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
  const nextNum = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  const next = String(nextNum).padStart(Math.max(4, String(nextNum).length), "0");

  copyFileSync(join(projectDir, "program.ts"), join(historyDir, `${next}.ts`));

  const entry: Record<string, unknown> = { version: nextNum, reason, timestamp: new Date().toISOString() };
  if (reason === "repair" && detail) entry.error = detail;
  if (reason === "update" && detail) entry.prompt = detail;
  appendFileSync(join(historyDir, "index.jsonl"), JSON.stringify(entry) + "\n");
}

// --- Helpers ---

/** Run fn in a temp directory, clean up afterwards regardless of outcome. */
async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
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

// --- Shared execution core ---

interface ExecuteOptions {
  projectDir: string;
  adapter: PiAdapter;
  maxRepairAttempts: number;
  timeout: number;
  maxIterations: number;
  /** Called after a successful repair. Receives attempt index and original error string. */
  onRepair?: (attempt: number, maxAttempts: number, error: string) => void;
}

async function executeProgram(options: ExecuteOptions): Promise<void> {
  const { projectDir, adapter, maxRepairAttempts, timeout, maxIterations } = options;

  mkdirSync(join(projectDir, "history"), { recursive: true });
  mkdirSync(join(projectDir, "logs"), { recursive: true });
  ensureProjectScaffold(projectDir);
  ensureRuntimeLink(projectDir);

  writeFileSync(join(projectDir, "logs", "latest.jsonl"), "");

  const repairErrors: string[] = [];

  for (let attempt = 0; attempt <= maxRepairAttempts; attempt++) {
    const abortController = new AbortController();
    const { signal } = abortController;
    const ctx = createContext(projectDir, loadState(projectDir), { maxIterations });
    const agentImpl = createAgent(adapter, signal);
    const toolsImpl = createTools(projectDir, signal);

    const server = createIPCServer(ctx, agentImpl, toolsImpl);

    try {
      const port = await startServer(server);
      const meta = JSON.parse(readFileSync(join(projectDir, "meta.json"), "utf-8"));

      const child = spawn(process.execPath, [TSX_CLI, join(projectDir, "program.ts")], {
        cwd: projectDir,
        env: {
          ...process.env,
          TRAMA_PORT: String(port),
          TRAMA_INPUT: JSON.stringify(meta.input),
          TRAMA_STATE: JSON.stringify(ctx.state),
          TRAMA_ITERATION: String(ctx.iteration),
          TRAMA_MAX_ITERATIONS: String(ctx.maxIterations),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const result = await waitForChild(child, timeout, {
        stdout: chunk => { process.stdout.write(chunk); },
        stderr: chunk => { process.stderr.write(chunk); },
      });

      if (result.exitCode === 0) {
        await closeServer(server);
        return;
      }

      throw new Error(
        `program.ts exited with code ${result.exitCode}\n` +
        `stdout: ${result.stdout}\n` +
        `stderr: ${result.stderr}`
      );

    } catch (error) {
      await forceCloseServer(server, toolsImpl, abortController);

      if (attempt === maxRepairAttempts) {
        const details = repairErrors.length > 0
          ? `\nRepair errors:\n${repairErrors.map((e, i) => `  [${i + 1}] ${e}`).join("\n")}`
          : "";
        throw new Error(`Failed after ${maxRepairAttempts} repair attempts: ${error}${details}`);
      }

      const source = readFileSync(join(projectDir, "program.ts"), "utf-8");
      const fixed = await repairWithTimeout(
        adapter,
        { programSource: source, error: String(error), runtimeTypes: RUNTIME_TYPES },
        timeout,
        repairErrors,
      );

      if (fixed !== null) {
        writeFileSync(join(projectDir, "program.ts"), fixed);
        options.onRepair?.(attempt, maxRepairAttempts, String(error));
      }
    }
  }
}

// --- Smoke run (used by create and update) ---

/** Copy new history entries from src to dst (appends only entries added after the shared prefix). */
function propagateHistoryEntries(srcDir: string, dstDir: string): void {
  const srcPath = join(srcDir, "history", "index.jsonl");
  const dstPath = join(dstDir, "history", "index.jsonl");
  if (!existsSync(srcPath)) return;

  const srcHistory = readFileSync(srcPath, "utf-8");
  const dstHistory = existsSync(dstPath) ? readFileSync(dstPath, "utf-8") : "";
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
): Promise<void> {
  // Run validation in a temp copy so side effects don't persist in the real project
  await withTempDir("trama-smoke-", async (smokeDir) => {
    cpSync(projectDir, smokeDir, { recursive: true });
    const smokeAdapter = adapter.withCwd(smokeDir);

    try {
      await executeProgram({
        projectDir: smokeDir,
        adapter: smokeAdapter,
        maxRepairAttempts: 3,
        timeout: 5000,
        maxIterations: 100,
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
