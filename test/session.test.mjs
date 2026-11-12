import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { runProgram } from "../packages/runtime/dist/runner.js";
import { Session } from "../packages/session/dist/index.js";
import { pathToFileURL } from "url";
import {
  REPO_ROOT, cleanupTempDir, createProjectFixture, isAlive, makeTempDir, pidIn, runNodeCommand, startRunnerProcess,
  waitFor, withEnv,
} from "./helpers.mjs";

/** The runner as a program reaches it: the public surface, not the module the tests call directly. */
const RUNNER_SURFACE_URL = pathToFileURL(join(REPO_ROOT, "packages", "runtime", "dist", "index.js")).href;

test("Session.spawn returns done ProgramResult", async (t) => {
  const projectDir = makeTempDir("trama-session-");
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(wsDir); });
  createProjectFixture(projectDir, {
    programSource: `import { ctx } from "@trama-dev/runtime";
await ctx.done({ ok: true });
`,
  });

  const session = await Session.create({ workspace: wsDir });
  const handle = session.spawn("test-agent", { projectDir, maxRepairAttempts: 0, timeout: 5_000 });
  const result = await handle.wait();

  assert.equal(result.status, "done");
  assert.deepEqual(result.result, { ok: true });
});

test("Session.spawn returns yielded ProgramResult", async (t) => {
  const projectDir = makeTempDir("trama-session-");
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(wsDir); });
  createProjectFixture(projectDir, {
    programSource: `import { ctx } from "@trama-dev/runtime";
await ctx.yield("waiting");
`,
  });

  const session = await Session.create({ workspace: wsDir });
  const handle = session.spawn("test-agent", { projectDir, maxRepairAttempts: 0, timeout: 5_000 });
  const result = await handle.wait();

  assert.equal(result.status, "yielded");
  assert.equal(result.reason, "waiting");
});

test("Session.spawn returns failed ProgramResult (not throw)", async (t) => {
  const projectDir = makeTempDir("trama-session-");
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(wsDir); });
  createProjectFixture(projectDir, {
    programSource: `throw new Error("boom");`,
  });

  const session = await Session.create({ workspace: wsDir });
  const handle = session.spawn("test-agent", { projectDir, maxRepairAttempts: 0, timeout: 5_000 });
  const result = await handle.wait();

  assert.equal(result.status, "failed");
  assert.match(result.reason, /boom/);
});

test("ParticipantHandle.resume works after yield", async (t) => {
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

  const session = await Session.create({ workspace: wsDir });
  const handle = session.spawn("test-agent", { projectDir, maxRepairAttempts: 0, timeout: 5_000 });

  const first = await handle.wait();
  assert.equal(first.status, "yielded");

  await handle.resume();
  const second = await handle.wait();
  assert.equal(second.status, "done");

  // Verify workspace artifact was written during resumed run
  const { readFileSync } = await import("fs");
  assert.equal(readFileSync(join(wsDir, "result.txt"), "utf-8"), "step=1");
});

test("ParticipantHandle.resume rejects when participant is done", async (t) => {
  const projectDir = makeTempDir("trama-session-");
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(wsDir); });
  createProjectFixture(projectDir, {
    programSource: `import { ctx } from "@trama-dev/runtime";
await ctx.done();
`,
  });

  const session = await Session.create({ workspace: wsDir });
  const handle = session.spawn("test-agent", { projectDir, maxRepairAttempts: 0, timeout: 5_000 });

  await handle.wait();

  await assert.rejects(
    () => handle.resume(),
    /Cannot resume.*expected state "yielded" but got "done"/,
  );
});

test("ParticipantHandle.resume rejects when participant is failed", async (t) => {
  const projectDir = makeTempDir("trama-session-");
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(wsDir); });
  createProjectFixture(projectDir, {
    programSource: `throw new Error("broken");`,
  });

  const session = await Session.create({ workspace: wsDir });
  const handle = session.spawn("test-agent", { projectDir, maxRepairAttempts: 0, timeout: 5_000 });

  await handle.wait();

  await assert.rejects(
    () => handle.resume(),
    /Cannot resume.*expected state "yielded" but got "failed"/,
  );
});

test("ParticipantHandle.resume rejects immediately when participant is still running", async (t) => {
  const projectDir = makeTempDir("trama-session-");
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(wsDir); });
  createProjectFixture(projectDir, {
    programSource: `import { ctx, tools } from "@trama-dev/runtime";
await tools.shell("sleep 5");
await ctx.done();
`,
  });

  const session = await Session.create({ workspace: wsDir });
  const handle = session.spawn("test-agent", { projectDir, maxRepairAttempts: 0, timeout: 10_000 });

  // resume() should reject immediately without blocking on the running program
  const start = Date.now();
  await assert.rejects(
    () => handle.resume(),
    /Cannot resume.*expected state "yielded" but got "running"/,
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1_000, `resume() should be fail-fast, took ${elapsed}ms`);

  // Clean up: wait for the spawned run to finish
  await handle.wait();
});

test("Session.spawn shares workspace between participants", async (t) => {
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

  const session = await Session.create({ workspace: wsDir });

  // Agent 1 writes to workspace
  const handle1 = session.spawn("agent1", { projectDir: projectDir1, maxRepairAttempts: 0, timeout: 5_000 });
  await handle1.wait();

  // Agent 2 reads from workspace
  const handle2 = session.spawn("agent2", { projectDir: projectDir2, maxRepairAttempts: 0, timeout: 5_000 });
  const result2 = await handle2.wait();
  assert.equal(result2.status, "done");

  const { readFileSync } = await import("fs");
  assert.equal(readFileSync(join(wsDir, "from-agent2.txt"), "utf-8"), "got: hello from agent 1");
});

test("Session.workspace lets the session's creator exchange artifacts with participants", async (t) => {
  const projectDir = makeTempDir("trama-session-");
  const wsDir = makeTempDir("trama-session-ws-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(wsDir); });

  createProjectFixture(projectDir, {
    programSource: `import { ctx, workspace } from "@trama-dev/runtime";
const question = await workspace.observe("question.txt", { timeout: 5000 });
await workspace.write("answer.txt", question.toUpperCase());
await ctx.done();`,
  });

  const session = await Session.create({ workspace: wsDir });
  assert.equal(session.workspaceDir, wsDir);

  const handle = session.spawn("echo", { projectDir, maxRepairAttempts: 0, timeout: 10_000 });
  await session.workspace.write("question.txt", "hello");
  const answer = await session.workspace.observe("answer.txt", { timeout: 10_000 });

  assert.equal(answer, "HELLO");
  assert.equal((await handle.wait()).status, "done");
  assert.deepEqual(await session.workspace.list("*.txt"), ["answer.txt", "question.txt"]);
});

test("Session expands a leading ~ in projectDir and workspace", async (t) => {
  const fakeHome = makeTempDir("trama-session-home-");
  t.after(() => cleanupTempDir(fakeHome));

  createProjectFixture(join(fakeHome, "projects", "tilde"), {
    programSource: `import { ctx, workspace } from "@trama-dev/runtime";
await workspace.write("seen.txt", "ok");
await ctx.done();`,
  });

  await withEnv({ HOME: fakeHome }, async () => {
    const session = await Session.create({ workspace: "~/shared" });
    assert.equal(session.workspaceDir, join(fakeHome, "shared"));

    const result = await session
      .spawn("tilde", { projectDir: "~/projects/tilde", maxRepairAttempts: 0, timeout: 10_000 })
      .wait();
    assert.equal(result.status, "done");
    assert.equal(readFileSync(join(fakeHome, "shared", "seen.txt"), "utf-8"), "ok");
  });
});

test("a program run by the runner can create a session and coordinate participants", async (t) => {
  const entryDir = makeTempDir("trama-session-entry-");
  const workerDir = makeTempDir("trama-session-worker-");
  let sessionWorkspace;
  t.after(() => {
    cleanupTempDir(entryDir);
    cleanupTempDir(workerDir);
    if (sessionWorkspace) cleanupTempDir(sessionWorkspace);
  });

  // The participant: reads the brief, writes its finding.
  createProjectFixture(workerDir, {
    programSource: `import { ctx, workspace } from "@trama-dev/runtime";
const brief = await workspace.observe("brief.txt", { timeout: 10000 });
await workspace.write("findings/" + ctx.input.args.check + ".txt", ctx.input.args.check + " checked: " + brief);
await ctx.done();`,
  });

  // The entry program: an ordinary program.ts that imports the session layer,
  // fans out to participants, and gathers what they wrote — no host code involved.
  createProjectFixture(entryDir, {
    scaffold: false,
    programSource: `import { ctx } from "@trama-dev/runtime";
import { Session } from "@trama-dev/session";

const session = await Session.createTemp();
const checks = ["sql", "xss"];
const handles = checks.map(check => session.spawn(check, {
  projectDir: ctx.input.args.workerDir,
  args: { check },
  maxRepairAttempts: 0,
  timeout: 20000,
}));
await session.workspace.write("brief.txt", "diff-42");
const findings = await session.workspace.observe("findings/*.txt", { expect: checks.length, timeout: 20000 });
const statuses = (await Promise.all(handles.map(h => h.wait()))).map(r => r.status);
await ctx.done({ workspaceDir: session.workspaceDir, statuses, findings });`,
  });

  const result = await runProgram({
    projectDir: entryDir, maxRepairAttempts: 0, timeout: 40_000, args: { workerDir },
  });

  assert.equal(result.status, "done", result.reason);
  sessionWorkspace = result.result.workspaceDir;
  assert.deepEqual(result.result.statuses, ["done", "done"]);
  assert.deepEqual(result.result.findings, [
    { path: "findings/sql.txt", content: "sql checked: diff-42" },
    { path: "findings/xss.txt", content: "xss checked: diff-42" },
  ]);
  assert.equal(existsSync(join(entryDir, "node_modules", "@trama-dev", "session")), true);
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
import { Session } from "@trama-dev/session";
const session = await Session.create({ workspace: ${JSON.stringify(wsDir)} });
const worker = await session.spawn("worker", { projectDir: ${JSON.stringify(workerDir)}, maxRepairAttempts: 0, timeout: 30000 }).wait();
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
import { Session } from "@trama-dev/session";
const session = await Session.create({ workspace: ${JSON.stringify(join(signalDir, "workspace"))} });
session.spawn("worker", { projectDir: ${JSON.stringify(workerDir)}, maxRepairAttempts: 0, timeout: 60000 });
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
import { Session } from "@trama-dev/session";
writeFileSync(${JSON.stringify(join(signalDir, "entry.pid"))}, String(process.pid));
const session = await Session.create({ workspace: ${JSON.stringify(join(signalDir, "workspace"))} });
await session.spawn("worker", { projectDir: ${JSON.stringify(workerDir)}, maxRepairAttempts: 0, timeout: 60000 }).wait();
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
import { Session } from "@trama-dev/session";
process.on("SIGTERM", () => {});
writeFileSync(${JSON.stringify(join(signalDir, "entry.pid"))}, String(process.pid));
const session = await Session.create({ workspace: ${JSON.stringify(join(signalDir, "workspace"))} });
session.spawn("worker", { projectDir: ${JSON.stringify(workerDir)}, maxRepairAttempts: 0, timeout: 60000 });
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
const inSession = await workspace.list("*").then(() => true, () => false);
await ctx.done({ args: ctx.input.args, inSession });`,
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
  assert.deepEqual(outside, { status: "done", result: { args: {}, inSession: false } });
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
    programSource: `import { Session } from "@trama-dev/session";
const session = await Session.create({ workspace: ${JSON.stringify(wsDir)} });
await session.spawn("scout", { projectDir: ${JSON.stringify(workerDir)}, maxRepairAttempts: 0, timeout: 20000 }).wait();
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

test("inside a program, a session is what it is outside one", { timeout: 40_000 }, async (t) => {
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
  // the workspace directory exists as soon as the session does, and stopping
  // a run with a signal ends in a result — once the run is really over.
  createProjectFixture(entryDir, {
    scaffold: false,
    programSource: `import { ctx } from "@trama-dev/runtime";
import { runProgram } from "@trama-dev/runtime/runner";
import { Session } from "@trama-dev/session";
import { existsSync, readFileSync } from "fs";
const workspace = ${JSON.stringify(join(signalDir, "ws", "nested"))};
const session = await Session.create({ workspace });
const workspaceExists = existsSync(session.workspaceDir);

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
