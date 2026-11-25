// meta.json: what a project was created with. Written once, by `create` (or
// by hand, for a hand-written project), and read by every run.

import { readFileSync } from "fs";
import { guardPath } from "./path-guard.js";
import { describeJson, isJsonObject } from "./serializable.js";
import { messageOf } from "./errors.js";

export interface ProjectMeta {
  /** What the program is given as ctx.input. */
  input: { prompt?: string; args?: Record<string, unknown> } & Record<string, unknown>;
  createdAt?: string;
  piVersion?: string;
  /** The model and provider the project was created with; they take precedence over the global config. */
  model?: string;
  provider?: string;
  /** The project a run of this one is checked by, where the run names none (see RunOptions.checkWith): by a name, or by a path from here. */
  checkWith?: string;
  /** What the project is for, in words: for whoever chooses among projects (see contract.ts). */
  description?: string;
  /** What a run of the project is given, written as a tool's parameters are: a run whose arguments do not fit is not begun. */
  parameters?: Record<string, unknown>;
  /** What a run of the project gives, written as a shape is: a result that does not fit fails the `done` it was given with. */
  returns?: unknown;
}

/**
 * Read a project's meta.json. A file that is not what a run needs — not JSON,
 * or without an `input` object — is refused here, by name, rather than left to
 * fail wherever its contents are first used.
 */
export function readProjectMeta(projectDir: string): ProjectMeta {
  const raw = readFileSync(guardPath(projectDir, "meta.json"), "utf-8");
  const fail = (reason: string): Error => new Error(
    `Malformed meta.json in ${projectDir} — ${reason}\n` +
    `It needs to be a JSON object with an "input" object, like {"input": {"prompt": "...", "args": {}}}.`
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw fail(`Parse error: ${messageOf(err)}`);
  }
  if (!isJsonObject(parsed)) {
    throw fail(`expected a JSON object but got ${describeJson(parsed)}.`);
  }
  if (!isJsonObject(parsed.input)) throw fail(`"input" is ${parsed.input === undefined ? "missing" : "not an object"}.`);
  return parsed as unknown as ProjectMeta;
}
