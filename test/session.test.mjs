import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { runProgram } from "../packages/runtime/dist/runner.js";
import { Session } from "../packages/session/dist/index.js";
import { cleanupTempDir, createProjectFixture, makeTempDir, withEnv } from "./helpers.mjs";

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
