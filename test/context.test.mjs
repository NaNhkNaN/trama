import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { createContext } from "../packages/runtime/dist/context.js";
import { toLogData } from "../packages/runtime/dist/serializable.js";
import { cleanupTempDir, createProjectFixture, makeTempDir, readJson, readText } from "./helpers.mjs";

test("createContext checkpoint persists state and increments iteration", async (t) => {
  const projectDir = makeTempDir("trama-context-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  const ctx = createContext(projectDir, { counter: 1 }, { maxIterations: 7 });

  assert.equal(ctx.checkpoint({ counter: 1, extra: { nested: true } }), 1);

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

  assert.equal(ctx.ended, null);
  assert.equal(ctx.done({ kept: true }, { result: "ok" }), 1);
  // Said again, it does nothing: not to the state, the log, or how the run ended.
  assert.equal(ctx.done({ kept: false }, { result: "ignored" }), 1);

  const lines = readJsonLines(join(projectDir, "logs", "latest.jsonl"));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].message, "done");
  assert.deepEqual(lines[0].data, { result: "ok" });
  assert.deepEqual(readJson(join(projectDir, "state.json")), { kept: true, __trama_iteration: 1 });
  assert.deepEqual(ctx.ended, { status: "done", result: { result: "ok" } });
});

test("createContext done logs completion even when no result is provided", async (t) => {
  const projectDir = makeTempDir("trama-context-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  const ctx = createContext(projectDir, {});
  ctx.done({});

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

  ctx.ready({ url: "http://127.0.0.1:3000" });
  ctx.ready({ url: "ignored" });

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

  assert.throws(
    () => ctx.checkpoint({ bad: { nested: [() => "nope"] } }),
    /ctx\.state\.bad\.nested\[0\] is not JSON-serializable \(function\)/,
  );
});

test("createContext allows shared object references that are not circular", async (t) => {
  const projectDir = makeTempDir("trama-context-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  const shared = { value: 42 };
  const ctx = createContext(projectDir, {});

  ctx.checkpoint({ left: shared, right: shared });

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

  assert.throws(() => ctx.checkpoint({ loop: a }), /circular reference/);
});

test("createContext checkpoint rejects Date, Map, and Set instances", async (t) => {
  const projectDir = makeTempDir("trama-context-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  for (const [label, value] of [["Date", new Date()], ["Map", new Map()], ["Set", new Set()]]) {
    const ctx = createContext(projectDir, {});
    assert.throws(() => ctx.checkpoint({ bad: value }), /not a plain object/, `should reject ${label}`);
  }
});

test("createContext checkpoint rejects NaN and Infinity", async (t) => {
  const projectDir = makeTempDir("trama-context-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  for (const value of [NaN, Infinity, -Infinity]) {
    const ctx = createContext(projectDir, {});
    assert.throws(() => ctx.checkpoint({ num: value }), /not JSON-serializable/);
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

  ctx.checkpoint({ __trama_iteration: 5, data: "kept" });
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

test("createContext done retries after checkpoint failure", async (t) => {
  const projectDir = makeTempDir("trama-context-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  const ctx = createContext(projectDir, {});

  // First done() should throw because the state cannot be persisted
  assert.throws(() => ctx.done({ bad: () => "nope" }, { result: "ok" }), /not JSON-serializable/);
  assert.equal(ctx.ended, null);

  // With a state that can be, done() succeeds
  ctx.done({ fixed: true }, { result: "ok" });

  const lines = readJsonLines(join(projectDir, "logs", "latest.jsonl"));
  // Persistence happens before logging — first attempt fails at checkpoint,
  // so only the successful retry produces a log entry.
  const doneLines = lines.filter(l => l.message === "done");
  assert.equal(doneLines.length, 1, "done log should be emitted on successful retry");
  assert.equal(readJson(join(projectDir, "state.json")).fixed, true);
});

test("log data is what JSON makes of it, and a log call does not fail over what it was handed", () => {
  // The program's side does this before the data is sent; the runner writes down what arrives.
  const circular = {};
  circular.self = circular;
  assert.ok(toLogData(circular).__trama_unserializable);
  assert.ok(toLogData(10n).__trama_unserializable);
  // One that cannot even be turned into text.
  const bare = Object.create(null);
  bare.self = bare;
  assert.ok(toLogData(bare).__trama_unserializable);
  assert.deepEqual(toLogData({ n: NaN, when: new Date(0), gone: undefined }), { n: null, when: "1970-01-01T00:00:00.000Z" });
  assert.equal(toLogData(undefined), undefined);
});

test("createContext checkpoint accepts null-prototype objects", async (t) => {
  const projectDir = makeTempDir("trama-context-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  const ctx = createContext(projectDir, {});
  const nullProto = Object.create(null);
  nullProto.key = "value";

  ctx.checkpoint({ data: nullProto });

  assert.deepEqual(readJson(join(projectDir, "state.json")).data, { key: "value" });
});

function readJsonLines(path) {
  const content = readText(path).trim();
  if (!content) return [];
  return content.split("\n").map(line => JSON.parse(line));
}

test("createContext: a state that could not be written settles nothing", (t) => {
  const projectDir = makeTempDir("trama-ctx-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);
  const ctx = createContext(projectDir, { __trama_yield: { reason: "earlier" }, n: 1 }, { print() {} });
  const state = { __trama_yield: { reason: "earlier" }, n: 1 };

  // A directory where the state file goes: writing it fails.
  mkdirSync(join(projectDir, "state.json"));
  assert.throws(() => ctx.checkpoint(state));
  assert.throws(() => ctx.done(state, "result"));
  assert.equal(ctx.iteration, 0);
  // The run can still end either way.
  assert.equal(ctx.ended, null);

  rmSync(join(projectDir, "state.json"), { recursive: true });
  ctx.yield(state, "later");
  assert.deepEqual(readJson(join(projectDir, "state.json")), { __trama_yield: { reason: "later" }, n: 1, __trama_iteration: 1 });
  assert.deepEqual(ctx.ended, { status: "yielded", reason: "later" });
});

test("createContext: once a run has ended its state is settled — nothing more is written, whichever call asks", (t) => {
  for (const end of ["done", "yield"]) {
    const projectDir = makeTempDir("trama-ctx-");
    t.after(() => cleanupTempDir(projectDir));
    createProjectFixture(projectDir);
    const ctx = createContext(projectDir, {}, { print() {} });

    if (end === "done") ctx.done({ n: 1 }, "result");
    else ctx.yield({ n: 1 }, "waiting for review");
    const settled = readJson(join(projectDir, "state.json"));
    const other = end === "done" ? "yield" : "done";

    // A checkpoint taken now would take back what the run ended on — after a yield, the very
    // mark the next run resumes from.
    assert.throws(() => ctx.checkpoint({ n: 2 }), new RegExp(`Cannot call ctx\\.checkpoint\\(\\) after ctx\\.${end}\\(\\)`));
    assert.throws(() => ctx[other]({ n: 3 }, "too late"), new RegExp(`Cannot call ctx\\.${other}\\(\\) after ctx\\.${end}\\(\\)`));
    // The same ending said again is not an error, and does nothing.
    ctx[end]({ n: 4 }, "again");

    assert.deepEqual(readJson(join(projectDir, "state.json")), settled);
    assert.equal(ctx.iteration, 1);
    assert.equal(readText(join(projectDir, "logs", "latest.jsonl")).trim().split("\n").length, 1);
  }
});
