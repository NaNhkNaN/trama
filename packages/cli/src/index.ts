#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { Command } from "commander";
import {
  createProject,
  runProgram,
  updateProject,
  listProjects,
  showLogs,
  resolveProject,
} from "@trama-dev/runtime/runner";

// The trama command is always a runner of its own, even when a program starts
// it: what it runs it runs here, and shows here. (Code that is part of a
// program asks that program's runner instead — see runProgram.) So it does not
// go by a bridge it may have inherited, and neither does anything it starts.
delete process.env.TRAMA_PORT;
delete process.env.TRAMA_INIT;

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
    const result = await runProgram({ projectDir: resolveProject(name), timeout, args });
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

cli.parse();
