// Runner-side types: what callers of "@trama-dev/runtime/runner" and the runtime's
// own modules use. Nothing here is visible to a program.ts.

import type { Budget } from "./budget.js";
export type { Budget };

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
   * Variables for the run, over the runner's own: its program has them, and
   * so do the shell commands it runs, its agents, and the runs it asks for,
   * each of which may be given more. (An agent has them by being served in a
   * process of its own, started with them: which pi it finds, and which key
   * for a provider, are then the run's.) One given as undefined is one not
   * given. The journal has their names, not what they hold.
   */
  env?: Record<string, string | undefined>;
  /**
   * What the run may use of a model, in all: its program's agent calls, the
   * requests for a fix, and everything the runs it asks for use. Once it is
   * spent, a call that asks a model is refused, one that is under way is
   * stopped where it would ask its model again, and no repair is tried. A
   * run a program asks for is held to the budget of the run that asked as
   * well: it can be given less, never more. Without it, a run nobody's
   * program asked for has the config's `budget`, if that has one.
   */
  budget?: Budget;
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
  /** How many runs of a project keep their journal. 0 records nothing. */
  journalRuns: number;
  /**
   * What becomes of what the agent that writes or fixes a program changes in
   * the project beside the program — a package it installs, a file it puts
   * right. "keep": it reaches the project with a program that then works,
   * and only with one. "discard": none of it does; the program is all that
   * is taken from the agent.
   */
  agentChanges: "keep" | "discard";
  /**
   * What a run may use of a model (see RunOptions) where it is not given a
   * budget of its own — and what a `create` or an `update` may: writing the
   * program and validating it, together. Without it, nothing is capped.
   */
  budget?: Budget;
}
