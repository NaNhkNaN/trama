import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { REPO_ROOT, cleanupTempDir, makeTempDir, runNodeCommand, writeJson, writeText } from "./helpers.mjs";

const CLI_ENTRY = join(REPO_ROOT, "packages", "cli", "dist", "index.js");

test("CLI list reports an empty workspace cleanly", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const result = await runNodeCommand([CLI_ENTRY, "list"], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: fakeHome },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /No projects found\./);
});

test("CLI run rejects invalid --timeout values", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-");
  t.after(() => cleanupTempDir(fakeHome));

  for (const bad of ["nope", "0", "-5", "", "1.5", "10ms"]) {
    const result = await runNodeCommand(
      [CLI_ENTRY, "run", "demo", "--timeout", bad],
      { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome } },
    );
    assert.equal(result.exitCode, 1, `should reject --timeout ${JSON.stringify(bad)}`);
    assert.match(result.stderr, /--timeout must be a positive integer/);
  }
});

test("CLI run surfaces missing-project errors with exit code 1", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const result = await runNodeCommand([CLI_ENTRY, "run", "missing", "--timeout", "10"], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: fakeHome },
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /not found/);
});

test("CLI run rejects path-like project names", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const result = await runNodeCommand([CLI_ENTRY, "run", "../escaped", "--timeout", "10"], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: fakeHome },
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Invalid project name/);
});

test("CLI create honors the configured default model when --model is omitted", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-");
  t.after(() => cleanupTempDir(fakeHome));

  writeJson(join(fakeHome, ".trama", "config.json"), {
    provider: "anthropic",
    model: "configured-model",
    maxRepairAttempts: 3,
    defaultTimeout: 300000,
    defaultMaxIterations: 100,
  });

  const observedModelPath = join(fakeHome, "observed-model.txt");
  const preloadPath = join(fakeHome, "mock-create.mjs");
  writeText(preloadPath, `import { writeFileSync } from "node:fs";
import { PiAdapter } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, "packages", "runtime", "dist", "pi-adapter.js")).href)};

PiAdapter.prototype.ask = async function ask() {
  writeFileSync(${JSON.stringify(observedModelPath)}, this.config.model, "utf-8");
  return 'import { ctx } from "@trama-dev/runtime";\\nawait ctx.done();\\n';
};

PiAdapter.prototype.repair = async function repair() {
  throw new Error("repair should not run");
};
`);

  const result = await runNodeCommand(
    ["--import", preloadPath, CLI_ENTRY, "create", "alpha", "write something"],
    { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome } },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(readFileSync(observedModelPath, "utf-8"), "configured-model");
});
