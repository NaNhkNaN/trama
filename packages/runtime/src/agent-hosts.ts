// The runner's side of agent-host.ts: the processes that serve its agent
// calls with extensions, started as they are needed and kept while they can
// be used again.
//
// A host serves one call at a time. A call takes a host that is free, or
// starts one; when it has been answered the host is free again — pi is
// loaded once for the calls of a run that follow one another, and once for
// each that is made beside another. A call that is cancelled is asked to
// stop, as it is in the runner, and given the time anything asked to stop is
// given: a host that has not let go of it by then — its extension does not
// return, or goes round without end — is put an end to, with all it started.
// That is one call's failure. No other call was in that process.

import { fork, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import { onAbort, throwIfAborted } from "./abort.js";
import { CutOff, type AgentCall, type AgentUsage } from "./agent-backend.js";
import type { FromHost, SentCall, ToHost } from "./agent-host.js";
import { messageOf } from "./errors.js";
import type { ModelConfig } from "./runner-types.js";
import { KILL_GRACE_MS, groupsUnder, requireWatchdog, stopGroups, stopWithThisProcess } from "./stopping.js";

const HOST = fileURLToPath(new URL("./agent-host.js", import.meta.url));

/**
 * What a host said, if it is something a host says. The channel is the
 * host's process's, and so is in the reach of whatever runs there — an
 * extension, which may write to it by mistake (`process.send("ready")` is
 * what many a library says to whatever started it) or on purpose. Anything
 * that is not of the protocol is passed over: it is not for a word on the
 * channel to fail a runner.
 */
function saidBy(message: unknown): FromHost | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const said = message as Record<string, unknown>;
  const counted = (usage: unknown): usage is AgentUsage => typeof usage === "object" && usage !== null;
  if (said.ready === true) return { ready: true };
  if (counted(said.sofar)) return { sofar: said.sofar };
  if (counted(said.had)) return { had: said.had };
  if (counted(said.used)) return { used: said.used };
  if (typeof said.answer === "string") return { answer: said.answer };
  if (typeof said.cutOff === "string") return { cutOff: said.cutOff };
  if (typeof said.error === "string") return { error: said.error };
  return undefined;
}

interface Host {
  process: ChildProcess;
  /** Resolves when the host has said it is there; rejects if it ends, or cannot be started, before that. */
  ready: Promise<void>;
  /** Resolves when its process has ended. */
  ended: Promise<void>;
  /** Whether its process has ended, or it has been told to. */
  gone: boolean;
  /** Resolves when all it started has been stopped — once it has been told to end. */
  stopped?: Promise<void>;
}

export interface AgentHosts {
  /** Have a host serve one call, as the adapter would (see AgentBackend.ask). */
  ask(config: ModelConfig, prompt: string, call: AgentCall): Promise<string>;
  /** End every host: what they were for is over. Resolves when none is left. (A call made after this starts one anew.) */
  close(): Promise<void>;
}

/** Of a call, what can be sent to another process. */
const sendable = ({ signal: _signal, used: _used, sofar: _sofar, had: _had, ...call }: AgentCall): SentCall => call;

/**
 * The hosts of one runner's calls. `env`: variables the hosts are started
 * with, over this process's own — a run's, whose agents are then that run's
 * in what they find of pi, of a provider's key, and in the commands they run.
 */
export function createAgentHosts(env?: Record<string, string>): AgentHosts {
  /** The hosts that are there: those serving a call, and those free to serve one. */
  const all = new Set<Host>(), free: Host[] = [];

  /** Put an end to a host, and to what it has under it. Resolves when they are gone. */
  const end = async (host: Host): Promise<void> => {
    if (!host.gone) {
      host.gone = true;
      const at = free.indexOf(host);
      if (at !== -1) free.splice(at, 1);
      // (Its process leads a group of its own; what it started in groups of their own is looked for first, while it is there to be asked of.)
      const { pid } = host.process;
      if (pid !== undefined) host.stopped = groupsUnder(pid).then(groups => stopGroups([pid, ...groups]));
    }
    await Promise.all([host.ended, host.stopped]);
  };

  const start = (): Host => {
    // If this process ends while a host is there, the watchdog stops the host — with what it has under it.
    requireWatchdog();
    let child: ChildProcess;
    try {
      child = fork(HOST, [], { detached: true, stdio: ["ignore", "inherit", "inherit", "ipc"], execArgv: [], ...(env && { env: { ...process.env, ...env } }) });
    } catch (err) {
      // (What the system refuses at once — more variables than a process can be handed — is said as what is found out later is.)
      throw new Error(`The agent's process could not be started: ${messageOf(err)}`);
    }
    const watched = child.pid !== undefined ? stopWithThisProcess(child.pid, true) : () => {};
    const host: Host = {
      process: child,
      gone: false,
      ready: new Promise<void>((resolve, reject) => {
        const there = (message: unknown) => {
          const said = saidBy(message);
          if (!said || !("ready" in said)) return;
          child.off("message", there);
          resolve();
        };
        child.on("message", there);
        child.once("error", (err) => reject(new Error(`The agent's process could not be started: ${err.message}`)));
        child.once("exit", (code, signal) => reject(new Error(`The agent's process ended as it started (${signal ?? `exit code ${code}`}).`)));
      }),
      ended: new Promise<void>((resolve) => {
        const over = () => {
          host.gone = true;
          all.delete(host);
          const at = free.indexOf(host);
          if (at !== -1) free.splice(at, 1);
          watched();
          resolve();
        };
        child.once("exit", over);
        child.once("error", over);
      }),
    };
    // (A host that ends before it was there is found out by whoever waits for it: nothing is thrown at nobody.)
    host.ready.catch(() => {});
    all.add(host);
    return host;
  };

  return {
    async ask(config, prompt, call) {
      throwIfAborted(call.signal);
      const host = free.pop() ?? start();
      const child = host.process;
      // (While it serves a call it is this process's to wait for; free, it keeps nobody waiting.)
      child.ref();
      child.channel?.ref();
      /** The host goes back among the free ones: it has answered, or was never asked. */
      const release = () => {
        kept = true;
        child.unref();
        child.channel?.unref();
        free.push(host);
      };
      let kept = false;
      try {
        await host.ready;
        return await new Promise<string>((resolve, reject) => {
          let giveUp: NodeJS.Timeout | undefined, offAbort = () => {}, isOver = false;
          // What the call last said it had used, and whether it has said what it used in the end.
          let last: AgentUsage | undefined, usedSaid = false;
          /** The call is over: by an answer of the host's, which is then free again — or without one, and the host is ended. */
          const over = (settle: () => void, hostIsWell: boolean) => {
            if (isOver) return;
            isOver = true;
            offAbort();
            clearTimeout(giveUp);
            child.off("message", heard);
            child.off("exit", exited);
            if (hostIsWell && !host.gone) release();
            // A host that is ended with a call in it never says what the call used in the end: what
            // it last said the call had used is then all that is known of it, and what the call is taken
            // to have used.
            else if (!usedSaid && last) call.used?.(last);
            settle();
          };
          const heard = (word: unknown) => {
            const message = saidBy(word);
            if (!message) return;
            if ("sofar" in message) {
              last = message.sofar;
              // The host waits to hear whether the call is to go on. (Where hearing what it used cancelled
              // the call, the host has been told that first, below: this then tells it nothing.)
              void Promise.resolve(call.sofar?.(message.sofar)).then(() => {
                if (!isOver && child.connected) child.send({ go: true } satisfies ToHost, () => {});
              });
            } else if ("had" in message) {
              last = message.had;
            } else if ("used" in message) {
              usedSaid = true;
              call.used?.(message.used);
            }
            else if ("answer" in message) over(() => resolve(message.answer), true);
            else if ("cutOff" in message) over(() => reject(new CutOff(message.cutOff)), true);
            else if ("error" in message) over(() => reject(new Error(message.error)), true);
          };
          const exited = (code: number | null, signal: NodeJS.Signals | null) =>
            over(() => reject(new Error(`The agent's process ended before it had answered (${signal ?? `exit code ${code}`}): the call was not finished.`)), false);
          child.on("message", heard);
          child.once("exit", exited);
          child.send({ ask: { config, prompt, call: sendable(call) } } satisfies ToHost, (err) => {
            if (err) over(() => reject(new Error(`The agent's process could not be asked: ${err.message}`)), false);
          });
          // A cancelled call is asked to stop where it is, and waited for no longer than anything asked to stop is.
          offAbort = onAbort(call.signal, () => {
            if (child.connected) child.send({ abort: true } satisfies ToHost, () => {});
            giveUp = setTimeout(() => over(() => reject(new Error("Aborted")), false), KILL_GRACE_MS);
          });
        });
      } finally {
        // (A host that did not answer — it never came to be there, it ended, it would not let go — is not one to keep.)
        if (!kept) void end(host);
      }
    },

    async close() {
      await Promise.all([...all].map(end));
    },
  };
}
