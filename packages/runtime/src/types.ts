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
   * agent has no tool for is an error.
   */
  tools?: string[];
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
   * Whether the agent has the user's pi extensions — those of the user's pi
   * directory and settings, not the ones pi has built in, and not the
   * project's: an extension is code that runs in the runner. With them come
   * the tools they add, the commands a prompt of `instruct` can then begin
   * with ("/name"), and what they do to a session, the skills and templates
   * they bring among it. One pi has something against is an error. Without
   * any of `skills`, `templates` and `extensions`, a prompt is the text it
   * is, whatever it begins with.
   */
  extensions?: boolean;
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
