// @trama-dev/runtime client — this is what program.ts imports.
// Thin HTTP wrapper that calls the runner's IPC server.

import { readFileSync } from "fs";
import type { Ctx, Agent, Tools, Workspace } from "./types.js";
import { assertSerializable } from "./serializable.js";

const PORT = process.env.TRAMA_PORT;
if (!PORT) {
  throw new Error(
    "@trama-dev/runtime must be executed via `trama run`. " +
    "Direct execution is not supported (TRAMA_PORT env var missing)."
  );
}

const INIT_PATH = process.env.TRAMA_INIT;
if (!INIT_PATH) {
  throw new Error(
    "@trama-dev/runtime: TRAMA_INIT env var missing. " +
    "This program must be launched by the trama runner."
  );
}

const BASE = `http://127.0.0.1:${PORT}`;
const initData = JSON.parse(readFileSync(INIT_PATH, "utf-8"));

async function call(endpoint: string, body: unknown) {
  const res = await fetch(`${BASE}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`trama runtime error: ${await res.text()}`);
  return res.json();
}

let donePromise: Promise<void> | null = null;
let readyCalled = false;
let terminalSignal: "done" | "yielded" | null = null;

export const ctx: Ctx = {
  input: initData.input,
  state: initData.state,
  iteration: initData.iteration,
  maxIterations: initData.maxIterations,
  resumed: initData.resumed ?? false,
  yieldReason: initData.yieldReason ?? null,

  async log(msg, data) {
    let safeData = data;
    try { JSON.stringify(safeData); } catch { safeData = { __trama_unserializable: String(data) }; }
    await call("/ctx/log", { message: msg, data: safeData });
  },
  async ready(data) {
    if (readyCalled) return;
    let safeData = data;
    try { JSON.stringify(safeData); } catch { safeData = { __trama_unserializable: String(data) }; }
    await call("/ctx/ready", { data: safeData });
    readyCalled = true;
  },
  async checkpoint() {
    assertSerializable(ctx.state, "ctx.state");
    await call("/ctx/checkpoint", { state: ctx.state });
    ctx.iteration += 1;
  },
  async done(result) {
    // Mutual exclusivity: yield() was already called
    if (terminalSignal === "yielded") {
      throw new Error("Cannot call ctx.done() after ctx.yield() — yield already signaled.");
    }

    // If a previous done() completed or is in flight, coalesce onto it.
    // If a previous done() failed, allow retry (promise was cleared).
    if (donePromise) return donePromise;

    terminalSignal = "done";

    const run = async () => {
      assertSerializable(ctx.state, "ctx.state");
      if (result !== undefined) assertSerializable(result, "ctx.done(result)");
      await call("/ctx/done", { state: ctx.state, result });
      ctx.iteration += 1;
    };

    donePromise = run();
    try {
      await donePromise;
    } catch (err) {
      donePromise = null;
      throw err;
    }
  },
  async yield(reason) {
    // Mutual exclusivity: done() was already called
    if (terminalSignal === "done") {
      throw new Error("Cannot call ctx.yield() after ctx.done() — done already signaled.");
    }

    // Idempotent: second yield after successful persistence is a no-op
    if (terminalSignal === "yielded") {
      process.exit(0);
    }

    assertSerializable(ctx.state, "ctx.state");

    // Set terminalSignal only after validation and HTTP call succeed,
    // so a failed yield can be retried (mirrors done()'s retry pattern).
    await call("/ctx/yield", { state: ctx.state, reason });
    terminalSignal = "yielded";

    // Structured exit — the runner detects the yield marker in state.json
    process.exit(0);
  },
};

const instructImpl = (prompt: string, opts?: { system?: string }) =>
  call("/agent/ask", { prompt, ...opts }).then(r => r.result);

export const agent: Agent = {
  instruct: instructImpl,
  ask: instructImpl,
  generate: (input) => call("/agent/generate", input).then(r => r.result),
};

export const tools: Tools = {
  read: (path) => call("/tools/read", { path }).then(r => r.result),
  write: (path, content) => call("/tools/write", { path, content }).then(r => r.result),
  shell: (cmd, opts) => call("/tools/shell", { command: cmd, ...opts }).then(r => r.result),
  fetch: (url, opts) => call("/tools/fetch", { url, ...opts }).then(r => r.result),
};

// Workspace — available only when running in a session (workspace path is in init data)
function createWorkspaceClient(): Workspace {
  const throwIfNoWorkspace = () => {
    if (!initData.workspace) {
      throw new Error("workspace is only available when running in a session");
    }
  };

  return {
    async read(path) {
      throwIfNoWorkspace();
      return call("/workspace/read", { path }).then(r => r.result);
    },
    async write(path, content) {
      throwIfNoWorkspace();
      return call("/workspace/write", { path, content }).then(r => r.result);
    },
    async list(pattern) {
      throwIfNoWorkspace();
      return call("/workspace/list", { pattern }).then(r => r.result);
    },
    async observe(pattern, options) {
      throwIfNoWorkspace();
      return call("/workspace/observe", { pattern, ...options }).then(r => r.result);
    },
  };
}

export const workspace: Workspace = createWorkspaceClient();
