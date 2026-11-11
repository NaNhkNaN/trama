import type { ChildProcess } from "child_process";
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

export interface SuperviseOptions {
  /** Wall-clock limit in ms. On expiry the child's process group is terminated. */
  timeout: number;
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
 * Collect a child's output and wait for it to exit, enforcing a wall-clock
 * timeout and an optional stop request. Termination is SIGTERM to the child's
 * process group, then SIGKILL if it is still alive after a grace period.
 * Resolves on exit however it happened; rejects only if the child failed to spawn.
 */
export function superviseChild(child: ChildProcess, options: SuperviseOptions): Promise<ChildExit> {
  const { timeout, sinks, stopSignal } = options;
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

    const timer = setTimeout(() => {
      if (exited) return;
      timedOut = true;
      terminate();
    }, timeout);

    const cleanup = () => {
      clearTimeout(timer);
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
