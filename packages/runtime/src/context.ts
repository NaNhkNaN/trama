import { writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import type { Ctx } from "./types.js";
import type { ProgramResult } from "./runner-types.js";
import { assertSerializable } from "./serializable.js";
import { guardPath } from "./path-guard.js";
import { readProjectMeta } from "./meta.js";

/** Where a project's structured run log lives, relative to the project root. */
export const LATEST_LOG_PATH = join("logs", "latest.jsonl");

/** Append one structured JSONL entry to a run log file. `data` is what the program's side made of what it was given (see toLogData). */
export function appendLogEntry(logsPath: string, message: string, data?: unknown): void {
  const entry = { ts: Date.now(), message, data: data ?? null };
  appendFileSync(logsPath, JSON.stringify(entry) + "\n");
}

/**
 * The runner's side of a program's `ctx`: what the program is told when it
 * starts, and the one place its state file and run log are written. The
 * program's own `ctx` (client.ts) forwards to this over IPC.
 *
 * The state is the program's. It is handed over with each call that persists
 * it and is not kept here: there is one copy of it in the program, and one on
 * disk.
 */
export interface RunContext {
  readonly input: Ctx["input"];
  readonly maxIterations: number;
  /** Whether this run takes up from a yield, and the reason that yield gave. */
  readonly resumed: boolean;
  readonly yieldReason: string | null;
  /** How many times the state has been persisted — in this run and the ones before it. */
  readonly iteration: number;
  /** How the program ended the run: null until it has called done() or yield(). */
  readonly ended: ProgramResult | null;

  log(message: string, data?: unknown): void;
  /** The first call is logged and passed on to `onReady`; any other does nothing. */
  ready(data?: Record<string, unknown>): void;
  /** Persist the program's state as it is now. Returns the iteration that makes it. */
  checkpoint(state: Record<string, unknown>): number;
  /** Persist the state and end the run as done. Returns the iteration it ended on. */
  done(state: Record<string, unknown>, result?: unknown): number;
  /** Persist the state, with the mark the next run resumes from, and end the run as yielded. */
  yield(state: Record<string, unknown>, reason: string): void;
}

/**
 * Bookkeeping lives in the state file under reserved `__trama_*` keys:
 * `__trama_iteration` (progress counter) and `__trama_yield` (set while the
 * program is suspended, cleared when it next advances).
 */
export function createContext(
  projectDir: string,
  initialState: Record<string, unknown>,
  options?: {
    maxIterations?: number;
    argsOverride?: Record<string, unknown>;
    onReady?: (data?: Record<string, unknown>) => void;
    /** Where the run's log lines are shown as they are written. Defaults to the console. */
    print?: (line: string) => void;
  },
): RunContext {
  const logsPath = guardPath(projectDir, LATEST_LOG_PATH);
  const statePath = guardPath(projectDir, "state.json");
  const meta = readProjectMeta(projectDir);

  // The input is the project's own: it is handed on as the file has it.
  const input = (options?.argsOverride
    ? { ...meta.input, args: { ...(meta.input.args ?? {}), ...options.argsOverride } }
    : meta.input) as Ctx["input"];

  // A yield marker left by the previous run means this run is its resumption.
  const yieldMarker = initialState.__trama_yield as { reason: string } | undefined;
  const savedIteration = initialState.__trama_iteration;

  let iteration = typeof savedIteration === "number" && Number.isInteger(savedIteration) && savedIteration >= 0
    ? savedIteration : 0;
  let readyCalled = false;
  let ended: ProgramResult | null = null;

  const writeLog = (message: string, data?: unknown) => {
    appendLogEntry(logsPath, message, data);
    (options?.print ?? console.log)(`[trama] ${message}`);
  };

  /**
   * The one way a state reaches the state file, and the one place the rules of
   * a run's ending are kept. A run ends once, by done() or by yield(). After
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
      const endedBy = ended.status === "done" ? "done" : "yield";
      throw new Error(`Cannot call ctx.${call}() after ctx.${endedBy}() — the run has ended, and its state is settled.`);
    }
    assertSerializable(state, "ctx.state");
    const record: Record<string, unknown> = { ...state, __trama_iteration: iteration + 1 };
    if (ending?.status === "yielded") record.__trama_yield = { reason: ending.reason };
    else delete record.__trama_yield; // the program has moved on from its last yield
    writeFileSync(statePath, JSON.stringify(record, null, 2));
    // Settled only once persisted: a call that failed leaves every call open.
    iteration += 1;
    ended = ending ?? null;
    return true;
  };

  /** Persistence is the critical part: a log line that cannot be written must not turn a completed ending into an error. */
  const logEnding = (message: string, data?: unknown) => {
    try { writeLog(message, data); } catch { /* best-effort */ }
  };

  return {
    input,
    maxIterations: options?.maxIterations ?? 100,
    resumed: yieldMarker != null,
    yieldReason: yieldMarker?.reason ?? null,
    get iteration() { return iteration; },
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
      return iteration;
    },

    done(state, result) {
      if (persist("done", state, { status: "done", result: result ?? undefined })) logEnding("done", result);
      return iteration;
    },

    // Exiting is the program's job: this returns so that the call can be answered first.
    yield(state, reason) {
      if (persist("yield", state, { status: "yielded", reason })) logEnding("yield", { reason });
    },
  };
}
