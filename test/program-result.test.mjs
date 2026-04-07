import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { PiAdapter } from "../packages/runtime/dist/pi-adapter.js";
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

// --- Repair workspace isolation ---

test("repair verification does not leak workspace artifacts", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(wsDir); });
  createProjectFixture(projectDir, {
    programSource: `throw new Error("original failure");`,
  });

  const originalRepair = PiAdapter.prototype.repair;
  PiAdapter.prototype.repair = async function repair() {
    // Repaired program writes to workspace then fails
    return `import { workspace } from "@trama-dev/runtime";
await workspace.write("leak.txt", "should not persist");
throw new Error("repair also fails");`;
  };

  try {
    const result = await runProgram({
      projectDir, maxRepairAttempts: 1, timeout: 5_000, workspaceDir: wsDir,
    });
    assert.equal(result.status, "failed");
    // The failed repair's workspace write must NOT appear in the real workspace
    assert.equal(existsSync(join(wsDir, "leak.txt")), false,
      "repair verification must not leak artifacts into the real workspace");
  } finally {
    PiAdapter.prototype.repair = originalRepair;
  }
});

test("failed real rerun does not leave workspace artifacts", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(wsDir); });

  // Seed workspace with a pre-existing artifact
  writeText(join(wsDir, "existing.txt"), "keep me");

  createProjectFixture(projectDir, {
    programSource: `throw new Error("original failure");`,
  });

  const originalRepair = PiAdapter.prototype.repair;
  PiAdapter.prototype.repair = async function repair() {
    // Use process.cwd() to distinguish temp verification from real rerun.
    // Temp verification runs in a temp dir copy; real rerun runs in the actual projectDir.
    const realProjectDir = JSON.stringify(projectDir);
    return `import { ctx, workspace } from "@trama-dev/runtime";
import { realpathSync } from "fs";
await workspace.write("artifact.txt", "from repair");
const cwd = realpathSync(process.cwd());
const realDir = realpathSync(${realProjectDir});
if (cwd === realDir) {
  throw new Error("crash in real dir");
}
await ctx.done();`;
  };

  try {
    const result = await runProgram({
      projectDir, maxRepairAttempts: 1, timeout: 5_000, workspaceDir: wsDir,
    });
    assert.equal(result.status, "failed");
    // Workspace artifacts from the failed real rerun must not persist
    assert.equal(existsSync(join(wsDir, "artifact.txt")), false,
      "failed real rerun must not leave workspace artifacts");
    // Pre-existing artifacts must survive
    assert.equal(readFileSync(join(wsDir, "existing.txt"), "utf-8"), "keep me");
  } finally {
    PiAdapter.prototype.repair = originalRepair;
  }
});

test("failed real rerun preserves concurrent workspace writes from other participants", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(wsDir); });

  createProjectFixture(projectDir, {
    programSource: `throw new Error("original failure");`,
  });

  const originalRepair = PiAdapter.prototype.repair;
  PiAdapter.prototype.repair = async function repair() {
    const realProjectDir = JSON.stringify(projectDir);
    // Program sleeps briefly in real dir (to allow simulated concurrent write),
    // then crashes. Passes in temp dir.
    return `import { ctx, tools, workspace } from "@trama-dev/runtime";
import { realpathSync } from "fs";
const cwd = realpathSync(process.cwd());
const realDir = realpathSync(${realProjectDir});
if (cwd === realDir) {
  await tools.shell("sleep 0.3");
  throw new Error("crash after concurrent write window");
}
await ctx.done();`;
  };

  try {
    // Start runProgram and simulate a concurrent write during the real rerun window
    const runPromise = runProgram({
      projectDir, maxRepairAttempts: 1, timeout: 10_000, workspaceDir: wsDir,
    });

    // Wait for the real rerun to start, then write a concurrent artifact
    // The repair takes ~2 runs (temp verify + real), so wait a bit
    await new Promise(r => setTimeout(r, 2000));
    writeText(join(wsDir, "concurrent.txt"), "from another participant");

    const result = await runPromise;
    assert.equal(result.status, "failed");
    // Concurrent write from another participant must survive the rollback
    assert.equal(readFileSync(join(wsDir, "concurrent.txt"), "utf-8"), "from another participant");
  } finally {
    PiAdapter.prototype.repair = originalRepair;
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

  const originalRepair = PiAdapter.prototype.repair;
  PiAdapter.prototype.repair = async function repair() {
    const realProjectDir = JSON.stringify(projectDir);
    return `import { ctx, tools, workspace } from "@trama-dev/runtime";
import { realpathSync } from "fs";
const cwd = realpathSync(process.cwd());
const realDir = realpathSync(${realProjectDir});
if (cwd === realDir) {
  await tools.shell("sleep 0.3");
}
await workspace.write("new-artifact.txt", "from repair");
await ctx.done();`;
  };

  try {
    const runPromise = runProgram({
      projectDir, maxRepairAttempts: 1, timeout: 10_000, workspaceDir: wsDir,
    });

    await new Promise(r => setTimeout(r, 2000));
    writeText(join(wsDir, "shared.txt"), "updated-by-other");

    const result = await runPromise;
    assert.equal(result.status, "done");
    assert.equal(readFileSync(join(wsDir, "new-artifact.txt"), "utf-8"), "from repair");
    assert.equal(readFileSync(join(wsDir, "shared.txt"), "utf-8"), "updated-by-other");
  } finally {
    PiAdapter.prototype.repair = originalRepair;
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

  const originalRepair = PiAdapter.prototype.repair;
  PiAdapter.prototype.repair = async function repair() {
    const realProjectDir = JSON.stringify(projectDir);
    // Repaired program modifies shared.txt (same file another participant will update)
    return `import { ctx, tools, workspace } from "@trama-dev/runtime";
import { realpathSync } from "fs";
const cwd = realpathSync(process.cwd());
const realDir = realpathSync(${realProjectDir});
if (cwd === realDir) {
  await tools.shell("sleep 0.3");
}
await workspace.write("shared.txt", "from-repair");
await ctx.done();`;
  };

  try {
    const runPromise = runProgram({
      projectDir, maxRepairAttempts: 1, timeout: 10_000, workspaceDir: wsDir,
    });

    // Wait for real rerun to start, then update shared.txt concurrently
    await new Promise(r => setTimeout(r, 2000));
    writeText(join(wsDir, "shared.txt"), "updated-by-other");

    const result = await runPromise;
    assert.equal(result.status, "done");
    // The concurrent update must be preserved — repair's stale write must be skipped
    assert.equal(readFileSync(join(wsDir, "shared.txt"), "utf-8"), "updated-by-other");
  } finally {
    PiAdapter.prototype.repair = originalRepair;
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

  const originalRepair = PiAdapter.prototype.repair;
  PiAdapter.prototype.repair = async function repair() {
    const realProjectDir = JSON.stringify(projectDir);
    return `import { ctx, tools, workspace } from "@trama-dev/runtime";
import { realpathSync } from "fs";
const cwd = realpathSync(process.cwd());
const realDir = realpathSync(${realProjectDir});
if (cwd === realDir) {
  await tools.shell("sleep 0.3");
}
await workspace.write("shared-new.txt", "from-repair");
await ctx.done();`;
  };

  try {
    const runPromise = runProgram({
      projectDir, maxRepairAttempts: 1, timeout: 10_000, workspaceDir: wsDir,
    });

    // Wait for real rerun to start, then create the same new path concurrently
    await new Promise(r => setTimeout(r, 2000));
    writeText(join(wsDir, "shared-new.txt"), "from-other");

    const result = await runPromise;
    assert.equal(result.status, "done");
    // The other participant's version must be preserved
    assert.equal(readFileSync(join(wsDir, "shared-new.txt"), "utf-8"), "from-other");
  } finally {
    PiAdapter.prototype.repair = originalRepair;
  }
});

test("successful repair commit handles path-shape conflict gracefully", async (t) => {
  // Test commitWorkspaceChanges directly to avoid timing fragility.
  // Simulate: repair wrote "nested/out.txt" in temp workspace, but another
  // participant created "nested" as a regular file in the real workspace.
  const { commitWorkspaceChanges, snapshotDir } = await import("../packages/runtime/dist/runner.js");

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

  // commitWorkspaceChanges must not throw — it should skip the conflicting path
  commitWorkspaceChanges(tempDir, realDir, tempBefore, realSeed);

  // The other participant's "nested" regular file must be preserved
  assert.equal(readFileSync(join(realDir, "nested"), "utf-8"), "i-am-a-file");
});

test("repair commit does not follow symlinks escaping workspace", async (t) => {
  // Test that commitWorkspaceChanges respects the workspace bounded root
  // when a concurrent participant places a symlink pointing outside.
  const { commitWorkspaceChanges, snapshotDir } = await import("../packages/runtime/dist/runner.js");
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

  // commitWorkspaceChanges must not follow the symlink and overwrite the external file
  commitWorkspaceChanges(tempDir, realDir, tempBefore, realSeed);

  // The external file must NOT have been overwritten
  assert.equal(readFileSync(join(outsideDir, "target.txt"), "utf-8"), "external-original");
});

test("repair commit does not follow symlinked parent directory escaping workspace", async (t) => {
  const { commitWorkspaceChanges, snapshotDir } = await import("../packages/runtime/dist/runner.js");
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

  commitWorkspaceChanges(tempDir, realDir, tempBefore, realSeed);

  // The external directory must NOT have a data.txt written into it
  assert.equal(existsSync(join(outsideDir, "data.txt")), false);
});

test("repair verification can read existing workspace artifacts", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(wsDir); });

  // Seed workspace with an artifact the repair needs
  writeText(join(wsDir, "input.txt"), "session data");

  createProjectFixture(projectDir, {
    programSource: `throw new Error("original failure");`,
  });

  const originalRepair = PiAdapter.prototype.repair;
  PiAdapter.prototype.repair = async function repair() {
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
    PiAdapter.prototype.repair = originalRepair;
  }
});

test("repair respects done marker precedence (done then throw)", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    programSource: `throw new Error("original failure");`,
  });

  const originalRepair = PiAdapter.prototype.repair;
  PiAdapter.prototype.repair = async function repair() {
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
    PiAdapter.prototype.repair = originalRepair;
  }
});
