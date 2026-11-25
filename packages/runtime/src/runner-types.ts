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
  /**
   * What the check of the run came to, where the run was to be checked
   * (see `RunOptions.checkWith`) and ended as done. It says what the work
   * is worth: `status` is the program's own word, and is not changed by it.
   */
  check?: Check;
}

/**
 * A check of a run: who made it, and the verdict — or why none could be
 * had. A check that could not be made has `error` and no `ok`: it is never
 * said as a verdict that the work is not good.
 */
export interface Check {
  /** Who checked: the checker's project, by where it is. */
  by: string;
  /** The checker's program as it was when it checked, by its hash (sha256): verdicts are comparable where this is the same. */
  program?: string;
  /** The verdict: whether the work is good. */
  ok?: boolean;
  /** How good, where the checker says: a number of its own scale. */
  score?: number;
  /** Why, where the checker says. */
  notes?: string;
  /** Why the check could not be made: the checker failed, did not end its work, ended with no verdict, or was stopped. */
  error?: string;
}

/** Which model serves a project's LLM calls. */
export interface ModelConfig {
  provider: string;
  model: string;
}

export interface RunOptions {
  projectDir: string;
  /**
   * Which version of the project's program the run is of, by its number in
   * the project's history: where it is not the program as it is. The
   * project is as it is — its state, its files — and the program is not
   * touched. Such a run is not fixed where it fails: a fix would be a
   * version nobody asked for. (The version's program is started from its
   * own file in history/: one that imports a file beside itself by a
   * relative path does not find it there.)
   */
  version?: number;
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
   * The project that checks the run, where it ends as done: by its name
   * among the user's projects, or by a path. Its program is run with a
   * throwaway copy of the project as the run left it for its workspace —
   * what it does there changes nothing — is handed as arguments `result`
   * (what the program ended with), `args` (what the run was started with),
   * `journal` and `run` (the record of the run it checks, and its id), and
   * answers with the verdict: `{ ok, score?, notes? }`. That is the
   * result's `check`, and is on the run's record. It is a run of the
   * checked run's own — counted in its budget, stopped with it, started
   * with its variables — and is neither fixed where it fails nor checked
   * in its turn. Without it, the `checkWith` of the project's meta.json,
   * if that has one (a path there is said from where the project is).
   *
   * What checks is to stay as it is while what is checked changes: so it
   * is no part of the program, which an update and a fix rewrite.
   */
  checkWith?: string;
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

/** A version of a project's program, as its history has it (history/NNNN.ts, and a line of history/index.jsonl). */
export interface HistoryVersion {
  version: number;
  /** Why it came: "create", "update", "repair", "rollback" — or "found": the program was not on record when it was run, or was to be replaced. */
  reason: string;
  /** When, as an ISO time. */
  at: string;
  /** The hash of its text (sha256). A run is of the version whose text its program was. */
  sha256?: string;
  /** What it was made for: the prompt of a create or an update, the failure a repair mended. */
  detail?: string;
  /** Of a rollback: the version whose text it is. */
  from?: number;
  /** Of an update or a fix: the version it was written from — the program as it was. Absent where that was on no record. */
  parent?: number;
  /** A mark of what the project said it took and gave when the version was made (its meta.json's `parameters` and `returns`): absent where it said nothing. */
  contract?: string;
  /** It was put on record beside the program, and was not made the program: it becomes that by being gone to (see `rollbackProject`). */
  aside?: true;
}

/**
 * A run of a project, as its history has it: a line of history/runs.jsonl,
 * written when the run is over. It says how the run went and holds nothing
 * of its work — that is in the run's journal, for as long as that is kept.
 */
export interface HistoryRun {
  /** The run's id, by which its journal is found. Absent where the run was not recorded. */
  run?: string;
  /** When it began, as an ISO time. */
  at: string;
  /** The version its program was when it began. Absent where the program could not be put on record. */
  version?: number;
  /** The version its program was when it ended, where that is another: a fix was installed. */
  ended?: number;
  status: ProgramResult["status"];
  /** Of a run that failed or yielded: the first line of why. */
  reason?: string;
  /** Of a run that was fixed: which attempt worked. */
  repaired?: number;
  /** What its check came to (see `Check`): the beginning of its notes, or of why it could not be made. */
  check?: Check;
  /** What it used of a model, by the runner's own count: its program's calls, its fixes, its check, and the runs it asked for. */
  used: { calls: number; tokens: number; cost: number };
  /** The same by the model that served: of the calls that said which. Absent where none did. (A version good with one model is not thereby good with another.) */
  models?: Record<string, { calls: number; tokens: number; cost: number }>;
  /** How long it took, in milliseconds. */
  ms: number;
  /** A mark of what it was started with (a hash of its arguments): runs with the same mark had the same. */
  input: string;
  /** What the runner made the run for, where it made it itself: a fix asked of this project, a check asked of it, an update it was asked to write. */
  for?: "fix" | "check" | "update";
}

/** A project's history (see `readHistory`): facts on record, in the order they came. */
export interface ProjectHistory {
  versions: HistoryVersion[];
  /** The runs on record: the latest thousand or so. */
  runs: HistoryRun[];
  /** The version the program is now: absent where it was changed since the latest version, and has not been run. */
  current?: number;
}

/** How a program held to every run on record went (see `replayAll`). */
export interface ReplayAllResult {
  /**
   * The project's runs that are over, oldest first, and how the replay of
   * each went — or why it was not replayed: its record does not say what a
   * replay has to begin from.
   */
  runs: Array<{ run: string; replay?: ReplayResult; notReplayed?: string }>;
  /** How many of them were replayed. */
  replayed: number;
  /** Every run that was replayed went as recorded (`same`), and at least one was. */
  same: boolean;
}

/** A replay as a program asks its runner for it: what can cross the bridge, and whether it is of every run. */
export type ReplayRequest = Omit<ReplayOptions, "signal"> & { all?: boolean };

/** A run as one program asks its runner for it: everything in RunOptions that can cross the bridge. */
export type RunRequest = Omit<RunOptions, "signal">;

/** A project a program asks its runner to make, or to change (see createProject and updateProject). */
export type MakeRequest =
  | { kind: "create"; name: string; prompt: string; model?: string; args?: Record<string, unknown> }
  /** An update: written from the program — or from a version of it that is named — and made the program, unless it is to be kept beside it. */
  | { kind: "update"; name: string; prompt: string; from?: number; install?: boolean; updateWith?: string }
  /** A version handed over as a text, to be kept beside the program (see `addVersion`). */
  | { kind: "version"; name: string; source: string; parent?: number; detail?: string }
  /** A project changed by going back to a version of its program (see `rollbackProject`). */
  | { kind: "rollback"; name: string; version: number };

/** A version that was made: its number in the project's history. */
export interface VersionMade { version: number }

/** What going back to a version came to: the new version it was made, and which it is of — or that the program was that already. */
export type RolledBack = { version: number; from: number } | { unchanged: true; version: number };

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
  /** The project asked to write an update, in place of pi's agent, where the update names none (see `updateProject`): by its name, or a path. */
  updateWith?: string;
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
