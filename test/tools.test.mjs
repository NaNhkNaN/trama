import assert from "node:assert/strict";
import { createServer } from "http";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { createTools, cappedBuffer } from "../packages/runtime/dist/tools.js";
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

test("createTools killActiveShells terminates background processes in the same process group", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));

  const tools = createTools(projectDir);
  const pending = tools.shell("(sleep 0.2; echo leaked > leaked.txt) & sleep 10");

  await new Promise(resolve => setTimeout(resolve, 50));
  tools.killActiveShells();

  const result = await pending;
  await new Promise(resolve => setTimeout(resolve, 400));

  assert.notEqual(result.exitCode, 0);
  assert.equal(existsSync(join(projectDir, "leaked.txt")), false);
});

test("createTools killActiveShells still terminates background processes after the shell has exited", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));

  const tools = createTools(projectDir);
  const result = await tools.shell('nohup sh -c "sleep 0.2; echo leaked > leaked.txt" >/dev/null 2>&1 &');

  assert.equal(result.exitCode, 0);

  tools.killActiveShells();
  await new Promise(resolve => setTimeout(resolve, 400));

  assert.equal(existsSync(join(projectDir, "leaked.txt")), false);
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

test("createTools fetch respects the provided abort signal", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));

  const server = createServer(() => {
    // Intentionally never respond; the caller should abort first.
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => server.close());

  const port = server.address().port;
  const controller = new AbortController();
  const tools = createTools(projectDir, controller.signal);
  const pending = tools.fetch(`http://127.0.0.1:${port}/hang`);

  setTimeout(() => controller.abort(), 20);

  await assert.rejects(
    async () => pending,
    /Abort|aborted/i,
  );
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

test("createTools write rejects directory symlinks that escape the project", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  const outsideDir = makeTempDir("trama-outside-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(outsideDir); });

  symlinkSync(outsideDir, join(projectDir, "escape"), "dir");

  const tools = createTools(projectDir);
  await assert.rejects(
    async () => tools.write("escape/pwned.txt", "should not exist"),
    /Path escapes project directory via symlink/,
  );
  assert.equal(existsSync(join(outsideDir, "pwned.txt")), false);
});

test("createTools write rejects file symlinks that point outside the project", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  const outsideDir = makeTempDir("trama-outside-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(outsideDir); });

  // Create a file symlink inside project pointing to an outside file
  writeFileSync(join(outsideDir, "victim.txt"), "original content");
  symlinkSync(join(outsideDir, "victim.txt"), join(projectDir, "link.txt"));

  const tools = createTools(projectDir);
  await assert.rejects(
    async () => tools.write("link.txt", "overwritten"),
    /Path escapes project directory via symlink/,
  );
  // The outside file must NOT be modified
  assert.equal(readFileSync(join(outsideDir, "victim.txt"), "utf-8"), "original content");
});

test("createTools write rejects dangling file symlinks that point outside the project", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  const outsideDir = makeTempDir("trama-outside-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(outsideDir); });

  // Dangling symlink: target does not exist yet
  symlinkSync(join(outsideDir, "newfile.txt"), join(projectDir, "link.txt"));

  const tools = createTools(projectDir);
  await assert.rejects(
    async () => tools.write("link.txt", "pwned"),
    /Path escapes project directory via symlink/,
  );
  assert.equal(existsSync(join(outsideDir, "newfile.txt")), false);
});

test("createTools write does not create directories outside the project before rejecting", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  const outsideDir = makeTempDir("trama-outside-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(outsideDir); });

  symlinkSync(outsideDir, join(projectDir, "escape"), "dir");

  const tools = createTools(projectDir);
  await assert.rejects(
    async () => tools.write("escape/newdir/pwned.txt", "should not exist"),
    /Path escapes project directory via symlink/,
  );
  // mkdirSync must NOT have created the directory outside
  assert.equal(existsSync(join(outsideDir, "newdir")), false);
});

test("createTools read rejects symlinks that escape the project directory", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  const outsideDir = makeTempDir("trama-outside-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(outsideDir); });

  writeFileSync(join(outsideDir, "secret.txt"), "sensitive data");
  symlinkSync(outsideDir, join(projectDir, "escape"), "dir");

  const tools = createTools(projectDir);
  await assert.rejects(
    async () => tools.read("escape/secret.txt"),
    /Path escapes project directory via symlink/,
  );
});

test("createTools shell cwd rejects symlinks that escape the project directory", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  const outsideDir = makeTempDir("trama-outside-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(outsideDir); });

  symlinkSync(outsideDir, join(projectDir, "escape"), "dir");

  const tools = createTools(projectDir);
  await assert.rejects(
    async () => tools.shell("pwd", { cwd: "escape" }),
    /Path escapes project directory via symlink/,
  );
});

test("createTools allows symlinks that stay inside the project directory", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));

  mkdirSync(join(projectDir, "real"), { recursive: true });
  writeFileSync(join(projectDir, "real", "data.txt"), "ok");
  symlinkSync(join(projectDir, "real"), join(projectDir, "link"), "dir");

  const tools = createTools(projectDir);
  const content = await tools.read("link/data.txt");
  assert.equal(content, "ok");

  await tools.write("link/output.txt", "written");
  assert.equal(readFileSync(join(projectDir, "real", "output.txt"), "utf-8"), "written");
});

test("createTools allows dangling file symlinks that point inside the project", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));

  mkdirSync(join(projectDir, "real"), { recursive: true });
  // Dangling: real/newfile.txt does not exist yet
  symlinkSync(join(projectDir, "real", "newfile.txt"), join(projectDir, "link.txt"));

  const tools = createTools(projectDir);
  await tools.write("link.txt", "created via dangling symlink");
  assert.equal(readFileSync(join(projectDir, "real", "newfile.txt"), "utf-8"), "created via dangling symlink");
});

// --- cappedBuffer tests ---

test("cappedBuffer truncates output beyond 10MB", () => {
  const buf = cappedBuffer();
  // Write 11MB in chunks
  const chunk = "x".repeat(1024 * 1024); // 1MB
  for (let i = 0; i < 11; i++) {
    buf.append(chunk);
  }
  assert.ok(buf.value.length <= 10 * 1024 * 1024 + 100, "buffer should be capped near 10MB");
  assert.match(buf.value, /\[trama\] output truncated at 10MB/);
});

test("cappedBuffer ignores appends after truncation", () => {
  const buf = cappedBuffer();
  const chunk = "x".repeat(10 * 1024 * 1024 + 1);
  buf.append(chunk);
  const lengthAfterCap = buf.value.length;
  buf.append("more data");
  assert.equal(buf.value.length, lengthAfterCap, "length should not change after truncation");
});

// --- shell edge cases ---

test("createTools shell handles commands that exit with null code", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));

  const tools = createTools(projectDir);
  // kill -9 causes null exit code in Node
  const result = await tools.shell("kill -9 $$");
  assert.equal(typeof result.exitCode, "number");
  assert.notEqual(result.exitCode, 0);
});
