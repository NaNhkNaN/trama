import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import {
  REPO_ROOT, cleanupTempDir, createProjectFixture, isAlive, makeTempDir, pidIn, runNodeCommand, waitFor, writeJson,
  writeText,
} from "./helpers.mjs";

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

  for (const bad of ["nope", "0", "-5", "", "10ms"]) {
    const result = await runNodeCommand(
      [CLI_ENTRY, "run", "demo", "--timeout", bad],
      { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome } },
    );
    assert.equal(result.exitCode, 1, `should reject --timeout ${JSON.stringify(bad)}`);
    assert.match(result.stderr, /--timeout must be a positive number/);
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

PiAdapter.prototype.ask = async function ask(prompt) {
  if (!prompt.startsWith("write something")) throw new Error("only the program should be asked for");
  writeFileSync(${JSON.stringify(observedModelPath)}, this.config.model, "utf-8");
  return 'import { ctx } from "@trama-dev/runtime";\\nawait ctx.done();\\n';
};
`);

  const result = await runNodeCommand(
    ["--import", preloadPath, CLI_ENTRY, "create", "alpha", "write something"],
    { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome } },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(readFileSync(observedModelPath, "utf-8"), "configured-model");
});

test("CLI create rejects malformed --arg values", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const result = await runNodeCommand(
    [CLI_ENTRY, "create", "demo", "make something", "--arg", "noequals"],
    { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome } },
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Invalid --arg format/);
});

test("CLI update surfaces missing-project errors with exit code 1", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const result = await runNodeCommand(
    [CLI_ENTRY, "update", "missing", "new requirements"],
    { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome } },
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /not found/);
});

test("CLI logs surfaces missing-project errors with exit code 1", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const result = await runNodeCommand(
    [CLI_ENTRY, "logs", "missing"],
    { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome } },
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /not found/);
});

test("CLI run without --timeout uses config.defaultTimeout instead of a hardcoded default", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-");
  t.after(() => cleanupTempDir(fakeHome));

  // Omitting --timeout should not error — it should fall through to config.defaultTimeout
  const result = await runNodeCommand([CLI_ENTRY, "run", "missing"], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: fakeHome },
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /not found/);
  assert.doesNotMatch(result.stderr, /timeout must be a positive integer/i);
});

test("the trama command started by a program is a runner of its own", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const projects = join(fakeHome, ".trama", "projects");
  createProjectFixture(join(projects, "inner"), {
    scaffold: false,
    programSource: `import { ctx } from "@trama-dev/runtime";
console.log("printed by the inner program");
await ctx.done();`,
  });
  // The outer program starts the command itself, as it might any other tool,
  // and reads what it prints. It inherits the outer program's bridge; it must
  // not hand its run to that bridge's runner, which would print it elsewhere.
  createProjectFixture(join(projects, "outer"), {
    scaffold: false,
    programSource: `import { ctx, tools } from "@trama-dev/runtime";
import { execFileSync } from "child_process";
const printed = execFileSync(process.execPath, [${JSON.stringify(CLI_ENTRY)}, "run", "inner"], { encoding: "utf-8" });
await tools.write("printed.txt", printed);
await ctx.done();`,
  });

  const result = await runNodeCommand([CLI_ENTRY, "run", "outer"], {
    cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome },
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(
    readFileSync(join(projects, "outer", "printed.txt"), "utf-8"), /printed by the inner program/,
    "the command's output should have reached the program that ran it",
  );
});

test("a signal stops `trama run` politely: the program is asked, waited for, and the command dies of the signal", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-");
  const signalDir = makeTempDir("trama-cli-signal-");
  t.after(() => { cleanupTempDir(fakeHome); cleanupTempDir(signalDir); });

  createProjectFixture(join(fakeHome, ".trama", "projects", "patient"), {
    scaffold: false,
    programSource: `import { writeFileSync } from "fs";
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(join(signalDir, "closed-properly"))}, "");
  process.exit(0);
});
writeFileSync(${JSON.stringify(join(signalDir, "program.pid"))}, String(process.pid));
setInterval(() => {}, 1000);
await new Promise(() => {});`,
  });

  const cli = spawn(process.execPath, [CLI_ENTRY, "run", "patient"], {
    cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome }, stdio: "ignore",
  });
  const exited = new Promise(resolve => cli.on("close", (code, signal) => resolve({ code, signal })));
  await waitFor(() => pidIn(join(signalDir, "program.pid")), "the program to start");
  const programPid = pidIn(join(signalDir, "program.pid"));

  cli.kill("SIGINT");
  const { signal } = await exited;

  assert.equal(signal, "SIGINT", "the command should end as the signal would have ended it");
  assert.equal(existsSync(join(signalDir, "closed-properly")), true, "the program should have been asked to stop");
  assert.equal(isAlive(programPid), false, "and gone before the command returned");
});
