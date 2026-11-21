// A program's own tools, on the runner's side of the bridge.
//
// A program hands an agent call tools that are functions of its own. The
// functions stay where they are, in the program's process: what crosses the
// bridge with the call is what each is called and called with, and the
// runner makes of that a tool whose every use asks the program. The bridge
// only carries calls from a program to its runner, so the program asks for
// them: beside the agent call it makes another, which the runner holds until
// a tool of the call's is used, and it says what the tool answered by a third.
// Nothing listens in the program, and what a tool was asked and answered is
// seen where everything a program is told is seen.

import { IMAGE_KINDS, NOT_WAITED_FOR, type OwnTool, type ToolAnswer, type ToolImage } from "./agent-backend.js";
import { argumentsOf } from "./schema.js";
import { onAbort } from "./abort.js";
import { messageOf } from "./errors.js";
import { describeJson, isJsonObject } from "./serializable.js";

/**
 * A tool of a program's, as the program declared it: all of it but the
 * function — and what holds a use of it to the parameters it declared
 * (returning the declared fields, or throwing what is wrong: see argumentsOf).
 */
export type DeclaredTool = Omit<OwnTool, "run"> & { held(args: unknown): unknown };

/** What a tool's name may be: what every provider takes for one. */
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const DECLARED = ["name", "description", "parameters", "parallel", "ends"];

const IMAGES = new Set<string>(IMAGE_KINDS);

/**
 * The images a tool answered with, as its program's client sent them: each
 * its kind and its bytes in base64, and nothing else. (pi hands a model
 * whatever it is given by that name; what is no image is refused here.)
 */
export function imagesOf(given: unknown): ToolImage[] | undefined {
  if (given == null) return undefined;
  const isImage = (image: unknown) => isJsonObject(image) && Object.keys(image).length === 2
    && typeof image.mimeType === "string" && IMAGES.has(image.mimeType)
    && typeof image.data === "string" && image.data !== "" && /^[A-Za-z0-9+/]*={0,2}$/.test(image.data);
  if (!Array.isArray(given) || !given.every(isImage)) {
    throw new Error(`Invalid field: images (expected a list of images, each its mimeType — ${[...IMAGES].join(", ")} — and its data, in base64)`);
  }
  return given.length > 0 ? given.map(({ mimeType, data }) => ({ mimeType, data })) : undefined;
}

/**
 * A call's `tools` as its program wrote them: the agent's own by name, and
 * the program's, each read for what it declares. What is wrong with one is
 * thrown, in words for whoever wrote it.
 */
export function toolsOf(tools: unknown[]): { names: string[]; declared: DeclaredTool[] } {
  const names: string[] = [], declared: DeclaredTool[] = [];
  // A tool of the program's is nobody else's by its name: not another of the program's, and not one of the
  // agent's that the call names. (A name of the agent's said twice is the agent's tool twice named, which is
  // the backend's to read — as a list of names and nothing else is.)
  const own = new Set<string>();
  const take = (name: string) => {
    if (own.has(name) || names.includes(name)) throw new Error(`Two tools are named ${JSON.stringify(name)}: a tool is called by its name`);
    own.add(name);
  };
  for (const tool of tools) {
    if (typeof tool === "string") {
      if (own.has(tool)) throw new Error(`Two tools are named ${JSON.stringify(tool)}: a tool is called by its name`);
      names.push(tool);
      continue;
    }
    if (!isJsonObject(tool)) throw new Error(`A tool is a name, or an object with a name, a description and a run: not ${describeJson(tool)}`);
    const { name, description, parameters, parallel, ends } = tool;
    if (typeof name !== "string" || !NAME.test(name)) {
      throw new Error(`A tool's name is letters, digits, "_" and "-", 64 of them at most: not ${typeof name === "string" ? JSON.stringify(name) : describeJson(name)}`);
    }
    const unknown = Object.keys(tool).find(field => !DECLARED.includes(field));
    if (unknown !== undefined) throw new Error(`The tool ${JSON.stringify(name)} has a field a tool does not take: ${unknown} (a tool takes: ${DECLARED.join(", ")}, run)`);
    if (typeof description !== "string" || description.trim() === "") {
      throw new Error(`The tool ${JSON.stringify(name)} has no description: it is all a model is told of what the tool is for`);
    }
    for (const [option, value] of Object.entries({ parallel, ends })) {
      if (value != null && typeof value !== "boolean") throw new Error(`The tool ${JSON.stringify(name)}: ${option} is true or false, not ${describeJson(value)}`);
    }
    let called: ReturnType<typeof argumentsOf>;
    try {
      called = argumentsOf(parameters ?? {});
    } catch (err) {
      throw new Error(`The tool ${JSON.stringify(name)}: ${messageOf(err)}`);
    }
    take(name);
    declared.push({ name, description, parameters: called.schema, ...(parallel === true && { parallel }), ...(ends === true && { ends }), held: called.held });
  }
  return { names, declared };
}

/**
 * What a program is told while an agent call of its is under way: that a
 * tool of its is called — `key` is how it says what the tool answered — or
 * that one it is running is to go no further.
 */
export type ToolEvent = { key: string; name: string; args: unknown } | { stop: string };

/** Writes down that a tool was asked, and returns what writes down its answer. */
type Recorder = (id: string, name: string, args: unknown) => (answer: ToolAnswer) => void;

export interface ToolAsks {
  /**
   * Open the way for the tools of one agent call, under the id its program
   * gave it: the tools as the call's backend is to have them, each asking
   * the program — and what closes the way, when the call is over.
   */
  open(of: string, declared: DeclaredTool[], record: Recorder): { tools: OwnTool[]; close(): void };
  /**
   * The next thing the program is to hear of the tools of the call `of`.
   * Null where there is to be none: the call is over — or whoever asked is
   * gone (`gone`), and is told nothing.
   */
  next(of: string, gone: Promise<void>): Promise<ToolEvent | null>;
  /** What the program says a tool answered. (Of a use nobody waits for any more, it is said to nobody.) */
  answered(of: string, key: string, answer: ToolAnswer): void;
}

/** How many calls that are over are remembered as that. */
const MAX_CLOSED = 1024;

interface Way {
  /** What the program has not been told yet, and whoever of it is waiting to be told. */
  events: ToolEvent[];
  waiting: Array<(event: ToolEvent | null) => void>;
  /** The uses of a tool that are waiting for the program's answer, each by its key. */
  pending: Map<string, (answer: ToolAnswer | null) => void>;
  uses: number;
  closed: boolean;
}

/** The tools of one program's agent calls: how each is asked, and how the program comes to hear of it. */
export function createToolAsks(): ToolAsks {
  const ways = new Map<string, Way>();
  /**
   * The calls that are over, by their ids — the latest of them: whoever asks what is next of one is told
   * that nothing is, and is not taken for one who asks ahead of a call to come.
   */
  const closed = new Set<string>();
  /** Whoever asked of a call that is not here yet: it and the asking were sent together, and either may be first. */
  const early = new Map<string, Set<() => void>>();

  const tell = (way: Way, event: ToolEvent) => {
    const waiting = way.waiting.shift();
    if (waiting) waiting(event);
    else way.events.push(event);
  };

  return {
    open(of, declared, record) {
      if (of === "") throw new Error("Invalid field: toolsId (expected a non-empty string)");
      if (ways.has(of) || closed.has(of)) throw new Error(`Duplicate toolsId: ${of}`);
      const way: Way = { events: [], waiting: [], pending: new Map(), uses: 0, closed: false };
      ways.set(of, way);
      for (const wake of early.get(of) ?? []) wake();
      early.delete(of);

      const tools = declared.map(({ held, ...tool }): OwnTool => ({
        ...tool,
        run: (given, id, signal) => new Promise<ToolAnswer>((resolve) => {
          if (way.closed || signal?.aborted) return resolve(NOT_WAITED_FOR);
          // A backend holds a model's call to the tool's parameters before it asks; what asks here may be
          // somebody else's word of what a backend said (a process that serves the call, with other code in it).
          // The program is asked with what its tool declared, or not at all.
          let args: unknown;
          try {
            args = held(given);
          } catch (err) {
            return resolve({ text: `The tool ${JSON.stringify(tool.name)} was called with what its parameters do not allow: ${messageOf(err).replace(/^Schema validation failed: /, "")}`, failed: true });
          }
          const key = String(++way.uses);
          const answered = record(id, tool.name, args);
          let off = () => {};
          // (An answer the program gave is written down. One that was not waited for is no answer: such a use has none on record.)
          way.pending.set(key, (answer) => {
            way.pending.delete(key);
            off();
            if (answer) answered(answer);
            resolve(answer ?? NOT_WAITED_FOR);
          });
          off = onAbort(signal, () => {
            const waiting = way.pending.get(key);
            if (!waiting) return;
            waiting(null);
            tell(way, { stop: key });
          });
          tell(way, { key, name: tool.name, args });
        }),
      }));

      return {
        tools,
        close() {
          // (A use that is still waiting for the program is waited for by nobody: its call is over. It has
          // the answer of one that was not waited for, and none on record.)
          way.closed = true;
          ways.delete(of);
          if (closed.size >= MAX_CLOSED) closed.delete(closed.values().next().value!);
          closed.add(of);
          for (const settle of [...way.pending.values()]) settle(null);
          for (const waiting of way.waiting.splice(0)) waiting(null);
        },
      };
    },

    async next(of, gone) {
      if (closed.has(of)) return null;
      if (!ways.has(of)) {
        const opened = await new Promise<boolean>((resolve) => {
          const wake = () => resolve(true);
          const waiting = early.get(of) ?? new Set();
          early.set(of, waiting.add(wake));
          void gone.then(() => {
            if (waiting.delete(wake) && waiting.size === 0 && early.get(of) === waiting) early.delete(of);
            resolve(false);
          });
        });
        if (!opened) return null;
      }
      const way = ways.get(of);
      if (!way) return null;
      const told = way.events.shift();
      if (told) return told;
      return new Promise<ToolEvent | null>((resolve) => {
        way.waiting.push(resolve);
        void gone.then(() => {
          const at = way.waiting.indexOf(resolve);
          if (at === -1) return;
          way.waiting.splice(at, 1);
          resolve(null);
        });
      });
    },

    answered(of, key, answer) {
      ways.get(of)?.pending.get(key)?.(answer);
    },
  };
}
