import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { llm } from "./fake-llm.mjs";
import { runProgram } from "../packages/runtime/dist/runner.js";
import { loadConfig } from "../packages/runtime/dist/project.js";
import { printJournals } from "../packages/runtime/dist/journal-view.js";
import { captureConsole, cleanupTempDir, createProjectFixture, isAlive, makeTempDir, waitFor, withEnv, writeJson } from "./helpers.mjs";

// A fix asked of a project, and not of pi's agent: where a run — or the configuration — names one (`repairWith`),
// the program that fixes is a program like any, run with the copy of the failing project as its workspace. What
// the runner does round a fix is as it was: the copy, the trial, what is kept. (Importing the stand-in for the
// model means a test here fails where pi's agent is asked for a fix, or for anything, that it did not provide.)

/** A program that fails for a slip in it — and, fixed, says how many words its file has. */
const BROKEN = `import { ctx, tools } from "@trama-dev/runtime";
const text = await tools.read("data.txt");
await ctx.done({ words: text.split(" ").lenght.toFixed(0) });
`;
const MENDED = BROKEN.replace("lenght", "length");

/**
 * A project that fixes: no model in it, so that what it is handed and what becomes of what it does is all that
 * a test sees. What it does is said by the file `how.txt` of the copy it is handed (and "mend" without one).
 */
const FIXER = `import { ctx, agent, workspace } from "@trama-dev/runtime";
import { appendFileSync } from "node:fs";
const { program, error, journal, kept, types, ...more } = ctx.input.args as any;
const how = await workspace.read("how.txt").catch(() => "mend");
const copy = (await workspace.shell("pwd")).stdout.trim();
appendFileSync(process.env.SEEN_BY_FIXER!, JSON.stringify({
  pid: process.pid, how, error, journal, kept, more: Object.keys(more), copy,
  knowsTheApi: typeof types === "string" && types.includes("interface Ctx") && types.includes("complete(request: ModelRequest)"),
  files: await workspace.list("*"), mine: process.env.MINE ?? null,
}) + "\\n");
if (how === "ask") {
  // (A fixer that asks a model, as one would: twice.)
  for (const turn of [1, 2]) await agent.complete({ messages: [{ role: "user", content: "turn " + turn }] });
}
// (At work for ten minutes: a promise nobody settles would be no work at all, and node would end the program there.)
if (how === "wait") await new Promise((resolve) => setTimeout(resolve, 600_000));
if (how === "fail") throw new Error("the fixer has a fault of its own");
if (how === "none") await ctx.done({ unfixable: "what it asks for is nowhere to be had" });
else if (how === "say nothing") await ctx.done({ note: "no program here" });
else if (how === "same") await ctx.done({ program });
else {
  // What it puts right beside the program, in the copy.
  await workspace.write("mended-by.txt", "the fixer");
  await ctx.done({ program: program.replace("lenght", "length") });
}
`;

const journalsOf = (projectDir) => {
  const dir = join(projectDir, "logs", "journal");
  return readdirSync(dir).sort().map((file) => readFileSync(join(dir, file), "utf-8").trim().split("\n").map((line) => JSON.parse(line)));
};

/** A project that fails, a project that fixes, and what the fixer wrote down each time it was asked. */
function projects(t, how) {
  const projectDir = makeTempDir("trama-fix-broken-"), fixer = makeTempDir("trama-fix-fixer-"), notes = makeTempDir("trama-fix-seen-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(fixer); cleanupTempDir(notes); });
  createProjectFixture(projectDir, { programSource: BROKEN });
  writeFileSync(join(projectDir, "data.txt"), "the heron waits at low tide");
  if (how) writeFileSync(join(projectDir, "how.txt"), how);
  createProjectFixture(fixer, { programSource: FIXER });
  const seen = join(notes, "seen.jsonl");
  writeFileSync(seen, "");
  return {
    projectDir, fixer,
    seen: () => readFileSync(seen, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    run: (options = {}) => withEnv({ SEEN_BY_FIXER: seen }, () => captureConsole("warn", () =>
      runProgram({ projectDir, repairWith: fixer, maxRepairAttempts: 1, timeout: 30_000, ...options }))),
  };
}

test("a fix is asked of the project a run names: it works in the copy as its workspace, and the program it answers with is tried and installed as any fix is", async (t) => {
  const it = projects(t);
  const { result } = await it.run({ env: { MINE: "the run's" } });
  assert.deepEqual(result, { status: "done", result: { words: "6" } });

  // The fix is the project's now; and what the fixer put right beside it in the copy reached the project with it.
  assert.equal(readFileSync(join(it.projectDir, "program.ts"), "utf-8"), MENDED);
  assert.equal(readFileSync(join(it.projectDir, "mended-by.txt"), "utf-8"), "the fixer");
  // (On record as the version after the program that failed, which was put there when it was run.)
  assert.deepEqual([readFileSync(join(it.projectDir, "history", "0001.ts"), "utf-8"), readFileSync(join(it.projectDir, "history", "0002.ts"), "utf-8")], [BROKEN, MENDED]);

  // What it was handed: the failure, the failed run's record, that what it changes is kept, the API as an
  // author is shown it — and nothing else; a copy of the project to work in, which is not the project; and
  // the variables of the run it fixes for.
  const [told, ...more] = it.seen();
  assert.deepEqual(more, []);
  assert.match(told.error, /toFixed/);
  assert.deepEqual({ how: told.how, kept: told.kept, more: told.more, knowsTheApi: told.knowsTheApi, mine: told.mine }, { how: "mend", kept: true, more: [], knowsTheApi: true, mine: "the run's" });
  assert.deepEqual(told.files, [".gitignore", "data.txt", "meta.json", "package.json", "program.ts"]);
  assert.notEqual(told.copy, realpathSync(it.projectDir));
  assert.equal(existsSync(told.copy), false, "the copy is gone with the attempt");

  // On record: the fix asked for, the run that was started for it, and the fix — in the failing run's journal;
  // and the fixer's own journal, in its own project, says whose it was.
  const [records] = journalsOf(it.projectDir);
  assert.equal(told.journal, join(realpathSync(it.projectDir), "logs", "journal", `${records[0].run}.jsonl`));
  const kinds = records.map((record) => record.kind);
  const asked = kinds.indexOf("fix-request"), child = records.find((record) => record.kind === "child"), fix = records.find((record) => record.kind === "fix");
  assert.ok(asked < kinds.indexOf("child") && kinds.indexOf("child") < kinds.indexOf("fix"));
  assert.equal(child.purpose, "fix");
  assert.deepEqual([fix.ok, fix.source, fix.changed], [true, MENDED, ["mended-by.txt"]]);
  const [fixers] = journalsOf(it.fixer);
  assert.equal(fixers[0].run, child.run);
  assert.deepEqual({ parent: fixers[0].parent.run, depth: fixers[0].depth, maxRepairAttempts: fixers[0].maxRepairAttempts }, { parent: records[0].run, depth: 1, maxRepairAttempts: 0 });
  assert.equal(fixers.at(-1).kind, "end");
  const shown = (await captureConsole("log", async () => printJournals(it.projectDir, "it", {}))).messages.join("\n");
  assert.match(shown, new RegExp(`fix asked for: .*\\n +\\d+\\.\\d+s +the fix is asked of a project: run ${child.run}\\n[^]*fix returned`));
});

test("the project that fixes is named for a run, or in the configuration — by a path, or by its name among the user's projects", async (t) => {
  const home = makeTempDir("trama-fix-home-");
  t.after(() => cleanupTempDir(home));
  const it = projects(t);
  createProjectFixture(join(home, ".trama", "projects", "mender"), { programSource: FIXER });
  const configured = (config) => { writeJson(join(home, ".trama", "config.json"), config); return withEnv({ HOME: home }, () => it.run({ repairWith: undefined })); };

  // By name: one of the user's.
  assert.deepEqual((await configured({ repairWith: "mender" })).result, { status: "done", result: { words: "6" } });
  assert.equal(journalsOf(join(home, ".trama", "projects", "mender")).length, 1);
  // By path; and what a run names comes before what the configuration does.
  writeFileSync(join(it.projectDir, "program.ts"), BROKEN);
  writeJson(join(home, ".trama", "config.json"), { repairWith: "no-such-project" });
  assert.equal((await withEnv({ HOME: home }, () => it.run())).result.status, "done");
  assert.equal(journalsOf(it.fixer).length, 1);

  // What is no project is said before anything is run — and not where no fix would be asked for anyway.
  writeFileSync(join(it.projectDir, "program.ts"), BROKEN);
  await assert.rejects(configured({ repairWith: "no-such-project" }), { message: `repairWith names no project: there is none at ${join(home, ".trama", "projects", "no-such-project")}` });
  await assert.rejects(it.run({ repairWith: join(home, "nowhere") }), { message: `repairWith names no project: there is none at ${join(home, "nowhere")}` });
  assert.equal((await withEnv({ HOME: home }, () => it.run({ repairWith: undefined, maxRepairAttempts: 0 }))).result.status, "failed");
  for (const [given, words] of [[7, '"repairWith" must be a project — its name, or a path to it (got 7)'], ["", '"repairWith" must be a project — its name, or a path to it (got "")']]) {
    writeJson(join(home, ".trama", "config.json"), { repairWith: given });
    await assert.rejects(withEnv({ HOME: home }, async () => loadConfig()), { message: `Invalid config: ${words}` });
  }
});

test("what comes back that is no fix is said as none: no program, the program as it was, a fixer that failed — and what fixes is not itself fixed", async (t) => {
  const failed = async (how, words, options) => {
    const it = projects(t, how);
    const { result } = await it.run(options);
    assert.equal(result.status, "failed");
    assert.match(result.reason, words);
    // The project is as it was.
    assert.equal(readFileSync(join(it.projectDir, "program.ts"), "utf-8"), BROKEN);
    assert.equal(existsSync(join(it.projectDir, "mended-by.txt")), false);
    return it;
  };
  await failed("same", /No fix came back: The repair returned the program unchanged, and changed nothing else in the project\./);
  // (The fixer's own failure: no fix is asked for it — of pi's agent, or of itself.)
  const it = await failed("fail", /No fix came back: The project asked for the fix failed: [^]*the fixer has a fault of its own/, { maxRepairAttempts: 3 });
  assert.equal(it.seen().length, 1);
  assert.equal(journalsOf(it.fixer)[0].some((record) => record.kind === "fix-request"), false);

  // One that says there is no fix has answered: the run fails with why, and nobody is asked again.
  const none = await failed("none", /No fix came back: It was said that there is none to be had: what it asks for is nowhere to be had$/, { maxRepairAttempts: 3 });
  assert.equal(none.seen().length, 1);
  assert.deepEqual(journalsOf(none.projectDir)[0].filter((record) => record.kind === "fix").map(({ ok, none }) => ({ ok, none })), [{ ok: false, none: true }]);
  await failed("say nothing", /No fix came back: The project asked for the fix answered with no program: its result is to be \{ program \}, the whole of the fixed program — or \{ unfixable \}, why there is no fix\.$/);

  // A project is not asked to fix itself.
  const own = projects(t);
  const { result } = await own.run({ repairWith: own.projectDir });
  assert.match(result.reason, /No fix came back: A project is not asked to fix itself: repairWith names the project that failed\./);
  assert.deepEqual(own.seen(), []);

  // Without one named, the fix is asked of pi's agent as it always was.
  const plain = projects(t);
  let asked = 0, prompted = "";
  const original = llm.repair;
  llm.repair = async (prompt) => { asked += 1; prompted = prompt; return MENDED; };
  t.after(() => { llm.repair = original; });
  assert.equal((await plain.run({ repairWith: undefined })).result.status, "done");
  assert.equal(asked, 1);
  assert.deepEqual(plain.seen(), []);

  // And pi's agent has the same way out: an answer that begins "NO FIX:" is that — not a program to install
  // and try, and not something to ask for again.
  assert.match(prompted, /there is no fix, and you are not to hand over such a program: answer instead with one line that begins "NO FIX:" and says why\.\n/);
  const hopeless = projects(t);
  asked = 0;
  llm.repair = async () => { asked += 1; return "\nNO FIX: the answer is known by its hash, and by nothing else.\n"; };
  const { result: told } = await hopeless.run({ repairWith: undefined, maxRepairAttempts: 3 });
  assert.equal(told.status, "failed");
  assert.match(told.reason, /^Failed after 1 repair attempt\(s\): [^]*No fix came back: It was said that there is none to be had: the answer is known by its hash, and by nothing else\.$/);
  assert.equal(asked, 1);
  assert.equal(readFileSync(join(hopeless.projectDir, "program.ts"), "utf-8"), BROKEN);
  const [fix] = journalsOf(hopeless.projectDir)[0].filter((record) => record.kind === "fix");
  assert.deepEqual({ ok: fix.ok, none: fix.none, used: fix.used }, { ok: false, none: true, used: undefined });
});

test("a fix by a project is the failing run's own: what its model is asked is counted in that run's budget, and it is stopped with the run", async (t) => {
  const took = (tokens) => ({ model: "p/m", input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, cost: tokens / 1000 });
  const original = llm.complete;
  let requests = 0;
  llm.complete = async (_request, call) => { requests += 1; call.used(took(400)); return { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" }; };
  t.after(() => { llm.complete = original; });

  // Counted: two requests at 400 tokens, in the run's own count. (On record where they were made: in the
  // fixer's journal, as what a run a program asked for used is in that run's.)
  const counted = projects(t, "ask");
  assert.equal((await counted.run({ budget: { tokens: 5000 } })).result.status, "done");
  assert.equal(requests, 2);
  const shown = (await captureConsole("log", async () => printJournals(counted.fixer, "it", {}))).messages.join("\n");
  assert.match(shown, /end: done +\(800 tokens +\$0\.8000 in all\)/);
  // ...and said where the fix was asked for: on the failing run's record, with the fix, and in what that run used in all.
  const [fixed] = journalsOf(counted.projectDir)[0].filter((record) => record.kind === "fix");
  assert.deepEqual({ by: fixed.by, used: fixed.used }, { by: counted.fixer, used: { calls: 2, tokens: 800, cost: 0.8 } });
  const asking = (await captureConsole("log", async () => printJournals(counted.projectDir, "it", {}))).messages.join("\n");
  assert.match(asking, /fix returned +800 tokens +\$0\.8000$/m);
  assert.match(asking, /end: done +\(800 tokens +\$0\.8000 in all\)/);
  // ...and held to it: 800 tokens of 700 is the budget reached, by the fixer's first request — its second is refused.
  requests = 0;
  const over = projects(t, "ask");
  const spent = await over.run({ budget: { tokens: 300 } });
  assert.match(spent.result.reason, /The budget of a run this one is part of is spent: 400 tokens used of 300\./);
  assert.equal(requests, 1);

  // Held: with one call allowed, the fixer's second request is refused — it fails, and there is no fix.
  requests = 0;
  const held = projects(t, "ask");
  const { result, messages } = await held.run({ budget: { calls: 1 } });
  assert.equal(result.status, "failed");
  assert.match(result.reason, /No fix came back: The project asked for the fix failed: [^]*The budget of a run this one is part of is spent: 1 of 1 calls to a model made\./);
  assert.equal(requests, 1);
  assert.ok(messages.some((message) => message.includes("1 of 1 calls to a model made")));
  assert.equal(readFileSync(join(held.projectDir, "program.ts"), "utf-8"), BROKEN);

  // Stopped: a run that is stopped while its fix is being made ends there, and the fixer's program with it.
  // (Stopped, and not left to its time: it has two minutes, and is over in a few seconds.)
  const stopped = projects(t, "wait");
  const stop = new AbortController();
  const running = stopped.run({ signal: stop.signal, timeout: 120_000 });
  await waitFor(() => stopped.seen().length === 1, "the fixer to be at work");
  const { pid } = stopped.seen()[0];
  assert.equal(isAlive(pid), true);
  const at = Date.now();
  stop.abort();
  assert.equal((await running).result.status, "failed");
  assert.ok(Date.now() - at < 60_000, `the run was stopped, and did not wait for its fixer's time to be up (${Date.now() - at}ms)`);
  await waitFor(() => !isAlive(pid), "the fixer's program to be gone");
  assert.equal(readFileSync(join(stopped.projectDir, "program.ts"), "utf-8"), BROKEN);
});

test("where what is changed beside the program is not kept, a fixer is told so, and none of it is", async (t) => {
  const home = makeTempDir("trama-fix-home-");
  t.after(() => cleanupTempDir(home));
  writeJson(join(home, ".trama", "config.json"), { agentChanges: "discard" });
  const it = projects(t);
  const { result } = await withEnv({ HOME: home }, () => it.run());
  assert.deepEqual(result, { status: "done", result: { words: "6" } });
  assert.equal(it.seen()[0].kept, false);
  assert.equal(readFileSync(join(it.projectDir, "program.ts"), "utf-8"), MENDED);
  assert.equal(existsSync(join(it.projectDir, "mended-by.txt")), false);
});

test("a program names who fixes the runs it asks for: by a path of its own, or by a name", async (t) => {
  const it = projects(t);
  const asker = makeTempDir("trama-fix-asker-");
  t.after(() => cleanupTempDir(asker));
  // (The fixer by a path that is relative to where the asking program is: the runner is somewhere else.)
  createProjectFixture(asker, { programSource: `import { ctx } from "@trama-dev/runtime";
import { runProgram } from "@trama-dev/runtime/runner";
import { relative } from "node:path";
const { broken, fixer } = ctx.input.args as any;
const result = await runProgram({ projectDir: broken, repairWith: "./" + relative(process.cwd(), fixer), maxRepairAttempts: 1, timeout: 30000 });
await ctx.done({ result });
` });
  const { result } = await withEnv({ SEEN_BY_FIXER: join(asker, "seen.jsonl") }, () => captureConsole("warn", () =>
    runProgram({ projectDir: asker, args: { broken: it.projectDir, fixer: it.fixer }, maxRepairAttempts: 0, timeout: 60_000 })));
  assert.deepEqual(result, { status: "done", result: { result: { status: "done", result: { words: "6" } } } });
  assert.equal(readFileSync(join(it.projectDir, "program.ts"), "utf-8"), MENDED);
  // The fixer's run is two deep: under the run that failed, which is under the program that asked for it.
  assert.equal(journalsOf(it.fixer)[0][0].depth, 2);
});
