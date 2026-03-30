import assert from "node:assert/strict";
import test from "node:test";
import { symlinkSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { guardPath } from "../packages/runtime/dist/path-guard.js";
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
