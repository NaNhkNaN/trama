import type { ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import { stopGroups } from "./stopping.js";

const MAX_OUTPUT = 10 * 1024 * 1024; // 10 MB
/** How long a child's output is waited for once the child itself has exited. */
const DRAIN_MS = 1000;
/** The longest delay a timer can be given; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

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
 * A time limit that only runs down while nothing is holding it.
 *
 * A program's timeout is an allowance for its own work. While it waits for a
 * run it started — one that is under a timeout of its own — the clock stops,
 * so that every moment is charged to exactly one of them and a program is
 * never killed for the time something else was entitled to take.
 */
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
  // Set while the clock is running: the timer, and when it was started. Time
  // is read from a clock that only moves forward — the wall clock can be set.
  let running: { timer: ReturnType<typeof setTimeout>; since: number } | null = null;

  const pause = () => {
    if (!running) return;
    clearTimeout(running.timer);
    remaining = Math.max(0, remaining - (performance.now() - running.since));
    running = null;
  };
  const run = () => {
    if (!onSpent || holds > 0 || running) return;
    running = {
      since: performance.now(),
      timer: setTimeout(() => {
        pause();
        if (remaining > 0) return run(); // an allowance longer than one timer can measure
        const spent = onSpent;
        onSpent = null;
        spent?.();
      }, Math.min(remaining, MAX_TIMER_MS)),
    };
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
  /** Aborting this asks the child to stop, the same way a timeout does. */
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
 * and an optional stop request. Either one stops the child's whole process
 * group (see stopping.ts).
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

    const emitOut = (text: string) => { if (text) { out.append(text); sinks?.stdout?.(text); } };
    const emitErr = (text: string) => { if (text) { err.append(text); sinks?.stderr?.(text); } };

    let drainTimer: ReturnType<typeof setTimeout> | null = null;

    // A child that failed to spawn has no pid, and nothing to stop.
    const terminate = () => { if (child.pid) void stopGroups([child.pid]); };

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
      if (drainTimer) clearTimeout(drainTimer);
      stopSignal?.removeEventListener("abort", onStopRequest);
    };

    child.stdout?.on("data", (chunk: Buffer) => emitOut(outDecoder.write(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => emitErr(errDecoder.write(chunk)));

    child.on("error", (spawnError) => {
      cleanup();
      reject(spawnError);
    });

    // The output pipes normally close right behind the exit. They stay open
    // only if something else inherited them — a process the child detached —
    // and what that writes is not the child's output. Stop waiting for it:
    // otherwise such a process keeps the run from ever ending, timeout or not.
    child.on("exit", () => {
      drainTimer = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); }, DRAIN_MS);
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
