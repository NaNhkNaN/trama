import { readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import type { Ctx } from "./types.js";
import { assertSerializable } from "./serializable.js";

export function createContext(
  projectDir: string,
  initialState: Record<string, unknown>,
  options?: { maxIterations?: number; argsOverride?: Record<string, unknown> },
): Ctx {
  const logsPath = join(projectDir, "logs", "latest.jsonl");
  const statePath = join(projectDir, "state.json");
  const meta = JSON.parse(readFileSync(join(projectDir, "meta.json"), "utf-8"));

  let doneCalled = false;
  let doneLogged = false;

  const input = options?.argsOverride
    ? { ...meta.input, args: { ...(meta.input.args ?? {}), ...options.argsOverride } }
    : meta.input;

  return {
    input,
    state: { ...initialState },
    iteration: typeof initialState.__trama_iteration === "number"
      && Number.isFinite(initialState.__trama_iteration)
      ? initialState.__trama_iteration : 0,
    maxIterations: options?.maxIterations ?? 100,

    async log(message, data) {
      const entry = { ts: Date.now(), message, data: data ?? null };
      appendFileSync(logsPath, JSON.stringify(entry) + "\n");
      console.log(`[trama] ${message}`);
    },

    async checkpoint() {
      assertSerializable(this.state, "ctx.state");

      const nextIteration = this.iteration + 1;
      this.state.__trama_iteration = nextIteration;
      writeFileSync(statePath, JSON.stringify(this.state, null, 2));
      this.iteration = nextIteration;
    },

    async done(result) {
      if (doneCalled) return;

      if (!doneLogged) {
        await this.log("done", result);
      }
      await this.checkpoint();
      // Only mark as complete after checkpoint succeeds.
      // If checkpoint throws, a retry will re-log "done" (acceptable)
      // and retry the checkpoint.
      doneLogged = true;
      doneCalled = true;
    }
  };
}
