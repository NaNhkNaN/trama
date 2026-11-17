// The one thing the runtime needs from whatever does the LLM work: hand it a
// prompt, get its final text back — and hear what that took.
//
// Everything trama asks of an LLM goes through this — a program's agent calls,
// generating a program, repairing one. To a backend they are all the same
// request; what to ask for, and what to make of the reply, is decided by the
// caller. Nothing outside the backend's own file knows which agent, harness or
// model is behind it.

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

/** Of a report, what a report is declared to hold — whatever else a backend put beside it. */
export const declaredUsage = ({ model, input, output, cacheRead, cacheWrite, cost }: AgentUsage): AgentUsage =>
  ({ model, input, output, cacheRead, cacheWrite, cost });

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
   * The skills the agent has for this call, of those the backend finds for
   * the user and where it works: all of them, or the ones named. Without it,
   * or with `false` or none named: none.
   */
  skills?: boolean | string[];
  /** The same of prompt templates: with one, a prompt that begins with its name is the template, filled in. */
  templates?: boolean | string[];
  /** Whether the agent has the user's own extensions of it: code of the user's that the backend runs. */
  extensions?: boolean;
  /**
   * The prompt is text and nothing else: it goes to the model as written,
   * and is not read for what it begins with — a skill called up by name, a
   * command of an extension — though the call has skills or extensions.
   */
  asText?: boolean;
  /** Cancels the call. A cancelled call rejects; it never resolves with a partial answer. */
  signal?: AbortSignal;
  /**
   * Told what the call has used so far, each time its agent is about to ask
   * the model again — for the next step of its work, or to have a long
   * conversation summed up: whoever hears it may cancel the call there,
   * before more is used. A backend that asks its model once, or cannot say,
   * never calls it. (It does not throw.)
   */
  sofar?: (usage: AgentUsage) => void;
  /**
   * Told what the call used, at most once and before the call settles —
   * however it ended: a call that failed or was cancelled half-way has used
   * what it used. A backend that cannot know, or a call that used nothing,
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
