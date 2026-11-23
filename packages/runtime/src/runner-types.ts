// Runner-side types: what callers of "@trama-dev/runtime/runner" and the runtime's
// own modules use. Nothing here is visible to a program.ts.

import type { Budget } from "./budget.js";
import type { OutsideAgent } from "./types.js";
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
   * The project that is asked for a fix where the run's program fails, in
   * place of pi's agent: by its name among the user's projects, or by a
   * path. Its program is run with a copy of the failing project as its
   * workspace, is handed as arguments `program` (the program that failed),
   * `error`, `journal` (the path of the failed run's record), `kept`
   * (whether what it changes in the copy beside the program reaches the
   * project) and `types` (the API as a program's author is shown it) — and
   * answers with `{ program }`: the whole of the fixed program. (Or with
   * `{ unfixable }`, saying why there is no fix: the run then fails with
   * that, and nobody is asked again.) It is a run
   * of the failing run's own: counted in its budget, stopped with it, and
   * not itself fixed where it fails. Without it, the config's `repairWith`,
   * if that has one.
   */
  repairWith?: string;
  /**
   * Stops the run: its program is stopped, no repair is attempted, and the
   * run ends as failed. A fix that was being tried leaves no trace.
   */
  signal?: AbortSignal;
}

/** What a replay is asked with (see `replayProgram`). */
export interface ReplayOptions {
  /** The project whose recorded run is replayed, and whose program is run against it. */
  projectDir: string;
  /** The run to answer from, by its id (as `trama journal <name> --list` shows it). Without it, the project's latest run that is no validation. */
  run?: string;
  /**
   * Answer a call wherever its endpoint is the recorded one, whatever it
   * asks: not "does the program ask what was asked" but "does it get through
   * what was answered". Each call that asked otherwise is in `other`.
   */
  loose?: boolean;
  /** A program to replay in the place of the project's: its text. The project's own is not touched. */
  program?: string;
  /** Variables for the program, over the runner's own. (Those the recorded run had are not on record: their names are.) */
  env?: Record<string, string>;
  /** How long the program may take, in milliseconds. Without it, the config's. */
  timeout?: number;
  /** Stops the replay, which then throws. */
  signal?: AbortSignal;
}

/**
 * How a replay went. A program's calls to the world — everything but what
 * it says to its own run by `ctx.*` — are answered from the record, in
 * order, each where it is the recorded call; none is carried out.
 */
export interface ReplayResult {
  /** The run that was answered from, and which attempt of it: the last. */
  run: string;
  attempt: number;
  /** Whether the program that was replayed is the one that was recorded, to the byte. */
  sameProgram: boolean;
  /** How many calls the record has, and how many of the program's were answered from it. */
  recorded: number;
  answered: number;
  /** How many of the record's calls the program did not come to make. */
  unasked: number;
  /** Calls answered though they asked otherwise than was recorded (`loose`): which, and where the request first differs. */
  other: Array<{ call: number; endpoint: string; difference: string }>;
  /**
   * Where the program left the record, and why: its call (the first is 1)
   * was not the next the record has, or the record has no answer for it.
   * The program was stopped there, and has no `result`.
   */
  left?: { call: number; endpoint: string; why: string };
  /** How the program ended, where it did not leave the record: its end is carried out. */
  result?: ProgramResult;
  /** How the recorded attempt ended, where the record says. */
  recordedResult?: ProgramResult;
  /**
   * The program ended as the recorded attempt ended: with the same result —
   * or, where both failed, by failing (the words of two failures are not
   * held against each other). False where it left the record.
   */
  sameEnd: boolean;
  /** The program went the whole way of the record, asked nothing otherwise, and ended as the recorded attempt ended. */
  same: boolean;
}

/** A run as one program asks its runner for it: everything in RunOptions that can cross the bridge. */
export type RunRequest = Omit<RunOptions, "signal">;

/** A project a program asks its runner to make, or to change (see createProject and updateProject). */
export interface MakeRequest {
  kind: "create" | "update";
  name: string;
  prompt: string;
  model?: string;
  args?: Record<string, unknown>;
}

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
  /** The project asked for a fix, in place of pi's agent, where a run is not given one of its own (see RunOptions). */
  repairWith?: string;
  /**
   * The agents from outside a program may name in `tools.agent`: each by a
   * name, and what starts it — `{ command, args?, env? }`. None is named
   * by the runtime itself.
   */
  agents?: Record<string, OutsideAgent>;
  /**
   * What a run may use of a model (see RunOptions) where it is not given a
   * budget of its own — and what a `create` or an `update` may: writing the
   * program and validating it, together. Without it, nothing is capped.
   */
  budget?: Budget;
}
