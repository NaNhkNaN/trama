import assert from "node:assert/strict";
import { createServer } from "http";
import test from "node:test";
import { mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { createTools } from "../packages/runtime/dist/tools.js";
import { cleanupTempDir, makeTempDir } from "./helpers.mjs";

test("createTools read and write operate inside the project directory", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));

  const tools = createTools(projectDir);
  await tools.write("nested/file.txt", "hello");

  assert.equal(await tools.read("nested/file.txt"), "hello");
  assert.equal(readFileSync(join(projectDir, "nested", "file.txt"), "utf-8"), "hello");
});

test("createTools prevents path traversal for file access", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));

  const tools = createTools(projectDir);

  await assert.rejects(async () => tools.write("../outside.txt", "nope"), /Path escapes project directory/);
  await assert.rejects(async () => tools.read("../outside.txt"), /Path escapes project directory/);
});

test("createTools shell runs commands in the requested cwd", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));
  mkdirSync(join(projectDir, "nested"), { recursive: true });

  const tools = createTools(projectDir);
  const result = await tools.shell("pwd", { cwd: "nested" });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout.trim(), /nested$/);
});

test("createTools shell returns spawn errors as structured results", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));

  const tools = createTools(projectDir);
  const result = await tools.shell("echo hi", { cwd: "missing-dir" });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /spawn sh ENOENT/);
});

test("createTools shell enforces timeouts", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));

  const tools = createTools(projectDir);
  const result = await tools.shell("sleep 1", { timeout: 50 });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /timeout/);
});

test("createTools killActiveShells terminates in-flight commands", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));

  const tools = createTools(projectDir);
  const pending = tools.shell("sleep 10");

  await new Promise(resolve => setTimeout(resolve, 50));
  tools.killActiveShells();

  const result = await pending;
  assert.notEqual(result.exitCode, 0);
});

test("createTools fetch returns status, body, and headers", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));

  const server = createServer((req, res) => {
    res.writeHead(201, { "x-test-header": req.method ?? "NONE" });
    res.end("pong");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => server.close());

  const port = server.address().port;
  const tools = createTools(projectDir);
  const result = await tools.fetch(`http://127.0.0.1:${port}/ping`, { method: "POST" });

  assert.equal(result.status, 201);
  assert.equal(result.body, "pong");
  assert.equal(result.headers["x-test-header"], "POST");
});

test("createTools path guard rejects prefix false-matches (spec §7.5)", async (t) => {
  // /tmp/foo-bar must NOT match project dir /tmp/foo
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));

  const tools = createTools(projectDir);
  const sibling = projectDir + "-sibling";

  // Construct a relative path that resolves to a sibling directory
  await assert.rejects(
    async () => tools.read("../" + join(projectDir, "..").split("/").pop() + "-sibling/secret"),
    /Path escapes project directory/,
  );
});

test("createTools shell guards cwd against traversal", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));

  const tools = createTools(projectDir);

  await assert.rejects(
    async () => tools.shell("pwd", { cwd: "../../" }),
    /Path escapes project directory/,
  );
});
