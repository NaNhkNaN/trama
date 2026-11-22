// What a run may use of a model, and the count of what it has.
//
// A budget is kept by the runner, where every question a run puts to a model
// passes (see createBackend): its program's agent calls, the requests for a
// fix, and — counted in the budget of each run above it too — all that the
// runs it asks for put to theirs. Nothing a program is given raises it.
// It is a guard and no wall: a program is not confined, and one that set out
// to could find other ways to a model.

import type { AgentUsage } from "./agent-backend.js";
import { describeJson, isJsonObject } from "./serializable.js";

/** A cap on what is asked of a model. What is not named is not capped. */
export interface Budget {
  /** US dollars, as the backend's price list counts what was used. */
  cost?: number;
  /** Tokens: all the model read and wrote, from a cache or not. */
  tokens?: number;
  /**
   * How many calls to a model's agent may be taken on: an agent call is one,
   * a `generate` that had to ask again two, a request for a fix one. (A call
   * counts when it is taken on, whatever then becomes of it.)
   */
  calls?: number;
}

const CAPS = ["cost", "tokens", "calls"] as const;

/** A value as it is said back to whoever gave it. */
function shown(value: unknown): string {
  try {
    return typeof value === "number" ? String(value) : JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * A budget as it was given — in a config, to a run, over the bridge — held to
 * what one is: a plain object of caps, each a number that is not negative,
 * and `calls` a whole one. Returns a copy. Throws with what is wrong, as said
 * of `what` it was given as.
 */
export function checkedBudget(given: unknown, what = "budget"): Budget {
  // (A plain object: what holds its caps some other way — a Map, an object that has them from another — would be read as holding none.)
  if (!isJsonObject(given) || ![Object.prototype, null].includes(Object.getPrototypeOf(given))) {
    throw new Error(`${what} is an object of caps (${CAPS.join(", ")}): got ${isJsonObject(given) ? "an object that is not a plain one" : describeJson(given)}`);
  }
  const budget: Budget = {};
  for (const [name, cap] of Object.entries(given)) {
    if (!(CAPS as readonly string[]).includes(name)) throw new Error(`${what} has no cap "${name}": its caps are ${CAPS.join(", ")}`);
    // (One given as undefined, or as null where it came as JSON, is one not given.)
    if (cap == null) continue;
    if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 0 || (name === "calls" && !Number.isInteger(cap))) {
      throw new Error(`${what}.${name} must be ${name === "calls" ? "a whole number" : "a number"} that is not negative (got ${shown(cap)})`);
    }
    budget[name as keyof Budget] = cap;
  }
  return budget;
}

/** More than this no one call has used of anything: what a report says beyond it is counted as this. */
const MOST = 1e15;

/**
 * A count as it can be added up: what a backend did not say, or said as no
 * number or as less than nothing, is nothing — it is not for a count to fail
 * a call, nor for a report to make room — and what it said as more than any
 * call uses is as much as a call can use: a sum that numbers cannot hold is
 * no sum, and no cap would be reached by it again.
 */
const counted = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(value, MOST) : 0);

/** All the tokens of a report: read and written, from a cache or not. */
const tokensOf = (usage: AgentUsage | undefined): number =>
  counted(usage?.input) + counted(usage?.output) + counted(usage?.cacheRead) + counted(usage?.cacheWrite);

/**
 * How near a cap on cost counts as reached. A cost is a sum of fractions, and
 * ten tenths of a dollar do not add up to one: a billionth of a dollar short
 * is there.
 */
const NEAR = 1e-9;

/** What is counted of one call to a backend, while it lasts. */
export interface Account {
  /**
   * What the call has used by now, in all. Returns why the call is to go no
   * further — a budget it counts in has been reached — or nothing.
   */
  sofar(usage: AgentUsage): string | undefined;
  /** The call is over: what it used is what was last said of it, and what is said of it from here on is counted nowhere. */
  close(): void;
}

export interface Meter {
  /** The caps it holds a run to, as they were given. */
  readonly limit: Budget;
  /** Whether it holds what it counts to anything: a cap of its own, or of a meter above. */
  capped(): boolean;
  /** Why nothing more may be asked of a model under it — or nothing, while something may. */
  spent(): string | undefined;
  /** Take on a call to a backend. Throws, with why, where nothing more may be asked. */
  admit(): Account;
  /** Why what is under way is to go no further: a cap on what calls use has been reached, here or above. */
  reached(): string | undefined;
  /** Add to the count, here and above: calls taken on, and what calls used — more than was said of them before, or less. */
  count(calls: number, cost: number, tokens: number): void;
  /** What it has counted so far: the calls taken on, and what they have said they used. */
  counted(): { calls: number; cost: number; tokens: number };
}

/**
 * The count of what a run uses, held to `limit`. What it counts is counted
 * under `above` too — the meter of the run that asked for this one — and is
 * refused where that has no room: a run cannot use what the run it is part of
 * may not.
 */
export function createMeter(limit: Budget = {}, above?: Meter): Meter {
  // What the calls taken on have used, as far as each has said, and how many they are.
  let cost = 0, tokens = 0, calls = 0;

  /** A cap on what calls use that has been reached. */
  const used = (): string | undefined => {
    if (limit.cost !== undefined && cost + NEAR >= limit.cost) return `$${cost.toFixed(4)} used of $${limit.cost}`;
    if (limit.tokens !== undefined && tokens >= limit.tokens) return `${tokens} tokens used of ${limit.tokens}`;
    return undefined;
  };
  /** ...or the cap on how many are made: that stops none that is under way, and admits no more. */
  const made = (): string | undefined =>
    limit.calls !== undefined && calls >= limit.calls ? `${calls} of ${limit.calls} calls to a model made` : undefined;
  const said = (why: string | undefined, inherited: string | undefined): string | undefined =>
    why !== undefined ? `The budget is spent: ${why}.`
      : inherited?.replace(/^The budget is/, "The budget of a run this one is part of is");

  const meter: Meter = {
    limit,
    capped: () => Object.keys(limit).length > 0 || above?.capped() === true,
    spent: () => said(used() ?? made(), above?.spent()),
    reached: () => said(used(), above?.reached()),
    count(more, dollars, read) {
      calls += more;
      cost += dollars;
      tokens += read;
      above?.count(more, dollars, read);
    },
    counted: () => ({ calls, cost, tokens }),
    admit() {
      const refusal = meter.spent();
      if (refusal !== undefined) throw new Error(refusal);
      meter.count(1, 0, 0);
      // What the call has said it used, in all: each word of it replaces the last.
      let had = { cost: 0, tokens: 0 }, over = false;
      return {
        sofar(usage) {
          if (!over) {
            const now = { cost: counted(usage?.cost), tokens: tokensOf(usage) };
            meter.count(0, now.cost - had.cost, now.tokens - had.tokens);
            had = now;
          }
          return meter.reached();
        },
        close() {
          over = true;
        },
      };
    },
  };
  return meter;
}
