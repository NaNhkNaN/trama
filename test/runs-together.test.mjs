import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { runProgram } from "../packages/runtime/dist/runner.js";
import { createWorkspace } from "../packages/runtime/dist/index.js";
import { pathToFileURL } from "url";
import {
  REPO_ROOT, cleanupTempDir, createProjectFixture, isAlive, makeTempDir, pidIn, runNodeCommand, startRunnerProcess,
  waitFor,
} from "./helpers.mjs";

// Runs that work together: several runs of one runner that share a workspace, started by a host or — through its
// runner — by a program. There is no layer for it: a run is given the workspace and a name (runProgram's
// workspaceDir and label), and whoever started it has the workspace by its directory (createWorkspace). What a
// program then makes of several such runs is the program's.

/** A run among others: given the workspace they share, and a name. */
const start = (name, workspaceDir, options) => runProgram({ ...options, workspaceDir, label: name });

/** The runner as a program reaches it: the public surface, not the module the tests call directly. */
const RUNNER_SURFACE_URL = pathToFileURL(join(REPO_ROOT, "packages", "runtime", "dist", "index.js")).href;

test("a run among others ends as any run does: done, with what it gave", async (t) => {
  const projectDir = makeTempDir("trama-session-");
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(wsDir); });
  createProjectFixture(projectDir, {
    programSource: `import { ctx } from "@trama-dev/runtime";
await ctx.done({ ok: true });
`,
  });

  const result = await start("test-agent", wsDir, { projectDir, maxRepairAttempts: 0, timeout: 5_000 });

  assert.equal(result.status, "done");
  assert.deepEqual(result.result, { ok: true });
});

test("a run among others that yields ends as yielded, with its reason", async (t) => {
  const projectDir = makeTempDir("trama-session-");
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(wsDir); });
  createProjectFixture(projectDir, {
    programSource: `import { ctx } from "@trama-dev/runtime";
await ctx.yield("waiting");
`,
  });

  const result = await start("test-agent", wsDir, { projectDir, maxRepairAttempts: 0, timeout: 5_000 });

  assert.equal(result.status, "yielded");
  assert.equal(result.reason, "waiting");
});

test("a run among others that fails ends as failed: a result, and nothing thrown", async (t) => {
  const projectDir = makeTempDir("trama-session-");
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(wsDir); });
  createProjectFixture(projectDir, {
    programSource: `throw new Error("boom");`,
  });

  const result = await start("test-agent", wsDir, { projectDir, maxRepairAttempts: 0, timeout: 5_000 });

  assert.equal(result.status, "failed");
  assert.match(result.reason, /boom/);
});

test("a run that yielded is taken up by running it again: it has its state, and the workspace as it was left", async (t) => {
  const projectDir = makeTempDir("trama-session-");
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(wsDir); });
  createProjectFixture(projectDir, {
    programSource: `import { ctx, workspace } from "@trama-dev/runtime";
if (!ctx.resumed) {
  ctx.state.step = 1;
  await ctx.yield("need input");
}
await workspace.write("result.txt", "step=" + ctx.state.step);
await ctx.done();
`,
  });

  const first = await start("test-agent", wsDir, { projectDir, maxRepairAttempts: 0, timeout: 5_000 });
  assert.equal(first.status, "yielded");

  const second = await start("test-agent", wsDir, { projectDir, maxRepairAttempts: 0, timeout: 5_000 });
  assert.equal(second.status, "done");

  // Verify workspace artifact was written during resumed run
  const { readFileSync } = await import("fs");
  assert.equal(readFileSync(join(wsDir, "result.txt"), "utf-8"), "step=1");
});

test("runs given one workspace share it: what one writes there the next reads", async (t) => {
  const projectDir1 = makeTempDir("trama-session-");
  const projectDir2 = makeTempDir("trama-session-");
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => {
    cleanupTempDir(projectDir1);
    cleanupTempDir(projectDir2);
    cleanupTempDir(wsDir);
  });

  createProjectFixture(projectDir1, {
    programSource: `import { ctx, workspace } from "@trama-dev/runtime";
await workspace.write("from-agent1.txt", "hello from agent 1");
await ctx.done();
`,
  });
  createProjectFixture(projectDir2, {
    programSource: `import { ctx, workspace } from "@trama-dev/runtime";
const msg = await workspace.read("from-agent1.txt");
await workspace.write("from-agent2.txt", "got: " + msg);
await ctx.done();
`,
  });

  // Agent 1 writes to workspace
  await start("agent1", wsDir, { projectDir: projectDir1, maxRepairAttempts: 0, timeout: 5_000 });

  // Agent 2 reads from workspace
  const result2 = await start("agent2", wsDir, { projectDir: projectDir2, maxRepairAttempts: 0, timeout: 5_000 });
  assert.equal(result2.status, "done");

  const { readFileSync } = await import("fs");
  assert.equal(readFileSync(join(wsDir, "from-agent2.txt"), "utf-8"), "got: hello from agent 1");
});

test("whoever starts a run has its workspace by the directory, and exchanges artifacts with the run as it goes", async (t) => {
  const projectDir = makeTempDir("trama-session-");
  const wsDir = makeTempDir("trama-session-ws-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(wsDir); });

  createProjectFixture(projectDir, {
    programSource: `import { ctx, workspace } from "@trama-dev/runtime";
const question = await workspace.observe("question.txt", { timeout: 5000 });
await workspace.write("answer.txt", question.toUpperCase());
await ctx.done();`,
  });

  const shared = createWorkspace(wsDir);
  const run = start("echo", wsDir, { projectDir, maxRepairAttempts: 0, timeout: 10_000 });
  await shared.write("question.txt", "hello");
  const answer = await shared.observe("answer.txt", { timeout: 10_000 });

  assert.equal(answer, "HELLO");
  assert.equal((await run).status, "done");
  assert.deepEqual(await shared.list("*.txt"), ["answer.txt", "question.txt"]);
});

test("a program has several runs work together through its runner: each given a workspace and a name, the workspace its own by the directory — and no layer of trama's for it", async (t) => {
  const entryDir = makeTempDir("trama-session-entry-");
  const workerDir = makeTempDir("trama-session-worker-");
  let sharedDir;
  t.after(() => {
    cleanupTempDir(entryDir);
    cleanupTempDir(workerDir);
    if (sharedDir) cleanupTempDir(sharedDir);
  });

  // The participant: reads the brief, writes its finding.
  createProjectFixture(workerDir, {
    programSource: `import { ctx, workspace } from "@trama-dev/runtime";
const brief = await workspace.observe("brief.txt", { timeout: 10000 });
await workspace.write("findings/" + ctx.input.args.check + ".txt", ctx.input.args.check + " checked: " + brief);
await ctx.done();`,
  });

  // The entry program: an ordinary program.ts that asks its runner for the runs,
  // fans out to them, and gathers what they wrote — no host code involved.
  createProjectFixture(entryDir, {
    scaffold: false,
    programSource: `import { ctx } from "@trama-dev/runtime";
import { createWorkspace, runProgram } from "@trama-dev/runtime/runner";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const workspaceDir = mkdtempSync(join(tmpdir(), "trama-together-"));
const shared = createWorkspace(workspaceDir);
const checks = ["sql", "xss"];
const runs = checks.map(check => runProgram({
  projectDir: ctx.input.args.workerDir,
  workspaceDir,
  label: check,
  args: { check },
  maxRepairAttempts: 0,
  timeout: 20000,
}));
await shared.write("brief.txt", "diff-42");
const findings = await shared.observe("findings/*.txt", { expect: checks.length, timeout: 20000 });
const statuses = (await Promise.all(runs)).map(r => r.status);
await ctx.done({ workspaceDir, statuses, findings });`,
  });

  const result = await runProgram({
    projectDir: entryDir, maxRepairAttempts: 0, timeout: 40_000, args: { workerDir },
  });

  assert.equal(result.status, "done", result.reason);
  sharedDir = result.result.workspaceDir;
  assert.deepEqual(result.result.statuses, ["done", "done"]);
  assert.deepEqual(result.result.findings, [
    { path: "findings/sql.txt", content: "sql checked: diff-42" },
    { path: "findings/xss.txt", content: "xss checked: diff-42" },
  ]);
  // What a project is linked to, for its program to import, is the runtime — and nothing else of trama's.
  assert.deepEqual(readdirSync(join(entryDir, "node_modules", "@trama-dev")), ["runtime"]);
});

test("a program is not timed out for the time its participant takes", async (t) => {
  const entryDir = makeTempDir("trama-session-entry-");
  const workerDir = makeTempDir("trama-session-worker-");
  const wsDir = makeTempDir("trama-session-ws-");
  t.after(() => { cleanupTempDir(entryDir); cleanupTempDir(workerDir); cleanupTempDir(wsDir); });

  // A participant that takes longer than the whole allowance of the program waiting for it.
  createProjectFixture(workerDir, {
    programSource: `import { ctx } from "@trama-dev/runtime";
await new Promise(resolve => setTimeout(resolve, 7000));
await ctx.done({ worked: true });`,
  });
  createProjectFixture(entryDir, {
    scaffold: false,
    programSource: `import { ctx } from "@trama-dev/runtime";
import { runProgram } from "@trama-dev/runtime/runner";
const worker = await runProgram({ projectDir: ${JSON.stringify(workerDir)}, workspaceDir: ${JSON.stringify(wsDir)}, label: "worker", maxRepairAttempts: 0, timeout: 30000 });
await ctx.done({ worker: worker.status });`,
  });

  // The program's own work takes a moment; its participant, under its own
  // timeout, takes seven seconds. Only the first counts against these five.
  const result = await runProgram({ projectDir: entryDir, maxRepairAttempts: 0, timeout: 5_000 });
  assert.equal(result.status, "done", result.reason);
  assert.deepEqual(result.result, { worker: "done" });
});

test("participants do not outlive the program that spawned them", async (t) => {
  const entryDir = makeTempDir("trama-session-entry-");
  const workerDir = makeTempDir("trama-session-worker-");
  const signalDir = makeTempDir("trama-session-signal-");
  t.after(() => { cleanupTempDir(entryDir); cleanupTempDir(workerDir); cleanupTempDir(signalDir); });

  // A participant that never finishes, with a shell command of its own still running.
  createProjectFixture(workerDir, {
    programSource: `import { tools } from "@trama-dev/runtime";
import { writeFileSync } from "fs";
writeFileSync(${JSON.stringify(join(signalDir, "worker.pid"))}, String(process.pid));
await tools.shell("echo $$ > ${join(signalDir, "shell.pid")}; sleep 60", { timeout: 60000 });`,
  });
  // The program that spawned it crashes once the participant is well under way.
  createProjectFixture(entryDir, {
    scaffold: false,
    programSource: `import { existsSync } from "fs";
import { runProgram } from "@trama-dev/runtime/runner";
void runProgram({ projectDir: ${JSON.stringify(workerDir)}, workspaceDir: ${JSON.stringify(join(signalDir, "workspace"))}, label: "worker", maxRepairAttempts: 0, timeout: 60000 }).catch(() => {});
while (!existsSync(${JSON.stringify(join(signalDir, "shell.pid"))})) await new Promise(resolve => setTimeout(resolve, 25));
throw new Error("the entry program crashes");`,
  });

  const result = await runProgram({ projectDir: entryDir, maxRepairAttempts: 0, timeout: 30_000 });
  assert.equal(result.status, "failed");
  assert.match(result.reason, /the entry program crashes/);

  const pids = ["worker.pid", "shell.pid"].map(name => pidIn(join(signalDir, name)));
  await waitFor(() => !pids.some(isAlive), "the participant and its shell command to be gone", 5_000);
});

test("stopping the runner stops the participants of its program, and what they started", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  const entryDir = makeTempDir("trama-session-entry-");
  const workerDir = makeTempDir("trama-session-worker-");
  const signalDir = makeTempDir("trama-session-signal-");
  t.after(() => { for (const dir of [fakeHome, entryDir, workerDir, signalDir]) cleanupTempDir(dir); });

  // Three levels down from the runner that gets stopped: its program, that
  // program's participant, and the participant's shell command.
  createProjectFixture(workerDir, {
    programSource: `import { tools } from "@trama-dev/runtime";
import { writeFileSync } from "fs";
writeFileSync(${JSON.stringify(join(signalDir, "worker.pid"))}, String(process.pid));
await tools.shell("echo $$ > ${join(signalDir, "shell.pid")}; sleep 60", { timeout: 60000 });`,
  });
  createProjectFixture(entryDir, {
    scaffold: false,
    programSource: `import { ctx } from "@trama-dev/runtime";
import { writeFileSync } from "fs";
import { runProgram } from "@trama-dev/runtime/runner";
writeFileSync(${JSON.stringify(join(signalDir, "entry.pid"))}, String(process.pid));
await runProgram({ projectDir: ${JSON.stringify(workerDir)}, workspaceDir: ${JSON.stringify(join(signalDir, "workspace"))}, label: "worker", maxRepairAttempts: 0, timeout: 60000 });
await ctx.done();`,
  });

  // A runner in a process of its own, stopped the way Ctrl-C stops `trama run`.
  const { child, exited } = startRunnerProcess(fakeHome, entryDir);
  const pidFiles = ["entry.pid", "worker.pid", "shell.pid"].map(name => join(signalDir, name));
  await waitFor(() => pidFiles.every(pidIn), "the participant to get as far as its shell command", 20_000);
  const pids = pidFiles.map(pidIn);
  assert.equal(pids.every(isAlive), true, "all three should be running");

  child.kill("SIGINT");
  await exited;

  await waitFor(() => !pids.some(isAlive), "everything the runner's program started to be gone", 5_000);
});

// --- One runner for the whole tree ---

test("stopping the runner stops participants even when the program that spawned them cannot act", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  const entryDir = makeTempDir("trama-session-entry-");
  const workerDir = makeTempDir("trama-session-worker-");
  const signalDir = makeTempDir("trama-session-signal-");
  t.after(() => { for (const dir of [fakeHome, entryDir, workerDir, signalDir]) cleanupTempDir(dir); });

  createProjectFixture(workerDir, {
    programSource: `import { tools } from "@trama-dev/runtime";
import { writeFileSync } from "fs";
writeFileSync(${JSON.stringify(join(signalDir, "worker.pid"))}, String(process.pid));
await tools.shell("echo $$ > ${join(signalDir, "shell.pid")}; sleep 60", { timeout: 60000 });`,
  });
  // Once its participant is under way, the program stops responding altogether:
  // it will not run a signal handler, and has to be killed in the end. Its
  // participant does not depend on it for being stopped.
  createProjectFixture(entryDir, {
    scaffold: false,
    programSource: `import { existsSync, writeFileSync } from "fs";
import { runProgram } from "@trama-dev/runtime/runner";
process.on("SIGTERM", () => {});
writeFileSync(${JSON.stringify(join(signalDir, "entry.pid"))}, String(process.pid));
void runProgram({ projectDir: ${JSON.stringify(workerDir)}, workspaceDir: ${JSON.stringify(join(signalDir, "workspace"))}, label: "worker", maxRepairAttempts: 0, timeout: 60000 }).catch(() => {});
while (!existsSync(${JSON.stringify(join(signalDir, "shell.pid"))})) await new Promise(resolve => setTimeout(resolve, 20));
writeFileSync(${JSON.stringify(join(signalDir, "entry-is-stuck"))}, "");
while (true) {}`,
  });

  const { child, exited } = startRunnerProcess(fakeHome, entryDir);
  await waitFor(() => existsSync(join(signalDir, "entry-is-stuck")) && pidIn(join(signalDir, "shell.pid")), "the participant to be under way", 20_000);
  const entryPid = pidIn(join(signalDir, "entry.pid"));
  const others = ["worker.pid", "shell.pid"].map(name => pidIn(join(signalDir, name)));

  child.kill("SIGINT");
  await exited;

  // The participant and its shell command go at once; the stuck program only when it is killed.
  await waitFor(() => !others.some(isAlive), "the participant and its shell command to be gone", 2_500);
  await waitFor(() => !isAlive(entryPid), "the stuck program to be killed", 12_000);
});

test("a run a program asked for is stopped when the one who asked is gone", { timeout: 40_000 }, async (t) => {
  const entryDir = makeTempDir("trama-session-entry-");
  const workerDir = makeTempDir("trama-session-worker-");
  const signalDir = makeTempDir("trama-session-signal-");
  t.after(() => { cleanupTempDir(entryDir); cleanupTempDir(workerDir); cleanupTempDir(signalDir); });

  createProjectFixture(workerDir, {
    programSource: `import { writeFileSync } from "fs";
writeFileSync(${JSON.stringify(join(signalDir, "worker.pid"))}, String(process.pid));
setInterval(() => {}, 1000);
await new Promise(() => {});`,
  });
  // The program has a process of its own ask for the run, kills that process
  // outright once the run is going, and then hangs. Nobody tells the runner
  // the run is no longer wanted: the asker's connection closing has to do.
  const asker = `import { runProgram } from ${JSON.stringify(RUNNER_SURFACE_URL)};
await runProgram({ projectDir: ${JSON.stringify(workerDir)}, maxRepairAttempts: 0, timeout: 60000 });`;
  createProjectFixture(entryDir, {
    scaffold: false,
    programSource: `import { spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
const workerPid = ${JSON.stringify(join(signalDir, "worker.pid"))};
const asker = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(asker)}], { stdio: "ignore" });
while (!existsSync(workerPid) || !readFileSync(workerPid, "utf-8")) await new Promise(resolve => setTimeout(resolve, 20));
asker.kill("SIGKILL");
const alive = () => { try { process.kill(Number(readFileSync(workerPid, "utf-8")), 0); return true; } catch { return false; } };
while (alive()) await new Promise(resolve => setTimeout(resolve, 20));
writeFileSync(${JSON.stringify(join(signalDir, "worker-was-stopped"))}, "");
setInterval(() => {}, 1000);
await new Promise(() => {});`,
  });

  const result = await runProgram({ projectDir: entryDir, maxRepairAttempts: 0, timeout: 3_000 });

  assert.equal(existsSync(join(signalDir, "worker-was-stopped")), true, "the run must be stopped once nobody waits for it");
  // ...and with it gone, the program's clock runs again.
  assert.equal(result.status, "failed");
  assert.match(result.reason, /timeout/);
});

test("programs that run programs without end are refused", { timeout: 60_000 }, async (t) => {
  const projectDir = makeTempDir("trama-session-");
  const signalDir = makeTempDir("trama-session-signal-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(signalDir); });

  // A program that runs itself, noting how deep it is each time.
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { ctx } from "@trama-dev/runtime";
import { runProgram } from "@trama-dev/runtime/runner";
import { appendFileSync } from "fs";
const depth = ctx.input.args.depth ?? 0;
const log = ${JSON.stringify(join(signalDir, "depths.txt"))};
appendFileSync(log, "depth " + depth + "\\n");
try {
  await runProgram({ projectDir: process.cwd(), args: { depth: depth + 1 }, maxRepairAttempts: 0, timeout: 60000 });
} catch (err) {
  appendFileSync(log, "refused: " + err.message + "\\n");
}
await ctx.done();`,
  });

  const result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 60_000 });
  assert.equal(result.status, "done");

  const lines = readFileSync(join(signalDir, "depths.txt"), "utf-8").trim().split("\n");
  const refusals = lines.filter(line => line.startsWith("refused"));
  assert.equal(refusals.length, 1, "exactly one run should have been refused");
  assert.match(refusals[0], /more than 16 deep/);
  assert.equal(lines.filter(line => line.startsWith("depth")).length, 17, "the runs at depths 0 to 16 ran");
});

test("a field a program leaves out by giving null is left out, inside a program as outside one", async (t) => {
  const entryDir = makeTempDir("trama-session-entry-");
  const workerDir = makeTempDir("trama-session-worker-");
  t.after(() => { cleanupTempDir(entryDir); cleanupTempDir(workerDir); });

  // workspace.* must stay unavailable: null is not a workspace.
  createProjectFixture(workerDir, {
    programSource: `import { ctx, workspace } from "@trama-dev/runtime";
const hasWorkspace = await workspace.list("*").then(() => true, () => false);
await ctx.done({ args: ctx.input.args, hasWorkspace });`,
  });
  createProjectFixture(entryDir, {
    programSource: `import { ctx } from "@trama-dev/runtime";
import { runProgram } from "@trama-dev/runtime/runner";
const result = await runProgram({
  projectDir: ${JSON.stringify(workerDir)}, maxRepairAttempts: 0, timeout: 20000,
  label: null, workspaceDir: null, args: null,
});
await ctx.done(result);`,
  });

  const options = { maxRepairAttempts: 0, timeout: 30_000 };
  const outside = await runProgram({ projectDir: workerDir, ...options, label: null, workspaceDir: null, args: null });
  const inside = await runProgram({ projectDir: entryDir, ...options });
  assert.deepEqual(outside, { status: "done", result: { args: {}, hasWorkspace: false } });
  assert.deepEqual(inside, { status: "done", result: outside });
});

test("a participant's output is shown under its name, and is not its parent's output", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  const entryDir = makeTempDir("trama-session-entry-");
  const workerDir = makeTempDir("trama-session-worker-");
  const wsDir = makeTempDir("trama-session-ws-");
  t.after(() => { for (const dir of [fakeHome, entryDir, workerDir, wsDir]) cleanupTempDir(dir); });

  createProjectFixture(workerDir, {
    programSource: `import { ctx } from "@trama-dev/runtime";
console.log("hello from the participant");
await ctx.log("checking");
process.stdout.write("and a last line without a newline");
await ctx.done();`,
  });
  // The program that spawned it fails afterwards — so what it is reported to have printed can be checked.
  createProjectFixture(entryDir, {
    scaffold: false,
    programSource: `import { runProgram } from "@trama-dev/runtime/runner";
await runProgram({ projectDir: ${JSON.stringify(workerDir)}, workspaceDir: ${JSON.stringify(wsDir)}, label: "scout", maxRepairAttempts: 0, timeout: 20000 });
console.log("the entry program's own line");
throw new Error("the entry program fails");`,
  });

  const runnerUrl = pathToFileURL(join(REPO_ROOT, "packages", "runtime", "dist", "runner.js")).href;
  const { stdout } = await runNodeCommand(["--input-type=module", "-e",
    `import { runProgram } from ${JSON.stringify(runnerUrl)};
const result = await runProgram({ projectDir: ${JSON.stringify(entryDir)}, maxRepairAttempts: 0, timeout: 30_000 });
console.log("REASON " + JSON.stringify(result.reason));`,
  ], { env: { ...process.env, HOME: fakeHome } });

  assert.match(stdout, /^\[scout\] hello from the participant$/m);
  assert.match(stdout, /^\[scout\] and a last line without a newline$/m);
  assert.match(stdout, /^\[scout\] \[trama\] checking$/m, "what the runner prints for a participant is under its name too");
  assert.match(stdout, /^the entry program's own line$/m);
  const reason = stdout.split("\n").find(line => line.startsWith("REASON "));
  assert.match(reason, /the entry program's own line/);
  assert.doesNotMatch(reason, /hello from the participant/, "a participant's output must not be reported as its parent's");
});

test("inside a program, a workspace and a run are what they are outside one", { timeout: 40_000 }, async (t) => {
  const entryDir = makeTempDir("trama-session-entry-");
  const workerDir = makeTempDir("trama-session-worker-");
  const signalDir = makeTempDir("trama-session-signal-");
  t.after(() => { cleanupTempDir(entryDir); cleanupTempDir(workerDir); cleanupTempDir(signalDir); });

  createProjectFixture(workerDir, {
    programSource: `import { writeFileSync } from "fs";
writeFileSync(${JSON.stringify(join(signalDir, "worker.pid"))}, String(process.pid));
setInterval(() => {}, 1000);
await new Promise(() => {});`,
  });
  // Two things a program may rely on, which now happen through its runner:
  // the workspace's directory exists as soon as the program has the workspace, and stopping
  // a run with a signal ends in a result — once the run is really over.
  createProjectFixture(entryDir, {
    scaffold: false,
    programSource: `import { ctx } from "@trama-dev/runtime";
import { createWorkspace, runProgram } from "@trama-dev/runtime/runner";
import { existsSync, readFileSync } from "fs";
const workspaceDir = ${JSON.stringify(join(signalDir, "ws", "nested"))};
createWorkspace(workspaceDir);
const workspaceExists = existsSync(workspaceDir);

const workerPid = ${JSON.stringify(join(signalDir, "worker.pid"))};
const stop = new AbortController();
const run = runProgram({ projectDir: ${JSON.stringify(workerDir)}, maxRepairAttempts: 0, timeout: 60000, signal: stop.signal });
while (!existsSync(workerPid) || !readFileSync(workerPid, "utf-8")) await new Promise(resolve => setTimeout(resolve, 20));
stop.abort();
const stopped = await run;
let workerAlive = true;
try { process.kill(Number(readFileSync(workerPid, "utf-8")), 0); } catch { workerAlive = false; }

const alreadyStopped = await runProgram({ projectDir: ${JSON.stringify(workerDir)}, maxRepairAttempts: 0, signal: stop.signal });
await ctx.done({ workspaceExists, stopped, workerAlive, alreadyStopped });`,
  });

  const result = await runProgram({ projectDir: entryDir, maxRepairAttempts: 0, timeout: 30_000 });
  assert.equal(result.status, "done", result.reason);
  const stoppedRun = { status: "failed", reason: "The run was stopped before it finished." };
  assert.deepEqual(result.result, {
    workspaceExists: true,
    stopped: stoppedRun,
    workerAlive: false,
    alreadyStopped: stoppedRun,
  });
});

test("a run among others is given variables as any run is: its program has them, and the commands it runs — and what is given for them and is none is the run's failing to start, not thrown at whoever asked", async (t) => {
  const workerDir = makeTempDir("trama-session-worker-"), wsDir = makeTempDir("trama-session-ws-");
  t.after(() => { cleanupTempDir(workerDir); cleanupTempDir(wsDir); });
  createProjectFixture(workerDir, {
    programSource: `import { ctx, tools } from "@trama-dev/runtime";
const said = await tools.shell('printf %s "$ROLE"');
await ctx.done({ own: process.env.ROLE ?? null, command: said.stdout });`,
  });

  const given = await start("reviewer", wsDir, { projectDir: workerDir, env: { ROLE: "reviewer" }, maxRepairAttempts: 0, timeout: 20_000 });
  assert.deepEqual(given, { status: "done", result: { own: "reviewer", command: "reviewer" } });
  const plain = await start("nobody", wsDir, { projectDir: workerDir, maxRepairAttempts: 0, timeout: 20_000 });
  assert.deepEqual(plain, { status: "done", result: { own: null, command: "" } });

  // What is given for variables and is no object of them is refused for what it is, not taken apart into some.
  for (const env of [["ROLE=x"], "ab", 5]) {
    await assert.rejects(() => start("worker", wsDir, { projectDir: workerDir, env, maxRepairAttempts: 0, timeout: 20_000 }), /env is an object of variables/);
  }
  // And what cannot be read at all is told the same way: by the run's promise, as any failing to start is.
  const unreadable = { get ROLE() { throw new Error("thrown by the caller's getter"); } };
  await assert.rejects(() => start("worker", wsDir, { projectDir: workerDir, env: unreadable, maxRepairAttempts: 0, timeout: 20_000 }), /thrown by the caller's getter/);
});
