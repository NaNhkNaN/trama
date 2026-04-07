import assert from "node:assert/strict";
import test from "node:test";
import { join } from "path";
import { Session } from "../packages/session/dist/index.js";
import { cleanupTempDir, createProjectFixture, makeTempDir } from "./helpers.mjs";

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
