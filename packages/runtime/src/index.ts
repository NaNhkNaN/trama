// @trama-dev/runtime runner surface — exported via "@trama-dev/runtime/runner"

import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync, rmSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { piVersion } from "./pi-adapter.js";
import { stripCodeFences } from "./agent.js";
import { onAbort, throwIfAborted } from "./abort.js";
import type { AgentUsage } from "./agent-backend.js";
import { createMeter } from "./budget.js";
import { LATEST_LOG_PATH } from "./context.js";
import { readProjectMeta } from "./meta.js";
import {
  loadConfig, loadProjectConfig, loadState, createBackend, validateProgram, installValidatedProgram,
  withTempDir, prepareProject, shownPaths, type Prepared, ensureProjectScaffold, RUNTIME_TYPES, runProgram as runHere, whyNotReplaceable,
} from "./runner.js";
import { createWorkspace as workspaceHere, ensureWorkspaceDir } from "./workspace.js";
import { parentBridge, remoteWorkspace, withOptions } from "./bridge-client.js";
import { guardPath, identityOf, sameProjectAs } from "./path-guard.js";
import { printJournals, spentIn } from "./journal-view.js";
import { messageOf } from "./errors.js";

export type { Budget, ProgramResult, RunOptions } from "./runner-types.js";
import type { ProgramResult, RunOptions, TramaConfig } from "./runner-types.js";
export type { Workspace, ObserveResult } from "./types.js";
import type { Workspace } from "./types.js";

// --- Running a project, and reaching a workspace ---
//
// A program never runs another program: it asks its runner to. So these two do
// their work in this process only when this process is not itself a program.
// Inside one they are calls on the bridge, carried out by the one runner that
// owns every run in the tree — which is how it can time them, stop them, and
// see them.

/** Run a project to an outcome: done, yielded, or failed. */
export async function runProgram(options: RunOptions): Promise<ProgramResult> {
  const bridge = parentBridge();
  if (!bridge) return runHere(options);

  // A signal cannot cross the bridge, but what it says can: the runner is told
  // to stop the run, and this call still waits for the run to be over — the
  // same as outside a program.
  const { signal, ...request } = options;
  const id = randomUUID();
  const offStop = onAbort(signal, () => {
    bridge.call("/run/stop", { id }).catch(() => { /* no runner left to tell */ });
  });
  try {
    return await bridge.call("/run/program", withOptions({ id }, {
      ...request,
      // The runner does not share this program's working directory.
      projectDir: resolve(request.projectDir),
      workspaceDir: request.workspaceDir && resolve(request.workspaceDir),
    }));
  } finally {
    offStop();
  }
}

/** The shared workspace in a directory, created if it does not exist: read, write, list, observe. */
export function createWorkspace(dir: string): Workspace {
  const bridge = parentBridge();
  if (!bridge) return workspaceHere(dir);
  const absolute = ensureWorkspaceDir(dir); // it exists from here on, as it does outside a program
  return remoteWorkspace(bridge.call, absolute);
}

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
await ctx.done({ finalMetric: Number.isFinite(bestMetric) ? bestMetric : null });

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

function getSystemPrompt(kept: boolean): string {
  return (
    `You are generating a TypeScript program for the trama runtime.\n\n` +
    `If the program is long-running (for example an HTTP server), call ctx.ready(...) after startup completes and handle SIGTERM/SIGINT for clean shutdown.\n\n` +
    `The workspace object is available when running in a session (shared artifact I/O between agents). ` +
    `ctx.yield(reason) suspends the program cooperatively — persists state and exits. ` +
    `ctx.resumed is true if this run follows a yield; ctx.yieldReason has the reason.\n\n` +
    `You are working in a copy of the project's directory, which is where the program will run: ` +
    `where the task speaks of the project's files, look at them. ` +
    (kept
      ? `What the program needs beside it — a package installed, a module it imports, a file it reads — ` +
        `you can make here: it is kept, with the program, if the program then passes its validation. ` +
        `The program itself is what you answer with, whatever you wrote to program.ts here.\n\n`
      : `Nothing you write here is kept — only the program you answer with.\n\n`) +
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

/**
 * Ask for a program for a project — in a copy of the project (see Prepared),
 * so that the agent can look at what the program is to work with and make
 * what it needs, and its tools do not write into the real one — and take
 * what comes back for a program only if something does: no program is not a
 * program that does nothing.
 */
async function generateProgram(
  backend: ReturnType<typeof createBackend>, prepared: Prepared, prompt: string, system: string, wrote: AgentUsage[], signal?: AbortSignal,
): Promise<string> {
  let reply: string;
  try {
    reply = await backend.ask(prompt, { cwd: prepared.copy, system, signal, used: (usage) => { wrote.push(usage); } });
  } finally {
    // What it took is said whatever came of it: it is on record only with a validation, and there may be none.
    // (A call that was cut off — stopped, or by the budget — says what it took once its backend has let go of it.)
    await backend.letGo();
    if (wrote.length > 0) console.log(`[trama] writing the program used ${spentIn(wrote)}`);
  }
  const program = stripCodeFences(reply);
  throwIfAborted(signal);
  if (program === "") throw new Error("The model answered with no program.");
  return program;
}

/**
 * The backend a create or an update asks: writing the program and validating
 * it are held, together, to the config's budget — and it is said when that is spent.
 */
const backendFor = (config: TramaConfig) =>
  createBackend(config, createMeter(config.budget), (why) => console.warn(`[trama] ${why}`));

/** Carry what the agent made beside a program into the project the program is now in, and say what that was. */
function keepPrepared(prepared: Prepared): void {
  let kept: ReturnType<Prepared["keep"]>;
  try {
    kept = prepared.keep();
  } catch (err) {
    // The program is in the project. That what was made beside it cannot be carried over is said, and does not undo that.
    console.warn(`[trama] what was made beside the program, while it was written, could not be carried into the project: ${messageOf(err)}`);
    return;
  }
  const { changed, unmerged } = kept;
  if (changed.length > 0) {
    console.log(`[trama] ${changed.length} path(s) made or changed beside the program, while it was written: ${shownPaths(changed)}`);
  }
  if (unmerged.length > 0) {
    console.warn(`[trama] ${unmerged.length} thing(s) done while the program was written did not reach the project:`);
    for (const { path, why } of unmerged) console.warn(`[trama]   ${path} — ${why}`);
  }
}

/**
 * Validate a candidate for a project: in the project as the agent prepared
 * it, where what the agent made is to be kept — or in the project as it is.
 * `kept` says which: what was validated is what is then to be in the
 * project. The agent's copy is no place to validate in where it is no longer
 * the copy the agent was given (a link put in its place is not followed), or
 * cannot be copied; the candidate is then validated by itself, which is said
 * (see validateProgram).
 */
async function validateCandidate(
  projectDir: string, backend: ReturnType<typeof createBackend>, candidate: string, config: TramaConfig, prepared: Prepared,
  wrote: AgentUsage[], signal?: AbortSignal,
): Promise<{ validated: Awaited<ReturnType<typeof validateProgram>>; kept: boolean }> {
  let as: string | undefined, alone: string | undefined;
  if (config.agentChanges === "keep") {
    try {
      prepared.ready();
      as = prepared.copy;
    } catch (err) {
      alone = messageOf(err);
    }
  }
  const validated = await validateProgram(projectDir, backend, candidate, {
    timeout: config.defaultTimeout,
    maxRepairAttempts: config.maxRepairAttempts,
    maxIterations: config.defaultMaxIterations,
    journalRuns: config.journalRuns,
    signal,
    as,
    alone,
    budget: config.budget,
    wrote,
  });
  return { validated, kept: as !== undefined && validated.alone === undefined };
}

// --- Public API ---

export async function createProject(
  name: string,
  prompt: string,
  options?: { model?: string; args?: Record<string, unknown>; signal?: AbortSignal },
): Promise<void> {
  validateProjectName(name);
  throwIfAborted(options?.signal);
  const projectDir = join(projectsDir(), name);
  let keepProjectOnFailure = false;

  mkdirSync(projectsDir(), { recursive: true });
  try {
    // Made here, and only here: whatever bears the name already — a project, a file, a link to nothing — is in the way.
    mkdirSync(projectDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Project "${name}" already exists.`);
    throw err;
  }
  // The directory made just now is the project: what is done from here on is done to it, and it alone is taken away again.
  const made = identityOf(projectDir);
  const stillTheProject = sameProjectAs(projectDir);

  try {
    ensureProjectScaffold(projectDir);

    const config = loadConfig();
    if (options?.model) config.model = options.model;

    const meta = {
      input: { prompt, args: options?.args ?? {} },
      createdAt: new Date().toISOString(),
      piVersion: await piVersion(),
      model: config.model,
      provider: config.provider,
    };
    writeFileSync(join(projectDir, "meta.json"), JSON.stringify(meta, null, 2));

    const backend = backendFor(config);
    const wrote: AgentUsage[] = [];

    console.log(`Generating program for "${name}"...`);
    // (What the agent is given to look at is the project made here, and no other directory that is at its path by now.)
    stillTheProject();
    await withTempDir("trama-gen-", async (privateDir) => {
      const prepared = prepareProject(projectDir, privateDir);
      const candidate = await generateProgram(backend, prepared,
        `${prompt}\n\nOutput ONLY the TypeScript program. No markdown fences. No explanation.`,
        getSystemPrompt(config.agentChanges === "keep"),
        wrote,
        options?.signal,
      );
      stillTheProject();

      // From here on the project is kept even if validation fails, so the
      // generated program can be inspected and fixed by hand.
      writeFileSync(guardPath(projectDir, "program.ts"), candidate);
      keepProjectOnFailure = true;

      console.log("Validating program...");
      const { validated, kept } = await validateCandidate(projectDir, backend, candidate, config, prepared, wrote, options?.signal);
      stillTheProject();
      installValidatedProgram(projectDir, validated, "create", prompt);
      if (kept) keepPrepared(prepared);
    });

    console.log(`Created ${name}. Run with: trama run ${name}`);
  } catch (err) {
    if (!keepProjectOnFailure && identityOf(projectDir) === made) {
      rmSync(projectDir, { recursive: true, force: true });
    }
    throw err;
  }
}

export async function updateProject(
  name: string,
  prompt: string,
  options?: { signal?: AbortSignal },
): Promise<void> {
  const projectDir = resolveProject(name);
  const unchanged = (why: unknown) =>
    new Error(`Update failed — the program is unchanged.\n${messageOf(why)}`);
  const stillTheProject = sameProjectAs(projectDir);
  // Asked before anything else is done, the project's own preparation included: an update's only
  // use is to replace the program, and where that cannot be done there is nothing to prepare for.
  const refusal = whyNotReplaceable(projectDir);
  if (refusal) throw unchanged(refusal);

  // The new program is generated and validated off to the side. The project is
  // only written to once there is a program that works, so a failed update has
  // nothing to undo.
  try {
    throwIfAborted(options?.signal);
    // A hand-written project may never have been run: give it history/ and the rest first.
    ensureProjectScaffold(projectDir);

    const originalSource = readFileSync(guardPath(projectDir, "program.ts"), "utf-8");
    const state = loadState(projectDir);
    const meta = readProjectMeta(projectDir);
    const config = loadProjectConfig(projectDir, meta);
    const backend = backendFor(config);
    const wrote: AgentUsage[] = [];

    const systemPrompt =
      getSystemPrompt(config.agentChanges === "keep") +
      `\n\nOriginal prompt: ${meta.input.prompt}` +
      `\n\nCurrent program.ts:\n${originalSource}` +
      (Object.keys(state).length > 0 ? `\n\nCurrent state:\n${JSON.stringify(state, null, 2)}` : "");

    console.log(`Updating "${name}"...`);
    await withTempDir("trama-gen-", async (privateDir) => {
      const prepared = prepareProject(projectDir, privateDir);
      const candidate = await generateProgram(backend, prepared,
        `${prompt}\n\nOutput the complete updated program.ts. No partial patches. No markdown fences. No explanation.`,
        systemPrompt,
        wrote,
        options?.signal,
      );
      stillTheProject();

      console.log("Validating updated program...");
      const { validated, kept } = await validateCandidate(projectDir, backend, candidate, config, prepared, wrote, options?.signal);
      stillTheProject();
      installValidatedProgram(projectDir, validated, "update", prompt);
      if (kept) keepPrepared(prepared);
    });
  } catch (err) {
    throw unchanged(err);
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
      const meta = readProjectMeta(projectDir);
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
  const logsPath = guardPath(projectDir, LATEST_LOG_PATH);

  let raw: string;
  try {
    raw = readFileSync(logsPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.log("No logs found.");
      return;
    }
    throw err;
  }

  const content = raw.trim();
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

/**
 * Show what a run of a project did, from its journal: the latest run, or the
 * one named. With `list`, show which runs have a journal instead.
 */
export async function showJournal(name: string, options: { run?: string; list?: boolean } = {}): Promise<void> {
  printJournals(resolveProject(name), name, options);
}
