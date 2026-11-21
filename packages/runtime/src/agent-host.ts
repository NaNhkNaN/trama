// A pi in a process of its own: what serves an agent call that has extensions.
//
// An extension is somebody's code, and pi runs it where pi runs. In the
// runner that is where every run of a tree is carried, counted and stopped
// from — so there a call with extensions is not served: it is handed to a
// process like this one (see agent-hosts.ts), which can be put an end to,
// and whose end is one call's failure and nothing else's.
//
// One call at a time, asked for and answered over the channel to the runner
// that started this process. The serving is the adapter's, as it is in a
// runner: nothing here knows what pi is. And the call's model is asked over
// the same channel, where it can be (see model-relay.ts): by the runner,
// where no extension is.

import { PiAdapter } from "./pi-adapter.js";
import { CutOff, type AgentCall, type AgentUsage, type OwnTool, type ToolAnswer } from "./agent-backend.js";
import type { ModelConfig } from "./runner-types.js";
import { messageOf } from "./errors.js";
import { createModelRelay, relayClient, relayServer, withRepliesWhole, type RelayAnswered, type RelayAsked } from "./model-relay.js";
import { groupsUnder, signalGroup } from "./stopping.js";

/**
 * What a call is made of that can be sent: all of it but where to say what
 * it used, and what cancels it — and, of the tools of its caller's own, what
 * each declares: to have one run, a host asks its runner (below).
 */
export type SentCall = Omit<AgentCall, "signal" | "used" | "sofar" | "had" | "relay" | "ownTools"> & { ownTools?: Array<Omit<OwnTool, "run">> };

/** A use of a tool of the caller's own, as a host asks its runner for it: `key` is how the two speak of it. */
export interface ToolAsked { key: string; name: string; id: string; args: unknown }

/**
 * What a runner says to a host: a call to serve; that the call it is serving
 * may go on, having said what it has used so far; that it is cancelled; and
 * what a model answers that the call had asked by its runner (see
 * model-relay.ts). And to a host that serves no call, but asks models for
 * the calls of others — the runner's own, where the run was given variables,
 * which a process is to be started with to ask by them: what to ask. And
 * what a tool of the caller's own answered, that the call's model had called.
 */
export type ToHost =
  | { ask: { config: ModelConfig; prompt: string; call: SentCall } }
  | { go: boolean }
  | { abort: true }
  | { tooled: { key: string; answer: ToolAnswer } }
  | RelayAnswered
  | RelayAsked;

/**
 * What a host says to its runner: that it is there; what the call has used
 * so far, where its model is about to be asked again (and the host waits to
 * hear that it may be); what it has used, as each reply of its model's has
 * come (which nothing waits for: it is what is known of the call if this
 * process has to be ended); what it used in the end; how the call ended —
 * its answer, an answer cut off at the output limit (with what there was of
 * it), or its failure; and what the call would have a model asked (or, of a
 * host that asks for others: what the model answered). And that the call's
 * model has called a tool of the caller's own — which is the runner's to
 * have run. (That such a use is to go no further is not said: it is when the
 * call is cancelled, or over, and the runner knows of both.)
 */
export type FromHost =
  | { ready: true }
  | { sofar: AgentUsage; answered?: true }
  | { had: AgentUsage }
  | { used: AgentUsage }
  | { answer: string }
  | { cutOff: string }
  | { error: string }
  | { tool: ToolAsked }
  | RelayAsked
  | RelayAnswered;

const say = (message: FromHost): void => {
  // (A runner that is gone is told nothing: this process is on its way out with it.)
  if (process.connected) process.send?.(message);
};

/** Cancels the call being served. */
let cancel: AbortController | undefined;
/**
 * Lets the call being served go on to ask its model again. It has said what
 * it used so far, and whoever counts that is in the runner: the model is not
 * asked before the runner has said whether the call is to go on.
 */
let goOn: ((go: boolean) => void) | undefined;
const answered = (go: boolean) => {
  goOn?.(go);
  goOn = undefined;
};
/** The end that asks, of what the call being served has its model asked by: this process's runner. */
const asks = relayClient(say);
/** The end that answers, where this process is one that asks models for the calls of others: with its own pi, and the keys it was started with. */
let answers: ReturnType<typeof relayServer> | undefined;
/** The uses of the caller's own tools that the call being served waits for, each by its key. */
const uses = new Map<string, (answer: ToolAnswer) => void>();
let used = 0;
/**
 * A tool of the caller's own, as this process has it: each use is asked of
 * the runner, which has the tool. (A use whose call is cancelled meanwhile
 * is not waited for by whoever asked it here — see asPisTool — and its
 * answer, should one come, is nobody's.)
 */
const askedOfRunner = (tool: Omit<OwnTool, "run">): OwnTool => ({
  ...tool,
  run: (args, id) => new Promise<ToolAnswer>((resolve) => {
    const key = String(++used);
    uses.set(key, resolve);
    say({ tool: { key, name: tool.name, id, args } });
  }),
});

/** Whether this process has been told to end. What it was serving is then stopped, and how that ended is not said: its runner hears that the process did. */
let leaving = false;

process.on("message", (message: ToHost) => {
  if ("go" in message) return answered(message.go);
  if ("abort" in message) {
    cancel?.abort();
    return answered(false);
  }
  if ("tooled" in message) {
    uses.get(message.tooled.key)?.(message.tooled.answer);
    uses.delete(message.tooled.key);
    return;
  }
  if ("relayed" in message) return asks.heard(message.relayed);
  if ("relay" in message || "relayAbort" in message) return (answers ??= relayServer(createModelRelay(), say)).heard(message);
  // (A process that has been told to end serves nothing more: whoever asked hears that it ended.)
  if (leaving) return;
  const { config, prompt, call } = message.ask;
  const serving = cancel = new AbortController();
  uses.clear();
  new PiAdapter(config).serve(prompt, {
    ...call,
    ownTools: call.ownTools?.map(askedOfRunner),
    signal: serving.signal,
    used: (usage) => say({ used: usage }),
    had: (usage) => say({ had: usage }),
    relay: withRepliesWhole(asks.relay),
    sofar: (usage, has) => new Promise<boolean>((resolve) => {
      goOn = resolve;
      say({ sofar: usage, ...(has && { answered: true }) });
    }),
  }).then(
    (answer) => { if (!leaving) say({ answer }); },
    (err) => { if (!leaving) say(err instanceof CutOff ? { cutOff: err.text } : { error: messageOf(err) }); },
  );
});

// The runner is gone, or has no more use for this process — it says so, or its watchdog does, by asking
// this process to end: there is nothing left to serve. What this process has under it in groups of their
// own — an MCP server, what an agent was running — goes first: nobody else knows of it, once this process
// is gone. (This process's own group is its runner's to end, or the watchdog's; and a process that cannot
// hear either is ended without being asked again, when the time anything asked to stop is given is up.)
// And the call it is serving is stopped first, where it is: the system takes a moment to say what is
// under this process, and in that moment the call is not to go on — to ask its model again, or to answer.
const leave = (asked?: NodeJS.Signals) => {
  if (leaving) return;
  leaving = true;
  cancel?.abort();
  answered(false);
  void groupsUnder(process.pid).then((groups) => {
    for (const group of groups) signalGroup(group, "SIGKILL");
    // (Asked to end, it ends as what was asked to: whoever waits for it is told how it went.)
    if (!asked) process.exit(0);
    process.removeAllListeners(asked);
    process.kill(process.pid, asked);
  });
};
process.on("disconnect", () => leave());
process.on("SIGTERM", leave);

say({ ready: true });
