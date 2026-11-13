import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { llm } from "./fake-llm.mjs";
import { runProgram } from "../packages/runtime/dist/runner.js";
import { createWorkspace } from "../packages/runtime/dist/workspace.js";
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

test("runProgram refuses a checkpoint after done — what the run ended on stands", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    programSource: `import { ctx, tools } from "@trama-dev/runtime";
ctx.state.answer = 1;
await ctx.done({ final: true });
ctx.state.answer = "changed after the end";
let verdict;
try {
  await ctx.checkpoint();
  verdict = "checkpoint was accepted";
} catch (err) {
  verdict = err.message;
}
await tools.write("verdict.txt", verdict + " / iteration " + ctx.iteration);
`,
  });

  const result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 });
  assert.equal(result.status, "done");
  assert.match(
    readFileSync(join(projectDir, "verdict.txt"), "utf-8"),
    /Cannot call ctx\.checkpoint\(\) after ctx\.done\(\).* \/ iteration 1$/,
  );
  assert.deepEqual(readJson(join(projectDir, "state.json")), { answer: 1, __trama_iteration: 1 });
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

// --- Repair: the project is staged, the shared workspace is live ---

// A fix runs on a private copy of the project. Several tests below need
// something else to change the real project while a repaired program is
// running — after the copy is taken, before a working fix is merged back.
// Rather than guess when that is, the repaired program announces that it has
// started and waits to be released, and the test acts in between. The two
// sides meet in a directory of their own, named after the project.
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

test("a fix that fails never touches the project, but what it wrote to the shared workspace stays", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(wsDir); });

  writeText(join(wsDir, "existing.txt"), "keep me");

  const originalSource = `throw new Error("original failure");`;
  createProjectFixture(projectDir, { programSource: originalSource });

  const originalRepair = llm.repair;
  llm.repair = async function repair() {
    // The repaired program writes to both places and then fails as well.
    return `import { tools, workspace } from "@trama-dev/runtime";
await tools.write("private.txt", "from the fix");
await workspace.write("artifact.txt", "from the fix");
throw new Error("repair also fails");`;
  };

  try {
    const result = await runProgram({
      projectDir, maxRepairAttempts: 1, timeout: 5_000, workspaceDir: wsDir,
    });
    assert.equal(result.status, "failed");
    // The project is the program's own: the fix ran on a copy of it.
    assert.equal(existsSync(join(projectDir, "private.txt")), false);
    assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), originalSource);
    // The workspace is shared and live: what was written there was written,
    // as it would have been by any run that failed part-way.
    assert.equal(readFileSync(join(wsDir, "artifact.txt"), "utf-8"), "from the fix");
    assert.equal(readFileSync(join(wsDir, "existing.txt"), "utf-8"), "keep me");
  } finally {
    llm.repair = originalRepair;
  }
});

test("a program being fixed still takes part in its session", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(wsDir); });

  createProjectFixture(projectDir, {
    programSource: `throw new Error("original failure");`,
  });

  const originalRepair = llm.repair;
  llm.repair = async function repair() {
    // The repaired program asks another participant for something and waits for the answer.
    return `import { ctx, workspace } from "@trama-dev/runtime";
await workspace.write("request.txt", "ping");
const reply = await workspace.observe("reply.txt", { timeout: 8000 });
await ctx.done({ reply });`;
  };

  // The other participant: answers a request once it sees one.
  const other = createWorkspace(wsDir);
  const answer = async () => {
    const request = await other.observe("request.txt", { timeout: 9_000 });
    await other.write("reply.txt", `pong to ${request}`);
  };

  try {
    const [result] = await Promise.all([
      runProgram({ projectDir, maxRepairAttempts: 1, timeout: 10_000, workspaceDir: wsDir }),
      answer(),
    ]);
    // It was heard while it was being tried, and it heard back.
    assert.equal(result.status, "done");
    assert.deepEqual(result.result, { reply: "pong to ping" });
  } finally {
    llm.repair = originalRepair;
  }
});

test("a fix that fails leaves alone what changed in the project meanwhile", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  t.after(() => cleanupTempDir(projectDir));

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
    const runPromise = runProgram({ projectDir, maxRepairAttempts: 1, timeout: 10_000 });

    await duringRepairRun(projectDir, () => {
      writeText(join(projectDir, "concurrent.txt"), "written meanwhile");
    });

    const result = await runPromise;
    assert.equal(result.status, "failed");
    assert.equal(readFileSync(join(projectDir, "concurrent.txt"), "utf-8"), "written meanwhile");
  } finally {
    llm.repair = originalRepair;
  }
});

test("a working fix is merged around what changed in the project meanwhile (other paths)", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  t.after(() => cleanupTempDir(projectDir));

  createProjectFixture(projectDir, {
    programSource: `throw new Error("original failure");`,
  });
  // A file that something else will update while the fix is being tried
  writeText(join(projectDir, "shared.txt"), "seed");

  const originalRepair = llm.repair;
  llm.repair = async function repair() {
    return `import { ctx, tools } from "@trama-dev/runtime";
${pauseRepairRun(projectDir)}
await tools.write("new-artifact.txt", "from repair");
await ctx.done();`;
  };

  try {
    const runPromise = runProgram({ projectDir, maxRepairAttempts: 1, timeout: 10_000 });

    await duringRepairRun(projectDir, () => {
      writeText(join(projectDir, "shared.txt"), "updated-meanwhile");
    });

    const result = await runPromise;
    assert.equal(result.status, "done");
    assert.equal(readFileSync(join(projectDir, "new-artifact.txt"), "utf-8"), "from repair");
    assert.equal(readFileSync(join(projectDir, "shared.txt"), "utf-8"), "updated-meanwhile");
  } finally {
    llm.repair = originalRepair;
  }
});

test("a working fix does not overwrite a file that changed in the project meanwhile", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  t.after(() => cleanupTempDir(projectDir));

  createProjectFixture(projectDir, {
    programSource: `throw new Error("original failure");`,
  });
  // Both the fix and something else will write to shared.txt
  writeText(join(projectDir, "shared.txt"), "seed");

  const originalRepair = llm.repair;
  llm.repair = async function repair() {
    return `import { ctx, tools } from "@trama-dev/runtime";
${pauseRepairRun(projectDir)}
await tools.write("shared.txt", "from-repair");
await ctx.done();`;
  };

  try {
    const runPromise = runProgram({ projectDir, maxRepairAttempts: 1, timeout: 10_000 });

    // While the fix runs on its copy, the real file is updated
    await duringRepairRun(projectDir, () => {
      writeText(join(projectDir, "shared.txt"), "updated-meanwhile");
    });

    const result = await runPromise;
    assert.equal(result.status, "done");
    // The update made to the real project is kept; the fix's stale write is skipped
    assert.equal(readFileSync(join(projectDir, "shared.txt"), "utf-8"), "updated-meanwhile");
  } finally {
    llm.repair = originalRepair;
  }
});

test("a working fix does not overwrite a file that appeared in the project meanwhile", async (t) => {
  const projectDir = makeTempDir("trama-result-");
  t.after(() => cleanupTempDir(projectDir));

  // shared-new.txt does not exist when the copy is taken — both sides create it
  createProjectFixture(projectDir, {
    programSource: `throw new Error("original failure");`,
  });

  const originalRepair = llm.repair;
  llm.repair = async function repair() {
    return `import { ctx, tools } from "@trama-dev/runtime";
${pauseRepairRun(projectDir)}
await tools.write("shared-new.txt", "from-repair");
await ctx.done();`;
  };

  try {
    const runPromise = runProgram({ projectDir, maxRepairAttempts: 1, timeout: 10_000 });

    await duringRepairRun(projectDir, () => {
      writeText(join(projectDir, "shared-new.txt"), "created-meanwhile");
    });

    const result = await runPromise;
    assert.equal(result.status, "done");
    assert.equal(readFileSync(join(projectDir, "shared-new.txt"), "utf-8"), "created-meanwhile");
  } finally {
    llm.repair = originalRepair;
  }
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
