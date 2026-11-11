import { readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import type { Ctx } from "./types.js";
import { assertSerializable } from "./serializable.js";
import { guardPath } from "./path-guard.js";

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
  },
): Ctx {
  const logsPath = guardPath(projectDir, join("logs", "latest.jsonl"));
  const statePath = guardPath(projectDir, "state.json");
  const meta = JSON.parse(readFileSync(guardPath(projectDir, "meta.json"), "utf-8"));

  let donePromise: Promise<void> | null = null;
  let readyCalled = false;
  let terminalSignal: "done" | "yielded" | null = null;

  const input = options?.argsOverride
    ? { ...meta.input, args: { ...(meta.input.args ?? {}), ...options.argsOverride } }
    : meta.input;

  // A yield marker left by the previous run means this run is its resumption.
  const yieldMarker = initialState.__trama_yield as { reason: string } | undefined;
  const savedIteration = initialState.__trama_iteration;

  /** Write ctx.state to disk and advance the iteration counter. */
  const persist = (ctx: Ctx) => {
    const nextIteration = ctx.iteration + 1;
    ctx.state.__trama_iteration = nextIteration;
    writeFileSync(statePath, JSON.stringify(ctx.state, null, 2));
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
      let safeData = data ?? null;
      try { JSON.stringify(safeData); } catch {
        safeData = { __trama_unserializable: String(data) };
      }
      const entry = { ts: Date.now(), message, data: safeData };
      appendFileSync(logsPath, JSON.stringify(entry) + "\n");
      console.log(`[trama] ${message}`);
    },

    async ready(data) {
      if (readyCalled) return;
      await this.log("ready", data);
      options?.onReady?.(data);
      readyCalled = true;
    },

    async checkpoint() {
      assertSerializable(this.state, "ctx.state");
      delete this.state.__trama_yield; // the program has moved on from its last yield
      persist(this);
    },

    async done(result) {
      if (terminalSignal === "yielded") {
        throw new Error("Cannot call ctx.done() after ctx.yield() — yield already signaled.");
      }

      // A completed done() is a no-op; one still in flight is shared.
      if (donePromise) return donePromise;

      // Claimed while in flight so a yield() cannot slip in alongside it.
      terminalSignal = "done";

      const run = async () => {
        await this.checkpoint();
        // Persistence is the critical part; a log failure must not turn a
        // completed done() into an error.
        try { await this.log("done", result); } catch { /* best-effort */ }
      };

      donePromise = run();
      try {
        await donePromise;
      } catch (err) {
        // Nothing was persisted, so nothing is settled: done() or yield() may be called again.
        donePromise = null;
        terminalSignal = null;
        throw err;
      }
    },

    async yield(reason) {
      if (terminalSignal === "done") {
        throw new Error("Cannot call ctx.yield() after ctx.done() — done already signaled.");
      }
      // The client exits the process after its first successful yield; here a
      // repeated call is simply a no-op.
      if (terminalSignal !== "yielded") {
        assertSerializable(this.state, "ctx.state");
        this.state.__trama_yield = { reason };
        persist(this);

        // Settled only once persisted — a failed yield() leaves done() and yield() both open.
        terminalSignal = "yielded";
        try { await this.log("yield", { reason }); } catch { /* best-effort */ }
      }
      // Exiting is the client's job: this returns so the IPC handler can answer first.
      return undefined as never;
    },
  };
}
