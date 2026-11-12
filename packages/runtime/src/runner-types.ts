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
  /**
   * Per-phase limit in ms on the program's own time, for each run and each
   * repair attempt. Time during which a run the program started with
   * runProgram() — a session participant — is in flight is not counted: that
   * run has a timeout of its own.
   */
  timeout?: number;
  args?: Record<string, unknown>;
  /** Shared workspace directory. When set, workspace.* API is enabled for the program. */
  workspaceDir?: string;
  /** A name for this run — a participant's, say. Its output is shown under it. */
  label?: string;
  /**
   * Stops the run: its program is stopped, no repair is attempted, and the
   * run ends as failed. A fix that was being tried leaves no trace.
   */
  signal?: AbortSignal;
}

/** A run as one program asks its runner for it: everything in RunOptions that can cross the bridge. */
export type RunRequest = Omit<RunOptions, "signal">;

export interface TramaConfig extends ModelConfig {
  maxRepairAttempts: number;
  defaultTimeout: number;
  defaultMaxIterations: number;
}
