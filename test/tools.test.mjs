import assert from "node:assert/strict";
import { createServer } from "http";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { createTools } from "../packages/runtime/dist/tools.js";
import { cappedBuffer, checkedEnv } from "../packages/runtime/dist/child-process.js";
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

test("a command stopped at its time says so of itself: by what its result has, and not by what it wrote or how long it took", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));
  const tools = createTools(projectDir);

  assert.deepEqual(await tools.shell("echo some; sleep 5", { timeout: 300 }), { exitCode: 1, stdout: "some\n", stderr: "\ntimeout", timedOut: true });
  assert.deepEqual(await tools.shellIn(projectDir, "sleep 5", { timeout: 0 }), { exitCode: 1, stdout: "", stderr: "\ntimeout", timedOut: true });
  // A command that ended by itself has no such thing said of it — whatever it wrote last, and however it ended.
  assert.deepEqual(await tools.shell("printf 'it gave up\\ntimeout' >&2; exit 1", { timeout: 10_000 }), { exitCode: 1, stdout: "", stderr: "it gave up\ntimeout" });
  assert.deepEqual(await tools.shell("echo done"), { exitCode: 0, stdout: "done\n", stderr: "" });
});

test("createTools shell: a command that reads its input finds it at an end", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));
  const tools = createTools(projectDir);

  // Nothing is ever sent to a command. Left waiting for input, this would only end at its timeout.
  const result = await tools.shell("cat; echo after", { timeout: 10_000 });
  assert.deepEqual(result, { exitCode: 0, stdout: "after\n", stderr: "" });
});

test("createTools stopActiveShells terminates in-flight commands", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));

  const tools = createTools(projectDir);
  const pending = tools.shell("sleep 10");

  await new Promise(resolve => setTimeout(resolve, 50));
  await tools.stopActiveShells();

  const result = await pending;
  assert.notEqual(result.exitCode, 0);
});

test("createTools stopActiveShells terminates background processes in the same process group", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));

  const tools = createTools(projectDir);
  const pending = tools.shell("(sleep 0.2; echo leaked > leaked.txt) & sleep 10");

  await new Promise(resolve => setTimeout(resolve, 50));
  await tools.stopActiveShells();

  const result = await pending;
  await new Promise(resolve => setTimeout(resolve, 400));

  assert.notEqual(result.exitCode, 0);
  assert.equal(existsSync(join(projectDir, "leaked.txt")), false);
});

test("createTools stopActiveShells still terminates background processes after the shell has exited", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));

  const tools = createTools(projectDir);
  const result = await tools.shell('nohup sh -c "sleep 0.2; echo leaked > leaked.txt" >/dev/null 2>&1 &');

  assert.equal(result.exitCode, 0);

  await tools.stopActiveShells();
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

test("createTools read gives clear error for missing files", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));

  const tools = createTools(projectDir);
  await assert.rejects(
    async () => tools.read("nonexistent.txt"),
    /File not found: nonexistent\.txt/,
  );
});

test("createTools shell commands do not inherit the bridge's address or its init file", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));

  // A runner working inside a program (create or update, called by one) has
  // these in its own environment; the init file holds that program's bridge secret.
  const saved = { port: process.env.TRAMA_PORT, init: process.env.TRAMA_INIT };
  process.env.TRAMA_PORT = "12345";
  process.env.TRAMA_INIT = "/somewhere/init.json";
  t.after(() => {
    for (const [key, value] of [["TRAMA_PORT", saved.port], ["TRAMA_INIT", saved.init]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  const tools = createTools(projectDir);
  const result = await tools.shell('echo "[$TRAMA_PORT][$TRAMA_INIT][$HOME]"');
  assert.equal(result.stdout.trim(), `[][][${process.env.HOME}]`);
});

test("createTools write through a link to a file in a directory that is not there yet makes the directory", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));
  symlinkSync(join(projectDir, "not-made", "dest.txt"), join(projectDir, "link.txt"));

  await createTools(projectDir).write("link.txt", "hello");
  assert.equal(readFileSync(join(projectDir, "not-made", "dest.txt"), "utf-8"), "hello");
});

test("superviseChild stops a child at once when it is asked to with a signal that has already fired", async () => {
  const { spawn } = await import("child_process");
  const { superviseChild } = await import("../packages/runtime/dist/child-process.js");
  const child = spawn("sleep", ["30"], { detached: true, stdio: ["ignore", "pipe", "pipe"] });

  const started = performance.now();
  const exit = await superviseChild(child, { timeout: 30_000, stopSignal: AbortSignal.abort() });
  assert.equal(exit.stopped, true);
  assert.equal(exit.signal, "SIGTERM");
  assert.ok(performance.now() - started < 5_000);
});

test("createTools write refuses to overwrite the project root itself or recreate a moved-away project as a file", async (t) => {
  const parent = makeTempDir("trama-tools-root-");
  t.after(() => cleanupTempDir(parent));
  const projectDir = join(parent, "project");
  mkdirSync(projectDir, { recursive: true });
  symlinkSync(".", join(projectDir, "self-link"));

  const tools = createTools(projectDir);
  for (const rootPath of ["", ".", "self-link"]) {
    await assert.rejects(async () => tools.write(rootPath, "nope"), /EISDIR/);
  }

  const { renameSync } = await import("fs");
  const movedDir = join(parent, "moved");
  renameSync(projectDir, movedDir);
  await assert.rejects(async () => tools.write("", "nope"), /There is no project at/);
  await assert.rejects(async () => tools.write(".", "nope"), /leads on from what does not exist/);
  assert.equal(existsSync(projectDir), false);
});

test("createTools fetch truncates streaming responses past 10 MB without reading an unbounded stream", async (t) => {
  const projectDir = makeTempDir("trama-tools-fetch-");
  t.after(() => cleanupTempDir(projectDir));

  let chunksSent = 0;
  const chunk = "a".repeat(256 * 1024);
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    const pump = () => {
      while (!res.destroyed && chunksSent < 400) {
        chunksSent += 1;
        if (!res.write(chunk)) {
          res.once("drain", pump);
          return;
        }
      }
      if (!res.destroyed) res.end();
    };
    pump();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const tools = createTools(projectDir);
  const response = await tools.fetch(`http://127.0.0.1:${port}/stream`);
  assert.equal(response.status, 200);
  assert.equal(response.body.endsWith("\n[trama] response body truncated at 10MB"), true);
  assert.ok(chunksSent < 200, `stream should cancel early once truncated, but sent ${chunksSent} chunks`);
});

test("superviseChild does not mark an already-exited child as timedOut while draining background pipe holders", async (t) => {
  const { spawn } = await import("child_process");
  const { superviseChild } = await import("../packages/runtime/dist/child-process.js");
  const child = spawn("sh", ["-c", "printf done; sleep 10 &"], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => {
    try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  });

  const exit = await superviseChild(child, { timeout: 250 });
  assert.equal(exit.code, 0);
  assert.equal(exit.timedOut, false);
  assert.equal(exit.stopped, false);
  assert.equal(exit.stdout.toString("utf-8"), "done");
});

test("createTools shell takes any time for a timeout: no limit at all is one, and no time at all ends the command at once", async (t) => {
  const projectDir = makeTempDir("trama-tools-timeout-");
  t.after(() => cleanupTempDir(projectDir));
  const tools = createTools(projectDir);

  for (const timeout of [Infinity, 2 ** 31, 60_000]) {
    const result = await tools.shell("echo ran", { timeout });
    assert.deepEqual([result.exitCode, result.stdout.trim()], [0, "ran"], String(timeout));
  }
  const result = await tools.shell("sleep 5; echo ran", { timeout: 0 });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /timeout$/);
});

test("createTools fetch gives an answer that has no body an empty one", async (t) => {
  const projectDir = makeTempDir("trama-tools-fetch-");
  t.after(() => cleanupTempDir(projectDir));
  const server = createServer((_req, res) => { res.writeHead(204).end(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const response = await createTools(projectDir).fetch(`http://127.0.0.1:${server.address().port}/`);
  assert.deepEqual([response.status, response.body], [204, ""]);
});

test("a command has the runner's variables, those its run was started with, and those it is given — in that order, and never the bridge's", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));
  const { withEnv } = await import("./helpers.mjs");

  await withEnv({ FROM_RUNNER: "runner", SHADOWED: "runner", TRAMA_PORT: "1234", TRAMA_INIT: "/somewhere" }, async () => {
    const tools = createTools(projectDir, undefined, { FROM_RUN: "run", SHADOWED: "run", TWICE: "run" });
    const show = 'printf %s "$FROM_RUNNER/$FROM_RUN/$SHADOWED/$TWICE/$ONCE/${TRAMA_PORT:-none}/${TRAMA_INIT:-none}"';
    assert.equal((await tools.shell(show)).stdout, "runner/run/run/run//none/none");
    assert.equal((await tools.shell(show, { env: { TWICE: "call", ONCE: "call" } })).stdout, "runner/run/run/call/call/none/none");
    // What one command was given, the next has not.
    assert.equal((await tools.shell(show, { env: {} })).stdout, "runner/run/run/run//none/none");
    // The bridge's two are the runner's to give, whoever names them; and none given is none given, however that is said.
    assert.equal((await tools.shell(show, { env: { TRAMA_PORT: "1", TRAMA_INIT: "x", ONCE: undefined } })).stdout, "runner/run/run/run//none/none");
    assert.equal((await tools.shell(show, { env: null })).stdout, "runner/run/run/run//none/none");
    await assert.rejects(() => tools.shell("true", { env: { "A B=C": "x" } }), /env has a name no variable can have: "A B=…"$/);
    await assert.rejects(() => tools.shell("true", { env: { "A B": 1 } }), /env gives "A B" what is not text a variable can hold/);
    await assert.rejects(() => tools.shell("true", { env: "A=1" }), /env is an object of variables/);
  });
  // Without any, a command has the runner's own as before.
  assert.equal((await createTools(projectDir).shell('printf %s "${HOME:+has a home}"')).stdout, "has a home");
});

test("the shell that runs a command is the runner's, whatever PATH the command is given; and a command the system will not start is a result", async (t) => {
  const { chmodSync } = await import("fs");
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));
  // Something else of the shell's name, where a PATH that says "here" would find it.
  writeFileSync(join(projectDir, "sh"), "#!/bin/sh\necho planted\n");
  chmodSync(join(projectDir, "sh"), 0o755);

  for (const tools of [createTools(projectDir), createTools(projectDir, undefined, { PATH: "" })]) {
    for (const PATH of ["", ".", "/nonexistent"]) {
      const result = await tools.shell('printf %s "ran with PATH=$PATH"; command -v ls >/dev/null 2>&1 || printf ", and finds no ls"', { env: { PATH } });
      assert.deepEqual(result, { exitCode: 0, stdout: `ran with PATH=${PATH}, and finds no ls`, stderr: "" });
    }
  }
  assert.deepEqual(await createTools(projectDir, undefined, { PATH: "" }).shell("printf ran"), { exitCode: 0, stdout: "ran", stderr: "" });

  // More than the system hands a process: the command is not started, and that is what the call says.
  const tooMuch = await createTools(projectDir).shell("true", { env: { BIG: "x".repeat(8 * 1024 * 1024) } });
  assert.equal(tooMuch.exitCode, 1);
  assert.match(tooMuch.stderr, /E2BIG/);
});

test("a runner that has no PATH finds the shell where the system keeps it, not in the project", async (t) => {
  const { chmodSync } = await import("fs");
  const { withEnv } = await import("./helpers.mjs");
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));
  writeFileSync(join(projectDir, "sh"), "#!/bin/sh\necho planted\n");
  chmodSync(join(projectDir, "sh"), 0o755);

  const result = await withEnv({ PATH: undefined }, () => createTools(projectDir).shell("printf ran"));
  assert.deepEqual(result, { exitCode: 0, stdout: "ran", stderr: "" });
});

test("the shell is sh to itself and in what it says, wherever the runner found it", async (t) => {
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));
  const tools = createTools(projectDir);

  assert.equal((await tools.shell('printf %s "$0"')).stdout, "sh");
  const unknown = await tools.shell("no-such-command-anywhere");
  assert.equal(unknown.exitCode, 127);
  assert.match(unknown.stderr, /^sh: /);
  assert.equal((await tools.shell("echo hi", { cwd: "missing-dir" })).stderr, "spawn sh ENOENT");
});

test("what is given for variables is held to what variables are, and handed back as a copy", () => {
  for (const none of [null, undefined, ["A=1"], "A=1", 5]) assert.throws(() => checkedEnv(none), /env is an object of variables: each a name, and its text/);
  const given = { A: "1", NOT_GIVEN: undefined, TRAMA_PORT: "7", TRAMA_INIT: "/x", __proto__: null };
  const checked = checkedEnv(given);
  assert.deepEqual({ ...checked }, { A: "1" });
  assert.notEqual(checked, given);
});

test("a directory called sh on the runner's PATH is no shell: the next is taken", async (t) => {
  const { withEnv } = await import("./helpers.mjs");
  const projectDir = makeTempDir("trama-tools-");
  t.after(() => cleanupTempDir(projectDir));
  mkdirSync(join(projectDir, "bin", "sh"), { recursive: true });

  const result = await withEnv({ PATH: `${join(projectDir, "bin")}:${process.env.PATH}` }, () => createTools(projectDir).shell("printf ran"));
  assert.deepEqual(result, { exitCode: 0, stdout: "ran", stderr: "" });
});

test("a command does nothing before whoever watches for its runner knows of it: a runner that dies as it starts one leaves nothing behind", { skip: process.platform === "win32" }, async (t) => {
  const { spawn } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const { REPO_ROOT, isAlive, pidIn, waitFor } = await import("./helpers.mjs");
  const projectDir = makeTempDir("trama-tools-gate-");
  t.after(() => cleanupTempDir(projectDir));
  // A runner that is slow between starting a command and saying that it did: the moment in which a command
  // that was already at its work would be nobody's to stop, were its runner to die then.
  const runner = `import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const started = cp.spawn;
cp.spawn = (...args) => {
  const child = started(...args);
  if (args[1]?.[0] === "-c") { const until = Date.now() + 500; while (Date.now() < until); }
  return child;
};
syncBuiltinESMExports();
const { createTools } = await import(${JSON.stringify(pathToFileURL(join(REPO_ROOT, "packages", "runtime", "dist", "tools.js")).href)});
await createTools(${JSON.stringify(projectDir)}).shell("echo $$ > shell.pid; sleep 60", { timeout: 60000 });`;
  const running = spawn(process.execPath, ["--input-type=module", "-e", runner], { stdio: "ignore" });
  t.after(() => { running.kill("SIGKILL"); });
  const pidFile = join(projectDir, "shell.pid");
  await waitFor(() => pidIn(pidFile), "the command to be at its work", 20_000);
  const shell = pidIn(pidFile);
  t.after(() => { try { process.kill(-shell, "SIGKILL"); } catch { /* gone, as it should be */ } });
  // The runner dies the moment its command is seen to have begun.
  running.kill("SIGKILL");
  await waitFor(() => !isAlive(shell), "the command of a runner that was killed to be gone", 8_000);
});

test("what is fetched is cut at ten megabytes of what was sent, whatever it is text of", async (t) => {
  const projectDir = makeTempDir("trama-tools-fetch-");
  t.after(() => cleanupTempDir(projectDir));
  // Text that takes three bytes a character: twelve megabytes of it sent, in four million characters.
  const chunk = Buffer.from("語".repeat(64 * 1024));
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    let sent = 0;
    const pump = () => {
      while (!res.destroyed && sent < 64) {
        sent += 1;
        if (!res.write(chunk)) return void res.once("drain", pump);
      }
      if (!res.destroyed) res.end();
    };
    pump();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });

  const { body } = await createTools(projectDir).fetch(`http://127.0.0.1:${server.address().port}/`);
  const note = "\n[trama] response body truncated at 10MB";
  assert.equal(body.endsWith(note), true, `it was cut: ${body.length} characters`);
  const kept = body.slice(0, -note.length);
  // (Ten megabytes are 3,495,253 such characters and a third of one: what is kept is whole characters.)
  assert.equal(kept.length, Math.floor(10 * 1024 * 1024 / 3));
  assert.equal(/^語+$/.test(kept), true);
});
