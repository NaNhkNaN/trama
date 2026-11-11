import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { llm } from "./fake-llm.mjs";
import { runProgram } from "../packages/runtime/dist/runner.js";
import { cleanupTempDir, createProjectFixture, makeTempDir, readJson, writeText } from "./helpers.mjs";

// --- ProgramResult from runProgram ---

test("runProgram returns ProgramResult with status done on success", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  const result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 });

  assert.equal(result.status, "done");
});

test("runProgram returns done result from ctx.done(result)", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    programSource: `import { ctx } from "@trama-dev/runtime";
await ctx.done({ answer: 42 });
`,
  });

  const result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 });

  assert.equal(result.status, "done");
  assert.deepEqual(result.result, { answer: 42 });
});

test("runProgram returns yielded status when program calls ctx.yield()", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    programSource: `import { ctx } from "@trama-dev/runtime";
ctx.state.progress = "halfway";
await ctx.yield("waiting for approval");
`,
  });

  const result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 });

  assert.equal(result.status, "yielded");
  assert.equal(result.reason, "waiting for approval");

  // Verify state was persisted
  const state = readJson(join(projectDir, "state.json"));
  assert.equal(state.progress, "halfway");
  assert.deepEqual(state.__trama_yield, { reason: "waiting for approval" });
});

test("runProgram resumed program sees ctx.resumed=true and ctx.yieldReason", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    programSource: `import { ctx, tools } from "@trama-dev/runtime";
if (!ctx.resumed) {
  ctx.state.step = "first";
  await ctx.yield("need input");
}
// This code runs on the second invocation (after resume)
await tools.write("resume-info.json", JSON.stringify({
  resumed: ctx.resumed,
  yieldReason: ctx.yieldReason,
  step: ctx.state.step,
}));
await ctx.done();
`,
  });

  // First run: should yield
  const first = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 });
  assert.equal(first.status, "yielded");
  assert.equal(first.reason, "need input");

  // Second run: should resume and complete
  const second = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 });
  assert.equal(second.status, "done");

  // Verify the resumed program saw the correct context
  const info = readJson(join(projectDir, "resume-info.json"));
  assert.equal(info.resumed, true);
  assert.equal(info.yieldReason, "need input");
  assert.equal(info.step, "first");
});

test("runProgram clears stale yield marker on natural success without terminal signal", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    programSource: `import { ctx } from "@trama-dev/runtime";
// Program exits naturally without calling done() or yield()
`,
    // Pre-seed state with a stale yield marker
    state: {
      __trama_iteration: 1,
      __trama_yield: { reason: "stale" },
    },
  });

  const result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 });
  assert.equal(result.status, "done");

  // Stale yield marker should be cleared
  const state = readJson(join(projectDir, "state.json"));
  assert.equal(state.__trama_yield, undefined);
});

test("runProgram returns failed ProgramResult for program-level failures (not throw)", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    programSource: `throw new Error("intentional failure");`,
  });

  const result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 });

  assert.equal(result.status, "failed");
  assert.match(result.reason, /intentional failure/);
});

test("runProgram yield does not trigger repair loop", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    programSource: `import { ctx } from "@trama-dev/runtime";
await ctx.yield("pausing");
`,
  });

  // If yield triggered repair, this would fail or take much longer
  const result = await runProgram({ projectDir, maxRepairAttempts: 3, timeout: 5_000 });
  assert.equal(result.status, "yielded");
});

test("runProgram done marker takes precedence over exit code", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    programSource: `import { ctx } from "@trama-dev/runtime";
await ctx.done({ completed: true });
// Throw after done — done marker should still take precedence
throw new Error("post-done error");
`,
  });

  // The done marker was persisted before the throw, so status should be "done"
  const result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 });
  assert.equal(result.status, "done");
  assert.deepEqual(result.result, { completed: true });
});

// --- Workspace integration via runProgram ---

test("runProgram with workspaceDir enables workspace API", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(wsDir); });
  createProjectFixture(projectDir, {
    programSource: `import { ctx, workspace } from "@trama-dev/runtime";
await workspace.write("output/result.json", JSON.stringify({ status: "ok" }));
const content = await workspace.read("output/result.json");
await ctx.done({ read: JSON.parse(content) });
`,
  });

  const result = await runProgram({
    projectDir,
    maxRepairAttempts: 0,
    timeout: 5_000,
    workspaceDir: wsDir,
  });

  assert.equal(result.status, "done");
  assert.deepEqual(result.result, { read: { status: "ok" } });
  // Verify file exists in workspace
  assert.ok(existsSync(join(wsDir, "output", "result.json")));
});

test("runProgram without workspaceDir makes workspace API throw", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    programSource: `import { ctx, workspace } from "@trama-dev/runtime";
try {
  await workspace.read("anything.txt");
  await ctx.done({ error: "should have thrown" });
} catch (err) {
  await ctx.done({ error: err.message });
}
`,
  });

  const result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 });
  assert.equal(result.status, "done");
  assert.match(result.result.error, /only available when running in a session/);
});

test("runProgram yield then done mutual exclusivity works end-to-end", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    programSource: `import { ctx, tools } from "@trama-dev/runtime";
try {
  await ctx.yield("pausing");
} catch (e) {
  // yield exits the process, so this won't run in normal flow
}
// This code won't execute because yield calls process.exit(0)
await tools.write("should-not-exist.txt", "bad");
`,
  });

  const result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 });
  assert.equal(result.status, "yielded");
  // File should not exist because process exited after yield
  assert.equal(existsSync(join(projectDir, "should-not-exist.txt")), false);
});

test("runProgram refuses yield after done — the runner enforces it, not the client", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    programSource: `import { ctx, tools } from "@trama-dev/runtime";
await ctx.done({ final: true });
try {
  await ctx.yield("too late");
  await tools.write("verdict.txt", "yield was accepted");
} catch (err) {
  await tools.write("verdict.txt", err.message);
}
`,
  });

  const result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 });
  assert.equal(result.status, "done");
  assert.deepEqual(result.result, { final: true });
  assert.match(
    readFileSync(join(projectDir, "verdict.txt"), "utf-8"),
    /Cannot call ctx\.yield\(\) after ctx\.done\(\)/,
  );
  assert.equal(readJson(join(projectDir, "state.json")).__trama_yield, undefined);
});

test("runProgram keeps the program's ctx.iteration in step with the runner", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    state: { __trama_iteration: 5 },
    programSource: `import { ctx, tools } from "@trama-dev/runtime";
const seen = [ctx.iteration];
await ctx.checkpoint(); seen.push(ctx.iteration);
await ctx.checkpoint(); seen.push(ctx.iteration);
await ctx.done();       seen.push(ctx.iteration);
// A repeated done() is a no-op: it must not advance the counter again.
await ctx.done();       seen.push(ctx.iteration);
await Promise.all([ctx.ready(), ctx.ready()]);
await tools.write("iterations.txt", seen.join(","));
`,
  });

  const result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 });
  assert.equal(result.status, "done");
  assert.equal(readFileSync(join(projectDir, "iterations.txt"), "utf-8"), "5,6,7,8,8");
  assert.equal(readJson(join(projectDir, "state.json")).__trama_iteration, 8);
  const readyLogs = readFileSync(join(projectDir, "logs", "latest.jsonl"), "utf-8")
    .trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.message === "ready");
  assert.equal(readyLogs.length, 1, "ready must be recorded once however often it is called");
});

// --- Repair workspace isolation ---

// Several tests below need "another participant" to touch the shared workspace
// while a repaired program is running — after the runner has staged the
// workspace, before it commits. Rather than guess when that is, the repaired
// program announces that it has started and waits to be released, and the test
// acts in between.

// A fix runs on a private copy of the project, so the two sides meet in a
// directory of their own, named after the project.
const signalDirFor = (projectDir) => `${projectDir}.signals`;

/** Source for a repaired program: announce the run and pause until released. */
function pauseRepairRun(projectDir) {
  const signalDir = signalDirFor(projectDir);
  return `import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
mkdirSync(${JSON.stringify(signalDir)}, { recursive: true });
writeFileSync(${JSON.stringify(join(signalDir, "started"))}, "");
while (!existsSync(${JSON.stringify(join(signalDir, "proceed"))})) await new Promise(r => setTimeout(r, 20));
rmSync(${JSON.stringify(signalDir)}, { recursive: true, force: true });`;
}

/** Wait for the repaired program to pause, run `act`, then let it continue. */
async function duringRepairRun(projectDir, act) {
  const signalDir = signalDirFor(projectDir);
  const deadline = Date.now() + 9_000;
  while (!existsSync(join(signalDir, "started"))) {
    if (Date.now() > deadline) throw new Error("the repaired program never started");
    await new Promise(r => setTimeout(r, 20));
  }
  act();
  writeText(join(signalDir, "proceed"), "");
}

test("a repair that fails leaves the shared workspace as it was", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(wsDir); });

  // Seed workspace with a pre-existing artifact
  writeText(join(wsDir, "existing.txt"), "keep me");

  createProjectFixture(projectDir, {
    programSource: `throw new Error("original failure");`,
  });

  const originalRepair = llm.repair;
  llm.repair = async function repair() {
    // The repaired program writes an artifact and then fails as well.
    return `import { workspace } from "@trama-dev/runtime";
await workspace.write("artifact.txt", "from repair");
throw new Error("repair also fails");`;
  };

  try {
    const result = await runProgram({
      projectDir, maxRepairAttempts: 1, timeout: 5_000, workspaceDir: wsDir,
    });
    assert.equal(result.status, "failed");
    // What the failed repair wrote must not reach the shared workspace
    assert.equal(existsSync(join(wsDir, "artifact.txt")), false,
      "a failed repair must not leave workspace artifacts");
    // Pre-existing artifacts must survive
    assert.equal(readFileSync(join(wsDir, "existing.txt"), "utf-8"), "keep me");
  } finally {
    llm.repair = originalRepair;
  }
});

test("a failed repair run preserves concurrent workspace writes from other participants", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(wsDir); });

  createProjectFixture(projectDir, {
    programSource: `throw new Error("original failure");`,
  });

  const originalRepair = llm.repair;
  llm.repair = async function repair() {
    // The repaired program waits for the concurrent write and then crashes.
    return `${pauseRepairRun(projectDir)}
throw new Error("crash after concurrent write window");`;
  };

  try {
    const runPromise = runProgram({
      projectDir, maxRepairAttempts: 1, timeout: 10_000, workspaceDir: wsDir,
    });

    await duringRepairRun(projectDir, () => {
      writeText(join(wsDir, "concurrent.txt"), "from another participant");
    });

    const result = await runPromise;
    assert.equal(result.status, "failed");
    // Concurrent write from another participant must still be there after the failed fix
    assert.equal(readFileSync(join(wsDir, "concurrent.txt"), "utf-8"), "from another participant");
  } finally {
    llm.repair = originalRepair;
  }
});

test("successful repair commit does not overwrite concurrent workspace updates (disjoint paths)", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(wsDir); });

  // Seed workspace with a file that another participant will update concurrently
  writeText(join(wsDir, "shared.txt"), "seed");

  createProjectFixture(projectDir, {
    programSource: `throw new Error("original failure");`,
  });

  const originalRepair = llm.repair;
  llm.repair = async function repair() {
    return `import { ctx, workspace } from "@trama-dev/runtime";
${pauseRepairRun(projectDir)}
await workspace.write("new-artifact.txt", "from repair");
await ctx.done();`;
  };

  try {
    const runPromise = runProgram({
      projectDir, maxRepairAttempts: 1, timeout: 10_000, workspaceDir: wsDir,
    });

    await duringRepairRun(projectDir, () => {
      writeText(join(wsDir, "shared.txt"), "updated-by-other");
    });

    const result = await runPromise;
    assert.equal(result.status, "done");
    assert.equal(readFileSync(join(wsDir, "new-artifact.txt"), "utf-8"), "from repair");
    assert.equal(readFileSync(join(wsDir, "shared.txt"), "utf-8"), "updated-by-other");
  } finally {
    llm.repair = originalRepair;
  }
});

test("successful repair commit does not overwrite concurrent update on same path", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(wsDir); });

  // Both the repair and another participant will write to shared.txt
  writeText(join(wsDir, "shared.txt"), "seed");

  createProjectFixture(projectDir, {
    programSource: `throw new Error("original failure");`,
  });

  const originalRepair = llm.repair;
  llm.repair = async function repair() {
    // Repaired program modifies shared.txt (same file another participant will update)
    return `import { ctx, workspace } from "@trama-dev/runtime";
${pauseRepairRun(projectDir)}
await workspace.write("shared.txt", "from-repair");
await ctx.done();`;
  };

  try {
    const runPromise = runProgram({
      projectDir, maxRepairAttempts: 1, timeout: 10_000, workspaceDir: wsDir,
    });

    // While the rerun holds its staged copy, another participant updates shared.txt
    await duringRepairRun(projectDir, () => {
      writeText(join(wsDir, "shared.txt"), "updated-by-other");
    });

    const result = await runPromise;
    assert.equal(result.status, "done");
    // The concurrent update must be preserved — repair's stale write must be skipped
    assert.equal(readFileSync(join(wsDir, "shared.txt"), "utf-8"), "updated-by-other");
  } finally {
    llm.repair = originalRepair;
  }
});

test("successful repair commit does not overwrite concurrently created new path", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(wsDir); });

  // shared-new.txt does NOT exist at seed time — both sides create it during the rerun window
  createProjectFixture(projectDir, {
    programSource: `throw new Error("original failure");`,
  });

  const originalRepair = llm.repair;
  llm.repair = async function repair() {
    return `import { ctx, workspace } from "@trama-dev/runtime";
${pauseRepairRun(projectDir)}
await workspace.write("shared-new.txt", "from-repair");
await ctx.done();`;
  };

  try {
    const runPromise = runProgram({
      projectDir, maxRepairAttempts: 1, timeout: 10_000, workspaceDir: wsDir,
    });

    // While the rerun holds its staged copy, another participant creates the same new path
    await duringRepairRun(projectDir, () => {
      writeText(join(wsDir, "shared-new.txt"), "from-other");
    });

    const result = await runPromise;
    assert.equal(result.status, "done");
    // The other participant's version must be preserved
    assert.equal(readFileSync(join(wsDir, "shared-new.txt"), "utf-8"), "from-other");
  } finally {
    llm.repair = originalRepair;
  }
});

test("successful repair commit handles path-shape conflict gracefully", async (t) => {
  // Test commitStagedChanges directly to avoid timing fragility.
  // Simulate: repair wrote "nested/out.txt" in temp workspace, but another
  // participant created "nested" as a regular file in the real workspace.
  const { commitStagedChanges, snapshotDir } = await import("../packages/runtime/dist/runner.js");

  const tempDir = makeTempDir("trama-temp-ws-");
  const realDir = makeTempDir("trama-real-ws-");
  t.after(() => { cleanupTempDir(tempDir); cleanupTempDir(realDir); });

  // Take the "before" snapshot of the empty temp workspace
  const tempBefore = snapshotDir(tempDir);
  // Take the "seed" snapshot of the empty real workspace
  const realSeed = snapshotDir(realDir);

  // Simulate the rerun writing nested/out.txt in the temp workspace
  const { mkdirSync: mkdir } = await import("fs");
  mkdir(join(tempDir, "nested"), { recursive: true });
  writeText(join(tempDir, "nested", "out.txt"), "from-repair");

  // Simulate another participant creating "nested" as a regular file in real workspace
  writeText(join(realDir, "nested"), "i-am-a-file");

  // commitStagedChanges must not throw — it should skip the conflicting path
  commitStagedChanges(tempDir, realDir, tempBefore, realSeed);

  // The other participant's "nested" regular file must be preserved
  assert.equal(readFileSync(join(realDir, "nested"), "utf-8"), "i-am-a-file");
});

test("repair commit does not follow symlinks escaping workspace", async (t) => {
  // Test that commitStagedChanges respects the workspace bounded root
  // when a concurrent participant places a symlink pointing outside.
  const { commitStagedChanges, snapshotDir } = await import("../packages/runtime/dist/runner.js");
  const { symlinkSync } = await import("fs");

  const tempDir = makeTempDir("trama-temp-ws-");
  const realDir = makeTempDir("trama-real-ws-");
  const outsideDir = makeTempDir("trama-outside-");
  t.after(() => { cleanupTempDir(tempDir); cleanupTempDir(realDir); cleanupTempDir(outsideDir); });

  writeText(join(outsideDir, "target.txt"), "external-original");

  // Snapshots of both empty workspaces
  const tempBefore = snapshotDir(tempDir);
  const realSeed = snapshotDir(realDir);

  // Simulate the rerun writing escape.txt in the temp workspace
  writeText(join(tempDir, "escape.txt"), "from-repair");

  // Simulate another participant creating escape.txt as a symlink to an external file
  symlinkSync(join(outsideDir, "target.txt"), join(realDir, "escape.txt"));

  // commitStagedChanges must not follow the symlink and overwrite the external file
  commitStagedChanges(tempDir, realDir, tempBefore, realSeed);

  // The external file must NOT have been overwritten
  assert.equal(readFileSync(join(outsideDir, "target.txt"), "utf-8"), "external-original");
});

test("repair commit does not follow symlinked parent directory escaping workspace", async (t) => {
  const { commitStagedChanges, snapshotDir } = await import("../packages/runtime/dist/runner.js");
  const { symlinkSync } = await import("fs");

  const tempDir = makeTempDir("trama-temp-ws-");
  const realDir = makeTempDir("trama-real-ws-");
  const outsideDir = makeTempDir("trama-outside-");
  t.after(() => { cleanupTempDir(tempDir); cleanupTempDir(realDir); cleanupTempDir(outsideDir); });

  const tempBefore = snapshotDir(tempDir);
  const realSeed = snapshotDir(realDir);

  // Simulate the rerun writing reports/data.txt in the temp workspace
  const { mkdirSync: mkdir } = await import("fs");
  mkdir(join(tempDir, "reports"), { recursive: true });
  writeText(join(tempDir, "reports", "data.txt"), "from-repair");

  // Simulate another participant creating "reports" as a symlink to an external directory
  symlinkSync(outsideDir, join(realDir, "reports"));

  commitStagedChanges(tempDir, realDir, tempBefore, realSeed);

  // The external directory must NOT have a data.txt written into it
  assert.equal(existsSync(join(outsideDir, "data.txt")), false);
});

test("a successful repair runs the fixed program exactly once", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(wsDir); });
  createProjectFixture(projectDir, {
    programSource: `throw new Error("original failure");`,
  });

  const originalRepair = llm.repair;
  let repairCalls = 0;
  llm.repair = async function repair() {
    repairCalls += 1;
    // Each execution leaves one line behind, in the project and in the workspace.
    return `import { ctx, workspace } from "@trama-dev/runtime";
import { appendFileSync } from "fs";
appendFileSync("executions.txt", "ran\\n");
const seen = await workspace.list("run-*.txt");
await workspace.write("run-" + seen.length + ".txt", "");
await ctx.done();`;
  };

  try {
    const result = await runProgram({
      projectDir, maxRepairAttempts: 3, timeout: 5_000, workspaceDir: wsDir,
    });
    assert.equal(result.status, "done");
    assert.equal(repairCalls, 1);
    // No trial run first: the fix is run once, for real, and its effects kept.
    assert.equal(readFileSync(join(projectDir, "executions.txt"), "utf-8"), "ran\n");
    assert.deepEqual(readdirSync(wsDir).sort(), ["run-0.txt"]);
  } finally {
    llm.repair = originalRepair;
  }
});

test("a repaired program sees the workspace's existing artifacts", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(wsDir); });

  // Seed workspace with an artifact the repair needs
  writeText(join(wsDir, "input.txt"), "session data");

  createProjectFixture(projectDir, {
    programSource: `throw new Error("original failure");`,
  });

  const originalRepair = llm.repair;
  llm.repair = async function repair() {
    return `import { ctx, workspace } from "@trama-dev/runtime";
const data = await workspace.read("input.txt");
await ctx.done({ data });`;
  };

  try {
    const result = await runProgram({
      projectDir, maxRepairAttempts: 1, timeout: 5_000, workspaceDir: wsDir,
    });
    assert.equal(result.status, "done");
    assert.equal(result.result.data, "session data");
  } finally {
    llm.repair = originalRepair;
  }
});

test("repair respects done marker precedence (done then throw)", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    programSource: `throw new Error("original failure");`,
  });

  const originalRepair = llm.repair;
  llm.repair = async function repair() {
    // Repaired program calls done() then throws — done should take precedence
    return `import { ctx } from "@trama-dev/runtime";
await ctx.done({ repaired: true });
throw new Error("post-done error");`;
  };

  try {
    const result = await runProgram({ projectDir, maxRepairAttempts: 1, timeout: 5_000 });
    assert.equal(result.status, "done");
    assert.deepEqual(result.result, { repaired: true });
  } finally {
    llm.repair = originalRepair;
  }
});
