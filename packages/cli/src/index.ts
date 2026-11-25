#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { Command } from "commander";
import {
  createProject,
  runProgram,
  updateProject,
  listProjects,
  showLogs,
  showJournal,
  showReplay,
  showHistory,
  rollbackProject,
  resolveProject,
  failureOf,
} from "@trama-dev/runtime/runner";

// The trama command is always a runner of its own, even when a program starts
// it: what it runs it runs here, and shows here. (Code that is part of a
// program asks that program's runner instead — see runProgram.) So it does not
// go by a bridge it may have inherited, and neither does anything it starts.
delete process.env.TRAMA_PORT;
delete process.env.TRAMA_INIT;

// What a signal means is for this command to say: the runtime listens for none
// (its watchdog cleans up after a process that simply dies). While a program
// is being run, a signal stops the run the way a run should be stopped — its
// program asked first, and waited for — and then this process goes the way the
// signal would have had it go. A second signal does not wait. Without this the
// command could not be stopped politely at all where it is process 1, as in a
// container: there the kernel only delivers signals a process handles.
const SIGNALS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 } as const;
type SignalName = keyof typeof SIGNALS;
const stopRun = new AbortController();
let running = false;
let received: SignalName | null = null;

for (const name of Object.keys(SIGNALS) as SignalName[]) {
  process.on(name, () => {
    if (!running || received) process.exit(128 + SIGNALS[name]);
    received = name;
    stopRun.abort();
  });
}

/** End as the signal that stopped the run would have ended this process. */
function leaveBySignal(name: SignalName): void {
  process.removeAllListeners(name);
  process.kill(process.pid, name);
  // Still here a moment later: nothing kills this process that way (process 1).
  setTimeout(() => process.exit(128 + SIGNALS[name]), 100);
}

/** While `work` goes on, a signal stops it rather than this process. */
function stoppable<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  running = true;
  return work(stopRun.signal).finally(() => { running = false; });
}

function collectArg(value: string, previous: string[]) {
  return [...previous, value];
}

/** Turn repeated `--arg key=value` options into an args object (undefined if none were given). */
function parseArgs(args: string[]): Record<string, unknown> | undefined {
  if (args.length === 0) return undefined;
  const given: Array<[string, string]> = [];
  for (const arg of args) {
    const eq = arg.indexOf("=");
    // (A name, then what it is given: what begins with the "=" names nothing.)
    if (eq < 1) {
      throw new Error(`Invalid --arg format: "${arg}". Expected key=value.`);
    }
    const name = arg.slice(0, eq);
    if (given.some(([had]) => had === name)) throw new Error(`--arg ${name} is given twice.`);
    given.push([name, arg.slice(eq + 1)]);
  }
  // (Made of its pairs, as a budget is below: a name every object has from birth is then a name like any other.)
  return Object.fromEntries(given);
}

/** Turn repeated `--budget cap=number` options into a budget (undefined if none were given). What a cap may be is the runner's to say. */
function parseBudget(caps: string[]): Record<string, number> | undefined {
  if (caps.length === 0) return undefined;
  const given: Array<[string, number]> = [];
  for (const cap of caps) {
    const eq = cap.indexOf("=");
    const amount = eq === -1 || cap.slice(eq + 1).trim() === "" ? NaN : Number(cap.slice(eq + 1));
    if (Number.isNaN(amount)) {
      throw new Error(`Invalid --budget format: "${cap}". Expected cap=number, as in cost=2.50, tokens=500000 or calls=40.`);
    }
    const name = cap.slice(0, eq);
    if (given.some(([had]) => had === name)) throw new Error(`--budget ${name} is given twice.`);
    given.push([name, amount]);
  }
  // (Made of its pairs: a cap by a name every object has from birth is then a cap like any other, to be refused as one.)
  return Object.fromEntries(given);
}

/** Wrap a command so any failure is reported as a one-line error with a non-zero exit. */
function command<A extends unknown[]>(run: (...args: A) => Promise<void>) {
  return async (...args: A) => {
    try {
      await run(...args);
      if (received) return leaveBySignal(received);
    } catch (err) {
      if (received) return leaveBySignal(received);
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  };
}

// Read the version from package.json (shipped next to dist/) so it can't drift from the published version.
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
) as { version: string };

const cli = new Command()
  .name("trama")
  .description("A minimal runtime for agent-authored programs")
  .version(version);

cli
  .command("create <name> <prompt>")
  .description("Generate a new program from a natural language prompt")
  .option("--model <model>", "LLM model to use")
  .option("--arg <key=value>", "Pass argument to the program (repeatable)", collectArg, [])
  .action(command(async (name: string, prompt: string, opts: { model?: string; arg: string[] }) => {
    const args = parseArgs(opts.arg);
    await stoppable((signal) => createProject(name, prompt, { model: opts.model, args, signal }));
  }));

cli
  .command("run <name>")
  .description("Execute a program")
  .option("--timeout <ms>", "Per-phase timeout in ms (applies to each run and repair attempt separately)")
  .option("--arg <key=value>", "Pass argument to the program (repeatable)", collectArg, [])
  .option("--budget <cap=number>", "Cap what the run may use of a model: cost (US dollars), tokens or calls (repeatable)", collectArg, [])
  .option("--check <project>", "Have the run checked, once it is done, by a project: its name, or a path")
  .option("--at-version <number>", "Run a version of the program from the project's history, and not the program as it is (see: trama history)")
  .action(command(async (name: string, opts: { timeout?: string; arg: string[]; budget: string[]; check?: string; atVersion?: string }) => {
    let timeout: number | undefined;
    if (opts.timeout !== undefined) {
      timeout = Number(opts.timeout);
      if (!Number.isFinite(timeout) || timeout <= 0) {
        throw new Error(`--timeout must be a positive number (got "${opts.timeout}")`);
      }
    }
    const args = parseArgs(opts.arg);
    const budget = parseBudget(opts.budget);
    const projectDir = resolveProject(name);
    let version: number | undefined;
    if (opts.atVersion !== undefined) {
      version = Number(opts.atVersion);
      if (!Number.isSafeInteger(version) || version < 1) throw new Error(`--at-version takes a version's number: 1 and up (got "${opts.atVersion}")`);
    }
    const result = await stoppable((signal) => runProgram({ projectDir, timeout, args, budget, checkWith: opts.check, ...(version !== undefined && { version }), signal }));
    // (A run that a signal stopped has failed, and is not reported as that: see `command`.)
    if (result.status === "failed") {
      throw new Error(failureOf(result.reason));
    }
    // A run that was checked ends well where its work was found good. (What the check said, or why there is none, has been shown.)
    if (result.check && result.check.ok !== true) {
      throw new Error(result.check.error !== undefined ? "The run is done, and its check could not be made." : "The run is done, and its check says the work is not good.");
    }
  }));

cli
  .command("update <name> <prompt>")
  .description("Update an existing program with new requirements")
  .action(command(async (name: string, prompt: string) => {
    await stoppable((signal) => updateProject(name, prompt, { signal }));
  }));

cli
  .command("list")
  .description("List all projects")
  .action(command(listProjects));

cli
  .command("logs <name>")
  .description("Show logs from last run")
  .action(command(showLogs));

cli
  .command("journal <name> [run]")
  .description("Show what a run did, call by call (the latest run, or the one named)")
  .option("--list", "List the runs that have a journal")
  .action(command(async (name: string, run: string | undefined, opts: { list?: boolean }) => {
    await showJournal(name, { run, list: opts.list });
  }));

cli
  .command("replay <name> [run]")
  .description("Run a program again with its calls answered from the record of a run (the latest, or the one named): nothing is carried out")
  .option("--all", "Replay every run on record, each by itself")
  .option("--loose", "Answer a call wherever its kind is the recorded one, whatever it asks")
  .action(command(async (name: string, run: string | undefined, opts: { all?: boolean; loose?: boolean }) => {
    const same = await stoppable((signal) => showReplay(name, { run, all: opts.all, loose: opts.loose, signal }));
    // (It ends as it went: the whole way to the recorded end, or not.)
    if (!same) process.exitCode = 1;
  }));

cli
  .command("history <name>")
  .description("Show the versions a program has had, and how the runs of each went")
  .option("--runs", "List each run under its version")
  .action(command(async (name: string, opts: { runs?: boolean }) => {
    await showHistory(name, { runs: opts.runs });
  }));

cli
  .command("rollback <name> <version>")
  .description("Go back to a version of a program: it becomes the program again, as a new version. Nothing is run")
  .action(command(async (name: string, version: string) => {
    // (A version is named by its number, as `trama history` shows it — with or without the v.)
    await rollbackProject(name, Number(/^v?(\d+)$/.exec(version)?.[1] ?? NaN));
  }));

cli.parse();
