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
// Three things are here: the one that asks (createModelRelay), and the two
// ends of a channel between it and a session (relayClient, relayServer).

import { createRequire } from "module";
import { pathToFileURL } from "url";
import { onAbort } from "./abort.js";
import { messageOf } from "./errors.js";

const loadPi = () => import("@earendil-works/pi-coding-agent");

/** A model as pi has it in its catalog: plain data. */
export type RelayModel = { provider: string; id: string; api?: string } & Record<string, unknown>;

/** A request of a model: plain data, all of it. */
export interface RelayRequest {
  /** The model, as the session that asks has it. */
  model: RelayModel;
  /** What the model is to be sent: as pi hands it to a provider. */
  context: unknown;
  /** The options of the request that are data (see `dataOf`). */
  options: Record<string, unknown>;
  /** Whether it is asked beside a call that is over — one that has its answer, or has failed (see AgentCall.sofar). */
  answered?: true;
}

/** An event of a reply, as pi's stream of it has them. The last is of type "done" or "error", and has the reply whole. */
export type RelayEvent = { type: string } & Record<string, unknown>;

export interface ModelRelay {
  /**
   * Ask the model. Resolves to the events of the reply, to the last — or to
   * undefined where the model is not one this relay can ask as the session
   * that asks would: that session then asks it itself. It does not reject.
   */
  ask(request: RelayRequest, signal?: AbortSignal): Promise<AsyncIterable<RelayEvent> | undefined>;
}

/** The options of a request that are data, and mean something to a provider. (The rest is pi's agent's own, and functions.) */
const DATA_OPTIONS = [
  "temperature", "samplingParams", "maxTokens", "transport", "cacheRetention", "sessionId", "disableContinuation",
  "websocketConnectTimeoutMs", "metadata", "toolChoice", "reasoning", "thinkingBudgets", "env", "headers", "identity",
  "timeoutMs", "maxRetries", "maxRetryDelayMs",
] as const;

/**
 * Of the options a session asks with, those that go with a relayed request —
 * or undefined where one is there that cannot go, and would be missed: a key
 * of the asker's own, a way of its own to reach the provider, a reply that is
 * to be fetched later.
 */
export function dataOf(options: Record<string, unknown> = {}): Record<string, unknown> | undefined {
  if (["apiKey", "fetch", "telemetry", "deferred"].some(key => options[key] !== undefined)) return undefined;
  return Object.fromEntries(DATA_OPTIONS.filter(key => options[key] !== undefined).map(key => [key, options[key]]));
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

/** What pi keeps for a session where its model is asked, let go of. (pi's own, had by its file: it is no part of what pi exports.) */
async function letGoOf(sessions: Iterable<string>): Promise<void> {
  try {
    const kept = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-ai/compat");
    const { cleanupSessionResources } = await import(pathToFileURL(kept).href) as { cleanupSessionResources?: (session: string) => void };
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
      try {
        const found = await (models ??= loadPi().then(pi => pi.ModelRuntime.create()));
        const { provider, id } = request.model;
        const own = found.getModel(provider, id);
        // The same model, to the letter, with a key to ask it by — and a provider nobody has had a hand in.
        if (!own || JSON.stringify(own) !== JSON.stringify(request.model) || !found.hasConfiguredAuth(provider)) return undefined;
        // (What goes with a request is held to here as where it was sent from: whoever sent it may not be who should have.)
        const options = dataOf(request.options);
        if (!options) return undefined;
        if (typeof options.sessionId === "string") sessions.add(options.sessionId);
        reply = found.streamSimple(own, request.context as Parameters<Models["streamSimple"]>[1], { ...options, signal: stop.signal });
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
export type RelayAsked = { relay: { id: number; request: RelayRequest } } | { relayAbort: number };
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
            // (Not one the other end can serve: nothing was asked.)
            off();
            waiting.delete(id);
            if (!begun) resolve(undefined);
          },
          end: () => add(notAsked(request.model, "The process that was asking the model ended before the reply had come.", "error")),
        });
        try {
          send({ relay: { id, request } });
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
  const serve = async (id: number, request: RelayRequest, stop: AbortController) => {
    try {
      if (await on.refuse?.(request)) return send({ relayed: { id, event: notAsked(request.model, "The call is to ask no more.") } });
      const events = await relay.ask(request, stop.signal);
      if (!events) return send({ relayed: { id, not: true } });
      for await (const event of events) {
        const usage = usageAtEnd(event);
        if (usage) on.replied?.(usage);
        send({ relayed: { id, event } });
      }
    } catch (err) {
      send({ relayed: { id, event: notAsked(request.model, `The model could not be asked: ${messageOf(err)}`, "error") } });
    } finally {
      asking.delete(id);
    }
  };
  return {
    heard(message) {
      if ("relayAbort" in message) return asking.get(message.relayAbort)?.abort();
      const { id, request } = message.relay;
      const stop = new AbortController();
      asking.set(id, stop);
      void serve(id, request, stop);
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
