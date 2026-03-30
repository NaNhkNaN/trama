import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, statSync, rmSync } from "fs";
import { join } from "path";
import { PiAdapter } from "../packages/runtime/dist/pi-adapter.js";
import { copyToHistory, loadConfig, loadState, resolveSmokeTimeout, runProgram, RUNTIME_TYPES, withSnapshot } from "../packages/runtime/dist/runner.js";
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
  await assert.rejects(
    async () => runProgram({ projectDir, maxRepairAttempts: 0, timeout: 1_500 }),
    /timeout/i,
  );
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

  await assert.rejects(
    async () => runProgram({ projectDir, maxRepairAttempts: 0, timeout: 5_000 }),
    /stdout: stdout-hint[\s\S]*stderr: .*boom/s,
  );
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

  const originalRepair = PiAdapter.prototype.repair;
  PiAdapter.prototype.repair = async function repair(input) {
    assert.match(input.error, /boom/);
    return fixedProgram;
  };

  try {
    await runProgram({ projectDir, maxRepairAttempts: 1, timeout: 5_000 });
  } finally {
    PiAdapter.prototype.repair = originalRepair;
  }

  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), fixedProgram);
  assert.equal(readFileSync(join(projectDir, "history", "0001.ts"), "utf-8"), fixedProgram);
  // After repair is verified in isolation, the repaired program runs in the real dir for actual output.
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

  const originalRepair = PiAdapter.prototype.repair;
  PiAdapter.prototype.repair = async function repair() {
    throw new Error("repair blew up");
  };

  try {
    await assert.rejects(
      async () => runProgram({ projectDir, maxRepairAttempts: 1, timeout: 5_000 }),
      /Repair errors:[\s\S]*repair blew up/s,
    );
  } finally {
    PiAdapter.prototype.repair = originalRepair;
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

test("resolveSmokeTimeout uses the provided timeout without applying a 30s cap", () => {
  assert.equal(resolveSmokeTimeout(undefined), 30_000);
  assert.equal(resolveSmokeTimeout(1_500), 1_500);
  assert.equal(resolveSmokeTimeout(45_000), 45_000);
});

test("runProgram does not trigger repair when program succeeds", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { scaffold: false });

  const originalRepair = PiAdapter.prototype.repair;
  let repairCalled = false;
  PiAdapter.prototype.repair = async function repair() {
    repairCalled = true;
    return 'throw new Error("repair should not run");';
  };

  try {
    await runProgram({ projectDir, maxRepairAttempts: 3, timeout: 5_000 });
    assert.equal(repairCalled, false, "repair should not be called when program succeeds");
    assert.equal(readFileSync(join(projectDir, "output.txt"), "utf-8"), "iteration:0");
  } finally {
    PiAdapter.prototype.repair = originalRepair;
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

  const originalRepair = PiAdapter.prototype.repair;
  PiAdapter.prototype.repair = async function repair() {
    throw new Error("LLM unavailable");
  };

  try {
    await assert.rejects(
      async () => runProgram({ projectDir, maxRepairAttempts: 3, timeout: 5_000 }),
      /Failed after 1 repair attempt\(s\)/,
    );
    assert.equal(readFileSync(join(projectDir, "run-count.txt"), "utf-8"), "1");
  } finally {
    PiAdapter.prototype.repair = originalRepair;
  }
});

test("runProgram only records repair history after the repaired program succeeds", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: 'throw new Error("original");',
  });

  const originalRepair = PiAdapter.prototype.repair;
  // First repair returns code that also fails, second repair returns working code
  let repairAttempt = 0;
  PiAdapter.prototype.repair = async function repair() {
    repairAttempt++;
    if (repairAttempt === 1) {
      return 'throw new Error("still broken");';
    }
    return `import { ctx } from "@trama-dev/runtime"; await ctx.done();`;
  };

  try {
    await runProgram({ projectDir, maxRepairAttempts: 3, timeout: 5_000 });
  } finally {
    PiAdapter.prototype.repair = originalRepair;
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

  const originalRepair = PiAdapter.prototype.repair;
  PiAdapter.prototype.repair = async function repair() {
    return 'throw new Error("still broken");';
  };

  try {
    await assert.rejects(
      async () => runProgram({ projectDir, maxRepairAttempts: 2, timeout: 5_000 }),
      /Failed after 2 repair attempts/,
    );
    assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), originalSource);
  } finally {
    PiAdapter.prototype.repair = originalRepair;
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

  const originalRepair = PiAdapter.prototype.repair;
  PiAdapter.prototype.repair = async function repair() {
    throw new Error("LLM unavailable");
  };

  try {
    await assert.rejects(
      async () => runProgram({ projectDir, maxRepairAttempts: 1, timeout: 5_000 }),
      /Failed after 1 repair attempt/,
    );
    assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), originalSource);
  } finally {
    PiAdapter.prototype.repair = originalRepair;
  }
});

test("runProgram repair side effects are isolated from the real project directory", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));

  const originalSource = 'throw new Error("original");';
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: originalSource,
  });

  const originalRepair = PiAdapter.prototype.repair;
  // Repair writes a side-effect file via this.cwd and returns code that also writes one.
  // Both should stay in the temp dir, never touching the real project.
  PiAdapter.prototype.repair = async function repair() {
    writeFileSync(join(this.cwd, "repair-side-effect.txt"), "from-repair-llm");
    return `import { tools } from "@trama-dev/runtime";
await tools.write("program-side-effect.txt", "from-repaired-program");
throw new Error("still broken");`;
  };

  try {
    await assert.rejects(
      async () => runProgram({ projectDir, maxRepairAttempts: 1, timeout: 5_000 }),
      /Failed after 1 repair attempt/,
    );
    // program.ts is never modified since no repair was verified
    assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), originalSource);
    // Side effects from repair LLM and repaired program must NOT leak to real dir
    assert.equal(existsSync(join(projectDir, "repair-side-effect.txt")), false);
    assert.equal(existsSync(join(projectDir, "program-side-effect.txt")), false);
  } finally {
    PiAdapter.prototype.repair = originalRepair;
  }
});

test("runProgram fully restores project when repair passes in temp but fails in real dir", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));

  const originalSource = 'throw new Error("original");';
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: originalSource,
  });

  const originalRepair = PiAdapter.prototype.repair;
  // Return code that succeeds in temp but writes a side-effect file and then fails in real dir.
  PiAdapter.prototype.repair = async function repair() {
    return `import { tools } from "@trama-dev/runtime";
await tools.write("leaked.txt", "from-repair-rerun");
if (!process.cwd().includes("trama-repair-")) {
  throw new Error("fails in real dir");
}
import { ctx } from "@trama-dev/runtime";
await ctx.done();`;
  };

  try {
    await assert.rejects(
      async () => runProgram({ projectDir, maxRepairAttempts: 1, timeout: 5_000 }),
      /Failed after 1 repair attempt/,
    );
    // Full restore: both program.ts and side effects from the failed real rerun.
    assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), originalSource);
    assert.equal(existsSync(join(projectDir, "leaked.txt")), false,
      "side effects from the rolled-back repair rerun must not persist");
  } finally {
    PiAdapter.prototype.repair = originalRepair;
  }
});

test("runProgram keeps verified repair even when post-success bookkeeping (onRepair) fails", async (t) => {
  const projectDir = makeTempDir("trama-runner-");
  t.after(() => cleanupTempDir(projectDir));

  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: 'throw new Error("original");',
  });

  const fixedProgram = `import { ctx } from "@trama-dev/runtime";
await ctx.done();
`;

  const originalRepair = PiAdapter.prototype.repair;
  PiAdapter.prototype.repair = async function repair() {
    // Make history/ unwritable so onRepair's copyToHistory throws
    const { chmodSync } = await import("fs");
    chmodSync(join(projectDir, "history"), 0o444);
    return fixedProgram;
  };

  try {
    // onRepair bookkeeping (history write) fails with EACCES, but program succeeded —
    // runProgram should still return success, not propagate the bookkeeping error.
    await runProgram({ projectDir, maxRepairAttempts: 1, timeout: 5_000 });
    assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), fixedProgram);
  } finally {
    PiAdapter.prototype.repair = originalRepair;
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

// --- Tests for consolidated bug fixes (withSnapshot, process leak, init file security) ---

test("withSnapshot keeps directory when fn() returns keep:true", async (t) => {
  const dir = makeTempDir("trama-snapshot-");
  t.after(() => cleanupTempDir(dir));

  writeText(join(dir, "original.txt"), "before");

  const value = await withSnapshot(dir, async () => {
    writeFileSync(join(dir, "original.txt"), "after");
    writeFileSync(join(dir, "new.txt"), "created");
    return { keep: true, value: "ok" };
  });

  assert.equal(value, "ok");
  assert.equal(readFileSync(join(dir, "original.txt"), "utf-8"), "after",
    "mutations should persist when keep:true");
  assert.equal(existsSync(join(dir, "new.txt")), true);
});

test("withSnapshot restores directory when fn() returns keep:false", async (t) => {
  const dir = makeTempDir("trama-snapshot-");
  t.after(() => cleanupTempDir(dir));

  writeText(join(dir, "original.txt"), "before");

  const value = await withSnapshot(dir, async () => {
    writeFileSync(join(dir, "original.txt"), "after");
    writeFileSync(join(dir, "side-effect.txt"), "leaked");
    return { keep: false, value: 42 };
  });

  assert.equal(value, 42);
  assert.equal(readFileSync(join(dir, "original.txt"), "utf-8"), "before",
    "mutations should be reverted when keep:false");
  assert.equal(existsSync(join(dir, "side-effect.txt")), false);
});

test("withSnapshot restores directory when fn() throws after mutating it", async (t) => {
  const dir = makeTempDir("trama-snapshot-");
  t.after(() => cleanupTempDir(dir));

  // Set up original state
  writeText(join(dir, "program.ts"), "original");
  writeText(join(dir, "keep.txt"), "untouched");

  await assert.rejects(
    () => withSnapshot(dir, async () => {
      // Simulate the real-rerun path: overwrite program.ts, write side effects, then throw
      writeFileSync(join(dir, "program.ts"), "repaired");
      writeFileSync(join(dir, "side-effect.txt"), "leaked");
      throw new Error("infrastructure failure");
    }),
    /infrastructure failure/,
  );

  // Directory must be fully restored to pre-fn state
  assert.equal(readFileSync(join(dir, "program.ts"), "utf-8"), "original",
    "program.ts must be restored after fn() throws");
  assert.equal(readFileSync(join(dir, "keep.txt"), "utf-8"), "untouched",
    "pre-existing files must survive");
  assert.equal(existsSync(join(dir, "side-effect.txt")), false,
    "side effects from fn() must not persist after throw");
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
const port = process.env.TRAMA_PORT;
const big = "x".repeat(51 * 1024 * 1024);
const res = await fetch("http://127.0.0.1:" + port + "/ctx/log", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: big,
});
await tools.write("ipc-status.txt", String(res.status));
await ctx.done();`,
  });

  await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 10_000 });
  assert.equal(readFileSync(join(projectDir, "ipc-status.txt"), "utf-8"), "413");
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
