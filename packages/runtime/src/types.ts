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
 * fails: nothing asked for here is quietly left out.
 */
export interface ModelOptions {
  /** Instructions for this call, on top of the agent's own. */
  system?: string;
  /** The model that serves this call, as "provider/model" — in place of the project's. */
  model?: string;
  /** How much the model is to think. A level pi does not have for the model is an error. */
  thinking?: Thinking;
}

export interface Agent {
  /**
   * Instruct the pi-coding-agent to perform a task. Returns plain text.
   * The underlying agent may autonomously use its tools to fulfill the
   * instruction — its own choice of them (read, bash, edit, write), or
   * exactly the ones named in `tools`: `[]` for none, and pi has more
   * than it chooses (grep, find, ls). A name the agent has no tool for is
   * an error.
   */
  instruct(prompt: string, options?: ModelOptions & { tools?: string[] }): Promise<string>;

  /**
   * Structured LLM call. Returns typed object matching the provided schema.
   * Supported schema value prefixes: "string", "number", "boolean".
   * Retries once on parse/validation failure.
   */
  generate<T>(input: ModelOptions & {
    prompt: string;
    schema: Record<string, string>;
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

  /** Execute a shell command. Returns structured result. */
  shell(command: string, options?: {
    cwd?: string;
    timeout?: number;
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
