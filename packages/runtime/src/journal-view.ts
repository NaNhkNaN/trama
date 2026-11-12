// Showing a journal: what `trama journal` prints.
//
// This reads what journal.ts writes, and only to show it. A journal is read
// as far as it goes — a run may still be writing it, or have died doing so.

import { readFileSync } from "fs";
import { JOURNAL_VERSION, journalDirOf, journalIn, runsIn, stillBeingWritten } from "./journal.js";

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
      if (typeof record === "object" && record !== null) records.push(record);
    } catch { /* not a whole record */ }
  }
  return records;
}

const oneLine = (value: unknown, max: number): string => {
  const text = (typeof value === "string" ? value : JSON.stringify(value) ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
};

/** The one field of a request that says most about it. */
function gist(request: Record<string, unknown> | undefined): string {
  // A run that was asked for is best known by the name it was given.
  if (typeof request?.label === "string") return oneLine(`${request.label}  (${request.projectDir})`, 60);
  for (const field of ["prompt", "command", "path", "pattern", "url", "message", "projectDir", "reason"]) {
    if (request?.[field] !== undefined) return oneLine(request[field], 60);
  }
  return "";
}

/** How a run ended, in a word or two — or that it has not, or never will. */
function ending(path: string, records: JournalRecord[]): string {
  const end = records.find(record => record.kind === "end");
  if (!end) return stillBeingWritten(path) ? "still running" : "did not finish";
  return end.result ? end.result.status : `could not run: ${oneLine(end.error, 60)}`;
}

function printJournal(path: string, records: JournalRecord[]): void {
  const head = records[0];
  console.log(`${head?.run ?? "?"}  ${head?.purpose ?? ""}${head?.label ? ` [${head.label}]` : ""}  ${ending(path, records)}`);
  if (head && head.v !== JOURNAL_VERSION) {
    console.log(`(recorded in format ${head.v}; this trama reads format ${JOURNAL_VERSION}, and shows what it can make of it)`);
  }

  const results = new Map<number, JournalRecord>();
  for (const record of records) if (record.kind === "result") results.set(record.seq, record);

  for (const record of records) {
    const at = `${(record.at / 1000).toFixed(3).padStart(9)}s`;
    switch (record.kind) {
      case "attempt":
        console.log(`${at}  attempt ${record.attempt}  program ${record.program?.sha256?.slice(0, 8) ?? "missing"}`);
        break;
      case "call": {
        const result = results.get(record.seq);
        const how = !result ? "never answered"
          : result.ok ? `ok  ${result.ms}ms`
          : `failed  ${result.ms}ms  ${oneLine(result.error, 60)}`;
        console.log(`${at}  #${String(record.seq).padEnd(3)} ${record.endpoint.slice(1).padEnd(18)} ${gist(record.request).padEnd(60)}  ${how}`);
        break;
      }
      case "child":
        console.log(`${at}  #${String(record.seq).padEnd(3)} started run ${record.run}`);
        break;
      case "fix-request":
        console.log(`${at}  fix asked for: ${oneLine(record.error, 80)}`);
        break;
      case "fix":
        console.log(`${at}  fix ${record.ok ? "returned" : `not returned: ${oneLine(record.error, 80)}`}`);
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
      case "full":
        console.log(`${at}  the journal is full: calls from here on were not recorded`);
        break;
      case "end":
        console.log(`${at}  end: ${ending(path, records)}`);
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
      console.log(`${run}  ${String(records[0]?.purpose ?? "").padEnd(8)}  ${String(calls).padStart(4)} calls  ${ending(path, records)}`);
    }
    return;
  }

  const run = options.run ?? runs[runs.length - 1];
  if (!runs.includes(run)) {
    throw new Error(`No journal for run "${run}". \`trama journal ${name} --list\` shows the runs that have one.`);
  }
  printJournal(journalIn(dir, run), readJournal(journalIn(dir, run)));
}
