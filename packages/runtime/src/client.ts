// @trama-dev/runtime client — this is what program.ts imports.
// A thin wrapper that forwards every call to the runner's IPC server
// (ipc-server.ts), which does the real work.

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

/** POST one call to the runner and return its result. */
async function call(endpoint: string, body: unknown) {
  const res = await fetch(`${BASE}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`trama runtime error: ${await res.text()}`);
  return (await res.json()).result;
}

/** Log payloads are best-effort: anything that can't be sent as JSON is replaced by its string form. */
function sendable(data: Record<string, unknown> | undefined) {
  try {
    JSON.stringify(data);
    return data;
  } catch {
    return { __trama_unserializable: String(data) };
  }
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
    await call("/ctx/log", { message: msg, data: sendable(data) });
  },
  async ready(data) {
    if (readyCalled) return;
    await call("/ctx/ready", { data: sendable(data) });
    readyCalled = true;
  },
  async checkpoint() {
    assertSerializable(ctx.state, "ctx.state");
    await call("/ctx/checkpoint", { state: ctx.state });
    ctx.iteration += 1;
  },
  async done(result) {
    if (terminalSignal === "yielded") {
      throw new Error("Cannot call ctx.done() after ctx.yield() — yield already signaled.");
    }

    // A completed done() is a no-op; one still in flight is shared.
    // One that failed cleared the promise below, so it can be retried.
    if (donePromise) return donePromise;

    // Locked in on the first attempt: a failed done() may be retried, but not swapped for yield().
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
    if (terminalSignal === "done") {
      throw new Error("Cannot call ctx.yield() after ctx.done() — done already signaled.");
    }

    assertSerializable(ctx.state, "ctx.state");
    // If this throws, nothing was persisted and both done() and yield() remain open.
    await call("/ctx/yield", { state: ctx.state, reason });
    terminalSignal = "yielded";

    // The runner has recorded the yield; suspending means ending this process.
    process.exit(0);
  },
};

const instruct: Agent["instruct"] = (prompt, opts) => call("/agent/ask", { prompt, ...opts });

export const agent: Agent = {
  instruct,
  ask: instruct,
  generate: (input) => call("/agent/generate", input),
};

export const tools: Tools = {
  read: (path) => call("/tools/read", { path }),
  write: (path, content) => call("/tools/write", { path, content }),
  shell: (cmd, opts) => call("/tools/shell", { command: cmd, ...opts }),
  fetch: (url, opts) => call("/tools/fetch", { url, ...opts }),
};

/** workspace.* exists only inside a session — everywhere else it fails clearly, without a round trip. */
async function workspaceCall(endpoint: string, body: unknown) {
  if (!initData.workspace) {
    throw new Error("workspace is only available when running in a session");
  }
  return call(endpoint, body);
}

export const workspace: Workspace = {
  read: (path) => workspaceCall("/workspace/read", { path }),
  write: (path, content) => workspaceCall("/workspace/write", { path, content }),
  list: (pattern) => workspaceCall("/workspace/list", { pattern }),
  observe: (pattern, options) => workspaceCall("/workspace/observe", { pattern, ...options }),
};
