import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "fs";
import { join } from "path";
import { PiAdapter } from "../packages/runtime/dist/pi-adapter.js";
import { copyToHistory, loadConfig, loadState, runProgram } from "../packages/runtime/dist/runner.js";
import { cleanupTempDir, createProjectFixture, makeTempDir, readJson, withEnv, writeJson, writeText } from "./helpers.mjs";

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
    await assert.rejects(
      async () => runProgram({ projectDir, maxRepairAttempts: 1, timeout: 5_000 }),
      /EACCES/,
    );
    // The repaired program ran successfully — program.ts must keep the verified repair
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
