// The shapes a program declares: of a typed answer (`agent.generate`), and of
// what a tool of its own is called with. One way of writing them — a kind in
// a word, an object by its fields, a list by the shape of its items — read
// once into a shape, which a value is then held to.
//
// Two words beside those. A field that may be absent is written with a "?" at
// the end of its name: { "model?": "string" } — its name is `model`. And
// "json" is any value: what is there is held as it is.

import { isJsonObject } from "./serializable.js";

const PRIMITIVES = ["string", "number", "boolean"] as const;
type SchemaPrimitive = (typeof PRIMITIVES)[number];
const isPrimitive = (named: string): named is SchemaPrimitive => (PRIMITIVES as readonly string[]).includes(named);
/** Any value at all: nothing is asked of it but that it be there. */
const ANY = "json";

/**
 * What a schema says a value is to be: a primitive by its name — or any
 * value — an object by its fields (and which of them may be absent), a list
 * by the one shape all its items have.
 */
export type Shape = SchemaPrimitive | typeof ANY | { fields: Array<[string, Shape]>; mayBeAbsent: string[] } | { items: Shape };

/** A field as it is written: its name, and whether it may be absent — a "?" at the end of what it is written under says so. */
const written = (key: string): { name: string; optional: boolean } =>
  (key.endsWith("?") ? { name: key.slice(0, -1), optional: true } : { name: key, optional: false });

/** How the two shapes that are not named in a word are written, for whoever named them in one. */
const HOW_WRITTEN = `a list is written as the shape of its items, in brackets: ["string"]; an object as its fields: { name: "string" }`;

/** Where a value is in an answer, in words: null for the answer itself, and under that each field by its name. */
type Where = string | null;
const fieldOf = (where: Where, key: string): string => (where === null ? key : `${where}.${key}`);

/** A value's kind as a schema names it in a word — and what follows a ":" there: words for the model, of what the value is. */
function worded(word: string): { kind: string; description: string } {
  const [kind, ...words] = word.split(":");
  return { kind: kind.trim(), description: words.join(":").trim() };
}

/**
 * Read the caller's schema declaration, up front: what the value at `where`
 * is to be. In words — "string", "number", "boolean", where what follows a
 * ":" describes the value to the model and is not read here — or an object
 * of such, or a list of one element: the shape of every item.
 */
export function shapeOf(declared: unknown, where: Where = null): Shape {
  if (Array.isArray(declared)) {
    if (declared.length !== 1) {
      throw new Error(`Schema validation failed: the list at "${where}" is written with ${declared.length} elements — it takes one, the shape of every item`);
    }
    return { items: shapeOf(declared[0], `${where}[]`) };
  }
  if (isJsonObject(declared)) {
    const fields: Array<[string, Shape]> = [], mayBeAbsent: string[] = [];
    for (const [key, value] of Object.entries(declared)) {
      const { name, optional } = written(key);
      // (A field may be named by nothing at all, odd as it is: what says nothing is a "?" with no name before it.)
      if (optional && name === "") throw new Error(`Schema validation failed: a field's name is missing before its "?"${where === null ? "" : `, at "${where}"`}`);
      if (fields.some(([has]) => has === name)) throw new Error(`Schema validation failed: the field "${fieldOf(where, name)}" is written twice, with a "?" and without`);
      fields.push([name, shapeOf(value, fieldOf(where, name))]);
      if (optional) mayBeAbsent.push(name);
    }
    return { fields, mayBeAbsent };
  }
  // (Anything else says nothing that is supported — and is said back as JSON would write it, which is no word for a kind.)
  const named = typeof declared === "string" ? worded(declared).kind : JSON.stringify(declared);
  if (named === ANY) return ANY;
  if (!isPrimitive(named)) {
    throw new Error(`Schema validation failed: unsupported schema type "${named}" for key "${where}" (${HOW_WRITTEN})`);
  }
  return named;
}

/**
 * A schema as JSON Schema says it: every field there but those that may be
 * absent, and no other; what follows a ":" in a field's word describes it.
 * (Of any value no kind is said.)
 */
export function jsonSchemaOf(declared: unknown): Record<string, unknown> {
  if (Array.isArray(declared)) return { type: "array", items: jsonSchemaOf(declared[0]) };
  if (isJsonObject(declared)) {
    const fields = Object.entries(declared).map(([key, value]) => ({ ...written(key), value }));
    return {
      type: "object",
      properties: Object.fromEntries(fields.map(({ name, value }) => [name, jsonSchemaOf(value)])),
      required: fields.filter(({ optional }) => !optional).map(({ name }) => name),
      additionalProperties: false,
    };
  }
  const { kind, description } = worded(String(declared));
  return { ...(kind !== ANY && { type: kind }), ...(description && { description }) };
}

/**
 * What a tool is called with, declared as a typed answer's shape is: the
 * fields of an object. `schema` says it as JSON Schema, which is how a model
 * is told; `held` holds what a tool is about to be called with to it, as a
 * typed answer is held to its shape — returning the declared fields and no
 * others, or throwing what is wrong. (A schema that is not one is an error,
 * as it is of an answer.)
 */
export function argumentsOf(declared: unknown): { schema: Record<string, unknown>; held(args: unknown): unknown } {
  if (!isJsonObject(declared)) throw new Error("Schema validation failed: a tool's parameters are an object of the fields it is called with");
  const shape = shapeOf(declared);
  return {
    schema: jsonSchemaOf(declared),
    held(args) {
      if (!isJsonObject(args)) throw new Error("Schema validation failed: the arguments are not an object");
      return conform(args, shape);
    },
  };
}

/** Whether a shape has a list anywhere in it. */
export const hasList = (shape: Shape): boolean =>
  typeof shape !== "string" && ("items" in shape || shape.fields.some(([, field]) => hasList(field)));

/** Whether a shape has a field that may be absent anywhere in it. */
export const hasOptional = (shape: Shape): boolean =>
  typeof shape !== "string" && ("items" in shape ? hasOptional(shape.items) : shape.mayBeAbsent.length > 0 || shape.fields.some(([, field]) => hasOptional(field)));

/** What a value is, said as a reply is told of it. */
const said = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "a list" : typeof value === "number" ? String(value) : typeof value;

/**
 * Shape validation and projection: verifies that the value at `where` is of
 * the shape declared — every field there, every item of a list — and returns
 * it holding the declared fields and no others.
 *
 * A field that may be absent is held where it is there, and is no key of
 * what is returned where it is not. (A null under it is its absence: it is
 * how many a caller says "none" — a model calling a tool among them.)
 */
export function conform(value: unknown, shape: Shape, where: Where = null): unknown {
  const mismatch = (expected: string) => new Error(`Schema validation failed: ${where}: expected ${expected}, got ${said(value)}`);
  if (shape === ANY) return value;
  if (typeof shape === "string") {
    if (typeof value !== shape || (shape === "number" && !Number.isFinite(value))) throw mismatch(shape);
    return value;
  }
  if ("items" in shape) {
    if (!Array.isArray(value)) throw mismatch("a list");
    return value.map((item, index) => conform(item, shape.items, `${where}[${index}]`));
  }
  if (!isJsonObject(value)) throw where === null ? new Error("Schema validation failed: response is not an object") : mismatch("an object");
  return Object.fromEntries(shape.fields.flatMap(([key, field]) => {
    // (A field is the reply's own: what every object has by birth is not something a reply said.)
    const there = Object.hasOwn(value, key);
    if (shape.mayBeAbsent.includes(key) && (!there || value[key] === null || value[key] === undefined)) return [];
    if (!there) throw new Error(`Schema validation failed: missing key: ${fieldOf(where, key)}`);
    return [[key, conform(value[key], field, fieldOf(where, key))]];
  }));
}

/**
 * What a model called a tool with, held to the parameters the tool declared:
 * for a program that runs its own tools, as the runner holds them for an
 * agent's (see argumentsOf). Returns the declared fields and no others, or
 * throws what is wrong — in words a model can be handed, to try again by.
 */
export function heldTo(parameters: unknown, given: unknown): Record<string, unknown> {
  return argumentsOf(parameters ?? {}).held(given) as Record<string, unknown>;
}
