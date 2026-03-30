// @trama-dev/runtime runner surface — exported via "@trama-dev/runtime/runner"

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, copyFileSync, appendFileSync, statSync, rmSync, cpSync, mkdtempSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { PiAdapter, stripCodeFences } from "./pi-adapter.js";
import { loadConfig, loadState, smokeRunAndRepair, copyToHistory, withTempDir, RUNTIME_TYPES, PI_VERSION } from "./runner.js";

export { runProgram } from "./runner.js";

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
const summary = await agent.ask("Summarize this data concisely:\\n" + data);
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

/** Run an LLM ask() in an isolated temp cwd so pi-coding-agent tools can't write into the real project. */
async function isolatedAsk(adapter: PiAdapter, prompt: string, options?: { system?: string }): Promise<string> {
  return withTempDir("trama-gen-", (dir) => adapter.withCwd(dir).ask(prompt, options));
}

/** Backup projectDir, run fn, restore on failure. Preserves new repair history entries across restore. */
async function withProjectBackup(
  projectDir: string,
  originalHistory: string,
  historyIndexPath: string,
  fn: () => Promise<void>,
): Promise<void> {
  const backupRoot = mkdtempSync(join(tmpdir(), "trama-update-backup-"));
  const backupDir = join(backupRoot, "project");
  cpSync(projectDir, backupDir, { recursive: true });

  try {
    await fn();
  } catch (err) {
    // Restore from backup, preserving any new repair history entries
    const failedHistory = existsSync(historyIndexPath) ? readFileSync(historyIndexPath, "utf-8") : "";
    rmSync(projectDir, { recursive: true, force: true });
    cpSync(backupDir, projectDir, { recursive: true });
    if (failedHistory.startsWith(originalHistory)) {
      const repairEntries = failedHistory.slice(originalHistory.length);
      if (repairEntries.length > 0) {
        appendFileSync(join(projectDir, "history", "index.jsonl"), repairEntries);
      }
    }
    throw new Error(
      `Update failed — project files have been restored to the previous version.\n` +
      `${err instanceof Error ? err.message : err}`
    );
  } finally {
    rmSync(backupRoot, { recursive: true, force: true });
  }
}

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
    mkdirSync(join(projectDir, "history"), { recursive: true });
    mkdirSync(join(projectDir, "logs"), { recursive: true });

    writeFileSync(join(projectDir, "package.json"), JSON.stringify({ type: "module" }, null, 2));
    writeFileSync(join(projectDir, ".gitignore"), "node_modules/\nstate.json\nlogs/\nhistory/\n");

    const meta = {
      input: { prompt, args: options?.args ?? {} },
      createdAt: new Date().toISOString(),
      piVersion: PI_VERSION,
    };
    writeFileSync(join(projectDir, "meta.json"), JSON.stringify(meta, null, 2));

    const config = loadConfig();
    if (options?.model) config.model = options.model;
    const adapter = new PiAdapter(config, projectDir);

    console.log(`Generating program for "${name}"...`);
    const program = stripCodeFences(await isolatedAsk(adapter,
      `${prompt}\n\nOutput ONLY the TypeScript program. No markdown fences. No explanation.`,
      { system: getSystemPrompt() },
    ));

    writeFileSync(join(projectDir, "program.ts"), program);
    keepProjectOnFailure = true;

    console.log("Validating program...");
    await smokeRunAndRepair(projectDir, adapter, "create", {
      timeout: config.defaultTimeout,
      maxRepairAttempts: config.maxRepairAttempts,
      maxIterations: config.defaultMaxIterations,
    });

    copyFileSync(join(projectDir, "program.ts"), join(projectDir, "history", "0001.ts"));
    appendFileSync(
      join(projectDir, "history", "index.jsonl"),
      JSON.stringify({ version: 1, reason: "create", timestamp: new Date().toISOString(), prompt }) + "\n",
    );

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

  const programPath = join(projectDir, "program.ts");
  const originalSource = readFileSync(programPath, "utf-8");
  const state = loadState(projectDir);
  const meta = JSON.parse(readFileSync(join(projectDir, "meta.json"), "utf-8"));
  const historyIndexPath = join(projectDir, "history", "index.jsonl");
  const originalHistory = existsSync(historyIndexPath) ? readFileSync(historyIndexPath, "utf-8") : "";

  const config = loadConfig();
  const adapter = new PiAdapter(config, projectDir);

  // Backup before any LLM calls, restore on any failure
  await withProjectBackup(projectDir, originalHistory, historyIndexPath, async () => {
    const systemPrompt =
      getSystemPrompt() +
      `\n\nOriginal prompt: ${meta.input.prompt}` +
      `\n\nCurrent program.ts:\n${originalSource}` +
      (Object.keys(state).length > 0 ? `\n\nCurrent state:\n${JSON.stringify(state, null, 2)}` : "");

    console.log(`Updating "${name}"...`);
    const updated = stripCodeFences(await isolatedAsk(adapter,
      `${prompt}\n\nOutput the complete updated program.ts. No partial patches. No markdown fences. No explanation.`,
      { system: systemPrompt },
    ));

    writeFileSync(programPath, updated);

    console.log("Validating updated program...");
    await smokeRunAndRepair(projectDir, adapter, "update", {
      timeout: config.defaultTimeout,
      maxRepairAttempts: config.maxRepairAttempts,
      maxIterations: config.defaultMaxIterations,
    });

    copyToHistory(projectDir, "update", prompt);

    console.log(`Updated ${name}. Run with: trama run ${name}`);
  });
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
      const meta = JSON.parse(readFileSync(join(projectDir, "meta.json"), "utf-8"));
      prompt = meta.input?.prompt ?? "";
      if (prompt.length > 60) prompt = prompt.slice(0, 57) + "...";
    } catch { /* no meta */ }

    try {
      const stat = statSync(join(projectDir, "program.ts"));
      modified = stat.mtime.toISOString().slice(0, 19).replace("T", " ");
    } catch { /* no program.ts */ }

    console.log(`  ${entry.name}  ${prompt}  ${modified}`);
  }
}

export async function showLogs(name: string): Promise<void> {
  const projectDir = resolveProject(name);
  const logsPath = join(projectDir, "logs", "latest.jsonl");

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
