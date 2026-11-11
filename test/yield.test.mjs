import assert from "node:assert/strict";
import test from "node:test";
import { join } from "path";
import { createContext } from "../packages/runtime/dist/context.js";
import { cleanupTempDir, createProjectFixture, makeTempDir, readJson, readText } from "./helpers.mjs";

function readJsonLines(path) {
  const content = readText(path).trim();
  if (!content) return [];
  return content.split("\n").map(line => JSON.parse(line));
}

// --- ctx.resumed and ctx.yieldReason ---

test("createContext sets resumed=false and yieldReason=null for fresh state", async (t) => {
  const projectDir = makeTempDir("trama-yield-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  const ctx = createContext(projectDir, {});
  assert.equal(ctx.resumed, false);
  assert.equal(ctx.yieldReason, null);
});

test("createContext sets resumed=true and yieldReason from yield marker", async (t) => {
  const projectDir = makeTempDir("trama-yield-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  const state = {
    __trama_iteration: 3,
    __trama_yield: { reason: "waiting for approval" },
    userKey: "preserved",
  };
  const ctx = createContext(projectDir, state);

  assert.equal(ctx.resumed, true);
  assert.equal(ctx.yieldReason, "waiting for approval");
  assert.equal(ctx.iteration, 3);
  assert.equal(ctx.state.userKey, "preserved");
});

// --- ctx.yield() ---

test("createContext yield persists state with yield marker", async (t) => {
  const projectDir = makeTempDir("trama-yield-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  const ctx = createContext(projectDir, {});
  ctx.state.pendingWork = "analysis";

  // yield() calls process.exit(0) in client mode, but in server-side
  // context it just persists and returns (for IPC handler to use).
  await ctx.yield("waiting for counterparty");

  const saved = readJson(join(projectDir, "state.json"));
  assert.deepEqual(saved.__trama_yield, { reason: "waiting for counterparty" });
  assert.equal(saved.pendingWork, "analysis");
  assert.equal(saved.__trama_iteration, 1);
});

test("createContext yield logs the yield event", async (t) => {
  const projectDir = makeTempDir("trama-yield-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  const ctx = createContext(projectDir, {});
  await ctx.yield("need input");

  const lines = readJsonLines(join(projectDir, "logs", "latest.jsonl"));
  const yieldLines = lines.filter(l => l.message === "yield");
  assert.equal(yieldLines.length, 1);
  assert.deepEqual(yieldLines[0].data, { reason: "need input" });
});

test("createContext yield rejects non-serializable state", async (t) => {
  const projectDir = makeTempDir("trama-yield-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  const ctx = createContext(projectDir, {});
  ctx.state.bad = () => "fn";

  await assert.rejects(
    () => ctx.yield("reason"),
    /not JSON-serializable/,
  );
});

// --- Mutual exclusivity ---

test("createContext done then yield throws", async (t) => {
  const projectDir = makeTempDir("trama-yield-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  const ctx = createContext(projectDir, {});
  await ctx.done({ result: "ok" });

  await assert.rejects(
    () => ctx.yield("too late"),
    /Cannot call ctx\.yield\(\) after ctx\.done\(\)/,
  );
});

test("createContext yield then done throws", async (t) => {
  const projectDir = makeTempDir("trama-yield-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  const ctx = createContext(projectDir, {});
  await ctx.yield("waiting");

  await assert.rejects(
    () => ctx.done({ result: "too late" }),
    /Cannot call ctx\.done\(\) after ctx\.yield\(\)/,
  );
});

// --- Yield marker lifecycle ---

test("createContext checkpoint clears yield marker", async (t) => {
  const projectDir = makeTempDir("trama-yield-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  // Start with a yield marker (as if resumed from a previous yield)
  const state = {
    __trama_iteration: 1,
    __trama_yield: { reason: "old reason" },
    data: "kept",
  };
  const ctx = createContext(projectDir, state);

  assert.equal(ctx.resumed, true);

  // Checkpoint should clear the yield marker
  await ctx.checkpoint();

  const saved = readJson(join(projectDir, "state.json"));
  assert.equal(saved.__trama_yield, undefined);
  assert.equal(saved.data, "kept");
  assert.equal(saved.__trama_iteration, 2);
});

test("createContext done clears yield marker and writes no marker of its own", async (t) => {
  const projectDir = makeTempDir("trama-yield-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  // Start with a yield marker
  const state = {
    __trama_iteration: 1,
    __trama_yield: { reason: "old" },
  };
  const ctx = createContext(projectDir, state);

  await ctx.done({ result: "finished" });

  const saved = readJson(join(projectDir, "state.json"));
  assert.equal(saved.__trama_yield, undefined);
  // Completion is reported to the runner in memory — state.json carries only
  // the program's state and the iteration counter.
  assert.deepEqual(Object.keys(saved), ["__trama_iteration"]);
});

test("createContext a failed done settles nothing — yield is still available", async (t) => {
  const projectDir = makeTempDir("trama-yield-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);

  const ctx = createContext(projectDir, {});
  ctx.state.bad = new Date();
  await assert.rejects(async () => ctx.done(), /not a plain object/);

  // Nothing was persisted, so the program may still choose to suspend instead.
  delete ctx.state.bad;
  await ctx.yield("changed my mind");

  const saved = readJson(join(projectDir, "state.json"));
  assert.deepEqual(saved.__trama_yield, { reason: "changed my mind" });
  // ...and having yielded, done is now the one that is refused.
  await assert.rejects(async () => ctx.done(), /Cannot call ctx\.done\(\) after ctx\.yield\(\)/);
});
