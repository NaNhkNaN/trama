import assert from "node:assert/strict";
import test from "node:test";
import { join } from "path";
import { createContext } from "../packages/runtime/dist/context.js";
import { cleanupTempDir, createProjectFixture, makeTempDir, readJson, readText } from "./helpers.mjs";

test("createContext checkpoint persists state and increments iteration", async (t) => {
  const projectDir = makeTempDir("trama-context-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  const ctx = createContext(projectDir, { counter: 1 }, { maxIterations: 7 });
  ctx.state.extra = { nested: true };

  await ctx.checkpoint();

  assert.equal(ctx.iteration, 1);
  assert.equal(ctx.maxIterations, 7);
  assert.deepEqual(readJson(join(projectDir, "state.json")), {
    counter: 1,
    extra: { nested: true },
    __trama_iteration: 1,
  });
});

test("createContext done logs once and is idempotent", async (t) => {
  const projectDir = makeTempDir("trama-context-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  const ctx = createContext(projectDir, {});

  await ctx.done({ result: "ok" });
  await ctx.done({ result: "ignored" });

  const lines = readJsonLines(join(projectDir, "logs", "latest.jsonl"));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].message, "done");
  assert.deepEqual(lines[0].data, { result: "ok" });
  assert.equal(readJson(join(projectDir, "state.json")).__trama_iteration, 1);
});

test("createContext done logs completion even when no result is provided", async (t) => {
  const projectDir = makeTempDir("trama-context-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  const ctx = createContext(projectDir, {});
  await ctx.done();

  const lines = readJsonLines(join(projectDir, "logs", "latest.jsonl"));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].message, "done");
  assert.equal(lines[0].data, null);
  assert.equal(readJson(join(projectDir, "state.json")).__trama_iteration, 1);
});

test("createContext checkpoint rejects non-serializable state with a useful path", async (t) => {
  const projectDir = makeTempDir("trama-context-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  const ctx = createContext(projectDir, {});
  ctx.state.bad = { nested: [() => "nope"] };

  await assert.rejects(
    async () => ctx.checkpoint(),
    /ctx\.state\.bad\.nested\[0\] is not JSON-serializable \(function\)/,
  );
});

test("createContext allows shared object references that are not circular", async (t) => {
  const projectDir = makeTempDir("trama-context-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  const shared = { value: 42 };
  const ctx = createContext(projectDir, { left: shared, right: shared });

  await ctx.checkpoint();

  assert.deepEqual(readJson(join(projectDir, "state.json")), {
    left: { value: 42 },
    right: { value: 42 },
    __trama_iteration: 1,
  });
});

test("createContext checkpoint rejects circular references", async (t) => {
  const projectDir = makeTempDir("trama-context-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  const ctx = createContext(projectDir, {});
  const a = {};
  a.self = a;
  ctx.state.loop = a;

  await assert.rejects(
    async () => ctx.checkpoint(),
    /circular reference/,
  );
});

test("createContext checkpoint rejects Date, Map, and Set instances", async (t) => {
  const projectDir = makeTempDir("trama-context-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  for (const [label, value] of [["Date", new Date()], ["Map", new Map()], ["Set", new Set()]]) {
    const ctx = createContext(projectDir, {});
    ctx.state.bad = value;
    await assert.rejects(
      async () => ctx.checkpoint(),
      /not a plain object/,
      `should reject ${label}`,
    );
  }
});

test("createContext checkpoint rejects NaN and Infinity", async (t) => {
  const projectDir = makeTempDir("trama-context-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  for (const value of [NaN, Infinity, -Infinity]) {
    const ctx = createContext(projectDir, {});
    ctx.state.num = value;
    await assert.rejects(
      async () => ctx.checkpoint(),
      /not JSON-serializable/,
    );
  }
});

test("createContext ignores polluted __trama_iteration (non-number)", async (t) => {
  const projectDir = makeTempDir("trama-context-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  for (const bad of ["oops", null, true, undefined]) {
    const ctx = createContext(projectDir, { __trama_iteration: bad });
    assert.equal(ctx.iteration, 0, `should reset to 0 for ${JSON.stringify(bad)}`);
  }
});

test("createContext resumes iteration from persisted __trama_iteration", async (t) => {
  const projectDir = makeTempDir("trama-context-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  const ctx = createContext(projectDir, { __trama_iteration: 5, data: "kept" });
  assert.equal(ctx.iteration, 5);

  await ctx.checkpoint();
  assert.equal(ctx.iteration, 6);

  const saved = readJson(join(projectDir, "state.json"));
  assert.equal(saved.__trama_iteration, 6);
  assert.equal(saved.data, "kept");
});

test("createContext extracts input from meta.json", async (t) => {
  const projectDir = makeTempDir("trama-context-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { metaInput: { prompt: "custom prompt", args: { file: "a.txt" } } });

  const ctx = createContext(projectDir, {});
  assert.equal(ctx.input.prompt, "custom prompt");
  assert.equal(ctx.input.args.file, "a.txt");
});

test("createContext done retries log and checkpoint after checkpoint failure", async (t) => {
  const projectDir = makeTempDir("trama-context-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  const ctx = createContext(projectDir, {});
  ctx.state.bad = () => "nope"; // non-serializable

  // First done() should throw because checkpoint fails on non-serializable state
  await assert.rejects(
    async () => ctx.done({ result: "ok" }),
    /not JSON-serializable/,
  );

  // Fix state and retry — done() should succeed and re-log
  ctx.state = { fixed: true };
  await ctx.done({ result: "ok" });

  const lines = readJsonLines(join(projectDir, "logs", "latest.jsonl"));
  // "done" should appear twice (once from the failed attempt, once from the retry)
  const doneLines = lines.filter(l => l.message === "done");
  assert.equal(doneLines.length, 2, "done log should be emitted on both attempts");
  assert.equal(readJson(join(projectDir, "state.json")).fixed, true);
});

function readJsonLines(path) {
  const content = readText(path).trim();
  if (!content) return [];
  return content.split("\n").map(line => JSON.parse(line));
}
