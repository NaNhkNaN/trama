// An agent from outside, asked for a piece of work: somebody else's harness,
// whole — its own loop, its own tools, its own login — started as a process
// and spoken with by the Agent Client Protocol (agentclientprotocol.com),
// version 1: JSON-RPC, a message to a line, on the agent's stdio.
//
// It is a black box and is treated as one. A prompt goes in; what it said
// comes out, with how that went. Nothing it does in between is held: not what
// it spends, not what it touches — it is asked nothing it does not offer, and
// granted what it asks. What is held is the run's own: how long the call may
// take, and that the agent is gone when the call or the run is over. And all
// of it is said in the result, as it was: what the agent is, how what was
// asked was in fact given, what it said it used.
//
// Everything that knows the protocol is in this file. No SDK is used: a
// client needs six of the protocol's methods, and they are here.

import { spawn, type ChildProcess } from "child_process";
import { existsSync, readFileSync } from "fs";
import { createInterface } from "readline";
import { onAbort } from "./abort.js";
import { checkedEnv } from "./child-process.js";
import { messageOf } from "./errors.js";
import { isJsonObject } from "./serializable.js";
import type { AgentResult, OutsideAgent } from "./types.js";

const PROTOCOL = 1;
/** How long a call may take where it does not say: ten minutes. An agent is slow before it does anything. */
export const DEFAULT_AGENT_TIMEOUT = 600_000;
/** How long an agent told to stop is given to do so; how long one that is done is given to go by itself; how long what it last wrote is waited for. */
const CANCEL_GRACE_MS = 5000, LEAVE_GRACE_MS = 2000, DRAIN_MS = 1000;
/** How much of what an agent wrote to stderr goes into the message of a failure: its end. */
const STDERR_KEPT = 2000;
/** The protocol's codes: a login is wanted; there is no such method. */
const NEEDS_LOGIN = -32000, NO_SUCH_METHOD = -32601;

const VERSION: string = (() => {
  try {
    return String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version);
  } catch {
    return "0";
  }
})();

/** What starts an agent, held to what that is — or an error saying what of it is not. */
export function checkedAgent(agent: unknown): OutsideAgent {
  if (!isJsonObject(agent)) throw new TypeError("expected what starts it — { command, args?, env? }");
  const other = Object.keys(agent).find(name => !["command", "args", "env"].includes(name));
  if (other !== undefined) throw new TypeError(`${JSON.stringify(other)} is nothing an agent is started with (command, args, env)`);
  if (typeof agent.command !== "string" || agent.command === "") throw new TypeError(`"command" must be a non-empty string`);
  if (agent.args != null && !(Array.isArray(agent.args) && agent.args.every(arg => typeof arg === "string"))) throw new TypeError(`"args" must be a list of strings`);
  return {
    command: agent.command,
    ...(agent.args != null && { args: agent.args as string[] }),
    ...(agent.env != null && { env: checkedEnv(agent.env) }),
  };
}

/** The agents a configuration names, each held to what starts one. */
export function checkedAgents(agents: unknown): Record<string, OutsideAgent> {
  if (!isJsonObject(agents)) throw new TypeError(`"agents" must be an object: each agent by a name, and what starts it`);
  return Object.fromEntries(Object.entries(agents).map(([name, agent]) => {
    try {
      return [name, checkedAgent(agent)];
    } catch (err) {
      throw new TypeError(`"agents": ${name}: ${messageOf(err)}`);
    }
  }));
}

/** A call as it is carried out: what was asked, held to what a call may ask, and the agent found. */
export interface AskedOfAgent {
  prompt: string;
  agent: OutsideAgent;
  cwd?: string;
  timeout: number;
  system?: string;
  model?: string;
  session?: string;
}

/** Read a call: what is wrong with it is said before anything is started. `agents`: those the configuration names. */
export function checkedAsk(prompt: unknown, options: unknown, agents: Record<string, OutsideAgent> = {}): AskedOfAgent {
  if (typeof prompt !== "string" || prompt === "") throw new TypeError("prompt: expected text that is not empty");
  const given = isJsonObject(options) ? options : {};
  let agent: OutsideAgent;
  if (typeof given.agent === "string") {
    if (!Object.hasOwn(agents, given.agent)) {
      throw new TypeError(`No agent is named ${JSON.stringify(given.agent)} in the configuration ("agents"): it names ${Object.keys(agents).join(", ") || "none"}.`);
    }
    agent = agents[given.agent];
  } else if (isJsonObject(given.agent)) {
    try {
      agent = checkedAgent(given.agent);
    } catch (err) {
      throw new TypeError(`agent: ${messageOf(err)}`);
    }
  } else {
    throw new TypeError("agent: expected the name of one in the configuration, or the command that starts one");
  }
  const timeout = given.timeout ?? DEFAULT_AGENT_TIMEOUT;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) throw new TypeError("timeout: expected a positive number of milliseconds");
  for (const name of ["cwd", "system", "model", "session"] as const) {
    if (given[name] != null && typeof given[name] !== "string") throw new TypeError(`${name}: expected text`);
  }
  const text = (name: "cwd" | "system" | "model" | "session") => (given[name] == null ? undefined : { [name]: given[name] as string });
  return { prompt, agent, timeout, ...text("cwd"), ...text("system"), ...text("model"), ...text("session") };
}

/** Where what an agent said of itself as it worked is written down, under the call. */
export interface Said {
  tool(title: string, kind?: string): void;
  permission(what: string, answer: "allow_once" | "reject_once" | "cancelled"): void;
  /** `session`: whose conversation it is — a cost is said of that, so far (see AgentResult). */
  usage(usage: NonNullable<AgentResult["usage"]>, session?: string): void;
}

/** What a call is carried out with, that is the run's and not the call's. */
export interface AskedWith {
  /** The variables a shell command of the run's has: the agent's own go over them. */
  env: Record<string, string | undefined>;
  /** The run's end: the agent is stopped with it, and the call throws. */
  signal?: AbortSignal;
  /** List the agent's process group as the run's, to be stopped with it. Returns what stops it for good and takes it off the list. */
  listed(pgid: number): () => Promise<void>;
  said?: Said;
}

/** An error the agent answered a request with. */
class Refusal extends Error {
  constructor(readonly code: unknown, message: string) { super(message); }
}
/** The agent's process ended — or could not be started — with requests unanswered. */
class Gone extends Error {
  constructor(readonly how: string, readonly notFound = false) { super(how); }
}

const numberOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const textOf = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
/** The values a choice offers: listed, or listed in groups. */
const valuesOf = (options: unknown): string[] =>
  (Array.isArray(options) ? options.flatMap(option => (!isJsonObject(option) ? [] : typeof option.value === "string" ? [option.value] : valuesOf(option.options))) : []);
const defined = <T extends object>(fields: T): Partial<T> => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;

/**
 * Have the agent do what is asked: start it, open a session or go on with
 * one, send the prompt, gather what it says until the turn is over — and
 * end it. Resolves with the result, also where the call did not go through
 * (see AgentResult); rejects only where the run was stopped.
 */
export async function askOutside(asked: AskedOfAgent & { cwd: string }, how: AskedWith): Promise<AgentResult> {
  const { agent } = asked, { said } = how;

  // What is known so far, of the agent and of the call: the result is made of it, however the call ends.
  // (What it said: each message of its own apart, in order.)
  const messages: string[] = [];
  let stopReason: string | undefined, sessionId: string | undefined, resumed: "resume" | "load" | undefined;
  let system: AgentResult["given"]["system"] = "none", model: { asked: string; set: boolean } | undefined;
  let tokens: Record<string, number | undefined> | undefined, cost: { amount: number; currency: string } | undefined, context: { used: number; size: number } | undefined;
  const permissions = { granted: 0, refused: 0 };
  const calls: Array<{ id: unknown; title: string; kind?: string; status?: string }> = [];
  const itself: AgentResult["agent"] = { resumes: false, takesSystem: false };
  const usage = () => {
    const used = { ...defined(tokens ?? {}), ...(cost && { cost }), ...(context && { context }) } as NonNullable<AgentResult["usage"]>;
    return Object.keys(used).length > 0 ? used : undefined;
  };
  const result = (failure?: AgentResult["failure"]): AgentResult => ({
    ok: failure === undefined,
    text: messages.join("\n\n"),
    messages: [...messages],
    ...(stopReason !== undefined && { stopReason: stopReason as AgentResult["stopReason"] }),
    ...(failure && { failure }),
    ...(sessionId !== undefined && { session: sessionId }),
    ...(usage() && { usage: usage() }),
    toolCalls: calls.map(({ title, kind, status }) => ({ title, ...defined({ kind, status }) })),
    given: { system, ...(model && { model }), ...(resumed && { resumed }), permissions },
    agent: itself,
  });

  if (!existsSync(asked.cwd)) return result({ kind: "failed", message: `There is no such directory to start it in: ${asked.cwd}` });

  let child: ChildProcess;
  try {
    child = spawn(agent.command, agent.args ?? [], { cwd: asked.cwd, env: { ...how.env, ...agent.env }, stdio: ["pipe", "pipe", "pipe"], detached: true });
  } catch (err) {
    return result({ kind: "failed", message: `It could not be started: ${messageOf(err)}` });
  }
  // (Its own process group: what it starts is stopped with it. Listed at once, as a shell command's is.)
  const stopGroup = child.pid ? how.listed(child.pid) : async () => {};
  let stopping: Promise<void> | undefined;
  const stop = () => (stopping ??= stopGroup());

  // --- The line to it: requests of ours and their answers, requests of its own, and what it says as it goes. ---
  let errors = "";
  child.stderr?.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString("utf-8")).slice(-STDERR_KEPT); });
  child.stdin?.on("error", () => {}); // (written to after it went: the going is what is reported)
  const write = (message: Record<string, unknown>) => {
    if (child.stdin?.writable) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const waiting = new Map<number, { resolve(value: unknown): void; reject(why: Error): void }>();
  let lastId = 0, gone: Gone | undefined;
  const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    if (gone) return reject(gone);
    waiting.set(++lastId, { resolve, reject });
    write({ id: lastId, method, params });
  });
  const leave = (why: Gone) => {
    gone ??= why;
    for (const { reject } of waiting.values()) reject(gone);
    waiting.clear();
  };
  child.on("error", (err: NodeJS.ErrnoException) => leave(new Gone(messageOf(err), err.code === "ENOENT")));
  const exited = new Promise<void>((resolve) => child.on("exit", (code, signal) => {
    resolve();
    // (What it wrote last may still be on its way: waited for, a moment — not for as long as something it started holds the pipe.)
    const over = () => leave(new Gone(code !== null ? `exit code ${code}` : `killed by ${signal}`));
    if (!child.stdout || child.stdout.closed) return over();
    child.stdout.once("close", over);
    setTimeout(over, DRAIN_MS).unref();
  }));

  // Told only once the prompt is sent: what a session that is loaded says before that is the old conversation, over again.
  let gathering = false;
  // What it says comes in pieces, and in more than one message: what it is about to do, and — after the tools it
  // called — its answer. One message is told from the next by its id, where the agent gives one, and by a tool
  // called between two things said: each is kept apart, and not run together with the next.
  let lastMessage: string | undefined, toolSince = false;
  const heard = (update: Record<string, unknown>) => {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (!isJsonObject(update.content) || update.content.type !== "text" || typeof update.content.text !== "string") break;
        const message = textOf(update.messageId);
        const another = toolSince || (message !== undefined && lastMessage !== undefined && message !== lastMessage);
        if (messages.length === 0 || another) messages.push("");
        messages[messages.length - 1] += update.content.text;
        lastMessage = message ?? lastMessage;
        toolSince = false;
        break;
      }
      case "tool_call": {
        toolSince = true;
        const call = { id: update.toolCallId, title: textOf(update.title) ?? "", ...defined({ kind: textOf(update.kind), status: textOf(update.status) }) };
        calls.push(call);
        said?.tool(call.title, call.kind);
        break;
      }
      case "tool_call_update": {
        const call = calls.find(one => one.id === update.toolCallId);
        if (call) Object.assign(call, defined({ title: textOf(update.title), kind: textOf(update.kind), status: textOf(update.status) }));
        break;
      }
      case "usage_update": {
        const used = numberOf(update.used), size = numberOf(update.size);
        if (used !== undefined && size !== undefined) context = { used, size };
        if (isJsonObject(update.cost) && numberOf(update.cost.amount) !== undefined && typeof update.cost.currency === "string") {
          cost = { amount: update.cost.amount as number, currency: update.cost.currency };
        }
        break;
      }
    }
  };
  /** A permission the agent asks: granted for the once, where that is offered; refused for the once, where it is not. Never for always. */
  const permit = (id: unknown, params: Record<string, unknown>) => {
    const offered = Array.isArray(params.options) ? params.options.filter(isJsonObject) : [];
    const option = offered.find(one => one.kind === "allow_once") ?? offered.find(one => one.kind === "reject_once");
    const answer = option === undefined ? "cancelled" : (option.kind as "allow_once" | "reject_once");
    permissions[answer === "allow_once" ? "granted" : "refused"] += 1;
    said?.permission(isJsonObject(params.toolCall) ? textOf(params.toolCall.title) ?? "" : "", answer);
    write({ id, result: { outcome: option === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId: option.optionId } } });
  };
  createInterface({ input: child.stdout! }).on("line", (line) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return; // (what is no message: an agent may say what it likes on its way up)
    }
    if (!isJsonObject(message)) return;
    if (typeof message.method === "string") {
      const params = isJsonObject(message.params) ? message.params : {};
      if (message.id === undefined || message.id === null) {
        if (message.method === "session/update" && gathering && isJsonObject(params.update)) heard(params.update);
      } else if (message.method === "session/request_permission") {
        permit(message.id, params);
      } else {
        // (A client that offers nothing has nothing to be asked for.)
        write({ id: message.id, error: { code: NO_SUCH_METHOD, message: `Method not found: ${message.method}` } });
      }
      return;
    }
    const asker = waiting.get(message.id as number);
    if (!asker) return;
    waiting.delete(message.id as number);
    if (isJsonObject(message.error)) asker.reject(new Refusal(message.error.code, textOf(message.error.message) ?? "the agent answered with an error it did not put into words"));
    else asker.resolve(message.result);
  });

  // --- What holds it: the time the call has, and the run. ---
  let timedOut = false, stopped = false, answered = false, prompting = false, resuming = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // Told to stop, where it is at work on a prompt, and given a moment to; then stopped.
    if (prompting && sessionId !== undefined) {
      write({ method: "session/cancel", params: { sessionId } });
      setTimeout(() => void stop(), CANCEL_GRACE_MS).unref();
    } else {
      void stop();
    }
  }, asked.timeout);
  const offStop = onAbort(how.signal, () => {
    stopped = true;
    void stop();
  });

  const wrote = () => (errors.trim() ? `\nWhat it wrote as it went:\n${errors.trim()}` : "");
  try {
    const hello = await request("initialize", { protocolVersion: PROTOCOL, clientCapabilities: {}, clientInfo: { name: "trama", version: VERSION } });
    answered = true;
    const capabilities = isJsonObject(hello?.agentCapabilities) ? hello.agentCapabilities : {};
    const ofSessions = isJsonObject(capabilities.sessionCapabilities) ? capabilities.sessionCapabilities : {};
    const canResume = isJsonObject(ofSessions.resume), canLoad = capabilities.loadSession === true;
    Object.assign(itself, defined({ name: textOf(hello?.agentInfo?.name), version: textOf(hello?.agentInfo?.version) }), {
      resumes: canResume || canLoad,
      takesSystem: isJsonObject(ofSessions.systemPrompt),
    });
    if (hello?.protocolVersion !== PROTOCOL) {
      return result({ kind: "refused", message: `It speaks version ${JSON.stringify(hello?.protocolVersion)} of the protocol, and this client version ${PROTOCOL}.` });
    }

    // A session: a new one, or an earlier one gone on with — by whichever way the agent says it has.
    const asSystem = asked.system !== undefined && itself.takesSystem;
    system = asked.system === undefined ? "none" : asSystem ? "as-system" : "in-prompt";
    const opening = { cwd: asked.cwd, mcpServers: [], ...(asSystem && { systemPrompt: { mode: "append", content: [{ type: "text", text: asked.system }] } }) };
    let opened: any;
    if (asked.session !== undefined) {
      if (!canResume && !canLoad) return result({ kind: "refused", message: "It does not go on with a conversation: it says it neither resumes one nor loads one." });
      resuming = true;
      opened = await request(canResume ? "session/resume" : "session/load", { sessionId: asked.session, ...opening });
      resuming = false;
      sessionId = asked.session;
      resumed = canResume ? "resume" : "load";
    } else {
      opened = await request("session/new", opening);
      sessionId = textOf(opened?.sessionId);
      if (sessionId === undefined) return result({ kind: "failed", message: "It opened a session and gave it no id." });
    }

    // Its model is its own. The one the call names is for an agent that has none: set where it is on offer, and only then.
    const choice = (Array.isArray(opened?.configOptions) ? opened.configOptions : []).filter(isJsonObject).find((option: Record<string, unknown>) => option.category === "model");
    if (choice) {
      itself.models = valuesOf(choice.options);
      let serving = textOf(choice.currentValue);
      if (asked.model !== undefined && serving === undefined && itself.models.includes(asked.model)) {
        await request("session/set_config_option", { sessionId, configId: choice.id, value: asked.model });
        serving = asked.model;
        model = { asked: asked.model, set: true };
      }
      if (serving !== undefined) itself.model = serving;
    }
    if (asked.model !== undefined) model ??= { asked: asked.model, set: false };

    // The prompt — with what was to be the system prompt at its head, where the agent takes none.
    gathering = prompting = true;
    const reply = await request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: system === "in-prompt"
        ? `[Standing instructions, from whoever asked for this work: they hold for all of it.]\n${asked.system}\n\n[The work asked for]\n${asked.prompt}`
        : asked.prompt }],
    });
    prompting = false;
    stopReason = textOf(reply?.stopReason);
    if (isJsonObject(reply?.usage)) {
      const used = reply.usage;
      tokens = {
        input: numberOf(used.inputTokens), output: numberOf(used.outputTokens), total: numberOf(used.totalTokens),
        cacheRead: numberOf(used.cachedReadTokens), cacheWrite: numberOf(used.cachedWriteTokens), thought: numberOf(used.thoughtTokens),
      };
    }
    if (timedOut) return result({ kind: "timed-out", message: `It was not done after the ${asked.timeout}ms it was given, and was told to stop.` });
    if (stopReason === "end_turn") return result();
    if (stopReason === "refusal") return result({ kind: "refused", message: "The agent refused the work." });
    return result({ kind: "failed", message: `The turn ended otherwise than a turn does: ${stopReason ?? "it was not said why"}.` });
  } catch (err) {
    if (stopped) throw new Error("The run was stopped while an agent from outside was at work");
    if (timedOut) return result({ kind: "timed-out", message: `It was not done after the ${asked.timeout}ms it was given, and was stopped.` });
    if (err instanceof Refusal) {
      return result({ kind: err.code === NEEDS_LOGIN ? "not-logged-in" : resuming ? "refused" : "failed", message: err.message });
    }
    if (err instanceof Gone) {
      if (err.notFound) return result({ kind: "not-installed", message: `There is no such command: ${agent.command} (${err.how})` });
      return result(answered
        ? { kind: "failed", message: `It ended in the middle of the work (${err.how}).${wrote()}` }
        : { kind: "not-installed", message: `It ended before it answered (${err.how}).${wrote()}` });
    }
    return result({ kind: "failed", message: messageOf(err) });
  } finally {
    clearTimeout(timer);
    offStop();
    const used = usage();
    if (used) said?.usage(used, sessionId);
    // Done with: it is let go by itself for a moment (its input ends), and then it and what it started are stopped.
    child.stdin?.end();
    if (!stopping && child.pid) await Promise.race([exited, new Promise(resolve => setTimeout(resolve, LEAVE_GRACE_MS).unref())]);
    await stop();
  }
}
