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
import type { HistoryRun, HistoryVersion, ProjectHistory } from "./runner-types.js";

const hashOf = (source: string | Buffer): string => createHash("sha256").update(source).digest("hex");
const fileOfVersion = (version: number): string => `${String(version).padStart(4, "0")}.ts`;

/** The index.jsonl field that carries the detail for each kind of versioned change. */
const HISTORY_DETAIL_FIELD: Record<string, string> = { create: "prompt", update: "prompt", repair: "error" };

/**
 * Add a version to a project's history: its text as history/NNNN.ts, and a
 * line in index.jsonl saying why (after `notes`, lines that belong with it).
 * Either all of it is written or none of it. Returns how to take it back, for
 * a caller whose own next step may still fail.
 */
export function recordVersion(
  projectDir: string,
  source: string | Buffer,
  reason: string,
  detail?: string,
  notes: Array<Record<string, unknown>> = [],
  more: Record<string, unknown> = {},
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

  // (With the hash of its text: by that a run is known to be of this version, and the program to be this one still.)
  const entry: Record<string, unknown> = { version, reason, timestamp: new Date().toISOString(), sha256: hashOf(source), ...more };
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
    versions.push({
      version,
      reason: String(entry.reason),
      at: String(entry.timestamp),
      ...(sha256 !== undefined && { sha256 }),
      ...(typeof detail === "string" && { detail }),
      ...(Number.isSafeInteger(entry.from) && { from: entry.from as number }),
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

/** The latest version of a project that has this text, by its hash: or none. */
export function versionWith(projectDir: string, sha256: string): number | undefined {
  return versionsOf(projectDir).filter((version) => version.sha256 === sha256).at(-1)?.version;
}

/** How long a claim to record a program as found is taken for somebody's who is still at it. */
const STALE_CLAIM_MS = 60_000;

/**
 * Put the program as it is on record as a version, where it is not the
 * latest one: changed by hand since, or never recorded — found so. From
 * then on every program that is run is a version, and can be gone back to.
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
  const isTheLatest = () => versionsOf(projectDir).at(-1)?.sha256 === sha256;
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
 * A project's history, as it is on record: its versions, its runs, and
 * which version the program is now — where it is the latest one, and has
 * not been changed since.
 */
export function readHistory(projectDir: string): ProjectHistory {
  const versions = versionsOf(projectDir);
  const latest = versions.at(-1);
  const current = latest !== undefined && latest.sha256 !== undefined && latest.sha256 === programHashOf(projectDir) ? latest.version : undefined;
  return { versions, runs: runsOf(projectDir), ...(current !== undefined && { current }) };
}

/** Save the current program.ts as the next version of the project, and record why. */
export function copyToHistory(projectDir: string, reason: string, detail?: string): void {
  recordVersion(projectDir, readFileSync(guardPath(projectDir, "program.ts")), reason, detail);
}
