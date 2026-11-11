// @trama-dev/runtime runner surface — exported via "@trama-dev/runtime/runner"

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { PI_VERSION } from "./pi-adapter.js";
import { stripCodeFences } from "./agent.js";
import type { AgentBackend } from "./agent-backend.js";
import {
  loadConfig, loadProjectConfig, loadState, createBackend, validateProgram, installValidatedProgram,
  withTempDir, ensureProjectScaffold, RUNTIME_TYPES,
} from "./runner.js";
import { guardPath } from "./path-guard.js";

export { runProgram } from "./runner.js";
export { createWorkspace } from "./workspace.js";
export type { ProgramResult, RunOptions } from "./runner-types.js";
import type { TramaConfig } from "./runner-types.js";
export type { Workspace, ObserveResult } from "./types.js";

// --- Example programs (included in system prompt during create/update) ---

const EXAMPLE_PROGRAMS = `// Example A: Simple — one-shot action, no LLM needed.
import { ctx, tools } from "@trama-dev/runtime";

const content = "# Hello World\\nGenerated at " + new Date().toISOString();
await tools.write("hello.md", content);
await ctx.log("wrote hello.md");
await ctx.done();

// Example B: Medium — use the LLM once to process data, write the result.
import { ctx, agent, tools } from "@trama-dev/runtime";

const data = await tools.read(ctx.input.args.file as string);
const summary = await agent.instruct("Summarize this data concisely:\\n" + data);
await tools.write("summary.md", summary);
await ctx.done({ summaryLength: summary.length });

// Example C: Iterative optimization loop.
// Pattern: propose a change via LLM, evaluate it with a deterministic script,
// keep the change only if it improves the metric, repeat.
// ctx.state and ctx.iteration persist across runs so the loop can resume after interruption.
import { ctx, agent, tools } from "@trama-dev/runtime";

let code = (ctx.state.code as string | undefined) ?? await tools.read("target.ts");
let bestMetric = (ctx.state.bestMetric as number | undefined) ?? Infinity;

for (let i = ctx.iteration; i < ctx.maxIterations; i++) {
  const proposal = await agent.generate<{ reasoning: string; newCode: string }>({
    prompt: "Analyze this code and propose ONE specific improvement:\\n" + code,
    schema: { reasoning: "string: why this change helps", newCode: "string: complete improved code" },
  });

  await tools.write("candidate.ts", proposal.newCode);
  const bench = await tools.shell("node benchmark.mjs candidate.ts");

  if (bench.exitCode !== 0) {
    await ctx.log("benchmark failed", { stderr: bench.stderr });
    continue;
  }

  const metric = parseFloat(bench.stdout.trim());
  if (metric < bestMetric) {
    code = proposal.newCode;
    bestMetric = metric;
    await ctx.log("improved", { iteration: i, metric, reasoning: proposal.reasoning });
    ctx.state = { code, bestMetric };
    await ctx.checkpoint();
  }
}

await tools.write("target.ts", code);
await ctx.done({ finalMetric: bestMetric });

// Example D: Long-running server.
// Call ctx.ready() only after the server is actually listening.
// Handle SIGTERM/SIGINT so smoke validation can shut it down cleanly.
import { ctx } from "@trama-dev/runtime";
import { createServer } from "node:http";

const server = createServer((_req, res) => {
  res.end("ok");
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(3000, "127.0.0.1", () => resolve());
});

await ctx.ready({ url: "http://127.0.0.1:3000" });

process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});
process.on("SIGINT", () => {
  server.close();
  process.exit(0);
});

await new Promise<void>(() => {});`;

function getSystemPrompt(): string {
  return (
    `You are generating a TypeScript program for the trama runtime.\n\n` +
    `If the program is long-running (for example an HTTP server), call ctx.ready(...) after startup completes and handle SIGTERM/SIGINT for clean shutdown.\n\n` +
    `The workspace object is available when running in a session (shared artifact I/O between agents). ` +
    `ctx.yield(reason) suspends the program cooperatively — persists state and exits. ` +
    `ctx.resumed is true if this run follows a yield; ctx.yieldReason has the reason.\n\n` +
    `Runtime API:\n${RUNTIME_TYPES}\n\n` +
    `Examples:\n${EXAMPLE_PROGRAMS}`
  );
}

function projectsDir(): string {
  return join(homedir(), ".trama", "projects");
}

export function validateProjectName(name: string): void {
  if (!name || /[\/\\]/.test(name) || name === "." || name === "..") {
    throw new Error(`Invalid project name: "${name}". Must be a simple directory name without path separators.`);
  }
}

export function resolveProject(name: string): string {
  validateProjectName(name);
  const dir = join(projectsDir(), name);
  if (!existsSync(dir)) {
    throw new Error(`Project "${name}" not found. Run \`trama list\` to see available projects.`);
  }
  return dir;
}

// --- Helpers ---

/** Ask in an empty throwaway directory, so the agent's tools cannot write into the real project. */
async function isolatedAsk(backend: AgentBackend, prompt: string, system: string): Promise<string> {
  return withTempDir("trama-gen-", (cwd) => backend.ask(prompt, { cwd, system }));
}

const validationOptions = (config: TramaConfig) => ({
  timeout: config.defaultTimeout,
  maxRepairAttempts: config.maxRepairAttempts,
  maxIterations: config.defaultMaxIterations,
});

// --- Public API ---

export async function createProject(
  name: string,
  prompt: string,
  options?: { model?: string; args?: Record<string, unknown> },
): Promise<void> {
  validateProjectName(name);
  const projectDir = join(projectsDir(), name);
  let keepProjectOnFailure = false;

  if (existsSync(projectDir)) {
    throw new Error(`Project "${name}" already exists.`);
  }

  mkdirSync(projectDir, { recursive: true });

  try {
    ensureProjectScaffold(projectDir);

    const config = loadConfig();
    if (options?.model) config.model = options.model;

    const meta = {
      input: { prompt, args: options?.args ?? {} },
      createdAt: new Date().toISOString(),
      piVersion: PI_VERSION,
      model: config.model,
      provider: config.provider,
    };
    writeFileSync(join(projectDir, "meta.json"), JSON.stringify(meta, null, 2));

    const backend = createBackend(config);

    console.log(`Generating program for "${name}"...`);
    const candidate = stripCodeFences(await isolatedAsk(backend,
      `${prompt}\n\nOutput ONLY the TypeScript program. No markdown fences. No explanation.`,
      getSystemPrompt(),
    ));

    // From here on the project is kept even if validation fails, so the
    // generated program can be inspected and fixed by hand.
    writeFileSync(join(projectDir, "program.ts"), candidate);
    keepProjectOnFailure = true;

    console.log("Validating program...");
    const validated = await validateProgram(projectDir, backend, candidate, validationOptions(config));
    installValidatedProgram(projectDir, validated, "create", prompt);

    console.log(`Created ${name}. Run with: trama run ${name}`);
  } catch (err) {
    if (!keepProjectOnFailure) {
      rmSync(projectDir, { recursive: true, force: true });
    }
    throw err;
  }
}

export async function updateProject(name: string, prompt: string): Promise<void> {
  const projectDir = resolveProject(name);
  // A hand-written project may never have been run: give it history/ and the rest first.
  ensureProjectScaffold(projectDir);

  const programPath = guardPath(projectDir, "program.ts");
  const originalSource = readFileSync(programPath, "utf-8");
  const state = loadState(projectDir);
  const meta = JSON.parse(readFileSync(guardPath(projectDir, "meta.json"), "utf-8"));
  const config = loadProjectConfig(projectDir);
  const backend = createBackend(config);

  const systemPrompt =
    getSystemPrompt() +
    `\n\nOriginal prompt: ${meta.input.prompt}` +
    `\n\nCurrent program.ts:\n${originalSource}` +
    (Object.keys(state).length > 0 ? `\n\nCurrent state:\n${JSON.stringify(state, null, 2)}` : "");

  // The new program is generated and validated off to the side. The project is
  // only written to once there is a program that works, so a failed update has
  // nothing to undo.
  try {
    console.log(`Updating "${name}"...`);
    const candidate = stripCodeFences(await isolatedAsk(backend,
      `${prompt}\n\nOutput the complete updated program.ts. No partial patches. No markdown fences. No explanation.`,
      systemPrompt,
    ));

    console.log("Validating updated program...");
    const validated = await validateProgram(projectDir, backend, candidate, validationOptions(config));
    try {
      installValidatedProgram(projectDir, validated, "update", prompt);
    } catch (err) {
      writeFileSync(programPath, originalSource); // recording the version failed: don't leave an unrecorded program behind
      throw err;
    }
  } catch (err) {
    throw new Error(
      `Update failed — the project is unchanged.\n` +
      `${err instanceof Error ? err.message : err}`
    );
  }

  console.log(`Updated ${name}. Run with: trama run ${name}`);
}

export async function listProjects(): Promise<void> {
  const dir = projectsDir();
  if (!existsSync(dir)) {
    console.log("No projects found.");
    return;
  }

  const entries = readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory());

  if (entries.length === 0) {
    console.log("No projects found.");
    return;
  }

  for (const entry of entries) {
    const projectDir = join(dir, entry.name);
    let prompt = "";
    let modified = "";

    try {
      const meta = JSON.parse(readFileSync(guardPath(projectDir, "meta.json"), "utf-8"));
      prompt = meta.input?.prompt ?? "";
      if (prompt.length > 60) prompt = prompt.slice(0, 57) + "...";
    } catch { /* no meta or symlink escape */ }

    try {
      const stat = statSync(guardPath(projectDir, "program.ts"));
      modified = stat.mtime.toISOString().slice(0, 19).replace("T", " ");
    } catch { /* no program.ts or symlink escape */ }

    console.log(`  ${entry.name}  ${prompt}  ${modified}`);
  }
}

export async function showLogs(name: string): Promise<void> {
  const projectDir = resolveProject(name);
  const logsPath = guardPath(projectDir, join("logs", "latest.jsonl"));

  if (!existsSync(logsPath)) {
    console.log("No logs found.");
    return;
  }

  const content = readFileSync(logsPath, "utf-8").trim();
  if (!content) {
    console.log("No log entries.");
    return;
  }

  for (const line of content.split("\n")) {
    try {
      const entry = JSON.parse(line);
      const time = new Date(entry.ts).toISOString().slice(11, 19);
      const data = entry.data ? `  ${JSON.stringify(entry.data)}` : "";
      console.log(`[${time}] ${entry.message}${data}`);
    } catch {
      console.log(line);
    }
  }
}
