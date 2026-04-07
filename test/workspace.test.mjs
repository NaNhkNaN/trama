import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from "fs";
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
