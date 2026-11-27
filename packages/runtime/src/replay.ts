// A replay: a program's calls answered from the record of an earlier run.
//
// A run's journal has every call its program made across the bridge, and what
// each was answered. A program is, to a large degree, what its answers make
// it: told the same things, it asks the same things. So a program can be run
// again against a record — each call that is the recorded one answered as it
// was, and not carried out. Nothing is asked of a model, no command runs,
// nothing is written or spent; what comes of it is how far the program went
// the way it had gone, and where it first went another.
//
// It is a dry run, and whole as one: every answer is from the record, so the
// program is consistent with itself (what it reads is what the record says
// was read), and the world is not touched. The moment one call were carried
// out and the next answered from the record, the two could disagree — an
// effect is not on record, only its answer is — so a replay ends where the
// program leaves its record. (Going on for real from there is another thing,
// and not this.)
//
// What is here: reading a record into what can be answered from it
// (`readRecording`), and matching a program's calls to it (`createReplay`).
// The bridge asks it for each call (ipc-server.ts); the runner runs the
// program so (`replayProgram`, in runner.ts).

import { readFileSync } from "fs";
import { dirname } from "path";
import { journalDirOf, journalIn, runsIn, stillBeingWritten } from "./journal.js";
import { projectAt } from "./path-guard.js";
import { requestsWhole } from "./journal-view.js";
import { isJsonObject } from "./serializable.js";
import type { ProgramResult } from "./runner-types.js";
import type { OwnTool } from "./agent-backend.js";

/** A call as the record has it, and what it has to answer it with. */
export interface RecordedCall {
  endpoint: string;
  request: unknown;
  /** How it was answered. */
  answer?: { ok: true; result: unknown } | { ok: false; error: string };
  /** Why the record cannot answer it, where it cannot. */
  unanswerable?: string;
  /** The uses of the program's own tools that the agent behind it made, in the order they were asked — and what the program answered each, where it did. */
  tools: Array<{ id: string; name: string; args: unknown; answer?: { failed: boolean; text: string } }>;
  /** Where in the journal it arrived, and where it was answered: a call that arrived before another was answered was in flight with it. */
  arrived: number;
  answeredAt: number;
  /** Which of the program's calls it was matched to, in a replay: the first is 1. */
  number?: number;
}

/** What a replay is made from: one attempt of a recorded run. */
export interface Recording {
  run: string;
  attempt: number;
  /** The program that was recorded, by its hash. */
  program?: string;
  /** What the run was started with. */
  args?: Record<string, unknown>;
  workspace?: string;
  /** The version the run was of, where it was of one that was named and not of the program as it was. */
  version?: number;
  /** The state the attempt began from. */
  state: Record<string, unknown>;
  /** How the attempt ended: null, where it failed. Undefined where the record does not say. */
  outcome?: ProgramResult | null;
  /** How the run ended. */
  end?: ProgramResult;
  /** Its calls to the world, in the order they arrived. (What a program says to its own run — `ctx.*` — is no part of them.) */
  calls: RecordedCall[];
}

const NOT_WHOLE = "the record does not have it whole: it was too large to keep";

/**
 * Calls that are beside what a replay matches, and are carried out in one:
 * what a program says to its own run (`ctx.*`), and its word that a run it
 * asked for is to stop — which is said of a call, and is no call to the
 * world itself. (In a replay no run is in flight to be stopped.)
 */
export const besideTheRecord = (endpoint: string): boolean => endpoint.startsWith("/ctx/") || endpoint === "/run/stop";

/**
 * A value with one directory's path made another's, wherever a text in it
 * has it. A program does not choose where it is run: a replay runs it in a
 * copy, and a fix was recorded in one — so what it asks may have its place
 * in it (a path made from its working directory, a project named beside its
 * own). Both are read as the project's own place before they are held
 * against each other.
 */
export function placed(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") return value.includes(from) ? value.split(from).join(to) : value;
  if (Array.isArray(value)) return value.map((item) => placed(item, from, to));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, held]) => [key, placed(held, from, to)]));
  return value;
}

/** The records of a journal, as far as they can be read. (A line that is no record — the last of a journal cut off in the writing — is passed over.) */
const recordsIn = (path: string): Array<Record<string, any>> =>
  readFileSync(path, "utf-8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });

/**
 * The runs of a project that a replay may be made from without one being
 * named, oldest first: those that are runs (and no validation), and are
 * over. A run that is still going is not among them — its record is not
 * all there yet, and a program that replays its own project would be
 * answered from the run it is in.
 */
export function runsToReplay(projectDir: string): string[] {
  const dir = journalDirOf(projectDir);
  return runsIn(dir).filter((run) => {
    const path = journalIn(dir, run);
    try {
      return !stillBeingWritten(path) && recordsIn(path)[0]?.purpose === "run";
    } catch {
      return false; // (gone since it was listed, or not to be read)
    }
  });
}

/**
 * Read the record of a run of the project: the run named — also one that
 * is still going, as far as it has got — or else the latest there is to
 * replay (see `runsToReplay`). Of a run that was repaired, the last
 * attempt: the program that came of it. Throws where there is nothing to
 * replay, or the record does not say what a replay has to begin from.
 */
export function readRecording(projectDir: string, run?: string): Recording {
  const dir = journalDirOf(projectDir);
  if (run !== undefined && !runsIn(dir).includes(run)) {
    throw new Error(`No journal for run ${JSON.stringify(run)}. \`trama journal <name> --list\` shows the runs that have one.`);
  }
  run ??= runsToReplay(projectDir).at(-1);
  if (run === undefined) throw new Error("No run of the project is on record: there is nothing to replay.");
  const records = recordsIn(journalIn(dir, run));

  const head = records[0] ?? {};
  const from = records.map((record) => record.kind).lastIndexOf("attempt");
  if (from < 0) throw new Error(`The record of run ${run} has no attempt in it: the run did not come to start its program.`);
  const attempt = records[from];
  if (head.cuts || attempt.cuts) throw new Error(`The record of run ${run} does not have whole what it began from: it was too large to keep.`);
  let state: unknown = attempt.state;
  if (state === undefined) {
    // (Made before the state was kept with the attempt: by 0.8.0 or before, which wrote down in its place how often the
    // state had been kept — `iteration`. A run that had kept none and resumed nothing began with none.)
    if (attempt.iteration !== 0 || attempt.resumed) throw new Error(`The record of run ${run} does not say what state it began from (it was made before that was kept): it cannot be replayed.`);
    state = {};
  }
  if (!isJsonObject(state)) throw new Error(`The record of run ${run} has no state a run can begin from.`);

  const mine = records.slice(from);
  const whole = requestsWhole(records);
  // An attempt that ran in a copy of the project — a fix that was tried — asked from there: read as asked from the project's place.
  const was = typeof attempt.dir === "string" && attempt.dir !== head.project ? dirname(attempt.dir) : undefined;
  const home = dirname(projectAt(projectDir));
  const inPlace = (request: unknown) => (was === undefined || was === home ? request : placed(request, was, home));
  const placeOf = new Map<number, number>();
  mine.forEach((record, at) => { if (record.kind === "result") placeOf.set(record.seq, at); });
  const calls: RecordedCall[] = [];
  const bySeq = new Map<number, RecordedCall>();
  mine.forEach((record, at) => {
    if (record.kind === "call" && !besideTheRecord(record.endpoint)) {
      const answeredAt = placeOf.get(record.seq), result = answeredAt === undefined ? undefined : mine[answeredAt];
      const call: RecordedCall = {
        endpoint: record.endpoint,
        request: inPlace(record.endpoint === "/agent/complete" ? (whole.get(record.seq) ?? record.request) : record.request),
        tools: [],
        arrived: at,
        answeredAt: answeredAt ?? Infinity,
        ...(record.cuts || result?.cuts ? { unanswerable: NOT_WHOLE }
          : !result ? { unanswerable: "the record has no answer for it: the run ended before it was answered" }
          : { answer: result.ok ? { ok: true as const, result: result.result } : { ok: false as const, error: String(result.error) } }),
      };
      calls.push(call);
      bySeq.set(record.seq, call);
    } else if (record.kind === "tool-call") {
      bySeq.get(record.seq)?.tools.push({ id: String(record.id), name: String(record.name), args: record.args });
    } else if (record.kind === "tool-result") {
      const use = bySeq.get(record.seq)?.tools[record.tool - 1];
      if (use) use.answer = record.ok ? { failed: false, text: String(record.result) } : { failed: true, text: String(record.error) };
    }
  });

  const exit = mine.find((record) => record.kind === "exit");
  const end = records.find((record) => record.kind === "end");
  return {
    run,
    attempt: Number(attempt.attempt) || 0,
    ...(attempt.program?.sha256 && { program: String(attempt.program.sha256) }),
    ...(isJsonObject(head.args) && { args: head.args }),
    ...(typeof head.workspace === "string" && { workspace: head.workspace }),
    ...(typeof head.version === "number" && { version: head.version }),
    state,
    // (An end that was too large to keep whole is not one another can be held against: the record then does not say.)
    ...(exit && !exit.cuts && !("error" in exit) && { outcome: (exit.outcome ?? null) as ProgramResult | null }),
    ...(end?.result && !end.cuts && { end: end.result as ProgramResult }),
    calls,
  };
}

/** A value as text, whatever order its fields were written in: two that say the same are the same text. */
const said = (value: unknown): string => JSON.stringify(value, (_key, held) => (held && typeof held === "object" && !Array.isArray(held)
  ? Object.fromEntries(Object.entries(held).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : held)) ?? "undefined";

/** Whether two values say the same. */
export const saysTheSame = (a: unknown, b: unknown): boolean => said(a) === said(b);

const shown = (value: unknown): string => { const text = said(value); return text.length > 140 ? `${text.slice(0, 140)}… (${text.length} characters)` : text; };

/** Where what was asked first differs from what was recorded: the way to it, and what each has there. Nothing, where they say the same. */
export function firstDifference(asked: unknown, recorded: unknown, path = ""): string | undefined {
  if (saysTheSame(asked, recorded)) return undefined;
  if (typeof asked === "object" && asked !== null && typeof recorded === "object" && recorded !== null && Array.isArray(asked) === Array.isArray(recorded)) {
    for (const key of new Set([...Object.keys(asked), ...Object.keys(recorded)])) {
      const found = firstDifference((asked as Record<string, unknown>)[key], (recorded as Record<string, unknown>)[key], `${path}/${key}`);
      if (found) return found;
    }
  }
  const where = path || "(the whole of it)";
  if (typeof asked === "string" && typeof recorded === "string") {
    let same = 0;
    while (same < asked.length && asked[same] === recorded[same]) same += 1;
    const about = (text: string) => JSON.stringify(`${same > 30 ? "…" : ""}${text.slice(Math.max(0, same - 30), same + 90)}${text.length > same + 90 ? "…" : ""}`);
    return `${where} at character ${same}: asked ${about(asked)} | recorded ${about(recorded)}`;
  }
  return `${where}: asked ${shown(asked)} | recorded ${shown(recorded)}`;
}

/** The calls that last as long as what they ask for, and are named by the client so that they can be stopped: by an id made for the call. */
const NAMED = ["/run/program", "/project/create", "/project/update", "/project/version", "/project/rollback", "/project/replay"];

/** A request as it is matched: without what is the client's own way of carrying a call, and no part of what the program asked. */
function matched(endpoint: string, request: unknown): unknown {
  if (!isJsonObject(request)) return request;
  if ("toolsId" in request) return { ...request, toolsId: undefined };
  if ("id" in request && NAMED.includes(endpoint)) return { ...request, id: undefined };
  return request;
}

/** The program has left the record: the call it left at is not answered, and the program is being stopped. */
export class LeftTheRecord extends Error {
  constructor() { super("The program left the record it was being replayed from"); }
}

export interface Replay {
  /**
   * The recorded call that this call of the program's is: the next the
   * record has, or one that was in flight together with it — such calls
   * may be made again in any order. Throws `LeftTheRecord`, having noted
   * where and why, where the record has no such call or cannot answer it.
   */
  take(endpoint: string, request: unknown): RecordedCall;
  /** The call was answered from the record. */
  answered(call: RecordedCall): void;
  /** The program has left the record at this call, for this reason — which is noted, the first time; and it throws. */
  leave(call: Pick<RecordedCall, "number" | "endpoint">, why: string): never;
  /** What is to be done when the program leaves the record: once. (The runner stops the program.) */
  whenLeft(then: () => void): void;
  /** How it went, so far. */
  readonly state: {
    recorded: number;
    answered: number;
    /** Calls answered though they asked otherwise than was recorded (`loose`). */
    other: Array<{ call: number; endpoint: string; difference: string }>;
    left?: { call: number; endpoint: string; why: string };
  };
}

/**
 * Match a program's calls to a recording. `loose`: a call is answered
 * wherever its endpoint is the recorded one, whatever it asks — which asks
 * not "does the program ask the same" but "does it get through what was
 * answered" — and each request that was other is noted. `place`: where the
 * program is run for the replay, and where its project is — what it asks is
 * read as asked from there (see `placed`).
 */
export function createReplay(recording: Recording, options: { loose?: boolean; place?: { from: string; to: string } } = {}): Replay {
  const pending = [...recording.calls];
  const state: Replay["state"] = { recorded: recording.calls.length, answered: 0, other: [] };
  let taken = 0, then = () => {};

  const replay: Replay = {
    state,
    whenLeft(what) { then = what; if (state.left) what(); },

    leave(call, why) {
      if (!state.left) {
        state.left = { call: call.number ?? taken + 1, endpoint: call.endpoint, why };
        then();
      }
      throw new LeftTheRecord();
    },

    take(endpoint, request) {
      // (After it has left, a program is being stopped: nothing more of it is answered.)
      if (state.left) throw new LeftTheRecord();
      const { place } = options;
      const asked = matched(endpoint, place && place.from !== place.to ? placed(request, place.from, place.to) : request);
      // What may be next: the first the record still has, and those that had arrived before any before them was answered.
      const window: RecordedCall[] = [];
      let firstAnswered = Infinity;
      for (const call of pending) {
        if (call.arrived > firstAnswered) break;
        window.push(call);
        firstAnswered = Math.min(firstAnswered, call.answeredAt);
      }
      // (A call the record does not have whole is known by its endpoint alone.)
      const sameAs = (call: RecordedCall) => call.endpoint === endpoint && (call.unanswerable === NOT_WHOLE || saysTheSame(asked, matched(endpoint, call.request)));
      const found = window.find(sameAs) ?? (options.loose ? window.find((call) => call.endpoint === endpoint) : undefined);
      if (!found) {
        const [next] = pending;
        return replay.leave({ endpoint }, !next ? "the record has no more calls"
          : next.endpoint !== endpoint ? `another call: asked ${endpoint} | recorded ${next.endpoint}`
          : firstDifference(asked, matched(endpoint, next.request)) ?? "it is not what was recorded");
      }
      found.number = taken += 1;
      pending.splice(pending.indexOf(found), 1);
      if (found.unanswerable) return replay.leave(found, found.unanswerable);
      if (!sameAs(found)) state.other.push({ call: found.number, endpoint, difference: firstDifference(asked, matched(endpoint, found.request)) ?? "" });
      return found;
    },

    answered() { state.answered += 1; },
  };
  return replay;
}

/**
 * What is done again of an agent call that is answered from the record: the
 * tools of the program's own that the agent called. The program is asked
 * what it was asked, in the order it was asked — so that what its tools do
 * in the program is done, as it was — and what each answers is held against
 * what it answered: a tool that answers otherwise is the program leaving its
 * record.
 */
export async function askAgain(replay: Replay, call: RecordedCall, own: OwnTool[] | undefined): Promise<void> {
  const told = ({ failed, text }: { failed: boolean; text: string }) => `${failed ? "failed, " : ""}${JSON.stringify(text.length > 120 ? `${text.slice(0, 120)}…` : text)}`;
  for (const use of call.tools) {
    const tool = own?.find((one) => one.name === use.name);
    if (!tool) replay.leave(call, `the record has its tool ${JSON.stringify(use.name)} asked, and the call has no such tool of the program's now`);
    // (A use nobody waited for has no answer on record, and was no part of what the program was told to the end.)
    if (!use.answer) continue;
    const answer = await tool!.run(use.args, use.id);
    const now = { failed: answer.failed === true, text: answer.text };
    if (now.failed !== use.answer.failed || now.text !== use.answer.text) {
      replay.leave(call, `its tool ${JSON.stringify(use.name)} answered otherwise: ${told(now)} | recorded ${told(use.answer)}`);
    }
  }
}
