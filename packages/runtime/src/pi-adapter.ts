import type { AgentSession, ExtensionFactory, InlineExtension, ModelRuntime as Models, ResourceLoader, SettingsManager as Settings, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { onAbort, rejectOnAbort, throwIfAborted } from "./abort.js";
import { messageOf } from "./errors.js";
import { createAgentHosts } from "./agent-hosts.js";
import { CutOff, addReply, atLeast, nothingYet, type AgentBackend, type AgentCall, type AgentUsage, type OwnTool, type Tally, type ToolAnswer } from "./agent-backend.js";
import * as http from "http";
import * as https from "https";
import { dataOf, isData, notAsked, usageAtEnd, wholeOf, type RelayEvent, type RelayModel, type RelayWay } from "./model-relay.js";
import type { ModelConfig } from "./runner-types.js";

/**
 * pi is loaded when it is first needed, not when this file is: it is most of
 * what the runtime weighs, and listing projects, reading logs, or running a
 * program that never calls the agent does not need it.
 */
const loadPi = () => import("@earendil-works/pi-coding-agent");

/** The pi version this runtime is built against (recorded in each project's meta.json). */
export const piVersion = async (): Promise<string> => (await loadPi()).VERSION;

/**
 * pi's own extensions — its MCP support among them. The `pi` command hands
 * them to its loader, and the package does not export them: they are read
 * from where pi keeps them, beside what it does export. A pi that keeps them
 * elsewhere is one a call with extensions cannot be served by as it asked —
 * its MCP servers would be missing with no word of it — and the call fails.
 */
async function builtInExtensions(): Promise<InlineExtension[]> {
  const kept = new URL("./extensions/index.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
  try {
    const found: unknown = (await import(kept.href)).builtInExtensions;
    if (!Array.isArray(found)) throw new Error("the file exports none");
    return found as InlineExtension[];
  } catch (err) {
    throw new Error(`pi's built-in extensions (its MCP support among them) cannot be had: trama reads them from pi's own files, at ${kept.pathname} (${messageOf(err)}).`);
  }
}

/**
 * The names of pi's own tools — those it gives an agent unasked, and those it
 * has besides. pi takes a tool it is handed by the name of one of them for
 * that tool, with no word of it; so a caller's own tool is held against them
 * here. Read from where pi keeps them, as its extensions are: the package
 * does not export the list, and a pi that keeps it elsewhere is one a call
 * with tools of its own cannot be served by as it asked — the call fails.
 */
async function pisOwnTools(): Promise<Set<string>> {
  const kept = new URL("./core/tools/index.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
  try {
    const found: unknown = (await import(kept.href)).allToolNames;
    if (!(found instanceof Set)) throw new Error("the file exports none");
    return found as Set<string>;
  } catch (err) {
    throw new Error(`The names of pi's own tools cannot be had: trama reads them from pi's own files, at ${kept.pathname} (${messageOf(err)}).`);
  }
}

/** What a tool is taken to have said where its call was cancelled before it answered. (Nobody reads it: the call is over.) */
const NOT_WAITED_FOR: ToolAnswer = { text: "The call was stopped before the tool had answered.", failed: true };

/**
 * What a call's own tool said that ended the agent's work — the answer of
 * such a call. A run that a tool ended has that tool's result as the last
 * thing on its record: the model was not asked again. (Where the model was —
 * it had called, in the same reply, a tool that ends nothing — the last
 * thing is its reply, and that is the answer, as of any call.)
 */
function endedWith(session: AgentSession, ownTools: OwnTool[] | undefined): string | undefined {
  const ending = new Set((ownTools ?? []).filter(tool => tool.ends).map(tool => tool.name));
  if (ending.size === 0) return undefined;
  const last = session.sessionManager.getEntries().flatMap(entry => (entry.type === "message" ? [entry.message] : [])).at(-1);
  // (Of the call's own that end it: a run may be ended by another's tool — an extension's — which is no answer of this call's.
  // And not one that failed: such a tool has ended nothing — see asPisTool — and the model was asked again.)
  if (last?.role !== "toolResult" || !ending.has(last.toolName)) return undefined;
  return last.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

/**
 * A caller's own tool, as pi has a tool. Run one at a time unless it says
 * it may be run beside another (pi's own way is to run together all that a
 * model calls in one reply). And over as soon as its signal says the call
 * is cancelled, whatever becomes of the asking: pi waits for a tool for as
 * long as the tool takes, and a cancelled call would be held by it.
 */
function asPisTool(own: OwnTool): ToolDefinition {
  return {
    name: own.name,
    label: own.name,
    description: own.description,
    parameters: own.parameters as ToolDefinition["parameters"],
    executionMode: own.parallel ? "parallel" : "sequential",
    async execute(id, args, signal) {
      let off = () => {};
      const cancelled = new Promise<ToolAnswer>((resolve) => { off = onAbort(signal, () => resolve(NOT_WAITED_FOR)); });
      const asked = own.run(args, id, signal).catch((err): ToolAnswer => ({ text: messageOf(err), failed: true }));
      const { text, images = [], failed } = await Promise.race([asked, cancelled]).finally(off);
      return {
        // (Where a tool has images and no words, there is no text at all: pi then says for itself that there is
        // something to see — and a text of no words, beside an image, is one some providers refuse.)
        content: [...(text !== "" || images.length === 0 ? [{ type: "text" as const, text }] : []), ...images.map(image => ({ type: "image" as const, ...image }))],
        details: undefined,
        ...(failed && { isError: true }),
        // (pi ends an agent's run on a result that says so, failed or not: a tool that failed has ended nothing.)
        ...(own.ends && !failed && { terminate: true }),
      };
    },
  };
}

/** provider/model pairs already warned about, so a loop of agent calls warns once per process. */
const warnedUnknownModels = new Set<string>();

/** What a call may ask of its session, beyond where it works and what it is told. */
type Asked = Pick<AgentCall, "model" | "thinking" | "tools" | "ownTools" | "skills" | "templates" | "extensions" | "asText" | "sofar" | "had" | "used" | "relay">;

const nameOf = (model: { provider: string; id: string }): string => `${model.provider}/${model.id}`;

/**
 * Of what a call may have all of, some by name, or none: whether it chose
 * from them, and which by name. (A list with no name in it chooses none, as
 * any list chooses only what it names.)
 */
type Choice = boolean | string[] | undefined;
const chosen = (choice: Choice): boolean => choice === true || Array.isArray(choice);
const named = (choice: Choice): string[] | undefined => (Array.isArray(choice) ? choice : undefined);

/** What pi found of each kind a call may choose from, by name: all of it, whatever the call chose. */
interface Found { skills: string[]; templates: string[] }

/** What pi writes of a set of skills, to tell a model of them: differently for each way the model has of reading one. */
type SkillsAsTold = Awaited<ReturnType<typeof loadPi>>["formatSkillsForPrompt"];
const WAYS_TO_READ = ["read", "bash", "indirect"] as const;

/**
 * How long an extension is given to hear that its session is over, while it is not asking a model — and, where a
 * call is cancelled while it is still being told that one begins, to have heard that first. (While it is asking a
 * model, it is waited for: see leaveExtensions.)
 */
const EXTENSION_LEAVE_MS = 5_000;

/** How long pi gives a request to a provider, where its settings do not say: the most a model is waited for, at work for extensions as their session ends. */
const REQUEST_MS = 300_000;

/** How long what was stopped is given to end, and say what it had used, before the count is closed. */
const STOPPED_MS = 1_000;

/**
 * How long a cancelled call is waited for where something holds it. Less
 * than a runner gives the process that serves the call to let go of it
 * (KILL_GRACE_MS): what the call used is said when it is given up here, and
 * that is to be heard there before the process is ended.
 */
const HELD_MS = 3_000;

/**
 * `work` — but once `signal` has said to stop, waited for no longer than a
 * while: a call that was cancelled is not held for good by what does not
 * return (an extension's handler, where the call has extensions).
 */
function notHeld<T>(work: Promise<T>, signal: AbortSignal | undefined, ms: number): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    let late: NodeJS.Timeout | undefined;
    const off = onAbort(signal, () => { late = setTimeout(() => reject(new Error("Aborted")), ms); });
    const over = () => {
      off();
      clearTimeout(late);
    };
    work.then(value => { over(); resolve(value); }, err => { over(); reject(err); });
  });
}

/** Wait for `work`, but no longer than a while. (What becomes of it is not asked.) */
async function within(work: Promise<unknown>, ms: number): Promise<void> {
  let giveUp: NodeJS.Timeout | undefined;
  await Promise.race([work.catch(() => {}), new Promise(resolve => { giveUp = setTimeout(resolve, ms); })]);
  clearTimeout(giveUp);
}

/**
 * Why a session is not the one a call asked for. pi takes a level it does not
 * have for the model, or a tool it has not got, and gives what it can without
 * a word; a call is to have what it asked for or fail. (`serving` is the model
 * by name, if pi has a real one.)
 */
function whyNotAsAsked(session: AgentSession, asked: Asked, serving: string | null, found: Found, asTold: SkillsAsTold): string | undefined {
  const { thinking } = asked;
  // (An extension pi has something against — it did not load, or a tool of it bears the name of another's — is
  // not one the call has as it was written: and it may be where a tool the call names was to come from.)
  const failed = asked.extensions ? session.resourceLoader.getExtensions().errors[0] : undefined;
  if (failed) return `The extension ${failed.path} is not as pi would have it: ${failed.error}`;
  if (thinking !== undefined && session.thinkingLevel !== thinking) {
    return `The model${serving ? ` ${serving}` : ""} does not think at level "${thinking}". ` +
      `Its levels: ${session.getAvailableThinkingLevels().join(", ")}.`;
  }
  // (With extensions, an agent's tools are not all there yet: see whyNotTheTools.)
  const tools = asked.extensions ? undefined : whyNotTheTools(session, asked);
  if (tools) return tools;
  const lacking = (kind: string, choice: Choice, had: string[]): string | undefined => {
    const missing = named(choice)?.find(name => !had.includes(name));
    return missing === undefined ? undefined : `pi has no ${kind} "${missing}". Its ${kind}s: ${had.join(", ") || "none"}.`;
  };
  const missing = lacking("skill", asked.skills, found.skills) ?? lacking("prompt template", asked.templates, found.templates);
  if (missing) return missing;
  // pi tells a model of its skills only where the model has something to read them with: a skill
  // that is for the model to take up (and not only to be called by name, in the prompt) has to be told of.
  // Looked for is what pi would write of them, word for word — nothing, where none is for the model to take up.
  if (chosen(asked.skills)) {
    const skills = session.resourceLoader.getSkills().skills;
    if (!WAYS_TO_READ.some(way => session.systemPrompt.includes(asTold(skills, way).trim()))) {
      const untold = skills.filter(skill => !skill.disableModelInvocation).map(skill => skill.name);
      return `The agent cannot take up its skills (${untold.join(", ")}) with the tools ${JSON.stringify(session.getActiveToolNames())}: ` +
        `pi tells a model of its skills only where it has "read" or "bash" to read them with.`;
    }
  }
  return undefined;
}

/**
 * Why an agent has not the tools a call named — to be asked when it has all
 * it is to have. Without extensions that is when its session is made. With
 * them it is when the model is about to be asked for the first time: an
 * extension may add tools as the run begins (pi's own connects the user's MCP
 * servers then, and their tools are the agent's from there on).
 */
function whyNotTheTools(session: AgentSession, { tools, ownTools }: Pick<AgentCall, "tools" | "ownTools">): string | undefined {
  const own = (ownTools ?? []).map(tool => tool.name);
  // (A tool of the caller's own by the name of an extension's is the tool from then on, to pi, and nothing is said of it.)
  for (const extension of session.resourceLoader.getExtensions().extensions) {
    const taken = own.find(name => extension.tools.has(name));
    if (taken !== undefined) return `The tool "${taken}" cannot be the call's own: the extension ${extension.path} has a tool of that name.`;
  }
  // The caller's own are named to pi with pi's (see createSession), and are the agent's as those are.
  const named = tools ? [...tools, ...own] : own.length > 0 ? own : undefined;
  if (named === undefined) return undefined;
  const given = session.getActiveToolNames();
  // (pi gives no tool that was not named. What it does not know by the name it was given, it leaves out.)
  return named.every(name => given.includes(name)) ? undefined
    : `The agent cannot be given the tools ${JSON.stringify(named)}: pi would give it ${JSON.stringify(given)}.`;
}

/** What is kept of a session that has extensions, beside the session. */
interface Extended {
  /** What its extensions have put to the model and is not yet over. */
  puts: Set<Promise<void>>;
  /** Whether its call has come to its end. */
  over: boolean;
  /** Looks, once, at what the agent has when the model is about to be asked for the first time (see whyNotTheTools). */
  look?: () => void;
}

/** The events of a reply, as a provider gives them: pi asks no more of them than to be gone through, to the last. */
type Reply = AsyncIterable<RelayEvent>;

/**
 * Where trama stands when a session's model is asked (see `watch`). What a
 * call has to say there is put in by `account`, as its session is made.
 */
interface Asking {
  /** The session's models: what was watched. */
  models: Models;
  /** What the replies that came used, all told: everything a model was asked on the session's account, by whoever asked. */
  seen: Tally;
  /** Waited for before a model is asked: whoever counts hears what the call has used so far, and may cancel it there. */
  before?: () => Promise<void>;
  /** Whether nothing more is to be asked: the call is cancelled, or over. */
  stopped?: () => boolean;
  /** Told that a reply has come. */
  replied?: () => void;
  /**
   * Has the model asked elsewhere, where it can be: the reply — or undefined, and the model is asked here.
   * (`headers`: whether the request's asker made its headers other than they were — see `watch`.)
   */
  elsewhere?: (by: RelayWay, model: RelayModel, context: unknown, options: Record<string, unknown> | undefined, headers: { changed: boolean }) => Promise<Reply | undefined>;
  /** How many replies are being gone through at this moment, of what was asked on the session's account: a model is at work for it. */
  answering: number;
  /** How many requests are being made ready at this moment: something is about to be asked — or is not, after all. */
  readying: number;
  /** Told when either number changes. */
  changed?: () => void;
  /** Stops what is being asked: the call was cancelled, or its session is gone. Every request made on the session's account goes with its signal. */
  cut: AbortController;
  /**
   * Whether the call has come to its end; and whether its session is gone — its extensions told that it is
   * over, and heard out. Between the two an extension may still ask a model for itself (to sum up what was
   * done, say), and that is the call's: what the call used is what it had used when its session was gone.
   */
  over: boolean;
  gone: boolean;
  /** Says that the call cannot have what it named, where that is found as its run begins (see `serve`): it is then stopped as a cancelled call is. */
  refusal: AbortController;
  /** Says to stop a call that is at its work: it was cancelled, or cannot have what it named. (Made by `account`.) */
  stop?: AbortSignal;
}

/**
 * A signal that says to stop when either does. One of them is whatever an
 * asker gave its request to be stopped by — which need not be a signal of
 * the system's own making (a library's, an older runtime's): such a one is
 * listened to as far as it can be, and the request is asked all the same.
 */
function either(own: unknown, cut: AbortSignal): { signal: AbortSignal; release: () => void } {
  const nothing = () => {};
  if (own === undefined || own === null) return { signal: cut, release: nothing };
  if (own instanceof AbortSignal) return { signal: AbortSignal.any([own, cut]), release: nothing };
  const both = new AbortController();
  const theirs = own as { aborted?: unknown; reason?: unknown; addEventListener?: unknown; removeEventListener?: unknown };
  const byThem = () => both.abort(theirs.reason);
  const byCut = () => both.abort(cut.reason);
  if (theirs.aborted === true) byThem();
  else if (cut.aborted) byCut();
  else {
    cut.addEventListener("abort", byCut, { once: true });
    try {
      if (typeof theirs.addEventListener === "function") theirs.addEventListener("abort", byThem, { once: true });
    } catch {
      // (Not one that can be listened to: the request is stopped by what stops the call, and by nothing else.)
    }
  }
  return {
    signal: both.signal,
    // (When the request is over: nothing of it is left listening to either.)
    release: () => {
      cut.removeEventListener("abort", byCut);
      try {
        if (typeof theirs.removeEventListener === "function") theirs.removeEventListener("abort", byThem);
      } catch {
        // (As it could not be listened to.)
      }
    },
  };
}

/** What an extension may have a hand in, of a request to a provider: a session where one does asks its model itself. */
const HANDS_IN = ["before_provider_request", "before_provider_headers", "after_provider_response", "provider_stream_event"];

/**
 * What pi's agent has every request of its own go with, to be told of what
 * a provider is sent and answers: pi's own, which do nothing where no
 * extension has a hand in (HANDS_IN). A request that goes with all of them,
 * by the way the agent asks, is one the agent makes for itself — or one made
 * with all the agent's was made with, which is the same to a provider.
 */
const HOOKS = ["onPayload", "onResponse", "onProviderStreamEvent"];

/**
 * What else goes with a request the agent makes for itself, and is nothing
 * a provider is handed: what the agent's loop calls as a turn goes, which pi
 * passes along with what a provider is to have. (The functions of
 * pi-agent-core's `createLoopConfig` that pi sets, less the hooks above. The
 * rest of what a loop is set up by is data, and goes as any data.) Named,
 * because it cannot be told otherwise: a function of the loop's is a
 * function like one an asker might mean a provider to have. A pi whose loop
 * is set up by a function more has its agent's requests asked where the call
 * is served, until it is named here.
 */
const LOOPS = ["beforeToolCall", "afterToolCall", "finishTurn", "prepareRequest", "prepareNextTurn", "convertToLlm", "transformContext", "getSteeringMessages", "getFollowUpMessages"];

/**
 * What a provider is asked by, of what it has: whether what comes of it comes
 * as the events of a reply, and the way a relay asks by in its place (none,
 * of a reply that was to be fetched later: it is fetched where it was asked
 * for). Whatever else a provider has is not asking a model.
 */
const ASKED_BY = new Map<PropertyKey, { events: boolean; way?: RelayWay }>([
  ["stream", { events: true, way: "stream" }],
  ["streamSimple", { events: true, way: "streamSimple" }],
  ["fetchDeferred", { events: true }],
  ["generateImages", { events: false, way: "generateImages" }],
  ["classify", { events: false, way: "classify" }],
]);

/** What is said of a request that is not made: its call is to ask no more. */
const NO_MORE = "The call is to ask no more.";

/**
 * What a request to a provider goes by, that is a process's own: its
 * variables — a provider's key may be one — and its ways to the network. An
 * extension may make them other than they were: read a file of variables,
 * put something of its own before every request the process makes. A request
 * asked from another process would then not be the request this one makes,
 * and nothing in the request says so. So what they are is kept from before
 * the first extension is loaded in this process (`asLoaded`), and a session
 * hands its requests over only while they are that still (`asItWas`). It is
 * what can be told, and not all an extension can do: one that reaches under
 * these is not seen.
 */
const shapeOf = () => ({
  variables: JSON.stringify(process.env),
  ways: [globalThis.fetch, (globalThis as Record<symbol, unknown>)[Symbol.for("undici.globalDispatcher.1")], http.globalAgent, https.globalAgent],
});
let asLoaded: ReturnType<typeof shapeOf> | undefined;
function asItWas(): boolean {
  if (!asLoaded) return false;
  const now = shapeOf();
  return now.variables === asLoaded.variables && now.ways.every((way, at) => way === asLoaded!.ways[at]);
}

/**
 * Stand where a session's models are asked. pi asks a model in more places
 * than one — its agent for a turn, for a summary of a long conversation or of
 * a branch, to keep a provider's cache warm while a session waits; and an
 * extension may ask by the session's models for itself — and every one of
 * them comes by one step: the request is made ready, and handed to the
 * model's provider. So that step is where a call is asked whether its model
 * may be asked again, and the provider's reply is where what it used is seen.
 * (pi does not export the step: it is a method of what trama made, and is
 * made to stand aside for this.)
 */
function watch(models: Models, asking: Asking): void {
  type Provider = Record<PropertyKey, unknown>;
  type Options = Record<string, unknown> | undefined;
  type Prepared = { provider: object; model: RelayModel; options: Record<string, unknown> };
  const standing = models as unknown as { prepareRequest(model: RelayModel, options?: Record<string, unknown>): Promise<Prepared> };
  const prepare = standing.prepareRequest.bind(models);
  // A provider for a call that is to ask no more: whatever it is asked by, the request ends as one that was
  // cancelled before it was sent — or, where what comes of it comes all at once, fails saying so. But to have
  // a provider give up a reply it was keeping for later is to ask no model: that is done, whoever is stopped.
  const refusing = (model: RelayModel, options: Options) => {
    const refused = async function* (): Reply {
      yield notAsked(model, NO_MORE);
    };
    const failed = async () => { throw new Error(NO_MORE); };
    return {
      stream: refused, streamSimple: refused, fetchDeferred: refused, generateImages: failed, classify: failed,
      cancelDeferred: async (_model: unknown, handle: unknown) => {
        const real = await prepare(model, options);
        const cancel = (real.provider as Provider).cancelDeferred;
        if (typeof cancel !== "function") throw new Error(`Provider ${model.provider} does not support deferred responses`);
        await cancel.call(real.provider, real.model, handle, real.options);
      },
    };
  };
  // A provider that is an extension's own code may ask another model by these same models, and hand back what
  // that model answered — there and then, from a queue of its own, or a reply it had asked for before: a reply
  // that passes here twice, and used what it used once. So what a reply used is counted by the reply: once for
  // each account of usage that passes, wherever and however often it passes. (pi hands a reply on as it is; a
  // provider that makes a copy of one, account and all, has made another reply of it as far as can be told.)
  const counted = new WeakSet<object>();
  // What is being asked at this moment is kept count of, for whoever waits on it (see leaveExtensions): the
  // replies that are being gone through, and the requests that are being made ready. (A request that is made
  // ready and then not asked — its asker was stopped before it came to that — never was one a model worked on.)
  const count = (of: "answering" | "readying", by: number) => {
    asking[of] += by;
    asking.changed?.();
  };
  const heard = async function* (reply: Reply, ...released: Array<() => void>): Reply {
    count("answering", 1);
    try {
      for await (const event of reply) {
        const used = usageAtEnd(event);
        if (used && !counted.has(used)) {
          counted.add(used);
          addReply(asking.seen, used);
          asking.replied?.();
        }
        yield event;
      }
    } finally {
      count("answering", -1);
      for (const release of released) release();
    }
  };
  // And every request goes with the word that stops it (Asking.cut), beside whatever its asker gave it to be
  // stopped by: asked here or elsewhere, by pi or by an extension for itself.
  const stoppable = (options: Options) => {
    const { signal, release } = either(options?.signal, asking.cut.signal);
    return { options: { ...options, signal }, release };
  };
  // What a request's asker would make of its headers (pi's agent has a function go with every request of its
  // own, for extensions that would: it makes nothing of them where none does) is seen as it is made: whether
  // the headers came out of it other than they went in — name by name, in their order, and a name with nothing
  // under it a name all the same: pi lays headers one over another by all of that.
  // (What cannot be told at all is not what it was, for all that can be said of it.)
  const told = (headers: unknown): string | undefined => {
    try {
      return JSON.stringify(headers !== null && typeof headers === "object"
        ? Object.entries(headers).map(([name, value]) => [name, value === undefined ? 0 : [value]]) : [headers]);
    } catch {
      return undefined;
    }
  };
  const seeing = (options: Options, headers: { changed: boolean }): Options => {
    const theirs = options?.transformHeaders;
    if (typeof theirs !== "function") return options;
    return {
      ...options,
      transformHeaders: async (had: unknown) => {
        const were = told(had);
        const made: unknown = await theirs(had);
        if (were === undefined || told(made) !== were) headers.changed = true;
        return made;
      },
    };
  };
  standing.prepareRequest = async (model, options) => {
    count("readying", 1);
    try {
      await asking.before?.();
      // (Asked no more.)
      if (asking.stopped?.()) return { provider: refusing(model, options), model, options: options ?? {} };
      const headers = { changed: false };
      const prepared = await prepare(model, seeing(options, headers));
      return {
        ...prepared,
        provider: new Proxy(prepared.provider as Provider, {
          get(target, key) {
            const value: unknown = Reflect.get(target, key, target);
            if (typeof value !== "function") return value;
            const by = ASKED_BY.get(key);
            if (!by) return value.bind(target);
            // A model is asked: what a provider is handed is the model, what it is to be sent, and the options.
            // Elsewhere, where that can be — or here, by the provider itself. What comes all at once is made a
            // reply of one event, and counted and waited for as any reply; and whoever asked is given it whole.
            return (...sent: unknown[]) => {
              const there = stoppable(options), here = stoppable(sent[2] as Options);
              const reply = heard((async function* (): Reply {
                const elsewhere = by.way && await asking.elsewhere?.(by.way, model, sent[1], there.options, headers);
                if (elsewhere) yield* elsewhere;
                else if (by.events) yield* value.call(target, sent[0], sent[1], here.options) as Reply;
                else yield { type: "done", message: await value.call(target, sent[0], sent[1], here.options) };
              })(), there.release, here.release);
              return by.events ? reply : wholeOf(reply);
            };
          },
        }),
      };
    } finally {
      // (Made ready, or not: counted until whoever had it made ready has had their turn to ask for the reply,
      // which is counted from there — so that no moment between the two is one in which nothing is being asked.)
      setImmediate(() => count("readying", -1));
    }
  };
}

/**
 * Have what is asked on a session's account be its call's, from before the
 * session is there: an extension may ask a model as it is told that the
 * session begins, and that is the call's as much as what its agent asks —
 * also where the call then fails before its agent was ever set going.
 *
 * Each time a model is about to be asked, what the call has used so far is
 * said, and whoever hears it waited for: they may cancel the call there, and
 * the model is then not asked. (One at a time: whoever hears it is told of
 * one request, and answers for that one.) And a call that was cancelled, or
 * whose session is gone, asks no more, whoever would have it ask — its agent,
 * pi keeping a cache warm, an extension for itself. Gives back what says to
 * stop the call while it is at its work.
 */
function account(asking: Asking, call: Asked, signal: AbortSignal | undefined, session: () => AgentSession | undefined): AbortSignal {
  const { sofar, had, relay } = call;
  const stopped = signal ? AbortSignal.any([signal, asking.refusal.signal]) : asking.refusal.signal;
  asking.stop = stopped;
  const counted = () => {
    const its = session();
    return its ? usageOf(its, asking.seen) : atLeast(undefined, asking.seen);
  };
  let heard: Promise<void> = Promise.resolve();
  // (A call that has its answer is not cancelled for what it has used: whoever hears says instead that
  // nothing more may be asked beside it — and nothing is, from then.)
  let noMore = false;
  // (What stops a call in its work — it was cancelled, or cannot have the tools it named — stops what is asked
  // on its account. Once it is over, a call that could not have its tools is one that failed, like any: what
  // an extension asks beside it, as it is told the session ends, is asked. And nothing is, once what was being
  // asked has been stopped — the session is being let go of: there is nobody left to say what the call has
  // used to, and to wait for.)
  const halted = () => asking.cut.signal.aborted || (asking.over ? signal?.aborted === true : stopped.aborted);
  asking.stopped = () => asking.gone || noMore || halted();
  // (Whoever hears what the call has used is not waited for once it is to ask no more, whatever they would
  // say: the call was cancelled or cannot have what it named, while it is at its work — and, whenever the
  // wait began, once what was being asked has been stopped.)
  const atWork = AbortSignal.any([stopped, asking.cut.signal]);
  asking.before = () => heard = heard.then(async () => {
    const usage = sofar && !asking.gone && !noMore && !halted() && counted();
    if (usage && await rejectOnAbort(Promise.resolve(sofar(usage, asking.over)), asking.over ? asking.cut.signal : atWork).catch(() => {}) === false && asking.over) noMore = true;
  });
  // (As soon as a reply has come, what the call has used is said to whoever would not otherwise know
  // it, were this process to be ended: before the reply is anybody else's to hear of.)
  asking.replied = () => {
    const usage = had && !asking.gone && counted();
    if (usage) had(usage);
  };
  // Where the call has extensions and somebody to ask its model by, its model is asked by them: what
  // a reply used is then read where no extension is. Not where an extension has made the model's
  // provider its own, has a hand in what a provider is sent and answers, or has made
  // this process other than it was in what a request goes by — the model is then asked here, as the
  // extension means it to be — nor where the request is not one that can be handed over: something
  // goes with it that is not data, and whoever asked may mean something by it (see dataOf).
  if (relay && call.extensions) {
    asking.elsewhere = async (by, model, context, options = {}, headers) => {
      const its = session();
      if (!its || !asItWas() || asking.models.getRegisteredProviderIds().includes(model.provider)) return undefined;
      if (HANDS_IN.some(event => its.extensionRunner.hasHandlers(event))) return undefined;
      // All that goes with a request is data, or the request is not handed over: whoever made it may mean
      // something by it. But what is known to be nothing a provider is handed is left out first.
      // What would make something of the request's headers, where that was seen to be nothing (see `watch`):
      // the request is the same without it.
      if (headers.changed) return undefined;
      const left = new Set(["transformHeaders"]);
      // pi's own hooks, which do nothing here (see HANDS_IN) — and are pi's own where they are the very ones
      // the session's agent has: any other is its asker's hand in the request.
      const agent = its.agent as unknown as Record<string, unknown>;
      for (const hook of HOOKS) {
        if (options[hook] === undefined) continue;
        if (options[hook] !== agent[hook]) return undefined;
        left.add(hook);
      }
      // And of a request the agent makes for itself, the rest of what its loop is set up by (see LOOPS); and
      // in its conversation, which is of pi's making, what a tool kept beside its result — no provider is
      // sent that, so it need not be what it was on the other side.
      const agents = by === "streamSimple" && HOOKS.every(hook => options[hook] === agent[hook]);
      if (agents) for (const name of LOOPS) left.add(name);
      let data: Record<string, unknown> | undefined;
      try {
        data = dataOf(Object.fromEntries(Object.entries(options).filter(([name]) => !left.has(name))));
        if (!data || (!agents && !isData(context))) return undefined;
      } catch {
        // (What cannot be gone through — it goes deeper than can be followed — is not known to be data.)
        return undefined;
      }
      return relay.ask({ ...(by !== "streamSimple" && { by }), model, context, options: data, ...(asking.over && { answered: true }) }, options.signal as AbortSignal | undefined);
    };
  }
  return stopped;
}

/**
 * Tell a session's extensions that it is over, and wait for them — a while:
 * an extension may hold what is to be let go of (a server it started), and
 * one that does not answer is not waited for. What one of them put to the
 * model and is still on its way there is seen off too, before the session is
 * gone: it is stopped as it begins to ask (see `ask`), where a session that
 * is disposed of under it would let it through.
 *
 * An extension that is asking a model is not one that does not answer: it
 * may be summing up what was done, and a model takes the time it takes — a
 * quarter of a minute for a page, a minute where it thinks first. So there
 * are two clocks, and one of them runs at a time. The while extensions are
 * given is their own, all told: it runs while no model is at work on what
 * was asked on the session's account, and stands while one is. And the time
 * a model may be at work for them, all told, is what pi gives one request of
 * its own (`most`; none, where pi has no limit): it runs while a reply is
 * being gone through. What they have all been told, and is still being asked
 * beside what they answered, is waited for the same way. (A request that is
 * only ever made ready — a session set going again and stopped as it begins,
 * over and over — is no model at work: it is on their own time.) When either
 * has run out, whoever let go of the session stops what is still asked (see
 * Asking.cut): nothing is left being asked for a reply on the account of a
 * session that is gone, to be nobody's.
 */
async function leaveExtensions(session: AgentSession, puts: Set<Promise<void>>, asking: Asking | undefined, most: number): Promise<void> {
  const left = (async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    while (puts.size > 0) await Promise.allSettled([...puts]);
  })().catch(() => {});
  await new Promise<void>((resolve) => {
    // Whether they have all answered, and whether the wait is over; what is left of their own time, and of a
    // model's for them; and the clock that runs one of those down — which, and since when.
    let told = false, ended = false, theirs = EXTENSION_LEAVE_MS, models = most > 0 ? most : Infinity;
    let clock: NodeJS.Timeout | undefined, atWork = false, since = performance.now();
    const done = () => {
      if (ended) return;
      ended = true;
      clearTimeout(clock);
      if (asking) asking.changed = undefined;
      asking?.cut.signal.removeEventListener("abort", look);
      resolve();
    };
    const look = () => {
      if (ended) return;
      const now = performance.now();
      if (atWork) models -= now - since;
      else theirs -= now - since;
      clearTimeout(clock);
      // (What was stopped — the call was cancelled — is no model at work, however long it takes to end: it is
      // given a moment for that when the wait is over, like anything that is stopped. See allEnded.)
      const asked = asking && !asking.cut.signal.aborted ? asking : undefined;
      atWork = asked !== undefined && asked.answering > 0;
      since = now;
      if (!atWork && told && !asked?.readying) return done();
      const has = atWork ? models : theirs;
      // (A timer takes no more than this.)
      clock = has === Infinity ? undefined : setTimeout(done, Math.min(Math.max(0, has), 2 ** 31 - 1));
    };
    if (asking) asking.changed = look;
    asking?.cut.signal.addEventListener("abort", look, { once: true });
    void left.then(() => {
      told = true;
      look();
    });
    look();
  });
}

/** Wait until no reply is being gone through on a session's account — what was stopped ends, and says what it had used — or for a moment, whichever is less. */
function allEnded(asking: Asking): Promise<void> {
  return new Promise((resolve) => {
    if (asking.answering <= 0) return resolve();
    const over = () => {
      clearTimeout(late);
      asking.changed = undefined;
      resolve();
    };
    const late = setTimeout(over, STOPPED_MS);
    asking.changed = () => { if (asking.answering <= 0) over(); };
  });
}

/**
 * The most a model is waited for, at work for a session's extensions as it
 * ends: what pi gives a request of its own, as the session's settings have
 * it — the time for a request to a provider, or else the time a connection
 * may be silent, which is none at all where the settings say so. What the
 * settings have that pi itself would not take is not taken here either:
 * then it is what pi gives where they say nothing.
 */
function longestAsked(session: AgentSession): number {
  try {
    const settings = session.settingsManager as Partial<Settings> | undefined;
    const own: unknown = settings?.getProviderRetrySettings?.().timeoutMs;
    if (typeof own === "number" && Number.isFinite(own) && own > 0) return own;
    const silent: unknown = settings?.getHttpIdleTimeoutMs?.();
    return typeof silent === "number" && silent >= 0 ? silent : REQUEST_MS;
  } catch {
    return REQUEST_MS;
  }
}

/**
 * What a session has used: pi's own count, over everything the session asked
 * of its model — a summary it made of a long conversation included — and
 * what trama saw come (`seen`: see `watch`), where that is more: a reply that
 * has come and is not on pi's record yet, and what an extension asked for
 * itself, which never is. Nothing, where no tokens were counted: the model
 * was never reached, or does not say.
 */
function usageOf(session: AgentSession, seen?: Tally): AgentUsage | undefined {
  const { tokens, cost } = session.getSessionStats();
  const { input, output, cacheRead, cacheWrite } = tokens;
  return atLeast({ ...(session.model && { model: nameOf(session.model) }), input, output, cacheRead, cacheWrite, cost }, seen);
}

/**
 * The model's answer: the text of the last reply the session has on record.
 *
 * The record, not the conversation as the model would next be shown it: pi
 * takes a reply that failed out of that — one the provider refused as too
 * long, one cut off — and what is left there to be last is an earlier turn.
 * And an answer only if the model ended it itself: a reply that is the
 * provider's error, or was cut off at the output limit, is the call's failure
 * (the second with what there was of it: see CutOff). A reply cut off in the
 * middle of a tool call is never the last: pi has the model make the call again.
 */
function answerOf(session: AgentSession, taken = false): string {
  const replies = session.sessionManager.getEntries()
    .flatMap(entry => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []));
  const reply = replies.at(-1);
  const text = reply?.content.map(block => (block.type === "text" ? block.text : "")).join("") ?? "";
  if (reply?.stopReason === "error") throw new Error(`The model did not answer: ${reply.errorMessage ?? "no reason given"}`);
  if (reply?.stopReason === "length") throw new CutOff(text);
  if (!text) {
    throw new Error(taken
      ? "The prompt was taken by an extension — a command of its own, or its reading of what is asked — and the model gave no answer."
      : "Empty response from LLM");
  }
  return text;
}

/**
 * The pi coding agent: a fresh in-memory session for every call — in this
 * process, or in a process of its own (see agent-host.ts). A call that has
 * extensions is served in one: an extension is somebody's code, and where it
 * runs it can hold up, or bring down, everything else that runs there. And
 * so is every call of an adapter that was given variables (`env`: a run's):
 * what an agent finds of pi, which key it has for a provider, and what the
 * commands it runs are given, are a process's — and this process is the
 * runner's, whose own are not a run's to change.
 */
export class PiAdapter implements AgentBackend {
  private config: ModelConfig;
  /** Whether every call is served in a process of its own: where those processes are given variables this one has not. */
  private apart: boolean;
  /** The processes that serve this adapter's calls. */
  private hosts: ReturnType<typeof createAgentHosts>;

  constructor(config: ModelConfig, env?: Record<string, string>) {
    this.config = config;
    // (Variables that are none are none given: such a run's calls are served as any run's.)
    this.apart = env !== undefined && Object.keys(env).length > 0;
    this.hosts = createAgentHosts(this.apart ? env : undefined);
  }

  /** Have a call served: here, or by a host. */
  async ask(prompt: string, call: AgentCall): Promise<string> {
    return call.extensions || this.apart ? this.hosts.ask(this.config, prompt, call) : this.serve(prompt, call);
  }

  /** End the processes that served calls: what this adapter was for is over. (It can be asked again: it starts them anew.) */
  async close(): Promise<void> {
    await this.hosts.close();
  }

  private async createSession(cwd: string, systemPrompt?: string, signal?: AbortSignal, asked: Asked = {}): Promise<AgentSession> {
    // Each step below is given up on the moment the call is cancelled.
    const raceAbort = <T>(step: Promise<T>) => rejectOnAbort(step, signal);

    const { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader, ModelRuntime, getAgentDir, formatSkillsForPrompt } = await raceAbort(loadPi());
    const agentDir = getAgentDir();
    // Skills and prompt templates are pi's for the user and for where the agent works — the
    // project's own, in its .pi directory, among them: and a call has those it chose, and no others.
    const found: Found = { skills: [], templates: [] };
    const only = <T extends { name: string }>(choice: Choice, items: T[]): T[] => {
      const names = named(choice);
      return names ? items.filter(item => names.includes(item.name)) : items;
    };
    const resources = new DefaultResourceLoader({
      cwd,
      agentDir,
      noExtensions: true,
      noSkills: !chosen(asked.skills),
      noPromptTemplates: !chosen(asked.templates),
      skillsOverride: (base) => {
        found.skills = base.skills.map(skill => skill.name);
        return { ...base, skills: only(asked.skills, base.skills) };
      },
      promptsOverride: (base) => {
        found.templates = base.prompts.map(template => template.name);
        return { ...base, prompts: only(asked.templates, base.prompts) };
      },
      ...(systemPrompt && { appendSystemPrompt: [systemPrompt] }),
    });
    await raceAbort(resources.reload());

    // Extensions are the user's own, unless the call says the project's are its too: an extension
    // is code, and what a project holds its program can write. So they are loaded apart, by a
    // loader that takes of the project's what the call said it may, and the session has the rest
    // from the other. And so, where the project's are not the call's, an extension that asks is
    // told the project is not one to be trusted — pi has extensions ask that before they take
    // anything of a project's for their own. The session's settings are otherwise what any call's
    // are, the project's among them: a call does not come to other tools, or another shell, for
    // having asked for extensions.
    if (asked.extensions !== undefined && typeof asked.extensions !== "boolean" && asked.extensions !== "project") {
      throw new Error(`extensions is true, false or "project", not ${JSON.stringify(asked.extensions)}`);
    }
    // Whose extensions: the user's — or the project's with them, where the call says so. Then the project
    // is one to be trusted, as it is when pi is run in it and told to: its extensions are loaded, the
    // MCP servers it names are started, and an extension that asks is told so.
    const withProjects = asked.extensions === "project";
    let resourceLoader: ResourceLoader = resources;
    const wary = asked.extensions && !withProjects
      ? Object.assign(Object.create(SettingsManager.create(cwd, agentDir)) as Settings, { isProjectTrusted: () => false })
      : undefined;
    const extended: Extended | undefined = asked.extensions ? { puts: new Set(), over: false } : undefined;
    if (extended) {
      // A session that is to ask no more — its call cancelled, or over — is stopped each time it begins to
      // (see `ask`); and an extension may set it going again each time it stops, by more ways than one. All
      // of that is done without the runner coming to anything else: not to the clock that is to give the
      // call up, nor to any other run. So each beginning of such a session waits a turn of the runner's —
      // by a handler of trama's own among the extensions, which is what pi waits for when a run begins.
      // And where the agent's model is about to be asked for the first time — for a turn, or to sum a
      // conversation up — what the agent has by then is looked at from there too (see whyNotTheTools).
      const breathes: ExtensionFactory = (pi) => {
        pi.on("agent_start", async () => {
          if (extended.over || signal?.aborted) await new Promise(resolve => setImmediate(resolve));
        });
        const looks = () => {
          extended.look?.();
          extended.look = undefined;
        };
        pi.on("turn_start", looks);
        pi.on("session_before_compact", looks);
      };
      const builtIn = await raceAbort(builtInExtensions());
      // (What this process is, before anything of an extension's is loaded in it: see shapeOf.)
      asLoaded ??= shapeOf();
      const own = new DefaultResourceLoader({
        cwd,
        agentDir,
        extensionFactories: [...builtIn, breathes],
        settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: withProjects }),
        // (Nothing but its extensions is asked of it, and so it need find nothing else.)
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await raceAbort(own.reload());
      resourceLoader = {
        getExtensions: () => own.getExtensions(),
        getSkills: () => resources.getSkills(),
        getPrompts: () => resources.getPrompts(),
        getThemes: () => resources.getThemes(),
        getAgentsFiles: () => resources.getAgentsFiles(),
        getSystemPrompt: () => resources.getSystemPrompt(),
        getSystemPromptSource: () => resources.getSystemPromptSource(),
        getAppendSystemPrompt: () => resources.getAppendSystemPrompt(),
        getAppendSystemPromptSources: () => resources.getAppendSystemPromptSources(),
        extendResources: (paths) => resources.extendResources(paths),
        reload: async (options) => {
          await resources.reload(options);
          await own.reload();
        },
      };
    }

    // Resolve the model through pi's model runtime (built-in catalog plus the
    // user's models.json). The project's own, if it is unknown there, resolves
    // to undefined, in which case pi falls back to its own default selection;
    // a model a call names is that model or the call fails.
    const modelRuntime = await raceAbort(ModelRuntime.create({ signal }));
    const asking: Asking = { models: modelRuntime, seen: nothingYet(), answering: 0, readying: 0, cut: new AbortController(), over: false, gone: false, refusal: new AbortController() };
    watch(modelRuntime, asking);
    // (A call names it "provider/model": the provider's name ends at a stroke, and either name may have more of them.)
    const strokes = [...(asked.model ?? "").matchAll(/\//g)].map(stroke => stroke.index);
    const model = asked.model === undefined
      ? modelRuntime.getModel(this.config.provider, this.config.model)
      : strokes.map(at => modelRuntime.getModel(asked.model!.slice(0, at), asked.model!.slice(at + 1))).find(Boolean);
    if (asked.model !== undefined && !model) {
      throw new Error(`Unknown model "${asked.model}". A model is named "provider/model", as pi's model catalog has it.`);
    }

    // The caller's own tools are handed to pi as tools of pi's embedder — and named to it with the tools the
    // call named, where it named any: with a list of names, pi has a tool it is handed only where it is on the
    // list. A name pi would take for something else is refused first: pi's own tool by that name would be gone.
    const ownTools = asked.ownTools ?? [];
    if (ownTools.length > 0) {
      const pis = await raceAbort(pisOwnTools());
      for (const [at, { name }] of ownTools.entries()) {
        if (pis.has(name)) throw new Error(`The tool "${name}" cannot be the call's own: pi has a tool of that name.`);
        if (name.startsWith("mcp__")) throw new Error(`The tool "${name}" cannot be the call's own: a name that begins "mcp__" is a tool of an MCP server's.`);
        if (ownTools.findIndex(other => other.name === name) !== at) throw new Error(`Two of the call's own tools are named "${name}".`);
      }
    }

    // Keep a reference to the raw promise so we can clean up a late-arriving session
    const sessionPromise = createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model,
      sessionManager: SessionManager.inMemory(cwd),
      resourceLoader,
      ...(wary && { settingsManager: wary }),
      ...(asked.thinking !== undefined && { thinkingLevel: asked.thinking as AgentSession["thinkingLevel"] }),
      ...(asked.tools && { tools: [...asked.tools, ...ownTools.map(tool => tool.name)] }),
      ...(ownTools.length > 0 && { customTools: ownTools.map(asPisTool) }),
    });

    let session: AgentSession | undefined;
    // The telling of extensions that a session begins, while it lasts.
    let beginning: Promise<void> | undefined;
    const stopped = account(asking, asked, signal, () => session);
    // (A call that is cancelled asks no more — and what is being asked for it then is asked no further, whoever
    // asked: from here, while its session is being made — and let go of, should that fail. Once the session
    // is there, it is whoever has it who listens: see `serve`.)
    const offCut = onAbort(signal, () => asking.cut.abort());
    try {
      ({ session } = await raceAbort(sessionPromise));
      this.asking.set(session, asking);
      // A session that is set going again once its call is over, or stopped, is stopped as it begins to: a
      // command of an extension that asks the model once more, or what an extension starts while it is being
      // told that the call is over.
      if (asked.sofar || asked.extensions) {
        const here = session;
        here.subscribe((event) => {
          if (event.type !== "turn_start" && event.type !== "compaction_start") return;
          if (asking.over || stopped.aborted) void here.abort().catch(() => {});
        });
      }
      // An extension is told that its session has begun, as pi tells it where pi runs by itself:
      // that is when it sets itself up. What goes wrong in one later is said, and is not the call's failure.
      // A command of one can wait for the model it asked, as it can there; the session is one call's, and
      // is not to be left for another.
      if (extended) {
        const here = session;
        const stays = async () => ({ cancelled: true });
        // What an extension puts to the model — a command of it, asking — is the call's to wait for (see
        // `ask`), and the command's own, where it waits: pi calls a session idle while a question is still
        // on its way to being asked, so what was put is kept account of here, as it is put.
        const { puts } = extended;
        this.extended.set(session, extended);
        const prompting = session.prompt.bind(session);
        session.prompt = (text, options) => {
          const put = prompting(text, options);
          if (options?.source !== "extension") return put;
          const over = () => { puts.delete(put); };
          puts.add(put);
          put.then(over, over);
          return put;
        };
        // A command that waits is told, when it has waited, that its call was cancelled — where it was: one
        // that asks until it is satisfied then stops asking, and need not be stopped each time it begins to.
        const idle = async () => {
          while (puts.size > 0) await Promise.allSettled([...puts]);
          await here.waitForIdle();
          throwIfAborted(signal);
        };
        beginning = session.bindExtensions({
          mode: "print",
          commandContextActions: {
            waitForIdle: idle,
            newSession: stays,
            fork: stays,
            switchSession: stays,
            navigateTree: async (target, options) => ({ cancelled: (await here.navigateTree(target, options)).cancelled }),
            reload: () => here.reload(),
          },
          // (A command that was not let wait, its call being cancelled, did not fail: nothing is said of it.)
          onError: (failure) => {
            if (signal?.aborted && failure.error === "Aborted") return;
            console.warn(`[trama] an extension failed (${failure.extensionPath}): ${failure.error}`);
          },
        });
        await raceAbort(beginning);
      }
      // With no model it can use, pi reports a placeholder that is not in its
      // catalog — a model is named only when it is a real one.
      const picked = session.model;
      const serving = picked && modelRuntime.getModel(picked.provider, picked.id) ? nameOf(picked) : null;
      const refusal = whyNotAsAsked(session, asked, serving, found, formatSkillsForPrompt);
      if (refusal) throw new Error(refusal);
      if (!model) this.warnUnknownModel(serving);
      offCut();
      return session;
    } catch (err) {
      // A session that is here is let go of, once, before the call fails — its extensions, if they were
      // still being told that it begins, having heard that out first (or been given the while they are
      // given to hear of its end). Where the call was cancelled before the session came, it may still
      // come: it is disposed of when it does, and no extension was told of it.
      // The call is over, failed; and what its extensions asked a model, as they were told that the session
      // begins and that it is over, is what it used — said when the session is gone, as of any call.
      asking.over = true;
      if (extended) extended.over = true;
      try {
        if (session) {
          if (beginning) await within(beginning, EXTENSION_LEAVE_MS);
          await this.letGoOf(session, asked);
        } else {
          sessionPromise.then(({ session: late }) => late.dispose()).catch(() => {});
        }
      } finally {
        asking.gone = true;
        offCut();
        const usage = session && asked.used && usageOf(session, asking.seen);
        if (usage) asked.used!(usage);
      }
      throw err;
    }
  }

  /** What is kept of each session that has extensions. */
  private extended = new WeakMap<AgentSession, Extended>();
  /** Where trama stands when each session's model is asked. */
  private asking = new WeakMap<AgentSession, Asking>();

  /** Be done with a session: its extensions, where it has any, told first that it is over. */
  private async letGoOf(session: AgentSession, asked: Asked): Promise<void> {
    const asking = this.asking.get(session);
    try {
      if (asked.extensions) await leaveExtensions(session, this.extended.get(session)?.puts ?? new Set(), asking, longestAsked(session));
    } catch (err) {
      console.warn(`[trama] an extension could not be told its session is over: ${messageOf(err)}`);
    } finally {
      // What is still being asked on its account — it was waited for as long as anything is — is asked no
      // further; and has a moment to end, and say what it had used: that is the call's too.
      asking?.cut.abort();
      if (asking && asked.extensions) await allEnded(asking);
      session.dispose();
    }
  }

  /**
   * The configured provider/model is not in pi's catalog, so pi picked a model
   * on its own. Say so once — otherwise a typo silently runs a different model.
   */
  private warnUnknownModel(fallback: string | null): void {
    const requested = `${this.config.provider}/${this.config.model}`;
    if (warnedUnknownModels.has(requested)) return;
    warnedUnknownModels.add(requested);
    console.warn(
      `[trama] warning: model "${requested}" was not found in pi's model catalog. ` +
      (fallback
        ? `pi is falling back to "${fallback}". `
        : `pi has no fallback model available, so LLM calls will fail. `) +
      `Check "provider" and "model" in ~/.trama/config.json or the project's meta.json.`
    );
  }

  /**
   * Serve a call in this process: run one prompt in a fresh session and
   * return the assistant's text reply. (What a host does; and what `ask`
   * does itself for a call without extensions.)
   *
   * Cancellation during `createSession` is handled step-by-step inside it; once
   * `session.prompt()` is running, a cancelled call has pi abort the run — which
   * settles the prompt (pi 1.x resolves it rather than rejecting, so
   * `signal.aborted` is checked again when `prompt()` returns) and leaves on
   * the session's record what the request that was cut off had taken by then.
   */
  async serve(prompt: string, call: AgentCall): Promise<string> {
    const { cwd, system, signal, used, sofar } = call;
    throwIfAborted(signal);

    const session = await this.createSession(cwd, system, signal, call);
    // (A call that is cancelled asks no more — and what is being asked for it then is asked no further, whoever
    // asked: while it is at its work, and while its extensions are told that it is over.)
    const offCut = onAbort(signal, () => this.asking.get(session)?.cut.abort());
    let offAbort = () => {};
    // What is kept of the call where its model is asked (see `account`): whether it has come to its end, and
    // whether its session is gone. (A session that was not made here has nothing asked on its account that
    // is seen: what is kept of its call is then kept here alone.)
    const asking = this.asking.get(session);
    const its: Pick<Asking, "over" | "gone" | "refusal"> = asking ?? { over: false, gone: false, refusal: new AbortController() };
    // What is kept of the session beside it, where it has extensions.
    const extended = this.extended.get(session);
    // Why the call cannot have the tools it named, where that was found as its run began. It is
    // then stopped as a cancelled call is — it asks nothing, and what would hold it is not waited
    // for long — and fails with that.
    let refused: string | undefined;
    const stopped = asking?.stop ?? (signal ? AbortSignal.any([signal, its.refusal.signal]) : its.refusal.signal);

    try {
      throwIfAborted(signal);
      offAbort = onAbort(signal, () => { session.abort().catch(() => {}); });
      // Where the agent has not the tools the call named, that is found as its run begins (see
      // createSession), and the call is stopped as one that was cancelled is.
      if (extended && call.extensions) {
        extended.look = () => {
          refused = whyNotTheTools(session, call);
          if (refused === undefined) return;
          // (The session is stopped where it hears next that a turn begins — just after this: see createSession.)
          extended.over = true;
          its.refusal.abort();
        };
      }
      if (!asking && (sofar || call.extensions)) {
        session.subscribe((event) => {
          if (event.type !== "turn_start" && event.type !== "compaction_start") return;
          if (its.over || stopped.aborted) void session.abort().catch(() => {});
        });
      }

      // The prompt is a program's text, whatever it begins with — but where the call has the user's skills,
      // templates or extensions, and does not say its prompt is text all the same: each of those has a line of
      // its own to be called up by ("/skill:name", "/name", a command), and pi reads a prompt for all of them
      // or for none.
      let taken = false;
      const answered = async () => {
        await session.prompt(prompt, {
          expandPromptTemplates: !call.asText && (chosen(call.skills) || chosen(call.templates) || Boolean(call.extensions)),
          preflightResult: (how) => { taken = how === "handled"; },
        });
        // A command that asked the model has the model's answer be the call's: what it put to the model is
        // waited for — also where the command itself did not wait, or pi had not yet set the run going.
        const puts = this.extended.get(session)?.puts;
        while (puts && puts.size > 0) await Promise.allSettled([...puts]);
        if (taken) await session.waitForIdle();
      };
      await notHeld(answered(), stopped, HELD_MS).catch((err) => { if (refused === undefined) throw err; });
      // (What the call cannot have as it asked is its failure, found before the model was asked anything.)
      if (refused !== undefined) throw new Error(refused);
      // An aborted prompt resolves with no usable answer — report it as an abort,
      // not as an empty LLM response.
      throwIfAborted(signal);
      return endedWith(session, call.ownTools) ?? answerOf(session, taken);
    } finally {
      offAbort();
      its.over = true;
      if (extended) extended.over = true;
      try {
        await this.letGoOf(session, call);
      } finally {
        // What the call used is said when all is over that could use anything on its account, however it
        // ended. (Whoever counts has not waited for this: they were told as each reply came.)
        its.gone = true;
        offCut();
        const usage = used && usageOf(session, this.asking.get(session)?.seen);
        if (usage) used(usage);
      }
    }
  }
}
