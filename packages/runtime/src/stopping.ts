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

import { execFile, spawn, type ChildProcess } from "child_process";
import * as fs from "fs";

/** How long what was asked to stop gets to do so: a process group after SIGTERM, before it is sent SIGKILL; a backend's call after it was cancelled, before the run goes on without it. */
export const KILL_GRACE_MS = 5000;
const STOP_POLL_MS = 25;
/** How long a group is waited for after SIGKILL before it is given up on. */
const KILL_SETTLE_MS = 1000;

/**
 * Send a signal to a whole process group. Children spawned with `detached: true`
 * lead their own group, so this also reaches whatever they started in the background.
 * Signal 0 only probes. Returns false if the group no longer exists — or
 * holds nothing that can be signalled, which is the same to one who means to
 * stop it. (macOS says so of a group whose last members have exited and are
 * yet to be reaped; to wait for such a group is to wait for nothing.)
 */
export function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

/** How long the system is given to say what processes there are. */
const PROCESSES_ASKED_MS = 2_000;

/**
 * What Linux says of its processes — each its id, its parent's and its
 * group's — in files: there is nothing to start to learn it, and nothing that
 * may be missing (a container often has no `ps`). Nothing, where there are no
 * such files — or where they are not of the processes whoever asks is among:
 * a container may have another's files before it, and a number read there
 * is nobody's here. So the files are taken at their word only where they say
 * of the asker (`self`) what it knows of itself: whose child it is (`parent`).
 *
 * It runs in two processes, here and in the watchdog, which is handed its
 * text: it may use nothing but its arguments. So may the two that follow.
 */
export function processesOnFile(fs: Pick<typeof import("fs"), "readdirSync" | "readFileSync">, self: number, parent: number): number[][] {
  const rows: number[][] = [];
  let names: string[];
  try {
    names = fs.readdirSync("/proc");
  } catch {
    return rows;
  }
  for (const name of names) {
    if (!/^[0-9]+$/.test(name)) continue;
    try {
      // "id (name) state parent group …": a name may hold anything, a ")" and a space among it —
      // what follows the last ")" is what is told apart by spaces.
      const stat = fs.readFileSync("/proc/" + name + "/stat", "utf8");
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const row = [Number(name), Number(after[1]), Number(after[2])];
      if (row.every(Number.isInteger)) rows.push(row);
    } catch { /* gone since it was listed */ }
  }
  return rows.some(row => row[0] === self && row[1] === parent) ? rows : [];
}

/** The same, of what `ps -Ao pid=,ppid=,pgid=` printed. */
function processesListed(listed: string): number[][] {
  return listed.split("\n").map(line => line.trim().split(/\s+/).map(Number)).filter(row => row.length === 3 && row.every(Number.isInteger));
}

/**
 * Of such rows, the process groups of everything one process has under it —
 * but for the group it leads, and that of whoever asks (`self`).
 */
function groupsAmong(rows: number[][], pid: number, self: number): number[] {
  const under = new Set([pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      if (under.has(row[1]) && !under.has(row[0])) {
        under.add(row[0]);
        grew = true;
      }
    }
  }
  const own = rows.find(row => row[0] === self);
  const groups = new Set(rows.filter(row => under.has(row[0])).map(row => row[2]));
  return [...groups].filter(group => group !== pid && !(own && group === own[2]));
}

/**
 * The process groups of everything a process has under it, as the system has
 * them at this moment — but for the group it leads, and this process's own.
 * A process may start what it starts in groups of their own (pi does so with
 * what an agent runs, and with an MCP server): the group it leads does not
 * hold those, and once it is gone nothing says any more whose they were.
 * (What has cut itself loose of its parent by then is nobody's to find; and
 * where the system cannot be asked — it has no such files, and no `ps` that
 * answers in a while — nothing is found.) Whoever asks is not held while a
 * `ps` answers: it is asked of what is still there, and is to be stopped
 * after.
 */
export async function groupsUnder(pid: number): Promise<number[]> {
  let rows = processesOnFile(fs, process.pid, process.ppid);
  if (rows.length === 0) {
    rows = processesListed(await new Promise<string>((resolve) => {
      execFile("ps", ["-Ao", "pid=,ppid=,pgid="], { encoding: "utf-8", timeout: PROCESSES_ASKED_MS, killSignal: "SIGKILL" }, (err, stdout) => resolve(err ? "" : stdout));
    }));
  }
  return groupsAmong(rows, pid, process.pid);
}

// --- Removing what was made ---

/**
 * Remove a directory tree, whatever has been done to it since it was made. A
 * tree with a directory in it that may not be written to — a copy of a project
 * that has one, or one a program made so — cannot be emptied as it stands; so
 * where removing it fails, its directories are opened first.
 *
 * It runs in two processes, here and in the watchdog, which is handed its
 * text: it may use nothing but its arguments.
 */
function removeTree(fs: Pick<typeof import("fs"), "rmSync" | "readdirSync" | "chmodSync">, dir: string): void {
  const remove = () => fs.rmSync(dir, { recursive: true, force: true });
  try { return remove(); } catch { /* opened below, and tried once more */ }
  const open = (at: string) => {
    try {
      fs.chmodSync(at, 0o700);
      for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
        if (entry.isDirectory()) open(at + "/" + entry.name); // not a link to one: only this tree is touched
      }
    } catch { /* what cannot be opened stays as it is */ }
  };
  open(dir);
  try { remove(); } catch { /* left for the OS to reap */ }
}

// --- The watchdog ---

// Run by the watchdog process: the same policy as stopGroups below. A group
// the runner had already asked to stop is not asked a second time.
const WATCHDOG = `
const fs = require("fs");
const { execFileSync } = require("child_process");
${removeTree}
${signalGroup}
${processesOnFile}
${processesListed}
${groupsAmong}
const { grace, settle, poll, asking } = JSON.parse(process.argv[1]);
const lists = { g: new Set(), d: new Set(), asked: new Set(), u: new Set() };
// What the system says of its processes: by its files, or by ps — which this process can wait for.
const processes = () => {
  const rows = processesOnFile(fs, process.pid, process.ppid);
  if (rows.length > 0) return rows;
  try {
    return processesListed(execFileSync("ps", ["-Ao", "pid=,ppid=,pgid="], { encoding: "utf8", timeout: asking, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return [];
  }
};
const alive = (pgid) => signalGroup(pgid, 0);

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
    for (const dir of lists.d) removeTree(fs, dir);
    process.exit(0);
  };
  // A group that is to be stopped with what is under it: what it started in groups of their own is
  // looked for now, while it is there to be asked of — it may not be able to end them itself.
  const led = [...lists.u].filter(alive);
  const rows = led.length > 0 ? processes() : [];
  const below = led.flatMap((pid) => groupsAmong(rows, pid, process.pid));
  let left = [...new Set([...lists.g, ...below])].filter(alive);
  for (const pgid of left) { if (!lists.asked.has(pgid)) signalGroup(pgid, "SIGTERM"); }
  let deadline = performance.now() + grace;
  let killed = false;
  const check = () => {
    // A group seen gone is never signalled again: its id may belong to another by now.
    left = left.filter(alive);
    if (left.length === 0) return finish();
    if (performance.now() < deadline) return;
    if (killed) return finish();
    for (const pgid of left) signalGroup(pgid, "SIGKILL");
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

/** The watchdog's lists: process groups, temp directories, the groups already asked to stop, and those to be stopped with what is under them. */
type List = "g" | "d" | "asked" | "u";

/** What the watchdog has been told about and not yet told to forget. */
const listed: Record<List, Set<number | string>> = { g: new Set(), d: new Set(), asked: new Set(), u: new Set() };
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
    const timings = { grace: KILL_GRACE_MS, settle: KILL_SETTLE_MS, poll: STOP_POLL_MS, asking: PROCESSES_ASKED_MS };
    // It is this file's own few lines, and is to start whatever this process was started with:
    // not with what NODE_OPTIONS would have it load first, or wait for (a debugger, say).
    const { NODE_OPTIONS: _options, ...env } = process.env;
    child = spawn(process.execPath, ["-e", WATCHDOG, JSON.stringify(timings)], {
      detached: true, // a signal sent to this process's group must not reach it
      stdio: ["pipe", "ignore", "ignore"],
      env,
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
  for (const name of ["g", "d", "asked", "u"] as const) {
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
 * the returned function is called, the group is stopped. `withWhatIsUnder`:
 * and so is what its leader has under it in groups of their own — for a
 * process whose children are nobody's to keep (an agent's host; not a
 * program, which may start what is to outlive it).
 */
export function stopWithThisProcess(pgid: number, withWhatIsUnder = false): () => void {
  enlist("g", pgid);
  if (withWhatIsUnder) enlist("u", pgid);
  return () => {
    delist("g", pgid);
    delist("asked", pgid);
    delist("u", pgid);
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
  removeTree(fs, dir);
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
