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
// runner: nothing here knows what pi is.

import { PiAdapter } from "./pi-adapter.js";
import { CutOff, type AgentCall, type AgentUsage } from "./agent-backend.js";
import type { ModelConfig } from "./runner-types.js";
import { messageOf } from "./errors.js";
import { groupsUnder, signalGroup } from "./stopping.js";

/** What a call is made of that can be sent: all of it but where to say what it used, and what cancels it. */
export type SentCall = Omit<AgentCall, "signal" | "used" | "sofar" | "had">;

/**
 * What a runner says to a host: a call to serve; that the call it is serving
 * may go on, having said what it has used so far; or that it is cancelled.
 */
export type ToHost = { ask: { config: ModelConfig; prompt: string; call: SentCall } } | { go: true } | { abort: true };

/**
 * What a host says to its runner: that it is there; what the call has used
 * so far, where its model is about to be asked again (and the host waits to
 * hear that it may be); what it has used, as each reply of its model's has
 * come (which nothing waits for: it is what is known of the call if this
 * process has to be ended); what it used in the end; and how the call ended —
 * its answer, an answer cut off at the output limit (with what there was of
 * it), or its failure.
 */
export type FromHost =
  | { ready: true }
  | { sofar: AgentUsage }
  | { had: AgentUsage }
  | { used: AgentUsage }
  | { answer: string }
  | { cutOff: string }
  | { error: string };

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
let goOn: (() => void) | undefined;
const answered = () => {
  goOn?.();
  goOn = undefined;
};
/** Whether this process has been told to end. What it was serving is then stopped, and how that ended is not said: its runner hears that the process did. */
let leaving = false;

process.on("message", (message: ToHost) => {
  if ("go" in message) return answered();
  if ("abort" in message) {
    cancel?.abort();
    return answered();
  }
  // (A process that has been told to end serves nothing more: whoever asked hears that it ended.)
  if (leaving) return;
  const { config, prompt, call } = message.ask;
  const serving = cancel = new AbortController();
  new PiAdapter(config).serve(prompt, {
    ...call,
    signal: serving.signal,
    used: (usage) => say({ used: usage }),
    had: (usage) => say({ had: usage }),
    sofar: (usage) => new Promise<void>((resolve) => {
      goOn = resolve;
      say({ sofar: usage });
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
  answered();
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
