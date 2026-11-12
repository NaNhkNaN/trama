// What must not outlive this process: the process groups it started, and the
// temp directories it made.
//
// A program, and every shell command it runs, leads its own process group — so
// that a timeout can take down everything it started. The cost is that none of
// them die with the runner. Something has to stop them when the runner goes,
// and it cannot be the runner: a process that is killed outright, or runs out
// of memory, or crashes, runs no code on its way out.
//
// So it is a process of its own, the watchdog. The runner keeps a pipe to it
// open, and tells it what it has started and what has ended. When the pipe
// closes — the runner is gone, however it went — the watchdog stops whatever
// is still on its list and deletes what is left of the directories. One runner
// carries every run of a session, so one list covers the whole tree.
//
// Nothing here listens for a signal or for the process exiting: the process
// that hosts a runner keeps its own way of handling both.

import { spawn, type ChildProcess } from "child_process";
import { rmSync } from "fs";
import { STOP_TIMINGS, onGroupAskedToStop } from "./child-process.js";

// Run by the watchdog process. It applies the same policy as stopGroups (see
// child-process.ts): ask, wait out the grace period, kill what is left. A
// group the runner had already asked is not asked a second time.
const WATCHDOG = `
const { rmSync } = require("fs");
const { grace, settle, poll } = JSON.parse(process.argv[1]);
const lists = { g: new Set(), d: new Set(), asked: new Set() };
const alive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
const signal = (pgid, name) => { try { process.kill(-pgid, name); } catch {} };

let unread = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  unread += chunk;
  for (let end; (end = unread.indexOf("\\n")) !== -1; unread = unread.slice(end + 1)) {
    const [op, list, item] = JSON.parse(unread.slice(0, end));
    lists[list][op === "+" ? "add" : "delete"](item);
  }
});

// The pipe has closed: the runner is gone.
let leaving = false;
const takeOver = () => {
  if (leaving) return;
  leaving = true;
  const finish = () => {
    for (const dir of lists.d) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
    process.exit(0);
  };
  let left = [...lists.g].filter(alive);
  for (const pgid of left) { if (!lists.asked.has(pgid)) signal(pgid, "SIGTERM"); }
  let deadline = performance.now() + grace;
  let killed = false;
  const check = () => {
    // A group seen gone is never signalled again: its id may belong to another by now.
    left = left.filter(alive);
    if (left.length === 0) return finish();
    if (performance.now() < deadline) return;
    if (killed) return finish();
    for (const pgid of left) signal(pgid, "SIGKILL");
    killed = true;
    deadline = performance.now() + settle;
  };
  check();
  setInterval(check, poll);
};
process.stdin.on("end", takeOver);
process.stdin.on("close", takeOver);
process.stdin.on("error", takeOver);
`;

/** The watchdog's lists: process groups, temp directories, and the groups already asked to stop. */
type List = "g" | "d" | "asked";

/** What this process has told the watchdog about and not yet taken back. */
const pending: Record<List, Set<number | string>> = { g: new Set(), d: new Set(), asked: new Set() };
let watchdog: ChildProcess | null = null;

const tell = (to: ChildProcess, op: "+" | "-", list: List, item: number | string) => {
  to.stdin?.write(JSON.stringify([op, list, item]) + "\n");
};

/**
 * Start the watchdog if there is none, and return it — or null if it cannot be
 * started. A watchdog that has itself died is replaced, and told again what is
 * still pending.
 */
function startWatchdog(): ChildProcess | null {
  if (watchdog) return watchdog;
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, ["-e", WATCHDOG, JSON.stringify(STOP_TIMINGS)], {
      detached: true, // a signal sent to this process's group must not reach it
      stdio: ["pipe", "ignore", "ignore"],
    });
  } catch {
    return null;
  }
  const lost = () => { if (watchdog === child) watchdog = null; };
  child.on("error", lost);
  child.on("exit", lost);
  child.stdin?.on("error", lost);
  if (child.pid === undefined) return null; // a failed spawn has no pid from the start

  // Neither the watchdog nor the pipe to it keeps this process alive.
  child.unref();
  (child.stdin as unknown as { unref?: () => void } | null)?.unref?.();

  watchdog = child;
  for (const list of ["g", "d", "asked"] as const) {
    for (const item of pending[list]) tell(child, "+", list, item);
  }
  return child;
}

/**
 * Make sure there is a watchdog before anything is started that would need
 * one. Throws if one cannot be started: running without it would mean leaving
 * processes behind with nobody to stop them.
 */
export function requireWatchdog(): void {
  if (!startWatchdog()) {
    throw new Error("Could not start trama's watchdog process, which stops what a run started if the runner dies.");
  }
}

/** Keep `item` on the watchdog's list until the returned function is called. */
function watch(list: List, item: number | string): () => void {
  pending[list].add(item);
  const to = startWatchdog();
  if (to) tell(to, "+", list, item);
  return () => {
    if (!pending[list].delete(item)) return;
    if (watchdog) tell(watchdog, "-", list, item);
  };
}

/**
 * Register a process group this process started: if this process ends before
 * the returned function is called, the group is stopped.
 */
export function stopWithThisProcess(pgid: number): () => void {
  const forget = watch("g", pgid);
  return () => {
    forget();
    asked.get(pgid)?.();
    asked.delete(pgid);
  };
}

/** Groups on the watchdog's list that this process has asked to stop, and how to take each off again. */
const asked = new Map<number, () => void>();
onGroupAskedToStop((pgid) => {
  if (pending.g.has(pgid) && !asked.has(pgid)) asked.set(pgid, watch("asked", pgid));
});

/**
 * Register a temp directory this process created: if this process ends before
 * the returned function is called, the directory is removed — once the groups
 * that may be writing to it are gone.
 */
export function removeWithThisProcess(dir: string): () => void {
  return watch("d", dir);
}

/** Remove a temp directory. Best-effort: failing to clean up must never change a run's outcome. */
export function removeTempDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* left for the OS to reap */ }
}
