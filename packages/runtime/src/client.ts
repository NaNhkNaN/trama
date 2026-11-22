// @trama-dev/runtime client — this is what program.ts imports.
// A thin wrapper that forwards every call to the runner's IPC server
// (ipc-server.ts), which does the real work.

import { randomUUID } from "crypto";
import type { Ctx, Agent, AgentOptions, AgentTool, Thinking, Schema, SchemaField, ShellResult, Tools, ObserveResult, Workspace, ModelRequest, ModelReply, ModelMessage, TextPart, ImagePart, ThinkingPart, ToolCallPart } from "./types.js";
import type { ImageKind, ToolImage } from "./agent-backend.js";
import type { ToolEvent } from "./own-tools.js";
import { openBridge, remoteWorkspace, withOptions } from "./bridge-client.js";
import { messageOf } from "./errors.js";
import { assertSerializable, toLogData } from "./serializable.js";

export type { Ctx, Agent, AgentOptions, AgentTool, Thinking, Schema, SchemaField, ShellResult, Tools, ObserveResult, Workspace, ModelRequest, ModelReply, ModelMessage, TextPart, ImagePart, ThinkingPart, ToolCallPart };

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

const { init: initData, call } = openBridge(PORT, INIT_PATH);

// The lifecycle rules (ready once; a run ends once, by done or by yield, and
// nothing is persisted after that) are enforced by the runner. Here each call is checked for what only this
// process can see — whether the values survive JSON — and then forwarded.
export const ctx: Ctx = {
  input: initData.input,
  state: initData.state,
  iteration: initData.iteration,
  maxIterations: initData.maxIterations,
  resumed: initData.resumed,
  yieldReason: initData.yieldReason,

  async log(msg, data) {
    await call("/ctx/log", { message: msg, data: toLogData(data) });
  },
  async ready(data) {
    await call("/ctx/ready", { data: toLogData(data) });
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

/** What kind of image bytes are, told by how they begin: of the kinds a model is shown. */
function imageKind(bytes: Uint8Array): ImageKind | undefined {
  const begins = (at: number, ...with_: number[]) => with_.every((byte, index) => bytes[at + index] === byte);
  if (begins(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (begins(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (begins(0, 0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
  if (begins(0, 0x52, 0x49, 0x46, 0x46) && begins(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return undefined;
}

/**
 * What a tool's result is to a model. Words: a string as it is, anything
 * else as JSON says it. And bytes are an image to be seen — by themselves,
 * or in a list, where what is not bytes is words.
 */
function said(result: unknown): { text: string; images?: ToolImage[] } {
  const words = (value: unknown): string => {
    if (typeof value === "string") return value;
    const json = JSON.stringify(value);
    if (json === undefined) throw new TypeError(`the tool returned a ${typeof value}, which cannot be said as JSON`);
    return json;
  };
  const parts = result instanceof Uint8Array ? [result] : Array.isArray(result) && result.some(part => part instanceof Uint8Array) ? result : undefined;
  if (!parts) return { text: result === undefined ? "Done." : words(result) };
  const text: string[] = [], images: ToolImage[] = [];
  for (const part of parts) {
    if (!(part instanceof Uint8Array)) {
      text.push(words(part));
      continue;
    }
    const mimeType = imageKind(part);
    if (!mimeType) throw new TypeError("the tool returned bytes that are no image a model is shown: not a PNG, a JPEG, a GIF or a WebP");
    images.push({ mimeType, data: Buffer.from(part.buffer, part.byteOffset, part.byteLength).toString("base64") });
  }
  return { text: text.join("\n"), images };
}

/** Whether a tool a call names is one of the program's own: written out, where the agent's are named. */
const isOwn = (tool: unknown): tool is object => typeof tool === "object" && tool !== null;

/**
 * Make an agent call. The tools of the program's own that it has are
 * functions, and stay here: the runner is sent what each declares, and where
 * this process waits to be asked for them — a call of its own beside the
 * agent call, held by the runner until a tool is called, or one that is
 * running is to stop, and made again for as long as the agent call lasts.
 */
async function agentCall(endpoint: string, body: unknown): Promise<any> {
  // (What is no call at all is the runner's to refuse, or the bridge's, as it is made.)
  const tools = isOwn(body) ? (body as { tools?: unknown }).tools : undefined;
  if (!Array.isArray(tools) || !tools.some(isOwn)) return call(endpoint, body);

  const own = new Map<string, AgentTool["run"]>();
  const declared = tools.map((tool: unknown) => {
    if (!isOwn(tool)) return tool;
    const { run, ...rest } = tool as Partial<AgentTool>;
    if (typeof run !== "function") {
      throw new TypeError(`the tool ${JSON.stringify(rest.name)} has no run: a tool of the program's own is a function of the program's`);
    }
    // (Of two by one name the runner refuses the call, before either is asked.)
    own.set(String(rest.name), run);
    return rest;
  });

  const toolsId = randomUUID();
  const over = new AbortController();
  /** The tools that are running, each by the key its use was told under. */
  const running = new Map<string, AbortController>();

  const use = async (key: string, name: string, args: unknown) => {
    const stop = new AbortController();
    running.set(key, stop);
    let answer: ReturnType<typeof said> | { error: string };
    try {
      answer = said(await own.get(name)!(args, { signal: stop.signal }));
    } catch (err) {
      answer = { error: messageOf(err) };
    }
    running.delete(key);
    // (What a tool says after it was told to stop, or after its call is over, is said to nobody: the runner has no use for it.)
    await call("/agent/tool/answered", { of: toolsId, key, ...answer }).catch(() => {});
  };

  const waiting = (async () => {
    // How long is waited before it is asked again where the asking failed: longer each time it fails again, and never long.
    let pause = 50;
    while (!over.signal.aborted) {
      let event: ToolEvent | null;
      try {
        event = await call("/agent/tool/asked", { of: toolsId }, over.signal);
        pause = 50;
      } catch {
        // Given up, the agent call being over. (Or not answered — which the agent call will say for itself: asked again meanwhile.)
        if (over.signal.aborted) return;
        await new Promise(resolve => setTimeout(resolve, pause));
        pause = Math.min(pause * 2, 1000);
        continue;
      }
      if (event === null) return;
      if ("stop" in event) running.get(event.stop)?.abort();
      else void use(event.key, event.name, event.args);
    }
  })();

  try {
    return await call(endpoint, { ...(body as object), tools: declared, toolsId });
  } finally {
    over.abort();
    for (const stop of running.values()) stop.abort();
    await waiting;
  }
}

/**
 * A request to a model as it is sent: of each tool, what it declares. Its
 * function stays here, and waits for nobody: no agent is asked that would
 * call it — the program reads the model's calls in the reply, and runs what
 * it will.
 */
function asSent(request: unknown): unknown {
  const tools = isOwn(request) ? (request as { tools?: unknown }).tools : undefined;
  if (!Array.isArray(tools)) return request;
  const declared = tools.map((tool: unknown) => {
    if (!isOwn(tool)) return tool;
    const { run: _run, ...rest } = tool as Partial<AgentTool>;
    return rest;
  });
  return { ...(request as object), tools: declared };
}

export const agent: Agent = {
  instruct: async (prompt, opts) => agentCall("/agent/instruct", withOptions({ prompt }, opts)),
  generate: async (input) => agentCall("/agent/generate", input),
  complete: async (request) => call("/agent/complete", asSent(request)),
};

export const tools: Tools = {
  read: (path) => call("/tools/read", { path }),
  write: (path, content) => call("/tools/write", { path, content }),
  shell: async (cmd, opts) => call("/tools/shell", withOptions({ command: cmd }, opts)),
  fetch: async (url, opts) => call("/tools/fetch", withOptions({ url }, opts)),
};

/** workspace.* exists only inside a session — everywhere else it fails clearly, without a round trip. */
export const workspace: Workspace = remoteWorkspace((endpoint, body) => {
  if (!initData.inSession) {
    return Promise.reject(new Error("workspace is only available when running in a session"));
  }
  return call(endpoint, body);
});

export { heldTo } from "./schema.js";
