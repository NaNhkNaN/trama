#!/usr/bin/env node

import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  readHistory,
  programGuide,
  addVersion,
  describeProject,
  describeProjects,
  failureOf,
  projectsDir,
  validateProjectName,
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

/** What a project is to take and give, as a file says it (`--contract`): an object of the three things a project says of itself, and no other. */
function contractIn(file: string): { description?: string; parameters?: Record<string, unknown>; returns?: unknown } {
  const NAMES = ["description", "parameters", "returns"];
  const named = NAMES.map((name) => `"${name}"`).join(", ");
  const text = readFileSync(file, "utf-8");
  const none = (why: string): Error => new Error(`--contract takes a file of JSON — an object of ${named} — and ${file} is none: ${why}`);
  let said: unknown;
  try { said = JSON.parse(text); } catch (err) { throw none(err instanceof Error ? err.message : String(err)); }
  if (said === null || typeof said !== "object" || Array.isArray(said)) throw none(`it is ${said === null ? "null" : Array.isArray(said) ? "a list" : `a ${typeof said}`}`);
  // (A name written wrongly is not passed over: what was meant by it would then be said by nobody, or by the writer.)
  const other = Object.keys(said).find((name) => !NAMES.includes(name));
  if (other !== undefined) throw new Error(`--contract: ${JSON.stringify(other)} is none of ${named}.`);
  return said as { description?: string; parameters?: Record<string, unknown>; returns?: unknown };
}

const isDirectory = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

/**
 * Where the programs that come with the command line are (`trama examples`):
 * beside dist, where it is installed — they are packed with it — and at the
 * repository's root where it is run from there. In that order: what is three
 * directories above an installed command line is somebody else's.
 */
function examplesDir(): string {
  for (const from of ["../examples", "../../../examples"]) {
    const dir = fileURLToPath(new URL(from, import.meta.url));
    if (isDirectory(dir)) return dir;
  }
  throw new Error("The examples are not where this command line is: they come with it, beside its dist.");
}

/** The examples there are, by name: each a directory that says of itself what a project does (meta.json). */
function examplesIn(dir: string): Array<{ name: string; description?: string }> {
  return readdirSync(dir).sort().flatMap((name) => {
    try {
      const { description } = JSON.parse(readFileSync(join(dir, name, "meta.json"), "utf-8")) as { description?: unknown };
      return [{ name, ...(typeof description === "string" && { description }) }];
    } catch {
      return [];
    }
  });
}

/** A version, as an option names it: its number (as `trama history` shows it) — or none, where the option was not given. */
function versionOf(option: string, given: string | undefined): number | undefined {
  if (given === undefined) return undefined;
  const version = Number(/^v?(\d+)$/.exec(given)?.[1] ?? NaN);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error(`${option} takes a version's number: 1 and up (got "${given}")`);
  return version;
}

/**
 * Have standard output be a document's alone (`--json`): from here on, what
 * would be written there — what a program logs and prints, what its runner
 * says as the run goes — is written to standard error. What is returned
 * writes the document, as JSON, and is over when it has been handed on: a
 * command that then fails does not cut it short.
 */
function theResultAlone(): (document: unknown) => Promise<void> {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((...given: Parameters<typeof process.stderr.write>) => process.stderr.write(...given)) as typeof process.stdout.write;
  return (document) => new Promise((resolve) => { write(`${JSON.stringify(document, null, 2)}\n`, () => resolve()); });
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
  .description("Make a project: have its program written from a prompt — or hand over one you wrote yourself (--program), with the prompt for what it is for")
  .option("--model <model>", "LLM model to use")
  .option("--arg <key=value>", "An argument of the project's own (repeatable): what a run of it has where the run gives none — and what the new program is validated with, so a parameter the project requires is to be given here", collectArg, [])
  .option("--with <project>", "The project that writes the program — its name, or a path — where it is not to be program-writer, the one that comes with trama")
  .option("--contract <file>", "What the project is to take and give: a file of JSON — {\"description\": \"…\", \"parameters\": {\"text\": \"string: what it is\", \"n?\": \"number\"}, \"returns\": {\"words\": \"number\"}} — written as `trama api` says (what is not said there, whoever writes the program says)")
  .option("--program <file>", "Make the project of a program you wrote yourself, and ask nobody to write one: it is validated as it is, and is the project's first version — or, where it does not run, no project is made (- for standard input; what a program is: trama api)")
  .action(command(async (name: string, prompt: string, opts: { model?: string; arg: string[]; with?: string; contract?: string; program?: string }) => {
    const args = parseArgs(opts.arg);
    const says = opts.contract === undefined ? {} : contractIn(opts.contract);
    const program = opts.program === undefined ? undefined : readFileSync(opts.program === "-" ? 0 : opts.program, "utf-8");
    await stoppable((signal) => createProject(name, prompt, { model: opts.model, args, ...(opts.with !== undefined && { createWith: opts.with }), ...(program !== undefined && { program }), ...says, signal }));
  }));

cli
  .command("run <name>")
  .description("Execute a program")
  .option("--timeout <ms>", "Per-phase timeout in ms (applies to each run and repair attempt separately)")
  .option("--arg <key=value>", "Pass argument to the program (repeatable)", collectArg, [])
  .option("--budget <cap=number>", "Cap what the run may use of a model: cost (US dollars), tokens or calls (repeatable)", collectArg, [])
  .option("--check <project>", "Have the run checked, once it is done, by a project: its name, or a path")
  .option("--at-version <number>", "Run a version of the program from the project's history, and not the program as it is (see: trama history)")
  .option("--workspace <dir>", "Where the run works, where that is not in its project: a directory the program has as its workspace (workspace.read, workspace.shell and the rest) — the codebase a harness is to work on, say. It is worked in as it is: nothing is copied")
  .option("--no-making", "Give the run no way to make projects, or change them — nor any run it starts: for a run whose program, or the model at work in it, is not to touch what else there is")
  .option("--json", "Say what the run came to as JSON on standard output — its status, its result, its check — and nothing else there: what is said as the run goes is on standard error")
  .action(command(async (name: string, opts: { timeout?: string; arg: string[]; budget: string[]; check?: string; atVersion?: string; workspace?: string; making: boolean; json?: boolean }) => {
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
    // (As it is given: from where the command is run. What is not there is not made — a run that was to work somewhere would then work in nothing.)
    const workspaceDir = opts.workspace === undefined ? undefined : resolve(opts.workspace);
    if (workspaceDir !== undefined && !isDirectory(workspaceDir)) throw new Error(`--workspace takes a directory, and there is none at ${workspaceDir}`);
    // (With --json, from here on: a run that is not begun — no such project, arguments that do not fit — has no document.)
    const say = opts.json ? theResultAlone() : undefined;
    const result = await stoppable((signal) => runProgram({ projectDir, timeout, args, budget, checkWith: opts.check, ...(version !== undefined && { version }), ...(workspaceDir !== undefined && { workspaceDir }), ...(opts.making === false && { making: false }), signal }));
    if (say) await say(result);
    // (Without --json: what the run gave, after what was said as it went — for whoever is looking on.)
    else if (result.status === "done" && result.result !== undefined) console.log(JSON.stringify(result.result, null, 2));
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
  .option("--from <number>", "Write it from that version of the program, and not from the program as it is (see: trama history)")
  .option("--beside", "Keep the new version beside the program, on record, and do not make it the program: run it with --at-version, go to it with rollback")
  .option("--with <project>", "The project that writes it — its name, or a path — where it is not to be program-writer, the one that comes with trama")
  .option("--contract <file>", "What the project is to take and give from this version on, where that is to change — as it is to for a run to give a field more, or one fewer: what a run gives beside what its project says is left out. A file of JSON as of create: each of \"description\", \"parameters\", \"returns\" that it says takes the place of the project's, whole, and what it does not say is as it is. The program is validated under it, and the two are the project's together; trama rollback goes back to both")
  .action(command(async (name: string, prompt: string, opts: { from?: string; beside?: boolean; with?: string; contract?: string }) => {
    const from = versionOf("--from", opts.from);
    const says = opts.contract === undefined ? {} : contractIn(opts.contract);
    await stoppable((signal) => updateProject(name, prompt, {
      ...(from !== undefined && { from }), ...(opts.beside && { install: false }), ...(opts.with !== undefined && { updateWith: opts.with }), ...says, signal,
    }));
  }));

cli
  .command("add-version <name> <file>")
  .description("Put a program you wrote yourself on record as a version of a project, beside its program: it is validated, and not installed — and its number is said (- for standard input; what a program is: trama api)")
  .option("--parent <number>", "The version it was written from: the program as it is, where none is named")
  .option("--detail <text>", "What it was made for, in words")
  .option("--contract <file>", "What this version is made to take and give, where that is not what the project says: a file of JSON as of create. It is validated and run under it; the project's own is not touched until the version is gone to (trama rollback)")
  .action(command(async (name: string, file: string, opts: { parent?: string; detail?: string; contract?: string }) => {
    const parent = versionOf("--parent", opts.parent);
    const says = opts.contract === undefined ? {} : contractIn(opts.contract);
    const source = readFileSync(file === "-" ? 0 : file, "utf-8");
    const { version } = await stoppable((signal) => addVersion(name, source, { ...(parent !== undefined && { parent }), ...(opts.detail !== undefined && { detail: opts.detail }), ...says, signal }));
    console.log(`Version ${version} of ${name} is on record, beside its program. Run with: trama run ${name} --at-version ${version}`);
  }));

cli
  .command("describe [name]")
  .description("Show what a project says of itself: what it is for, what a run of it takes and gives (every project, without a name)")
  .option("--json", "As JSON, with what it takes and gives as JSON Schema too")
  .action(command(async (name: string | undefined, opts: { json?: boolean }) => {
    const said = name === undefined ? await describeProjects() : await describeProject(name);
    if (opts.json) return console.log(JSON.stringify(said, null, 2));
    const shape = (declared: unknown) => (declared === undefined ? "(it does not say)" : JSON.stringify(declared, null, 2).replace(/\n/g, "\n  "));
    for (const each of Array.isArray(said) ? said : [said]) {
      console.log(`${each.name} — ${each.description ?? "(it does not say what it is for)"}\n  takes: ${shape(each.parameters)}\n  gives: ${shape(each.returns)}`);
    }
  }));

cli
  .command("api")
  .description("Show what a program is, for whoever writes one themselves: where a project is, how what it takes and gives is written, the runtime's API, and programs to go by")
  .action(command(async () => { console.log(programGuide()); }));

cli
  .command("examples [name]")
  .description("List the programs that come with trama — a harness, the loop, a judge, a fixer, a writer — or copy one among your projects, to read, run and change")
  .option("--as <project>", "The name the copy has among your projects, where that is not the example's own")
  .action(command(async (name: string | undefined, opts: { as?: string }) => {
    const from = examplesDir(), there = examplesIn(from);
    if (name === undefined) {
      return console.log(
        `Programs that come with trama — a harness, the loop, a judge, a fixer, a writer: each a project, to copy among your own, read, run and change.\n\n` +
        there.map((each) => `  ${each.name} — ${each.description ?? "(it does not say what it is for)"}\n`).join("") +
        `\nCopy one among your projects: trama examples <name> [--as <project>]`);
    }
    // (By its name among them, and by nothing else: a path is no name.)
    if (!there.some((each) => each.name === name)) throw new Error(`There is no example named ${JSON.stringify(name)}: there are ${there.map((each) => each.name).join(", ")}.`);
    const as = opts.as ?? name;
    validateProjectName(as);
    const to = join(projectsDir(), as);
    mkdirSync(projectsDir(), { recursive: true });
    // The name is taken by making its directory, which fails where anything is there: a copy is never laid over a project.
    try {
      mkdirSync(to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      throw new Error(`There is a project named ${JSON.stringify(as)} already: give the copy another name (--as <project>).`);
    }
    try {
      cpSync(join(from, name), to, { recursive: true });
    } catch (err) {
      rmSync(to, { recursive: true, force: true });
      throw err;
    }
    console.log(`${name} is among your projects${as === name ? "" : ` as ${as}`}: ${to}\nIt is yours, to read and change: its README.md says how it is used, and trama describe ${as} what it takes and gives.`);
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
  .option("--json", "As JSON: its versions, its runs, and which version is the program")
  .action(command(async (name: string, opts: { runs?: boolean; json?: boolean }) => {
    if (opts.json) return console.log(JSON.stringify(await readHistory(resolveProject(name)), null, 2));
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
