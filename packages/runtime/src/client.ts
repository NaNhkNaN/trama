// @trama-dev/runtime client — this is what program.ts imports.
// Thin HTTP wrapper that calls the runner's IPC server.

import type { Ctx, Agent, Tools } from "./types.js";
import { assertSerializable } from "./serializable.js";

const PORT = process.env.TRAMA_PORT;
if (!PORT) {
  throw new Error(
    "@trama-dev/runtime must be executed via `trama run`. " +
    "Direct execution is not supported (TRAMA_PORT env var missing)."
  );
}
if (!process.env.TRAMA_INPUT) {
  throw new Error(
    "@trama-dev/runtime: TRAMA_INPUT env var missing. " +
    "This program must be launched by the trama runner."
  );
}

const BASE = `http://127.0.0.1:${PORT}`;

async function call(endpoint: string, body: unknown) {
  const res = await fetch(`${BASE}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`trama runtime error: ${await res.text()}`);
  return res.json();
}

let doneCalled = false;

export const ctx: Ctx = {
  input: JSON.parse(process.env.TRAMA_INPUT!),
  state: JSON.parse(process.env.TRAMA_STATE ?? "{}"),
  iteration: parseInt(process.env.TRAMA_ITERATION ?? "0"),
  maxIterations: parseInt(process.env.TRAMA_MAX_ITERATIONS ?? "100"),

  async log(msg, data) {
    await call("/ctx/log", { message: msg, data });
  },
  async checkpoint() {
    assertSerializable(ctx.state, "ctx.state");
    await call("/ctx/checkpoint", { state: ctx.state });
    ctx.iteration += 1;
  },
  async done(result) {
    if (doneCalled) return;
    assertSerializable(ctx.state, "ctx.state");
    if (result !== undefined) assertSerializable(result, "ctx.done(result)");
    await call("/ctx/done", { state: ctx.state, result });
    doneCalled = true;
    ctx.iteration += 1;
  },
};

export const agent: Agent = {
  ask: (prompt, opts) => call("/agent/ask", { prompt, ...opts }).then(r => r.result),
  generate: (input) => call("/agent/generate", input).then(r => r.result),
};

export const tools: Tools = {
  read: (path) => call("/tools/read", { path }).then(r => r.result),
  write: (path, content) => call("/tools/write", { path, content }).then(r => r.result),
  shell: (cmd, opts) => call("/tools/shell", { command: cmd, ...opts }).then(r => r.result),
  fetch: (url, opts) => call("/tools/fetch", { url, ...opts }).then(r => r.result),
};
