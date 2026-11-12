// The one thing the runtime needs from whatever does the LLM work: hand it a
// prompt, get its final text back.
//
// Everything trama asks of an LLM goes through this — a program's agent calls,
// generating a program, repairing one. To a backend they are all the same
// request; what to ask for, and what to make of the reply, is decided by the
// caller. Nothing outside the backend's own file knows which agent, harness or
// model is behind it.

export interface AgentCall {
  /** The directory the agent works in: what its tools read is here, and what they write lands here. */
  cwd: string;
  /** Instructions for this call, on top of the agent's own. */
  system?: string;
  /** Cancels the call. A cancelled call rejects; it never resolves with a partial answer. */
  signal?: AbortSignal;
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

/**
 * Hold a piece of work to the promise above: reject as soon as `signal` is
 * aborted, whether or not the work itself notices. What the work goes on to do
 * after that is no longer waited for.
 */
export function rejectOnAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Aborted"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    const settle = <V>(pass: (value: V) => void) => (value: V) => {
      signal.removeEventListener("abort", onAbort);
      pass(value);
    };
    work.then(settle(resolve), settle(reject));
  });
}
