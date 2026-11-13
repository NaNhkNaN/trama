import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync, symlinkSync, statSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { createServer } from "net";
import { llm } from "./fake-llm.mjs";
import {
  copyToHistory, createBackend, ensureProjectScaffold, installValidatedProgram, loadConfig, loadState, runProgram, RUNTIME_TYPES,
  validateProgram,
} from "../packages/runtime/dist/runner.js";
import { printJournals } from "../packages/runtime/dist/journal-view.js";
import { openJournal } from "../packages/runtime/dist/journal.js";
import {
  REPO_ROOT, captureConsole, cleanupTempDir, createProjectFixture, isAlive, makeTempDir, pidIn, readJson, startRunnerProcess, waitFor,
  withEnv, writeJson, writeText,
} from "./helpers.mjs";

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
    assert.match(result.reason, /No fix came back: repair blew up/);
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

// --- A program's time allowance ---

const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));

test("an allowance runs out only while nothing is holding it", async () => {
  const { createAllowance } = await import("../packages/runtime/dist/child-process.js");

  let spent = false;
  const allowance = createAllowance(300);
  allowance.start(() => { spent = true; });

  // Held — twice over — for far longer than the allowance.
  await pause(100);
  const releaseFirst = allowance.hold();
  const releaseSecond = allowance.hold();
  await pause(600);
  assert.equal(spent, false, "the clock must not run while it is held");

  releaseFirst();
  releaseFirst(); // releasing twice releases once
  await pause(400);
  assert.equal(spent, false, "the clock must stay stopped until every hold is released");

  // Released: what was left when it was first held — about 200ms — now runs down.
  releaseSecond();
  await pause(60);
  assert.equal(spent, false, "the time before the hold was used up, not the time during it");
  await pause(600);
  assert.equal(spent, true);
});

test("an allowance that is cancelled, or never started, does not run out", async () => {
  const { createAllowance } = await import("../packages/runtime/dist/child-process.js");

  let spent = false;
  const cancelled = createAllowance(50);
  cancelled.start(() => { spent = true; });
  cancelled.cancel();

  const neverStarted = createAllowance(50);
  neverStarted.hold()();

  await pause(250);
  assert.equal(spent, false);
});

test("an allowance can be longer than a single timer can measure", async () => {
  const { createAllowance } = await import("../packages/runtime/dist/child-process.js");

  // More than 2^31 ms: handed to a timer as it is, it would run out at once.
  let spent = false;
  const allowance = createAllowance(3_000_000_000);
  allowance.start(() => { spent = true; });
  await pause(150);
  allowance.cancel();
  assert.equal(spent, false);
});

// --- Stopping a run from outside ---

test("a run that is stopped ends as failed, with its program gone and no repair attempted", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));

  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { writeFileSync } from "fs";
writeFileSync("program.pid", String(process.pid));
setInterval(() => {}, 1000);
await new Promise(() => {});`,
  });

  const originalRepair = llm.repair;
  let repairs = 0;
  llm.repair = async () => { repairs += 1; throw new Error("no fix should have been asked for"); };

  try {
    const stop = new AbortController();
    const run = runProgram({ projectDir, maxRepairAttempts: 2, timeout: 30_000, signal: stop.signal });
    await waitFor(() => pidIn(join(projectDir, "program.pid")), "the program to start");
    const programPid = pidIn(join(projectDir, "program.pid"));
    stop.abort();

    const result = await run;
    assert.equal(result.status, "failed");
    assert.match(result.reason, /was stopped/);
    assert.equal(repairs, 0, "there is nothing to repair in a program that was stopped");
    assert.equal(isAlive(programPid), false, "the program must be gone by the time the run returns");
  } finally {
    llm.repair = originalRepair;
  }
});

test("a program that exits cleanly when stopped has still not finished", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));

  // Shutting down properly on SIGTERM is what a well-behaved program does. Its
  // exit code then says nothing about whether it did what it was run for.
  createProjectFixture(projectDir, {
    scaffold: false,
    state: { __trama_yield: { reason: "earlier" } },
    programSource: `import { writeFileSync } from "fs";
process.on("SIGTERM", () => process.exit(0));
writeFileSync("program.pid", String(process.pid));
setInterval(() => {}, 1000);
await new Promise(() => {});`,
  });

  const stop = new AbortController();
  const run = runProgram({ projectDir, maxRepairAttempts: 0, timeout: 30_000, signal: stop.signal });
  await waitFor(() => pidIn(join(projectDir, "program.pid")), "the program to start");
  stop.abort();

  const result = await run;
  assert.equal(result.status, "failed");
  assert.match(result.reason, /was stopped/);
  // Nothing was concluded from the run: it is still the resumption it was.
  assert.deepEqual(readJson(join(projectDir, "state.json")).__trama_yield, { reason: "earlier" });
});

test("a run stopped while a fix is being asked for gives up on the fix", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));

  const originalSource = 'throw new Error("original");';
  createProjectFixture(projectDir, { scaffold: false, programSource: originalSource });

  const stop = new AbortController();
  const originalRepair = llm.repair;
  let asked = false;
  // An LLM that never answers — until the call is cancelled.
  llm.repair = (_prompt, call) => new Promise((_resolve, reject) => {
    asked = true;
    call.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    stop.abort();
  });

  try {
    const result = await runProgram({ projectDir, maxRepairAttempts: 3, timeout: 30_000, signal: stop.signal });
    assert.equal(asked, true);
    assert.equal(result.status, "failed");
    assert.match(result.reason, /was stopped/);
    assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), originalSource);
  } finally {
    llm.repair = originalRepair;
  }
});

test("a run stopped while a fix is being tried leaves the project as it was", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  const signalDir = makeTempDir("trama-signal-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(signalDir); });

  const originalSource = 'throw new Error("original");';
  createProjectFixture(projectDir, { scaffold: false, programSource: originalSource, state: { kept: true } });

  const originalRepair = llm.repair;
  let fixes = 0;
  // The proposed fix checkpoints new state, writes a file, announces itself and then hangs.
  llm.repair = async () => {
    fixes += 1;
    return `import { ctx } from "@trama-dev/runtime";
import { writeFileSync } from "fs";
process.on("SIGTERM", () => process.exit(0)); // a clean exit must not pass for success
ctx.state.kept = false;
await ctx.checkpoint();
writeFileSync("written-by-fix.txt", "x");
writeFileSync(${JSON.stringify(join(signalDir, "fix.pid"))}, String(process.pid));
setInterval(() => {}, 1000);
await new Promise(() => {});`;
  };

  try {
    const stop = new AbortController();
    const run = runProgram({ projectDir, maxRepairAttempts: 3, timeout: 30_000, signal: stop.signal });
    await waitFor(() => pidIn(join(signalDir, "fix.pid")), "the fix to be running");
    const fixPid = pidIn(join(signalDir, "fix.pid"));
    stop.abort();

    const result = await run;
    assert.equal(result.status, "failed");
    assert.match(result.reason, /was stopped/);
    assert.equal(fixes, 1, "no further fix may be asked for once the run is stopped");
    assert.equal(isAlive(fixPid), false);
    assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), originalSource);
    assert.deepEqual(readJson(join(projectDir, "state.json")), { kept: true });
    assert.equal(existsSync(join(projectDir, "written-by-fix.txt")), false);
  } finally {
    llm.repair = originalRepair;
  }
});

// --- Process lifetime, init file security, IPC limits ---

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
  await waitFor(() => pidIn(join(signalDir, "shell.pid")), "the shell command to start");
  const programPid = pidIn(join(signalDir, "program.pid"));
  const shellPid = pidIn(join(signalDir, "shell.pid"));
  assert.equal(isAlive(programPid) && isAlive(shellPid), true);

  child.kill("SIGINT");
  const { signal } = await exited;
  assert.equal(signal, "SIGINT", "the runner should still die of the signal it was sent");

  await waitFor(() => !isAlive(programPid) && !isAlive(shellPid), "the program and its shell command to be gone", 5_000);
});

test("a runner that is killed outright still leaves nothing behind", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  const projectDir = makeTempDir("trama-runner-");
  const signalDir = makeTempDir("trama-signal-");
  const tempRoot = makeTempDir("trama-tmp-");
  t.after(() => { for (const dir of [fakeHome, projectDir, signalDir, tempRoot]) cleanupTempDir(dir); });

  // SIGKILL: the runner runs no code on its way out. Its program, a process the
  // program started itself and a shell command in flight are all still going,
  // and the runner's temp directory still holds the bridge secret.
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { tools } from "@trama-dev/runtime";
import { spawn } from "child_process";
import { writeFileSync } from "fs";
const own = spawn("sleep", ["60"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(join(signalDir, "program.pid"))}, String(process.pid));
writeFileSync(${JSON.stringify(join(signalDir, "own.pid"))}, String(own.pid));
await tools.shell("echo $$ > ${join(signalDir, "shell.pid")}; sleep 60", { timeout: 60000 });`,
  });

  const { child, exited } = startRunnerProcess(fakeHome, projectDir, { env: { TMPDIR: tempRoot } });
  const pidFiles = ["program.pid", "own.pid", "shell.pid"].map(name => join(signalDir, name));
  await waitFor(() => pidFiles.every(pidIn), "the program and what it started to be running");
  const pids = pidFiles.map(pidIn);
  // (Other tools keep things in the temp directory too; trama's own are named for it.)
  const ownTempDirs = () => readdirSync(tempRoot).filter(name => name.startsWith("trama-"));
  assert.notDeepEqual(ownTempDirs(), [], "the runner should have a temp directory while it runs");

  child.kill("SIGKILL");
  await exited;

  await waitFor(() => !pids.some(isAlive), "everything the runner started to be stopped", 5_000);
  await waitFor(() => ownTempDirs().length === 0, "the runner's temp directories to be removed", 5_000);
});

test("a program that ignores being asked to stop does not survive a stopped runner", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  const projectDir = makeTempDir("trama-runner-");
  const signalDir = makeTempDir("trama-signal-");
  t.after(() => { cleanupTempDir(fakeHome); cleanupTempDir(projectDir); cleanupTempDir(signalDir); });

  // A runner asks before it kills, so that a program can stop what it started.
  // One that will not go is killed once the grace period is over — by then the
  // runner itself is long gone.
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { writeFileSync } from "fs";
process.on("SIGTERM", () => {});
writeFileSync(${JSON.stringify(join(signalDir, "program.pid"))}, String(process.pid));
setInterval(() => {}, 1000);
await new Promise(() => {});`,
  });

  const { child, exited } = startRunnerProcess(fakeHome, projectDir);
  await waitFor(() => pidIn(join(signalDir, "program.pid")), "the program to start");
  const programPid = pidIn(join(signalDir, "program.pid"));

  child.kill("SIGINT");
  await exited;
  await waitFor(() => !isAlive(programPid), "the program to be killed", 12_000);
});

test("a program gets to act on being asked to stop, even when it is busy", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  const projectDir = makeTempDir("trama-runner-");
  const signalDir = makeTempDir("trama-signal-");
  t.after(() => { cleanupTempDir(fakeHome); cleanupTempDir(projectDir); cleanupTempDir(signalDir); });

  // Working in stretches of a fifth of a second, the program cannot answer a
  // signal at once. It still has the whole grace period to.
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { writeFileSync } from "fs";
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(join(signalDir, "stopped-cleanly"))}, "");
  process.exit(0);
});
writeFileSync(${JSON.stringify(join(signalDir, "program.pid"))}, String(process.pid));
setInterval(() => { const until = Date.now() + 200; while (Date.now() < until); }, 0);`,
  });

  const { child, exited } = startRunnerProcess(fakeHome, projectDir);
  await waitFor(() => pidIn(join(signalDir, "program.pid")), "the program to start");

  child.kill("SIGINT");
  await exited;
  await waitFor(() => existsSync(join(signalDir, "stopped-cleanly")), "the program to act on SIGTERM", 5_000);
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
    maxRepairAttempts: 1,
    setup: `llm.repair = async () => ${JSON.stringify(fix)};`,
  });

  await waitFor(() => pidIn(join(signalDir, "fix.pid")), "the fix to be running");
  const fixPid = pidIn(join(signalDir, "fix.pid"));
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

for (const [ending, lastLine] of [["finished", "await ctx.done();"], ["crashed", 'throw new Error("crash");']]) {
  test(`what a program started itself does not outlive a run that ${ending}`, async (t) => {
    const projectDir = makeTempDir("trama-runner-");
    t.after(() => cleanupTempDir(projectDir));

    // Not a shell command run through tools.shell(): a process of the program's own.
    createProjectFixture(projectDir, {
      scaffold: false,
      programSource: `import { ctx } from "@trama-dev/runtime";
import { spawn } from "child_process";
import { writeFileSync } from "fs";
const child = spawn("sleep", ["60"], { stdio: "ignore" });
child.unref();
writeFileSync("child.pid", String(child.pid));
${lastLine}`,
    });

    await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 20_000 });
    const childPid = pidIn(join(projectDir, "child.pid"));
    assert.ok(childPid, "the program should have started its process");
    await waitFor(() => !isAlive(childPid), "the program's own process to be stopped", 5_000);
  });
}

test("a run does not return while something it started is still running", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));

  // A background job that ignores being asked to stop. It has to be killed —
  // and the run must not be reported over before it is: whoever called is
  // about to merge, or delete, the directory it is working in.
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { ctx, tools } from "@trama-dev/runtime";
await tools.shell("nohup sh -c 'trap \\"\\" TERM; echo $$ > job.pid; while :; do sleep 1; done' >/dev/null 2>&1 &");
while (!(await tools.read("job.pid").catch(() => "")).trim()) await new Promise(resolve => setTimeout(resolve, 20));
await ctx.done();`,
  });

  const result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 20_000 });
  assert.equal(result.status, "done");
  const jobPid = pidIn(join(projectDir, "job.pid"));
  assert.ok(jobPid, "the job should have started");
  // (A moment's allowance: a killed process is still listed until it has been collected.)
  await waitFor(() => !isAlive(jobPid), "the job to be gone once the run has returned", 500);
});

test("a process that outlives a program on purpose does not keep its run from ending", { timeout: 30_000 }, async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  let detachedPid = null;
  t.after(() => {
    if (detachedPid) { try { process.kill(detachedPid, "SIGKILL"); } catch { /* already gone */ } }
    cleanupTempDir(projectDir);
  });

  // Detached, so in a process group of its own and out of the runner's reach —
  // but still holding the program's output pipes open.
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { ctx } from "@trama-dev/runtime";
import { spawn } from "child_process";
import { writeFileSync } from "fs";
const child = spawn("sleep", ["25"], { detached: true, stdio: "inherit" });
child.unref();
writeFileSync("detached.pid", String(child.pid));
await ctx.done();`,
  });

  const started = Date.now();
  const result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 20_000 });
  detachedPid = pidIn(join(projectDir, "detached.pid"));

  assert.equal(result.status, "done");
  assert.ok(Date.now() - started < 10_000, "the run should end with the program, not with what it left behind");
  assert.equal(isAlive(detachedPid), true, "what a program detaches is left alone");
});

test("a long-running program that does not handle SIGTERM is still a valid program", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { scaffold: false });

  // Validation stops a program once it has been ready for a while. Dying of
  // that signal is the expected end, whether or not the program handles it.
  const candidate = `import { ctx } from "@trama-dev/runtime";
await ctx.ready();
setInterval(() => {}, 1000);
await new Promise(() => {});`;

  const validated = await validateProgram(projectDir, createBackend(loadConfig()), candidate, {
    timeout: 20_000, maxRepairAttempts: 0, maxIterations: 10,
  });
  assert.equal(validated.source, candidate);
});

test("validating a program that runs others goes as far as its own work, and runs none of them", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  const participantDir = makeTempDir("trama-runner-participant-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(participantDir); });
  createProjectFixture(projectDir, { scaffold: false });

  // A participant that would leave a mark if it were run — and that is broken,
  // so a real run would also send it to be repaired.
  createProjectFixture(participantDir, {
    scaffold: false,
    programSource: `import { writeFileSync } from "fs";
writeFileSync("was-run.txt", "");
throw new Error("the participant is broken");`,
  });

  // The candidate does some work of its own, hands off to two participants at
  // once — one that exists, one named by a path that does not resolve from
  // where it is being validated — and would fail outright after that.
  const candidate = `import { tools } from "@trama-dev/runtime";
import { Session } from "@trama-dev/session";
await tools.write("own-work.txt", "done before the hand-off");
const session = await Session.create({ workspace: "./workspace" });
const real = session.spawn("real", { projectDir: ${JSON.stringify(participantDir)} });
const elsewhere = session.spawn("elsewhere", { projectDir: "../not-next-to-the-copy" });
await Promise.all([real.wait(), elsewhere.wait()]);
throw new Error("reached only when the program is run for real");`;

  const originalRepair = llm.repair;
  llm.repair = async () => { throw new Error("nothing should have been sent for repair"); };
  try {
    const validated = await validateProgram(projectDir, createBackend(loadConfig()), candidate, {
      timeout: 20_000, maxRepairAttempts: 1, maxIterations: 10,
    });
    assert.equal(validated.source, candidate);
    assert.equal(validated.repairedError, undefined);
  } finally {
    llm.repair = originalRepair;
  }
  assert.equal(existsSync(join(participantDir, "was-run.txt")), false, "a validation must not run other programs");
  assert.equal(existsSync(join(projectDir, "own-work.txt")), false, "and it still leaves the project itself alone");
});

test("how a program goes down when a validation cuts it off at a hand-off does not count against it", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  const participantDir = makeTempDir("trama-runner-participant-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(participantDir); });
  createProjectFixture(projectDir, { scaffold: false });
  createProjectFixture(participantDir, { scaffold: false });

  // A careful coordinator: on SIGTERM it waits for its participant before it
  // leaves. Run for real, that wait ends when the runner stops the
  // participant. In a validation the participant was never started, so the
  // wait cannot end, and the program has to be killed. It is still a valid
  // program: it got as far as a validation goes.
  const candidate = `import { Session } from "@trama-dev/session";
const session = await Session.create({ workspace: "./workspace" });
const participant = session.spawn("p", { projectDir: ${JSON.stringify(participantDir)} });
process.on("SIGTERM", async () => { await participant.wait().catch(() => {}); process.exit(0); });
await participant.wait();`;

  const validated = await validateProgram(projectDir, createBackend(loadConfig()), candidate, {
    timeout: 20_000, maxRepairAttempts: 0, maxIterations: 10,
  });
  assert.equal(validated.source, candidate);
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

// --- Installing a validated program ---

/** What a project's history holds: its version files, and the reasons in its index. */
function historyOf(projectDir) {
  const indexPath = join(projectDir, "history", "index.jsonl");
  return {
    files: readdirSync(join(projectDir, "history")).filter(name => name.endsWith(".ts")).sort(),
    reasons: existsSync(indexPath)
      ? readFileSync(indexPath, "utf-8").split("\n").filter(Boolean).map(line => JSON.parse(line).reason)
      : [],
  };
}
const leftovers = (projectDir) => readdirSync(projectDir).filter(name => name.includes(".trama-tmp-"));

test("installing a program records it and puts it in place, keeping the file's permissions", (t) => {
  const projectDir = makeTempDir("trama-install-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { programSource: "OLD" });
  chmodSync(join(projectDir, "program.ts"), 0o755);

  installValidatedProgram(projectDir, { source: "NEW", repairedError: "it crashed" }, "update", "make it new");

  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), "NEW");
  assert.equal(statSync(join(projectDir, "program.ts")).mode & 0o777, 0o755);
  assert.deepEqual(historyOf(projectDir), { files: ["0001.ts"], reasons: ["update-repair", "update"] });
  assert.equal(readFileSync(join(projectDir, "history", "0001.ts"), "utf-8"), "NEW");
  assert.deepEqual(leftovers(projectDir), []);
});

test("a program that cannot be put in place leaves no version of it on record", { skip: process.getuid?.() === 0 }, (t) => {
  const projectDir = makeTempDir("trama-install-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { programSource: "OLD" });
  copyToHistory(projectDir, "create", "the first version");
  const indexBefore = readFileSync(join(projectDir, "history", "index.jsonl"), "utf-8");

  // Its owner made it read-only: it is not replaced, and nothing else is touched.
  chmodSync(join(projectDir, "program.ts"), 0o444);
  assert.throws(() => installValidatedProgram(projectDir, { source: "NEW" }, "update", "p"),
    { code: "EACCES", message: /The program cannot be replaced: .*program\.ts is read-only/ });
  chmodSync(join(projectDir, "program.ts"), 0o644);
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), "OLD");
  assert.deepEqual(historyOf(projectDir).files, ["0001.ts"]);
  assert.equal(readFileSync(join(projectDir, "history", "index.jsonl"), "utf-8"), indexBefore);
  assert.deepEqual(leftovers(projectDir), []);
});

test("a version recorded for a program that then cannot take its place is taken back", (t) => {
  const projectDir = makeTempDir("trama-install-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { programSource: "OLD" });
  copyToHistory(projectDir, "create", "the first version");
  const indexBefore = readFileSync(join(projectDir, "history", "index.jsonl"), "utf-8");

  // A directory where the program goes: everything up to the last step works, and the last step cannot.
  rmSync(join(projectDir, "program.ts"));
  mkdirSync(join(projectDir, "program.ts"));
  assert.throws(() => installValidatedProgram(projectDir, { source: "NEW", repairedError: "e" }, "update", "p"));

  assert.deepEqual(historyOf(projectDir).files, ["0001.ts"], "the version file written for it is gone");
  assert.equal(readFileSync(join(projectDir, "history", "index.jsonl"), "utf-8"), indexBefore, "and so are its lines in the index");
  assert.deepEqual(leftovers(projectDir), []);
});

test("a version that cannot be recorded is not installed", { skip: process.getuid?.() === 0 }, (t) => {
  const projectDir = makeTempDir("trama-install-");
  t.after(() => { chmodSync(join(projectDir, "history", "index.jsonl"), 0o644); cleanupTempDir(projectDir); });
  createProjectFixture(projectDir, { programSource: "OLD" });
  writeText(join(projectDir, "history", "index.jsonl"), "");
  chmodSync(join(projectDir, "history", "index.jsonl"), 0o444);

  assert.throws(() => installValidatedProgram(projectDir, { source: "NEW" }, "create", "p"), { code: "EACCES" });
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), "OLD");
  assert.deepEqual(historyOf(projectDir), { files: [], reasons: [] });
  assert.deepEqual(leftovers(projectDir), []);
});

test("a program that is a link inside the project is written through the link", (t) => {
  const projectDir = makeTempDir("trama-install-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { programSource: "OLD" });
  rmSync(join(projectDir, "program.ts"));
  writeText(join(projectDir, "src", "real.ts"), "OLD");
  symlinkSync(join("src", "real.ts"), join(projectDir, "program.ts"));

  installValidatedProgram(projectDir, { source: "NEW" }, "update", "p");

  assert.equal(lstatSync(join(projectDir, "program.ts")).isSymbolicLink(), true);
  assert.equal(readFileSync(join(projectDir, "src", "real.ts"), "utf-8"), "NEW");
});

test("a program whose place is the project directory itself is not installed, and nothing is put beside the project", (t) => {
  const parent = makeTempDir("trama-install-");
  t.after(() => cleanupTempDir(parent));
  const projectDir = join(parent, "project");
  createProjectFixture(projectDir, { programSource: "OLD" });
  rmSync(join(projectDir, "program.ts"));
  symlinkSync(".", join(projectDir, "program.ts"));

  assert.throws(() => installValidatedProgram(projectDir, { source: "NEW" }, "update", "p"), /The program cannot be replaced: .*project is a directory\./);
  assert.deepEqual(readdirSync(parent), ["project"]);
  assert.deepEqual(historyOf(projectDir), { files: [], reasons: [] });
});

test("a program that is a link to a file in a directory not made yet is installed there", (t) => {
  const projectDir = makeTempDir("trama-install-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { programSource: "OLD" });
  rmSync(join(projectDir, "program.ts"));
  symlinkSync(join("src", "main.ts"), join(projectDir, "program.ts"));

  installValidatedProgram(projectDir, { source: "NEW" }, "create", "p");
  assert.equal(readFileSync(join(projectDir, "src", "main.ts"), "utf-8"), "NEW");
  assert.equal(lstatSync(join(projectDir, "program.ts")).isSymbolicLink(), true);
});

// --- meta.json ---

test("a meta.json that is not what a run needs is refused by name", async (t) => {
  const projectDir = makeTempDir("trama-meta-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { scaffold: false });
  const run = () => runProgram({ projectDir, maxRepairAttempts: 0, timeout: 20_000 });

  writeText(join(projectDir, "meta.json"), "{ not json");
  await assert.rejects(run, /Malformed meta\.json in .*Parse error/s);
  writeText(join(projectDir, "meta.json"), "[]");
  await assert.rejects(run, /Malformed meta\.json in .*expected a JSON object but got an array/s);
  writeText(join(projectDir, "meta.json"), "null");
  await assert.rejects(run, /Malformed meta\.json in .*expected a JSON object but got null/s);
  writeJson(join(projectDir, "meta.json"), { createdAt: "2026-01-01" });
  await assert.rejects(run, /Malformed meta\.json in .*"input" is missing/s);
  // Nothing was run, and nothing recorded as a run.
  assert.equal(existsSync(join(projectDir, "output.txt")), false);

  // The model a project names is held to what the global config is held to.
  writeJson(join(projectDir, "meta.json"), { input: {}, model: 5 });
  await assert.rejects(run, /Invalid meta\.json in .*"model" must be a non-empty string \(got 5\)/s);

  // Not a quiet return to another model, either: an empty or mistyped name is said to be one.
  for (const model of ["", 0, false]) {
    writeJson(join(projectDir, "meta.json"), { input: {}, model });
    await assert.rejects(run, /Invalid meta\.json in .*"model" must be a non-empty string/s, `model: ${JSON.stringify(model)}`);
  }
  writeJson(join(projectDir, "meta.json"), { input: {}, provider: "" });
  await assert.rejects(run, /Invalid meta\.json in .*"provider" must be a non-empty string/s);
  // null is a field left out.
  writeJson(join(projectDir, "meta.json"), { input: {}, model: null, provider: null });
  assert.equal((await run()).status, "done");

  // An input with nothing in it is still an input.
  writeJson(join(projectDir, "meta.json"), { input: {} });
  assert.equal((await run()).status, "done");
});

test("installing a program keeps the permissions of the one it replaces, whatever the umask", (t) => {
  const projectDir = makeTempDir("trama-install-");
  const umask = process.umask(0o022);
  t.after(() => { process.umask(umask); cleanupTempDir(projectDir); });
  createProjectFixture(projectDir, { programSource: "OLD" });
  chmodSync(join(projectDir, "program.ts"), 0o664);

  installValidatedProgram(projectDir, { source: "NEW" }, "update", "p");
  assert.equal(statSync(join(projectDir, "program.ts")).mode & 0o777, 0o664);
});

test("taking a version back leaves alone what another run recorded meanwhile", async (t) => {
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const projectDir = makeTempDir("trama-install-");
  const realRename = fs.renameSync;
  t.after(() => { fs.renameSync = realRename; syncBuiltinESMExports(); cleanupTempDir(projectDir); });
  createProjectFixture(projectDir, { programSource: "OLD" });
  const indexPath = join(projectDir, "history", "index.jsonl");

  // The last step fails — after another run of the project has added a line of its own to the index.
  const theirs = JSON.stringify({ version: 2, reason: "repair", error: "theirs" }) + "\n";
  fs.renameSync = () => { fs.appendFileSync(indexPath, theirs); throw new Error("cannot take its place"); };
  syncBuiltinESMExports();
  assert.throws(() => installValidatedProgram(projectDir, { source: "NEW" }, "update", "p"), /cannot take its place/);

  const lines = readFileSync(indexPath, "utf-8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual(lines.map(line => line.reason), ["update", "repair"], "their line is still there — and so, then, is ours");
  assert.equal(existsSync(join(projectDir, "history", "0001.ts")), true, "a line on record keeps the version it names");
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), "OLD");
  assert.deepEqual(leftovers(projectDir), []);
});

test("a version is never recorded over a version file that is already there", (t) => {
  const projectDir = makeTempDir("trama-install-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { programSource: "OLD" });
  // Two runs that pick the same number: the file of the first must survive the second.
  const fsPromise = import("node:fs");
  return fsPromise.then(async ({ default: fs }) => {
    const { syncBuiltinESMExports } = await import("node:module");
    const realReaddir = fs.readdirSync;
    writeText(join(projectDir, "history", "0001.ts"), "THEIRS");
    fs.readdirSync = (path, ...rest) => String(path).endsWith("history") ? [] : realReaddir(path, ...rest);
    syncBuiltinESMExports();
    try {
      assert.throws(() => installValidatedProgram(projectDir, { source: "NEW" }, "update", "p"), { code: "EEXIST" });
    } finally {
      fs.readdirSync = realReaddir;
      syncBuiltinESMExports();
    }
    assert.equal(readFileSync(join(projectDir, "history", "0001.ts"), "utf-8"), "THEIRS");
    assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), "OLD");
    assert.equal(existsSync(join(projectDir, "history", "index.jsonl")), false);
  });
});

test("a file that holds null where an object is expected is said to hold null", (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { state: "null" });
  assert.throws(() => loadState(projectDir), /Expected a JSON object but got null/);
  writeText(join(projectDir, "state.json"), "[]");
  assert.throws(() => loadState(projectDir), /Expected a JSON object but got an array/);
});

test("the bridge answers a request it cannot read as a request with 400, and carries nothing out", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { ctx, tools } from "@trama-dev/runtime";
import { readFileSync } from "fs";
const { token } = JSON.parse(readFileSync(process.env.TRAMA_INIT, "utf-8"));
const post = (endpoint, body) => fetch("http://127.0.0.1:" + process.env.TRAMA_PORT + endpoint, {
  method: "POST", headers: { Authorization: "Bearer " + token }, body,
}).then(async res => res.status + " " + (await res.text()));
const answers = [];
// Not an object, though each of these is JSON; and one that is not JSON at all.
for (const body of ["null", '"text"', "[]", "7", "{ not json"]) answers.push(await post("/ctx/ready", body));
await tools.write("answers.json", JSON.stringify(answers));
await ctx.done();`,
  });

  const result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 10_000 });
  assert.equal(result.status, "done");
  const answers = readJson(join(projectDir, "answers.json"));
  for (const answer of answers.slice(0, 4)) assert.equal(answer, "400 The request body must be a JSON object");
  assert.equal(answers[4], "400 The request body is not valid JSON");
  // ready() was never called on the program's behalf.
  assert.equal(readFileSync(join(projectDir, "logs", "latest.jsonl"), "utf-8").includes('"ready"'), false);
});

test("a repair that worked takes the program's place in one move, keeping its permissions", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { scaffold: false, programSource: 'throw new Error("boom");' });
  chmodSync(join(projectDir, "program.ts"), 0o755);
  const fixed = `import { ctx } from "@trama-dev/runtime";\nawait ctx.done();\n`;
  const originalRepair = llm.repair;
  llm.repair = async () => fixed;
  t.after(() => { llm.repair = originalRepair; });

  const result = await runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 });
  assert.equal(result.status, "done");
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), fixed.trim());
  assert.equal(statSync(join(projectDir, "program.ts")).mode & 0o777, 0o755);
  assert.deepEqual(leftovers(projectDir), []);
});

// --- A repair that worked, and a project that will not take it ---

/** A project whose program fails, and a fix for it that writes state and a file. */
function repairableProject(t) {
  const projectDir = makeTempDir("trama-runner-");
  createProjectFixture(projectDir, { scaffold: false, programSource: 'throw new Error("boom");', state: { n: 1 } });
  const fixed = `import { ctx, tools } from "@trama-dev/runtime";
ctx.state.n = 2;
await tools.write("output.txt", "written by the fix");
await ctx.done();
`;
  const originalRepair = llm.repair;
  llm.repair = async () => fixed;
  t.after(() => { llm.repair = originalRepair; cleanupTempDir(projectDir); });
  return { projectDir, fixed };
}

test("a fix that cannot be put in place leaves nothing of its run in the project", async (t) => {
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const { projectDir } = repairableProject(t);
  const realRename = fs.renameSync;
  t.after(() => { fs.renameSync = realRename; syncBuiltinESMExports(); });

  // The one move that puts the program in place fails.
  fs.renameSync = (from, to) => {
    if (String(to) === join(realpathSync(projectDir), "program.ts")) throw new Error("cannot take its place");
    return realRename(from, to);
  };
  syncBuiltinESMExports();
  await assert.rejects(runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 }), /cannot take its place/);

  // The fixed program ran to done — on a copy. The project has the old program, and so the old state.
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), 'throw new Error("boom");');
  assert.deepEqual(readJson(join(projectDir, "state.json")), { n: 1 });
  assert.equal(existsSync(join(projectDir, "output.txt")), false);
  assert.deepEqual(leftovers(projectDir), []);
});

test("a fix is put in place by one move only: the merge of what it wrote does not write the program", async (t) => {
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const { projectDir, fixed } = repairableProject(t);
  const realCopy = fs.copyFileSync;
  t.after(() => { fs.copyFileSync = realCopy; syncBuiltinESMExports(); });

  // Files are written where their paths lead, and the temp directory is reached through a link on some systems.
  const realDir = realpathSync(projectDir);
  const copiedOver = [];
  fs.copyFileSync = (from, to, ...rest) => {
    if (String(to).startsWith(realDir)) copiedOver.push(String(to).slice(realDir.length + 1));
    return realCopy(from, to, ...rest);
  };
  syncBuiltinESMExports();
  const result = await runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 });

  assert.equal(result.status, "done");
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), fixed.trim());
  assert.deepEqual(readJson(join(projectDir, "state.json")).n, 2);
  assert.equal(copiedOver.includes("program.ts"), false, `copied into the project: ${copiedOver}`);
  assert.equal(copiedOver.includes("output.txt"), true);
});

test("a version whose line never reached the index is taken back, though the index cannot be read", { skip: process.getuid?.() === 0 }, (t) => {
  const projectDir = makeTempDir("trama-install-");
  const indexPath = join(projectDir, "history", "index.jsonl");
  t.after(() => { chmodSync(indexPath, 0o644); cleanupTempDir(projectDir); });
  createProjectFixture(projectDir, { programSource: "OLD" });
  writeText(indexPath, "");
  chmodSync(indexPath, 0o000);

  assert.throws(() => installValidatedProgram(projectDir, { source: "NEW" }, "update", "p"), { code: "EACCES" });
  assert.deepEqual(readdirSync(join(projectDir, "history")), ["index.jsonl"], "the version file written for it is gone");
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), "OLD");
});

test("null in the global config is a field left out, as it is in a project's", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));
  writeJson(join(fakeHome, ".trama", "config.json"), { model: null, journalRuns: 3 });
  await withEnv({ HOME: fakeHome }, async () => {
    const config = loadConfig();
    assert.equal(typeof config.model, "string");
    assert.ok(config.model.length > 0);
    assert.equal(config.journalRuns, 3);
  });
});

// --- A program that may not be replaced ---

test("a program its owner made read-only is run; when it fails, no fix is asked for or tried", { skip: process.getuid?.() === 0 }, async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  createProjectFixture(projectDir, { scaffold: false, programSource: 'throw new Error("boom");' });
  chmodSync(join(projectDir, "program.ts"), 0o444);
  let asked = 0;
  const originalRepair = llm.repair;
  llm.repair = async () => { asked += 1; return `import { ctx } from "@trama-dev/runtime";\nawait ctx.done();\n`; };
  t.after(() => { llm.repair = originalRepair; cleanupTempDir(projectDir); });

  // A fix could not become the program, so the model is not paid for one and none is run.
  const result = await runProgram({ projectDir, maxRepairAttempts: 2, timeout: 20_000 });
  assert.equal(result.status, "failed");
  assert.match(result.reason, /no repair was tried\. The program cannot be replaced: .*program\.ts is read-only\.\n[\s\S]*boom/);
  assert.equal(asked, 0);
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), 'throw new Error("boom");');
});

test("a candidate is validated, and repaired, in a copy of a project whose own program is read-only", { skip: process.getuid?.() === 0 }, async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  createProjectFixture(projectDir, { scaffold: false, programSource: "OLD" });
  chmodSync(join(projectDir, "program.ts"), 0o444);
  const fixed = `import { ctx } from "@trama-dev/runtime";\nawait ctx.done();\n`;
  const originalRepair = llm.repair;
  llm.repair = async () => fixed;
  t.after(() => { llm.repair = originalRepair; cleanupTempDir(projectDir); });

  // What the project's program may have done to it is said of the project. The copy's is the copy's own.
  const validated = await validateProgram(projectDir, createBackend(loadConfig()), 'throw new Error("the candidate fails");', {
    timeout: 20_000, maxRepairAttempts: 1, maxIterations: 10,
  });
  assert.equal(validated.source, fixed.trim());
  assert.match(validated.repairedError, /the candidate fails/);

  // The project was not touched — and still will not take a new program.
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), "OLD");
  assert.equal(statSync(join(projectDir, "program.ts")).mode & 0o777, 0o444);
  assert.throws(() => installValidatedProgram(projectDir, validated, "update", "p"), /The program cannot be replaced: .*program\.ts is read-only/);
  assert.deepEqual(leftovers(projectDir), []);
});

// --- What a repair leaves as the program ---

test("the program a repair leaves is the program as its run left it", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  createProjectFixture(projectDir, { scaffold: false, programSource: 'throw new Error("boom");' });
  const next = `import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ generation: 2 });\n`;
  // The fix writes its own successor, as a program that programs itself does.
  const fixed = `import { ctx } from "@trama-dev/runtime";
import { writeFileSync } from "fs";
writeFileSync("program.ts", ${JSON.stringify(next)});
await ctx.done({ generation: 1 });
`;
  const originalRepair = llm.repair;
  llm.repair = async () => fixed;
  t.after(() => { llm.repair = originalRepair; cleanupTempDir(projectDir); });

  const result = await runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 });
  assert.deepEqual(result.result, { generation: 1 });
  // In an ordinary run the program it wrote would be the project's program. It is here too —
  // and it is what goes on record as the repair.
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), next);
  assert.equal(readFileSync(join(projectDir, "history", "0001.ts"), "utf-8"), next);
  assert.deepEqual(leftovers(projectDir), []);
});

test("a repair of a program that is a link inside the project goes through the link, and nothing else writes it", async (t) => {
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const { projectDir, fixed } = repairableProject(t);
  rmSync(join(projectDir, "program.ts"));
  writeText(join(projectDir, "src", "main.ts"), 'throw new Error("boom");');
  symlinkSync(join("src", "main.ts"), join(projectDir, "program.ts"));
  const realCopy = fs.copyFileSync;
  t.after(() => { fs.copyFileSync = realCopy; syncBuiltinESMExports(); });

  const realDir = realpathSync(projectDir);
  const copiedOver = [];
  fs.copyFileSync = (from, to, ...rest) => {
    if (String(to).startsWith(realDir)) copiedOver.push(String(to).slice(realDir.length + 1));
    return realCopy(from, to, ...rest);
  };
  syncBuiltinESMExports();
  const result = await runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 });

  assert.equal(result.status, "done");
  assert.equal(lstatSync(join(projectDir, "program.ts")).isSymbolicLink(), true);
  assert.equal(readFileSync(join(projectDir, "src", "main.ts"), "utf-8"), fixed.trim());
  // The program was put in place once, by the one move. The merge carries what the run did, and
  // putting the fix into the copy is not something the run did — under whatever name the file has.
  assert.deepEqual(copiedOver.filter(path => path !== "output.txt" && path !== "state.json" && !path.startsWith("logs/")), []);
  assert.equal(copiedOver.includes("output.txt"), true);
  assert.deepEqual(readJson(join(projectDir, "state.json")).n, 2);
});

// --- What crosses the bridge ---

test("the bridge holds every field of a call to the kind it is declared as", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { ctx, tools } from "@trama-dev/runtime";
import { readFileSync } from "fs";
const { token } = JSON.parse(readFileSync(process.env.TRAMA_INIT, "utf-8"));
const post = (endpoint, body) => fetch("http://127.0.0.1:" + process.env.TRAMA_PORT + endpoint, {
  method: "POST", headers: { Authorization: "Bearer " + token }, body: JSON.stringify(body),
}).then(async res => res.status + " " + (await res.text()));
const answers = [];
for (const [endpoint, body] of [
  ["/tools/shell", { command: "true", cwd: 7 }],
  ["/tools/shell", { command: "true", timeout: "soon" }],
  ["/agent/instruct", { prompt: "p", system: 7 }],
  ["/tools/fetch", { url: "http://127.0.0.1:1/", headers: 7 }],
  ["/workspace/observe", { pattern: "a", dir: "/nowhere", expect: "one" }],
  ["/run/program", { projectDir: "/nowhere", timeout: "soon" }],
  ["/run/program", { projectDir: "/nowhere", maxRepairAttempts: "many" }],
  ["/ctx/done", { state: [] }],
  // A field the call does not declare is not an error; an optional one given as null was left out.
  ["/tools/shell", { command: "echo carried out", stdio: "inherit", cwd: null, timeout: null }],
]) answers.push(await post(endpoint, body));
await tools.write("answers.json", JSON.stringify(answers));
await ctx.done();`,
  });

  const result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 20_000 });
  assert.equal(result.status, "done");
  assert.deepEqual(readJson(join(projectDir, "answers.json")), [
    "400 Invalid field: cwd (expected string or undefined)",
    "400 Invalid field: timeout (expected number or undefined)",
    "400 Invalid field: system (expected string or undefined)",
    "400 Invalid field: headers (expected object or undefined)",
    "400 Invalid field: expect (expected number or undefined)",
    "400 Invalid field: timeout (expected number or undefined)",
    "400 Invalid field: maxRepairAttempts (expected number or undefined)",
    "400 Missing or invalid field: state (expected object)",
    '200 {"result":{"exitCode":0,"stdout":"carried out\\n","stderr":""}}',
  ]);
});

test("a number JSON cannot carry is refused where the call is made, not sent on as a field left out", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  const other = makeTempDir("trama-runner-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(other); });
  createProjectFixture(other, { scaffold: false, programSource: `import { ctx } from "@trama-dev/runtime";\nawait ctx.done();\n` });
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { ctx, tools } from "@trama-dev/runtime";
import { runProgram } from "@trama-dev/runtime/runner";
const said = (call) => call().then(() => "carried out", err => err.message);
const outcome = {
  shell: await said(() => tools.shell("true", { timeout: Infinity })),
  run: await said(() => runProgram({ projectDir: ${JSON.stringify(other)}, timeout: NaN })),
  args: await said(() => runProgram({ projectDir: ${JSON.stringify(other)}, args: { limit: -Infinity } })),
  list: await said(() => runProgram({ projectDir: ${JSON.stringify(other)}, args: { limits: [1, NaN] } })),
};
// A log line is not a call that does anything: it takes what it is given, as JSON makes of it.
await ctx.log("numbers", { n: NaN });
await ctx.done(outcome);`,
  });

  const result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 20_000 });
  assert.deepEqual(result.result, {
    shell: "timeout is Infinity, which cannot be sent to the runner (/tools/shell)",
    run: "timeout is NaN, which cannot be sent to the runner (/run/program)",
    args: "limit is -Infinity, which cannot be sent to the runner (/run/program)",
    list: "item 1 of a list is NaN, which cannot be sent to the runner (/run/program)",
  });
  const logged = readFileSync(join(projectDir, "logs", "latest.jsonl"), "utf-8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(logged.find(line => line.message === "numbers").data, { n: null });
  // Outside a program the same run is refused too, by the runner itself.
  await assert.rejects(runProgram({ projectDir: other, timeout: NaN }), /Invalid timeout: NaN/);
});

test("a project nothing can be created in is run; when its program fails, no fix is asked for", { skip: process.getuid?.() === 0 }, async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  createProjectFixture(projectDir, { programSource: 'throw new Error("boom");' });
  ensureProjectScaffold(projectDir); // everything a run needs is there already
  chmodSync(projectDir, 0o555);
  let asked = 0;
  const originalRepair = llm.repair;
  llm.repair = async () => { asked += 1; return `import { ctx } from "@trama-dev/runtime";\nawait ctx.done();\n`; };
  t.after(() => { llm.repair = originalRepair; chmodSync(projectDir, 0o755); cleanupTempDir(projectDir); });

  // A new program is a new file beside the old one. Where none can be made, a fix has nowhere to go.
  const result = await runProgram({ projectDir, maxRepairAttempts: 2, timeout: 20_000 });
  assert.equal(result.status, "failed");
  assert.match(result.reason, /no repair was tried\. The program cannot be replaced: nothing can be created in /);
  assert.equal(asked, 0);
});

test("a candidate that removes its own program.ts while it is validated is still the candidate that ran", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { scaffold: false, programSource: "OLD" });
  const candidate = `import { ctx } from "@trama-dev/runtime";
import { rmSync } from "fs";
rmSync("program.ts");
await ctx.done();`;

  const validated = await validateProgram(projectDir, createBackend(loadConfig()), candidate, {
    timeout: 20_000, maxRepairAttempts: 0, maxIterations: 10,
  });
  assert.equal(validated.source, candidate);
});

// --- What a copy of a project is ---

/** The copies of projects there are in the temp directory right now. */
const copiesInTemp = () => readdirSync(tmpdir()).filter(name => /^trama-(repair|staged|validate)-/.test(name));

test("a pipe or a socket left in a project is no part of its copies: the program is repaired and validated all the same", async (t) => {
  const { projectDir, fixed } = repairableProject(t);
  execFileSync("mkfifo", [join(projectDir, "events.pipe")]);
  // A socket's path may be no longer than the system allows; a temp directory's can be.
  const server = createServer();
  const listening = await new Promise(resolve => {
    server.once("error", () => resolve(false));
    server.listen(join(projectDir, "app.sock"), () => resolve(true));
  });
  t.after(() => new Promise(resolve => listening ? server.close(resolve) : resolve()));
  if (!listening) t.diagnostic("no socket could be made here (the path is too long for one): only the pipe is tested");

  const validated = await validateProgram(projectDir, createBackend(loadConfig()), fixed, {
    timeout: 20_000, maxRepairAttempts: 0, maxIterations: 10,
  });
  assert.equal(validated.source, fixed); // as given: a candidate is not a model's reply, and is not trimmed

  const result = await runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 });
  assert.equal(result.status, "done");
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), fixed.trim());
  assert.equal(readFileSync(join(projectDir, "output.txt"), "utf-8"), "written by the fix");
  // Neither was touched, and neither was taken for something the run removed.
  assert.equal(lstatSync(join(projectDir, "events.pipe")).isFIFO(), true);
  if (listening) assert.equal(lstatSync(join(projectDir, "app.sock")).isSocket(), true);
});

test("a copy of a project is as the project is: links leading where they lead, files and directories with what they allow, no journals", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  createProjectFixture(projectDir, { scaffold: false, programSource: 'throw new Error("boom");' });
  writeText(join(projectDir, ".hidden"), "a dotfile");
  writeText(join(projectDir, "bin", "tool.sh"), "#!/bin/sh");
  chmodSync(join(projectDir, "bin", "tool.sh"), 0o750);
  mkdirSync(join(projectDir, "empty", "inside"), { recursive: true });
  mkdirSync(join(projectDir, "private"));
  chmodSync(join(projectDir, "private"), 0o700);
  symlinkSync("bin/tool.sh", join(projectDir, "to-file"));
  symlinkSync("bin", join(projectDir, "to-dir"));
  symlinkSync("../nowhere/at-all", join(projectDir, "dangling"));
  symlinkSync("/etc/hosts", join(projectDir, "absolute"));
  // The fix reports what it finds where it runs, which is the copy. What it writes is merged back.
  const fixed = `import { ctx } from "@trama-dev/runtime";
import { lstatSync, readlinkSync, existsSync, readdirSync, writeFileSync } from "fs";
const mode = (path) => (lstatSync(path).mode & 0o777).toString(8);
writeFileSync("found.json", JSON.stringify({
  hidden: existsSync(".hidden"),
  toolMode: mode("bin/tool.sh"),
  privateMode: mode("private"),
  empty: readdirSync("empty"),
  emptyInside: readdirSync("empty/inside"),
  links: ["to-file", "to-dir", "dangling", "absolute"].map(name => lstatSync(name).isSymbolicLink() && readlinkSync(name)),
  logs: readdirSync("logs"),
}));
await ctx.done();
`;
  const originalRepair = llm.repair;
  llm.repair = async () => fixed;
  t.after(() => { llm.repair = originalRepair; cleanupTempDir(projectDir); });

  const result = await runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 });
  assert.equal(result.status, "done");
  // The run has a journal by now, so the project has logs/journal — and the copy did not.
  assert.equal(existsSync(join(projectDir, "logs", "journal")), true);
  assert.deepEqual(readJson(join(projectDir, "found.json")), {
    hidden: true,
    toolMode: "750",
    privateMode: "700",
    empty: ["inside"],
    emptyInside: [],
    // Kept as written — but for the one that leaves the project by "..": from the copy that would be
    // somewhere else, so it is made to say where it leads from here.
    links: ["bin/tool.sh", "bin", join(realpathSync(projectDir), "..", "nowhere/at-all"), "/etc/hosts"],
    logs: ["latest.jsonl"],
  });
  // What the run did not touch is as it was, in the project.
  assert.equal(readlinkSync(join(projectDir, "dangling")), "../nowhere/at-all");
});

test("a fix cannot do in a copy what it could not do in the project: writing where the project forbids it fails the fix", { skip: process.getuid?.() === 0 }, async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  createProjectFixture(projectDir, { scaffold: false, programSource: 'throw new Error("boom");' });
  writeText(join(projectDir, "out", "deep", "sample.txt"), "kept");
  chmodSync(join(projectDir, "out", "deep"), 0o555);
  chmodSync(join(projectDir, "out"), 0o555);
  const originalRepair = llm.repair;
  llm.repair = async () => `import { ctx, tools } from "@trama-dev/runtime";
await tools.write("out/result.txt", "a result");
await ctx.done({ wrote: "out/result.txt" });
`;
  const before = new Set(copiesInTemp());
  t.after(() => {
    llm.repair = originalRepair;
    chmodSync(join(projectDir, "out"), 0o755);
    chmodSync(join(projectDir, "out", "deep"), 0o755);
    cleanupTempDir(projectDir);
  });

  // Were the copy more open than the project, the fix would be done there, installed — and its
  // result dropped where the merge could not write it.
  const result = await runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 });
  assert.equal(result.status, "failed");
  assert.match(result.reason, /EACCES/);
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), 'throw new Error("boom");');
  // The copies held directories that may not be written to, and are gone all the same.
  assert.deepEqual(copiesInTemp().filter(name => !before.has(name)), []);
});

test("a copy a run has closed against writing is removed all the same", { skip: process.getuid?.() === 0 }, async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  createProjectFixture(projectDir, { scaffold: false, programSource: 'throw new Error("boom");' });
  const originalRepair = llm.repair;
  llm.repair = async () => `import { ctx } from "@trama-dev/runtime";
import { chmodSync, mkdirSync, writeFileSync } from "fs";
mkdirSync("sealed/deeper", { recursive: true });
writeFileSync("sealed/deeper/file.txt", "sealed in");
chmodSync("sealed/deeper", 0o500);
chmodSync("sealed", 0o500);
await ctx.done();
`;
  const before = new Set(copiesInTemp());
  t.after(() => {
    llm.repair = originalRepair;
    for (const dir of ["sealed", "sealed/deeper"]) if (existsSync(join(projectDir, dir))) chmodSync(join(projectDir, dir), 0o755);
    cleanupTempDir(projectDir);
  });

  const result = await runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 });
  assert.equal(result.status, "done");
  assert.equal(readFileSync(join(projectDir, "sealed", "deeper", "file.txt"), "utf-8"), "sealed in");
  // The project's directories are closed as the run closed them: what it did to what they allow arrives too.
  for (const dir of ["sealed", "sealed/deeper"]) assert.equal(statSync(join(projectDir, dir)).mode & 0o777, 0o500, dir);
  assert.deepEqual(copiesInTemp().filter(name => !before.has(name)), []);
});

test("a temp directory inside the project is no place for a copy of it: no fix is asked for, and nothing is copied into itself", async (t) => {
  const { projectDir } = repairableProject(t);
  mkdirSync(join(projectDir, "tmp"));
  let asked = 0;
  const fix = llm.repair;
  llm.repair = async (...args) => { asked += 1; return fix(...args); };

  const result = await withEnv({ TMPDIR: join(projectDir, "tmp") }, () => runProgram({ projectDir, maxRepairAttempts: 2, timeout: 20_000 }));
  assert.equal(result.status, "failed");
  assert.match(result.reason, /boom[\s\S]*No fix came back: A copy of .* cannot be made inside it/);
  assert.equal(asked, 0);
  // (The loader that runs program.ts keeps a cache of its own there.)
  assert.deepEqual(readdirSync(join(projectDir, "tmp")).filter(name => name.startsWith("trama-")), []);
});

test("a project that cannot be copied is not repaired: the run fails with the reason, and no fix is asked for", { skip: process.getuid?.() === 0 }, async (t) => {
  const { projectDir } = repairableProject(t);
  writeText(join(projectDir, "secret.txt"), "nobody may read this");
  chmodSync(join(projectDir, "secret.txt"), 0o000);
  let asked = 0;
  const fix = llm.repair;
  llm.repair = async (...args) => { asked += 1; return fix(...args); };
  const before = new Set(copiesInTemp());

  // The agent that writes a fix works in a copy. Where none can be made, that is why no fix came back —
  // a result of the run, not an exception from it.
  const result = await runProgram({ projectDir, maxRepairAttempts: 2, timeout: 20_000 });
  assert.equal(result.status, "failed");
  assert.match(result.reason, /boom[\s\S]*No fix came back: EACCES/);
  assert.equal(asked, 0);
  assert.deepEqual(copiesInTemp().filter(name => !before.has(name)), []);
});

test("a program that is a link into a directory still to be made needs somewhere that directory can be made", { skip: process.getuid?.() === 0 }, (t) => {
  const projectDir = makeTempDir("trama-install-");
  t.after(() => { chmodSync(projectDir, 0o755); cleanupTempDir(projectDir); });
  createProjectFixture(projectDir, { programSource: "OLD" });
  rmSync(join(projectDir, "program.ts"));
  symlinkSync(join("src", "main.ts"), join(projectDir, "program.ts"));
  chmodSync(projectDir, 0o555);

  // Asked of the nearest directory that is there: it is where the first new thing would be made.
  assert.throws(() => installValidatedProgram(projectDir, { source: "NEW" }, "update", "p"),
    { code: "EACCES", message: /The program cannot be replaced: nothing can be created in / });
  assert.deepEqual(historyOf(projectDir), { files: [], reasons: [] });

  chmodSync(projectDir, 0o755);
  installValidatedProgram(projectDir, { source: "NEW" }, "update", "p");
  assert.equal(readFileSync(join(projectDir, "src", "main.ts"), "utf-8"), "NEW");
});

// --- A pipe where the runtime writes ---

test("a program that puts a pipe where its state or its log goes is told so, and its runner is not held up", { skip: process.getuid?.() === 0 }, async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => { cleanupTempDir(fakeHome); cleanupTempDir(projectDir); });
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { ctx } from "@trama-dev/runtime";
import { execFileSync } from "child_process";
import { rmSync, writeFileSync } from "fs";
const said = (call) => call().then(() => "carried out", err => err.message);
const pipeAt = (path) => { rmSync(path, { force: true }); execFileSync("mkfifo", [path]); };
pipeAt("state.json");
const checkpoint = await said(() => ctx.checkpoint());
rmSync("state.json");
pipeAt("logs/latest.jsonl");
const log = await said(() => ctx.log("into the pipe"));
rmSync("logs/latest.jsonl");
writeFileSync("verdict.json", JSON.stringify({ checkpoint, log }));
await ctx.done();`,
  });

  // In a process of its own: writing to a pipe nobody reads never returns, and takes with it
  // the timeout that would have ended the run.
  const { child, exited } = startRunnerProcess(fakeHome, projectDir);
  const ended = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(null), 20_000).unref())]);
  if (ended === null) child.kill("SIGKILL");
  assert.notEqual(ended, null, "the runner was held up");
  const verdict = readJson(join(projectDir, "verdict.json"));
  assert.match(verdict.checkpoint, /Not a file or a directory: state\.json/);
  assert.match(verdict.log, /Not a file or a directory: logs\/latest\.jsonl/);
});

// --- Where the runtime writes, and what counts as the same place ---

test("the links to the runtime are put inside the project: a node_modules that leads elsewhere is refused, not followed", (t) => {
  for (const linked of ["node_modules", join("node_modules", "@trama-dev")]) {
    const projectDir = makeTempDir("trama-runner-");
    const outside = makeTempDir("trama-outside-");
    const theirs = makeTempDir("trama-outside-");
    t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(outside); cleanupTempDir(theirs); });
    createProjectFixture(projectDir, { scaffold: false });
    // Out there, somebody has a link of their own under the very name the runtime would use.
    const there = linked === "node_modules" ? join(outside, "@trama-dev") : outside;
    mkdirSync(there, { recursive: true });
    symlinkSync(theirs, join(there, "runtime"));
    mkdirSync(join(projectDir, linked, ".."), { recursive: true });
    symlinkSync(outside, join(projectDir, linked));

    assert.throws(() => ensureProjectScaffold(projectDir), /Path escapes project directory via symlink: node_modules\/@trama-dev/);
    assert.deepEqual(readdirSync(there), ["runtime"], "nothing was added out there");
    assert.equal(realpathSync(join(there, "runtime")), realpathSync(theirs), "and their link is as it was");
  }
});

test("a project's journals stay out of its copies wherever logs/journal really is", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  createProjectFixture(projectDir, { scaffold: false, programSource: 'throw new Error("boom");' });
  // logs is a link to a directory elsewhere in the project: the journals are in data/logs/journal.
  mkdirSync(join(projectDir, "data", "logs"), { recursive: true });
  symlinkSync(join("data", "logs"), join(projectDir, "logs"));
  const originalRepair = llm.repair;
  llm.repair = async () => `import { ctx } from "@trama-dev/runtime";
import { existsSync, writeFileSync } from "fs";
writeFileSync("found.json", JSON.stringify(["logs/journal", "data/logs/journal"].map(dir => existsSync(dir))));
await ctx.done();
`;
  t.after(() => { llm.repair = originalRepair; cleanupTempDir(projectDir); });

  const result = await runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 });
  assert.equal(result.status, "done");
  assert.equal(readdirSync(join(projectDir, "data", "logs", "journal")).length, 1, "the run was recorded, through the link");
  assert.deepEqual(readJson(join(projectDir, "found.json")), [false, false]);
});

test("a temp directory inside the project is known for what it is, however it is spelled", async (t) => {
  const parent = makeTempDir("trama-runner-");
  const projectDir = join(parent, "MyProject");
  const fixed = `import { ctx } from "@trama-dev/runtime";\nawait ctx.done();\n`;
  createProjectFixture(projectDir, { scaffold: false, programSource: 'throw new Error("boom");' });
  mkdirSync(join(projectDir, "tmp"));
  const inOtherLetters = join(parent, "myproject", "tmp");
  let asked = 0;
  const originalRepair = llm.repair;
  llm.repair = async () => { asked += 1; return fixed; };
  t.after(() => { llm.repair = originalRepair; cleanupTempDir(parent); });
  if (!existsSync(inOtherLetters)) return t.skip("this file system tells upper case from lower");

  const result = await withEnv({ TMPDIR: inOtherLetters }, () => runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 }));
  assert.equal(result.status, "failed");
  // Refused where the walk came to it — not after the project had been copied into itself as deep as a path can go.
  assert.match(result.reason, /No fix came back: A copy of .* cannot be made inside it/);
  assert.equal(asked, 0);
});

// --- What a fix's run wrote, and what of it reached the project ---

test("a file a fix put a new one in place of arrives as it did so, though the old one could not be written to", { skip: process.getuid?.() === 0 }, async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  createProjectFixture(projectDir, { scaffold: false, programSource: 'throw new Error("boom");' });
  for (const name of ["replaced.txt", "renamed-over.txt"]) {
    writeText(join(projectDir, name), "OLD");
    chmodSync(join(projectDir, name), 0o444);
  }
  // The other way round: a file that may be written to, in a directory that may not.
  writeText(join(projectDir, "sealed", "inside.txt"), "OLD");
  chmodSync(join(projectDir, "sealed"), 0o555);
  const originalRepair = llm.repair;
  llm.repair = async () => `import { ctx } from "@trama-dev/runtime";
import { renameSync, rmSync, writeFileSync } from "fs";
rmSync("replaced.txt");
writeFileSync("replaced.txt", "NEW, in a new file", { mode: 0o640 });
writeFileSync("next.txt", "NEW, moved into place");
renameSync("next.txt", "renamed-over.txt");
writeFileSync("sealed/inside.txt", "NEW, written into");
await ctx.done();
`;
  t.after(() => { llm.repair = originalRepair; chmodSync(join(projectDir, "sealed"), 0o755); cleanupTempDir(projectDir); });

  // Each of these the program may do in the project itself. Tried in a copy, they have to arrive too.
  const { result, messages } = await captureConsole("warn", () => runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 }));
  assert.equal(result.status, "done");
  assert.equal(readFileSync(join(projectDir, "replaced.txt"), "utf-8"), "NEW, in a new file");
  assert.equal(statSync(join(projectDir, "replaced.txt")).mode & 0o777, 0o640 & ~process.umask(), "a new file, with the new file's permissions");
  assert.equal(readFileSync(join(projectDir, "renamed-over.txt"), "utf-8"), "NEW, moved into place");
  assert.equal(readFileSync(join(projectDir, "sealed", "inside.txt"), "utf-8"), "NEW, written into");
  assert.deepEqual(messages.filter(line => line.includes("did not reach the project")), []);
  assert.deepEqual(leftovers(projectDir), []);
});

test("what a fix's run wrote that did not reach the project is said, and is on record", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  createProjectFixture(projectDir, { scaffold: false, programSource: 'throw new Error("boom");' });
  writeText(join(projectDir, "report.txt"), "as it was");
  const real = join(realpathSync(projectDir), "report.txt");
  const originalRepair = llm.repair;
  // While it runs in its copy, the project's own file changes under it — here by its own hand, to be sure of the moment.
  llm.repair = async () => `import { ctx } from "@trama-dev/runtime";
import { writeFileSync } from "fs";
writeFileSync("report.txt", "what the run wrote");
writeFileSync("arrived.txt", "this one arrives");
writeFileSync(${JSON.stringify(real)}, "changed by someone else meanwhile, and longer");
await ctx.done();
`;
  t.after(() => { llm.repair = originalRepair; cleanupTempDir(projectDir); });

  const { result, messages } = await captureConsole("warn", () => runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 }));
  // The run is done, and the other's change is kept — as before. What is new is that it is not kept quiet.
  assert.equal(result.status, "done");
  assert.equal(readFileSync(real, "utf-8"), "changed by someone else meanwhile, and longer");
  assert.equal(readFileSync(join(projectDir, "arrived.txt"), "utf-8"), "this one arrives");
  assert.ok(messages.some(line => /1 change\(s\) the repaired run made did not reach the project/.test(line)), messages.join("\n"));
  assert.ok(messages.some(line => /report\.txt — it was changed or removed in the project meanwhile/.test(line)), messages.join("\n"));

  const [journal] = readdirSync(join(projectDir, "logs", "journal"));
  const records = readFileSync(join(projectDir, "logs", "journal", journal), "utf-8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(records.find(record => record.kind === "unmerged").files,
    [{ path: "report.txt", why: "it was changed or removed in the project meanwhile" }]);
  // And whoever reads the journal is told.
  const shown = await captureConsole("log", () => printJournals(projectDir, "the-project", {}));
  assert.ok(shown.messages.some(line => /1 change\(s\) it made did not reach the project/.test(line)), shown.messages.join("\n"));
  assert.ok(shown.messages.some(line => /report\.txt — it was changed or removed/.test(line)), shown.messages.join("\n"));
});

test("what a fix did to its own program.ts is not reported as work that did not arrive: the program is installed, not merged", async (t) => {
  const next = `import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ generation: 2 });\n`;
  const rewrites = `import { ctx } from "@trama-dev/runtime";
import { writeFileSync } from "fs";
writeFileSync("program.ts", ${JSON.stringify(next)});
await ctx.done();
`;
  const removes = `import { ctx } from "@trama-dev/runtime";
import { rmSync } from "fs";
rmSync("program.ts");
await ctx.done();
`;
  const originalRepair = llm.repair;
  t.after(() => { llm.repair = originalRepair; });
  for (const [fixed, left] of [[rewrites, next], [removes, removes.trim()]]) {
    const projectDir = makeTempDir("trama-runner-");
    t.after(() => cleanupTempDir(projectDir));
    createProjectFixture(projectDir, { scaffold: false, programSource: 'throw new Error("boom");' });
    llm.repair = async () => fixed;

    const { result, messages } = await captureConsole("warn", () => runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 }));
    assert.equal(result.status, "done");
    assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), left);
    assert.deepEqual(messages.filter(line => line.includes("did not reach the project")), []);
  }
});

// --- A copy stands on its own ---

test("a link that names a place in the project by its full path leads, in a copy, to the same place in the copy", async (t) => {
  const projectDir = realpathSync(makeTempDir("trama-runner-"));
  createProjectFixture(projectDir, { scaffold: false, programSource: 'throw new Error("boom");' });
  writeText(join(projectDir, "data", "x.txt"), "AS IT WAS");
  symlinkSync(join(projectDir, "data"), join(projectDir, "by-full-path"));
  // The links to the runtime are made in a directory reached the same way.
  mkdirSync(join(projectDir, "vendor"));
  symlinkSync(join(projectDir, "vendor"), join(projectDir, "node_modules"));
  const originalRepair = llm.repair;
  t.after(() => { llm.repair = originalRepair; cleanupTempDir(projectDir); });

  // A fix that fails after writing through the link. Tried in a copy, it must leave the project alone.
  llm.repair = async () => `import { writeFileSync } from "fs";
writeFileSync("by-full-path/x.txt", "written by a fix that then fails");
throw new Error("still broken");
`;
  const failed = await runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 });
  assert.equal(failed.status, "failed");
  assert.match(failed.reason, /still broken/);
  assert.equal(readFileSync(join(projectDir, "data", "x.txt"), "utf-8"), "AS IT WAS");

  // And one that works runs — its node_modules is inside the copy, as the project's is inside the project —
  // and what it wrote through the link arrives where the link leads.
  llm.repair = async () => `import { ctx } from "@trama-dev/runtime";
import { writeFileSync } from "fs";
writeFileSync("by-full-path/x.txt", "written by the fix");
await ctx.done();
`;
  const done = await runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 });
  assert.equal(done.status, "done");
  assert.equal(readFileSync(join(projectDir, "data", "x.txt"), "utf-8"), "written by the fix");
  assert.equal(lstatSync(join(projectDir, "by-full-path")).isSymbolicLink(), true);
});

test("a project whose journals cannot be kept is still repaired: it has none to leave out of a copy", async (t) => {
  const { projectDir, fixed } = repairableProject(t);
  const outside = makeTempDir("trama-outside-");
  t.after(() => cleanupTempDir(outside));
  mkdirSync(join(projectDir, "logs"));
  symlinkSync(outside, join(projectDir, "logs", "journal"));

  const { result, messages } = await captureConsole("warn", () => runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 }));
  assert.equal(result.status, "done");
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), fixed.trim());
  assert.ok(messages.some(line => line.includes("this run is not being recorded")));
  assert.deepEqual(readdirSync(outside), []);
});

test("a journal this process is writing is known for its own, however the project is named", (t) => {
  const parent = realpathSync(makeTempDir("trama-runner-"));
  t.after(() => cleanupTempDir(parent));
  const projectDir = join(parent, "MyProject");
  createProjectFixture(projectDir);
  const inOtherLetters = join(parent, "myproject");
  if (!existsSync(inOtherLetters)) return t.skip("this file system tells upper case from lower");

  const first = openJournal(projectDir, 1, {});
  // A second run of the same project, named in other letters, makes room for itself — one journal is kept.
  const second = openJournal(inOtherLetters, 1, {});
  t.after(() => { first.close(); second.close(); });
  assert.equal(existsSync(first.path), true, "the journal still being written was removed to make room");
});

// --- What a repaired run did reaches the project — all of it, or it is said ---

const BOOM = 'throw new Error("boom");';
const fixThat = (does) => async () => `import { ctx } from "@trama-dev/runtime";\nimport * as fs from "fs";\n${does}\nawait ctx.done();\n`;

test("what a repaired run did to directories, links and permissions reaches the project like what it did to files", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  createProjectFixture(projectDir, { scaffold: false, programSource: BOOM });
  writeText(join(projectDir, "becomes-a-link.txt"), "PRECIOUS");
  writeText(join(projectDir, "becomes-a-dir.txt"), "PRECIOUS");
  writeText(join(projectDir, "target.txt"), "T");
  writeText(join(projectDir, "config", "settings.json"), "{}");
  writeText(join(projectDir, "old", "deep", "f.txt"), "f");
  writeText(join(projectDir, "run.sh"), "#!/bin/sh\n");
  writeText(join(projectDir, "count.txt"), "1");
  const originalRepair = llm.repair;
  llm.repair = fixThat(`
fs.rmSync("becomes-a-link.txt"); fs.symlinkSync("target.txt", "becomes-a-link.txt");
fs.rmSync("becomes-a-dir.txt"); fs.mkdirSync("becomes-a-dir.txt");
fs.rmSync("config", { recursive: true }); fs.writeFileSync("config", "v2");
fs.mkdirSync("cache");
fs.rmSync("old", { recursive: true });
fs.chmodSync("run.sh", 0o755);
fs.symlinkSync(process.cwd() + "/target.txt", "latest");
fs.mkdirSync("sealed"); fs.writeFileSync("sealed/inside.txt", "in"); fs.chmodSync("sealed", 0o555);
const { atime, mtime } = fs.statSync("count.txt"); fs.writeFileSync("count.txt", "2"); fs.utimesSync("count.txt", atime, mtime);
`);
  t.after(() => { llm.repair = originalRepair; chmodSync(join(projectDir, "sealed"), 0o755); cleanupTempDir(projectDir); });

  const { result, messages } = await captureConsole("warn", () => runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 }));
  assert.equal(result.status, "done");
  assert.deepEqual(messages.filter(line => line.includes("did not reach the project")), []);
  const at = (name) => join(projectDir, name);
  assert.equal(lstatSync(at("becomes-a-link.txt")).isSymbolicLink(), true);
  assert.equal(readFileSync(at("becomes-a-link.txt"), "utf-8"), "T");
  assert.deepEqual(readdirSync(at("becomes-a-dir.txt")), []);
  assert.equal(readFileSync(at("config"), "utf-8"), "v2");
  assert.deepEqual(readdirSync(at("cache")), []);
  assert.equal(existsSync(at("old")), false);
  assert.equal(statSync(at("run.sh")).mode & 0o777, 0o755);
  // A link the run made by its working directory's full path names the project, not the copy that is gone.
  assert.equal(realpathSync(at("latest")), join(realpathSync(projectDir), "target.txt"));
  assert.equal(statSync(at("sealed")).mode & 0o777, 0o555);
  assert.equal(readFileSync(at("sealed/inside.txt"), "utf-8"), "in");
  assert.equal(readFileSync(at("count.txt"), "utf-8"), "2", "a change that kept the file's size and times");
});

test("a repaired run that closes a directory costs the project nothing that is in it: it is closed there too, with what the run left in it", { skip: process.getuid?.() === 0 }, async (t) => {
  // 0o400: the names in it can be listed, and none of them looked at. 0o300: not listed either.
  for (const mode of ["0o400", "0o300"]) {
    const projectDir = makeTempDir("trama-runner-");
    createProjectFixture(projectDir, { scaffold: false, programSource: BOOM });
    writeText(join(projectDir, "sub", "a.txt"), "A");
    writeText(join(projectDir, "sub", "b.txt"), "B");
    const originalRepair = llm.repair;
    llm.repair = fixThat(`fs.writeFileSync("sub/c.txt", "C"); fs.rmSync("sub/b.txt"); fs.chmodSync("sub", ${mode});`);
    t.after(() => { llm.repair = originalRepair; chmodSync(join(projectDir, "sub"), 0o755); cleanupTempDir(projectDir); });

    const { result, messages } = await captureConsole("warn", () => runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 }));
    assert.equal(result.status, "done");
    assert.deepEqual(messages.filter(line => line.includes("did not reach the project")), []);
    assert.equal(statSync(join(projectDir, "sub")).mode & 0o777, Number(mode), mode);
    chmodSync(join(projectDir, "sub"), 0o755);
    assert.deepEqual(readdirSync(join(projectDir, "sub")).sort(), ["a.txt", "c.txt"], mode);
    assert.deepEqual(leftovers(projectDir), []);
  }
});

test("no link in a project lets a fix that fails write to the project from its copy", async (t) => {
  // The temp directory is beside the project, so that "../<the project's name>" is the project from a copy too.
  const parent = realpathSync(makeTempDir("trama-runner-"));
  const projectDir = join(parent, "my-proj");
  createProjectFixture(projectDir, { scaffold: false, programSource: BOOM });
  writeText(join(projectDir, "data", "x.txt"), "X");
  symlinkSync("../my-proj/data", join(projectDir, "out-and-back"));
  symlinkSync(join(projectDir, "data"), join(projectDir, "by-full-path"));
  symlinkSync(join(projectDir, "not-yet") + "/", join(projectDir, "to-come")); // cannot be followed until not-yet is made
  const originalRepair = llm.repair;
  llm.repair = async () => `import * as fs from "fs";
for (const link of ["out-and-back", "by-full-path"]) fs.writeFileSync(link + "/leak.txt", "LEAK");
for (const how of [() => fs.mkdirSync("to-come/"), () => fs.mkdirSync("to-come/", { recursive: true }), () => fs.writeFileSync("to-come/leak.txt", "LEAK")]) { try { how(); } catch {} }
throw new Error("still broken");
`;
  t.after(() => { llm.repair = originalRepair; cleanupTempDir(parent); });

  const result = await withEnv({ TMPDIR: parent }, () => runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 }));
  assert.equal(result.status, "failed");
  assert.match(result.reason, /still broken/, "the fix got as far as its own failure: the links led somewhere in its copy");
  assert.deepEqual(readdirSync(join(projectDir, "data")), ["x.txt"]);
  assert.equal(existsSync(join(projectDir, "not-yet")), false);
});

test("a program that reads through a link out of its project and back in is the same program in a copy", async (t) => {
  const parent = realpathSync(makeTempDir("trama-runner-"));
  const projectDir = join(parent, "my-proj");
  const viaLink = `import { ctx, tools } from "@trama-dev/runtime";\nawait ctx.done({ read: await tools.read("out-and-back/x.txt") });\n`;
  createProjectFixture(projectDir, { scaffold: false, programSource: viaLink });
  writeText(join(projectDir, "data", "x.txt"), "X");
  symlinkSync("../my-proj/data", join(projectDir, "out-and-back"));
  t.after(() => cleanupTempDir(parent));

  const direct = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 20_000 });
  assert.deepEqual(direct.result, { read: "X" });
  // The copy is somewhere else, where "../my-proj" is nothing.
  const validated = await validateProgram(projectDir, createBackend(loadConfig()), viaLink, { timeout: 20_000, maxRepairAttempts: 0, maxIterations: 5 });
  assert.equal(validated.source, viaLink);
});

test("a project with a directory that cannot be looked into is not copied without it: the copy is refused", { skip: process.getuid?.() === 0 }, async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  createProjectFixture(projectDir, { scaffold: false, programSource: BOOM });
  mkdirSync(join(projectDir, "locked", "inner"), { recursive: true });
  chmodSync(join(projectDir, "locked"), 0o444);
  t.after(() => { chmodSync(join(projectDir, "locked"), 0o755); cleanupTempDir(projectDir); });
  const lists = `import { ctx } from "@trama-dev/runtime";\nimport * as fs from "fs";\nawait ctx.done({ held: fs.readdirSync("locked") });\n`;

  // Before any journal has been written for the project, and after: the answer is the same.
  for (let again = 0; again < 2; again++) {
    await assert.rejects(
      validateProgram(projectDir, createBackend(loadConfig()), lists, { timeout: 20_000, maxRepairAttempts: 0, maxIterations: 5, journalRuns: again }),
      { code: "EACCES" });
  }
});

// --- What a repaired run did to its own program reaches the project like the rest of what it did ---

const SELF = `// what the program made of itself\nimport { ctx } from "@trama-dev/runtime";\nawait ctx.done();\n`;
const shapeOf = (projectDir, names) => Object.fromEntries(names.map((name) => {
  const at = join(projectDir, name);
  const stat = lstatSync(at, { throwIfNoEntry: false });
  if (!stat) return [name, "nothing"];
  if (stat.isSymbolicLink()) return [name, `link to ${readlinkSync(at)}`];
  return [name, stat.isDirectory() ? "dir" : `file ${(stat.mode & 0o777).toString(8)} ${JSON.stringify(readFileSync(at, "utf-8"))}`];
}));
/**
 * A project whose program.ts is a file of its own — or a link to src/app.ts,
 * where the program then is; or one that says so in other letters than the
 * directory has, or a file the directory has as Program.ts (which is
 * program.ts only where the file system takes the two for one name).
 */
const foldsNames = existsSync(import.meta.filename.toUpperCase()) && existsSync(import.meta.filename.toLowerCase());
const projectWith = (program, { linked = false, spelled = false } = {}) => {
  const projectDir = makeTempDir("trama-runner-");
  createProjectFixture(projectDir, { scaffold: false, programSource: program });
  if (linked) {
    rmSync(join(projectDir, "program.ts"));
    writeText(join(projectDir, "src", "app.ts"), program);
    symlinkSync(spelled ? "SRC/app.ts" : "src/app.ts", join(projectDir, "program.ts"));
  } else if (spelled) {
    renameSync(join(projectDir, "program.ts"), join(projectDir, "Program.ts"));
  }
  chmodSync(join(projectDir, "program.ts"), 0o600); // (of the file the link leads to, where it is one)
  return projectDir;
};

const WHAT_A_PROGRAM_DOES_TO_ITSELF = {
  "allows itself more": { does: `fs.chmodSync("program.ts", 0o755);` },
  "rewrites itself": { does: `fs.writeFileSync("program.ts", ${JSON.stringify(SELF)});` },
  "puts a new file in its own place": { does: `fs.writeFileSync("p.new", ${JSON.stringify(SELF)}); fs.renameSync("p.new", "program.ts");`, names: ["p.new"] },
  "makes itself a link to where it moved": {
    does: `fs.mkdirSync("src"); fs.writeFileSync("src/main.ts", ${JSON.stringify(SELF)}); fs.unlinkSync("program.ts"); fs.symlinkSync("src/main.ts", "program.ts");`,
    names: ["src/main.ts"],
  },
  "was a link, and rewrites itself through it": { linked: true, does: `fs.writeFileSync("program.ts", ${JSON.stringify(SELF)});`, names: ["src/app.ts"] },
  "was a link, and makes itself a file of its own, leaving what it was a link to": {
    linked: true, does: `fs.unlinkSync("program.ts"); fs.writeFileSync("program.ts", ${JSON.stringify(SELF)});`, names: ["src/app.ts"],
  },
  "was a link, and points itself at another file": {
    linked: true, does: `fs.writeFileSync("src/main.ts", ${JSON.stringify(SELF)}); fs.unlinkSync("program.ts"); fs.symlinkSync("src/main.ts", "program.ts");`,
    names: ["src/app.ts", "src/main.ts"],
  },
  "is there as Program.ts, and allows itself more": { spelled: true, onlyWhereNamesFold: true, does: `fs.chmodSync("program.ts", 0o755);`, names: ["Program.ts"] },
  "is linked to in other letters, and allows itself more": { linked: true, spelled: true, onlyWhereNamesFold: true, does: `fs.chmodSync("program.ts", 0o755);`, names: ["src/app.ts"] },
  "was a link, and makes itself a file of its own, with something else where it was": {
    linked: true,
    does: `fs.unlinkSync("program.ts"); fs.writeFileSync("program.ts", ${JSON.stringify(SELF)}); fs.writeFileSync("src/app.ts", "export const HELPER = 42;\\n");`,
    names: ["src/app.ts"],
  },
};

for (const [what, { does, linked, spelled, onlyWhereNamesFold, names = [] }] of Object.entries(WHAT_A_PROGRAM_DOES_TO_ITSELF)) {
  test(`a repaired program that ${what} leaves the project as the same program leaves it when run directly`, { skip: onlyWhereNamesFold && !foldsNames }, async (t) => {
    const fix = (await fixThat(does)()).trimEnd(); // as a fix comes back
    const direct = projectWith(fix, { linked, spelled });
    const repaired = projectWith(BOOM, { linked, spelled });
    const originalRepair = llm.repair;
    llm.repair = async () => fix;
    t.after(() => { llm.repair = originalRepair; cleanupTempDir(direct); cleanupTempDir(repaired); });

    const ran = await runProgram({ projectDir: direct, maxRepairAttempts: 0, timeout: 20_000 });
    assert.equal(ran.status, "done");
    const { result, messages } = await captureConsole("warn", () => runProgram({ projectDir: repaired, maxRepairAttempts: 1, timeout: 20_000 }));
    assert.equal(result.status, "done");
    assert.deepEqual(messages.filter(line => line.includes("did not reach the project")), []);
    assert.deepEqual(shapeOf(repaired, ["program.ts", ...names]), shapeOf(direct, ["program.ts", ...names]));
  });
}

for (const [how, { spelled, linked, onlyWhereNamesFold, does = `fs.unlinkSync("program.ts");`, is }] of Object.entries({
  "": { is: (fix) => ({ "program.ts": `file 600 ${JSON.stringify(fix)}` }) },
  ", in a project that has it as Program.ts": { spelled: true, onlyWhereNamesFold: true, is: (fix) => ({ "Program.ts": `file 600 ${JSON.stringify(fix)}` }) },
  // The link is gone, and a file of its name is put back: the fix. Where the link led is as the run left it.
  ", where it was a link": { linked: true, is: (fix) => ({ "program.ts": `file 600 ${JSON.stringify(fix)}`, "src/app.ts": `file 600 ${JSON.stringify(fix)}` }) },
  ", by removing the directory a link in other letters led into": {
    linked: true, spelled: true, onlyWhereNamesFold: true, does: `fs.rmSync("src", { recursive: true });`,
    is: (fix) => ({ "program.ts": `file 600 ${JSON.stringify(fix)}`, "src": "nothing", "SRC": "nothing" }),
  },
})) {
  test(`a repaired program that removes itself is still the fix that ran: the project has it${how}`, { skip: onlyWhereNamesFold && !foldsNames }, async (t) => {
    const fix = (await fixThat(`${does} fs.writeFileSync("state.txt", "written by the run");`)()).trimEnd();
    const projectDir = projectWith(BOOM, { spelled, linked });
    const originalRepair = llm.repair;
    llm.repair = async () => fix;
    t.after(() => { llm.repair = originalRepair; cleanupTempDir(projectDir); });

    const { result, messages } = await captureConsole("warn", () => runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 }));
    assert.equal(result.status, "done");
    assert.deepEqual(messages.filter(line => line.includes("did not reach the project")), []);
    const wanted = { ...is(fix), "state.txt": 'file 644 "written by the run"' };
    assert.deepEqual(shapeOf(projectDir, Object.keys(wanted)), wanted);
    assert.deepEqual(readdirSync(projectDir).filter((name) => /^program\.ts$/i.test(name)), [spelled && !linked ? "Program.ts" : "program.ts"]);
  });
}

for (const [what, does, why] of [
  ["a directory", `fs.unlinkSync("program.ts"); fs.mkdirSync("program.ts");`, /left no program\.ts that can be read: .*program\.ts is a directory, not a program\./],
  ["a link out of the project", `fs.unlinkSync("program.ts"); fs.symlinkSync("/etc/hosts", "program.ts");`, /left no program\.ts that can be read: Path escapes project directory/],
]) {
  test(`a fix whose run leaves ${what} where its program was has not worked: nothing of it reaches the project`, async (t) => {
    const projectDir = projectWith(BOOM);
    const originalRepair = llm.repair;
    llm.repair = fixThat(`fs.writeFileSync("state.txt", "written by the run");\n${does}`);
    t.after(() => { llm.repair = originalRepair; cleanupTempDir(projectDir); });

    const result = await runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 });
    assert.equal(result.status, "failed");
    assert.match(result.reason, why);
    assert.deepEqual(shapeOf(projectDir, ["program.ts", "state.txt"]), { "program.ts": `file 600 ${JSON.stringify(BOOM)}`, "state.txt": "nothing" });
  });
}

test("a directory where a project's program should be is no program, and is said to be none", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  createProjectFixture(projectDir, { scaffold: false, programSource: BOOM });
  rmSync(join(projectDir, "program.ts"));
  mkdirSync(join(projectDir, "program.ts"));
  const originalRepair = llm.repair;
  let asked = 0;
  llm.repair = async () => { asked++; return SELF; };
  t.after(() => { llm.repair = originalRepair; cleanupTempDir(projectDir); });

  // Run: it fails as a program that cannot be loaded does, and no fix is asked for — none could take its place.
  const result = await runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 });
  assert.equal(result.status, "failed");
  assert.match(result.reason, /no repair was tried\. The program cannot be replaced: .*program\.ts is a directory\./);
  assert.equal(asked, 0);
  // Nor is a candidate tried: there is no place for it in a copy of this, as there is none in the project.
  await assert.rejects(
    validateProgram(projectDir, createBackend(loadConfig()), SELF, { timeout: 20_000, maxRepairAttempts: 0, maxIterations: 5 }),
    /No program can be tried in a copy of .*: its program\.ts is a directory\./);
  assert.throws(() => installValidatedProgram(projectDir, { source: SELF }, "update", "p"), /The program cannot be replaced: .*program\.ts is a directory\./);
  assert.deepEqual(readdirSync(join(projectDir, "program.ts")), []);
});
