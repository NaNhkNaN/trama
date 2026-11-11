import { spawn, type ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";

const MAX_OUTPUT = 10 * 1024 * 1024; // 10 MB
/** How long a child gets to exit after SIGTERM before it is sent SIGKILL. */
const KILL_GRACE_MS = 5000;

/** A string accumulator that stops growing (and says so) once it passes 10MB. */
export function cappedBuffer() {
  let buf = "";
  let capped = false;
  return {
    append(text: string) {
      if (capped) return;
      buf += text;
      if (buf.length > MAX_OUTPUT) {
        buf = buf.slice(0, MAX_OUTPUT) + "\n[trama] output truncated at 10MB";
        capped = true;
      }
    },
    get value() { return buf; },
  };
}

/**
 * Send a signal to a whole process group. Children spawned with `detached: true`
 * lead their own group, so this also reaches whatever they started in the background.
 * Signal 0 only probes. Returns false if the group no longer exists.
 */
export function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * A time limit that only runs down while nothing is holding it.
 *
 * A program's timeout is an allowance for its own work. While it waits for a
 * run it started — one that is under a timeout of its own — the clock stops,
 * so that every moment is charged to exactly one of them and a program is
 * never killed for the time something else was entitled to take.
 */
// Run by a process of its own (see stopGroups): wait for the groups to go, and
// kill outright whichever are still there when the grace period is over.
const REAPER = `
const [grace, ...groups] = process.argv.slice(1).map(Number);
const alive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
const deadline = Date.now() + grace;
setInterval(() => {
  const left = groups.filter(alive);
  if (left.length > 0 && Date.now() < deadline) return;
  for (const pgid of left) { try { process.kill(-pgid, "SIGKILL"); } catch {} }
  process.exit(0);
}, 100);
`;

/**
 * Stop process groups for good: SIGTERM now, SIGKILL after a grace period to
 * whichever are still there.
 *
 * Never SIGKILL first. A group may hold a runner of its own — a program that
 * coordinates others, a shell command that runs trama — and that runner has
 * started process groups this one cannot see. SIGTERM is its chance to stop
 * them; killed outright, it leaves them running.
 *
 * The grace period is seen through by a small detached process rather than a
 * timer here, because the caller is often on its way out — this is what a
 * runner does with everything it started when it is stopped itself.
 */
export function stopGroups(pgids: number[]): void {
  const stopping = pgids.filter(pgid => signalGroup(pgid, "SIGTERM"));
  if (stopping.length === 0) return;
  try {
    spawn(process.execPath, ["-e", REAPER, String(KILL_GRACE_MS), ...stopping.map(String)], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } catch {
    // No reaper could be started: without one, do not leave them to chance.
    for (const pgid of stopping) signalGroup(pgid, "SIGKILL");
  }
}

export interface Allowance {
  /** Start the clock. `onSpent` is called once, if the allowance runs out. */
  start(onSpent: () => void): void;
  /** Stop the clock until the returned function is called. Holds add up: the clock runs only when all are released. */
  hold(): () => void;
  /** Stop for good; `onSpent` will not be called. */
  cancel(): void;
}

export function createAllowance(ms: number): Allowance {
  let remaining = ms;
  let holds = 0;
  let onSpent: (() => void) | null = null;
  // Set while the clock is running: the timer, and when it was started.
  let running: { timer: ReturnType<typeof setTimeout>; since: number } | null = null;

  const run = () => {
    if (!onSpent || holds > 0 || running) return;
    const spent = onSpent;
    running = {
      since: Date.now(),
      timer: setTimeout(() => { running = null; onSpent = null; spent(); }, remaining),
    };
  };
  const pause = () => {
    if (!running) return;
    clearTimeout(running.timer);
    remaining = Math.max(0, remaining - (Date.now() - running.since));
    running = null;
  };

  return {
    start(fn) { onSpent = fn; run(); },
    hold() {
      holds += 1;
      pause();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds -= 1;
        run();
      };
    },
    cancel() { pause(); onSpent = null; },
  };
}

export interface SuperviseOptions {
  /**
   * Time limit: a number of ms of wall-clock time, or an allowance that its
   * owner may put on hold. On expiry the child's process group is terminated.
   */
  timeout: number | Allowance;
  /** Receive output as it arrives, in addition to it being collected. */
  sinks?: { stdout?: (chunk: string) => void; stderr?: (chunk: string) => void };
  /** Aborting this asks the child to stop (same SIGTERM → SIGKILL sequence as a timeout). */
  stopSignal?: AbortSignal;
}

export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** The timeout expired and the child was killed for it. */
  timedOut: boolean;
  /** `stopSignal` fired while the child was still running. */
  stopped: boolean;
}

/**
 * Collect a child's output and wait for it to exit, enforcing a time limit
 * and an optional stop request. Termination is SIGTERM to the child's
 * process group, then SIGKILL if it is still alive after a grace period.
 * Resolves on exit however it happened; rejects only if the child failed to spawn.
 */
export function superviseChild(child: ChildProcess, options: SuperviseOptions): Promise<ChildExit> {
  const { sinks, stopSignal } = options;
  const allowance = typeof options.timeout === "number" ? createAllowance(options.timeout) : options.timeout;
  return new Promise((resolve, reject) => {
    const out = cappedBuffer();
    const err = cappedBuffer();
    const outDecoder = new StringDecoder("utf-8");
    const errDecoder = new StringDecoder("utf-8");
    let timedOut = false;
    let stopped = false;
    let exited = false;
    let killFallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const emitOut = (text: string) => { if (text) { out.append(text); sinks?.stdout?.(text); } };
    const emitErr = (text: string) => { if (text) { err.append(text); sinks?.stderr?.(text); } };

    const kill = (sig: NodeJS.Signals) => {
      if (child.pid) signalGroup(child.pid, sig);
      else child.kill(sig);
    };

    const terminate = () => {
      kill("SIGTERM");
      if (killFallbackTimer) clearTimeout(killFallbackTimer);
      killFallbackTimer = setTimeout(() => { if (!exited) kill("SIGKILL"); }, KILL_GRACE_MS);
      killFallbackTimer.unref();
    };

    const onStopRequest = () => {
      if (exited || stopped || timedOut) return;
      stopped = true;
      terminate();
    };
    stopSignal?.addEventListener("abort", onStopRequest, { once: true });

    allowance.start(() => {
      if (exited) return;
      timedOut = true;
      terminate();
    });

    const cleanup = () => {
      allowance.cancel();
      if (killFallbackTimer) clearTimeout(killFallbackTimer);
      stopSignal?.removeEventListener("abort", onStopRequest);
    };

    child.stdout?.on("data", (chunk: Buffer) => emitOut(outDecoder.write(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => emitErr(errDecoder.write(chunk)));

    child.on("error", (spawnError) => {
      cleanup();
      reject(spawnError);
    });

    child.on("close", (code, signal) => {
      exited = true;
      cleanup();
      emitOut(outDecoder.end());
      emitErr(errDecoder.end());
      resolve({ code, signal, stdout: out.value, stderr: err.value, timedOut, stopped });
    });
  });
}
