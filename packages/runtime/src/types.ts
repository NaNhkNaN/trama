// The program-facing API: everything a program.ts can import from "@trama-dev/runtime".
// This file is the single source of truth for that API — its generated .d.ts is also
// what the LLM is shown when it writes or repairs a program, so the doc comments here
// are part of the prompt. Runner-side types live in runner-types.ts.

export interface Ctx {
  /** Original user prompt and any arguments */
  input: { prompt: string; args: Record<string, unknown> };

  /**
   * Persistent state. Must be strictly JSON-serializable.
   * Local working copy — only checkpoint(), yield() and done() persist to disk.
   * Reserved keys: any key starting with `__trama_` is reserved.
   */
  state: Record<string, unknown>;

  /**
   * Current iteration counter (starts at 0).
   * Advances only when checkpoint(), yield() or done() is called.
   */
  iteration: number;

  /** Max iterations hint. Not enforced by runtime. */
  maxIterations: number;

  /** True if this run follows a yield (read-only, set by runtime on startup). */
  readonly resumed: boolean;

  /** The reason string from the previous yield, or null (read-only, set by runtime on startup). */
  readonly yieldReason: string | null;

  /** Write a structured log entry */
  log(message: string, data?: Record<string, unknown>): Promise<void>;

  /**
   * Signal that a long-running program has finished startup and is now serving.
   * Used by smoke validation to distinguish "started successfully" from "completed".
   * This marks startup success only; it is not a guarantee about long-term health.
   * Idempotent: second call is a no-op.
   */
  ready(data?: Record<string, unknown>): Promise<void>;

  /**
   * Persist current ctx.state to disk.
   * Throws once done() or yield() has been called: the run has ended, and its state is settled.
   */
  checkpoint(): Promise<void>;

  /**
   * Signal program completion. Persists state (logging is best-effort).
   * Does NOT terminate execution — program should return naturally.
   * Idempotent: second call is a no-op.
   * Mutually exclusive with yield() — throws if yield() was already called.
   */
  done(result?: Record<string, unknown>): Promise<void>;

  /**
   * Cooperative suspension. Persists ctx.state with a yield marker and exits (logging is best-effort).
   * The session layer (or manual `trama run`) re-runs the program when ready.
   * The program resumes by reading its own ctx.state.
   * Mutually exclusive with done() — throws if done() was already called.
   * A done() or yield() that fails (e.g. on unserializable state) settles nothing:
   * fix the problem and call either one.
   */
  yield(reason: string): Promise<never>;
}

/** How much a model is to think before it answers. */
export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * A tool of the program's own, for the agent of one call: a function of the
 * program's, which the model can call by name. It is run where the program
 * runs — it has the program's variables, and can do what the program can.
 */
export interface AgentTool {
  /** As the model calls it: letters, digits, "_" and "-". Not the name of another tool the agent has. */
  name: string;
  /** What it is for. This, and what its parameters are called, is all the model is told of it. */
  description: string;
  /**
   * What it is called with, written as the shape of a typed answer is (see
   * `Schema`): `{ id: "string: the order's id", lines: ["number"] }`. The
   * model's call is held to it before `run` is called: every field there,
   * each of its kind, and no other. Without it, the tool is called with `{}`.
   */
  parameters?: Schema;
  /**
   * It may run while another tool does. Without it, the tools a model calls
   * in one reply are run one after the other, in the order it called them —
   * the agent's own among them, where one of the program's is called beside.
   */
  parallel?: boolean;
  /**
   * What it returns is the end of the agent's work, and the answer of the
   * call: the model is not asked again. For a call whose answer is to be
   * something the model hands over, held to a shape, rather than its last
   * words — `{ name: "verdict", ends: true, parameters: { ok: "boolean" }, … }`.
   * Not where it throws: the model then reads why, and may call it again.
   * (And not where the model called, in the same reply, a tool that ends
   * nothing: it is then asked again, as after any tool.)
   */
  ends?: boolean;
  /**
   * Called each time the model calls the tool, with its arguments. What it
   * returns is the model's to read: a string as it is, anything else as
   * JSON says it (nothing at all as "Done."). Bytes — a Buffer, a
   * Uint8Array — are an image for the model to see: PNG, JPEG, GIF or WebP,
   * told by how they begin; a list with bytes in it is each of those as an
   * image, and the rest as words. What it throws is the model's
   * to read too, as the tool's failure — and not the failure of the call,
   * which goes on. `signal` says when the call it is run for is to go no
   * further (it was cancelled, or its budget is spent): what it returns
   * after that is nobody's.
   */
  run(args: any, context: { signal: AbortSignal }): unknown;
}

/**
 * What a call may say about how it is served. Each is honoured or the call
 * fails: nothing asked for here is quietly left out. (But by an extension
 * the call asked for itself: what one does to a session is its to do.)
 */
export interface AgentOptions {
  /** Instructions for this call, on top of the agent's own. */
  system?: string;
  /** The model that serves this call, as "provider/model" — in place of the project's. */
  model?: string;
  /** How much the model is to think. A level pi does not have for the model is an error. */
  thinking?: Thinking;
  /**
   * The agent's tools for this call: exactly the ones named. `[]` for none —
   * the answer is then made from the prompt alone, and nothing is read, run
   * or written. Without it the agent has its own choice of them (read, bash,
   * edit, write); pi has more than it chooses (grep, find, ls). A name the
   * agent has no tool for is an error. A tool of the program's own is given
   * as itself (see `AgentTool`), beside the names — and is then the agent's
   * like any: a call that names tools of its own and nothing else has those
   * and no other.
   */
  tools?: Array<string | AgentTool>;
  /**
   * The skills the agent has for this call: `true` for all that pi finds
   * for the user and for the project (its `.pi/skills` among them; of two
   * by one name, the project's) — or the ones named. Without it, none. A
   * name pi has no skill by is an error, and so is a call whose agent could
   * not read them: pi tells a model of its skills only where it has `read`
   * or `bash`. A prompt of `instruct` that begins with "/skill:name " is
   * then that skill's text, and after it what followed the space. (A prompt
   * of `generate` is text, whatever it begins with.)
   */
  skills?: boolean | string[];
  /**
   * The prompt templates the call has: `true` for all that pi finds for the
   * user and for the project (its `.pi/prompts`; of two by one name, the
   * project's) — or the ones named. A prompt that begins with "/name" is
   * then the template of that name, with what follows as its arguments:
   * split as a shell splits words — quotes taken off, a line break or a run
   * of spaces become one space. A name pi has no template by is an error.
   * (For `instruct` only: what tells the model how a typed answer is to be
   * written follows the prompt, and a template is free to leave that out.)
   */
  templates?: boolean | string[];
  /**
   * Whether the agent has pi's extensions: `true` for the user's — those of
   * the user's pi directory and settings, and the ones pi has built in, its
   * MCP servers among them — or "project" for the project's own as well (its
   * `.pi/extensions`, the MCP servers it names). With them come the tools
   * they add, the commands a prompt of `instruct` can then begin with
   * ("/name"), and what they do to a session, the skills and templates they
   * bring among it. One pi has something against is an error. A call with
   * extensions is served in a process of its own: what an extension gets
   * wrong ends that call, and nothing else of the run. Without any of
   * `skills`, `templates` and `extensions`, a prompt is the text it is,
   * whatever it begins with.
   */
  extensions?: boolean | "project";
  /**
   * What to make of an answer that was cut off at the model's output limit.
   * "fail", as it is without this: the call fails — the answer is not whole.
   * "keep": the call returns what there was of it, as if it were the answer
   * (and still fails where there was none: a reply cut off before its first
   * word) — for a call whose work is what the agent did with its tools, and
   * whose closing words matter little. (The agent goes no further than the
   * reply that was cut off: where that was leading up to more work, the work
   * was not done. A typed answer that was cut off is seldom whole.)
   */
  cutOff?: "fail" | "keep";
}

/**
 * The shape of a typed answer, field by field. A field is "string", "number"
 * or "boolean" — what follows a ":" describes it to the model — or an object
 * of such fields, or a list, written as the shape of its items in brackets:
 *
 *   { summary: "string", passed: "boolean: did every test pass",
 *     failures: [{ test: "string", line: "number" }], tags: ["string"] }
 */
export type Schema = { readonly [field: string]: SchemaField };
/** (A list has one element: the shape of every item.) */
export type SchemaField = string | Schema | readonly SchemaField[];

export interface Agent {
  /**
   * Instruct the pi-coding-agent to perform a task. Returns plain text.
   * The underlying agent may autonomously use its tools to fulfill the
   * instruction.
   */
  instruct(prompt: string, options?: AgentOptions): Promise<string>;

  /**
   * The same, with the answer as a typed object matching the schema: the
   * agent may use its tools to find out what it is asked, and answers in
   * that shape: the fields of the schema and no others, each as declared.
   * Asks once more on a parse/validation failure.
   */
  generate<T>(input: Omit<AgentOptions, "templates"> & {
    prompt: string;
    schema: Schema;
  }): Promise<T>;

  /**
   * Ask the model once, and have its one reply: no agent is at work, no
   * tool is run, and nothing is asked again. For a program that is its own
   * harness — it keeps the conversation, runs the tools the model calls,
   * and decides when to ask again and when to stop:
   *
   *   const messages: ModelMessage[] = [{ role: "user", content: "…" }];
   *   for (;;) {
   *     const reply = await agent.complete({ system, messages, tools });
   *     messages.push(reply);                      // a reply goes back as it came
   *     if (reply.stopReason !== "toolUse") break; // read why it stopped: see ModelReply
   *     for (const part of reply.content) {
   *       if (part.type !== "toolCall") continue;
   *       messages.push({ role: "toolResult", toolCallId: part.id, toolName: part.name, content: await mine(part) });
   *     }
   *   }
   *
   * Each is a call to a run's budget, counted for what its reply used: a
   * loop is better held by a cap on tokens or cost than on calls.
   */
  complete(request: ModelRequest): Promise<ModelReply>;
}

/** A part of a message that is text. */
export interface TextPart {
  type: "text";
  text: string;
}

/** An image in a message: its kind — image/png, image/jpeg, image/gif or image/webp — and its bytes in base64. */
export interface ImagePart {
  type: "image";
  mimeType: string;
  data: string;
}

/** What a model thought before it answered, where it shows that. */
export interface ThinkingPart {
  type: "thinking";
  thinking: string;
}

/**
 * A model's call of a tool it was told of: to be answered by a message of
 * role "toolResult" with its `id`, before the model is asked again. Its
 * arguments are as the model wrote them — held to nothing: where they were
 * no JSON at all, `argumentsError` says so, and they are `{}`.
 */
export interface ToolCallPart {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  argumentsError?: string;
}

/**
 * A model's reply to one request. What is declared here is what a program
 * may read. There is more on it — what its provider wants to see again when
 * the conversation goes on: so a reply goes back into `messages` as it came,
 * all of it. (It is plain data, and can be kept in state.)
 */
export interface ModelReply {
  role: "assistant";
  content: Array<TextPart | ThinkingPart | ToolCallPart>;
  /**
   * Why the model stopped. "stop": it has answered. "toolUse": it called
   * tools, and waits for what they say. "length": it was cut off at its
   * output limit — what there is of the reply is here. "error": the
   * provider failed, and `errorMessage` says how; whether to ask again is
   * the program's to decide.
   */
  stopReason: "stop" | "toolUse" | "length" | "error";
  errorMessage?: string;
  /** The model that answered, as its provider names it. */
  model: string;
  /** What the reply used: tokens read and written, from a cache and to one, and what pi's price list makes of them in US dollars. */
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } };
  [carried: string]: unknown;
}

/** A message of the conversation a model is sent: the user's, a reply as it came, or what a tool the model called said. */
export type ModelMessage =
  | { role: "user"; content: string | Array<TextPart | ImagePart> }
  | ModelReply
  | { role: "toolResult"; toolCallId: string; toolName: string; content: string | Array<TextPart | ImagePart>; isError?: boolean };

export interface ModelRequest {
  /** The conversation so far, oldest first. It is the program's to keep: nothing of it is remembered between requests. */
  messages: ModelMessage[];
  /** What the model is told to be, before the conversation. */
  system?: string;
  /**
   * The tools the model may call, each declared as a tool of the program's
   * is to an agent (see `AgentTool`): its name, description and parameters.
   * Nothing runs one — the model's call comes back in the reply, and the
   * program does with it what it will; so a tool's `run` may be left out.
   */
  tools?: Array<Pick<AgentTool, "name" | "description" | "parameters"> & Partial<AgentTool>>;
  /** The model, as "provider/model". Without it, the project's — which is then one pi has, or the call fails. */
  model?: string;
  /** How much the model is to think. A level the model has not got is an error. */
  thinking?: Thinking;
  /** The most the reply may come to, in tokens. */
  maxTokens?: number;
  temperature?: number;
  /** "none": the model answers without calling a tool, though it is told of them. */
  toolChoice?: "auto" | "none";
  /** How long the provider is waited for, in milliseconds: five minutes without it. */
  timeout?: number;
}

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface Tools {
  /** Read a file. Path is relative to project dir. */
  read(path: string): Promise<string>;

  /** Write a file. Path is relative to project dir. */
  write(path: string, content: string): Promise<void>;

  /**
   * Execute a shell command. Returns structured result.
   * `env` is variables for the command, over those it has anyway: the
   * runner's, and those the run was started with. (What a program sets in
   * its own process.env is the program's, and is not handed on unless it is
   * given here: `env: process.env` hands on all of it.)
   */
  shell(command: string, options?: {
    cwd?: string;
    timeout?: number;
    env?: Record<string, string | undefined>;
  }): Promise<ShellResult>;

  /** HTTP fetch. Returns response body as string. */
  fetch(url: string, options?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ status: number; body: string; headers: Record<string, string> }>;
}

// --- Workspace types ---

/** Result of workspace.observe(). Single-file returns content string; multi-file returns array. */
export type ObserveResult = string | Array<{ path: string; content: string }>;

export interface Workspace {
  /** Read an artifact. Path is relative to workspace root. */
  read(path: string): Promise<string>;

  /** Write an artifact atomically. Path is relative to workspace root. */
  write(path: string, content: string): Promise<void>;

  /** List artifacts matching a glob pattern. Returns paths relative to workspace root. */
  list(pattern: string): Promise<string[]>;

  /**
   * Observe artifact changes. Level-triggered: existing matches are included immediately.
   * Single-file pattern returns content string. Glob/expect>1 returns sorted array of {path, content}.
   */
  observe(pattern: string, options?: { expect?: number; timeout?: number }): Promise<ObserveResult>;
}
