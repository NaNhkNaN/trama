// What a project takes and gives: said in its meta.json, in the words a tool
// is declared in — `description`, `parameters`, `returns` — and written as
// every shape is (see schema.ts). The runner holds a run to it: arguments
// that do not fit are a run that is not begun, and a result that does not
// fit is a `done` that failed.
//
// It is the project's, and not its program's: an update writes program.ts
// and nothing else, so what a program is held to is out of the reach of
// whoever rewrites it — and every version of a project keeps one contract,
// which is what lets two of them be held against each other at all.
//
// A project that says none of it is held to nothing, as it was.

import { createHash } from "crypto";
import { existsSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import { messageOf } from "./errors.js";
import { readProjectMeta, type ProjectMeta } from "./meta.js";
import { projectNamed } from "./project.js";
import { conform, jsonSchemaOf, shapeOf, type Shape } from "./schema.js";
import { isJsonObject } from "./serializable.js";

export interface Contract {
  /** What the project is for, in words: for whoever chooses among projects. */
  description?: string;
  /** What a run of it is given: as it is written, and read. */
  parameters?: { declared: Record<string, unknown>; shape: Extract<Shape, { fields: unknown }> };
  /** What a run of it gives: as it is written, and read. */
  returns?: { declared: unknown; shape: Shape };
}

/** What a project says of itself, for whoever asks (see `describeProject`). */
export interface ProjectDescription {
  /** The project's name: that of its directory. */
  name: string;
  description?: string;
  /** What a run of it is given, as its meta.json writes it. */
  parameters?: Record<string, unknown>;
  /** What a run of it gives, as its meta.json writes it. */
  returns?: unknown;
  /** The same as JSON Schema, which is how a model is told of a tool. */
  schema?: { parameters?: Record<string, unknown>; returns?: Record<string, unknown> };
}

/**
 * Read what a project's meta.json says the project takes and gives. What is
 * written there and is no shape — or no text, of the description — is
 * refused by name, as a meta.json that is none is.
 */
export function contractOf(projectDir: string, meta: ProjectMeta = readProjectMeta(projectDir), unread = `Malformed meta.json in ${projectDir}`): Contract {
  // (`unread`: what it is called where it cannot be read — of what is not yet a project's meta.json, another thing than that.)
  const fail = (what: string): Error => new Error(`${unread} — ${what}`);
  const said = meta as unknown as Record<string, unknown>;
  const contract: Contract = {};
  if (said.description !== undefined) {
    if (typeof said.description !== "string") throw fail(`"description" is what the project is for, in words: text.`);
    contract.description = said.description;
  }
  const read = (field: "parameters" | "returns"): Shape => {
    try {
      return shapeOf(said[field], null);
    } catch (err) {
      throw fail(`"${field}": ${messageOf(err)}`);
    }
  };
  if (said.parameters !== undefined) {
    if (!isJsonObject(said.parameters)) throw fail(`"parameters" is what the project takes: an object of the fields a run is given.`);
    contract.parameters = { declared: said.parameters, shape: read("parameters") as Extract<Shape, { fields: unknown }> };
  }
  if (said.returns !== undefined) contract.returns = { declared: said.returns, shape: read("returns") };
  return contract;
}

const FAILED = "Schema validation failed: ";
const why = (err: unknown): string => {
  const message = messageOf(err);
  return message.startsWith(FAILED) ? message.slice(FAILED.length) : message;
};

/**
 * What a run of a project is started with: the arguments it was asked with,
 * laid over those the project's own meta.json says — and, where the project
 * says what it takes, held to that: the declared fields and no others, as a
 * tool's arguments are held. Throws where a declared field is missing or of
 * another kind.
 *
 * **An argument the project does not take is left out, and not refused**
 * (`leftOut`: their names, for whoever is to say so). Whoever starts a run
 * may hand it more than its program reads — a runner hands a checker and a
 * fixer what it has, and may have more one day; an input may carry what is
 * for its judge — and a program is not to lean on what its project does not
 * say it takes. That it was left out is said (see runProject), for it is
 * also what a name written wrongly looks like.
 *
 * An argument written as text where a number or a boolean is declared is
 * read as the one it writes: from a command line every argument is text.
 *
 * `asked`: the arguments as they were asked — those left out among them —
 * with what was held in the place of what it was held from: what a checker
 * of the run is handed, which judges what was asked for.
 */
export function fitted(projectDir: string, args?: Record<string, unknown>, meta: ProjectMeta = readProjectMeta(projectDir)): { args: Record<string, unknown> | undefined; leftOut: string[]; asked: Record<string, unknown>; takes?: string } {
  const given = args === undefined ? meta.input.args : { ...(meta.input.args ?? {}), ...args };
  const { parameters } = contractOf(projectDir, meta);
  if (!parameters) return { args: given, leftOut: [], asked: { ...given } };
  const takes = parameters.shape.fields.map(([name]) => (parameters.shape.mayBeAbsent.includes(name) ? `${name}?` : name)).join(", ") || "nothing";
  const read: Record<string, unknown> = {}, leftOut: string[] = [];
  for (const [name, value] of Object.entries(given ?? {})) {
    const field = parameters.shape.fields.find(([has]) => has === name);
    if (!field) { leftOut.push(name); continue; }
    read[name] = value;
    if (typeof value !== "string") continue;
    if (field[1] === "number" && value.trim() !== "" && Number.isFinite(Number(value))) read[name] = Number(value);
    if (field[1] === "boolean" && (value === "true" || value === "false")) read[name] = value === "true";
  }
  try {
    const held = conform(read, parameters.shape) as Record<string, unknown>;
    return { args: held, leftOut, asked: { ...given, ...held }, takes };
  } catch (err) {
    const left = leftOut.length > 0 ? ` Not taken, and left out: ${leftOut.map((name) => JSON.stringify(name)).join(", ")}.` : "";
    throw new Error(`The arguments do not fit what ${projectDir} takes — ${why(err)}.${left} It takes: ${takes}.`);
  }
}

/** What a run's program is given of what the run was started with (see `fitted`). */
export const startedWith = (projectDir: string, args?: Record<string, unknown>, meta?: ProjectMeta): Record<string, unknown> | undefined =>
  fitted(projectDir, args, meta).args;

/**
 * The fields a value has that its shape does not declare, by where they are
 * ("also", "files.extra", "lines[].extra" — once for every item of a list):
 * what holding it to the shape leaves out.
 */
function undeclared(value: unknown, shape: Shape, where = ""): string[] {
  if (typeof shape === "string") return [];
  if ("items" in shape) return Array.isArray(value) ? [...new Set(value.flatMap((item) => undeclared(item, shape.items, `${where}[]`)))] : [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.keys(value).flatMap((key) => {
    const at = where === "" ? key : `${where}.${key}`;
    const field = shape.fields.find(([has]) => has === key);
    return field ? undeclared((value as Record<string, unknown>)[key], field[1], at) : [at];
  });
}

/**
 * What a run gives, held to what its project says it gives: the declared
 * fields and no others (`given`). Throws where it does not fit.
 *
 * **What it had beside is left out, and not refused** — as an argument the
 * project does not take is (see `fitted`) — and is named (`leftOut`), for
 * whoever is to say so: a result that comes back short of what its program
 * handed over, with nothing said, is what a field nobody declared looks like
 * to whoever asked for it. `gives`: what the project says it gives, in a word
 * for each field.
 */
export function heldResult(projectDir: string, contract: Contract, result: unknown): { given: unknown; leftOut: string[]; gives?: string } {
  if (!contract.returns) return { given: result, leftOut: [] };
  const { shape, declared } = contract.returns;
  const fields = typeof shape !== "string" && "fields" in shape ? shape : undefined;
  try {
    // (An object is spoken of by its fields; anything else, as "it".)
    const given = conform(result, shape, fields ? null : "it");
    const gives = fields ? fields.fields.map(([name]) => (fields.mayBeAbsent.includes(name) ? `${name}?` : name)).join(", ") || "nothing" : JSON.stringify(declared);
    return { given, leftOut: undeclared(result, shape), gives };
  } catch (err) {
    throw new Error(`The result does not fit what ${projectDir} gives — ${why(err)}.`);
  }
}

/** A mark of a contract: the same for the same, and absent where the project says nothing of what it takes or gives. */
export function contractMark(contract: Contract): string | undefined {
  if (!contract.parameters && !contract.returns) return undefined;
  return createHash("sha256").update(JSON.stringify([contract.parameters?.declared ?? null, contract.returns?.declared ?? null])).digest("hex");
}

/** What the project at a place says of itself. */
function described(projectDir: string): ProjectDescription {
  const name = basename(projectDir);
  const { description, parameters, returns } = contractOf(projectDir);
  return {
    name,
    ...(description !== undefined && { description }),
    ...(parameters && { parameters: parameters.declared }),
    ...(returns && { returns: returns.declared }),
    ...((parameters || returns) && { schema: {
      ...(parameters && { parameters: jsonSchemaOf(parameters.declared) }),
      ...(returns && { returns: jsonSchemaOf(returns.declared) }),
    } }),
  };
}

/**
 * What a project says of itself — what it is for, what it takes and gives —
 * read from its meta.json: its program is not run. Named as a project is
 * named to be checked by: by its name among the user's projects, or a path.
 */
export function describeProject(named: string): ProjectDescription {
  const projectDir = projectNamed(named);
  if (!existsSync(join(projectDir, "meta.json"))) throw new Error(`There is no project at ${projectDir}.`);
  return described(projectDir);
}

/** The user's projects, by name, and what each says of itself. (One whose meta.json cannot be read so has its name, and no more.) */
export function describeProjects(): ProjectDescription[] {
  const dir = join(homedir(), ".trama", "projects");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort()
    .filter((name) => statSync(join(dir, name), { throwIfNoEntry: false })?.isDirectory() === true && existsSync(join(dir, name, "meta.json")))
    .map((name) => {
      try {
        return described(join(dir, name));
      } catch {
        return { name };
      }
    });
}
