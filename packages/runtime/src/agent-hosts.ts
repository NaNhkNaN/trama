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
import { CutOff, addReply, atLeast, nothingYet, type AgentCall, type AgentUsage } from "./agent-backend.js";
import { createModelRelay, relayClient, relayServer, type ModelRelay } from "./model-relay.js";
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
  if (counted(said.sofar)) return { sofar: said.sofar, ...(said.answered === true && { answered: true }) };
  if (counted(said.had)) return { had: said.had };
  if (counted(said.used)) return { used: said.used };
  if (typeof said.answer === "string") return { answer: said.answer };
  if (typeof said.cutOff === "string") return { cutOff: said.cutOff };
  if (typeof said.error === "string") return { error: said.error };
  // What a call would have a model asked, and what a model answered (see model-relay.ts).
  const held = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
  const { relay, relayAbort, relayed } = said;
  if (held(relay) && typeof relay.id === "number" && held(relay.request)) {
    const { model, options } = relay.request;
    if (held(model) && typeof model.provider === "string" && typeof model.id === "string" && held(options)) return { relay } as FromHost;
  }
  if (typeof relayAbort === "number") return { relayAbort };
  if (held(relayed) && typeof relayed.id === "number" && (relayed.not === true || (held(relayed.event) && typeof relayed.event.type === "string"))) return { relayed } as FromHost;
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
const sendable = ({ signal: _signal, used: _used, sofar: _sofar, had: _had, relay: _relay, ...call }: AgentCall): SentCall => call;

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
    // Whoever waits for a host to be gone is held until it is seen to be. (A free host keeps nobody waiting —
    // see `release` — and a process held by nothing else would end in the middle of this wait, well and without
    // a word, the moment the host's group was gone and before the host was seen to end: whatever was to come
    // after — a run's failure said, its exit code — would not.)
    host.process.ref();
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

  /**
   * Who asks the models of the calls these hosts serve (see model-relay.ts).
   * Where the hosts are this process's own in all but being apart, that is
   * this process: with its pi, and the keys it has. Where they were started
   * with variables — a run's, which may name another pi and other keys — it
   * is a process started with the same, that serves no call and so has
   * nobody's code in it but pi's and trama's: started when it is first
   * wanted, and again if it was lost.
   */
  let asker: { host: Host; asks: ReturnType<typeof relayClient> } | undefined;
  const apart: ModelRelay = {
    async ask(request, signal) {
      try {
        if (!asker || asker.host.gone) {
          const host = start();
          const child = host.process;
          // (It keeps nobody waiting: a call that has asked by it is waited for by its own host.)
          child.unref();
          child.channel?.unref();
          const asks = relayClient((message) => { if (child.connected) child.send(message satisfies ToHost, () => {}); });
          child.on("message", (word: unknown) => {
            const said = saidBy(word);
            if (said && "relayed" in said) asks.heard(said.relayed);
          });
          child.once("exit", () => asks.close());
          asker = { host, asks };
        }
        const { host, asks } = asker;
        await host.ready;
        return await asks.relay.ask(request, signal);
      } catch {
        // (A process that cannot be had is not one to ask by: whoever asked asks itself.)
        return undefined;
      }
    },
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
          // What the replies used that the call's model was asked for from here: seen come, and nobody's word.
          // A count the host says is taken for no less than that.
          const seen = nothingYet();
          // How many replies were seen, and how many had been when the call was last told what it had used;
          // and whether whoever was told has said, of the call when it was over, that nothing more may be asked
          // on its account. (Said of a call still at its work, a no stops nothing: such a call is stopped by
          // being cancelled — see AgentCall.sofar. Here as where the call is served.)
          let replies = 0, told = 0, noMore = false;
          let asksHere: ReturnType<typeof createModelRelay> | undefined;
          let asked: ReturnType<typeof relayServer> | undefined;
          const asking = () => asked ??= relayServer(
            env ? apart : asksHere = createModelRelay(),
            (answer) => { if (child.connected) child.send(answer satisfies ToHost, () => {}); },
            {
              // A model is not asked for a call that has not been told of all it was seen to use: the host says
              // what the call has used before each request (below) — and where a request comes that it did not
              // say that before, the call is told from here (as of a call that is over, where the request
              // says it is asked beside one). A no to such a request is a no from then on, whatever is asked
              // after and whatever it says of itself. And a call that is cancelled, or done with, has its model
              // asked no more, whatever in its host would have it asked.
              async refuse(request) {
                if (!noMore && replies !== told) {
                  told = replies;
                  const sofar = atLeast(last, seen), answered = request.answered === true;
                  if (sofar && await call.sofar?.(sofar, answered) === false && answered) noMore = true;
                }
                return noMore || isOver || call.signal?.aborted === true;
              },
              replied(used) {
                addReply(seen, used);
                replies += 1;
                const had = atLeast(last, seen);
                if (had) call.had?.(had);
              },
            },
          );
          /** The call is over: by an answer of the host's, which is then free again — or without one, and the host is ended. */
          const over = (settle: () => void, hostIsWell: boolean) => {
            if (isOver) return;
            isOver = true;
            offAbort();
            clearTimeout(giveUp);
            child.off("message", heard);
            child.off("exit", exited);
            asked?.close();
            void asksHere?.close();
            if (hostIsWell && !host.gone) release();
            // A host that is ended with a call in it never says what the call used in the end: what
            // it last said the call had used — and what was seen of it here — is then all that is
            // known of it, and what the call is taken to have used. (And a host that is well and
            // says nothing, of a call whose model was asked from here, is not taken at its silence.)
            if (!usedSaid) {
              const used = atLeast(last, seen);
              if (used) call.used?.(used);
            }
            settle();
          };
          const heard = (word: unknown) => {
            const message = saidBy(word);
            if (!message) return;
            if ("relay" in message || "relayAbort" in message) return asking().heard(message);
            if ("sofar" in message) {
              const sofar = atLeast(last = message.sofar, seen);
              told = replies;
              // The host waits to hear whether the call is to go on — or, of a call that has its answer, whether
              // what would be asked beside it may be. (Where hearing what it used cancelled the call, the host
              // has been told that first, below: this then tells it nothing.)
              void Promise.resolve(sofar && call.sofar?.(sofar, message.answered === true)).then((go) => {
                if (go === false && message.answered === true) noMore = true;
                if (!isOver && child.connected) child.send({ go: go !== false } satisfies ToHost, () => {});
              });
            } else if ("had" in message) {
              const had = atLeast(last = message.had, seen);
              if (had) call.had?.(had);
            } else if ("used" in message) {
              usedSaid = true;
              const used = atLeast(message.used, seen);
              if (used) call.used?.(used);
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
            // (What its model is being asked from here is asked no further, whether or not its host hears.)
            asked?.close();
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
