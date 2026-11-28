import { appendFileSync } from "fs";
import { join } from "path";
import type { Ctx } from "./types.js";
import type { ProgramResult } from "./runner-types.js";
import { assertSerializable, isJsonObject } from "./serializable.js";
import { guardPath } from "./path-guard.js";
import { readProjectMeta } from "./meta.js";
import { contractOf, heldResult, startedWith, withHeld, type Held } from "./contract.js";
import { saveState } from "./project.js";

/** Where a project's structured run log lives, relative to the project root. */
export const LATEST_LOG_PATH = join("logs", "latest.jsonl");

/** Append one structured JSONL entry to a run log file. `data` is what the program's side made of what it was given (see toLogData). */
export function appendLogEntry(logsPath: string, message: string, data?: unknown): void {
  const entry = { ts: Date.now(), message, data: data ?? null };
  appendFileSync(logsPath, JSON.stringify(entry) + "\n");
}

/**
 * The runner's side of a program's `ctx`: what the program is told when it
 * starts, and where its state file and run log are written while it runs
 * (once it is over, the runner settles both: see runProgramOnce). The
 * program's own `ctx` (client.ts) forwards to this over IPC.
 *
 * The state is the program's. It is handed over with each call that persists
 * it and is not kept here: there is one copy of it in the program, and one on
 * disk.
 */
export interface RunContext {
  readonly input: Ctx["input"];
  /** Whether this run takes up from a yield, and the reason that yield gave. */
  readonly resumed: boolean;
  readonly yieldReason: string | null;
  /** How the program ended the run: null until it has called done(), yield() or fail(). */
  readonly ended: ProgramResult | null;

  log(message: string, data?: unknown): void;
  /** The first call is logged and passed on to `onReady`; any other does nothing. */
  ready(data?: Record<string, unknown>): void;
  /** Persist the program's state as it is now. */
  checkpoint(state: Record<string, unknown>): void;
  /** Persist the state and end the run as done. */
  done(state: Record<string, unknown>, result?: unknown): void;
  /** Persist the state, with the mark the next run resumes from, and end the run as yielded. */
  yield(state: Record<string, unknown>, reason: string): void;
  /**
   * End the run as failed, in the program's words: what was asked cannot be
   * done, and nothing is wrong with the program. Nothing is persisted: the
   * state is as the program last had it kept — as where a program dies —
   * and so is the mark of a yield the run took up from.
   */
  fail(reason: string): void;
}

/**
 * The state file is the program's state, and one thing of the runner's
 * under a reserved key: `__trama_yield`, there while the program is
 * suspended and gone when it next advances. (An earlier trama kept a count
 * there too, `__trama_iteration`: a file that has one loses it when the
 * state is next kept — how often a loop went round is the program's own to
 * keep, in its state.)
 */
export function createContext(
  projectDir: string,
  initialState: Record<string, unknown>,
  options?: {
    argsOverride?: Record<string, unknown>;
    onReady?: (data?: Record<string, unknown>) => void;
    /** Where the run's log lines are shown as they are written. Defaults to the console. */
    print?: (line: string) => void;
    /**
     * Told what the result that ended the run had beside what the project
     * says it gives (see `heldResult`): the names, and what the project
     * gives. Once, when the run is settled as done — and not at all where
     * nothing was left out.
     */
    leftOut?: (names: string[], gives: string) => void;
    /**
     * What the run is held to, in the place of what the project's meta.json
     * says it takes and gives: of a run of a version that was made under
     * something else than the project says now (see `runProgram`'s `version`).
     */
    says?: Held;
  },
): RunContext {
  // Where the state and the log go is asked each time one is written, not once: the program
  // can change what is there while it runs. Asked here too, so that a project that will not
  // do is refused before its program is started.
  const logsPath = () => guardPath(projectDir, LATEST_LOG_PATH);
  const statePath = () => guardPath(projectDir, "state.json");
  logsPath();
  statePath();
  const meta = options?.says ? withHeld(readProjectMeta(projectDir), options.says) : readProjectMeta(projectDir);
  // What the project takes and gives, as it says it when the run begins: the run is held to that.
  const contract = contractOf(projectDir, meta);

  // The input is the project's own: it is handed on as the file has it — its arguments held to what the
  // project takes, where it says what that is.
  const input = (contract.parameters
    ? { ...meta.input, args: startedWith(projectDir, options?.argsOverride, meta) }
    : options?.argsOverride
      ? { ...meta.input, args: { ...(meta.input.args ?? {}), ...options.argsOverride } }
      : meta.input) as Ctx["input"];

  // A yield marker left by the previous run means this run is its resumption.
  const rawYield = initialState.__trama_yield;
  const yieldMarker = isJsonObject(rawYield) && typeof rawYield.reason === "string" ? { reason: rawYield.reason } : null;
  let readyCalled = false;
  let ended: ProgramResult | null = null;

  const writeLog = (message: string, data?: unknown) => {
    appendLogEntry(logsPath(), message, data);
    (options?.print ?? console.log)(`[trama] ${message}`);
  };

  /** The call that ended a run so. */
  const endedBy = (how: ProgramResult) => (how.status === "done" ? "done" : how.status === "yielded" ? "yield" : "fail");

  /**
   * The one way a state reaches the state file, and the one place the rules of
   * a run's ending are kept. A run ends once, by done(), by yield() or by fail(). After
   * that its state is settled: the same ending said again does nothing, and
   * any other call that would write the state is refused — it would take back
   * what the run ended on, the mark the next run resumes from included.
   *
   * `ending` is how the call ends the run, if it does. Returns false for a call
   * that had nothing left to do.
   */
  const persist = (call: "checkpoint" | "done" | "yield", state: Record<string, unknown>, ending?: ProgramResult): boolean => {
    if (ended) {
      if (ending?.status === ended.status) return false;
      throw new Error(`Cannot call ctx.${call}() after ctx.${endedBy(ended)}() — the run has ended, and its state is settled.`);
    }
    assertSerializable(state, "ctx.state");
    const { __trama_iteration: _counted, ...record }: Record<string, unknown> = state;
    if (ending?.status === "yielded") record.__trama_yield = { reason: ending.reason };
    else delete record.__trama_yield; // the program has moved on from its last yield
    saveState(projectDir, record);
    // Settled only once persisted: a call that failed leaves every call open.
    ended = ending ?? null;
    return true;
  };

  /** Persistence is the critical part: a log line that cannot be written must not turn a completed ending into an error. */
  const logEnding = (message: string, data?: unknown) => {
    try { writeLog(message, data); } catch { /* best-effort */ }
  };

  return {
    input,
    resumed: yieldMarker != null,
    yieldReason: yieldMarker?.reason ?? null,
    get ended() { return ended; },

    log: writeLog,

    ready(data) {
      if (readyCalled) return;
      writeLog("ready", data);
      options?.onReady?.(data);
      readyCalled = true;
    },

    checkpoint(state) {
      persist("checkpoint", state);
    },

    done(state, result) {
      // (Held before anything is settled: a result that does not fit is a done that failed, and the run is not over.)
      const { given, leftOut, gives } = ended ? { given: result, leftOut: [], gives: "" } : heldResult(projectDir, contract, result ?? undefined);
      if (persist("done", state, { status: "done", result: given ?? undefined })) {
        logEnding("done", given);
        // (Saying it is no part of ending: it must not turn a run that is done into one that failed.)
        if (leftOut.length > 0) { try { options?.leftOut?.(leftOut, gives ?? ""); } catch { /* best-effort */ } }
      }
    },

    // Exiting is the program's job: this returns so that the call can be answered first.
    yield(state, reason) {
      if (persist("yield", state, { status: "yielded", reason })) logEnding("yield", { reason });
    },

    // (Exiting is the program's job here too. Nothing is written but the log: a run that failed keeps what it had kept.)
    fail(reason) {
      if (ended) {
        if (ended.status === "failed") return;
        throw new Error(`Cannot call ctx.fail() after ctx.${endedBy(ended)}() — the run has ended, and its state is settled.`);
      }
      ended = { status: "failed", reason: reason.trim() === "" ? "The program ended its run as failed, and did not say why." : reason };
      logEnding("failed", { reason: ended.reason });
    },
  };
}
