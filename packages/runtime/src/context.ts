import { readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import type { Ctx } from "./types.js";

/**
 * Recursively check that a value is strictly JSON-serializable.
 * Throws TypeError with the path to the offending value.
 *
 * Uses a stack (ancestor chain) instead of a flat set so that shared-but-
 * non-circular structures like { a: shared, b: shared } pass validation.
 */
function assertSerializable(value: unknown, path: string, ancestors = new Set<unknown>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} is not JSON-serializable (${value})`);
    }
    return;
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new TypeError(`${path} is not JSON-serializable (${typeof value})`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${path} contains a circular reference`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertSerializable(value[i], `${path}[${i}]`, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    const name = (value as object).constructor?.name ?? "unknown";
    throw new TypeError(`${path} is not a plain object (${name})`);
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    assertSerializable(v, `${path}.${k}`, ancestors);
  }
  ancestors.delete(value);
}

export function createContext(
  projectDir: string,
  initialState: Record<string, unknown>,
  options?: { maxIterations?: number },
): Ctx {
  const logsPath = join(projectDir, "logs", "latest.jsonl");
  const statePath = join(projectDir, "state.json");
  const meta = JSON.parse(readFileSync(join(projectDir, "meta.json"), "utf-8"));

  let doneCalled = false;
  let doneLogged = false;

  return {
    input: meta.input,
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

      if (result && !doneLogged) {
        await this.log("done", result);
        doneLogged = true;
      }
      await this.checkpoint();
      doneCalled = true;
    }
  };
}
