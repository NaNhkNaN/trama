// Asking a model for a session that is in another process.
//
// A call that has extensions is served by pi in a process of its own (see
// agent-host.ts), and what an extension is free to do there it can do to what
// that process says of itself: what the call used, among it. So where it can
// be, the model is asked by a process no extension is in — the runner, or a
// process of the runner's that was started with the variables of the run —
// and the session is handed the reply as it comes. What the reply used is
// then read where it was asked for, and is nobody's word.
//
// Where it can be: the model has to be the same to both, and the request one
// that is made of plain data. A session whose model the other side has not
// got as the session has it, or whose request an extension has a hand in,
// asks its model itself, as it always did — and what it used is what its
// process says. This is not a wall: pi does not hold an extension to it.
//
// A model: one that is asked for a reply as pi's agent asks, or by its
// provider's own options (which is how an extension asks that would have the
// whole answer: pi's `complete`), one that makes images, one that classifies.
//
// Three things are here: the one that asks (createModelRelay), and the two
// ends of a channel between it and a session (relayClient, relayServer).

import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";
import { pathToFileURL } from "url";
import { onAbort } from "./abort.js";
import { messageOf } from "./errors.js";

const loadPi = () => import("@earendil-works/pi-coding-agent");

/** A model as pi has it in its catalog: plain data. */
export type RelayModel = { provider: string; id: string; api?: string } & Record<string, unknown>;

/**
 * The ways pi has of asking a model, that a relay asks by: for a reply, as
 * pi's agent asks (by options that are any provider's) or by the options of
 * the model's own provider; for images; for what a classifier makes of a
 * state. Each is a method of pi's models by that name.
 */
export type RelayWay = "streamSimple" | "stream" | "generateImages" | "classify";

/** Of each way: the type of model it asks, as pi's catalog has them — and whether what comes of it comes as the events of a reply (and not all at once). */
const WAYS = new Map<unknown, { of: "chat" | "image" | "classifier"; events: boolean }>([
  ["streamSimple", { of: "chat", events: true }],
  ["stream", { of: "chat", events: true }],
  ["generateImages", { of: "image", events: false }],
  ["classify", { of: "classifier", events: false }],
]);

/** A request of a model: plain data, all of it. */
export interface RelayRequest {
  /** The way the model is asked: as pi's agent asks, where it is not said. */
  by?: RelayWay;
  /** The model, as the session that asks has it. */
  model: RelayModel;
  /** What the model is to be sent: as pi hands it to a provider. */
  context: unknown;
  /** The options of the request that are data (see `dataOf`). */
  options: Record<string, unknown>;
  /** Whether it is asked beside a call that is over — one that has its answer, or has failed (see AgentCall.sofar). */
  answered?: true;
}

/**
 * An event of a reply, as pi's stream of it has them. The last is of type
 * "done" or "error", and has the reply whole. What comes all at once —
 * images, a classifier's answers — comes as a reply of one event, "done",
 * with it as its `message`: so that it is counted, and waited for, as any
 * reply is (see `wholeOf`).
 */
export type RelayEvent = { type: string } & Record<string, unknown>;

export interface ModelRelay {
  /**
   * Ask the model. Resolves to the events of the reply, to the last — or to
   * undefined where the model is not one this relay can ask as the session
   * that asks would: that session then asks it itself. It does not reject.
   */
  ask(request: RelayRequest, signal?: AbortSignal): Promise<AsyncIterable<RelayEvent> | undefined>;
}

/**
 * Whether a value is data: what it is on the other side of a channel is what
 * it is here. Text, numbers that are numbers, yes and no, nothing; and lists
 * and plain records of those. Not a function, nor anything that is of a kind
 * of its own (a date, a signal, bytes; a list or a record that is more than
 * one), nor what holds itself, nor what says of itself something other than
 * it shows. (What a record has by a symbol, or has and does not show, is no
 * part of it on any channel, and a provider is sent none of it either: pi's
 * schemas have such.)
 */
export function isData(value: unknown, within: Set<object> = new Set()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || within.has(value)) return false;
  // (A list or a record, and of no kind of its own: nor one that would be said otherwise than it shows.)
  const kind: unknown = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? kind !== Array.prototype : kind !== Object.prototype && kind !== null) return false;
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") return false;
  within.add(value);
  try {
    // (A place of a list that has nothing is something else on the other side; a name of a record that has nothing is no
    // name there. A list is gone through place by place, as a channel goes through it — not as it would have itself gone through.)
    if (Array.isArray(value)) return Array.from({ length: value.length }, (_, at) => value[at] as unknown).every(one => isData(one, within));
    return Object.values(value).every(one => one === undefined || isData(one, within));
  } finally {
    within.delete(value);
  }
}

/**
 * The options a session asks with, as those that go with a relayed request —
 * or undefined where one is there that cannot go, and would be missed.
 *
 * What goes is whatever is data, by whatever name: a provider's own options
 * are its own, and are not known here by name. What cannot go: a key of the
 * asker's own, a way of its own to reach the provider, a span to report to,
 * a reply that is to be fetched later (it is fetched where it was asked
 * for) — and anything else that is not data: a provider may read whatever
 * it is given, and what goes with a request is its asker's to mean something
 * by. (What whoever hands a request over knows to be nothing a provider is
 * handed, they leave out first: see `account`, pi-adapter.ts.) The word to
 * stop by is no option here: it goes beside the request.
 */
export function dataOf(options: Record<string, unknown> = {}): Record<string, unknown> | undefined {
  if (["apiKey", "fetch", "telemetry", "deferred"].some(key => options[key] !== undefined)) return undefined;
  const data = Object.entries(options).filter(([key]) => key !== "signal");
  if (data.some(([, value]) => value !== undefined && !isData(value))) return undefined;
  // (Each under its own name, whatever the name: none of them is taken for anything else.)
  return Object.fromEntries(data);
}

/**
 * Data as it goes on a channel, where a record in it has nothing under a
 * name. A channel carries no such name — and to have nothing under a name is
 * not to be without it, where records are laid one over another, name by
 * name and in the order of their names (as pi lays a request's headers, and
 * what a model is sampled by, over the model's own). So a word is put under
 * each such name, that is nothing else: said beside the data (`mark`), and
 * taken out again where the data is had (`unmarked`). The name then stands
 * where it stood, with nothing under it.
 */
export function marked<T>(data: T): { data: T; mark?: string } {
  const mark = `nothing:${randomUUID()}`;
  let found = false;
  const copy = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(copy);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([name, one]) => {
      if (one !== undefined) return [name, copy(one)];
      found = true;
      return [name, mark];
    }));
  };
  const made = copy(data) as T;
  // (A copy either way: what goes on the channel is what the data shows, name by name, whatever else it has.)
  return found ? { data: made, mark } : { data: made };
}

/** Data that came by a channel (see `marked`), with nothing under the names of its records that the mark is under. (In a list the mark is a word like any: nothing is ever marked there.) */
export function unmarked<T>(data: T, mark: unknown): T {
  if (typeof mark !== "string" || mark === "") return data;
  const clear = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    for (const [name, one] of Object.entries(value)) {
      if (one === mark && !Array.isArray(value)) (value as Record<string, unknown>)[name] = undefined;
      else clear(one);
    }
  };
  clear(data);
  return data;
}

/**
 * What came of asking a model, of a reply that is gone through to its end:
 * the reply whole — or, of a request that failed before it was one, its
 * failure thrown (as pi's own `generateImages` and `classify` have what a
 * provider throws, and make of it what they give back).
 */
export async function wholeOf(reply: AsyncIterable<RelayEvent>): Promise<unknown> {
  let last: RelayEvent | undefined;
  for await (const event of reply) last = event;
  if (last?.type === "done") return last.message;
  throw new Error(String((last?.error as { errorMessage?: unknown } | undefined)?.errorMessage ?? "The model was not asked."));
}

/** What a reply used, as pi has it on the reply. */
export interface ReplyUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}

/** What the reply an event is the last of used — undefined of any other event. */
export function usageAtEnd(event: RelayEvent): ReplyUsage | undefined {
  const reply = event.type === "done" ? event.message : event.type === "error" ? event.error : undefined;
  return (reply as { usage?: ReplyUsage } | undefined)?.usage;
}

/**
 * The event that ends a reply the model was not asked for: as pi makes the
 * reply of a request that was cancelled before it was sent. (Said as one that
 * was cancelled, whyever it was: pi reads the words of a reply that failed —
 * for a number that looks like a server's, to try again; for a limit, to sum
 * the conversation up — and a request that is not to be made is neither.)
 */
export function notAsked(model: RelayModel, why: string, as: "aborted" | "error" = "aborted"): RelayEvent {
  return {
    type: "error",
    reason: as,
    error: {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: as, errorMessage: why, timestamp: Date.now(),
    },
  };
}

// --- An event without the reply so far, and with it again ---

// Every event of a reply but the last carries `partial`: the whole reply so
// far. Sent as they are, a reply's events grow with the square of its length.
// And `partial` is one object that pi goes on changing: read a moment late,
// it holds what later events bring. So an event is sent with what it adds —
// text and thinking as their delta, anything else as the one block it is of
// (see `leaner`) — and the reply so far is put together again where it is
// wanted.

const wordsOf = (type: string): "text" | "thinking" | undefined =>
  type.startsWith("text_") ? "text" : type.startsWith("thinking_") ? "thinking" : undefined;

/** How much of a tool call's arguments is sent whole with every piece of them, before it is sent whole only as it grows by half again. */
const SMALL = 8 * 1024;

/**
 * Makes of a reply's events the events as they are sent: without the reply
 * so far. (One for each reply: it keeps how much of each tool call has been
 * sent.) What an event adds is sent with it — but a tool call's arguments,
 * which pi puts together from their pieces in its own way for each kind of
 * provider, can only be sent whole: so they are, with every piece while they
 * are short, and after that each time they have grown by half — and whole at
 * their end. Whoever is shown a long tool call as it comes is shown its
 * arguments as they were a little while before.
 */
export function leaner(): (event: RelayEvent) => RelayEvent {
  const grown = new Map<number, number>(), sent = new Map<number, number>();
  return (event) => {
    if (event.type === "done" || event.type === "error") return event;
    const { partial, ...rest } = event as RelayEvent & { partial: { content: Record<string, unknown>[] } & Record<string, unknown>; contentIndex: number; delta?: unknown };
    const { content, ...top } = partial;
    if (event.type === "start") return { ...rest, top };
    const at = rest.contentIndex, kind = wordsOf(event.type);
    if (!kind) {
      const now = (grown.get(at) ?? 0) + (typeof rest.delta === "string" ? rest.delta.length : 0);
      grown.set(at, now);
      const whole = !event.type.endsWith("_delta") || now <= SMALL || now >= (sent.get(at) ?? 0) * 1.5;
      if (!whole) return { ...rest, top };
      sent.set(at, now);
      return { ...rest, top, block: content[at] };
    }
    if (event.type.endsWith("_delta")) return { ...rest, top };
    // (Its beginning and its end: the block without its words, which are had from the deltas, or from `content`.)
    const { [kind]: _words, ...around } = content[at] ?? {};
    return { ...rest, top, around };
  };
}

/** The reply so far, kept where events that were sent without it are given it again. */
export interface SoFar {
  partial?: { content: Record<string, unknown>[] } & Record<string, unknown>;
}

/** An event that was sent without the reply so far (see `leaner`), with it. */
export function whole(event: RelayEvent, state: SoFar): RelayEvent {
  if (event.type === "done" || event.type === "error") return event;
  const { top, block, around, ...rest } = event as RelayEvent & { top?: Record<string, unknown>; block?: Record<string, unknown>; around?: Record<string, unknown>; contentIndex: number; delta?: string; content?: string };
  const partial = state.partial = { ...state.partial, ...top, content: [...(state.partial?.content ?? [])] };
  if (event.type === "start") return { ...rest, partial };
  const at = rest.contentIndex, was = partial.content[at] ?? {};
  const kind = wordsOf(event.type);
  if (!kind) partial.content[at] = block ?? was;
  else if (event.type.endsWith("_start")) partial.content[at] = { ...around, [kind]: "" };
  else if (event.type.endsWith("_delta")) partial.content[at] = { ...was, [kind]: String(was[kind] ?? "") + String(rest.delta ?? "") };
  else partial.content[at] = { ...was, ...around, [kind]: rest.content };
  return { ...rest, partial };
}

// --- The one that asks ---

/**
 * Where pi's own pi-ai keeps what it exports by a name: looked for where pi
 * would look for the package (beside it, then in each `node_modules` above),
 * and read from what the package says it exports to an `import`. Not by
 * `require.resolve`: pi-ai is a package to be imported and nothing else, and
 * asked for as one to be required it is not found — which is how nothing was
 * let go of, with no word of it, in 0.6.0 and 0.6.1.
 */
function inPisAi(name: string): string {
  const lookedIn = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve.paths("@earendil-works/pi-ai") ?? [];
  for (const dir of lookedIn) {
    const root = join(dir, "@earendil-works", "pi-ai");
    let exported: unknown;
    try {
      exported = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).exports?.[name]?.import;
    } catch {
      continue; // not here: pi's is further up
    }
    if (typeof exported === "string") return join(root, exported);
    break;
  }
  throw new Error(`pi-ai exports no ${name}`);
}

/** What pi keeps for a session where its model is asked, let go of. (pi's own, had by its file: it is no part of what pi exports.) */
async function letGoOf(sessions: Iterable<string>): Promise<void> {
  try {
    const { cleanupSessionResources } = await import(pathToFileURL(inPisAi("./compat")).href) as { cleanupSessionResources?: (session: string) => void };
    for (const session of sessions) cleanupSessionResources?.(session);
  } catch { /* what cannot be let go of is left: it is bounded where it is kept */ }
}

/**
 * A relay that asks with this process's own pi: the models it finds, and the
 * keys it has for their providers. Its events are sent ones (see `leaner`).
 * `close` when whoever it asks for is done: what is still being asked is
 * asked no further, and what was kept for it is let go of.
 */
export function createModelRelay(): ModelRelay & { close(): Promise<void> } {
  type Models = Awaited<ReturnType<Awaited<ReturnType<typeof loadPi>>["ModelRuntime"]["create"]>>;
  let models: Promise<Models> | undefined;
  const asking = new Set<AbortController>();
  const sessions = new Set<string>();
  return {
    async ask(request, signal) {
      let reply: AsyncIterable<unknown>;
      const stop = new AbortController();
      // (Cancelled before it was asked: nothing is asked.)
      if (signal?.aborted) return (async function* () { yield notAsked(request.model, "Aborted"); })();
      try {
        const found = await (models ??= loadPi().then(pi => pi.ModelRuntime.create()));
        const { provider, id } = request.model;
        const by = request.by ?? "streamSimple";
        // (A way that is none of these is not one to ask by, whatever pi's models have by that name.)
        const way = WAYS.get(by);
        if (!way) return undefined;
        const own: unknown = way.of === "chat" ? found.getModel(provider, id) : found.getModelOfType(way.of, provider, id);
        // The same model, to the letter, with a key to ask it by — and a provider nobody has had a hand in.
        if (!own || JSON.stringify(own) !== JSON.stringify(request.model) || !found.hasConfiguredAuth(provider)) return undefined;
        // (What goes with a request is held to here as where it was sent from: whoever sent it may not be who should have.)
        const options = dataOf(request.options);
        if (!options) return undefined;
        if (typeof options.sessionId === "string") sessions.add(options.sessionId);
        // (pi's models, asked by the name of the way: each takes the model, what it is to be sent, and the options.)
        const ask = (found as unknown as Record<RelayWay, (model: unknown, context: unknown, options: Record<string, unknown>) => unknown>)[by].bind(found);
        const asked = ask(own, request.context, { ...options, signal: stop.signal });
        reply = way.events ? asked as AsyncIterable<unknown> : (async function* () { yield { type: "done", message: await asked }; })();
      } catch {
        // (A pi that cannot be had here is not one to ask by: whoever asked asks itself.)
        models = undefined;
        return undefined;
      }
      const off = onAbort(signal, () => stop.abort());
      asking.add(stop);
      const lean = leaner();
      return (async function* () {
        try {
          for await (const event of reply) yield lean(event as RelayEvent);
        } catch (err) {
          yield notAsked(request.model, `The model could not be asked: ${messageOf(err)}`, "error");
        } finally {
          off();
          asking.delete(stop);
        }
      })();
    },
    async close() {
      for (const stop of asking) stop.abort();
      await letGoOf(sessions);
      sessions.clear();
    },
  };
}

// --- The two ends of a channel ---

/** What the end that asks sends: a request, or that one it sent is cancelled. */
export type RelayAsked = { relay: { id: number; request: RelayRequest; mark?: string } } | { relayAbort: number };
/** What the end that answers sends: an event of the reply to a request, or that the request is not one it can serve. */
export type RelayAnswered = { relayed: { id: number; event: RelayEvent } | { id: number; not: true } };

/**
 * The asking end: a relay that is reached by messages. `heard` is to be told
 * what the other end answers; `close` when the other end is gone — whatever
 * is still waited for then ends as a request that failed, saying so (nobody
 * cancelled it), and nothing more is asked by it.
 */
export function relayClient(send: (message: RelayAsked) => void): { relay: ModelRelay; heard(answer: RelayAnswered["relayed"]): void; close(): void } {
  const waiting = new Map<number, { heard(answer: RelayAnswered["relayed"]): void; end(): void }>();
  let ids = 0, closed = false;
  return {
    relay: {
      ask: (request, signal) => new Promise((resolve) => {
        if (closed) return resolve(undefined);
        // (Cancelled before it was asked: nothing is sent.)
        if (signal?.aborted) return resolve((async function* () { yield notAsked(request.model, "Aborted"); })());
        const id = ++ids;
        const events: RelayEvent[] = [];
        let wake = () => {}, begun = false;
        const off = onAbort(signal, () => send({ relayAbort: id }));
        const reply = async function* () {
          try {
            for (;;) {
              const event = events.shift();
              if (!event) await new Promise<void>((next) => { wake = next; });
              else {
                yield event;
                if (event.type === "done" || event.type === "error") return;
              }
            }
          } finally {
            off();
            waiting.delete(id);
          }
        };
        const add = (event: RelayEvent) => {
          events.push(event);
          wake();
          if (!begun) resolve(reply());
          begun = true;
        };
        waiting.set(id, {
          heard(answer) {
            if ("event" in answer) return add(answer.event);
            // (Not one the other end can serve: nothing was asked. Said of a reply that had begun, it is the reply's end.)
            if (begun) return add(notAsked(request.model, "The process that was asking the model ended the reply before it was whole.", "error"));
            off();
            waiting.delete(id);
            resolve(undefined);
          },
          end: () => add(notAsked(request.model, "The process that was asking the model ended before the reply had come.", "error")),
        });
        try {
          // (Where its options have nothing under a name, that is said: the channel would not say it.)
          const { data: options, mark } = marked(request.options);
          send({ relay: { id, request: { ...request, options }, mark } });
        } catch {
          // (A request that cannot be put on the channel — something in it is not data — is one nobody served.)
          off();
          waiting.delete(id);
          resolve(undefined);
        }
      }),
    },
    heard(answer) {
      waiting.get(answer.id)?.heard(answer);
    },
    close() {
      closed = true;
      for (const request of [...waiting.values()]) request.end();
    },
  };
}

/**
 * The answering end: serves, by `relay`, the requests that `heard` is told
 * of. `refuse`: whether a request is not to be made at all (it then ends as
 * one that was cancelled) — asked before each, and waited for; `replied`:
 * told what each reply used, as its last event passes. `close`: what is
 * still being asked is asked no further.
 */
export function relayServer(
  relay: ModelRelay,
  send: (message: RelayAnswered) => void,
  on: { refuse?: (request: RelayRequest) => boolean | Promise<boolean>; replied?: (usage: ReplyUsage) => void } = {},
): { heard(message: RelayAsked): void; close(): void } {
  const asking = new Map<number, AbortController>();
  // What cannot be said — the channel will not carry it, or is gone — is not said: whoever asks for others
  // is not failed by one of them.
  const say = (answer: RelayAnswered) => {
    try {
      send(answer);
    } catch { /* (Nobody is there to hear it.) */ }
  };
  const serve = async (id: number, request: RelayRequest, stop: AbortController) => {
    // Of a request that is not asked, what is said back of its model is its names: whatever else came as
    // the model may be nothing the channel will carry.
    let model: RelayModel = { provider: "", id: "" };
    try {
      const { provider, id: name, api } = request.model;
      model = { provider: String(provider), id: String(name), ...(typeof api === "string" && { api }) };
      if (await on.refuse?.(request)) return send({ relayed: { id, event: notAsked(model, "The call is to ask no more.") } });
      const events = await relay.ask(request, stop.signal);
      if (!events) return send({ relayed: { id, not: true } });
      for await (const event of events) {
        const usage = usageAtEnd(event);
        if (usage) on.replied?.(usage);
        send({ relayed: { id, event } });
      }
    } catch (err) {
      // (Whatever was thrown, and whether or not it can be said what.)
      let why = "it cannot be said why";
      try {
        why = messageOf(err);
      } catch { /* (As it is.) */ }
      say({ relayed: { id, event: notAsked(model, `The model could not be asked: ${why}`, "error") } });
    } finally {
      asking.delete(id);
    }
  };
  return {
    heard(message) {
      if ("relayAbort" in message) return asking.get(message.relayAbort)?.abort();
      const { id, request, mark } = message.relay;
      // (A request by a number another is being asked by is nobody's: what would stop it would stop the other.)
      if (asking.has(id)) return;
      let asked: RelayRequest;
      try {
        asked = { ...request, options: unmarked(request.options, mark) };
      } catch {
        // (What cannot be gone through — it goes deeper than anything a request goes with — is not one to serve.)
        return say({ relayed: { id, not: true } });
      }
      const stop = new AbortController();
      asking.set(id, stop);
      void serve(id, asked, stop);
    },
    close() {
      for (const stop of asking.values()) stop.abort();
    },
  };
}

/** A relay whose events are sent ones, as one whose events are pi's own: each with the reply so far. */
export function withRepliesWhole(relay: ModelRelay): ModelRelay {
  return {
    async ask(request, signal) {
      const events = await relay.ask(request, signal);
      if (!events) return undefined;
      return (async function* () {
        const state: SoFar = {};
        for await (const event of events) yield whole(event, state);
      })();
    },
  };
}
