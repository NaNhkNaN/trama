import { writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import type { Ctx } from "./types.js";
import { assertSerializable, toLogData } from "./serializable.js";
import { guardPath } from "./path-guard.js";
import { readProjectMeta } from "./meta.js";

/** Where a project's structured run log lives, relative to the project root. */
export const LATEST_LOG_PATH = join("logs", "latest.jsonl");

/** Append one structured JSONL entry to a run log file. */
export function appendLogEntry(logsPath: string, message: string, data?: unknown): void {
  const entry = { ts: Date.now(), message, data: toLogData(data ?? null) };
  appendFileSync(logsPath, JSON.stringify(entry) + "\n");
}

/**
 * The runner-side ctx: owns state.json and the run log for one run of a
 * program. The program's own `ctx` (client.ts) forwards to this over IPC.
 *
 * This is the one place the ctx lifecycle rules are enforced (ready once,
 * done once, done and yield mutually exclusive) — the client only forwards.
 *
 * Bookkeeping lives in ctx.state under reserved `__trama_*` keys:
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
): Ctx {
  const logsPath = guardPath(projectDir, LATEST_LOG_PATH);
  const statePath = guardPath(projectDir, "state.json");
  const meta = readProjectMeta(projectDir);

  let readyCalled = false;
  let terminalSignal: "done" | "yielded" | null = null;

  // The input is the project's own: it is handed on as the file has it.
  const input = (options?.argsOverride
    ? { ...meta.input, args: { ...(meta.input.args ?? {}), ...options.argsOverride } }
    : meta.input) as Ctx["input"];

  // A yield marker left by the previous run means this run is its resumption.
  const yieldMarker = initialState.__trama_yield as { reason: string } | undefined;
  const savedIteration = initialState.__trama_iteration;

  const writeLog = (message: string, data?: unknown) => {
    appendLogEntry(logsPath, message, data);
    (options?.print ?? console.log)(`[trama] ${message}`);
  };

  /** Validate ctx.state, write state.json, and advance in-memory state only once persisted. */
  const persistState = (ctx: Ctx, yieldReason?: string) => {
    assertSerializable(ctx.state, "ctx.state");
    const nextIteration = ctx.iteration + 1;
    const nextState: Record<string, unknown> = { ...ctx.state, __trama_iteration: nextIteration };
    if (yieldReason !== undefined) nextState.__trama_yield = { reason: yieldReason };
    else delete nextState.__trama_yield; // the program has moved on from its last yield
    writeFileSync(statePath, JSON.stringify(nextState, null, 2));
    if (yieldReason !== undefined) ctx.state.__trama_yield = { reason: yieldReason };
    else delete ctx.state.__trama_yield;
    ctx.state.__trama_iteration = nextIteration;
    ctx.iteration = nextIteration;
  };

  return {
    input,
    state: { ...initialState },
    iteration: typeof savedIteration === "number" && Number.isInteger(savedIteration) && savedIteration >= 0
      ? savedIteration : 0,
    maxIterations: options?.maxIterations ?? 100,
    resumed: yieldMarker != null,
    yieldReason: yieldMarker?.reason ?? null,

    async log(message, data) {
      writeLog(message, data);
    },

    async ready(data) {
      if (readyCalled) return;
      writeLog("ready", data);
      options?.onReady?.(data);
      readyCalled = true;
    },

    async checkpoint() {
      // A checkpoint says the program has moved on from its last yield. After
      // the yield that ends this run it would take back the very thing the
      // next run resumes from.
      if (terminalSignal === "yielded") {
        throw new Error("Cannot call ctx.checkpoint() after ctx.yield() — the run has yielded.");
      }
      persistState(this);
    },

    async done(result) {
      if (terminalSignal === "yielded") {
        throw new Error("Cannot call ctx.done() after ctx.yield() — yield already signaled.");
      }
      if (terminalSignal === "done") return;

      persistState(this);
      // Settled only once persisted — a failed done() leaves done() and yield() both open.
      terminalSignal = "done";
      // Persistence is the critical part; a log failure must not turn a completed done() into an error.
      try { writeLog("done", result); } catch { /* best-effort */ }
    },

    async yield(reason) {
      if (terminalSignal === "done") {
        throw new Error("Cannot call ctx.yield() after ctx.done() — done already signaled.");
      }
      // The client exits the process after its first successful yield; here a
      // repeated call is simply a no-op.
      if (terminalSignal !== "yielded") {
        persistState(this, reason);
        // Settled only once persisted — a failed yield() leaves done() and yield() both open.
        terminalSignal = "yielded";
        try { writeLog("yield", { reason }); } catch { /* best-effort */ }
      }
      // Exiting is the client's job: this returns so the IPC handler can answer first.
      return undefined as never;
    },
  };
}
