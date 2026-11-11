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

// The lifecycle rules (ready once, done once, done and yield mutually exclusive)
// are enforced by the runner. Here each call is checked for what only this
// process can see — whether the values survive JSON — and then forwarded.
export const ctx: Ctx = {
  input: initData.input,
  state: initData.state,
  iteration: initData.iteration,
  maxIterations: initData.maxIterations,
  resumed: initData.resumed,
  yieldReason: initData.yieldReason,

  async log(msg, data) {
    await call("/ctx/log", { message: msg, data: sendable(data) });
  },
  async ready(data) {
    await call("/ctx/ready", { data: sendable(data) });
  },
  async checkpoint() {
    assertSerializable(ctx.state, "ctx.state");
    ctx.iteration = await call("/ctx/checkpoint", { state: ctx.state });
  },
  async done(result) {
    assertSerializable(ctx.state, "ctx.state");
    if (result !== undefined) assertSerializable(result, "ctx.done(result)");
    ctx.iteration = await call("/ctx/done", { state: ctx.state, result });
  },
  async yield(reason) {
    assertSerializable(ctx.state, "ctx.state");
    await call("/ctx/yield", { state: ctx.state, reason });
    // The runner has recorded the yield; suspending means ending this process.
    process.exit(0);
  },
};

export const agent: Agent = {
  instruct: (prompt, opts) => call("/agent/instruct", { prompt, ...opts }),
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
