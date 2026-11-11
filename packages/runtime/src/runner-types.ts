// Runner-side types: what callers of "@trama-dev/runtime/runner" and the runtime's
// own modules use. Nothing here is visible to a program.ts.

export interface ProgramResult {
  status: "done" | "yielded" | "failed";
  /** Yield reason, or error summary for failed. */
  reason?: string;
  /** From ctx.done(result), if provided. */
  result?: unknown;
}

/** Which model serves a project's LLM calls. */
export interface ModelConfig {
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

export interface TramaConfig extends ModelConfig {
  maxRepairAttempts: number;
  defaultTimeout: number;
  defaultMaxIterations: number;
}
