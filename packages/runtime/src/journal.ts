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

/** Where a project's journals are kept — under logs/, which trama keeps out of version control. */
export const journalDirOf = (projectDir: string) => guardPath(projectDir, join("logs", "journal"));

/** The longest text kept whole. */
const MAX_TEXT = 256 * 1024;
/** About how much one record may hold. It is spent in the order the record's fields come in. */
const MAX_RECORD = 1024 * 1024;
/** How far into nested values a record goes. */
const MAX_DEPTH = 12;
/** How large a journal grows before it stops taking down calls. */
const MAX_JOURNAL = 64 * 1024 * 1024;

/** Stands for what a record had no room left for. */
const OMITTED = { clipped: "", omitted: true };

/**
 * A value as it is written down: whole if there is room, and otherwise cut
 * short — a long text keeps its beginning, its real length and a hash to tell
 * what was there. `room` is what is left of the record's allowance; everything
 * written is counted against it, so a record stays about that size whatever
 * shape its contents have, and takes about that long to write.
 */
function clip(value: unknown, room: { left: number }, depth = 0): unknown {
  if (room.left <= 0) return OMITTED;
  if (typeof value === "string") {
    const keep = Math.min(MAX_TEXT, room.left);
    room.left -= Math.min(value.length, keep) + 2;
    if (value.length <= keep) return value;
    return {
      clipped: value.slice(0, keep),
      length: value.length,
      sha256: createHash("sha256").update(value).digest("hex"),
    };
  }
  if (typeof value === "bigint") value = value.toString();
  if (value === null || typeof value !== "object") {
    room.left -= 8;
    return value;
  }
  // Binary data is recorded by its size: as text it would be a list of numbers.
  if (ArrayBuffer.isView(value)) {
    room.left -= 32;
    return { clipped: "", bytes: value.byteLength };
  }
  // Anything that knows how it wants to be written (a Date) is asked.
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
    return clip((value as { toJSON(): unknown }).toJSON(), room, depth);
  }
  if (depth >= MAX_DEPTH) {
    room.left -= 32;
    return { clipped: "", nested: true };
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      if (room.left <= 0) {
        items.push({ ...OMITTED, items: value.length });
        break;
      }
      items.push(clip(item, room, depth + 1));
    }
    return items;
  }
  const fields: Record<string, unknown> = {};
  // Walked field by field rather than listed first: an object with millions
  // of fields is left as soon as the room runs out.
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (room.left <= 0) {
      fields["…"] = OMITTED;
      break;
    }
    room.left -= key.length + 3;
    fields[key] = clip((value as Record<string, unknown>)[key], room, depth + 1);
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
export function writerOf(path: string): number | null {
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
  const journals = readdirSync(dir).filter(name => name.endsWith(".jsonl")).sort();
  for (const name of journals.slice(0, Math.max(0, journals.length - (keep - 1)))) {
    const path = join(dir, name);
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
    mkdirSync(journalDirOf(projectDir), { recursive: true });
    // One name for one directory, however the project was referred to: a
    // journal is recognised as still being written by its path.
    const dir = realpathSync(journalDirOf(projectDir));
    makeRoom(dir, keep);
    path = join(dir, `${run}.jsonl`);
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
      line = JSON.stringify(clip({ at, kind, ...compose() }, { left: MAX_RECORD }));
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
