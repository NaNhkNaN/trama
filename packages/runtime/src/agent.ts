import type { Agent } from "./types.js";
import { CutOff, type AgentBackend, type AgentCall } from "./agent-backend.js";
import { isJsonObject } from "./serializable.js";

/** A line of a reply that could be the edge of a fenced block: three or more backticks. */
interface Fence {
  /** Where its backticks start, where its line does, and where the next line does. */
  at: number;
  line: number;
  next: number;
  ticks: number;
  /** It could open a block: nothing follows it on its line but a word for what the block holds. */
  opens: boolean;
  /** It could close one: nothing stands before it on its line. */
  closes: boolean;
}

const NAMED = /[\w.+#-]*\s*\n/y;

/** The fences of a text, in the order they stand in. */
function fencesOf(text: string): Fence[] {
  const fences: Fence[] = [];
  for (const run of text.matchAll(/`{3,}/g)) {
    const at = run.index, ticks = run[0].length;
    const line = text.lastIndexOf("\n", at - 1) + 1;
    const newline = text.indexOf("\n", at);
    NAMED.lastIndex = at + ticks;
    const opens = NAMED.test(text);
    const closes = text.slice(line, at).trim() === "";
    if (opens || closes) fences.push({ at, line, next: newline === -1 ? text.length : newline + 1, ticks, opens, closes });
  }
  return fences;
}

/**
 * A reader of the comments of `text` from `from` on, to be asked of one
 * fence after another, in order, whether it stands in one — and so is the
 * program's own text: a program may show how it is used, between fences, in
 * a comment.
 *
 * Only a comment that begins its line is one here (as a comment that holds
 * lines of its own does): `src/*.ts` in a sentence, or in a command, opens
 * nothing. Nothing else of the language is read — a string or a template
 * literal cannot hold a line of backticks anyway.
 */
function commentsFrom(text: string, from: number): { holds(fence: Fence): boolean; open(): boolean } {
  const marks = /^[ \t]*\/\*|\*\//gm;
  let at = from, open = false;
  const readTo = (end: number) => {
    marks.lastIndex = at;
    for (let mark; (mark = marks.exec(text)) !== null && mark.index < end; ) open = mark[0] !== "*/";
    at = end;
    return open;
  };
  return {
    holds: (fence) => readTo(fence.at) || /^[ \t]*\/\//.test(text.slice(fence.line, fence.at)),
    open: () => readTo(text.length),
  };
}

/**
 * The program in an LLM reply that was asked to contain nothing else: the last
 * fenced block if there is one (models add explanations, or show a "before"
 * first), otherwise the whole text.
 *
 * A program may hold fences of its own, in a comment. So a reply in which
 * every fence stands in a comment was not fenced at all; and a block ends at
 * the first closing fence, of backticks enough, that does not stand in a
 * comment of the block — or, if there is none such (the block is no program,
 * its comment never ends, it was opened with more backticks than it is
 * closed with), at the first closing fence there is.
 *
 * What this still takes wrongly, where the plain reading would not: a line
 * that begins as a comment begins — among the words, or in another block:
 * `/*.log` in a list of files to ignore, a snippet cut off inside a comment —
 * when what ends a comment comes only further on, past a fence. Then the
 * fences between are taken for a program's own, and the reply comes out
 * whole, or as two blocks and the words between them. It is not a program,
 * and the validation that follows says so.
 */
export function stripCodeFences(text: string): string {
  const reply = text.trim();
  const fences = fencesOf(reply);
  const whole = commentsFrom(reply, 0);
  if (fences.every((fence) => whole.holds(fence)) && !whole.open()) return reply;

  let last: string | undefined;
  for (let from = 0; ; ) {
    const opener = fences.find((fence) => fence.opens && fence.at >= from);
    if (!opener) break;
    const closers = fences.filter((fence) => fence.at >= opener.next && fence.closes);
    const inBlock = commentsFrom(reply, opener.next);
    const closer = closers.find((fence) => fence.ticks >= opener.ticks && !inBlock.holds(fence)) ?? closers[0];
    if (closer) last = reply.slice(opener.next, closer.line).trim();
    from = (closer ?? opener).at + (closer ?? opener).ticks;
  }
  return last ?? reply;
}

const SCHEMA_PRIMITIVES = new Set(["string", "number", "boolean"]);
type SchemaPrimitive = "string" | "number" | "boolean";

/** What a schema says a value is to be: a primitive by its name, an object by its fields, a list by the one shape all its items have. */
type Shape = SchemaPrimitive | { fields: Array<[string, Shape]> } | { items: Shape };

/** How the two shapes that are not named in a word are written, for whoever named them in one. */
const HOW_WRITTEN = `a list is written as the shape of its items, in brackets: ["string"]; an object as its fields: { name: "string" }`;

/** Where a value is in an answer, in words: null for the answer itself, and under that each field by its name. */
type Where = string | null;
const fieldOf = (where: Where, key: string): string => (where === null ? key : `${where}.${key}`);

/**
 * Read the caller's schema declaration, up front: what the value at `where`
 * is to be. In words — "string", "number", "boolean", where what follows a
 * ":" describes the value to the model and is not read here — or an object
 * of such, or a list of one element: the shape of every item.
 */
function shapeOf(declared: unknown, where: Where): Shape {
  if (Array.isArray(declared)) {
    if (declared.length !== 1) {
      throw new Error(`Schema validation failed: the list at "${where}" is written with ${declared.length} elements — it takes one, the shape of every item`);
    }
    return { items: shapeOf(declared[0], `${where}[]`) };
  }
  if (isJsonObject(declared)) {
    return { fields: Object.entries(declared).map(([key, value]) => [key, shapeOf(value, fieldOf(where, key))]) };
  }
  // (Anything else says nothing that is supported — and is said back as JSON would write it, which is no word for a kind.)
  const named = typeof declared === "string" ? declared.split(":")[0].trim() : JSON.stringify(declared);
  if (!SCHEMA_PRIMITIVES.has(named)) {
    throw new Error(`Schema validation failed: unsupported schema type "${named}" for key "${where}" (${HOW_WRITTEN})`);
  }
  return named as SchemaPrimitive;
}

const hasList = (shape: Shape): boolean =>
  typeof shape !== "string" && ("items" in shape || shape.fields.some(([, field]) => hasList(field)));

/** What a value is, said as a reply is told of it. */
const said = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "a list" : typeof value === "number" ? String(value) : typeof value;

/**
 * Shape validation and projection: verifies that the value at `where` is of
 * the shape declared — every field there, every item of a list — and returns
 * it holding the declared fields and no others.
 */
function conform(value: unknown, shape: Shape, where: Where): unknown {
  const mismatch = (expected: string) => new Error(`Schema validation failed: ${where}: expected ${expected}, got ${said(value)}`);
  if (typeof shape === "string") {
    if (typeof value !== shape || (shape === "number" && !Number.isFinite(value))) throw mismatch(shape);
    return value;
  }
  if ("items" in shape) {
    if (!Array.isArray(value)) throw mismatch("a list");
    return value.map((item, index) => conform(item, shape.items, `${where}[${index}]`));
  }
  if (!isJsonObject(value)) throw where === null ? new Error("Schema validation failed: response is not an object") : mismatch("an object");
  return Object.fromEntries(shape.fields.map(([key, field]) => {
    // (A field is the reply's own: what every object has by birth is not something a reply said.)
    if (!Object.hasOwn(value, key)) throw new Error(`Schema validation failed: missing key: ${fieldOf(where, key)}`);
    return [key, conform(value[key], field, fieldOf(where, key))];
  }));
}

/** Hears what a call used — each time its backend was asked: a `generate` that had to ask again is heard twice. */
type Used = AgentCall["used"];

/** The runner's side of a program's `agent`: its calls, and for each a place to say what it used. */
export interface RunnerAgent {
  instruct(prompt: string, options?: Parameters<Agent["instruct"]>[1], used?: Used): Promise<string>;
  generate<T>(input: Parameters<Agent["generate"]>[0], used?: Used): Promise<T>;
}

/** Of what a call may ask for, what it did ask for: a backend is not handed a thing nobody named. */
const asked = (options: Pick<AgentCall, "model" | "thinking" | "tools" | "skills" | "templates" | "extensions" | "asText" | "used">) =>
  Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));

/**
 * The `agent` a program talks to: its calls, served by `backend` working in
 * `cwd`, and cancelled together through `signal`.
 */
export function createAgent(backend: AgentBackend, cwd: string, signal?: AbortSignal): RunnerAgent {
  /**
   * Ask the backend — and of a reply that was cut off at the output limit,
   * make what the call said to make of it: its failure, unless the call
   * keeps such a reply, and there is something of it to keep.
   */
  const ask = async (prompt: string, call: AgentCall, cutOff: unknown): Promise<string> => {
    if (cutOff !== undefined && cutOff !== "fail" && cutOff !== "keep") {
      throw new Error(`cutOff is "fail" or "keep", not ${JSON.stringify(cutOff)}`);
    }
    try {
      return await backend.ask(prompt, call);
    } catch (err) {
      if (cutOff === "keep" && err instanceof CutOff && err.text !== "") return err.text;
      throw err;
    }
  };

  return {
    async instruct(prompt, options, used) {
      const { system, model, thinking, tools, skills, templates, extensions, cutOff } = options ?? {};
      return ask(prompt, { cwd, system, signal, ...asked({ model, thinking, tools, skills, templates, extensions, used }) }, cutOff);
    },

    async generate(input, used) {
      if (!isJsonObject(input.schema)) throw new Error("Schema validation failed: a schema is an object of the fields the answer is to have");
      const shape = shapeOf(input.schema, null);
      const schemaInstruction = `Respond with ONLY a JSON object matching this shape:\n${
        JSON.stringify(input.schema, null, 2)
      }\n${
        hasList(shape) ? "Where the shape shows a list, it shows one item: answer with as many as there are, each of that shape.\n" : ""
      }No markdown. No explanation. Just the JSON.`;

      const fullPrompt = `${input.prompt}\n\n${schemaInstruction}`;
      const { system, model, thinking, tools, skills, extensions, cutOff } = input;
      // The prompt of a typed answer is text, whatever it begins with: what says how to answer follows it, and a
      // skill called up by name, or a command, would take that for its own — and would not be there at a second asking.
      const asText = skills !== undefined || extensions !== undefined ? true : undefined;
      const call = { cwd, system, signal, ...asked({ model, thinking, tools, skills, extensions, asText, used }) };

      const parseAndValidate = (response: string): Record<string, unknown> => {
        const trimmed = response.trim();
        // Try raw parse first — avoids mangling valid JSON that contains
        // fenced code blocks inside string values.
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
          parsed = JSON.parse(fenceMatch ? fenceMatch[1].trim() : trimmed);
        }
        return conform(parsed, shape, null) as Record<string, unknown>;
      };

      // First attempt — backend errors (network/auth) propagate immediately.
      // Only parse/validation failures trigger a retry.
      const response = await ask(fullPrompt, call, cutOff);
      try {
        return parseAndValidate(response) as any;
      } catch (firstError) {
        const retryPrompt = `Your previous response failed validation: ${firstError}.\nTry again.\n\n${fullPrompt}`;
        const retryResponse = await ask(retryPrompt, call, cutOff);
        return parseAndValidate(retryResponse) as any;
      }
    }
  };
}
