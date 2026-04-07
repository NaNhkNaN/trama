import { readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import type { Ctx } from "./types.js";
import { assertSerializable } from "./serializable.js";
import { guardPath } from "./path-guard.js";

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
  let doneLogged = false;
  let readyCalled = false;
  // Track terminal signal: null, "done", or "yielded"
  let terminalSignal: "done" | "yielded" | null = null;

  const input = options?.argsOverride
    ? { ...meta.input, args: { ...(meta.input.args ?? {}), ...options.argsOverride } }
    : meta.input;

  // Detect yield marker from previous run
  const yieldMarker = initialState.__trama_yield as { reason: string } | undefined;
  const resumed = yieldMarker != null;
  const yieldReason = yieldMarker?.reason ?? null;

  return {
    input,
    state: { ...initialState },
    iteration: typeof initialState.__trama_iteration === "number"
      && Number.isInteger(initialState.__trama_iteration)
      && initialState.__trama_iteration >= 0
      ? initialState.__trama_iteration : 0,
    maxIterations: options?.maxIterations ?? 100,
    resumed,
    yieldReason,

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

      // Clear yield marker on checkpoint (explicit state advancement)
      delete this.state.__trama_yield;

      const nextIteration = this.iteration + 1;
      this.state.__trama_iteration = nextIteration;
      writeFileSync(statePath, JSON.stringify(this.state, null, 2));
      this.iteration = nextIteration;
    },

    async done(result) {
      // Mutual exclusivity: yield() was already called
      if (terminalSignal === "yielded") {
        throw new Error("Cannot call ctx.done() after ctx.yield() — yield already signaled.");
      }

      // If a previous done() completed successfully, no-op.
      // If a previous done() is still in flight, coalesce onto it.
      // If a previous done() failed (checkpoint threw), allow retry.
      if (donePromise) return donePromise;

      terminalSignal = "done";

      const run = async () => {
        // Persist first — this is the critical action
        this.state.__trama_done = { result: result ?? null };
        // Clear any stale yield marker
        delete this.state.__trama_yield;
        await this.checkpoint();
        // Log is best-effort: persistence already succeeded.
        // Matches yield()'s pattern — log failure must not
        // prevent the IPC handler from acknowledging the signal.
        if (!doneLogged) {
          try { await this.log("done", result); } catch { /* best-effort */ }
          doneLogged = true;
        }
      };

      donePromise = run();
      try {
        await donePromise;
      } catch (err) {
        // Checkpoint failed — clear promise so a retry is allowed.
        donePromise = null;
        throw err;
      }
    },

    async yield(reason) {
      // Mutual exclusivity: done() was already called
      if (terminalSignal === "done") {
        throw new Error("Cannot call ctx.yield() after ctx.done() — done already signaled.");
      }

      // Idempotent: second yield after successful persistence is a no-op
      if (terminalSignal === "yielded") {
        // In server-side context, just return (won't actually reach here
        // in IPC mode since the client exits after the first yield)
        return undefined as never;
      }

      assertSerializable(this.state, "ctx.state");

      // Persist yield marker
      this.state.__trama_yield = { reason };
      // Clear done marker if somehow present
      delete this.state.__trama_done;

      const nextIteration = this.iteration + 1;
      this.state.__trama_iteration = nextIteration;
      writeFileSync(statePath, JSON.stringify(this.state, null, 2));

      // Set terminalSignal only after persistence succeeds,
      // so a failed yield can be retried (mirrors done()'s pattern).
      terminalSignal = "yielded";

      // Log is best-effort: the critical action (state persistence) already
      // succeeded. A log failure must not prevent the IPC handler from
      // acknowledging the yield to the signal tracker.
      try { await this.log("yield", { reason }); } catch { /* best-effort */ }

      // In IPC mode, the client handles process.exit(0).
      // Return never — the caller (IPC handler) responds to the client,
      // and the client exits the child process.
      return undefined as never;
    },
  };
}
