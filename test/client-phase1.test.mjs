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
    workspace: null,
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
  const { env, initDir } = runtimeEnv({ workspace: null });
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
  const { env, initDir } = runtimeEnv({ workspace: null });
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
  const { env, initDir } = runtimeEnv({ workspace: null });
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
  const { env, initDir } = runtimeEnv({ workspace: null });
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

test("client.ts ctx.resumed defaults to false when not in init data", async () => {
  const initDir = mkdtempSync(join(tmpdir(), "trama-client-p1-"));
  const initFile = join(initDir, "init.json");
  // Write init data WITHOUT resumed/yieldReason (old format)
  writeFileSync(initFile, JSON.stringify({
    input: { prompt: "test", args: {} },
    state: {},
    iteration: 0,
    maxIterations: 100,
  }));
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
      { cwd: REPO_ROOT, env: { ...process.env, TRAMA_PORT: "1", TRAMA_INIT: initFile } },
    );

    const output = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(output.resumed, false);
    assert.equal(output.yieldReason, null);
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

test("client.ts done then yield throws mutual exclusivity error", async () => {
  // Need a real server for done to succeed, then yield should throw locally
  const result = await runNodeCommand(
    [
      "--input-type=module",
      "-e",
      `import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const server = createServer((req, res) => {
  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result: null }));
  });
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const addr = server.address();
const initDir = mkdtempSync(join(tmpdir(), "trama-client-mx-"));
const initFile = join(initDir, "init.json");
writeFileSync(initFile, JSON.stringify({
  input: { prompt: "test", args: {} },
  state: {},
  iteration: 0,
  maxIterations: 100,
  workspace: null,
  resumed: false,
  yieldReason: null,
}));

process.env.TRAMA_PORT = String(addr.port);
process.env.TRAMA_INIT = initFile;

try {
  const { ctx } = await import(${JSON.stringify(CLIENT_MODULE_URL)});
  await ctx.done();
  try {
    await ctx.yield("too late");
    console.log("ERROR: should have thrown");
  } catch (err) {
    console.log(err.message);
  }
} finally {
  await new Promise(resolve => server.close(resolve));
  rmSync(initDir, { recursive: true, force: true });
}`,
    ],
    { cwd: REPO_ROOT, env: { ...process.env } },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /Cannot call ctx\.yield\(\) after ctx\.done\(\)/);
});
