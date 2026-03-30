import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "fs";
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

test("createContext ready logs once, triggers onReady once, and does not checkpoint", async (t) => {
  const projectDir = makeTempDir("trama-context-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  const readyEvents = [];
  const ctx = createContext(projectDir, { booted: false }, {
    onReady(data) {
      readyEvents.push(data);
    },
  });

  await ctx.ready({ url: "http://127.0.0.1:3000" });
  await ctx.ready({ url: "ignored" });

  const lines = readJsonLines(join(projectDir, "logs", "latest.jsonl"));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].message, "ready");
  assert.deepEqual(lines[0].data, { url: "http://127.0.0.1:3000" });
  assert.deepEqual(readyEvents, [{ url: "http://127.0.0.1:3000" }]);
  assert.equal(ctx.iteration, 0);
  assert.equal(existsSync(join(projectDir, "state.json")), false);
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

test("createContext argsOverride merges with meta.json args", async (t) => {
  const projectDir = makeTempDir("trama-context-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { metaInput: { prompt: "prompt", args: { existing: "kept", overridden: "old" } } });

  const ctx = createContext(projectDir, {}, { argsOverride: { overridden: "new", added: "extra" } });
  assert.equal(ctx.input.args.existing, "kept");
  assert.equal(ctx.input.args.overridden, "new");
  assert.equal(ctx.input.args.added, "extra");
});

test("createContext resets negative and fractional __trama_iteration to zero", async (t) => {
  const projectDir = makeTempDir("trama-context-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  for (const bad of [-1, -3.5, 0.5]) {
    const ctx = createContext(projectDir, { __trama_iteration: bad });
    assert.equal(ctx.iteration, 0, `should reset to 0 for ${bad}`);
  }

  // Positive integers should still be accepted
  const ctx = createContext(projectDir, { __trama_iteration: 3 });
  assert.equal(ctx.iteration, 3);
});

test("createContext done coalesces concurrent unawaited calls", async (t) => {
  const projectDir = makeTempDir("trama-context-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  const ctx = createContext(projectDir, {});

  // Fire two done() calls without awaiting the first — both should resolve
  // to the same operation (one log entry, one checkpoint).
  const a = ctx.done({ result: "first" });
  const b = ctx.done({ result: "second" });
  await Promise.all([a, b]);

  const lines = readJsonLines(join(projectDir, "logs", "latest.jsonl"));
  const doneLines = lines.filter(l => l.message === "done");
  assert.equal(doneLines.length, 1, "done should be logged exactly once");
  assert.deepEqual(doneLines[0].data, { result: "first" }, "first call's result wins");
  assert.equal(readJson(join(projectDir, "state.json")).__trama_iteration, 1);
});

test("createContext done coalesces concurrent failures and still allows retry", async (t) => {
  const projectDir = makeTempDir("trama-context-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  const ctx = createContext(projectDir, {});
  ctx.state.bad = () => "nope";

  const a = ctx.done({ result: "first" }).catch(err => err.message);
  const b = ctx.done({ result: "second" }).catch(err => err.message);
  const [firstError, secondError] = await Promise.all([a, b]);

  assert.match(firstError, /not JSON-serializable/);
  assert.equal(secondError, firstError, "concurrent callers should observe the same failure");

  let doneLines = readJsonLines(join(projectDir, "logs", "latest.jsonl"))
    .filter(line => line.message === "done");
  assert.equal(doneLines.length, 1, "failed concurrent done() calls should log only once");
  assert.deepEqual(doneLines[0].data, { result: "first" }, "first failed call's result wins");

  ctx.state = { fixed: true };
  await ctx.done({ result: "retry" });

  doneLines = readJsonLines(join(projectDir, "logs", "latest.jsonl"))
    .filter(line => line.message === "done");
  assert.equal(doneLines.length, 2, "retry should emit a fresh done log after failure");
  assert.deepEqual(doneLines[1].data, { result: "retry" });
  assert.equal(readJson(join(projectDir, "state.json")).__trama_iteration, 1);
  assert.equal(readJson(join(projectDir, "state.json")).fixed, true);
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

test("createContext log does not throw on non-serializable data", async (t) => {
  const projectDir = makeTempDir("trama-context-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  const ctx = createContext(projectDir, {});
  const circular = {};
  circular.self = circular;

  // Should not throw — log should be a safe API
  await ctx.log("test", circular);

  const lines = readJsonLines(join(projectDir, "logs", "latest.jsonl"));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].message, "test");
  assert.ok(lines[0].data.__trama_unserializable);
});

test("createContext checkpoint accepts null-prototype objects", async (t) => {
  const projectDir = makeTempDir("trama-context-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  const ctx = createContext(projectDir, {});
  const nullProto = Object.create(null);
  nullProto.key = "value";
  ctx.state.data = nullProto;

  await ctx.checkpoint();

  assert.deepEqual(readJson(join(projectDir, "state.json")).data, { key: "value" });
});

function readJsonLines(path) {
  const content = readText(path).trim();
  if (!content) return [];
  return content.split("\n").map(line => JSON.parse(line));
}
