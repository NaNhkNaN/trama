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

import { closeSync, constants, fstatSync, openSync, readSync, readdirSync, renameSync, rmSync, writeSync } from "fs";
import { createHash, randomBytes } from "crypto";
import { join } from "path";
import { guardPath, identityIn, identityOf, makeDirsIn, realRootOf } from "./path-guard.js";
import { stagedNameFor } from "./replace-file.js";
import { isJsonObject } from "./serializable.js";
import { messageOf } from "./errors.js";
import { declaredUsage, type AgentUsage, type ToolAnswer } from "./agent-backend.js";

/** The format of the records. Bump it when a reader of older journals would be misled. */
export const JOURNAL_VERSION = 1;

/** Where a project keeps its journals, relative to the project — under logs/, which trama keeps out of version control. */
export const JOURNAL_DIR = join("logs", "journal");

/** The shape of a run's id: ISO timestamp (with dashes) followed by 6 hex digits. */
const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}$/;
/** A record's line is never longer than this: a megabyte of characters, each written as an escape of six at most, and its cuts. */
const LONGEST_LINE = 8 * 1024 * 1024;
const SAFE_READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;

/**
 * A project's journal directory, by its one real name however the project was
 * referred to.
 */
export function journalDirOf(projectDir: string): string {
  // Where the path leads, by the guard's own reckoning — the same before the
  // directory exists as after, and never a place the guard did not check.
  return guardPath(projectDir, JOURNAL_DIR);
}

/** The journal of a run, in a journal directory. */
export const journalIn = (dir: string, run: string) => join(dir, `${run}.jsonl`);

/** How a journal begins: the record of its run, which names the run and the process that writes it. */
const FIRST_RECORD = /^\{"at":\d+,"kind":"run","v":\d+,"run":"([^"]+)","pid":(\d+)[,}]/;

/**
 * Look into what may be a journal — the file of `run`, if one is named —
 * without waiting on a pipe or following a link there: `look` is given what
 * to read it with. Undefined if it is no journal: not a file, or one that
 * does not begin as a journal does. (Any `.jsonl` file can be put where the
 * journals are; only what trama wrote is listed, read, or removed in its turn.)
 * Throws where it cannot be opened at all, which is the caller's to judge.
 */
function inJournal<T>(path: string, run: string | undefined, look: (journal: { writer: number | null; ended(): boolean }) => T): T | undefined {
  const fd = openSync(path, SAFE_READ_FLAGS);
  try {
    const file = fd, stat = fstatSync(fd), size = stat.size;
    if (!stat.isFile()) return undefined;
    const read = (from: number, length: number) => {
      const buffer = Buffer.allocUnsafe(length);
      return buffer.toString("utf-8", 0, readSync(file, buffer, 0, length, from));
    };
    // The start of the first record is always written the same way, however long the record is.
    const first = FIRST_RECORD.exec(read(0, Math.min(size, 512)));
    if (!first || !RUN_ID.test(first[1]) || (run !== undefined && first[1] !== run)) return undefined;
    const pid = Number(first[2]);
    /** The last line, if it begins within the last `length` bytes. */
    const lastLine = (length: number) => {
      const from = Math.max(0, size - length);
      const text = read(from, size - from).trimEnd();
      const line = text.lastIndexOf("\n");
      return line === -1 && from > 0 ? undefined : text.slice(line + 1);
    };
    return look({
      writer: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
      // A record's line is rarely longer than a page, and never than LONGEST_LINE.
      ended() {
        try {
          const last: unknown = JSON.parse(lastLine(4096) ?? lastLine(LONGEST_LINE) ?? "");
          return isJsonObject(last) && last.kind === "end";
        } catch {
          return false; // cut off in the middle of a record
        }
      },
    });
  } catch {
    return undefined;
  } finally {
    try { closeSync(fd); } catch { /* nothing more to do with it */ }
  }
}

/**
 * Whether the file `name` of a journal directory is a journal: named for a
 * run, and beginning as that run's journal does. One that is named for a run
 * and may not be read — another user's run of the project wrote it — is taken
 * at its name: it can be listed and removed in its turn, and cannot be copied.
 */
function isJournal(dir: string, name: string): boolean {
  const run = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : "";
  if (!RUN_ID.test(run)) return false;
  try {
    return inJournal(join(dir, name), run, () => true) === true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EACCES" || code === "EPERM";
  }
}

/** The ids of the runs that have a journal in `dir`, oldest first. (A run's id starts with when it started.) */
export function runsIn(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; // no run has been recorded
    throw err;
  }
  // A journal is a file. Anything else that bears a journal's name — a directory, a link, a pipe,
  // which would hold up whoever opened it — is not one; nor is a file somebody else put there.
  return entries.filter((entry) => entry.isFile() && isJournal(dir, entry.name))
    .map((entry) => entry.name.slice(0, -".jsonl".length)).sort();
}

/**
 * What a copy of `projectDir` is to leave out so as not to carry the project's
 * journals, each by what it is (its `identityOf`): the directory they are in,
 * if nothing else is in it or it may not be read or searched — and otherwise every
 * journal in it. Somebody's own file among the journals is the project's
 * like any other, and is copied.
 */
export function journalEntriesOf(projectDir: string): Set<string> {
  const only = (...ids: Array<string | undefined>) => new Set(ids.filter((id): id is string => id !== undefined));
  let dir: string | undefined;
  /** The directory itself — which is not left out where it is the project (by links that lead back to it). */
  const whole = () => {
    const id = dir === undefined ? undefined : identityOf(dir);
    return id === identityOf(realRootOf(projectDir)) ? undefined : id;
  };
  try {
    const journalDir = dir = journalDirOf(projectDir);
    const entries = readdirSync(journalDir, { withFileTypes: true });
    const journals = entries.filter((entry) => entry.isFile() && isJournal(journalDir, entry.name));
    const all = journals.length === entries.length ? whole() : undefined;
    return all !== undefined ? only(all) : only(...journals.map((entry) => identityOf(join(journalDir, entry.name))));
  } catch (err) {
    // Where the journals would be, the project has none: the way leads out of it, or to nothing, or to a file.
    // And a directory that may not be read, or looked into, is left out whole: no part of it can be told from another.
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EACCES" || code === "EPERM" ? only(whole()) : only();
  }
}

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
function clip(value: unknown, room: Room, path: Array<string | number> = [], expanded = false): unknown {
  const cut = (about: Omit<Cut, "path">) => {
    room.cuts.push({ path, ...about });
    room.left -= 128 + path.reduce((size: number, step) => size + String(step).length + 3, 0);
  };
  if (typeof value === "bigint") value = value.toString();
  if (typeof value === "string") {
    const keep = Math.max(0, Math.min(MAX_TEXT, room.left));
    room.left -= Math.min(value.length, keep) + 3;
    if (value.length <= keep) return value;
    cut({ cut: "text", length: value.length, sha256: createHash("sha256").update(value).digest("hex") });
    return value.slice(0, keep);
  }
  if (value === null || typeof value !== "object") {
    room.left -= typeof value === "number" ? String(value).length + 1 : 8;
    return value;
  }
  // Binary data is recorded by its size: as text it would be a list of numbers.
  if (ArrayBuffer.isView(value)) {
    cut({ cut: "bytes", length: value.byteLength });
    return null;
  }
  // Anything that knows how it wants to be written (a Date) is asked — once per slot, like JSON.stringify.
  if (!expanded && typeof (value as { toJSON?: unknown }).toJSON === "function") {
    return clip((value as { toJSON(): unknown }).toJSON(), room, path, true);
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
    // What cannot be written down is no field, as it is none to JSON — and so nothing the record
    // is made of says how it wants to be written: each thing was asked that once, above.
    const field = (value as Record<string, unknown>)[key];
    if (typeof field === "function") continue;
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
    fields[key] = clip(field, room, [...path, key]);
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
  if (!isJsonObject(headers)) return headers;
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
  if (endpoint === "/tools/fetch" && isJsonObject(value) && "headers" in value) {
    return { ...value, headers: redactHeaders(value.headers) };
  }
  return value;
}

export type CallOutcome = { ok: true; result: unknown } | { ok: false; error: string };

/** A bridge call on record: its position among the run's calls, and what is written down of it later. */
export interface RecordedCall {
  seq: number;
  /** How it was answered. */
  end(outcome: CallOutcome): void;
  /** What the agent behind it used — each time it was asked, and whether or not the call is answered. */
  used(usage: AgentUsage): void;
  /**
   * That the agent behind it called a tool of the program's (`id`: as the
   * model called it) — what the program was asked. Returns what writes down
   * what the program answered: a use of a tool that was not waited for has
   * no answer on record, as a call nobody was left to answer has no result.
   */
  tool(id: string, name: string, args: unknown): (answer: ToolAnswer) => void;
}

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
  /** Record what the agent used on the runner's own account — asking for a fix, say (`what`: "fix"). */
  used(what: string, usage: AgentUsage): void;
  /**
   * Record a bridge call as it arrives. Returns its position among the run's
   * calls, and what records how it was answered.
   */
  call(endpoint: string, request: unknown): RecordedCall;
  /** Stop recording. Anything noted after this is dropped. */
  close(): void;
}

/** A journal that records nothing. Calls are still numbered, so the rest of the runner need not care. */
/** What is written down of a call that is not on record: nothing. */
const UNRECORDED: Omit<RecordedCall, "seq"> = { end() {}, used() {}, tool: () => () => {} };

/** A call that is nobody's to look up: what carries other calls rather than being one (see ipc-server). */
export const OFF_THE_RECORD: RecordedCall = { seq: 0, ...UNRECORDED };

function noJournal(): Journal {
  let seq = 0;
  return { run: "", path: "", note() {}, used() {}, call: () => ({ seq: ++seq, ...UNRECORDED }), close() {} };
}

/**
 * Journals this process is writing, each by what it is (see identityOf): a
 * project may be named in more ways than one, and its journals with it. They
 * are never the ones to make room.
 */
const beingWritten = new Set<string>();

/**
 * Whether a journal is still being written: by this process, or by another
 * runner that is still there and has not yet written its ending. (A journal
 * this process started and has closed is finished, though the process lives
 * on. And a process that may not be signalled is not the writer of a journal
 * that can be read: its number has been given to somebody else's since.)
 */
export function stillBeingWritten(path: string): boolean {
  const journal = identityOf(path);
  if (journal !== undefined && beingWritten.has(journal)) return true;
  const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    return inJournal(path, undefined, ({ writer, ended }) =>
      writer !== null && writer !== process.pid && isAlive(writer) && !ended()) === true;
  } catch {
    return false; // (nothing to be read there, so nothing that says who writes it)
  }
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
  const t0 = performance.now();
  let fd: number | null = null;
  let path = "";
  let staged = "";
  let identity: string | undefined;
  let written = 0;
  let full = false;

  const formatLine = (at: number, kind: string, compose: () => Record<string, unknown>): string => {
    try {
      const room: Room = { left: MAX_RECORD, cuts: [] };
      const record = clip({ at, kind, ...compose() }, room) as Record<string, unknown>;
      if (room.cuts.length > 0) record.cuts = room.cuts;
      return JSON.stringify(record);
    } catch (err) {
      return JSON.stringify({ at, kind, unrecordable: messageOf(err) });
    }
  };

  try {
    const dir = journalDirOf(projectDir);
    // (In the project, which is there: a journal is not what makes a directory where a project was.)
    makeDirsIn(projectDir, dir);
    makeRoom(dir, keep);
    path = journalIn(dir, run);
    staged = stagedNameFor(path);
    const firstLine = formatLine(0, "run", () => ({
      v: JOURNAL_VERSION, run, pid: process.pid, started: started.toISOString(), project: projectDir, ...about,
    }));
    // Readable by its owner only, and whole from the moment its name appears in the directory.
    fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND, 0o600);
    written = writeSync(fd, firstLine + "\n");
    identity = identityIn(fstatSync(fd, { bigint: true }));
    beingWritten.add(identity);
    renameSync(staged, path);
    staged = "";
  } catch (err) {
    if (fd !== null) try { closeSync(fd); } catch { /* ignore */ }
    if (identity !== undefined) beingWritten.delete(identity);
    if (staged) try { rmSync(staged, { force: true }); } catch { /* ignore */ }
    console.warn(`[trama] this run is not being recorded: ${messageOf(err)}`);
    return noJournal();
  }

  const close = () => {
    if (fd === null) return;
    try { closeSync(fd); } catch { /* nothing more to do with it */ }
    fd = null;
    if (identity !== undefined) beingWritten.delete(identity);
  };

  /** Write one record. `compose` builds it, and may fail: what cannot be written down is noted as such. */
  const write = (kind: string, compose: () => Record<string, unknown>) => {
    if (fd === null) return;
    const line = formatLine(Math.round(performance.now() - t0), kind, compose);
    try {
      written += writeSync(fd, line + "\n");
    } catch (err) {
      console.warn(`[trama] the journal could not be written, and stops here: ${messageOf(err)}`);
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

  return {
    run,
    path,
    note: (kind, fields = {}) => write(kind, () => fields),
    used: (what, usage) => write("usage", () => ({ for: what, ...declaredUsage(usage) })),
    call(endpoint, request) {
      const position = ++seq;
      if (!roomForCalls()) return { seq: position, ...UNRECORDED };
      const arrived = performance.now();
      // How many times the agent behind it has called a tool of the program's.
      let uses = 0;
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
        used(usage) {
          write("usage", () => ({ seq: position, ...declaredUsage(usage) }));
        },
        tool(id, name, args) {
          const use = ++uses;
          const asked = performance.now();
          write("tool-call", () => ({ seq: position, tool: use, id, name, args }));
          return (answer) => write("tool-result", () => ({
            seq: position,
            tool: use,
            ms: Math.round(performance.now() - asked),
            ...(answer.failed ? { ok: false, error: answer.text } : { ok: true, result: answer.text }),
          }));
        },
      };
    },
    close,
  };
}
