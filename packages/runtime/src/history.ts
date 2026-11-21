// A project's history: each program it has had, as history/NNNN.ts, and
// why it came to have it, as a line of history/index.jsonl.

import {
  readFileSync, writeFileSync, appendFileSync, readdirSync, statSync,
  rmSync, openSync, closeSync, truncateSync,
} from "fs";
import { join } from "path";
import { guardPath } from "./path-guard.js";

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
): () => void {
  const historyDir = guardPath(projectDir, "history");
  const indexPath = guardPath(projectDir, join("history", "index.jsonl"));
  const versions = readdirSync(historyDir)
    .filter(f => /^\d+\.ts$/.test(f))
    .map(f => parseInt(f, 10))
    .filter(n => Number.isSafeInteger(n) && n < Number.MAX_SAFE_INTEGER);
  // (In the history directory as the guard found it: no link is left in that. And the file itself is made,
  // never opened — a name that is there already, a link somebody put there among them, is not written through.)
  const fileOf = (version: number) => join(historyDir, `${String(version).padStart(4, "0")}.ts`);
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

  const entry: Record<string, unknown> = { version, reason, timestamp: new Date().toISOString() };
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
  return undo;
}

/** Save the current program.ts as the next version of the project, and record why. */
export function copyToHistory(projectDir: string, reason: string, detail?: string): void {
  recordVersion(projectDir, readFileSync(guardPath(projectDir, "program.ts")), reason, detail);
}
