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
  resolveProject,
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

function collectArg(value: string, previous: string[]) {
  return [...previous, value];
}

/** Turn repeated `--arg key=value` options into an args object (undefined if none were given). */
function parseArgs(args: string[]): Record<string, unknown> | undefined {
  if (args.length === 0) return undefined;
  const result: Record<string, unknown> = {};
  for (const arg of args) {
    const eq = arg.indexOf("=");
    if (eq === -1) {
      throw new Error(`Invalid --arg format: "${arg}". Expected key=value.`);
    }
    result[arg.slice(0, eq)] = arg.slice(eq + 1);
  }
  return result;
}

/** Wrap a command so any failure is reported as a one-line error with a non-zero exit. */
function command<A extends unknown[]>(run: (...args: A) => Promise<void>) {
  return async (...args: A) => {
    try {
      await run(...args);
    } catch (err) {
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
    await createProject(name, prompt, { model: opts.model, args: parseArgs(opts.arg) });
  }));

cli
  .command("run <name>")
  .description("Execute a program")
  .option("--timeout <ms>", "Per-phase timeout in ms (applies to each run and repair attempt separately)")
  .option("--arg <key=value>", "Pass argument to the program (repeatable)", collectArg, [])
  .action(command(async (name: string, opts: { timeout?: string; arg: string[] }) => {
    let timeout: number | undefined;
    if (opts.timeout !== undefined) {
      timeout = Number(opts.timeout);
      if (!Number.isFinite(timeout) || timeout <= 0) {
        throw new Error(`--timeout must be a positive number (got "${opts.timeout}")`);
      }
    }
    const args = parseArgs(opts.arg);
    const projectDir = resolveProject(name);
    running = true;
    const result = await runProgram({ projectDir, timeout, args, signal: stopRun.signal })
      .finally(() => { running = false; });
    if (received) return leaveBySignal(received);
    if (result.status === "failed") {
      throw new Error(`Program failed: ${result.reason}`);
    }
  }));

cli
  .command("update <name> <prompt>")
  .description("Update an existing program with new requirements")
  .action(command(updateProject));

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

cli.parse();
