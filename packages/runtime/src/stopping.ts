// Stopping what a runner started, and removing what it made.
//
// A program, and every shell command it runs, leads its own process group — so
// that a timeout can take down everything it started. The cost is that none of
// them die with the runner: something has to stop them, and delete the temp
// directories they worked in.
//
// Never SIGKILL first. A group gets the chance to end properly — a program to
// close what it opened, a `trama` command to stop its own run and report it.
// Killed outright, nothing in it gets to finish anything. So a group is asked
// to stop, and killed only if it is still there when the grace period is over.
//
// That policy is carried out in two places. While the runner is there, it does
// it itself and waits for the result (stopGroups). When the runner is gone, it
// cannot: a process that is killed outright, or runs out of memory, or
// crashes, runs no code on its way out. So there is a process of its own, the
// watchdog. The runner keeps a pipe to it open, and tells it what it has
// started and what has ended. When the pipe closes — the runner is gone,
// however it went — the watchdog stops whatever is still on its list and
// deletes what is left of the directories. One runner carries every run of a
// session, so one list covers the whole tree.
//
// Nothing here listens for a signal or for the process exiting: the process
// that hosts a runner keeps its own way of handling both.

import { spawn, type ChildProcess } from "child_process";
import { rmSync } from "fs";

/** How long a process group gets to exit after SIGTERM before it is sent SIGKILL. */
const KILL_GRACE_MS = 5000;
const STOP_POLL_MS = 25;
/** How long a group is waited for after SIGKILL before it is given up on. */
const KILL_SETTLE_MS = 1000;

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

// --- The watchdog ---

// Run by the watchdog process: the same policy as stopGroups below. A group
// the runner had already asked to stop is not asked a second time.
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

/** What the watchdog has been told about and not yet told to forget. */
const listed: Record<List, Set<number | string>> = { g: new Set(), d: new Set(), asked: new Set() };
let watchdog: ChildProcess | null = null;

const tell = (to: ChildProcess, op: "+" | "-", list: List, item: number | string) => {
  to.stdin?.write(JSON.stringify([op, list, item]) + "\n");
};

/**
 * Start the watchdog if there is none, and return it — or null if it cannot be
 * started. A watchdog that has itself died is replaced, and told again what is
 * still listed.
 */
function startWatchdog(): ChildProcess | null {
  if (watchdog) return watchdog;
  let child: ChildProcess;
  try {
    const timings = { grace: KILL_GRACE_MS, settle: KILL_SETTLE_MS, poll: STOP_POLL_MS };
    child = spawn(process.execPath, ["-e", WATCHDOG, JSON.stringify(timings)], {
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
  for (const name of ["g", "d", "asked"] as const) {
    for (const item of listed[name]) tell(child, "+", name, item);
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

/** Put an item on one of the watchdog's lists. */
function enlist(on: List, item: number | string): void {
  listed[on].add(item);
  const to = startWatchdog();
  if (to) tell(to, "+", on, item);
}

/** Take it off again. */
function delist(from: List, item: number | string): void {
  if (listed[from].delete(item) && watchdog) tell(watchdog, "-", from, item);
}

/**
 * Register a process group this process started: if this process ends before
 * the returned function is called, the group is stopped.
 */
export function stopWithThisProcess(pgid: number): () => void {
  enlist("g", pgid);
  return () => {
    delist("g", pgid);
    delist("asked", pgid);
  };
}

/**
 * Register a temp directory this process created: if this process ends before
 * the returned function is called, the directory is removed — once the groups
 * that may be writing to it are gone.
 */
export function removeWithThisProcess(dir: string): () => void {
  enlist("d", dir);
  return () => delist("d", dir);
}

/** Remove a temp directory. Best-effort: failing to clean up must never change a run's outcome. */
export function removeTempDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* left for the OS to reap */ }
}

// --- Stopping, while this process is there to see it through ---

/** Groups this process has asked to stop and is still watching. */
const stopping = new Map<number, Promise<void>>();

function stopGroup(pgid: number): Promise<void> {
  // Asked once is enough: to some programs a second SIGTERM means "now".
  const watched = stopping.get(pgid);
  if (watched) return watched;
  if (!signalGroup(pgid, "SIGTERM")) return Promise.resolve();
  // The watchdog, should it take over from here, must not ask again either.
  if (listed.g.has(pgid)) enlist("asked", pgid);

  const gone = new Promise<void>((resolve) => {
    let deadline = performance.now() + KILL_GRACE_MS;
    let killed = false;
    const poll = setInterval(() => {
      const alive = signalGroup(pgid, 0);
      if (alive && performance.now() < deadline) return;
      if (alive && !killed) {
        // Out of patience. A killed group is gone in a moment; allow it that
        // moment, but do not wait on one that for some reason never goes.
        signalGroup(pgid, "SIGKILL");
        killed = true;
        deadline = performance.now() + KILL_SETTLE_MS;
        return;
      }
      clearInterval(poll);
      stopping.delete(pgid);
      resolve();
    }, STOP_POLL_MS);
  });
  stopping.set(pgid, gone);
  return gone;
}

/**
 * Stop process groups for good: SIGTERM now, SIGKILL after the grace period to
 * whichever are still there. Resolves when none is left — so that what follows
 * (merging a directory they were writing to, deleting it) finds them gone.
 */
export async function stopGroups(pgids: number[]): Promise<void> {
  await Promise.all(pgids.map(stopGroup));
}
