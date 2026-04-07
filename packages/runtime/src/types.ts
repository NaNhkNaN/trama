// @trama-dev/runtime - All shared types

export interface Ctx {
  /** Original user prompt and any arguments */
  input: { prompt: string; args: Record<string, unknown> };

  /**
   * Persistent state. Must be strictly JSON-serializable.
   * Local working copy — only checkpoint() and done() persist to disk.
   * Reserved keys: any key starting with `__trama_` is reserved.
   */
  state: Record<string, unknown>;

  /**
   * Current iteration counter (starts at 0).
   * Advances only when checkpoint() or done() is called.
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

  /** Persist current ctx.state to disk */
  checkpoint(): Promise<void>;

  /**
   * Signal program completion. Persists state (logging is best-effort).
   * Does NOT terminate execution — program should return naturally.
   * Idempotent: second call is a no-op.
   * Mutually exclusive with yield() — throws if yield() was already called.
   * Terminal choice is irreversible: once done() is attempted (even if it fails),
   * yield() is permanently blocked. Fix the issue and retry done() instead.
   */
  done(result?: Record<string, unknown>): Promise<void>;

  /**
   * Cooperative suspension. Persists ctx.state with a yield marker and exits (logging is best-effort).
   * The session layer (or manual `trama run`) re-runs the program when ready.
   * The program resumes by reading its own ctx.state.
   * Idempotent: second call is a no-op.
   * Mutually exclusive with done() — throws if done() was already called.
   * Unlike done(), yield's terminal choice is only locked after successful persistence —
   * a failed yield() leaves both done() and yield() available for retry.
   */
  yield(reason: string): Promise<never>;
}

export interface Agent {
  /**
   * Instruct the pi-coding-agent to perform a task. Returns plain text.
   * The underlying agent may autonomously use its built-in tools
   * (bash, file read/write/edit) to fulfill the instruction.
   */
  instruct(prompt: string, options?: { system?: string }): Promise<string>;

  /** @deprecated Use instruct() instead. Alias kept for backwards compatibility. */
  ask(prompt: string, options?: { system?: string }): Promise<string>;

  /**
   * Structured LLM call. Returns typed object matching the provided schema.
   * Supported schema value prefixes: "string", "number", "boolean".
   * Retries once on parse/validation failure.
   */
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

// --- Program result ---

export interface ProgramResult {
  status: "done" | "yielded" | "failed";
  /** Yield reason, or error summary for failed. */
  reason?: string;
  /** From ctx.done(result), if provided. */
  result?: unknown;
}

// --- Internal types ---

export interface PiAdapterConfig {
  provider: string;
  model: string;
}

export interface RunOptions {
  projectDir: string;
  maxRepairAttempts?: number;
  timeout?: number;
  args?: Record<string, unknown>;
  /** Shared workspace directory. When set, workspace.* API is enabled for the program. */
  workspaceDir?: string;
}

export interface RepairInput {
  programSource: string;
  error: string;
  runtimeTypes: string;
}

export interface ChildResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TramaConfig extends PiAdapterConfig {
  maxRepairAttempts: number;
  defaultTimeout: number;
  defaultMaxIterations: number;
}
