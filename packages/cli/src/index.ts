#!/usr/bin/env node

import { Command } from "commander";
import {
  createProject,
  runProgram,
  updateProject,
  listProjects,
  showLogs,
  resolveProject,
} from "@trama-dev/runtime/runner";

function collectArg(value: string, previous: string[]) {
  return [...previous, value];
}

function parseArgs(args: string[]): Record<string, unknown> {
  if (args.length === 0) return {};
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

const cli = new Command()
  .name("trama")
  .description("A minimal runtime for agent-authored programs")
  .version("0.1.1");

cli
  .command("create <name> <prompt>")
  .description("Generate a new program from a natural language prompt")
  .option("--model <model>", "LLM model to use")
  .option("--arg <key=value>", "Pass argument to the program (repeatable)", collectArg, [])
  .action(async (name: string, prompt: string, opts: { model?: string; arg: string[] }) => {
    try {
      const args = parseArgs(opts.arg);
      await createProject(name, prompt, {
        model: opts.model,
        args: Object.keys(args).length > 0 ? args : undefined,
      });
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

cli
  .command("run <name>")
  .description("Execute a program")
  .option("--timeout <ms>", "Per-phase timeout in ms (applies to each run and repair attempt separately)")
  .option("--arg <key=value>", "Pass argument to the program (repeatable)", collectArg, [])
  .action(async (name: string, opts: { timeout?: string; arg: string[] }) => {
    try {
      let timeout: number | undefined;
      if (opts.timeout !== undefined) {
        timeout = Number(opts.timeout);
        if (!Number.isInteger(timeout) || timeout <= 0) {
          console.error(`Error: --timeout must be a positive integer (got "${opts.timeout}")`);
          process.exit(1);
        }
      }
      const args = parseArgs(opts.arg);
      const projectDir = resolveProject(name);
      await runProgram({
        projectDir,
        timeout,
        args: Object.keys(args).length > 0 ? args : undefined,
      });
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

cli
  .command("update <name> <prompt>")
  .description("Update an existing program with new requirements")
  .action(async (name: string, prompt: string) => {
    try {
      await updateProject(name, prompt);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

cli
  .command("list")
  .description("List all projects")
  .action(async () => {
    try {
      await listProjects();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

cli
  .command("logs <name>")
  .description("Show logs from last run")
  .action(async (name: string) => {
    try {
      await showLogs(name);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

cli.parse();
