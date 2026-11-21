// The backend as a runner holds it: the one place that picks what does the
// LLM work, and where every call of a run is counted and held to its budget.

import { onAbort, rejectOnAbort } from "./abort.js";
import type { AgentBackend } from "./agent-backend.js";
import { createMeter, type Meter } from "./budget.js";
import { PiAdapter } from "./pi-adapter.js";
import type { TramaConfig } from "./runner-types.js";
import { KILL_GRACE_MS } from "./stopping.js";
import { messageOf } from "./errors.js";

/**
 * What does the LLM work for a project. The only place that picks a backend:
 * everything else is handed one and does not know which it is.
 *
 * It is also where what is asked of a model is counted, and held to a
 * budget (`meter`): every call passes here, whoever makes it. A call that
 * comes when the budget is spent is refused; one under way is stopped where
 * its agent would ask the model again — what the model was asked before
 * that is used, and what it was answering is let finish. `spent` is told
 * why, the first time either happens.
 */
export function createBackend(config: TramaConfig, meter: Meter = createMeter(), spent: (why: string) => void = () => {}, env?: Record<string, string>): Backend {
  // (`env`: the variables of the run whose calls these are — its agents' too, as they are its program's and its commands'.)
  const backend = new PiAdapter(config, env);
  // The calls that were cancelled.
  const cutOff = new Set<Promise<unknown>>();
  // Why a call was first refused, or stopped, for the budget.
  let refused: string | undefined;
  const overBudget = (why: string): Error => {
    if (refused === undefined) spent(why);
    refused ??= why;
    return new Error(why);
  };
  return {
    spent: () => meter.spent(),
    refused: () => refused,
    counts: () => meter.capped(),
    // The interface promises that a cancelled call rejects, and a run's end
    // waits on that. Every backend is held to it here, rather than trusted with it.
    async ask(prompt, call) {
      let account: ReturnType<Meter["admit"]>;
      try {
        account = meter.admit();
      } catch (err) {
        throw overBudget(messageOf(err));
      }
      // Stops the call where the budget is reached while it is under way.
      const over = new AbortController();
      let why: string | undefined;
      const signal = call.signal ? AbortSignal.any([call.signal, over.signal]) : over.signal;
      const work = backend.ask(prompt, {
        ...call,
        signal,
        sofar(usage, answered) {
          const reached = account.sofar(usage);
          call.sofar?.(usage, answered);
          // A call that is over keeps what it ended with — its answer, or its own failure: what would be
          // asked beside it is not asked, and that is all. (It is a request refused for the budget all the
          // same, and said as one.)
          if (answered) {
            const spent = why ?? reached;
            if (spent === undefined) return true;
            overBudget(spent);
            return false;
          }
          // (Once it is to stop, it is to stop — whatever is said of it after.)
          why ??= reached;
          if (why === undefined) return true;
          over.abort();
          return false;
        },
        // (What the call has used is counted from when it is known: nothing is stopped for it here — a reply that
        // has come is not taken back — but whatever is asked next, by this call or another, is asked against it.)
        had(usage) {
          account.sofar(usage);
          call.had?.(usage);
        },
        used(usage) {
          account.sofar(usage);
          call.used?.(usage);
        },
      });
      const off = onAbort(signal, () => { cutOff.add(work); });
      // What the call used is counted as its own until the backend has let go of it — which
      // is when it has said the last of it — however long ago whoever asked was answered.
      const settled = () => {
        off();
        account.close();
        // (Let go of: nobody need wait for it any more.)
        cutOff.delete(work);
      };
      work.then(settled, settled);
      try {
        return await rejectOnAbort(work, signal);
      } catch (err) {
        // (Stopped by whoever asked, it was stopped by them, whatever the budget had come to.)
        throw why !== undefined && !call.signal?.aborted ? overBudget(why) : err;
      }
    },
    close: () => backend.close(),
    async letGo() {
      let giveUp: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(cutOff),
        new Promise(resolve => { giveUp = setTimeout(resolve, KILL_GRACE_MS); }),
      ]);
      clearTimeout(giveUp);
    },
  };
}

/** The budgets of which it has been said that they are spent. */
const saidSpent = new WeakSet<Meter>();

/**
 * Say that a budget is spent, once for the budget — whoever comes up against
 * it first: the run's own backend, or the backend of a project being made
 * for the run's program, of which there may be many.
 */
export const saysOnce = (meter: Meter, say: (why: string) => void) => (why: string): void => {
  if (saidSpent.has(meter)) return;
  saidSpent.add(meter);
  say(why);
};

/** A backend as the runner holds it: one whose cancelled calls are answered at once, and can be waited for apart. */
export interface Backend extends AgentBackend {
  /** Why nothing more may be asked of it — the budget it counts in is spent — or nothing, while something may. */
  spent(): string | undefined;
  /** Why a call of it was first refused or stopped for the budget, if one was — whatever the count has come to since. */
  refused(): string | undefined;
  /** Whether what its calls use is held to anything: then what a call it cut off used is to be waited for, recorded or not. */
  counts(): boolean;
  /**
   * End what the backend kept to serve calls with — a process of its own for
   * those that have extensions. Whatever it served is over: a run, a
   * validation. (Asked again after this, it starts anew.)
   */
  close(): Promise<void>;
  /**
   * Resolves when the backend has let go of the calls that were cancelled so
   * far: whoever cancelled one went on at once, and the backend still had to
   * stop what it was doing, and to say what the call had used. They are
   * waited for no longer than anything asked to stop is.
   */
  letGo(): Promise<void>;
}
