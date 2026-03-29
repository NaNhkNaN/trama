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

const cli = new Command()
  .name("trama")
  .description("A minimal runtime for agent-authored programs")
  .version("0.1.0");

cli
  .command("create <name> <prompt>")
  .description("Generate a new program from a natural language prompt")
  .option("--model <model>", "LLM model to use")
  .action(async (name: string, prompt: string, opts: { model?: string }) => {
    try {
      await createProject(name, prompt, opts.model ? { model: opts.model } : undefined);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

cli
  .command("run <name>")
  .description("Execute a program")
  .option("--timeout <ms>", "Execution timeout in ms", "300000")
  .action(async (name: string, opts: { timeout: string }) => {
    try {
      const timeout = Number(opts.timeout);
      if (!Number.isInteger(timeout) || timeout <= 0) {
        console.error(`Error: --timeout must be a positive integer (got "${opts.timeout}")`);
        process.exit(1);
      }
      const projectDir = resolveProject(name);
      await runProgram({ projectDir, timeout });
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
