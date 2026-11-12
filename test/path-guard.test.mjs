import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, lstatSync, readFileSync, realpathSync, symlinkSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { guardPath, guardWriteTarget } from "../packages/runtime/dist/path-guard.js";
import { createTools } from "../packages/runtime/dist/tools.js";
import { createWorkspace } from "../packages/runtime/dist/workspace.js";
import { loadState, ensureProjectScaffold } from "../packages/runtime/dist/runner.js";
import { createContext } from "../packages/runtime/dist/context.js";
import { makeTempDir, cleanupTempDir, writeJson, writeText, createProjectFixture } from "./helpers.mjs";

// --- guardPath unit tests ---

test("guardPath rejects symlink pointing outside the project", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  const outsideDir = makeTempDir("trama-outside-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(outsideDir); });

  writeFileSync(join(outsideDir, "secret.txt"), "sensitive data");
  symlinkSync(join(outsideDir, "secret.txt"), join(projectDir, "state.json"));

  assert.throws(
    () => guardPath(projectDir, "state.json"),
    /Path escapes project directory via symlink/,
  );
});

test("guardPath rejects directory symlink pointing outside the project", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  const outsideDir = makeTempDir("trama-outside-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(outsideDir); });

  symlinkSync(outsideDir, join(projectDir, "logs"));

  assert.throws(
    () => guardPath(projectDir, join("logs", "latest.jsonl")),
    /Path escapes project directory via symlink/,
  );
});

test("guardPath allows normal paths inside the project", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  t.after(() => cleanupTempDir(projectDir));

  mkdirSync(join(projectDir, "logs"), { recursive: true });
  writeFileSync(join(projectDir, "state.json"), "{}");

  // Should not throw
  const resolved = guardPath(projectDir, "state.json");
  assert.ok(resolved.endsWith("state.json"));

  const logsPath = guardPath(projectDir, join("logs", "latest.jsonl"));
  assert.ok(logsPath.endsWith("latest.jsonl"));
});

test("guardPath rejects .. traversal", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  t.after(() => cleanupTempDir(projectDir));

  assert.throws(
    () => guardPath(projectDir, "../etc/passwd"),
    /Path escapes project directory/,
  );
});

test("guardPath allows symlinks that stay inside the project", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  t.after(() => cleanupTempDir(projectDir));

  mkdirSync(join(projectDir, "data"), { recursive: true });
  writeFileSync(join(projectDir, "data", "real.json"), "{}");
  symlinkSync(join(projectDir, "data", "real.json"), join(projectDir, "state.json"));

  // Should not throw — symlink target is inside the project
  const resolved = guardPath(projectDir, "state.json");
  assert.ok(resolved.endsWith("state.json"));
});

// --- Integration tests: runner-level ops reject symlinks ---

test("loadState rejects symlinked state.json pointing outside project", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  const outsideDir = makeTempDir("trama-outside-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(outsideDir); });

  writeFileSync(join(outsideDir, "stolen.json"), '{"secret":"data"}');
  symlinkSync(join(outsideDir, "stolen.json"), join(projectDir, "state.json"));

  assert.throws(
    () => loadState(projectDir),
    /Path escapes project directory via symlink/,
  );
});

test("ensureProjectScaffold rejects symlinked package.json pointing outside project", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  const outsideDir = makeTempDir("trama-outside-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(outsideDir); });

  writeFileSync(join(outsideDir, "target.json"), '{"name":"victim"}');
  symlinkSync(join(outsideDir, "target.json"), join(projectDir, "package.json"));

  assert.throws(
    () => ensureProjectScaffold(projectDir),
    /Path escapes project directory via symlink/,
  );
});

test("ensureProjectScaffold rejects symlinked .gitignore pointing outside project", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  const outsideDir = makeTempDir("trama-outside-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(outsideDir); });

  writeFileSync(join(outsideDir, "target"), "original content");
  symlinkSync(join(outsideDir, "target"), join(projectDir, ".gitignore"));

  assert.throws(
    () => ensureProjectScaffold(projectDir),
    /Path escapes project directory via symlink/,
  );
});

test("createContext rejects symlinked meta.json pointing outside project", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  const outsideDir = makeTempDir("trama-outside-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(outsideDir); });

  mkdirSync(join(projectDir, "logs"), { recursive: true });
  writeFileSync(join(projectDir, "logs", "latest.jsonl"), "");
  writeJson(join(outsideDir, "meta.json"), {
    input: { prompt: "test", args: {} },
    createdAt: "2026-01-01T00:00:00.000Z",
    piVersion: "0.63.1",
  });
  symlinkSync(join(outsideDir, "meta.json"), join(projectDir, "meta.json"));

  assert.throws(
    () => createContext(projectDir, {}),
    /Path escapes project directory via symlink/,
  );
});

test("createContext rejects symlinked logs directory pointing outside project", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  const outsideDir = makeTempDir("trama-outside-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(outsideDir); });

  writeJson(join(projectDir, "meta.json"), {
    input: { prompt: "test", args: {} },
    createdAt: "2026-01-01T00:00:00.000Z",
    piVersion: "0.63.1",
  });
  mkdirSync(join(outsideDir, "logs"), { recursive: true });
  symlinkSync(join(outsideDir, "logs"), join(projectDir, "logs"));

  assert.throws(
    () => createContext(projectDir, {}),
    /Path escapes project directory via symlink/,
  );
});

// --- Dangling symlink tests ---

test("guardPath rejects dangling symlink pointing outside the project", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  t.after(() => cleanupTempDir(projectDir));

  // Symlink to a non-existent file outside the project
  symlinkSync("/tmp/nonexistent-trama-target-12345", join(projectDir, "state.json"));

  assert.throws(
    () => guardPath(projectDir, "state.json"),
    /Path escapes project directory via symlink/,
  );
});

test("guardPath rejects dangling symlink in logs dir pointing outside project", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  t.after(() => cleanupTempDir(projectDir));

  mkdirSync(join(projectDir, "logs"), { recursive: true });
  symlinkSync("/tmp/nonexistent-trama-target-12345", join(projectDir, "logs", "latest.jsonl"));

  assert.throws(
    () => guardPath(projectDir, join("logs", "latest.jsonl")),
    /Path escapes project directory via symlink/,
  );
});

test("loadState rejects dangling symlinked state.json pointing outside project", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  t.after(() => cleanupTempDir(projectDir));

  // Dangling symlink — target doesn't exist
  symlinkSync("/tmp/nonexistent-trama-target-12345", join(projectDir, "state.json"));

  assert.throws(
    () => loadState(projectDir),
    /Path escapes project directory via symlink/,
  );
});

test("guardPath allows dangling symlinks that stay inside the project", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  t.after(() => cleanupTempDir(projectDir));

  // Dangling symlink to a non-existent file INSIDE the project
  symlinkSync(join(projectDir, "not-yet-created.json"), join(projectDir, "state.json"));

  // Should not throw — target is inside project even though it doesn't exist
  const resolved = guardPath(projectDir, "state.json");
  assert.ok(resolved.endsWith("state.json"));
});

// --- chains of links ---

test("a link to a link that points outside is refused, though neither destination exists", async (t) => {
  const projectDir = makeTempDir("trama-guard-");
  const outside = makeTempDir("trama-guard-outside-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(outside); });
  symlinkSync(join(outside, "escaped.txt"), join(projectDir, "second")); // dangling, and outside
  symlinkSync(join(projectDir, "second"), join(projectDir, "first"));   // points at the dangling link

  assert.throws(() => guardPath(projectDir, "first"), /Path escapes project directory via symlink/);
  assert.throws(() => guardWriteTarget(projectDir, "first"), /Path escapes project directory via symlink/);
  // What a write would have done: follow both links and create the file outside.
  await assert.rejects(createTools(projectDir).write("first", "x"), /Path escapes project directory via symlink/);
  await assert.rejects(createWorkspace(projectDir).write("first", "x"), /Path escapes project directory via symlink/);
  assert.equal(existsSync(join(outside, "escaped.txt")), false);
});

test("a path below a directory link that points outside and at nothing is refused", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  const outside = makeTempDir("trama-guard-outside-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(outside); });
  // mkdir -p through this link would create the directory outside.
  symlinkSync(join(outside, "not-there-yet"), join(projectDir, "dir"));

  assert.throws(() => guardPath(projectDir, join("dir", "sub", "file.txt")), /Path escapes project directory via symlink/);
});

test("a chain of links that stays inside is followed to its end, and a write replaces what is there", async (t) => {
  const workspaceDir = makeTempDir("trama-guard-");
  t.after(() => cleanupTempDir(workspaceDir));
  symlinkSync(join(workspaceDir, "deep", "target.txt"), join(workspaceDir, "second")); // nothing there yet
  symlinkSync("second", join(workspaceDir, "first"));                                   // a relative link

  assert.equal(guardPath(workspaceDir, "first"), join(workspaceDir, "first"));
  assert.equal(guardWriteTarget(workspaceDir, "first"), join(realpathSync(workspaceDir), "deep", "target.txt"));

  await createWorkspace(workspaceDir).write("first", "through both");
  assert.equal(readFileSync(join(workspaceDir, "deep", "target.txt"), "utf-8"), "through both");
  // Neither link was replaced by the file.
  assert.equal(lstatSync(join(workspaceDir, "first")).isSymbolicLink(), true);
  assert.equal(lstatSync(join(workspaceDir, "second")).isSymbolicLink(), true);
});

test("links that lead back to themselves are refused rather than followed for ever", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  t.after(() => cleanupTempDir(projectDir));
  symlinkSync("b", join(projectDir, "a"));
  symlinkSync("a", join(projectDir, "b"));

  assert.throws(() => guardPath(projectDir, "a"), /Too many levels of symbolic links/);
});

test("a root that does not exist yet is guarded like one that does", (t) => {
  // The temp directory is itself reached through a link on some systems (/var on macOS).
  const parent = makeTempDir("trama-guard-");
  t.after(() => cleanupTempDir(parent));
  const root = join(parent, "not", "made", "yet");

  assert.equal(guardPath(root, "file.txt"), join(root, "file.txt"));
  assert.throws(() => guardPath(root, "../../../../etc/passwd"), /Path escapes project directory/);
});

test('".." in what a link says is taken from where the links before it lead', async (t) => {
  const parent = makeTempDir("trama-guard-");
  t.after(() => cleanupTempDir(parent));
  const root = join(parent, "root");
  mkdirSync(root);
  writeFileSync(join(parent, "secret.txt"), "outside");
  // Every link here points inside the root as text. The system reads "here/.." as the root's parent.
  symlinkSync(".", join(root, "here"));
  symlinkSync("here/../secret.txt", join(root, "a"));
  symlinkSync("here/..", join(root, "p"));
  assert.equal(readFileSync(join(root, "a"), "utf-8"), "outside", "the layout is what it is meant to be");

  assert.throws(() => guardPath(root, "a"), /Path escapes project directory via symlink/);
  assert.throws(() => guardPath(root, join("p", "secret.txt")), /Path escapes project directory via symlink/);
  await assert.rejects(createTools(root).read("a"), /Path escapes project directory via symlink/);
  await assert.rejects(createWorkspace(root).read(join("p", "secret.txt")), /Path escapes project directory via symlink/);
  // Nor is what is out there listed, or waited for.
  assert.deepEqual(await createWorkspace(root).list("**"), []);
  const ran = await createTools(root).shell("pwd", { cwd: "p" }).catch(err => err);
  assert.match(String(ran.message), /Path escapes project directory via symlink/);
});

test('".." that stays inside is followed, and one that leads up from nothing is refused', (t) => {
  const root = makeTempDir("trama-guard-");
  t.after(() => cleanupTempDir(root));
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "file.txt"), "inside");
  symlinkSync("sub/../file.txt", join(root, "back"));
  symlinkSync("not-there/../file.txt", join(root, "through-nothing"));

  assert.equal(guardWriteTarget(root, "back"), join(realpathSync(root), "file.txt"));
  // The system could not follow this either: there is no directory to go up from.
  assert.throws(() => guardPath(root, "through-nothing"), /leads up from what does not exist/);
});
