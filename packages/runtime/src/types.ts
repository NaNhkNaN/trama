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

  /** Write a structured log entry */
  log(message: string, data?: Record<string, unknown>): Promise<void>;

  /** Persist current ctx.state to disk */
  checkpoint(): Promise<void>;

  /**
   * Signal program completion. Persists state and logs result.
   * Does NOT terminate execution — program should return naturally.
   * Idempotent: second call is a no-op.
   */
  done(result?: Record<string, unknown>): Promise<void>;
}

export interface Agent {
  /**
   * LLM call via pi-coding-agent. Returns plain text.
   * The underlying pi agent may use its built-in tools autonomously.
   */
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

// --- Internal types ---

export interface PiAdapterConfig {
  provider: string;
  model: string;
}

export interface RunOptions {
  projectDir: string;
  maxRepairAttempts?: number;
  timeout?: number;
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
