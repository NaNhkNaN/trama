import assert from "node:assert/strict";
import test from "node:test";
import { join } from "path";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { pathToFileURL } from "url";
import { REPO_ROOT, runNodeCommand } from "./helpers.mjs";

const CLIENT_MODULE_URL = pathToFileURL(join(REPO_ROOT, "packages", "runtime", "dist", "client.js")).href;

function runtimeEnv() {
  const initFile = mkdtempSync(join(tmpdir(), "trama-client-test-")) + "/init.json";
  writeFileSync(initFile, JSON.stringify({
    input: { prompt: "test prompt", args: {} },
    state: {},
    iteration: 0,
    maxIterations: 100,
  }));
  return {
    env: {
      ...process.env,
      TRAMA_PORT: "1",
      TRAMA_INIT: initFile,
    },
    initFile,
  };
}

test("client.ts throws a clear error when run directly without trama", async () => {
  const result = await runNodeCommand(
    ["-e", `import "@trama-dev/runtime";`],
    { cwd: REPO_ROOT, env: { ...process.env, TRAMA_PORT: undefined } },
  );

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /TRAMA_PORT/);
});

test("client.ts throws a clear error when TRAMA_INIT is missing", async () => {
  const result = await runNodeCommand(
    ["-e", `import "@trama-dev/runtime";`],
    { cwd: REPO_ROOT, env: { ...process.env, TRAMA_PORT: "12345", TRAMA_INIT: undefined } },
  );

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /TRAMA_INIT/);
});

test("client.ts checkpoint rejects non-serializable state before attempting IPC", async () => {
  const { env, initFile } = runtimeEnv();
  try {
    const result = await runNodeCommand(
      [
        "--input-type=module",
        "-e",
        `const { ctx } = await import(${JSON.stringify(CLIENT_MODULE_URL)});
ctx.state.bad = new Date();
await ctx.checkpoint();`,
      ],
      { cwd: REPO_ROOT, env },
    );

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /ctx\.state\.bad is not a plain object \(Date\)/);
    assert.doesNotMatch(result.stderr, /ECONNREFUSED|fetch failed/i);
  } finally {
    try { rmSync(initFile); } catch {}
  }
});

test("client.ts done rejects non-serializable results before attempting IPC", async () => {
  const { env, initFile } = runtimeEnv();
  try {
    const result = await runNodeCommand(
      [
        "--input-type=module",
        "-e",
        `const { ctx } = await import(${JSON.stringify(CLIENT_MODULE_URL)});
await ctx.done(new Map());`,
      ],
      { cwd: REPO_ROOT, env },
    );

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /ctx\.done\(result\) is not a plain object \(Map\)/);
    assert.doesNotMatch(result.stderr, /ECONNREFUSED|fetch failed/i);
  } finally {
    try { rmSync(initFile); } catch {}
  }
});
