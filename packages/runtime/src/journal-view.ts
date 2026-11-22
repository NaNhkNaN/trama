// Showing a journal: what `trama journal` prints.
//
// This reads what journal.ts writes, and only to show it. A journal is read
// as far as it goes — a run may still be writing it, or have died doing so.

import { readFileSync } from "fs";
import { JOURNAL_VERSION, journalDirOf, journalIn, runsIn, stillBeingWritten } from "./journal.js";
import { isJsonObject } from "./serializable.js";

type JournalRecord = { kind: string; at: number } & Record<string, any>;

/**
 * The records of a journal file. A line that is not a whole record — the last
 * one, if the runner died writing it — is left out, and so is a file that
 * cannot be read at all.
 */
function readJournal(path: string): JournalRecord[] {
  const records: JournalRecord[] = [];
  let text = "";
  try { text = readFileSync(path, "utf-8"); } catch { /* shown as a run with nothing on record */ }
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      if (isJsonObject(record)) records.push(record as JournalRecord);
    } catch { /* not a whole record */ }
  }
  return records;
}

const oneLine = (value: unknown, max: number): string => {
  const text = (typeof value === "string" ? value : JSON.stringify(value) ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
};

/** The one field of a request that says most about it. */
/**
 * The requests to a model on a record, each whole, by the position of its
 * call: a journal has of each what it adds to the one before (see
 * `besideTheLast` in journal.ts), and this puts them together again. (As far
 * as the record has them: what was cut from a record for its size is cut.)
 */
export function requestsWhole(records: Array<Record<string, any>>): Map<number, Record<string, unknown>> {
  const whole = new Map<number, Record<string, unknown>>();
  let last: Record<string, any> | undefined;
  for (const record of records) {
    if (record.kind !== "call" || record.endpoint !== "/agent/complete" || !Array.isArray(record.request?.messages)) continue;
    const { messagesBefore = 0, unchanged = [], messages, ...others } = record.request;
    const request: Record<string, any> = { ...others };
    for (const name of unchanged) if (last?.[name] !== undefined) request[name] = last[name];
    request.messages = [...(last?.messages ?? []).slice(0, messagesBefore), ...messages];
    whole.set(record.seq, request);
    last = request;
  }
  return whole;
}

/** The words of a conversation's last message — or, where it has none, what it has instead. */
function lastSaid(messages: unknown[]): string {
  const content = (messages.at(-1) as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  const parts = Array.isArray(content) ? content as Array<Record<string, unknown>> : [];
  const text = parts.find(part => typeof part?.text === "string");
  return text ? String(text.text) : parts.length > 0 ? `(${String(parts[0]?.type)})` : "";
}

function gist(request: Record<string, unknown> | undefined): string {
  // A run that was asked for is best known by the name it was given.
  if (typeof request?.label === "string") return oneLine(`${request.label}  (${request.projectDir})`, 60);
  // ...and a project that was asked for by its own.
  if (typeof request?.name === "string") return oneLine(`${request.name}: ${typeof request.prompt === "string" ? request.prompt : ""}`, 60);
  // ...and a request to a model by the last that was said in the conversation it carries.
  if (Array.isArray(request?.messages)) return oneLine(request.messages.length === 0 && request.messagesBefore ? "(asked again, as before)" : lastSaid(request.messages), 60);
  for (const field of ["prompt", "command", "path", "pattern", "url", "message", "projectDir", "reason"]) {
    if (request?.[field] !== undefined) return oneLine(request[field], 60);
  }
  return "";
}

/** What reports of usage — `usage` records, or what a backend said — add up to, in a few words: and nothing where there are none. */
export function spentIn(usage: object[]): string {
  if (usage.length === 0) return "";
  const sum = (field: string) => usage.reduce((total, record) => total + (Number((record as Record<string, unknown>)[field]) || 0), 0);
  return `${sum("input") + sum("output") + sum("cacheRead") + sum("cacheWrite")} tokens  $${sum("cost").toFixed(4)}`;
}

/** How a call, or a use of a tool, was answered — as its record of that says, where it has one. */
const howAnswered = (answer: JournalRecord | undefined): string =>
  !answer ? "never answered"
    : answer.ok ? `ok  ${answer.ms}ms`
    : `failed  ${answer.ms}ms  ${oneLine(answer.error, 60)}`;

const usageIn = (records: JournalRecord[]) => records.filter(record => record.kind === "usage");

/**
 * What a run used, as far as its journal says. That is all of it (`inAll`
 * says so) unless the journal filled up: then it is what is on record, be
 * that nothing, and is said to be.
 */
/** What a project asked for a fix used (see the `fix` record), as a report of usage is added up: its tokens are not told apart there. */
const asUsage = (used: { tokens?: number; cost?: number }) => ({ input: used.tokens ?? 0, cost: used.cost ?? 0 });

function spentInAll(records: JournalRecord[], inAll = ""): string {
  // (A fix is part of the run it is for, whoever made it: what a project used for one is counted with the rest.)
  const counted = spentIn([...usageIn(records), ...records.filter(record => record.kind === "fix" && record.used).map(record => asUsage(record.used))]);
  if (!records.some(record => record.kind === "full")) return counted && counted + inAll;
  return `${counted || "no usage"} on record — the journal was full`;
}

/** How a run ended, in a word or two — or that it has not, or never will. */
function ending(path: string, records: JournalRecord[]): string {
  const end = records.find(record => record.kind === "end");
  if (!end) return stillBeingWritten(path) ? "still running" : "did not finish";
  return end.result ? end.result.status : `could not run: ${oneLine(end.error, 60)}`;
}

function printJournal(path: string, records: JournalRecord[]): void {
  const head = records[0];
  const howEnded = ending(path, records);
  console.log(`${head?.run ?? "?"}  ${head?.purpose ?? ""}${head?.label ? ` [${head.label}]` : ""}  ${howEnded}`);
  if (head && head.v !== JOURNAL_VERSION) {
    console.log(`(recorded in format ${head.v}; this trama reads format ${JOURNAL_VERSION}, and shows what it can make of it)`);
  }

  const results = new Map<number, JournalRecord>();
  for (const record of records) if (record.kind === "result") results.set(record.seq, record);
  // What a tool of the program's answered, by the call it was used for and which use of a tool that was.
  const answers = new Map<string, JournalRecord>();
  for (const record of records) if (record.kind === "tool-result") answers.set(`${record.seq}/${record.tool}`, record);
  const usage = usageIn(records);
  const total = spentInAll(records, " in all");

  for (const record of records) {
    const at = `${(record.at / 1000).toFixed(3).padStart(9)}s`;
    switch (record.kind) {
      case "attempt":
        console.log(`${at}  attempt ${record.attempt}  program ${record.program?.sha256?.slice(0, 8) ?? "missing"}`);
        break;
      case "call": {
        const how = howAnswered(results.get(record.seq));
        const used = spentIn(usage.filter(item => item.seq === record.seq));
        console.log(`${at}  #${String(record.seq).padEnd(3)} ${record.endpoint.slice(1).padEnd(18)} ${gist(record.request).padEnd(60)}  ${how}${used && `  ${used}`}`);
        break;
      }
      case "tool-call": {
        const how = howAnswered(answers.get(`${record.seq}/${record.tool}`));
        console.log(`${at}  #${String(record.seq).padEnd(3)} ${`  tool ${record.name}`.padEnd(18)} ${oneLine(record.args, 60).padEnd(60)}  ${how}`);
        break;
      }
      case "usage":
        // (What a call used is shown with the call.)
        if (record.for === "fix") console.log(`${at}  asking for the fix used ${spentIn([record])}`);
        if (record.for === "generate") console.log(`${at}  writing the program used ${spentIn([record])}`);
        break;
      case "budget":
        console.log(`${at}  ${oneLine(record.spent, 100)}`);
        break;
      case "child":
        // (A run a call of the program's started — or, for a fix, one the run itself started.)
        console.log(record.purpose === "fix"
          ? `${at}  the fix is asked of a project: run ${record.run}`
          : `${at}  #${String(record.seq).padEnd(3)} started ${record.purpose === "validate" ? "validation" : "run"} ${record.run}`);
        break;
      case "fix-request":
        console.log(`${at}  fix asked for: ${oneLine(record.error, 80)}`);
        break;
      case "fix":
        // (What a project that was asked for it used is said with it: what pi's agent used is in the lines of `usage`.)
        console.log(`${at}  fix ${record.ok ? "returned" : `not returned: ${oneLine(record.error, 80)}`}${record.used ? `  ${spentIn([asUsage(record.used)])}` : ""}`);
        break;
      case "exit": {
        const how = record.timedOut ? "timed out"
          : record.validated ? `stopped, validated (${record.validated})`
          : record.stopped ? "stopped"
          : record.signal ? `killed by ${record.signal}`
          : `exit code ${record.code}`;
        const verdict = record.error ? `unusable: ${oneLine(record.error, 60)}` : record.outcome ? record.outcome.status : "failed";
        console.log(`${at}  attempt ${record.attempt} over: ${how} → ${verdict}`);
        break;
      }
      case "unmerged":
        console.log(`${at}  attempt ${record.attempt}: ${record.files?.length ?? 0} change(s) it made did not reach the project`);
        for (const file of record.files ?? []) console.log(`${" ".repeat(at.length)}    ${file.path} — ${oneLine(file.why, 80)}`);
        break;
      case "full":
        console.log(`${at}  the journal is full: calls from here on were not recorded`);
        break;
      case "end":
        console.log(`${at}  end: ${howEnded}${total && `  (${total})`}`);
        break;
    }
  }
}

/**
 * Print what a run of the project in `projectDir` did: the latest run, or the
 * one named. With `list`, print which runs have a journal instead. `name` is
 * what the project is called where the user asked.
 */
export function printJournals(projectDir: string, name: string, options: { run?: string; list?: boolean }): void {
  const dir = journalDirOf(projectDir);
  const runs = runsIn(dir);
  if (runs.length === 0) {
    console.log("No runs have been recorded.");
    return;
  }

  if (options.list) {
    for (const run of runs) {
      const path = journalIn(dir, run);
      const records = readJournal(path);
      const calls = records.filter(record => record.kind === "call").length;
      const used = spentInAll(records);
      console.log(`${run}  ${String(records[0]?.purpose ?? "").padEnd(8)}  ${String(calls).padStart(4)} calls  ${ending(path, records)}${used && `  ${used}`}`);
    }
    return;
  }

  const run = options.run ?? runs[runs.length - 1];
  if (!runs.includes(run)) {
    throw new Error(`No journal for run "${run}". \`trama journal ${name} --list\` shows the runs that have one.`);
  }
  const path = journalIn(dir, run);
  printJournal(path, readJournal(path));
}
