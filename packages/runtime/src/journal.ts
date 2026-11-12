// The journal: a record of what a run did.
//
// What a program does through the runtime goes through the bridge, so the
// bridge is where a run can be written down: each call as it arrives, and how
// it was answered. Around the calls go the things only the runner knows — which
// program was run, each attempt and how it exited, each fix that was asked for
// and what came back, and how the run as a whole ended. (What a program does on
// its own — it is a node process like any other — is not seen here.)
//
// One file per run, one JSON record per line, appended as things happen, so a
// journal says what had happened by the time of its last line: a run that died
// has no "end", and a call nobody was left to answer has no "result".
//
// It records. Nothing reads it back to change what a run does.

import { appendFileSync, closeSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, rmSync } from "fs";
import { createHash, randomBytes } from "crypto";
import { join } from "path";
import { guardPath } from "./path-guard.js";

/** The format of the records. Bump it when a reader of older journals would be misled. */
export const JOURNAL_VERSION = 1;

/** Where a project keeps its journals, relative to the project — under logs/, which trama keeps out of version control. */
export const JOURNAL_DIR = join("logs", "journal");

/**
 * A project's journal directory, by its one real name however the project was
 * referred to: a journal is recognised as still being written by its path.
 */
export function journalDirOf(projectDir: string): string {
  const dir = guardPath(projectDir, JOURNAL_DIR);
  try { return realpathSync(dir); } catch { return dir; /* not there yet */ }
}

/** The ids of the runs that have a journal in `dir`, oldest first. (A run's id starts with when it started.) */
export function runsIn(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; // no run has been recorded
    throw err;
  }
  return names.filter(name => name.endsWith(".jsonl")).sort().map(name => name.slice(0, -".jsonl".length));
}

/** The journal of a run, in a journal directory. */
export const journalIn = (dir: string, run: string) => join(dir, `${run}.jsonl`);

/** The longest text kept whole. */
const MAX_TEXT = 256 * 1024;
/** About how much one record may hold. It is spent in the order the record's fields come in. */
const MAX_RECORD = 1024 * 1024;
/** How far into nested values a record goes. */
const MAX_DEPTH = 12;
/** The longest name a field is recorded under. */
const MAX_NAME = 1024;
/** How large a journal grows before it stops taking down calls. */
const MAX_JOURNAL = 64 * 1024 * 1024;
/**
 * What a record lost to its limits. Each entry names a value by the path to it
 * and says what was there; the value itself is still in its place, as far as
 * it was kept:
 *   "text"   — its beginning is; `length` and `sha256` are of the whole
 *   "list"   — its first items are; `length` is how many it had
 *   "object" — some of its fields are: those there was room for, with names of a recordable length
 *   "bytes"  — binary data, none of it kept (null); `length` is its size
 *   "depth"  — nested too deep to follow, none of it kept (null)
 * The list is kept apart from the values, in the record's `cuts`, so that
 * nothing a program passes can be mistaken for it — and a record without
 * `cuts` is whole.
 */
type Cut = { path: Array<string | number>; cut: "text" | "list" | "object" | "bytes" | "depth"; length?: number; sha256?: string };

/** What is left of a record's allowance, and what has been cut from it so far. */
interface Room { left: number; cuts: Cut[] }

/**
 * A value as it is written down: whole if there is room, and otherwise cut
 * short, with a note of it in `room.cuts`. Everything written is counted
 * against `room.left` — the notes too — so a record holds about that many
 * characters whatever shape its contents have. (Its line can be longer: JSON
 * writes some characters as escapes of up to six.)
 */
function clip(value: unknown, room: Room, path: Array<string | number> = []): unknown {
  const cut = (about: Omit<Cut, "path">) => {
    room.cuts.push({ path, ...about });
    room.left -= 128 + path.reduce((size: number, step) => size + String(step).length + 3, 0);
  };
  if (typeof value === "string") {
    const keep = Math.max(0, Math.min(MAX_TEXT, room.left));
    room.left -= Math.min(value.length, keep) + 3;
    if (value.length <= keep) return value;
    cut({ cut: "text", length: value.length, sha256: createHash("sha256").update(value).digest("hex") });
    return value.slice(0, keep);
  }
  if (typeof value === "bigint") value = value.toString();
  if (value === null || typeof value !== "object") {
    room.left -= typeof value === "number" ? String(value).length + 1 : 8;
    return value;
  }
  // Binary data is recorded by its size: as text it would be a list of numbers.
  if (ArrayBuffer.isView(value)) {
    cut({ cut: "bytes", length: value.byteLength });
    return null;
  }
  // Anything that knows how it wants to be written (a Date) is asked.
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
    return clip((value as { toJSON(): unknown }).toJSON(), room, path);
  }
  if (path.length >= MAX_DEPTH) {
    cut({ cut: "depth" });
    return null;
  }
  room.left -= 3; // an empty list or object takes room too
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      if (room.left <= 0) {
        cut({ cut: "list", length: value.length });
        break;
      }
      items.push(clip(item, room, [...path, items.length]));
    }
    return items;
  }
  const fields: Record<string, unknown> = {};
  let fieldsLeftOut = false;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    // A field goes in with its name, or not at all. A name that is too long
    // is passed over — it would be repeated in the path of everything cut
    // beneath it — and one there is no room for ends the object.
    const noRoom = room.left <= key.length;
    if (noRoom || key.length > MAX_NAME) {
      if (!fieldsLeftOut) cut({ cut: "object" });
      fieldsLeftOut = true;
      if (noRoom) break;
      continue;
    }
    room.left -= key.length + 3;
    fields[key] = clip((value as Record<string, unknown>)[key], room, [...path, key]);
  }
  return fields;
}

/**
 * Header names whose values are credentials more often than not. Wide on
 * purpose: a header wrongly held back costs little, one wrongly kept is a leak.
 * (Rate-limit headers count tokens, they do not carry one.)
 */
const SECRET_HEADER = /auth|cookie|secret|passw|credential|session|jwt|csrf|xsrf|signature|token|key/i;
const isSecretHeader = (name: string) => SECRET_HEADER.test(name) && !/rate-?limit/i.test(name);

/** A copy of a set of HTTP headers — an object, or a list of pairs — with the secret-looking values left out. */
function redactHeaders(headers: unknown): unknown {
  if (Array.isArray(headers)) {
    return headers.map(pair =>
      Array.isArray(pair) && typeof pair[0] === "string" && isSecretHeader(pair[0]) ? [pair[0], "[redacted]"] : pair);
  }
  if (typeof headers !== "object" || headers === null) return headers;
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, isSecretHeader(name) ? "[redacted]" : value]),
  );
}

/**
 * What is written down of a call's request or result. The one thing known to
 * carry secrets by design — the headers of a web request — is redacted. A
 * secret a program puts anywhere else (a URL, a prompt, a command) is recorded
 * like the rest: the journal cannot tell.
 */
function recordable(endpoint: string, value: unknown): unknown {
  if (endpoint === "/tools/fetch" && typeof value === "object" && value !== null && "headers" in value) {
    return { ...value, headers: redactHeaders((value as { headers: unknown }).headers) };
  }
  return value;
}

export type CallOutcome = { ok: true; result: unknown } | { ok: false; error: string };

export interface Journal {
  /** The run's id — the name of its journal file, without the extension. Empty if nothing is being recorded. */
  readonly run: string;
  /** The journal file. Empty if nothing is being recorded. */
  readonly path: string;
  /**
   * Append a record of the given kind. Put small fields first: a record's
   * allowance is spent in order, and what comes last is what gets cut.
   */
  note(kind: string, fields?: Record<string, unknown>): void;
  /**
   * Record a bridge call as it arrives. Returns its position among the run's
   * calls, and what records how it was answered.
   */
  call(endpoint: string, request: unknown): { seq: number; end(outcome: CallOutcome): void };
  /** Stop recording. Anything noted after this is dropped. */
  close(): void;
}

/** A journal that records nothing. Calls are still numbered, so the rest of the runner need not care. */
function noJournal(): Journal {
  let seq = 0;
  return { run: "", path: "", note() {}, call: () => ({ seq: ++seq, end() {} }), close() {} };
}

/** Journals this process is writing. They are never the ones to make room. */
const beingWritten = new Set<string>();

/** The process that started a journal — named at the start of its first record — or null if it cannot be told. */
function writerOf(path: string): number | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const start = Buffer.alloc(512);
    const pid = /"pid":(\d+)/.exec(start.toString("utf-8", 0, readSync(fd, start, 0, start.length, 0)))?.[1];
    return pid ? Number(pid) : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * Whether a journal is still being written: by this process, or by another
 * runner that is still there. (A journal this process started and has closed
 * is finished, though the process lives on.)
 */
export function stillBeingWritten(path: string): boolean {
  if (beingWritten.has(path)) return true;
  const writer = writerOf(path);
  return writer !== null && writer !== process.pid && isAlive(writer);
}

/**
 * Remove the oldest journals of a project so that, with one more, at most
 * `keep` remain — but never one that is still being written, by this process
 * or by another runner: a run of the same project may be going on right now
 * (two participants of a session, or a program that runs its own project).
 * Such journals stay, and the project holds more than `keep` for a while.
 */
function makeRoom(dir: string, keep: number): void {
  const runs = runsIn(dir);
  for (const run of runs.slice(0, Math.max(0, runs.length - (keep - 1)))) {
    const path = journalIn(dir, run);
    if (!stillBeingWritten(path)) rmSync(path, { force: true });
  }
}

/**
 * Start the journal of a run of `projectDir`, keeping the journals of at most
 * `keep` runs of it (0: record nothing). `about` is what is known at the start
 * and goes into the first record.
 *
 * The journal belongs to the project, not to wherever the program happens to
 * be executed: a fix tried on a copy, or a candidate validated in one, is
 * still recorded here, where it will be looked for.
 *
 * Recording is best-effort. If the journal cannot be opened or written, the
 * run goes on without one — a record must never change what it records.
 */
export function openJournal(projectDir: string, keep: number, about: Record<string, unknown>): Journal {
  if (keep <= 0) return noJournal();

  const started = new Date();
  const run = `${started.toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  let fd: number | null;
  let path: string;
  try {
    mkdirSync(guardPath(projectDir, JOURNAL_DIR), { recursive: true });
    const dir = journalDirOf(projectDir);
    makeRoom(dir, keep);
    path = journalIn(dir, run);
    // Readable by its owner only: it holds what the program read, wrote and was told.
    fd = openSync(path, "a", 0o600);
    beingWritten.add(path);
  } catch (err) {
    console.warn(`[trama] this run is not being recorded: ${err instanceof Error ? err.message : err}`);
    return noJournal();
  }

  const t0 = performance.now();
  let written = 0;
  let full = false;

  const close = () => {
    if (fd === null) return;
    try { closeSync(fd); } catch { /* nothing more to do with it */ }
    fd = null;
    beingWritten.delete(path);
  };

  /** Write one record. `compose` builds it, and may fail: what cannot be written down is noted as such. */
  const write = (kind: string, compose: () => Record<string, unknown>) => {
    if (fd === null) return;
    const at = Math.round(performance.now() - t0);
    let line: string;
    try {
      const room: Room = { left: MAX_RECORD, cuts: [] };
      const record = clip({ at, kind, ...compose() }, room) as Record<string, unknown>;
      if (room.cuts.length > 0) record.cuts = room.cuts;
      line = JSON.stringify(record);
    } catch (err) {
      line = JSON.stringify({ at, kind, unrecordable: err instanceof Error ? err.message : String(err) });
    }
    try {
      appendFileSync(fd, line + "\n");
      written += line.length + 1;
    } catch (err) {
      console.warn(`[trama] the journal could not be written, and stops here: ${err instanceof Error ? err.message : err}`);
      close();
    }
  };

  /** Past its size, a journal keeps the shape of the run — attempts, exits, the end — but no more of its calls. */
  const roomForCalls = () => {
    if (!full && written > MAX_JOURNAL) {
      full = true;
      write("full", () => ({ bytes: written, note: "calls after this point are not recorded" }));
    }
    return !full;
  };

  let seq = 0;
  write("run", () => ({ v: JOURNAL_VERSION, run, pid: process.pid, started: started.toISOString(), project: projectDir, ...about }));

  return {
    run,
    path,
    note: (kind, fields = {}) => write(kind, () => fields),
    call(endpoint, request) {
      const position = ++seq;
      if (!roomForCalls()) return { seq: position, end() {} };
      const arrived = performance.now();
      write("call", () => ({ seq: position, endpoint, request: recordable(endpoint, request) }));
      return {
        seq: position,
        end(outcome) {
          write("result", () => ({
            seq: position,
            ms: Math.round(performance.now() - arrived),
            ...(outcome.ok ? { ok: true, result: recordable(endpoint, outcome.result) } : outcome),
          }));
        },
      };
    },
    close,
  };
}
