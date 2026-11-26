// A project's history: each program it has had, as history/NNNN.ts, and
// why it came to have it, as a line of history/index.jsonl — and each run of
// it, as a line of history/runs.jsonl: which version it was of, how it
// ended, what its check said, what it used. A lineage: versions that can be
// told apart by how their runs went, and gone back to. What is here is on
// record as fact. Nothing here says which version is better.

import {
  readFileSync, writeFileSync, appendFileSync, readdirSync, statSync,
  rmSync, openSync, closeSync, truncateSync, renameSync, mkdirSync,
} from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { guardPath } from "./path-guard.js";
import { isJsonObject } from "./serializable.js";
import { heldIn, markOfHeld, type Held } from "./contract.js";
import { readProjectMeta } from "./meta.js";
import type { HistoryRun, HistoryVersion, ProjectHistory } from "./runner-types.js";

const hashOf = (source: string | Buffer): string => createHash("sha256").update(source).digest("hex");
const fileOfVersion = (version: number): string => `${String(version).padStart(4, "0")}.ts`;

/** The kinds of version that are written from another: the program as it was, rewritten. */
const WRITTEN_FROM = ["update", "repair"];

/** The index.jsonl field that carries the detail for each kind of versioned change. */
const HISTORY_DETAIL_FIELD: Record<string, string> = { create: "prompt", update: "prompt", repair: "error" };

/** Where what versions were made under is kept, as it was written: each by its mark. */
const CONTRACTS = join("history", "contracts");

/** Keep what a version is made under, by its mark: once, and for good. (That it cannot be kept is no reason not to record the version: going back to it then says so.) */
function keepHeld(projectDir: string, mark: string, held: Held): void {
  try {
    mkdirSync(guardPath(projectDir, CONTRACTS), { recursive: true });
    writeFileSync(guardPath(projectDir, join(CONTRACTS, `${mark}.json`)), `${JSON.stringify(held, null, 2)}\n`, { flag: "wx" });
  } catch { /* (There already — or not to be written.) */ }
}

/** What the project is held to as it is — its meta.json's `parameters` and `returns` — and the mark of that. Nothing, where its meta.json cannot be read so. */
export function heldNow(projectDir: string): { mark?: string; held: Held } | undefined {
  try {
    const held = heldIn(readProjectMeta(projectDir));
    return { mark: markOfHeld(projectDir, held), held };
  } catch {
    return undefined;
  }
}

/**
 * What a version was made under: its mark — none, where the project said
 * nothing of what it took and gave — and the text of it (`held`), where that
 * is on record: it is kept from when versions' were (a version recorded
 * before has its mark alone).
 */
export function heldOfVersion(projectDir: string, version: number): { mark?: string; held?: Held } {
  const mark = versionsOf(projectDir).find((one) => one.version === version)?.contract;
  if (mark === undefined) return { held: {} };
  try {
    const kept: unknown = JSON.parse(readFileSync(guardPath(projectDir, join(CONTRACTS, `${mark}.json`)), "utf-8"));
    // (What is kept under a mark is what the mark is of, or it is not what the version was made under.)
    if (isJsonObject(kept) && markOfHeld(projectDir, heldIn(kept)) === mark) return { mark, held: heldIn(kept) };
  } catch { /* (Not kept, or not to be read.) */ }
  return { mark };
}

/**
 * Add a version to a project's history: its text as history/NNNN.ts, and a
 * line in index.jsonl saying why (after `notes`, lines that belong with it).
 * Either all of it is written or none of it. Returns how to take it back, for
 * a caller whose own next step may still fail.
 *
 * A version is its program and what the project took and gave when it was
 * made: its line has the mark of that, and the text is kept by the mark.
 * `under`: what it is made under, where that is not what the project says —
 * a version kept beside the program, or one that is about to be the program
 * together with what it is held to.
 */
export function recordVersion(
  projectDir: string,
  source: string | Buffer,
  reason: string,
  detail?: string,
  notes: Array<Record<string, unknown>> = [],
  more: Record<string, unknown> = {},
  under?: Held,
): (() => void) & { version: number } {
  const historyDir = guardPath(projectDir, "history");
  const indexPath = guardPath(projectDir, join("history", "index.jsonl"));
  const versions = readdirSync(historyDir)
    .filter(f => /^\d+\.ts$/.test(f))
    .map(f => parseInt(f, 10))
    .filter(n => Number.isSafeInteger(n) && n < Number.MAX_SAFE_INTEGER);
  // (In the history directory as the guard found it: no link is left in that. And the file itself is made,
  // never opened — a name that is there already, a link somebody put there among them, is not written through.)
  const fileOf = (version: number) => join(historyDir, fileOfVersion(version));
  // The next number: one more than the highest there is — or, where another run of the project took that
  // one between the looking and the taking, the one after. A version file that is already there is someone
  // else's, and is not written over.
  let version = versions.reduce((a, b) => Math.max(a, b), 0) + 1;
  let snapshot = fileOf(version), fd: number;
  for (;;) {
    try {
      fd = openSync(snapshot, "wx");
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      snapshot = fileOf(++version);
    }
  }

  // (With the hash of its text: by that a run is known to be of this version, and the program to be this one still.
  // And with a mark of what the project took and gave when it was made, where the project says: versions made under
  // one contract can be held against each other, and a change of it is seen where it was made.)
  let contract: string | undefined;
  try {
    const held = under ?? heldIn(readProjectMeta(projectDir));
    contract = markOfHeld(projectDir, held);
    if (contract !== undefined) keepHeld(projectDir, contract, held);
  } catch { /* (A meta.json that cannot be read so: the version is one all the same.) */ }
  const entry: Record<string, unknown> = { version, reason, timestamp: new Date().toISOString(), sha256: hashOf(source), ...(contract !== undefined && { contract }), ...more };
  const detailField = HISTORY_DETAIL_FIELD[reason];
  if (detailField && detail) entry[detailField] = detail;

  const lines = Buffer.from([...notes, entry].map(line => JSON.stringify(line) + "\n").join(""));
  const sizeBefore = statSync(indexPath, { throwIfNoEntry: false })?.size;
  let appended = false;

  // Takes back what was written here and nothing else. Another run of the
  // project may be recording a version of its own at the same moment: if the
  // index no longer ends with these lines alone, they are left in it, and the
  // version file with them — a version on record that was never installed,
  // rather than someone else's record cut out of the history.
  const undo = () => {
    try {
      const index = readFileSync(indexPath);
      const start = sizeBefore ?? 0;
      const sinceThen = index.subarray(Math.min(start, index.length));
      // What was appended is the end of the index — whole, or as far as a failed write got.
      const cutTo = index.subarray(-lines.length).equals(lines) ? index.length - lines.length
        : lines.subarray(0, sinceThen.length).equals(sinceThen) ? start
        : null;
      if (cutTo === null) return;
      if (cutTo === 0 && sizeBefore === undefined) rmSync(indexPath, { force: true });
      else if (cutTo < index.length) truncateSync(indexPath, cutTo);
    } catch (err) {
      // The index cannot be looked at. If the lines went into it, they stay,
      // and the version file with them; if they never did, there is only the file.
      if (appended && (err as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    try { rmSync(snapshot, { force: true }); } catch { /* best-effort */ }
  };
  try {
    try { writeFileSync(fd, source); } finally { closeSync(fd); }
    appendFileSync(indexPath, lines);
    appended = true;
  } catch (err) {
    undo();
    throw err;
  }
  return Object.assign(undo, { version });
}

/** The versions of a project that are on record, in the order they came. (A line of the index that is no version — a note beside one — is none.) */
export function versionsOf(projectDir: string): HistoryVersion[] {
  let index: string;
  try {
    index = readFileSync(guardPath(projectDir, join("history", "index.jsonl")), "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }
  const versions: HistoryVersion[] = [];
  for (const line of index.split("\n")) {
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!isJsonObject(entry) || !Number.isSafeInteger(entry.version) || (entry.version as number) < 1) continue;
    const version = entry.version as number;
    // A line written before a version's hash was kept with it: the hash is its file's, where that is still there.
    let sha256 = typeof entry.sha256 === "string" ? entry.sha256 : undefined;
    if (sha256 === undefined) {
      try { sha256 = hashOf(readFileSync(guardPath(projectDir, join("history", fileOfVersion(version))))); } catch { /* (Its file is gone.) */ }
    }
    const detail = entry[HISTORY_DETAIL_FIELD[String(entry.reason)] ?? ""];
    // The version it was written from: as its line says — which may say that it is not known — and, of a line
    // written before lines said, the one before it, where it is an update or a fix: so they came, one after another.
    const parent = Object.hasOwn(entry, "parent")
      ? (Number.isSafeInteger(entry.parent) ? entry.parent as number : undefined)
      : WRITTEN_FROM.includes(String(entry.reason)) ? versions.at(-1)?.version : undefined;
    versions.push({
      version,
      reason: String(entry.reason),
      at: String(entry.timestamp),
      ...(sha256 !== undefined && { sha256 }),
      ...(typeof detail === "string" && { detail }),
      ...(Number.isSafeInteger(entry.from) && { from: entry.from as number }),
      ...(parent !== undefined && { parent }),
      ...(typeof entry.contract === "string" && { contract: entry.contract }),
      ...(entry.aside === true && { aside: true as const }),
    });
  }
  return versions;
}


/** The text of a version of a project's program. Throws where its file is not there. */
export function textOfVersion(projectDir: string, version: number): string {
  return readFileSync(guardPath(projectDir, join("history", fileOfVersion(version))), "utf-8");
}

/** The hash of a project's program as it is — or nothing, where there is none to read. */
export function programHashOf(projectDir: string): string | undefined {
  try { return hashOf(readFileSync(guardPath(projectDir, "program.ts"))); } catch { return undefined; }
}

/**
 * The latest version of a project that has this text, by its hash: or none.
 * Of those the program was made, where there is one — a version kept beside
 * the program that happens to have the program's text is not what the
 * program is — and else of those kept beside it.
 */
export function versionWith(projectDir: string, sha256: string): number | undefined {
  const has = versionsOf(projectDir).filter((version) => version.sha256 === sha256);
  return (has.filter((version) => !version.aside).at(-1) ?? has.at(-1))?.version;
}

/** How long a claim to record a program as found is taken for somebody's who is still at it. */
const STALE_CLAIM_MS = 60_000;

/** Whether what the project is held to, as it is, is what a version of that mark was made under. (A meta.json that cannot be read says nothing against it.) */
const heldAs = (projectDir: string, mark: string | undefined): boolean => {
  const now = heldNow(projectDir);
  return now === undefined || now.mark === mark;
};

/**
 * The version whose text the program is, where that is the latest the
 * program was made — whatever the project takes and gives by now: what a
 * program written from the program as it is, is written from.
 */
export function textIsOf(projectDir: string): number | undefined {
  const latest = versionsOf(projectDir).filter((version) => !version.aside).at(-1);
  return latest?.sha256 !== undefined && latest.sha256 === programHashOf(projectDir) ? latest.version : undefined;
}

/**
 * Put the project as it is on record as a version, where it is not the
 * latest one: its program changed by hand since, or what it takes and gives
 * — a version is the two — or never recorded: found so. From then on every
 * program that is run is a version, and can be gone back to.
 *
 * Runs of one project may begin at the same moment, each by a runner of its
 * own: the program is recorded by one of them. (Which is settled by a file
 * only one can make. Whoever finds it made leaves the recording to its
 * maker, and learns the version's number later, by the program's hash.)
 */
export function recordAsFound(projectDir: string): void {
  let source: Buffer;
  try { source = readFileSync(guardPath(projectDir, "program.ts")); } catch { return; } // (No program to record: its run will say so.)
  const sha256 = hashOf(source);
  // (The latest that the program was made: a version kept beside the program is no statement of what the program is.)
  const isTheLatest = () => {
    const latest = versionsOf(projectDir).filter((version) => !version.aside).at(-1);
    return latest?.sha256 === sha256 && heldAs(projectDir, latest.contract);
  };
  if (isTheLatest()) return;
  const historyDir = guardPath(projectDir, "history");
  mkdirSync(historyDir, { recursive: true });
  const claim = join(historyDir, `.found-${sha256.slice(0, 16)}`);
  const claimed = (): boolean => {
    try { closeSync(openSync(claim, "wx")); return true; } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      return false;
    }
  };
  if (!claimed()) {
    // Somebody else's — unless whoever made it is long gone, and left it.
    const made = statSync(claim, { throwIfNoEntry: false })?.mtimeMs;
    if (made !== undefined && Date.now() - made < STALE_CLAIM_MS) return;
    rmSync(claim, { force: true });
    if (!claimed()) return;
  }
  try {
    if (!isTheLatest()) recordVersion(projectDir, source, "found");
  } finally {
    rmSync(claim, { force: true });
  }
}

/** The most a file of runs holds before it is put aside: about a thousand runs, at the most a line comes to. */
export const MAX_RUNS_FILE = 1024 * 1024;
const RUNS = join("history", "runs.jsonl"), RUNS_ASIDE = join("history", "runs.1.jsonl");

/**
 * Add a run to a project's history: a line of history/runs.jsonl. The runs
 * on record are the latest — a file that is full is put aside, in the
 * place of the one put aside before it, and a new one begun: so there are
 * always the last thousand or so, and never more than two files of them.
 * (Put aside by a rename, and not cut down by writing it again: a line
 * another runner adds at that moment is in one file or the other, and not lost.)
 */
export function noteRun(projectDir: string, run: HistoryRun): void {
  const runs = guardPath(projectDir, RUNS);
  mkdirSync(guardPath(projectDir, "history"), { recursive: true });
  if ((statSync(runs, { throwIfNoEntry: false })?.size ?? 0) >= MAX_RUNS_FILE) renameSync(runs, guardPath(projectDir, RUNS_ASIDE));
  appendFileSync(runs, `${JSON.stringify(run)}\n`);
}

/** The runs of a project that are on record, oldest first. */
function runsOf(projectDir: string): HistoryRun[] {
  const runs: HistoryRun[] = [];
  for (const file of [RUNS_ASIDE, RUNS]) {
    let text: string;
    try { text = readFileSync(guardPath(projectDir, file), "utf-8"); } catch { continue; }
    for (const line of text.split("\n")) {
      try {
        const run: unknown = JSON.parse(line);
        if (isJsonObject(run)) runs.push(run as unknown as HistoryRun);
      } catch { /* (No line of it: one cut off in the writing.) */ }
    }
  }
  return runs;
}

/**
 * A project's history, as it is on record: its versions, its runs — all
 * that are there, or the latest so many (`runs`) — and which version the
 * program is now, where it is the latest one and has not been changed since.
 */
export function readHistory(projectDir: string, options: { runs?: number } = {}): ProjectHistory {
  const versions = versionsOf(projectDir);
  // What the program is: the latest version it was made — not one put on record beside it, which it never was.
  const latest = versions.filter((version) => !version.aside).at(-1);
  // (And made under what the project takes and gives now: one changed by hand since is a version when it is next run.)
  const current = latest !== undefined && latest.sha256 !== undefined && latest.sha256 === programHashOf(projectDir) && heldAs(projectDir, latest.contract) ? latest.version : undefined;
  const all = runsOf(projectDir);
  const runs = options.runs === undefined ? all : options.runs >= 1 ? all.slice(-Math.floor(options.runs)) : [];
  return { versions, runs, ...(current !== undefined && { current }) };
}

/** Save the current program.ts as the next version of the project, and record why. */
export function copyToHistory(projectDir: string, reason: string, detail?: string, more: Record<string, unknown> = {}): void {
  recordVersion(projectDir, readFileSync(guardPath(projectDir, "program.ts")), reason, detail, [], more);
}
