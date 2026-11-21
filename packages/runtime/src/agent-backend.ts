// The one thing the runtime needs from whatever does the LLM work: hand it a
// prompt, get its final text back — and hear what that took.
//
// Everything trama asks of an LLM goes through this — a program's agent calls,
// generating a program, repairing one. To a backend they are all the same
// request; what to ask for, and what to make of the reply, is decided by the
// caller. Nothing outside the backend's own file knows which agent, harness or
// model is behind it.

import type { ModelRelay } from "./model-relay.js";

/**
 * What a call used, as far as its backend knows: the tokens the model read and
 * wrote, the ones it read from a cache and wrote to one, and what the backend's
 * price list makes of that in US dollars.
 */
export interface AgentUsage {
  /** The model that served the call, as the backend names it. */
  model?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** What replies used, added up as they came — by whoever saw them come. */
export interface Tally {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export const nothingYet = (): Tally => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

/** Add to a tally what one reply used, as a model's reply says it. */
export function addReply(tally: Tally, used: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } }): void {
  tally.input += used.input;
  tally.output += used.output;
  tally.cacheRead += used.cacheRead;
  tally.cacheWrite += used.cacheWrite;
  tally.cost += used.cost.total;
}

/**
 * A count, and what was seen besides: of each figure, the greater. Two
 * counts of one call, made at two places, are each a count of what passed
 * there — and what passed at both is most of it. (Where each saw something
 * the other did not, this is still short of the whole: it is the least the
 * call used, which is what a count that may be short is to be.) Nothing,
 * where no tokens were counted at either.
 */
export function atLeast(usage: AgentUsage | undefined, seen?: Tally): AgentUsage | undefined {
  const most = (figure: keyof Tally) => Math.max(usage?.[figure] ?? 0, seen?.[figure] ?? 0);
  const input = most("input"), output = most("output"), cacheRead = most("cacheRead"), cacheWrite = most("cacheWrite");
  if (input + output + cacheRead + cacheWrite === 0) return undefined;
  return { ...(usage?.model !== undefined && { model: usage.model }), input, output, cacheRead, cacheWrite, cost: most("cost") };
}

/** Of a report, what a report is declared to hold — whatever else a backend put beside it. */
export const declaredUsage = ({ model, input, output, cacheRead, cacheWrite, cost }: AgentUsage): AgentUsage =>
  ({ model, input, output, cacheRead, cacheWrite, cost });

/** An image, as it is handed about: what kind it is, and its bytes in base64. */
export interface ToolImage {
  mimeType: string;
  data: string;
}

/**
 * What a tool that was asked says: what the model is to read — and to be
 * shown, where the tool has images for it — and whether that is how it failed.
 */
export interface ToolAnswer {
  text: string;
  images?: ToolImage[];
  failed?: boolean;
}

/**
 * A tool that is not the backend's: whoever makes the call has it, and is
 * asked by `run` each time the model calls it.
 */
export interface OwnTool {
  /** As the model calls it. Nobody else's name: not a tool of the backend's, nor of anything the backend loads. */
  name: string;
  /** What it is for, as the model is told. */
  description: string;
  /** What it is called with: the JSON Schema of an object. A backend holds a call's arguments to it before it asks. */
  parameters: Record<string, unknown>;
  /** It may be run while another tool is. Without it, of the tools a model calls in one reply, one is run after the other. */
  parallel?: boolean;
  /**
   * What it answers, where it does not fail, is the end of the agent's work
   * and the answer of the call: the model is not asked again. (Unless the
   * model called, in the same reply, a tool that does not end it.)
   */
  ends?: boolean;
  /**
   * Have it run: `id` is the model's call of it. It does not reject — a
   * tool's failure is an answer, for the model to read — and where `signal`
   * says the call is to go no further it is not waited for.
   */
  run(args: unknown, id: string, signal?: AbortSignal): Promise<ToolAnswer>;
}

export interface AgentCall {
  /** The directory the agent works in: what its tools read is here, and what they write lands here. */
  cwd: string;
  /** Instructions for this call, on top of the agent's own. */
  system?: string;
  /** The model that is to serve this call, as the backend names its models — in place of the one it would use. */
  model?: string;
  /** How much the model is to think, as the backend names its levels. */
  thinking?: string;
  /** The agent's tools for this call, by name: these and no others. Without it, the agent's own choice. */
  tools?: string[];
  /**
   * Tools of the caller's own, which the agent has beside those: each to be
   * the agent's as it is written, or the call rejects — a name that is
   * another tool's is not taken over, and not passed over.
   */
  ownTools?: OwnTool[];
  /**
   * The skills the agent has for this call, of those the backend finds for
   * the user and where it works: all of them, or the ones named. Without it,
   * or with `false` or none named: none.
   */
  skills?: boolean | string[];
  /** The same of prompt templates: with one, a prompt that begins with its name is the template, filled in. */
  templates?: boolean | string[];
  /**
   * Whether the agent has the user's own extensions of it — or, with
   * "project", those of where it works as well: somebody's code, which the
   * backend runs.
   */
  extensions?: boolean | "project";
  /**
   * The prompt is text and nothing else: it goes to the model as written,
   * and is not read for what it begins with — a skill called up by name, a
   * command of an extension — though the call has skills or extensions.
   */
  asText?: boolean;
  /** Cancels the call. A cancelled call rejects; it never resolves with a partial answer. */
  signal?: AbortSignal;
  /**
   * Told what the call has used so far, each time its model is about to be
   * asked again — for the next step of the agent's work, to have a long
   * conversation summed up, or for anything else that is asked of a model on
   * the call's account: whoever hears it may cancel the call there, before
   * more is used. A backend that asks its model once, or cannot say, never
   * calls it. (It does not throw.) Whoever hears it may take a moment over
   * it — it is in another process, say — and return a promise: a backend
   * that can wait for that before it asks its model does.
   *
   * `answered`: the call is over by now — it has its answer, or has
   * failed — and what would be asked is asked beside that: by an
   * extension, as it is told that the session is over. Such a call is not
   * to be cancelled for what it has used: what it ended with stands.
   * Whoever hears says `false` instead (or resolves to it), and the model
   * is then not asked.
   */
  sofar?: (usage: AgentUsage, answered?: boolean) => unknown;
  /**
   * Told what the call has used as soon as a reply of its model's has come.
   * Nothing waits for it, and nothing is cancelled by it: it is for whoever
   * counts — what the call has used is known to them from then, and not
   * only when the call next asks or is over — and for whoever may lose the
   * call before it says what it used in the end: the runner of a process
   * that serves it, which may have to end that process.
   */
  had?: (usage: AgentUsage) => void;
  /**
   * Somebody to ask the model by, for a call that is served where code runs
   * that is neither trama's nor the backend's — an extension's, in a process
   * of its own: what a reply used is then read where no such code is. A
   * backend asks by it where it can, and by itself where it cannot.
   */
  relay?: ModelRelay;
  /**
   * Told what the call used, at most once and before the call settles —
   * however it ended: a call that failed or was cancelled half-way has used
   * what it used. (When all is over that could use anything on the call's
   * account: what an extension asks a model as it is told that the session
   * ends is the call's too.) A backend that cannot know, or a call that used nothing,
   * says nothing. (It does not throw: what it is told is only written down.)
   */
  used?: (usage: AgentUsage) => void;
}

/**
 * A reply that ended at the model's output limit, and not where the model
 * would have ended it. It is not the answer — the call fails with this —
 * and it carries what there was of the reply, for a caller that has a use
 * for that. (The agent goes no further than the reply that was cut off: where
 * that reply was leading up to something still to be done, it was not done.)
 */
export class CutOff extends Error {
  constructor(readonly text: string) {
    super("The model's answer was cut off at its output limit.");
  }
}

export interface AgentBackend {
  /**
   * Run one prompt to completion and return the agent's final text. A final
   * reply that was cut off at the output limit is a rejection, with `CutOff`.
   *
   * Each call stands alone — nothing carries over from one to the next, and
   * everything a call depends on is in its arguments. A backend that cannot
   * honour something in `call` must reject, never silently ignore it.
   */
  ask(prompt: string, call: AgentCall): Promise<string>;
}
