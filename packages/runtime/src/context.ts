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

  const input = options?.argsOverride
    ? { ...meta.input, args: { ...(meta.input.args ?? {}), ...options.argsOverride } }
    : meta.input;

  return {
    input,
    state: { ...initialState },
    iteration: typeof initialState.__trama_iteration === "number"
      && Number.isInteger(initialState.__trama_iteration)
      && initialState.__trama_iteration >= 0
      ? initialState.__trama_iteration : 0,
    maxIterations: options?.maxIterations ?? 100,

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

      const nextIteration = this.iteration + 1;
      this.state.__trama_iteration = nextIteration;
      writeFileSync(statePath, JSON.stringify(this.state, null, 2));
      this.iteration = nextIteration;
    },

    async done(result) {
      // If a previous done() completed successfully, no-op.
      // If a previous done() is still in flight, coalesce onto it.
      // If a previous done() failed (checkpoint threw), allow retry.
      if (donePromise) return donePromise;

      const run = async () => {
        if (!doneLogged) {
          await this.log("done", result);
        }
        await this.checkpoint();
        doneLogged = true;
      };

      donePromise = run();
      try {
        await donePromise;
      } catch (err) {
        // Checkpoint failed — clear promise so a retry is allowed.
        donePromise = null;
        throw err;
      }
    }
  };
}
