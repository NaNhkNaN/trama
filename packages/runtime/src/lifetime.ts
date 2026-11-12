// What this process must undo if it ends while a run is still in flight:
// stop the processes it started, and delete what it left in the temp directory.
//
// A program, and every shell command it runs, leads its own process group — so
// that a timeout can take down everything it started. The cost is that none of
// them die with the runner: without this, Ctrl-C on `trama run` would leave
// them all running. One runner carries every run of a session, so the lists
// kept here cover the whole tree.

import { rmSync } from "fs";
import { stopGroupsOnExit } from "./child-process.js";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type Signal = (typeof SIGNALS)[number];

const pendingGroups = new Set<number>();
const pendingDirs = new Set<string>();
let installed = false;

function runPending(): void {
  const groups = [...pendingGroups];
  const dirs = [...pendingDirs];
  pendingGroups.clear();
  pendingDirs.clear();
  // The groups are asked to stop and given a moment; whatever sees that through
  // also removes the directories again once they are gone, in case they were
  // still writing to them.
  stopGroupsOnExit(groups, dirs);
  for (const dir of dirs) removeTempDir(dir);
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

/** Keep `item` pending until the returned function is called. */
function track<T>(pending: Set<T>, item: T): () => void {
  pending.add(item);
  install();
  return () => {
    pending.delete(item);
    if (pendingGroups.size === 0 && pendingDirs.size === 0) uninstall();
  };
}

/**
 * Register a process group this process started: if this process ends before
 * the returned function is called, the group is stopped (see stopGroupsOnExit).
 */
export function stopWithThisProcess(pgid: number): () => void {
  return track(pendingGroups, pgid);
}

/**
 * Register a temp directory this process created: if this process ends before
 * the returned function is called, the directory is removed.
 */
export function removeWithThisProcess(dir: string): () => void {
  return track(pendingDirs, dir);
}

/** Remove a temp directory. Best-effort: failing to clean up must never change a run's outcome. */
export function removeTempDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* left for the OS to reap */ }
}
