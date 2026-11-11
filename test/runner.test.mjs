import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, statSync, rmSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { llm } from "./fake-llm.mjs";
import { copyToHistory, loadConfig, loadState, runProgram, RUNTIME_TYPES } from "../packages/runtime/dist/runner.js";
import { REPO_ROOT, cleanupTempDir, createProjectFixture, makeTempDir, readJson, withEnv, writeJson, writeText } from "./helpers.mjs";

test("loadState returns an empty object when state.json is missing", (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));

  assert.deepEqual(loadState(projectDir), {});
});

test("loadState parses valid JSON state", (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { state: { counter: 2 } });

  assert.deepEqual(loadState(projectDir), { counter: 2 });
});

test("loadState throws a clear error for corrupt JSON", (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { state: "{broken json" });

  assert.throws(
    () => loadState(projectDir),
    /Corrupt state\.json .*cannot safely continue/,
  );
});

test("copyToHistory continues numbering correctly past 9999", (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  writeFileSync(join(projectDir, "history", "9999.ts"), "// old");
  writeFileSync(join(projectDir, "history", "10000.ts"), "// newer");
  writeFileSync(join(projectDir, "program.ts"), "// latest");

  copyToHistory(projectDir, "update", "prompt");

  assert.equal(existsSync(join(projectDir, "history", "10001.ts")), true);

  const entries = readFileSync(join(projectDir, "history", "index.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));
  assert.equal(entries.at(-1).version, 10001);
  assert.equal(entries.at(-1).reason, "update");
});

test("copyToHistory creates 0001.ts as the first entry when history is empty", (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);
  writeFileSync(join(projectDir, "program.ts"), "// first");

  copyToHistory(projectDir, "create");

  assert.equal(existsSync(join(projectDir, "history", "0001.ts")), true);
  assert.equal(readFileSync(join(projectDir, "history", "0001.ts"), "utf-8"), "// first");

  const entries = readFileSync(join(projectDir, "history", "index.jsonl"), "utf-8")
    .trim().split("\n").map(l => JSON.parse(l));
  assert.equal(entries.at(-1).version, 1);
  assert.equal(entries.at(-1).reason, "create");
  // "create" without detail should not have error or prompt keys
  assert.equal("error" in entries.at(-1), false);
  assert.equal("prompt" in entries.at(-1), false);
});

test("copyToHistory records error detail for repair entries", (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);
  writeFileSync(join(projectDir, "program.ts"), "// repaired");

  copyToHistory(projectDir, "repair", "something broke");

  const entries = readFileSync(join(projectDir, "history", "index.jsonl"), "utf-8")
    .trim().split("\n").map(l => JSON.parse(l));
  assert.equal(entries.at(-1).reason, "repair");
  assert.equal(entries.at(-1).error, "something broke");
});

test("runProgram scaffolds and executes a minimal shared project", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { scaffold: false });

  await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 });

  assert.equal(readFileSync(join(projectDir, "output.txt"), "utf-8"), "iteration:0");
  assert.deepEqual(readJson(join(projectDir, "package.json")), { type: "module" });
  assert.equal(existsSync(join(projectDir, ".gitignore")), true);
  assert.equal(existsSync(join(projectDir, "logs", "latest.jsonl")), true);
  assert.equal(existsSync(join(projectDir, "history")), true);

  const state = readJson(join(projectDir, "state.json"));
  assert.equal(state.status, "ok");
  assert.equal(state.__trama_iteration, 1);

  const logs = readFileSync(join(projectDir, "logs", "latest.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));
  assert.deepEqual(logs.map(entry => entry.message), ["ran", "done"]);
});

test("runProgram rejects missing projects before execution", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));

  await assert.rejects(
    async () => runProgram({ projectDir: join(projectDir, "missing"), maxRepairAttempts: 0 }),
    /Project not found/,
  );
});

test("runProgram refuses to overwrite a real project-local runtime directory", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { scaffold: false });
  mkdirSync(join(projectDir, "node_modules", "@trama-dev", "runtime"), { recursive: true });
  writeFileSync(join(projectDir, "node_modules", "@trama-dev", "runtime", "marker.txt"), "user-owned");

  await assert.rejects(
    async () => runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 }),
    /exists and is not a symlink/,
  );
  assert.equal(existsSync(join(projectDir, "node_modules", "@trama-dev", "runtime", "marker.txt")), true);
});

test("runProgram stops immediately on corrupt state", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { scaffold: false, state: "{broken json" });

  await assert.rejects(
    async () => runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 }),
    /Corrupt state\.json/,
  );
});

test("runProgram wall-clock timeout kills the child during tools.shell", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { tools } from "@trama-dev/runtime";
await tools.shell("sleep 60");`,
  });

  const start = Date.now();
  const result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 1_500 });
  assert.equal(result.status, "failed");
  assert.match(result.reason, /timeout/i);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5_000, `Expected <5s, got ${elapsed}ms`);
});

test("runProgram includes buffered stdout in failure errors", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `console.log("stdout-hint");
throw new Error("boom");`,
  });

  const result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 });
  assert.equal(result.status, "failed");
  assert.match(result.reason, /stdout: stdout-hint[\s\S]*stderr: .*boom/s);
});

test("runProgram records successful repairs in history and logs the repair attempt", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: 'throw new Error("boom");',
  });

  const fixedProgram = `import { ctx, tools } from "@trama-dev/runtime";
await tools.write("repaired.txt", "ok");
await ctx.done();
`;

  const originalRepair = llm.repair;
  llm.repair = async function repair(prompt) {
    assert.match(prompt, /Error:\n[\s\S]*boom/, "the fix request carries the failure");
    // A model rarely returns the program alone, whatever it was told.
    return "Here is the fixed program:\n\n```typescript\n" + fixedProgram + "```\n";
  };

  try {
    await runProgram({ projectDir, maxRepairAttempts: 1, timeout: 5_000 });
  } finally {
    llm.repair = originalRepair;
  }

  // What is installed is the program in the reply, without the wrapping around it.
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), fixedProgram.trim());
  assert.equal(readFileSync(join(projectDir, "history", "0001.ts"), "utf-8"), fixedProgram.trim());
  // The fix is tried on a copy of the project; what it wrote is merged back because it worked.
  assert.equal(readFileSync(join(projectDir, "repaired.txt"), "utf-8"), "ok");

  const history = readFileSync(join(projectDir, "history", "index.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));
  assert.equal(history.at(-1).reason, "repair");
  assert.match(history.at(-1).error, /boom/);

  const logs = readFileSync(join(projectDir, "logs", "latest.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));
  assert.equal(logs.some(entry => entry.message === "Repair attempt 1/1"), true);
  assert.equal(logs.some(entry => entry.message === "done"), true);
});

test("runProgram surfaces repair failures after retries are exhausted", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: 'throw new Error("boom");',
  });

  const originalRepair = llm.repair;
  llm.repair = async function repair() {
    throw new Error("repair blew up");
  };

  try {
    const result = await runProgram({ projectDir, maxRepairAttempts: 1, timeout: 5_000 });
    assert.equal(result.status, "failed");
    assert.match(result.reason, /Repair errors:[\s\S]*repair blew up/s);
  } finally {
    llm.repair = originalRepair;
  }
});

test("runProgram patches existing package.json that lacks type:module", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    scaffold: false,
    packageJson: { name: "user-pkg", version: "2.0.0" },
  });

  await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 });

  const pkg = readJson(join(projectDir, "package.json"));
  assert.equal(pkg.type, "module");
  assert.equal(pkg.name, "user-pkg");
  assert.equal(pkg.version, "2.0.0");
});

test("runProgram rejects invalid timeout values passed via the public API", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { scaffold: false });

  await assert.rejects(
    async () => runProgram({ projectDir, maxRepairAttempts: 0, timeout: Number.NaN }),
    /Invalid timeout: NaN/,
  );
});

test("runProgram surfaces malformed config.json instead of silently using defaults", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(projectDir));
  t.after(() => cleanupTempDir(fakeHome));
  createProjectFixture(projectDir, { scaffold: false });
  writeText(join(fakeHome, ".trama", "config.json"), "{bad json");

  await withEnv({ HOME: fakeHome }, async () => {
    await assert.rejects(
      async () => runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 }),
      /Malformed config/,
    );
  });
});

test("runProgram rejects invalid maxRepairAttempts values passed via the public API", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { scaffold: false });

  await assert.rejects(
    async () => runProgram({ projectDir, maxRepairAttempts: -1, timeout: 5_000 }),
    /Invalid maxRepairAttempts: -1/,
  );
  await assert.rejects(
    async () => runProgram({ projectDir, maxRepairAttempts: 1.5, timeout: 5_000 }),
    /Invalid maxRepairAttempts: 1.5/,
  );
});

test("runProgram refuses to overwrite a malformed package.json", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    scaffold: false,
    packageJson: { type: "module" },
  });
  const malformed = "{\n  \"name\": \"demo\",\n";
  writeFileSync(join(projectDir, "package.json"), malformed);

  await assert.rejects(
    async () => runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 }),
    /Malformed package\.json .*will not overwrite it automatically/,
  );
  assert.equal(readFileSync(join(projectDir, "package.json"), "utf-8"), malformed);
});

test("runProgram appends missing trama exclusions to an existing .gitignore", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    scaffold: false,
    packageJson: { type: "module" },
  });
  writeFileSync(join(projectDir, ".gitignore"), "README.md\n");

  await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 });

  const lines = readFileSync(join(projectDir, ".gitignore"), "utf-8").trim().split("\n");
  assert.equal(lines.includes("README.md"), true);
  assert.equal(lines.includes("node_modules/"), true);
  assert.equal(lines.includes("state.json"), true);
  assert.equal(lines.includes("logs/"), true);
  assert.equal(lines.includes("history/"), true);
});

test("runProgram replaces a stale symlink with the correct target", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { scaffold: false });

  // Create a stale symlink pointing to a nonexistent path
  const linkDir = join(projectDir, "node_modules", "@trama-dev");
  mkdirSync(linkDir, { recursive: true });
  symlinkSync("/tmp/nonexistent-old-trama", join(linkDir, "runtime"), "dir");

  await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 });
  assert.equal(readFileSync(join(projectDir, "output.txt"), "utf-8"), "iteration:0");
});

test("runProgram rejects symlinked meta.json that points outside the project", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  const outsideDir = makeTempDir("trama-outside-");
  t.after(() => {
    cleanupTempDir(projectDir);
    cleanupTempDir(outsideDir);
  });
  createProjectFixture(projectDir, { scaffold: false });

  writeJson(join(outsideDir, "meta.json"), {
    input: { prompt: "outside prompt", args: {} },
    createdAt: "2026-03-28T00:00:00.000Z",
    piVersion: "0.63.1",
  });
  rmSync(join(projectDir, "meta.json"));
  symlinkSync(join(outsideDir, "meta.json"), join(projectDir, "meta.json"));

  await assert.rejects(
    async () => runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 }),
    /Path escapes project directory via symlink: meta\.json/,
  );
});

test("runProgram rejects symlinked program.ts that points outside the project", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  const outsideDir = makeTempDir("trama-outside-");
  t.after(() => {
    cleanupTempDir(projectDir);
    cleanupTempDir(outsideDir);
  });
  createProjectFixture(projectDir, { scaffold: false });

  const outsideProgram = `console.log("outside");`;
  writeText(join(outsideDir, "program.ts"), outsideProgram);
  rmSync(join(projectDir, "program.ts"));
  symlinkSync(join(outsideDir, "program.ts"), join(projectDir, "program.ts"));

  await assert.rejects(
    async () => runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 }),
    /Path escapes project directory via symlink: program\.ts/,
  );
  assert.equal(readFileSync(join(outsideDir, "program.ts"), "utf-8"), outsideProgram);
});

// --- Regression tests ---

test("loadState rejects non-object JSON values (string, array, null)", (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));

  for (const [label, content] of [["string", '"hello"'], ["array", "[1,2]"], ["null", "null"], ["number", "42"]]) {
    createProjectFixture(projectDir, { state: content });
    assert.throws(
      () => loadState(projectDir),
      /Corrupt state\.json/,
      `should reject ${label}`,
    );
  }
});

test("loadConfig rejects invalid field values", (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const cases = [
    [{ defaultMaxIterations: -1 }, /defaultMaxIterations/],
    [{ defaultMaxIterations: 0 }, /defaultMaxIterations/],
    [{ defaultTimeout: 0 }, /defaultTimeout/],
    [{ defaultTimeout: -100 }, /defaultTimeout/],
    [{ provider: 123 }, /provider/],
    [{ model: "" }, /model/],
  ];

  for (const [override, pattern] of cases) {
    writeJson(join(fakeHome, ".trama", "config.json"), override);
    withEnv({ HOME: fakeHome }, () => {
      assert.throws(() => loadConfig(), pattern, `should reject ${JSON.stringify(override)}`);
    });
  }
});

test("runProgram does not trigger repair when program succeeds", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { scaffold: false });

  const originalRepair = llm.repair;
  let repairCalled = false;
  llm.repair = async function repair() {
    repairCalled = true;
    return 'throw new Error("repair should not run");';
  };

  try {
    await runProgram({ projectDir, maxRepairAttempts: 3, timeout: 5_000 });
    assert.equal(repairCalled, false, "repair should not be called when program succeeds");
    assert.equal(readFileSync(join(projectDir, "output.txt"), "utf-8"), "iteration:0");
  } finally {
    llm.repair = originalRepair;
  }
});

test("runProgram throws immediately when repair LLM call fails (does not re-run broken program)", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));

  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { tools } from "@trama-dev/runtime";
let runCount = 0;
try {
  runCount = parseInt(await tools.read("run-count.txt"), 10) || 0;
} catch {
  // First run: file does not exist yet.
}
await tools.write("run-count.txt", String(runCount + 1));
throw new Error("boom");`,
  });

  const originalRepair = llm.repair;
  llm.repair = async function repair() {
    throw new Error("LLM unavailable");
  };

  try {
    const result = await runProgram({ projectDir, maxRepairAttempts: 3, timeout: 5_000 });
    assert.equal(result.status, "failed");
    assert.match(result.reason, /Failed after 1 repair attempt\(s\)/);
    assert.equal(readFileSync(join(projectDir, "run-count.txt"), "utf-8"), "1");
  } finally {
    llm.repair = originalRepair;
  }
});

test("runProgram only records repair history after the repaired program succeeds", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: 'throw new Error("original");',
  });

  const originalRepair = llm.repair;
  // First repair returns code that also fails, second repair returns working code
  let repairAttempt = 0;
  llm.repair = async function repair() {
    repairAttempt++;
    if (repairAttempt === 1) {
      return 'throw new Error("still broken");';
    }
    return `import { ctx } from "@trama-dev/runtime"; await ctx.done();`;
  };

  try {
    await runProgram({ projectDir, maxRepairAttempts: 3, timeout: 5_000 });
  } finally {
    llm.repair = originalRepair;
  }

  const history = readFileSync(join(projectDir, "history", "index.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));

  // Only the successful repair should be in history, not the failed one
  const repairEntries = history.filter(e => e.reason === "repair");
  assert.equal(repairEntries.length, 1, "only 1 verified repair should be recorded");
});

// --- Regression tests for consolidated bug fixes ---

test("runProgram restores original program.ts when all repair attempts produce broken code", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));

  const originalSource = 'throw new Error("original");';
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: originalSource,
  });

  const originalRepair = llm.repair;
  let attempts = 0;
  llm.repair = async function repair() {
    attempts += 1;
    return `throw new Error("still broken, attempt ${attempts}");`;
  };

  try {
    const result = await runProgram({ projectDir, maxRepairAttempts: 2, timeout: 5_000 });
    assert.equal(result.status, "failed");
    assert.match(result.reason, /Failed after 2 repair attempts/);
    assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), originalSource);
  } finally {
    llm.repair = originalRepair;
  }
});

test("runProgram does not run a repair that changes nothing or returns nothing", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));

  const originalSource = `import { appendFileSync } from "fs";
appendFileSync(${JSON.stringify(join(projectDir, "executions.txt"))}, "ran\\n");
throw new Error("original");`;
  createProjectFixture(projectDir, { scaffold: false, programSource: originalSource });

  const originalRepair = llm.repair;
  try {
    for (const [useless, expected] of [[originalSource, /returned the program unchanged/], ["  \n", /returned an empty program/]]) {
      llm.repair = async function repair() { return useless; };
      const result = await runProgram({ projectDir, maxRepairAttempts: 3, timeout: 5_000 });
      assert.equal(result.status, "failed");
      assert.match(result.reason, /Failed after 1 repair attempt\(s\)/);
      assert.match(result.reason, expected);
    }
    // Two runs of the original program, one per runProgram call — and no reruns of a "fix" that fixes nothing.
    assert.equal(readFileSync(join(projectDir, "executions.txt"), "utf-8"), "ran\nran\n");
  } finally {
    llm.repair = originalRepair;
  }
});

test("runProgram restores original program.ts when repair LLM call fails", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));

  const originalSource = 'throw new Error("original");';
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: originalSource,
  });

  const originalRepair = llm.repair;
  llm.repair = async function repair() {
    throw new Error("LLM unavailable");
  };

  try {
    const result = await runProgram({ projectDir, maxRepairAttempts: 1, timeout: 5_000 });
    assert.equal(result.status, "failed");
    assert.match(result.reason, /Failed after 1 repair attempt/);
    assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), originalSource);
  } finally {
    llm.repair = originalRepair;
  }
});

test("runProgram leaves no trace of a repair that did not work", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));

  const originalSource = 'throw new Error("original");';
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: originalSource,
  });

  const originalRepair = llm.repair;
  // The repair agent writes a file in its working directory, and the program it
  // returns writes another before failing. Neither may reach the project: the
  // agent works in a throwaway copy, and a fix is tried on a copy too.
  llm.repair = async function repair(_prompt, call) {
    writeFileSync(join(call.cwd, "repair-side-effect.txt"), "from-repair-llm");
    return `import { tools } from "@trama-dev/runtime";
await tools.write("program-side-effect.txt", "from-repaired-program");
throw new Error("still broken");`;
  };

  try {
    const result = await runProgram({ projectDir, maxRepairAttempts: 1, timeout: 5_000 });
    assert.equal(result.status, "failed");
    assert.match(result.reason, /Failed after 1 repair attempt/);
    // program.ts is the original: a fix that did not work is never installed
    assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), originalSource);
    assert.equal(existsSync(join(projectDir, "repair-side-effect.txt")), false);
    assert.equal(existsSync(join(projectDir, "program-side-effect.txt")), false);
  } finally {
    llm.repair = originalRepair;
  }
});

test("runProgram keeps a working repair even when post-success bookkeeping (onRepair) fails", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));

  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: 'throw new Error("original");',
  });

  const fixedProgram = `import { ctx } from "@trama-dev/runtime";
await ctx.done();
`;

  const originalRepair = llm.repair;
  llm.repair = async function repair() {
    // Make history/ unwritable so onRepair's copyToHistory throws
    const { chmodSync } = await import("fs");
    chmodSync(join(projectDir, "history"), 0o444);
    return fixedProgram;
  };

  try {
    // onRepair bookkeeping (history write) fails with EACCES, but program succeeded —
    // runProgram should still return success, not propagate the bookkeeping error.
    await runProgram({ projectDir, maxRepairAttempts: 1, timeout: 5_000 });
    assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), fixedProgram.trim());
  } finally {
    llm.repair = originalRepair;
    // Restore permissions for cleanup
    const { chmodSync } = await import("fs");
    try { chmodSync(join(projectDir, "history"), 0o755); } catch { /* may not exist */ }
  }
});

test("loadConfig rejects non-object JSON values (array, string, number, null)", (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  for (const [label, content] of [["array", "[]"], ["string", '"openai"'], ["number", "42"], ["null", "null"]]) {
    writeText(join(fakeHome, ".trama", "config.json"), content);
    withEnv({ HOME: fakeHome }, () => {
      assert.throws(
        () => loadConfig(),
        /Malformed config.*expected a JSON object/,
        `should reject ${label}`,
      );
    });
  }
});

test("runProgram rejects non-object package.json (array)", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { scaffold: false });
  writeFileSync(join(projectDir, "package.json"), "[]");

  await assert.rejects(
    async () => runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 }),
    /Malformed package\.json.*expected a JSON object/,
  );
});

// --- Process lifetime, init file security, IPC limits ---

/** Start a runner in its own process, so the test can stop it the way a user or a parent runner would. */
function startRunnerProcess(fakeHome, projectDir, { stubRepair = "" } = {}) {
  const runnerUrl = pathToFileURL(join(REPO_ROOT, "packages", "runtime", "dist", "runner.js")).href;
  const fakeLlmUrl = pathToFileURL(join(REPO_ROOT, "test", "fake-llm.mjs")).href;
  const script = `import { runProgram } from ${JSON.stringify(runnerUrl)};
import { llm } from ${JSON.stringify(fakeLlmUrl)};
${stubRepair}
await runProgram({ projectDir: ${JSON.stringify(projectDir)}, maxRepairAttempts: 1, timeout: 60_000 });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: fakeHome },
    stdio: "ignore",
  });
  const exited = new Promise(resolve => child.on("close", (code, signal) => resolve({ code, signal })));
  return { child, exited };
}

async function waitFor(check, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("stopping the runner stops the program and the shell commands it started", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  const projectDir = makeTempDir("trama-runner-");
  const signalDir = makeTempDir("trama-signal-");
  t.after(() => { cleanupTempDir(fakeHome); cleanupTempDir(projectDir); cleanupTempDir(signalDir); });

  // A program in the middle of a long shell command, as when the user presses Ctrl-C.
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { tools } from "@trama-dev/runtime";
import { writeFileSync } from "fs";
writeFileSync(${JSON.stringify(join(signalDir, "program.pid"))}, String(process.pid));
await tools.shell("echo $$ > ${join(signalDir, "shell.pid")}; sleep 60", { timeout: 60000 });`,
  });

  const { child, exited } = startRunnerProcess(fakeHome, projectDir);
  await waitFor(() => existsSync(join(signalDir, "shell.pid")) && readFileSync(join(signalDir, "shell.pid"), "utf-8").trim() !== "", "the shell command to start");
  const programPid = Number(readFileSync(join(signalDir, "program.pid"), "utf-8"));
  const shellPid = Number(readFileSync(join(signalDir, "shell.pid"), "utf-8"));
  assert.equal(isAlive(programPid) && isAlive(shellPid), true);

  child.kill("SIGINT");
  const { signal } = await exited;
  assert.equal(signal, "SIGINT", "the runner should still die of the signal it was sent");

  await waitFor(() => !isAlive(programPid) && !isAlive(shellPid), "the program and its shell command to be gone", 5_000);
});

test("a runner stopped while trying a fix leaves the project as it was", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  const projectDir = makeTempDir("trama-runner-");
  const signalDir = makeTempDir("trama-signal-");
  t.after(() => { cleanupTempDir(fakeHome); cleanupTempDir(projectDir); cleanupTempDir(signalDir); });

  const originalSource = 'throw new Error("original");';
  createProjectFixture(projectDir, { scaffold: false, programSource: originalSource, state: { kept: true } });

  // The proposed fix checkpoints new state, writes a file, announces itself and then hangs.
  const fix = `import { ctx } from "@trama-dev/runtime";
import { writeFileSync } from "fs";
ctx.state.kept = false;
await ctx.checkpoint();
writeFileSync("written-by-fix.txt", "x");
writeFileSync(${JSON.stringify(join(signalDir, "fix.pid"))}, String(process.pid));
await new Promise(() => {});`;
  const { child, exited } = startRunnerProcess(fakeHome, projectDir, {
    stubRepair: `llm.repair = async () => ${JSON.stringify(fix)};`,
  });

  await waitFor(() => existsSync(join(signalDir, "fix.pid")), "the fix to be running");
  const fixPid = Number(readFileSync(join(signalDir, "fix.pid"), "utf-8"));
  child.kill("SIGTERM");
  await exited;

  // The unverified fix was never installed, and nothing it did reached the project.
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), originalSource);
  assert.deepEqual(readJson(join(projectDir, "state.json")), { kept: true });
  assert.equal(existsSync(join(projectDir, "written-by-fix.txt")), false);
  await waitFor(() => !isAlive(fixPid), "the fix to be gone", 5_000);
});

test("runProgram cleans up background processes even on successful runs", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));

  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { ctx, tools } from "@trama-dev/runtime";
await tools.shell('nohup sh -c "sleep 0.3; echo leaked > leaked.txt" >/dev/null 2>&1 &');
await ctx.done();`,
  });

  await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 });
  // Wait long enough for the background process to have written if it were alive
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(existsSync(join(projectDir, "leaked.txt")), false,
    "background processes must be killed even on successful runs");
});

test("runProgram init payload is not world-readable", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));

  // Use a program that reads and saves the init file path and mode before it's cleaned up
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { ctx, tools } from "@trama-dev/runtime";
import { statSync } from "fs";
const initPath = process.env.TRAMA_INIT;
const stat = statSync(initPath);
const mode = (stat.mode & 0o777).toString(8);
await tools.write("init-mode.txt", mode);
await ctx.done();`,
  });

  await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 });
  const mode = readFileSync(join(projectDir, "init-mode.txt"), "utf-8").trim();
  assert.equal(mode, "600", "init file must be mode 0600, not world-readable");
});

test("IPC server rejects oversized request bodies with 413", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));

  // Program sends a raw HTTP request to the IPC server with a body exceeding 50MB.
  // It reads the status code and writes it to a file so we can assert from the test.
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { ctx, tools } from "@trama-dev/runtime";
import { readFileSync } from "fs";
const port = process.env.TRAMA_PORT;
const { token } = JSON.parse(readFileSync(process.env.TRAMA_INIT, "utf-8"));
const big = "x".repeat(51 * 1024 * 1024);
const res = await fetch("http://127.0.0.1:" + port + "/ctx/log", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
  body: big,
});
await tools.write("ipc-status.txt", String(res.status));
await ctx.done();`,
  });

  await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 10_000 });
  assert.equal(readFileSync(join(projectDir, "ipc-status.txt"), "utf-8"), "413");
});

test("IPC server refuses requests that do not carry the run's token", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));

  // The server listens on a loopback port. Without the token, knowing the port
  // must not be enough to have the runner execute anything — whether the
  // request comes with no credentials, a wrong token, or the "simple request"
  // shape a web page can send without a CORS preflight.
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { ctx, tools } from "@trama-dev/runtime";
const url = "http://127.0.0.1:" + process.env.TRAMA_PORT + "/tools/shell";
const body = JSON.stringify({ command: "echo intruder > intruder.txt" });
const attempts = [
  { "Content-Type": "application/json" },
  { "Content-Type": "application/json", "Authorization": "Bearer " + "0".repeat(64) },
  { "Content-Type": "text/plain" },
];
const statuses = [];
for (const headers of attempts) {
  statuses.push((await fetch(url, { method: "POST", headers, body })).status);
}
// The real client still works.
const legit = await tools.shell("echo ok");
await tools.write("ipc-auth.txt", statuses.join(",") + " " + legit.stdout.trim());
await ctx.done();`,
  });

  const result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 10_000 });
  assert.equal(result.status, "done");
  assert.equal(readFileSync(join(projectDir, "ipc-auth.txt"), "utf-8"), "401,401,401 ok");
  assert.equal(existsSync(join(projectDir, "intruder.txt")), false, "an unauthenticated request must not run a command");
});

test("RUNTIME_TYPES stays in sync with types.ts public interfaces", () => {
  const typesSource = readFileSync(
    join(REPO_ROOT, "packages", "runtime", "src", "types.ts"), "utf-8",
  );
  const extractInterface = (source, name, exported) => {
    const pattern = new RegExp(`${exported ? "export\\s+" : ""}interface\\s+${name}\\b`);
    const match = pattern.exec(source);
    assert.ok(match, `${exported ? "types.ts" : "RUNTIME_TYPES"} missing interface ${name}`);

    const openBrace = source.indexOf("{", match.index);
    assert.notEqual(openBrace, -1, `missing opening brace for interface ${name}`);

    let depth = 0;
    for (let i = openBrace; i < source.length; i++) {
      if (source[i] === "{") depth += 1;
      if (source[i] === "}") depth -= 1;
      if (depth === 0) {
        return source.slice(match.index, i + 1);
      }
    }

    throw new Error(`unterminated interface ${name}`);
  };

  const normalizeInterface = (source) => source
    .replace(/\/\*\*[\s\S]*?\*\//g, "")
    .replace(/\bexport\s+/g, "")
    .replace(/;/g, "")
    .replace(/\s+/g, " ")
    .trim();

  for (const iface of ["Ctx", "Agent", "Tools", "ShellResult"]) {
    const actual = normalizeInterface(extractInterface(typesSource, iface, true));
    const promptSummary = normalizeInterface(extractInterface(RUNTIME_TYPES, iface, false));
    assert.equal(promptSummary, actual, `RUNTIME_TYPES interface drift for ${iface}`);
  }
});
