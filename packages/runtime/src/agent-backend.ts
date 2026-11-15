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
  /** Cancels the call. A cancelled call rejects; it never resolves with a partial answer. */
  signal?: AbortSignal;
  /**
   * Told what the call used, at most once and before the call settles —
   * however it ended: a call that failed or was cancelled half-way has used
   * what it used. A backend that cannot know, or a call that used nothing,
   * says nothing. (It does not throw: what it is told is only written down.)
   */
  used?: (usage: AgentUsage) => void;
}

export interface AgentBackend {
  /**
   * Run one prompt to completion and return the agent's final text.
   *
   * Each call stands alone — nothing carries over from one to the next, and
   * everything a call depends on is in its arguments. A backend that cannot
   * honour something in `call` must reject, never silently ignore it.
   */
  ask(prompt: string, call: AgentCall): Promise<string>;
}
