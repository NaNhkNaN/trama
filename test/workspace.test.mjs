import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, symlinkSync } from "fs";
import { spawn } from "child_process";
import { join } from "path";
import { createWorkspace } from "../packages/runtime/dist/workspace.js";
import { cleanupTempDir, makeTempDir, writeText } from "./helpers.mjs";

test("workspace.write creates file and workspace.read reads it back", async (t) => {
  const dir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(dir));

  const ws = createWorkspace(dir);
  await ws.write("reports/analysis.json", '{"score":42}');
  const content = await ws.read("reports/analysis.json");

  assert.equal(content, '{"score":42}');
  // Verify file actually exists on disk
  assert.ok(existsSync(join(dir, "reports", "analysis.json")));
});

test("workspace.write is atomic (temp + rename)", async (t) => {
  const dir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(dir));

  const ws = createWorkspace(dir);
  await ws.write("data.txt", "hello world");

  // File should exist with correct content (no partial writes)
  assert.equal(readFileSync(join(dir, "data.txt"), "utf-8"), "hello world");
});

test("workspace.read throws on missing file", async (t) => {
  const dir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(dir));

  const ws = createWorkspace(dir);
  await assert.rejects(
    () => ws.read("nonexistent.txt"),
    /Workspace artifact not found/,
  );
});

test("workspace.write rejects path traversal", async (t) => {
  const dir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(dir));

  const ws = createWorkspace(dir);
  await assert.rejects(
    () => ws.write("../escape.txt", "bad"),
    /Path escapes project directory/,
  );
});

test("workspace.read rejects path traversal", async (t) => {
  const dir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(dir));

  const ws = createWorkspace(dir);
  await assert.rejects(
    () => ws.read("../../etc/passwd"),
    /Path escapes project directory/,
  );
});

test("workspace.list returns matching files sorted by path", async (t) => {
  const dir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(dir));

  const ws = createWorkspace(dir);
  await ws.write("reports/b.json", "b");
  await ws.write("reports/a.json", "a");
  await ws.write("reports/c.txt", "c");
  await ws.write("other/d.json", "d");

  const jsonFiles = await ws.list("reports/*.json");
  assert.deepEqual(jsonFiles, ["reports/a.json", "reports/b.json"]);
});

test("workspace.list with ** matches nested paths", async (t) => {
  const dir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(dir));

  const ws = createWorkspace(dir);
  await ws.write("a/b/c.txt", "deep");
  await ws.write("a/d.txt", "shallow");
  await ws.write("e.txt", "root");

  const all = await ws.list("**/*.txt");
  assert.ok(all.includes("a/b/c.txt"));
  assert.ok(all.includes("a/d.txt"));
  assert.ok(all.includes("e.txt"));
});

test("workspace.list returns empty array when no matches", async (t) => {
  const dir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(dir));

  const ws = createWorkspace(dir);
  const result = await ws.list("*.nonexistent");
  assert.deepEqual(result, []);
});

test("workspace.observe returns content immediately for existing single file", async (t) => {
  const dir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(dir));

  const ws = createWorkspace(dir);
  await ws.write("ready.txt", "done");

  const content = await ws.observe("ready.txt");
  assert.equal(content, "done");
});

test("workspace.observe waits for file to appear", async (t) => {
  const dir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(dir));

  const ws = createWorkspace(dir);

  // Write the file after a small delay
  setTimeout(() => {
    writeText(join(dir, "delayed.txt"), "appeared");
  }, 300);

  const content = await ws.observe("delayed.txt", { timeout: 5000 });
  assert.equal(content, "appeared");
});

test("workspace.observe times out when file never appears", async (t) => {
  const dir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(dir));

  const ws = createWorkspace(dir);

  await assert.rejects(
    () => ws.observe("never.txt", { timeout: 500 }),
    /timed out/,
  );
});

test("workspace.observe refuses at once a single path that could never be read", async (t) => {
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(wsDir));
  writeText(join(wsDir, "file.txt"), "a file");
  const ws = createWorkspace(wsDir);

  // No timeout is given: without the refusal these would be waited for until the run ended.
  const soon = (promise) => Promise.race([
    promise.then(() => "answered", err => err.message),
    new Promise(resolve => setTimeout(() => resolve("still waiting"), 2_000).unref()),
  ]);
  assert.match(await soon(ws.observe("../outside.txt")), /Path escapes project directory/);
  assert.match(await soon(ws.observe("file.txt/below.txt")), /ENOTDIR/);
});

test("workspace.observe with expect waits for multiple files", async (t) => {
  const dir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(dir));

  const ws = createWorkspace(dir);

  // Write one file immediately
  await ws.write("results/a.json", '{"a":1}');

  // Write second file after a delay
  setTimeout(() => {
    writeText(join(dir, "results", "b.json"), '{"b":2}');
  }, 300);

  const results = await ws.observe("results/*.json", { expect: 2, timeout: 5000 });

  assert.ok(Array.isArray(results));
  assert.equal(results.length, 2);
  // Sorted by path
  assert.equal(results[0].path, "results/a.json");
  assert.equal(results[0].content, '{"a":1}');
  assert.equal(results[1].path, "results/b.json");
  assert.equal(results[1].content, '{"b":2}');
});

test("workspace.observe with expect times out when not enough files", async (t) => {
  const dir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(dir));

  const ws = createWorkspace(dir);
  await ws.write("results/only-one.json", "{}");

  await assert.rejects(
    () => ws.observe("results/*.json", { expect: 3, timeout: 500 }),
    /timed out.*Found 1\/3/,
  );
});

test("workspace.observe returns array for glob pattern even with one match", async (t) => {
  const dir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(dir));

  const ws = createWorkspace(dir);
  await ws.write("results/only.json", "data");

  const results = await ws.observe("results/*.json", { timeout: 1000 });
  assert.ok(Array.isArray(results));
  assert.equal(results.length, 1);
  assert.equal(results[0].path, "results/only.json");
});

test("workspace.observe counts unique paths not write events", async (t) => {
  const dir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(dir));

  const ws = createWorkspace(dir);

  // Write same file twice — should count as 1
  await ws.write("results/a.json", "v1");
  await ws.write("results/a.json", "v2");

  // Need 2 unique paths
  setTimeout(() => {
    writeText(join(dir, "results", "b.json"), "v1");
  }, 300);

  const results = await ws.observe("results/*.json", { expect: 2, timeout: 5000 });
  assert.equal(results.length, 2);
  // a.json should have latest content
  assert.equal(results[0].content, "v2");
});

test("workspace.observe respects abort signal", async (t) => {
  const dir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(dir));

  const controller = new AbortController();
  const ws = createWorkspace(dir, controller.signal);

  setTimeout(() => controller.abort(), 200);

  await assert.rejects(
    () => ws.observe("never.txt", { timeout: 10000 }),
    /aborted/,
  );
});

test("workspace.write rejects symlinks escaping workspace", async (t) => {
  const wsDir = makeTempDir("trama-ws-");
  const outside = makeTempDir("trama-outside-");
  t.after(() => { cleanupTempDir(wsDir); cleanupTempDir(outside); });

  // Create a symlink inside workspace pointing outside
  symlinkSync(outside, join(wsDir, "escape-link"));

  const ws = createWorkspace(wsDir);
  await assert.rejects(
    () => ws.write("escape-link/secret.txt", "bad"),
    /Path escapes project directory/,
  );
});

test("workspace.read rejects symlinks escaping workspace", async (t) => {
  const wsDir = makeTempDir("trama-ws-");
  const outside = makeTempDir("trama-outside-");
  t.after(() => { cleanupTempDir(wsDir); cleanupTempDir(outside); });

  writeText(join(outside, "secret.txt"), "sensitive data");
  symlinkSync(join(outside, "secret.txt"), join(wsDir, "escape-link.txt"));

  const ws = createWorkspace(wsDir);
  await assert.rejects(
    () => ws.read("escape-link.txt"),
    /Path escapes project directory/,
  );
});

test("workspace.write writes through internal symlink (not replacing it)", async (t) => {
  const dir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(dir));

  const ws = createWorkspace(dir);

  // Create a real file and a symlink to it inside workspace
  await ws.write("real-target.txt", "original");
  symlinkSync(join(dir, "real-target.txt"), join(dir, "link.txt"));

  // Write through the symlink
  await ws.write("link.txt", "updated");

  // The symlink should still be a symlink
  const { lstatSync: lstat, readFileSync: readFs } = await import("fs");
  assert.ok(lstat(join(dir, "link.txt")).isSymbolicLink(), "should remain a symlink");
  // The target file should have the new content
  assert.equal(readFs(join(dir, "real-target.txt"), "utf-8"), "updated");
  // Reading through the link should also return updated content
  assert.equal(await ws.read("link.txt"), "updated");
});

test("workspace.list includes symlinked files inside workspace", async (t) => {
  const dir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(dir));

  const ws = createWorkspace(dir);
  await ws.write("real.txt", "real content");
  symlinkSync(join(dir, "real.txt"), join(dir, "linked.txt"));

  const files = await ws.list("*.txt");
  assert.ok(files.includes("linked.txt"), "symlinked file should appear in list");
  assert.ok(files.includes("real.txt"), "real file should appear in list");
});

test("workspace.observe sees symlinked artifacts", async (t) => {
  const dir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(dir));

  const ws = createWorkspace(dir);
  await ws.write("data/real.json", '{"v":1}');
  symlinkSync(join(dir, "data", "real.json"), join(dir, "data", "alias.json"));

  const results = await ws.observe("data/*.json", { expect: 2, timeout: 1000 });
  assert.ok(Array.isArray(results));
  assert.equal(results.length, 2);
  const paths = results.map(r => r.path).sort();
  assert.deepEqual(paths, ["data/alias.json", "data/real.json"]);
});

test("workspace.write handles dangling internal symlinks (writes to target)", async (t) => {
  const dir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(dir));

  const ws = createWorkspace(dir);

  // Create a dangling symlink: link.txt -> future.txt (future.txt doesn't exist yet)
  const { symlinkSync: symlink, lstatSync: lstat, readFileSync: readFs } = await import("fs");
  symlink(join(dir, "future.txt"), join(dir, "link.txt"));

  // Verify it's dangling
  assert.ok(lstat(join(dir, "link.txt")).isSymbolicLink());
  assert.equal(existsSync(join(dir, "future.txt")), false);

  // Write through the dangling symlink
  await ws.write("link.txt", "hello future");

  // The symlink should remain, and the target file should now exist
  assert.ok(lstat(join(dir, "link.txt")).isSymbolicLink(), "symlink should be preserved");
  assert.equal(readFs(join(dir, "future.txt"), "utf-8"), "hello future");
  assert.equal(await ws.read("link.txt"), "hello future");
});

test("workspace.list excludes symlinks escaping workspace", async (t) => {
  const wsDir = makeTempDir("trama-ws-");
  const outside = makeTempDir("trama-outside-");
  t.after(() => { cleanupTempDir(wsDir); cleanupTempDir(outside); });

  const ws = createWorkspace(wsDir);
  await ws.write("safe.txt", "ok");
  writeText(join(outside, "external.txt"), "bad");
  symlinkSync(join(outside, "external.txt"), join(wsDir, "escape.txt"));

  const files = await ws.list("*.txt");
  assert.ok(files.includes("safe.txt"));
  assert.ok(!files.includes("escape.txt"), "external symlink should be excluded from list");
});

test("workspace.list handles symlink cycles without infinite recursion", async (t) => {
  const dir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(dir));

  const ws = createWorkspace(dir);
  await ws.write("real.txt", "content");
  // Create a symlink cycle: loop -> . (points back to workspace root)
  symlinkSync(dir, join(dir, "loop"));

  const files = await ws.list("**/*.txt");
  // loop/ is traversed once (produces loop/real.txt), but loop/loop/ is not
  // (cycle detection kicks in). Without cycle detection this would be infinite.
  assert.ok(files.includes("real.txt"));
  assert.ok(files.includes("loop/real.txt"));
  assert.ok(!files.some(f => f.startsWith("loop/loop/")), "must not recurse into loop/loop/");
  assert.ok(files.length <= 2, `expected at most 2 files, got ${files.length}: ${JSON.stringify(files)}`);
});

test("workspace.observe with symlink cycle counts unique real artifacts", async (t) => {
  const dir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(dir));

  const ws = createWorkspace(dir);
  await ws.write("data.txt", "only one");
  // Create cycle
  symlinkSync(dir, join(dir, "cycle"));

  // There are 2 workspace-relative paths: data.txt and cycle/data.txt
  // (cycle is a legitimate traversal that produces its own paths)
  // But cycle/cycle/ is not traversed (cycle detection kicks in)
  const files = await ws.list("**/*.txt");
  assert.ok(files.includes("data.txt"));
  assert.ok(files.includes("cycle/data.txt"));
  assert.ok(!files.some(f => f.startsWith("cycle/cycle/")), "should not recurse into cycle/cycle/");
});

test("workspace.list returns paths through directory alias symlinks", async (t) => {
  const dir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(dir));

  const ws = createWorkspace(dir);
  mkdirSync(join(dir, "real"), { recursive: true });
  await ws.write("real/data.txt", "content");
  symlinkSync(join(dir, "real"), join(dir, "alias"));

  // Both real/ and alias/ paths should appear
  const allFiles = await ws.list("**/*.txt");
  assert.ok(allFiles.includes("real/data.txt"), "real path should be listed");
  assert.ok(allFiles.includes("alias/data.txt"), "alias path should be listed");

  // Pattern-specific queries should work for both
  const realFiles = await ws.list("real/*.txt");
  assert.deepEqual(realFiles, ["real/data.txt"]);
  const aliasFiles = await ws.list("alias/*.txt");
  assert.deepEqual(aliasFiles, ["alias/data.txt"]);

  // observe with expect: 2 should resolve — two unique paths
  const results = await ws.observe("**/*.txt", { expect: 2, timeout: 1000 });
  assert.ok(Array.isArray(results));
  assert.equal(results.length, 2);
});

test("every alias of a shared directory is listed and observed; a link come upon through a link is not followed", async (t) => {
  const dir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(dir));
  const ws = createWorkspace(dir);
  await ws.write("shared/item.txt", "one item");
  for (const name of ["a", "b"]) {
    mkdirSync(join(dir, name));
    symlinkSync("../shared", join(dir, name, "ref"));
  }

  // Two ways to one directory are not a loop: what can be read under each is listed under each.
  assert.equal(await ws.read("b/ref/item.txt"), "one item");
  assert.deepEqual(await ws.list("**"), ["a/ref/item.txt", "b/ref/item.txt", "shared/item.txt"]);
  assert.deepEqual(await ws.observe("b/**", { timeout: 1000 }), [{ path: "b/ref/item.txt", content: "one item" }]);

  // A way back up is a loop, and is gone round once: what is there is listed under it, and the
  // links found there — its own among them — are left for where they really are.
  symlinkSync("..", join(dir, "a", "up"));
  assert.deepEqual(await ws.list("**"),
    ["a/ref/item.txt", "a/up/shared/item.txt", "b/ref/item.txt", "shared/item.txt"]);
  // Not listed, though it can be read.
  assert.equal(await ws.read("a/up/b/ref/item.txt"), "one item");
});

test("directories that all link to one another are listed in the time it takes to visit each link once", async (t) => {
  const dir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(dir));
  const ws = createWorkspace(dir);
  const names = Array.from({ length: 9 }, (_, i) => `d${i}`);
  for (const name of names) await ws.write(`${name}/file.txt`, name);
  for (const from of names) for (const to of names) if (from !== to) symlinkSync(`../${to}`, join(dir, from, `to-${to}`));

  // Followed wherever they are come upon, these links make more paths than can be walked: every
  // order of every choice of the nine. Followed where they really are, each is walked once.
  const started = performance.now();
  const listed = await ws.list("**");
  assert.equal(listed.length, names.length + names.length * (names.length - 1));
  assert.ok(listed.includes("d3/to-d7/file.txt"));
  assert.ok(performance.now() - started < 5_000, "the listing took too long to be bounded");
});

test("workspace creates directory if it does not exist", async (t) => {
  const dir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(dir));

  const wsDir = join(dir, "new-workspace");
  assert.equal(existsSync(wsDir), false);

  const ws = createWorkspace(wsDir);
  assert.ok(existsSync(wsDir));

  await ws.write("test.txt", "created");
  assert.equal(await ws.read("test.txt"), "created");
});

test("workspace.write that cannot put its file in place leaves no temp file behind", async (t) => {
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(wsDir));
  mkdirSync(join(wsDir, "taken")); // a directory where the artifact would go

  await assert.rejects(createWorkspace(wsDir).write("taken", "content"));
  assert.deepEqual(readdirSync(wsDir), ["taken"]);
});

test("workspace.write refuses the workspace itself as an artifact, and puts nothing beside it", async (t) => {
  const parent = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(parent));
  const wsDir = join(parent, "ws");
  const workspace = createWorkspace(wsDir);
  symlinkSync(".", join(wsDir, "self"));

  for (const path of ["", ".", "self"]) {
    await assert.rejects(workspace.write(path, "content"), /is the directory itself/);
  }
  assert.deepEqual(readdirSync(parent), ["ws"]);
});

test("workspace.write creates its temp file, and does not write through one that is already there", async (t) => {
  const crypto = (await import("node:crypto")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const parent = makeTempDir("trama-ws-");
  const realRandom = crypto.randomBytes;
  t.after(() => { crypto.randomBytes = realRandom; syncBuiltinESMExports(); cleanupTempDir(parent); });
  const wsDir = join(parent, "ws");
  const workspace = createWorkspace(wsDir);
  writeFileSync(join(parent, "victim.txt"), "VICTIM");

  // The one name the temp file can have this time — and a link planted there, pointing outside.
  crypto.randomBytes = (size) => Buffer.alloc(size, 0xab);
  syncBuiltinESMExports();
  symlinkSync(join(parent, "victim.txt"), join(wsDir, `.trama-tmp-${"ab".repeat(6)}`));

  await assert.rejects(workspace.write("note.txt", "from the workspace"), { code: "EEXIST" });
  assert.equal(readFileSync(join(parent, "victim.txt"), "utf-8"), "VICTIM");
  assert.equal(existsSync(join(wsDir, "note.txt")), false);
});

test("a temp file left by a write that was cut off is not an artifact", async (t) => {
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(wsDir));
  const workspace = createWorkspace(wsDir);
  await workspace.write("report.md", "whole");
  // What a runner killed between writing and moving leaves behind.
  writeFileSync(join(wsDir, "report.md.trama-tmp-0123456789ab"), "half of");

  assert.deepEqual(await workspace.list("**"), ["report.md"]);
  assert.deepEqual(await workspace.observe("report*", { timeout: 0 }), [{ path: "report.md", content: "whole" }]);
});

test("workspace.write keeps the permissions of the artifact it replaces", async (t) => {
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(wsDir));
  const workspace = createWorkspace(wsDir);
  writeFileSync(join(wsDir, "run.sh"), "old", { mode: 0o755 });

  await workspace.write("run.sh", "new");
  const { statSync } = await import("fs");
  assert.equal(statSync(join(wsDir, "run.sh")).mode & 0o777, 0o755);
  assert.equal(readFileSync(join(wsDir, "run.sh"), "utf-8"), "new");
});

test("a workspace somebody removed is made anew by the next write: it is nothing but its path", async (t) => {
  const parent = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(parent));
  const dir = join(parent, "workspace");
  const ws = createWorkspace(dir);
  await ws.write("first.txt", "1");
  rmSync(dir, { recursive: true });
  await ws.write("deep/second.txt", "2");
  assert.equal(readFileSync(join(dir, "deep", "second.txt"), "utf-8"), "2");
});

test("a workspace named by a link, whose directory somebody removed, is made anew where the link says", async (t) => {
  const parent = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(parent));
  mkdirSync(join(parent, "shared", "data"), { recursive: true });
  symlinkSync(join(parent, "shared", "data"), join(parent, "ws"));
  const ws = createWorkspace(join(parent, "ws"));
  await ws.write("first.txt", "1");
  rmSync(join(parent, "shared", "data"), { recursive: true });
  await ws.write("second.txt", "2");
  assert.equal(readFileSync(join(parent, "shared", "data", "second.txt"), "utf-8"), "2");
});

test("workspace.observe fails promptly when an exact target becomes a directory and guards traversal even with expect > 1", async (t) => {
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(wsDir));
  const ws = createWorkspace(wsDir);

  await assert.rejects(
    () => ws.observe("../outside.txt", { expect: 2, timeout: 5_000 }),
    /Path escapes/,
  );

  const started = performance.now();
  const pending = ws.observe("out/result.txt", { timeout: 10_000 });
  setTimeout(() => mkdirSync(join(wsDir, "out", "result.txt"), { recursive: true }), 80);

  await assert.rejects(pending, /EISDIR/);
  assert.ok(performance.now() - started < 3_000, "observe should fail as soon as the directory appears instead of timing out");
});

// --- What a pattern means, and what is listed ---

test("a pattern's ** is any run of characters, and with its slash any number of whole directories", async (t) => {
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(wsDir));
  const ws = createWorkspace(wsDir);
  for (const path of ["top.md", "docs/a.md", "docs/sub/b.md", "ab.txt", "a/x/b.txt", "a/xb.txt", "notes (1).txt", "notes+1.txt", "x.y"]) await ws.write(path, path);

  for (const [pattern, expected] of [
    ["**/*.md", ["docs/a.md", "docs/sub/b.md", "top.md"]],
    ["**.md", ["docs/a.md", "docs/sub/b.md", "top.md"]],
    ["docs/**.md", ["docs/a.md", "docs/sub/b.md"]],
    ["docs/**", ["docs/a.md", "docs/sub/b.md"]],
    ["docs/*", ["docs/a.md"]],
    ["a**", ["a/x/b.txt", "a/xb.txt", "ab.txt"]],
    ["a**/b.txt", ["a/x/b.txt", "ab.txt"]],
    // (Whole directories: what stands between two slashes, not the end of a name.)
    ["a/**/b.txt", ["a/x/b.txt"]],
    ["a/**b.txt", ["a/x/b.txt", "a/xb.txt"]],
    ["?b.txt", ["ab.txt"]],
    // Every other character is itself — those a pattern of another kind would take for an operator among them.
    ["notes (1).txt", ["notes (1).txt"]],
    ["notes+1.txt", ["notes+1.txt"]],
    ["x.y", ["x.y"]],
    ["x?y", ["x.y"]],
    ["[ab].txt", []],
    ["{top,x}.md", []],
  ]) assert.deepEqual(await ws.list(pattern), expected, pattern);

  // And no text in a pattern is taken for an operator: what a pattern is made of is only what was written.
  for (const odd of ["\x00GLOBSTAR\x00", "\x00GLOBSTARSLASH\x00top.md"]) assert.deepEqual(await ws.list(odd), [], JSON.stringify(odd));
});

test("a link to a file is listed wherever it can be read — in a directory that is itself come to by a link, too", async (t) => {
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(wsDir));
  const ws = createWorkspace(wsDir);
  await ws.write("real/f.txt", "the file");
  symlinkSync("f.txt", join(wsDir, "real", "alias"));
  symlinkSync("real", join(wsDir, "by-link"));
  // (A link to a directory is not followed a second time: that is what would never end.)
  symlinkSync("..", join(wsDir, "real", "up"));

  const listed = await ws.list("**");
  assert.deepEqual(listed, ["by-link/alias", "by-link/f.txt", "real/alias", "real/f.txt", "real/up/real/alias", "real/up/real/f.txt"]);
  for (const path of listed) assert.equal(await ws.read(path), "the file", path);
});

test("a file that is written anew does not keep what let the old one run as somebody else", { skip: process.getuid?.() === 0 }, async (t) => {
  const { chmodSync, statSync } = await import("fs");
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(wsDir));
  const ws = createWorkspace(wsDir);
  await ws.write("tool.sh", "#!/bin/sh\n");
  chmodSync(join(wsDir, "tool.sh"), 0o6755);
  if ((statSync(join(wsDir, "tool.sh")).mode & 0o6000) === 0) return t.skip("this file system keeps no such bits");

  await ws.write("tool.sh", "#!/bin/sh\necho rewritten\n");
  // As when the system itself writes into such a file: what it allows stays, the rest goes.
  assert.equal((statSync(join(wsDir, "tool.sh")).mode & 0o7777).toString(8), "755");
});

test("a workspace named by a link to nothing is made where the link leads", async (t) => {
  const parent = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(parent));
  symlinkSync(join("made", "later"), join(parent, "by-link"));

  const ws = createWorkspace(join(parent, "by-link"));
  await ws.write("a.txt", "written");
  assert.equal(readFileSync(join(parent, "made", "later", "a.txt"), "utf-8"), "written");
  assert.deepEqual(await ws.list("*"), ["a.txt"]);
});

test("workspace.observe waits out what comes to be in the way of a path that could be read when it began", async (t) => {
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(wsDir));
  const ws = createWorkspace(wsDir);
  const pending = ws.observe("out/result.txt", { timeout: 10_000 });
  // While it waits: a file where the directory is to be — then the directory, and the file in it.
  setTimeout(() => writeFileSync(join(wsDir, "out"), "in the way"), 50);
  setTimeout(() => { rmSync(join(wsDir, "out")); mkdirSync(join(wsDir, "out")); writeFileSync(join(wsDir, "out", "result.txt"), "there now"); }, 700);
  assert.equal(await pending, "there now");
});

test("what is to take an artifact's place is closed to others while it is written, where the artifact is", { skip: process.platform === "win32" }, async (t) => {
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(wsDir));
  const workspace = createWorkspace(wsDir);
  writeFileSync(join(wsDir, "key.txt"), "old", { mode: 0o600 });

  // Somebody who looks, all the while, at what stands beside the artifact, and writes down what each such file allows.
  const seen = join(wsDir, "..", `seen-${process.pid}.txt`);
  t.after(() => rmSync(seen, { force: true }));
  const looks = `const fs = require("fs"); const [dir, seen] = process.argv.slice(1); const modes = new Set(); fs.writeFileSync(seen, "");
    const until = Date.now() + 20000;
    while (Date.now() < until && !fs.existsSync(dir + "/enough")) {
      for (const name of fs.readdirSync(dir)) if (name.startsWith(".trama-tmp-")) { try { modes.add((fs.statSync(dir + "/" + name).mode & 0o777).toString(8)); } catch {} }
    }
    fs.writeFileSync(seen, [...modes].join(" "));`;
  const looker = spawn(process.execPath, ["-e", looks, wsDir, seen], { stdio: "ignore" });
  const done = new Promise((resolve) => looker.once("exit", resolve));
  while (!existsSync(seen)) await new Promise((resolve) => setTimeout(resolve, 10));

  // Much to write: it stands there half-written for a while.
  for (let n = 0; n < 4; n += 1) await workspace.write("key.txt", "k".repeat(48 * 1024 * 1024));
  writeFileSync(join(wsDir, "enough"), "");
  await done;
  const modes = readFileSync(seen, "utf-8").split(" ").filter(Boolean);
  assert.ok(modes.length > 0, "it was seen while it was written");
  assert.deepEqual(modes, ["600"], "and never allowed more than the artifact it was to replace");
  assert.equal(statSync(join(wsDir, "key.txt")).mode & 0o777, 0o600);
});

test("a pattern that says \"any directories\" many times over is read as quickly as one that says it once", async (t) => {
  const wsDir = makeTempDir("trama-ws-");
  t.after(() => cleanupTempDir(wsDir));
  const workspace = createWorkspace(wsDir);
  const deep = Array.from({ length: 28 }, (_, at) => `d${at}`).join("/");
  await workspace.write(`${deep}/found.md`, "there");

  const started = performance.now();
  // (Each of them could be any number of the directories on the way: tried every way round, that is millions of ways to find nothing.)
  assert.deepEqual(await workspace.list(`${"**/".repeat(14)}nothing.md`), []);
  assert.deepEqual(await workspace.list(`${"**/".repeat(14)}found.md`), [`${deep}/found.md`]);
  assert.deepEqual(await workspace.list(`d0/**/d5/**/**/d20/**/*.md`), [`${deep}/found.md`]);
  assert.deepEqual(await workspace.list(`**/d5/**/d4/**/*.md`), [], "directories are found in the order they are in");
  assert.ok(performance.now() - started < 2000, `it took ${Math.round(performance.now() - started)}ms`);
});

test("a pattern matches what it matched when it was handed to the system's matcher of expressions: thousands of them, made up", async () => {
  const { compileGlob } = await import("../packages/runtime/dist/workspace.js");
  // As a pattern was read before: an expression, tried every way round. (For patterns short enough to be done with.)
  const before = (pattern) => {
    const literal = (text) => text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const within = (segment) => segment.split("?").map((part) => part.split("*").map(literal).join("[^/]*")).join("[^/]");
    return new RegExp(`^${pattern.split("**/").map((part) => part.split("**").map(within).join(".*")).join("(?:.+/)?")}$`);
  };
  // Made up the same way each time: what fails once fails again.
  let seed = 20261120;
  const next = (below) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % below; };
  const made = (from, longest) => Array.from({ length: next(longest + 1) }, () => from[next(from.length)]).join("");
  const differing = [];
  let matched = 0;
  for (let n = 0; n < 12000; n += 1) {
    // (Half of them of few letters, so that a pattern and a path are often nearly each other.)
    const few = n % 2 === 0;
    const pattern = made(few ? ["a", "/", "*", "**/", "**/", "**", "?"] : ["a", "b", "/", "*", "*", "**/", "**", "?", ".", "("], few ? 5 : 7);
    const was = before(pattern), is = compileGlob(pattern);
    for (let m = 0; m < 12; m += 1) {
      const path = made(few ? ["a", "a", "/"] : ["a", "b", "/", ".", "(", "é"], few ? 6 : 9);
      if (was.test(path)) matched += 1;
      if (was.test(path) !== is.test(path)) differing.push([pattern, path, was.test(path)]);
    }
  }
  assert.deepEqual(differing.slice(0, 5), []);
  assert.ok(matched > 10000, `enough of them matched for that to mean something: ${matched}`);
  // "Whole segments" are none, or what ends in a slash and has something before it: a slash alone is neither.
  for (const [pattern, path, matches] of [["a**/b", "a/b", false], ["a**/b", "ab", true], ["a**/b", "a/x/b", true], ["**/b", "/b", false], ["**/b", "x/b", true], ["a/**/b", "a/b", true], ["a/**/b", "a//b", false]]) {
    assert.equal(compileGlob(pattern).test(path), matches, `${pattern} against ${path}`);
    assert.equal(before(pattern).test(path), matches, `${pattern} against ${path}, as it was`);
  }
});
