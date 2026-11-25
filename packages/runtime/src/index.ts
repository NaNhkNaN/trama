// @trama-dev/runtime runner surface — exported via "@trama-dev/runtime/runner"

import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync, rmSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { piVersion } from "./pi-adapter.js";
import { stripCodeFences } from "./agent.js";
import { onAbort, throwIfAborted } from "./abort.js";
import type { AgentUsage } from "./agent-backend.js";
import { createMeter, type Meter } from "./budget.js";
import { LATEST_LOG_PATH } from "./context.js";
import { readProjectMeta } from "./meta.js";
import { ensureProjectScaffold, loadConfig, loadProjectConfig, loadState, namesAPath, projectNamed } from "./project.js";
import { createBackend, saysOnce, type Backend } from "./runner-backend.js";
import {
  validateProgram, installValidatedProgram, keepBeside, writtenFrom, writtenBy,
  withTempDir, prepareProject, shownPaths, type Prepared, RUNTIME_TYPES, runProgram as runHere, replayProgram as replayHere, replayAll as replayAllHere, rollbackTo, whyNotReplaceable,
  inputMarkOf as markHere,
  tagged, failureOf, type AskedToMake, type Making,
} from "./runner.js";
import { createWorkspace as workspaceHere, ensureWorkspaceDir } from "./workspace.js";
import { parentBridge, remoteWorkspace, withOptions, type Bridge } from "./bridge-client.js";
import { guardPath, identityOf, sameProjectAs } from "./path-guard.js";
import { printJournals, spentIn } from "./journal-view.js";
import { messageOf } from "./errors.js";

export type { HistoryRun, HistoryVersion, ProjectHistory, RolledBack, VersionMade } from "./runner-types.js";
import type { ProjectHistory, RolledBack, VersionMade } from "./runner-types.js";
import { readHistory as historyHere, textOfVersion } from "./history.js";
import { describeProject as describeHere, describeProjects as describeAllHere } from "./contract.js";
import type { ProjectDescription } from "./contract.js";
export type { ProjectDescription } from "./contract.js";
export type { Budget, Check, ProgramResult, RunOptions, ReplayOptions, ReplayResult, ReplayAllResult } from "./runner-types.js";
export { failureOf } from "./runner.js";
export { requestsWhole } from "./journal-view.js";
import type { ProgramResult, RunOptions, ReplayAllResult, ReplayOptions, ReplayResult, TramaConfig } from "./runner-types.js";
export type { Workspace, ObserveResult } from "./types.js";
import type { Workspace } from "./types.js";

// --- Running a project, making one, and reaching a workspace ---
//
// A program never runs another program, nor makes or changes a project: it
// asks its runner to. So these do their work in this process only when this
// process is not itself a program. Inside one they are calls on the bridge,
// carried out by the one runner that owns every run in the tree — which is
// how it can time them, stop them, count what they use, and see them.

/**
 * Ask this program's runner for something that lasts as long as the call
 * does — a run, a project made. A signal cannot cross the bridge, but what
 * it says can: the runner is told to stop it, and this call still waits for
 * it to be over — the same as outside a program.
 */
async function overBridge<T>(bridge: Bridge, endpoint: string, asked: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const id = randomUUID();
  const offStop = onAbort(signal, () => {
    bridge.call("/run/stop", { id }).catch(() => { /* no runner left to tell */ });
  });
  try {
    return await bridge.call(endpoint, withOptions({ id }, asked));
  } finally {
    offStop();
  }
}

/** How this runner makes or changes a project for a program that asks it to (see Making). */
const making: Making = async (request, asked) =>
  request.kind === "rollback" ? rollbackHere(request.name, request.version, asked)
    : request.kind === "version" ? addVersionHere(request.name, request.source, { parent: request.parent, detail: request.detail, signal: asked.signal }, asked)
    : request.kind === "create"
      ? createHere(request.name, request.prompt, { model: request.model, args: request.args, signal: asked.signal }, asked)
      : updateHere(request.name, request.prompt, { from: request.from, install: request.install, updateWith: request.updateWith, signal: asked.signal }, asked);

/** Run a project to an outcome: done, yielded, or failed. */
export async function runProgram(options: RunOptions): Promise<ProgramResult> {
  const bridge = parentBridge();
  if (!bridge) return runHere(options, undefined, making);

  const { signal, ...request } = options;
  return overBridge(bridge, "/run/program", {
    ...request,
    // The runner does not share this program's working directory.
    projectDir: resolve(request.projectDir),
    workspaceDir: request.workspaceDir && resolve(request.workspaceDir),
    // (A path is this program's to say where it leads. A name is one of the user's projects, wherever it is said.)
    repairWith: request.repairWith !== undefined && namesAPath(request.repairWith) ? projectNamed(request.repairWith) : request.repairWith,
    checkWith: request.checkWith !== undefined && namesAPath(request.checkWith) ? projectNamed(request.checkWith) : request.checkWith,
  }, signal);
}

/**
 * Replay a recorded run of a project: its program run again with each call
 * answered from the record, and none carried out — nothing asked of a model,
 * nothing written to the project, nothing spent. What comes back is how far
 * the program went the way it had gone, and where it left the record (see
 * `ReplayResult`).
 *
 * A program asks its runner for it, as it does for a run: it is made
 * there, is stopped with the program's run, and is a call on that run's
 * record.
 */
export async function replayProgram(options: ReplayOptions): Promise<ReplayResult> {
  const bridge = parentBridge();
  if (!bridge) return replayHere(options);
  const { signal, ...request } = options;
  // (The runner does not share this program's working directory.)
  return overBridge(bridge, "/project/replay", { ...request, projectDir: resolve(request.projectDir) }, signal);
}

/**
 * Hold a project's program to every run of it that is on record and over:
 * each replayed by itself (see `replayProgram`), and one answer for all —
 * `same`, where every run that could be replayed went as recorded. A record
 * is a test of the way its run went: this is the check for a change that is
 * meant to change nothing.
 */
export async function replayAll(options: Omit<ReplayOptions, "run">): Promise<ReplayAllResult> {
  const bridge = parentBridge();
  if (!bridge) return replayAllHere(options);
  const { signal, ...request } = options;
  return overBridge(bridge, "/project/replay", { ...request, projectDir: resolve(request.projectDir), all: true }, signal);
}

/**
 * Replay a run of a project by its name — or, with `all`, every run on
 * record — and say how it went. Returns whether it went as recorded.
 */
export async function showReplay(name: string, options: { run?: string; all?: boolean; loose?: boolean; signal?: AbortSignal } = {}): Promise<boolean> {
  const status = (result: ProgramResult) => (result.status === "failed" ? `failed — ${failureOf(result.reason).split("\n")[0]}` : result.status);
  const { all, ...asked } = options;
  if (all) {
    if (asked.run !== undefined) throw new Error("--all replays every run: name one, or give --all.");
    const went = await replayAll({ projectDir: resolveProject(name), loose: asked.loose, signal: asked.signal });
    const calls = (n: number) => `${n} call${n === 1 ? "" : "s"}`;
    for (const { run, replay, notReplayed } of went.runs) {
      console.log(`${run}: ${!replay ? `not replayed — ${notReplayed}`
        : replay.same ? `as recorded (${calls(replay.recorded)}, ${replay.result!.status})`
        : replay.left ? `left the record at its call ${replay.left.call} (${replay.left.endpoint}): ${replay.left.why}`
        : !replay.sameEnd ? `ended otherwise than was recorded: ${status(replay.result!)} (recorded: ${replay.recordedResult ? status(replay.recordedResult) : "not said"})`
        : replay.other.length > 0 ? `${replay.other.length} of its ${calls(replay.recorded)} asked otherwise than was recorded; the first, call ${replay.other[0].call} (${replay.other[0].endpoint}): ${replay.other[0].difference}`
        : `ended as recorded, without ${calls(replay.unasked)} the record has`}`);
    }
    const as = went.runs.filter(({ replay }) => replay?.same).length;
    console.log(`${as} of ${went.replayed} run${went.replayed === 1 ? "" : "s"} replayed went as recorded${went.replayed < went.runs.length ? `; ${went.runs.length - went.replayed} could not be replayed` : ""}`);
    return went.same;
  }
  const went = await replayProgram({ projectDir: resolveProject(name), ...asked });
  console.log(`replay of run ${went.run}, attempt ${went.attempt}: the program is ${went.sameProgram ? "" : "not "}the one that was recorded`);
  console.log(`${went.answered} of its ${went.recorded} calls were answered from the record; none was carried out`);
  if (went.other.length > 0) {
    console.log(`${went.other.length} of them asked otherwise than was recorded:`);
    for (const { call, endpoint, difference } of went.other) console.log(`    call ${call} (${endpoint}): ${difference}`);
  }
  if (went.left) console.log(`it left the record at its call ${went.left.call} (${went.left.endpoint}): ${went.left.why}`);
  else if (went.result) {
    console.log(went.sameEnd ? `it ended as recorded: ${went.result.status}`
      : `it ended otherwise than was recorded: ${status(went.result)} (recorded: ${went.recordedResult ? status(went.recordedResult) : "not said"})`);
    if (went.unasked > 0) console.log(`${went.unasked} of the record's calls it did not come to make`);
  }
  return went.same;
}

/**
 * A project's history, as it is on record: its versions, its runs — all
 * that are there, or the latest so many (`runs`) — and which version the
 * program is now (see `ProjectHistory`). Facts, in the order they came.
 *
 * A program asks its runner for it. They are files, and it could read them:
 * asked for so, what it read is on its run's record, and a replay of the run
 * is told what the run was told, not what the history has come to since.
 */
export async function readHistory(projectDir: string, options: { runs?: number } = {}): Promise<ProjectHistory> {
  const bridge = parentBridge();
  if (!bridge) return historyHere(projectDir, options);
  // (The runner does not share this program's working directory.)
  return bridge.call("/project/history", withOptions({ projectDir: resolve(projectDir) }, options));
}

/**
 * What a project says of itself: what it is for (`description`), what a run
 * of it is given (`parameters`) and gives (`returns`) — as its meta.json
 * writes them, and as JSON Schema. Its program is not run. The project is
 * named by its name among the user's projects, or by a path.
 *
 * A program asks its runner, as for a history: what it was told is on its
 * run's record.
 */
export async function describeProject(name: string): Promise<ProjectDescription> {
  const bridge = parentBridge();
  if (!bridge) return describeHere(name);
  return bridge.call("/project/describe", { name: namesAPath(name) ? resolve(name) : name });
}

/** The user's projects, by name, and what each says of itself (see `describeProject`): for a program that is to choose among them. */
export async function describeProjects(): Promise<ProjectDescription[]> {
  const bridge = parentBridge();
  if (!bridge) return describeAllHere();
  return bridge.call("/project/describe", {});
}

/**
 * The mark of what a run of a project is started with, where it is asked
 * for with these arguments: the `input` of its line in the project's
 * history. By it a program finds the runs on record that were started with
 * the same — and does not pay for what is there. A program asks its runner
 * for it, as for the history it is held against.
 */
export async function inputMarkOf(projectDir: string, args?: Record<string, unknown>): Promise<string> {
  const bridge = parentBridge();
  if (!bridge) return markHere(projectDir, args);
  return bridge.call("/project/mark", withOptions({ projectDir: resolve(projectDir) }, args === undefined ? {} : { args }));
}

/**
 * Go back to a version of a project's program, by the project's name: the
 * version's text becomes the program again, as a new version. Nothing is
 * run or validated, and nothing else of the project is touched (see
 * `trama history <name>` for the versions there are).
 *
 * A program asks its runner for it, as it does for an update: the project
 * is changed there, and that it was is on the run's record.
 */
export async function rollbackProject(name: string, version: number): Promise<RolledBack> {
  const bridge = parentBridge();
  if (!bridge) return rollbackHere(name, version);
  return overBridge(bridge, "/project/rollback", { name, version });
}

function rollbackHere(name: string, version: number, asked: Asked = {}): RolledBack {
  const went = rollbackTo(resolveProject(name), version);
  shownUnder(asked.label).log("unchanged" in went
    ? `${name} is at version ${went.version} already: nothing was changed.`
    : `${name} is at version ${went.from} again, as version ${went.version}. The program was not run, and nothing else of the project was changed.`);
  return went;
}

/**
 * Show a project's history: each version — why it came, when, the hash of
 * its text — and how the runs of it went: how they ended, what each checker
 * said of them, what they took and used on the mean. With `runs`, each run.
 * It counts and takes means, and says of no version that it is the better.
 */
export async function showHistory(name: string, options: { runs?: boolean } = {}): Promise<void> {
  const { versions, runs, current } = historyHere(resolveProject(name));
  if (versions.length === 0 && runs.length === 0) {
    console.log(`No version of ${name} is on record: its program has not been made by trama, or run, since history was kept.`);
    return;
  }
  const when = (at: string) => at.slice(0, 16).replace("T", " ");
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const mean = (numbers: number[]) => numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
  const rounded = (n: number) => String(Number(n.toFixed(3)));
  const oneLine = (text: string, most: number) => { const line = text.replace(/\s+/g, " ").trim(); return line.length > most ? `${line.slice(0, most)}…` : line; };
  const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
  const said = (check: NonNullable<(typeof runs)[number]["check"]>) =>
    (check.error !== undefined ? "not checked" : `${check.ok ? "ok" : "not ok"}${check.score !== undefined ? ` (score ${rounded(check.score)})` : ""}`);

  /** How some runs went: how many, how they ended, what they took and used on the mean — and what each checker said of them, by itself. */
  const told = (of: typeof runs) => {
    if (of.length === 0) return console.log("    no runs on record");
    const ended = (["done", "yielded", "failed"] as const).map((status) => [status, of.filter((run) => run.status === status).length] as const).filter(([, n]) => n > 0);
    const asked = of.filter((run) => run.used?.calls > 0);
    console.log(`    ${count(of.length, "run")}: ${ended.map(([status, n]) => `${n} ${status}`).join(", ")}; ${seconds(mean(of.map((run) => run.ms ?? 0)))} on the mean`
      + (asked.length > 0 ? `, ${Math.round(mean(of.map((run) => run.used?.tokens ?? 0)))} tokens and $${mean(of.map((run) => run.used?.cost ?? 0)).toFixed(4)} a run` : ""));
    // A verdict is its checker's: those of one checker — the same project, the same program — are said together, and never with another's.
    const checkers = new Map<string, NonNullable<(typeof runs)[number]["check"]>[]>();
    for (const { check } of of) if (check) checkers.set(`${check.by} (program ${check.program?.slice(0, 8) ?? "missing"})`, [...(checkers.get(`${check.by} (program ${check.program?.slice(0, 8) ?? "missing"})`) ?? []), check]);
    for (const [who, checks] of checkers) {
      const made = checks.filter((check) => check.error === undefined), scores = made.flatMap((check) => (check.score !== undefined ? [check.score] : []));
      console.log(`    checked by ${who}: ${made.filter((check) => check.ok).length} of ${made.length} ok`
        + (made.length < checks.length ? `, ${checks.length - made.length} not made` : "")
        + (scores.length > 0 ? `; score ${rounded(mean(scores))} on the mean` : ""));
    }
    if (!options.runs) return;
    for (const run of of) {
      console.log(`      ${[run.run ?? when(run.at), run.status, run.check && said(run.check), seconds(run.ms ?? 0),
        run.used?.calls > 0 && `${run.used.tokens} tokens $${run.used.cost.toFixed(4)}`, run.ended !== undefined && `fixed: v${run.ended} since`, run.reason && oneLine(run.reason, 100)].filter(Boolean).join("  ")}`);
    }
  };

  for (const version of versions) {
    console.log([`v${version.version}`, version.reason, when(version.at), version.sha256?.slice(0, 8) ?? "(its file is gone)", version.from !== undefined && `from v${version.from}`,
      version.parent !== undefined && `of v${version.parent}`, version.aside && "(beside the program)",
      version.detail && JSON.stringify(oneLine(version.detail, 60)), version.version === current && "← the program now"].filter(Boolean).join("  "));
    told(runs.filter((run) => run.version === version.version));
  }
  // Runs of a program that could not be put on record, or whose version is on record no longer.
  const known = new Set(versions.map((version) => version.version));
  const others = runs.filter((run) => run.version === undefined || !known.has(run.version));
  if (others.length > 0) {
    console.log("of no version on record");
    told(others);
  }
  if (runs.length > 0) console.log(`${count(runs.length, "run")} ${runs.length === 1 ? "is" : "are"} on record, the first of ${when(runs[0].at)}.`);
  if (current === undefined && versions.length > 0) {
    // (After the latest version it was made: one kept beside the program was never the program.)
    const was = versions.filter((version) => !version.aside).at(-1);
    console.log(`The program as it is now is on no record: it was changed${was ? ` after version ${was.version}` : ""}, and is recorded when it is next run.`);
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
  // (One line of text, too: a name is shown, in a line of its own making, wherever its project is spoken of.)
  if (!name || /[\/\\\x00-\x1f\x7f]/.test(name) || name === "." || name === "..") {
    throw new Error(`Invalid project name: ${JSON.stringify(name)}. Must be a simple directory name without path separators.`);
  }
}

/** Whether a project is at a path: a directory, reached however the path reaches it. */
const isProject = (dir: string): boolean => statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true;

export function resolveProject(name: string): string {
  validateProjectName(name);
  const dir = join(projectsDir(), name);
  if (!isProject(dir)) {
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
  backend: Backend, prepared: Prepared, prompt: string, system: string, wrote: AgentUsage[], signal?: AbortSignal,
  label?: string,
): Promise<string> {
  let reply: string;
  try {
    reply = await backend.ask(prompt, { cwd: prepared.copy, system, signal, used: (usage) => { wrote.push(usage); } });
  } finally {
    // What it took is said whatever came of it: it is on record only with a validation, and there may be none.
    // (A call that was cut off — stopped, or by the budget — says what it took once its backend has let go of it.)
    await backend.letGo();
    if (wrote.length > 0) console.log(tagged(label, `[trama] writing the program used ${spentIn(wrote)}`));
  }
  const program = stripCodeFences(reply);
  throwIfAborted(signal);
  if (program === "") throw new Error("The model answered with no program.");
  return program;
}

/**
 * What a project is made or changed under where a run's program asked its
 * runner for that (see AskedToMake) — and nothing, where a person or a host
 * did: then it is nobody's but its own.
 */
type Asked = Partial<AskedToMake>;

/**
 * The budget a create or an update is held to, writing the program and
 * validating it together: the config's — or, where a run's program asked
 * for it, that run's and those above it, and not the config's a second time.
 */
const budgetOf = (config: TramaConfig, asked: Asked) => (asked.above ? undefined : config.budget);

/**
 * The backend a create or an update asks: held to its budget, and it is said
 * when that is spent — once, and where a run's program asked, once for that
 * run, in the run's own words: a program may ask for many projects.
 */
function backendFor(config: TramaConfig, asked: Asked, meter: Meter = meterFor(config, asked)) {
  const say = (why: string) => console.warn(tagged(asked.label, `[trama] ${why}`));
  const { above } = asked;
  // (Asked for by a run's program, the project is written by an agent of that run: with the run's variables.)
  return createBackend(config, meter, above ? saysOnce(above, (why) => say(above.spent() ?? why)) : say, asked.env);
}

/** The count a create or an update is made under: writing the program, validating it, and a fix of it in between — whoever is asked for each. */
const meterFor = (config: TramaConfig, asked: Asked): Meter => createMeter(budgetOf(config, asked), asked.above);

/** Who fixes a candidate that fails its validation, where the configuration names a project for it: found before anything is written. */
function fixerOf(config: TramaConfig): string | undefined {
  if (config.repairWith === undefined || config.maxRepairAttempts <= 0) return undefined;
  const fixer = projectNamed(config.repairWith);
  if (!existsSync(join(fixer, "meta.json"))) throw new Error(`repairWith names no project: there is none at ${fixer}`);
  return fixer;
}

/** Carry what the agent made beside a program into the project the program is now in, and say what that was. */
function keepPrepared(prepared: Prepared, label?: string): void {
  const say = shownUnder(label);
  let kept: ReturnType<Prepared["keep"]>;
  try {
    kept = prepared.keep();
  } catch (err) {
    // The program is in the project. That what was made beside it cannot be carried over is said, and does not undo that.
    say.warn(`[trama] what was made beside the program, while it was written, could not be carried into the project: ${messageOf(err)}`);
    return;
  }
  const { changed, unmerged } = kept;
  if (changed.length > 0) {
    say.log(`[trama] ${changed.length} path(s) made or changed beside the program, while it was written: ${shownPaths(changed)}`);
  }
  if (unmerged.length > 0) {
    say.warn(`[trama] ${unmerged.length} thing(s) done while the program was written did not reach the project:`);
    for (const { path, why } of unmerged) say.warn(`[trama]   ${path} — ${why}`);
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
  projectDir: string, backend: Backend, candidate: string, config: TramaConfig, prepared: Prepared,
  wrote: AgentUsage[], signal: AbortSignal | undefined, asked: Asked, byItself = false,
  more: { meter?: Meter; writtenBy?: { by: string; used: { calls: number; tokens: number; cost: number } } } = {},
): Promise<{ validated: Awaited<ReturnType<typeof validateProgram>>; kept: boolean }> {
  let as: string | undefined, alone: string | undefined;
  if (config.agentChanges === "keep" && !byItself) {
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
    agents: config.agents,
    signal,
    as,
    alone,
    budget: budgetOf(config, asked),
    wrote,
    label: asked.label,
    env: asked.env,
    askedFor: asked.parent && asked.started && { parent: asked.parent, started: asked.started },
    // (A candidate that fails is fixed by whoever the configuration names to fix: a project, where it names one.)
    repairWith: fixerOf(config),
    ...more,
  });
  return { validated, kept: as !== undefined && validated.alone === undefined };
}

/** What is shown of a project being made, under the name of the run that asked for it — if one did, and has one. */
const shownUnder = (label: string | undefined) => ({
  log: (line: string) => console.log(tagged(label, line)),
  warn: (line: string) => console.warn(tagged(label, line)),
});

/**
 * How a project comes by a program that was asked for — a new project's
 * first, or one in the place of another: written off to the side, in a copy
 * of the project; validated; and only then made the project's, with what
 * the agent made beside it where that is kept. The project is written to
 * once there is a program that works. (`written`: told of the candidate
 * before it is validated, for whoever has a use for one that may yet fail.)
 */
async function writeValidateInstall(projectDir: string, how: {
  reason: "create" | "update";
  /** What was asked for, as it is kept on record with the version. */
  prompt: string;
  /** What the agent is asked, and what it is told beside. */
  ask: string;
  system: string;
  /** What is said as the validation begins. */
  validating: string;
  config: TramaConfig;
  backend: Backend;
  /** Throws where the project is no longer the directory it was (see sameProjectAs). */
  stillTheProject: () => void;
  signal?: AbortSignal;
  asked: Asked;
  written?: (candidate: string) => void;
  /** Of an update: the text it is written from, where that is a version named and not the program as it is — and which version that is. */
  from?: { text: string; version: number };
  /** Of an update: kept beside the program, on record, and not made the program (`parent`: the version it is written from). */
  beside?: { parent: number | null };
  /** The count all of it is made under (the backend's). */
  meter?: Meter;
  /** Of an update: the project that writes it, in the place of pi's agent — and the program it writes from (see `writtenBy`). */
  writer?: { project: string; program: string };
}): Promise<number> {
  const { config, backend, stillTheProject, signal, asked } = how;
  const wrote: AgentUsage[] = [];
  return withTempDir("trama-gen-", async (privateDir) => {
    const prepared = prepareProject(projectDir, privateDir, how.from?.text);
    // Who writes: a project, where one is named — or pi's agent, at work in the copy with its own tools.
    let candidate: string, by: { by: string; used: { calls: number; tokens: number; cost: number } } | undefined;
    if (how.writer) {
      const meter = how.meter ?? meterFor(config, asked), before = meter.counted();
      // (What it makes beside the program is kept where an agent's would be: not of a version that is kept beside the program.)
      candidate = await writtenBy(how.writer.project, { prompt: how.prompt, program: how.writer.program, kept: config.agentChanges === "keep" && !how.beside, copy: prepared.copy }, { ...asked, signal, meter });
      const now = meter.counted();
      by = { by: how.writer.project, used: { calls: now.calls - before.calls, tokens: now.tokens - before.tokens, cost: now.cost - before.cost } };
    } else {
      candidate = await generateProgram(backend, prepared, how.ask, how.system, wrote, signal, asked.label);
    }
    stillTheProject();
    how.written?.(candidate);

    shownUnder(asked.label).log(how.validating);
    // (A version that is to be kept beside the program is the program's text and no more: it is validated in the
    // project as it is, where it will be run — not with what its writer made beside it, which is not kept.)
    const { validated, kept } = await validateCandidate(projectDir, backend, candidate, config, prepared, wrote, signal, asked, how.beside !== undefined, { meter: how.meter, ...(by && { writtenBy: by }) });
    stillTheProject();
    if (how.beside) return keepBeside(projectDir, validated, how.prompt, how.beside.parent);
    const version = installValidatedProgram(projectDir, validated, how.reason, how.prompt, how.from?.version);
    if (kept) keepPrepared(prepared, asked.label);
    return version;
  });
}

// --- Public API ---

/** Generate a program for a new project from a prompt, validate it, and make it the project's. */
export async function createProject(
  name: string,
  prompt: string,
  options?: { model?: string; args?: Record<string, unknown>; signal?: AbortSignal },
): Promise<void> {
  const bridge = parentBridge();
  if (!bridge) return createHere(name, prompt, options);
  const { signal, ...asked } = options ?? {};
  await overBridge(bridge, "/project/create", withOptions({ name, prompt }, asked), signal);
}

/**
 * Generate a new program for a project from a prompt and its current one,
 * validate it, and put it in the other's place. Returns the version it is.
 *
 * `from`: written from that version of the project's program, by its number
 * in the project's history, and not from the program as it is.
 *
 * `install: false`: kept beside the program — on record as a version, which
 * can be run by its number (`runProgram({ version })`) and gone to
 * (`rollbackProject`) — and not made the program: the project is as it was.
 * So a version is tried before anything is put in the program's place.
 *
 * `updateWith`: the project that writes the program, in the place of pi's
 * agent — by its name among the user's projects, or a path. Without one,
 * the configuration's `updateWith`; without that, pi's agent. It is run
 * with a copy of the project as its workspace, handed `{ prompt, program,
 * kept, types, copy }`, and answers `{ program }` (see
 * examples/update-by-harness). What is done round the writing — the copy,
 * the validation, the record, what is installed — is the runner's whoever
 * writes.
 */
export async function updateProject(
  name: string,
  prompt: string,
  options?: { from?: number; install?: boolean; updateWith?: string; signal?: AbortSignal },
): Promise<VersionMade> {
  const bridge = parentBridge();
  if (!bridge) return updateHere(name, prompt, options);
  const { signal, ...asked } = options ?? {};
  // (A path a program names is named from where the program is: the runner does not share its working directory.)
  if (typeof asked.updateWith === "string" && namesAPath(asked.updateWith)) asked.updateWith = projectNamed(asked.updateWith);
  return overBridge(bridge, "/project/update", withOptions({ name, prompt }, asked), signal);
}

/**
 * Put a program's text on record as a version of a project, beside the
 * project's program: for whoever writes programs by a way of its own — a
 * program that is itself the writer. It is validated as an update's is (a
 * text that does not run is no version, and nothing is mended: it is on
 * record as it was handed over, or not at all), and the program is not
 * touched. `parent`: the version it was written from — the program as it
 * is, where none is named. `detail`: what it was made for, in words.
 */
export async function addVersion(
  name: string,
  source: string,
  options?: { parent?: number; detail?: string; signal?: AbortSignal },
): Promise<VersionMade> {
  const bridge = parentBridge();
  if (!bridge) return addVersionHere(name, source, options);
  const { signal, ...asked } = options ?? {};
  return overBridge(bridge, "/project/version", withOptions({ name, source }, asked), signal);
}

async function addVersionHere(
  name: string,
  source: string,
  options?: { parent?: number; detail?: string; signal?: AbortSignal },
  asked: Asked = {},
): Promise<VersionMade> {
  const projectDir = resolveProject(name);
  const refused = (why: unknown) => new Error(`The version is not put on record.\n${messageOf(why)}`);
  const stillTheProject = sameProjectAs(projectDir);
  try {
    if (typeof source !== "string" || source.trim() === "") throw new Error("A version is a program's text, and this is none.");
    throwIfAborted(options?.signal);
    ensureProjectScaffold(projectDir);
    const parent = writtenFrom(projectDir, options?.parent);
    const config = loadProjectConfig(projectDir);
    shownUnder(asked.label).log(`Validating a version of "${name}"...`);
    const validated = await validateProgram(projectDir, backendFor(config, asked), source, {
      timeout: config.defaultTimeout,
      // (As it was handed over, or not at all: a fix would be another text than the one its writer answers for.)
      maxRepairAttempts: 0,
      maxIterations: config.defaultMaxIterations,
      journalRuns: config.journalRuns,
      agents: config.agents,
      signal: options?.signal,
      budget: budgetOf(config, asked),
      wrote: [],
      label: asked.label,
      env: asked.env,
      askedFor: asked.parent && asked.started && { parent: asked.parent, started: asked.started },
    });
    stillTheProject();
    return { version: keepBeside(projectDir, validated, options?.detail, parent) };
  } catch (err) {
    throw refused(err);
  }
}

async function createHere(
  name: string,
  prompt: string,
  options?: { model?: string; args?: Record<string, unknown>; signal?: AbortSignal },
  asked: Asked = {},
): Promise<void> {
  const say = shownUnder(asked.label);
  validateProjectName(name);
  // (Asked before a project is made: what is no name of a model would be written down as the project's, and no run of it could read that.)
  if (options?.model !== undefined && typeof options.model !== "string") {
    throw new Error(`Invalid model: ${JSON.stringify(options.model)}. A model is named in text.`);
  }
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
    writeFileSync(guardPath(projectDir, "meta.json"), JSON.stringify(meta, null, 2));

    const backend = backendFor(config, asked);

    say.log(`Generating program for "${name}"...`);
    // (What the agent is given to look at is the project made here, and no other directory that is at its path by now.)
    stillTheProject();
    await writeValidateInstall(projectDir, {
      reason: "create",
      prompt,
      ask: `${prompt}\n\nOutput ONLY the TypeScript program. No markdown fences. No explanation.`,
      system: getSystemPrompt(config.agentChanges === "keep"),
      validating: "Validating program...",
      config, backend, stillTheProject, signal: options?.signal, asked,
      // From here on the project is kept even if validation fails, so the
      // generated program can be inspected and fixed by hand.
      written: (candidate) => {
        writeFileSync(guardPath(projectDir, "program.ts"), candidate);
        keepProjectOnFailure = true;
      },
    });

    say.log(`Created ${name}. Run with: trama run ${name}`);
  } catch (err) {
    if (!keepProjectOnFailure && identityOf(projectDir) === made) {
      rmSync(projectDir, { recursive: true, force: true });
    }
    throw err;
  }
}

async function updateHere(
  name: string,
  prompt: string,
  options?: { from?: number; install?: boolean; updateWith?: string; signal?: AbortSignal },
  asked: Asked = {},
): Promise<VersionMade> {
  const say = shownUnder(asked.label);
  const projectDir = resolveProject(name);
  const unchanged = (why: unknown) =>
    new Error(`Update failed — the program is unchanged.\n${messageOf(why)}`);
  const stillTheProject = sameProjectAs(projectDir);
  const beside = options?.install === false;
  // Asked before anything else is done, the project's own preparation included: an update's only
  // use is to replace the program, and where that cannot be done there is nothing to prepare for.
  // (Unless it is to be kept beside the program: then the program is not replaced.)
  const refusal = beside ? null : whyNotReplaceable(projectDir);
  if (refusal) throw unchanged(refusal);
  let version: number;

  // The new program is generated and validated off to the side. The project is
  // only written to once there is a program that works, so a failed update has
  // nothing to undo.
  try {
    throwIfAborted(options?.signal);
    // A hand-written project may never have been run: give it history/ and the rest first.
    ensureProjectScaffold(projectDir);

    // What it is written from: the program as it is — or a version of it that is named, which is to be there.
    // (And where it is to be kept beside the program, what it is written from is on record: put there, where it is not.)
    const from = options?.from === undefined ? undefined : { version: writtenFrom(projectDir, options.from)!, text: textOfVersion(projectDir, options.from) };
    const parent = beside ? from?.version ?? writtenFrom(projectDir) : undefined;
    const originalSource = from?.text ?? readFileSync(guardPath(projectDir, "program.ts"), "utf-8");
    const state = loadState(projectDir);
    const meta = readProjectMeta(projectDir);
    const config = loadProjectConfig(projectDir, meta);
    const meter = meterFor(config, asked);
    const backend = backendFor(config, asked, meter);
    // Who writes it: the project the call names, or the configuration — or, with neither, pi's agent.
    const named = options?.updateWith ?? config.updateWith;
    const writer = named === undefined ? undefined : projectNamed(named);
    if (writer !== undefined && !existsSync(join(writer, "meta.json"))) throw new Error(`updateWith names no project: there is none at ${writer}`);

    // What the project says it takes and gives is told to whoever writes its program: a writer that is a project has
    // it in its copy (meta.json); pi's agent is told here. The program is held to it, and it is not the program's to change.
    const says = { description: meta.description, parameters: meta.parameters, returns: meta.returns };
    const systemPrompt =
      getSystemPrompt(config.agentChanges === "keep") +
      (says.parameters !== undefined || says.returns !== undefined
        ? `\n\nWhat the project says it takes and gives (its meta.json): the program is held to it — a run's arguments are these and no others, and what the program ends with is to be of this shape — and it is not the program's to change.\n${JSON.stringify(says, null, 2)}`
        : "") +
      `\n\nOriginal prompt: ${meta.input.prompt}` +
      `\n\nCurrent program.ts:\n${originalSource}` +
      (Object.keys(state).length > 0 ? `\n\nCurrent state:\n${JSON.stringify(state, null, 2)}` : "");

    say.log(`Updating "${name}"...`);
    version = await writeValidateInstall(projectDir, {
      ...(from && { from }),
      ...(parent !== undefined && { beside: { parent } }),
      reason: "update",
      prompt,
      ask: `${prompt}\n\nOutput the complete updated program.ts. No partial patches. No markdown fences. No explanation.`,
      system: systemPrompt,
      validating: "Validating updated program...",
      config, backend, stillTheProject, signal: options?.signal, asked, meter,
      ...(writer !== undefined && { writer: { project: writer, program: originalSource } }),
    });
  } catch (err) {
    throw unchanged(err);
  }

  say.log(beside ? `Version ${version} of ${name} is on record, beside its program. Run with: trama run ${name} --at-version ${version}` : `Updated ${name}. Run with: trama run ${name}`);
  return { version };
}

export async function listProjects(): Promise<void> {
  const dir = projectsDir();
  if (!existsSync(dir)) {
    console.log("No projects found.");
    return;
  }

  // (What can be run by its name is listed by it: a project reached through a link among them.)
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter(e => isProject(join(dir, e.name)));

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
      // (What it is for, where it says so: and what it was made with, where it does not.)
      prompt = typeof meta.description === "string" ? meta.description : meta.input?.prompt ?? "";
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
