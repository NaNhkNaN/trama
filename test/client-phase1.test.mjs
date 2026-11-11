import assert from "node:assert/strict";
import test from "node:test";
import { join } from "path";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { pathToFileURL } from "url";
import { REPO_ROOT, runNodeCommand } from "./helpers.mjs";

const CLIENT_MODULE_URL = pathToFileURL(join(REPO_ROOT, "packages", "runtime", "dist", "client.js")).href;

function runtimeEnv(initOverrides = {}) {
  const initDir = mkdtempSync(join(tmpdir(), "trama-client-p1-"));
  const initFile = join(initDir, "init.json");
  writeFileSync(initFile, JSON.stringify({
    input: { prompt: "test prompt", args: {} },
    state: {},
    iteration: 0,
    maxIterations: 100,
    inSession: false,
    resumed: false,
    yieldReason: null,
    ...initOverrides,
  }));
  return {
    env: {
      ...process.env,
      TRAMA_PORT: "1",
      TRAMA_INIT: initFile,
    },
    initFile,
    initDir,
  };
}

test("client.ts workspace throws when not in a session (workspace=null)", async () => {
  const { env, initDir } = runtimeEnv({ inSession: false });
  try {
    const result = await runNodeCommand(
      [
        "--input-type=module",
        "-e",
        `const { workspace } = await import(${JSON.stringify(CLIENT_MODULE_URL)});
try {
  await workspace.read("anything.txt");
  process.exit(99);
} catch (err) {
  console.log(err.message);
  process.exit(0);
}`,
      ],
      { cwd: REPO_ROOT, env },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /only available when running in a session/);
  } finally {
    try { rmSync(initDir, { recursive: true, force: true }); } catch {}
  }
});

test("client.ts workspace.write throws when not in a session", async () => {
  const { env, initDir } = runtimeEnv({ inSession: false });
  try {
    const result = await runNodeCommand(
      [
        "--input-type=module",
        "-e",
        `const { workspace } = await import(${JSON.stringify(CLIENT_MODULE_URL)});
try {
  await workspace.write("test.txt", "data");
  process.exit(99);
} catch (err) {
  console.log(err.message);
  process.exit(0);
}`,
      ],
      { cwd: REPO_ROOT, env },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /only available when running in a session/);
  } finally {
    try { rmSync(initDir, { recursive: true, force: true }); } catch {}
  }
});

test("client.ts workspace.list throws when not in a session", async () => {
  const { env, initDir } = runtimeEnv({ inSession: false });
  try {
    const result = await runNodeCommand(
      [
        "--input-type=module",
        "-e",
        `const { workspace } = await import(${JSON.stringify(CLIENT_MODULE_URL)});
try {
  await workspace.list("*.txt");
  process.exit(99);
} catch (err) {
  console.log(err.message);
  process.exit(0);
}`,
      ],
      { cwd: REPO_ROOT, env },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /only available when running in a session/);
  } finally {
    try { rmSync(initDir, { recursive: true, force: true }); } catch {}
  }
});

test("client.ts workspace.observe throws when not in a session", async () => {
  const { env, initDir } = runtimeEnv({ inSession: false });
  try {
    const result = await runNodeCommand(
      [
        "--input-type=module",
        "-e",
        `const { workspace } = await import(${JSON.stringify(CLIENT_MODULE_URL)});
try {
  await workspace.observe("*.txt", { timeout: 100 });
  process.exit(99);
} catch (err) {
  console.log(err.message);
  process.exit(0);
}`,
      ],
      { cwd: REPO_ROOT, env },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /only available when running in a session/);
  } finally {
    try { rmSync(initDir, { recursive: true, force: true }); } catch {}
  }
});

test("client.ts ctx.resumed and ctx.yieldReason from init data", async () => {
  const { env, initDir } = runtimeEnv({
    resumed: true,
    yieldReason: "waiting for counterparty",
  });
  try {
    const result = await runNodeCommand(
      [
        "--input-type=module",
        "-e",
        `const { ctx } = await import(${JSON.stringify(CLIENT_MODULE_URL)});
console.log(JSON.stringify({
  resumed: ctx.resumed,
  yieldReason: ctx.yieldReason,
}));`,
      ],
      { cwd: REPO_ROOT, env },
    );

    // Exit code may be non-zero because TRAMA_PORT=1 (no server), but we check stdout
    const output = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(output.resumed, true);
    assert.equal(output.yieldReason, "waiting for counterparty");
  } finally {
    try { rmSync(initDir, { recursive: true, force: true }); } catch {}
  }
});

test("client.ts yield rejects non-serializable state before IPC", async () => {
  const { env, initDir } = runtimeEnv();
  try {
    const result = await runNodeCommand(
      [
        "--input-type=module",
        "-e",
        `const { ctx } = await import(${JSON.stringify(CLIENT_MODULE_URL)});
ctx.state.bad = new Date();
await ctx.yield("reason");`,
      ],
      { cwd: REPO_ROOT, env },
    );

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /not a plain object \(Date\)/);
    // Should NOT attempt IPC (no ECONNREFUSED)
    assert.doesNotMatch(result.stderr, /ECONNREFUSED|fetch failed/i);
  } finally {
    try { rmSync(initDir, { recursive: true, force: true }); } catch {}
  }
});
