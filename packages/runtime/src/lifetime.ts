// What this process must undo if it ends while a run is still in flight:
// stop the processes it started, and delete what it left in the temp directory.
//
// A program, and every shell command it runs, leads its own process group — so
// that a timeout can take down everything it started. The cost is that none of
// them die with the runner: without this, Ctrl-C on `trama run` would leave the
// program running, and a program that coordinates others (a session) would
// leave them running when it ended.

import { rmSync } from "fs";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type Signal = (typeof SIGNALS)[number];

const pending = new Set<() => void>();
let installed = false;

function runPending(): void {
  for (const undo of [...pending]) {
    try { undo(); } catch { /* best-effort: we are on the way out */ }
  }
  pending.clear();
}

function onSignal(signal: Signal): void {
  runPending();
  // Having a handler at all cancelled the signal's default action. Step aside
  // and send it again, so that what happens next is what would have happened
  // had this handler never been installed: the process dies of it, or whoever
  // else handles the signal decides. (Common libraries only act on a signal
  // when they are its sole listener, so simply staying out of the way is not
  // enough — the signal has to arrive once more without us.)
  uninstall();
  process.kill(process.pid, signal);
}

function install(): void {
  if (installed) return;
  installed = true;
  process.on("exit", runPending);
  for (const signal of SIGNALS) process.on(signal, onSignal);
}

/** Leave the host process's signal handling untouched whenever nothing is in flight. */
function uninstall(): void {
  if (!installed) return;
  installed = false;
  process.removeListener("exit", runPending);
  for (const signal of SIGNALS) process.removeListener(signal, onSignal);
}

/**
 * Register something to undo if this process ends before `settle` is called.
 * `undo` must be synchronous. Returns `settle`: call it once the thing has been
 * dealt with in the normal course of the run.
 */
export function untilSettled(undo: () => void): () => void {
  pending.add(undo);
  install();
  return () => {
    pending.delete(undo);
    if (pending.size === 0) uninstall();
  };
}

/** Remove a temp directory. Best-effort: failing to clean up must never change a run's outcome. */
export function removeTempDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* left for the OS to reap */ }
}
