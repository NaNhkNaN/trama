// What a program's `agent` is to its runner: its calls, each made a request
// of the backend. (The program in a reply that was to be one: code-fences.ts.)

import type { AgentOptions, Schema } from "./types.js";
import { CutOff, type AgentBackend, type AgentCall, type ModelAsk, type OwnTool } from "./agent-backend.js";
import { conform, hasList, hasOptional, shapeOf } from "./schema.js";
import { isJsonObject } from "./serializable.js";

export { stripCodeFences } from "./code-fences.js";

/** Hears what a call used — each time its backend was asked: a `generate` that had to ask again is heard twice. */
type Used = AgentCall["used"];

/** How a call is served, as its runner has it: the agent's tools by name — the program's own are given beside (`ownTools`). */
type Served = Omit<AgentOptions, "tools"> & { tools?: string[] };

/**
 * The runner's side of a program's `agent`: its calls, and for each a place
 * to say what it used — and the tools of the program's that the agent has
 * for it, each a way to ask the program.
 */
export interface RunnerAgent {
  instruct(prompt: string, options?: Served, used?: Used, ownTools?: OwnTool[]): Promise<string>;
  generate<T>(input: Omit<Served, "templates"> & { prompt: string; schema: Schema }, used?: Used, ownTools?: OwnTool[]): Promise<T>;
  /** One request to the model, held to its shape already (see model-request.ts), and its one reply. */
  complete(request: ModelAsk, used?: Used): Promise<Record<string, unknown>>;
}

/** Of what a call may ask for, what it did ask for: a backend is not handed a thing nobody named. */
const asked = (options: Pick<AgentCall, "model" | "thinking" | "tools" | "ownTools" | "skills" | "templates" | "extensions" | "asText" | "used">) =>
  Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));

/**
 * The `agent` a program talks to: its calls, served by `backend` working in
 * `cwd` — or in `workspace`, the run's, where a call says so and the run has
 * one — and cancelled together through `signal`.
 */
export function createAgent(backend: AgentBackend, cwd: string, signal?: AbortSignal, workspace?: string): RunnerAgent {
  /** Where a call's agent works: in the project — or in the run's workspace, where the call says so. */
  const where = (inWorkspace: unknown): string => {
    if (inWorkspace === undefined || inWorkspace === false) return cwd;
    if (inWorkspace !== true) throw new Error(`workspace is true or false, not ${JSON.stringify(inWorkspace)}`);
    if (workspace === undefined) throw new Error("This run has no workspace for its agent to work in: one is there where a run is given one (trama run --workspace <dir>, or workspaceDir)");
    return workspace;
  };
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
    async instruct(prompt, options, used, ownTools) {
      const { system, model, thinking, tools, skills, templates, extensions, cutOff, workspace: inWorkspace } = options ?? {};
      return ask(prompt, { cwd: where(inWorkspace), system, signal, ...asked({ model, thinking, tools, ownTools, skills, templates, extensions, used }) }, cutOff);
    },

    complete: (request, used) => backend.complete(request, { signal, ...(used && { used }) }),

    async generate(input, used, ownTools) {
      if (!isJsonObject(input.schema)) throw new Error("Schema validation failed: a schema is an object of the fields the answer is to have");
      const shape = shapeOf(input.schema);
      const schemaInstruction = `Respond with ONLY a JSON object matching this shape:\n${
        JSON.stringify(input.schema, null, 2)
      }\n${
        hasList(shape) ? "Where the shape shows a list, it shows one item: answer with as many as there are, each of that shape.\n" : ""
      }${
        hasOptional(shape) ? 'A field whose name ends in "?" may be left out; where it is given, its name is without the "?".\n' : ""
      }No markdown. No explanation. Just the JSON.`;

      const fullPrompt = `${input.prompt}\n\n${schemaInstruction}`;
      const { system, model, thinking, tools, skills, extensions, cutOff, workspace: inWorkspace } = input;
      // The prompt of a typed answer is text, whatever it begins with: what says how to answer follows it, and a
      // skill called up by name, or a command, would take that for its own — and would not be there at a second asking.
      const asText = skills !== undefined || extensions !== undefined ? true : undefined;
      const call = { cwd: where(inWorkspace), system, signal, ...asked({ model, thinking, tools, ownTools, skills, extensions, asText, used }) };

      const parseAndValidate = (response: string): Record<string, unknown> => {
        const trimmed = response.trim();
        // Try raw parse first — avoids mangling valid JSON that contains
        // fenced code blocks inside string values.
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          // Fenced: what stands between the first fence and the last — an answer may hold fences of its own,
          // in what it says — or, where that is not JSON (more blocks than one), what the first block holds.
          const whole = trimmed.match(/```(?:json)?\s*\n?([\s\S]*)\n?\s*```/);
          try {
            if (!whole) throw new SyntaxError("not fenced");
            parsed = JSON.parse(whole[1].trim());
          } catch {
            const first = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
            parsed = JSON.parse(first ? first[1].trim() : trimmed);
          }
        }
        return conform(parsed, shape) as Record<string, unknown>;
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
