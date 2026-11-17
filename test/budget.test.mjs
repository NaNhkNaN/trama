import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { llm } from "./fake-llm.mjs";
import { checkedBudget, createMeter } from "../packages/runtime/dist/budget.js";
import { createBackend, loadConfig, runProgram, validateProgram } from "../packages/runtime/dist/runner.js";
import { createProject, updateProject } from "../packages/runtime/dist/index.js";
import { printJournals } from "../packages/runtime/dist/journal-view.js";
import { PiAdapter } from "../packages/runtime/dist/pi-adapter.js";
import { Session } from "../packages/session/dist/index.js";
import {
  REPO_ROOT, captureConsole, cleanupTempDir, createProjectFixture, makeTempDir, readJson, runNodeCommand, withEnv, writeJson,
} from "./helpers.mjs";

/** A report of usage: so many tokens read, at a dollar a thousand. */
const took = (tokens) => ({ model: "p/m", input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, cost: tokens / 1000 });

const journalsOf = (projectDir) => {
  const dir = join(projectDir, "logs", "journal");
  return readdirSync(dir).sort().map((file) => readFileSync(join(dir, file), "utf-8").trim().split("\n").map((line) => JSON.parse(line)));
};

/** Stand in for the model while a test runs: `ask` answers a program's calls, `repair` a request for a fix. */
function standIn(t, { ask, repair }) {
  const original = { ask: llm.ask, repair: llm.repair };
  if (ask) llm.ask = ask;
  if (repair) llm.repair = repair;
  t.after(() => Object.assign(llm, original));
}

/** A program that asks its agent `ctx.input.args.times` times, and says how each call went. */
const ASKS = `import { ctx, agent } from "@trama-dev/runtime";
const went = [];
for (let i = 0; i < Number(ctx.input.args.times ?? 3); i++) {
  went.push(await agent.instruct("question " + i).catch((err) => String(err.message)));
}
await ctx.done({ went });
`;

test("a budget is an object of caps, each a number that is not negative", () => {
  assert.deepEqual(checkedBudget({}), {});
  assert.deepEqual(checkedBudget({ cost: 2.5, tokens: 1000, calls: 3 }), { cost: 2.5, tokens: 1000, calls: 3 });
  assert.deepEqual(checkedBudget({ cost: 0, tokens: 0.5, calls: 0 }), { cost: 0, tokens: 0.5, calls: 0 });
  // One given as nothing is one not given.
  assert.deepEqual(checkedBudget({ cost: undefined, tokens: null, calls: 1 }), { calls: 1 });
  const given = { cost: 1 };
  assert.notEqual(checkedBudget(given), given, "what comes back is a copy");
  assert.deepEqual(checkedBudget(Object.assign(Object.create(null), { calls: 2 })), { calls: 2 });

  for (const [bad, why] of [
    [null, /^budget is an object of caps \(cost, tokens, calls\): got null$/],
    [[1], /^budget is an object of caps \(cost, tokens, calls\): got an array$/],
    ["2", /^budget is an object of caps \(cost, tokens, calls\): got string$/],
    [{ dollars: 2 }, /^budget has no cap "dollars": its caps are cost, tokens, calls$/],
    [{ cost: "2" }, /^budget\.cost must be a number that is not negative \(got "2"\)$/],
    [{ cost: -1 }, /^budget\.cost must be a number that is not negative \(got -1\)$/],
    [{ tokens: NaN }, /^budget\.tokens must be a number that is not negative \(got NaN\)$/],
    [{ tokens: Infinity }, /^budget\.tokens must be a number that is not negative \(got Infinity\)$/],
    [{ cost: 5n }, /^budget\.cost must be a number that is not negative \(got 5\)$/],
    // What holds its caps some other way than a plain object does would be read as holding none.
    [new Map([["cost", 1]]), /^budget is an object of caps \(cost, tokens, calls\): got an object that is not a plain one$/],
    [Object.create({ cost: 1 }), /got an object that is not a plain one$/],
    [new Date(), /got an object that is not a plain one$/],
    [{ calls: 1.5 }, /^budget\.calls must be a whole number that is not negative \(got 1\.5\)$/],
    [{ calls: -1 }, /^budget\.calls must be a whole number that is not negative \(got -1\)$/],
    [{ calls: true }, /^budget\.calls must be a whole number/],
  ]) {
    assert.throws(() => checkedBudget(bad), (err) => why.test(err.message), String(why));
  }
  assert.throws(() => checkedBudget({ cost: -1 }, `"budget"`), /^Error: "budget"\.cost must be/);
});

test("a meter counts what calls use, admits no call once a cap is reached, and says where one under way is to stop", () => {
  // Nothing capped: everything is admitted, whatever it uses.
  const free = createMeter();
  for (let i = 0; i < 5; i++) assert.equal(free.admit().sofar(took(1e9)), undefined);
  assert.equal(free.spent(), undefined);
  assert.deepEqual(free.limit, {});

  // Cost: what calls under way have used counts with what the finished ones did.
  const meter = createMeter({ cost: 1 });
  const first = meter.admit(), second = meter.admit();
  assert.equal(first.sofar(took(400)), undefined);
  assert.equal(second.sofar(took(500)), undefined);
  // (What a call says is what it has used in all: said again, it is not added again.)
  assert.equal(first.sofar(took(400)), undefined);
  assert.equal(meter.spent(), undefined);
  assert.equal(first.sofar(took(500)), "The budget is spent: $1.0000 used of $1.");
  assert.equal(meter.spent(), "The budget is spent: $1.0000 used of $1.");
  assert.throws(() => meter.admit(), { message: "The budget is spent: $1.0000 used of $1." });
  // A call that is over has used what was last said of it — and being over twice changes nothing.
  first.close();
  first.close();
  second.close();
  assert.equal(meter.spent(), "The budget is spent: $1.0000 used of $1.");
  // (What is said of a call after it is over is not counted.)
  first.sofar(took(9000));
  assert.equal(meter.spent(), "The budget is spent: $1.0000 used of $1.");

  // Tokens: all of them, read and written, from a cache or not.
  const tokens = createMeter({ tokens: 100 });
  const call = tokens.admit();
  assert.equal(call.sofar({ input: 20, output: 30, cacheRead: 40, cacheWrite: 9, cost: 5 }), undefined);
  assert.equal(call.sofar({ input: 20, output: 30, cacheRead: 40, cacheWrite: 10, cost: 5 }), "The budget is spent: 100 tokens used of 100.");
  // A report that is not one, or says no number, counts as nothing — it is not for a count to fail a call.
  const odd = createMeter({ tokens: 1, cost: 1 });
  for (const report of [undefined, {}, { input: "many", cost: NaN }, { input: Infinity, cost: Infinity }]) assert.equal(odd.admit().sofar(report), undefined);
  // Nor does a report of less than nothing make room for what another call used.
  const room = createMeter({ tokens: 10, cost: 1 });
  room.admit().sofar({ input: -100, output: -100, cacheRead: -100, cacheWrite: -100, cost: -100 });
  assert.equal(room.admit().sofar({ input: 3, output: 3, cacheRead: 2, cacheWrite: 2, cost: 0 }), "The budget is spent: 10 tokens used of 10.");
  assert.equal(createMeter({ cost: 1 }).admit().sofar(took(-5000)), undefined);
  // (A cap on cost is reached where it is reached, or a billionth of a dollar short: not a cent short.)
  assert.equal(createMeter({ cost: 1 }).admit().sofar(took(995)), undefined);
  // What a report says beyond anything a call could use is counted as the most a call can: the count stays a number,
  // and a cap goes on being reached — also once the report is said again, and by the calls that come after.
  const huge = createMeter({ tokens: 100 }, createMeter({ cost: 1e30 }));
  const absurd = huge.admit();
  for (let said = 0; said < 2; said++) assert.equal(absurd.sofar({ input: 1e308, output: 1e308, cacheRead: 1e308, cacheWrite: 1e308, cost: 1e308 }), "The budget is spent: 4000000000000000 tokens used of 100.");
  absurd.sofar(took(1));
  assert.equal(huge.spent(), undefined);
  assert.equal(huge.admit().sofar(took(100)), "The budget is spent: 101 tokens used of 100.");
  // A call may come to say it used less than it said: its last word is what it used.
  const less = createMeter({ tokens: 100 });
  const wavering = less.admit();
  assert.equal(wavering.sofar(took(100)), "The budget is spent: 100 tokens used of 100.");
  assert.equal(wavering.sofar(took(40)), undefined);
  assert.equal(less.spent(), undefined);
  // Ten tenths of a dollar are a dollar, whatever they add up to as fractions.
  const tenths = createMeter({ cost: 1 });
  for (let i = 0; i < 10; i++) {
    const call = tenths.admit();
    call.sofar(took(100));
    call.close();
  }
  assert.equal(tenths.spent(), "The budget is spent: $1.0000 used of $1.");
  // A meter holds what it counts to something where it has a cap, or a meter above it has.
  assert.deepEqual([createMeter().capped(), createMeter({}).capped(), createMeter({ calls: 0 }).capped(), createMeter({}, createMeter({ cost: 1 })).capped(), createMeter({}, createMeter()).capped()],
    [false, false, true, true, false]);

  // Calls: so many are admitted, and the cap stops none that is under way.
  const calls = createMeter({ calls: 2 });
  const one = calls.admit(), two = calls.admit();
  assert.equal(one.sofar(took(5)), undefined);
  assert.equal(two.sofar(took(5)), undefined);
  assert.equal(calls.reached(), undefined);
  assert.throws(() => calls.admit(), { message: "The budget is spent: 2 of 2 calls to a model made." });
  one.close();
  assert.throws(() => calls.admit(), /2 of 2 calls/, "a call that is over was still made");
  assert.throws(() => createMeter({ calls: 0 }).admit(), { message: "The budget is spent: 0 of 0 calls to a model made." });
  assert.throws(() => createMeter({ cost: 0 }).admit(), { message: "The budget is spent: $0.0000 used of $0." });
  // Where two caps are reached, what calls used is what is said.
  const both = createMeter({ cost: 1, tokens: 10, calls: 1 });
  assert.equal(both.admit().sofar(took(1000)), "The budget is spent: $1.0000 used of $1.");
  assert.equal(both.spent(), "The budget is spent: $1.0000 used of $1.");
});

test("what a run uses is counted in the budget of the run that asked for it too, and refused where that has no room", () => {
  const top = createMeter({ cost: 1 });
  const child = createMeter({ calls: 2 }, top);
  const grandchild = createMeter({}, child);

  const deep = grandchild.admit();
  assert.equal(deep.sofar(took(600)), undefined);
  const own = top.admit();
  // The parent's own call, and the grandchild's, together: the budget is the top's, and each is told in its own words.
  assert.equal(own.sofar(took(400)), "The budget is spent: $1.0000 used of $1.");
  assert.equal(deep.sofar(took(600)), "The budget of a run this one is part of is spent: $1.0000 used of $1.");
  assert.equal(child.spent(), "The budget of a run this one is part of is spent: $1.0000 used of $1.");
  assert.throws(() => grandchild.admit(), { message: "The budget of a run this one is part of is spent: $1.0000 used of $1." });
  deep.close();
  own.close();
  assert.throws(() => child.admit(), /a run this one is part of/);
  // (What is said of a call once it is over is counted nowhere: not in its own run, and in none above.)
  deep.sofar(took(90000));
  assert.equal(top.spent(), "The budget is spent: $1.0000 used of $1.");

  // A run's own cap comes before the one above it; and a call a run makes is one made in every run above.
  const above = createMeter({ calls: 3 });
  const below = createMeter({ calls: 1 }, above);
  below.admit().close();
  assert.equal(below.spent(), "The budget is spent: 1 of 1 calls to a model made.");
  assert.equal(above.spent(), undefined);
  const sibling = createMeter({}, above);
  sibling.admit();
  sibling.admit();
  assert.equal(above.spent(), "The budget is spent: 3 of 3 calls to a model made.");
  assert.equal(sibling.spent(), "The budget of a run this one is part of is spent: 3 of 3 calls to a model made.");
  // (The cap on how many are made stops none under way, here or above.)
  assert.equal(sibling.reached(), undefined);
  // Where a run's own budget is spent and one above it too, it is told of its own.
  const outer = createMeter({ calls: 1 });
  const inner = createMeter({ calls: 1 }, outer);
  inner.admit();
  assert.equal(inner.spent(), "The budget is spent: 1 of 1 calls to a model made.");
});

test("a backend refuses a call once its budget is spent, stops one under way where it would ask again, and says so once", async (t) => {
  const realAsk = PiAdapter.prototype.ask;
  t.after(() => { PiAdapter.prototype.ask = realAsk; });
  const config = { provider: "fake", model: "plain" };
  const said = [];
  const backend = createBackend(config, createMeter({ cost: 1 }), (why) => said.push(why));

  // A call that uses less than there is goes through, and what it used is told on as before.
  const heard = [];
  PiAdapter.prototype.ask = async (_prompt, call) => {
    call.sofar(took(200));
    call.used(took(300));
    return "an answer";
  };
  assert.equal(await backend.ask("p", { cwd: "/work", used: (usage) => heard.push(["used", usage.input]), sofar: (usage) => heard.push(["sofar", usage.input]) }), "an answer");
  assert.deepEqual(heard, [["sofar", 200], ["used", 300]]);
  assert.equal(backend.spent(), undefined);
  assert.deepEqual(said, []);

  // One that reaches the budget while it is under way is cancelled there — and fails with why, not as one its caller cancelled.
  const order = [];
  PiAdapter.prototype.ask = (_prompt, call) => new Promise((_resolve, reject) => {
    call.signal.addEventListener("abort", () => {
      order.push("cancelled");
      // The backend lets go a little later, and says then what the call used in the end.
      setTimeout(() => { call.used(took(900)); order.push("let go"); reject(new Error("stopped")); }, 30);
    });
    call.sofar(took(500));
    order.push("went on");
    call.sofar(took(800));
  });
  await assert.rejects(() => backend.ask("p", { cwd: "/work" }), { message: "The budget is spent: $1.1000 used of $1." });
  assert.deepEqual(order, ["went on", "cancelled"], "whoever asked is answered at once");
  // (...also where its backend then says it used less after all: it was stopped for the budget.)
  const fickle = createBackend(config, createMeter({ cost: 1 }));
  PiAdapter.prototype.ask = (_prompt, call) => new Promise((_resolve, reject) => {
    call.signal.addEventListener("abort", () => setTimeout(() => reject(new Error("stopped")), 5));
    call.sofar(took(1500));
    call.sofar(took(200));
  });
  await assert.rejects(() => fickle.ask("p", { cwd: "/work" }), { message: "The budget is spent: $1.5000 used of $1." });
  // (A backend remembers that it stopped a call for the budget, though by its count there is room again.)
  assert.deepEqual([fickle.spent(), fickle.refused(), createBackend(config, createMeter({ cost: 1 })).refused()], [undefined, "The budget is spent: $1.5000 used of $1.", undefined]);
  assert.deepEqual([backend.counts(), createBackend(config).counts(), createBackend(config, createMeter({}, createMeter({ calls: 9 }))).counts()], [true, false, true]);
  assert.deepEqual(said, ["The budget is spent: $1.1000 used of $1."]);
  // What it used in the end is counted when the backend says it; and a run's end waits for that.
  await backend.letGo();
  assert.deepEqual(order, ["went on", "cancelled", "let go"]);
  assert.equal(backend.spent(), "The budget is spent: $1.2000 used of $1.");

  // After that no call is taken on: the backend is not asked.
  PiAdapter.prototype.ask = async () => assert.fail("the backend was asked");
  await assert.rejects(() => backend.ask("p", { cwd: "/work" }), { message: "The budget is spent: $1.2000 used of $1." });
  assert.equal(said.length, 1, "it is said once");
  // (What a backend remembers is why a call was first kept from the model, not what the count came to after.)
  assert.equal(backend.refused(), "The budget is spent: $1.1000 used of $1.");

  // A call its caller cancels was cancelled by them, whatever the budget has come to since.
  const stop = new AbortController();
  const other = createBackend(config, createMeter({ cost: 1 }));
  PiAdapter.prototype.ask = (_prompt, call) => new Promise((_resolve, reject) => {
    call.signal.addEventListener("abort", () => reject(new Error("stopped")));
    stop.abort();
    call.sofar(took(5000));
  });
  await assert.rejects(() => other.ask("p", { cwd: "/work", signal: stop.signal }), /Aborted/);
  // ...and one that fails by itself fails as it did.
  const third = createBackend(config, createMeter({ calls: 5 }));
  PiAdapter.prototype.ask = async (_prompt, call) => { call.used(took(1)); throw new Error("the model is away"); };
  await assert.rejects(() => third.ask("p", { cwd: "/work" }), { message: "the model is away" });

  // What a backend says of a call after it has let go of it is not that call's any more, and is counted nowhere.
  const strict = createBackend(config, createMeter({ cost: 1 }));
  let late;
  PiAdapter.prototype.ask = async (_prompt, call) => { call.used(took(100)); late = () => { call.sofar(took(5000)); call.used(took(5000)); }; return "an answer"; };
  assert.equal(await strict.ask("p", { cwd: "/work" }), "an answer");
  late();
  assert.equal(strict.spent(), undefined);
  PiAdapter.prototype.ask = async (_prompt, call) => { call.used(took(900)); return "an answer"; };
  await strict.ask("p", { cwd: "/work" });
  assert.equal(strict.spent(), "The budget is spent: $1.0000 used of $1.");

  // Without a budget nothing is counted against anything: a backend made as before behaves as before.
  const free = createBackend(config);
  PiAdapter.prototype.ask = async (_prompt, call) => { call.sofar(took(1e9)); call.used(took(1e9)); return "an answer"; };
  assert.equal(await free.ask("p", { cwd: "/work" }), "an answer");
  assert.equal(free.spent(), undefined);
});

test("a run is held to its budget: a call that comes when it is spent is refused, and it is said once, and written down", async (t) => {
  const projectDir = makeTempDir("trama-budget-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { programSource: ASKS });
  let asked = 0;
  standIn(t, { ask: async (prompt, call) => { asked += 1; call.used(took(400)); return `answer to ${prompt}`; } });

  // Three calls at 40 cents under a dollar: the third is the one that reaches it, and is still answered — the fourth is refused.
  const { messages, result } = await captureConsole("warn", () =>
    runProgram({ projectDir, args: { times: 5 }, budget: { cost: 1 }, maxRepairAttempts: 0, timeout: 20_000 }));
  assert.deepEqual(result, {
    status: "done",
    result: { went: [
      "answer to question 0", "answer to question 1", "answer to question 2",
      "trama runtime error: Error: The budget is spent: $1.2000 used of $1.",
      "trama runtime error: Error: The budget is spent: $1.2000 used of $1.",
    ] },
  });
  assert.equal(asked, 3);
  assert.deepEqual(messages, ["[trama] The budget is spent: $1.2000 used of $1."]);

  const [records] = journalsOf(projectDir);
  assert.deepEqual(records[0].budget, { cost: 1 });
  assert.deepEqual(records.filter((record) => record.kind === "budget").map((record) => record.spent), ["The budget is spent: $1.2000 used of $1."]);
  assert.deepEqual(records.filter((record) => record.kind === "result" && record.ok === false).map((record) => record.seq), [4, 5]);
  const shown = (await captureConsole("log", async () => printJournals(projectDir, "it", {}))).messages.join("\n");
  assert.match(shown, /^ +\d+\.\d+s  The budget is spent: \$1\.2000 used of \$1\.$/m);

  // The same of calls, and of tokens; and a run with no budget is held to none, and has none on record.
  asked = 0;
  const byCalls = await runProgram({ projectDir, args: { times: 3 }, budget: { calls: 2 }, maxRepairAttempts: 0, timeout: 20_000 });
  assert.equal(byCalls.result.went[2], "trama runtime error: Error: The budget is spent: 2 of 2 calls to a model made.");
  const byTokens = await runProgram({ projectDir, args: { times: 3 }, budget: { tokens: 800 }, maxRepairAttempts: 0, timeout: 20_000 });
  assert.equal(byTokens.result.went[2], "trama runtime error: Error: The budget is spent: 800 tokens used of 800.");
  const free = await runProgram({ projectDir, args: { times: 4 }, maxRepairAttempts: 0, timeout: 20_000 });
  assert.deepEqual(free.result.went, [0, 1, 2, 3].map((i) => `answer to question ${i}`));
  const all = journalsOf(projectDir);
  assert.deepEqual(all.map((journal) => journal[0].budget), [{ cost: 1 }, { calls: 2 }, { tokens: 800 }, undefined]);
  assert.equal("budget" in all[3][0], false);
  assert.equal(all[3].some((record) => record.kind === "budget"), false);

  // What is no budget is refused before anything is run.
  for (const [budget, why] of [[{ dollars: 1 }, /budget has no cap "dollars"/], [{ cost: -1 }, /budget\.cost must be a number that is not negative/], [5, /budget is an object of caps/]]) {
    await assert.rejects(() => runProgram({ projectDir, budget, maxRepairAttempts: 0, timeout: 20_000 }), why);
  }
  assert.equal(journalsOf(projectDir).length, 4);
});

test("a call under way when the budget is reached is stopped where its agent would ask the model again", async (t) => {
  const projectDir = makeTempDir("trama-budget-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { programSource: ASKS });
  const turns = [];
  // An agent that would ask its model five times, a thousand tokens each, saying before each but the first what it has used.
  standIn(t, {
    ask: (prompt, call) => new Promise((resolve, reject) => {
      let turn = 0;
      call.signal.addEventListener("abort", () => { call.used(took(turn * 1000)); reject(new Error("stopped")); });
      const next = () => {
        if (call.signal.aborted) return;
        if (turn > 0) call.sofar(took(turn * 1000));
        if (call.signal.aborted) return;
        turns.push(`${prompt} turn ${turn += 1}`);
        if (turn === 5) { call.used(took(5000)); return resolve("an answer"); }
        setImmediate(next);
      };
      next();
    }),
  });

  const { messages, result } = await captureConsole("warn", () =>
    runProgram({ projectDir, args: { times: 2 }, budget: { tokens: 3000 }, maxRepairAttempts: 0, timeout: 20_000 }));
  assert.deepEqual(result.result.went, [
    "trama runtime error: Error: The budget is spent: 3000 tokens used of 3000.",
    "trama runtime error: Error: The budget is spent: 3000 tokens used of 3000.",
  ]);
  assert.deepEqual(turns, ["question 0 turn 1", "question 0 turn 2", "question 0 turn 3"], "the fourth request was not made, and the second call never began");
  assert.deepEqual(messages, ["[trama] The budget is spent: 3000 tokens used of 3000."]);
  const [records] = journalsOf(projectDir);
  assert.deepEqual(records.filter((record) => record.kind === "usage").map((record) => [record.seq, record.input]), [[1, 3000]]);
});

test("where a run's budget is spent, a program that fails is not repaired: a fix is asked of a model too", async (t) => {
  const projectDir = makeTempDir("trama-budget-");
  t.after(() => cleanupTempDir(projectDir));
  const FAILS = `import { agent } from "@trama-dev/runtime";
console.log(await agent.instruct("a question"));
throw new Error("it does not work " + (await agent.instruct("another").catch(() => "at all")));
`;
  createProjectFixture(projectDir, { programSource: FAILS });
  let fixes = 0;
  standIn(t, {
    ask: async (_prompt, call) => { call.used(took(100)); return "an answer"; },
    repair: async (_prompt, call) => { fixes += 1; call.used(took(100)); return FAILS.replace("it does not work", `it still does not work, fix ${fixes},`); },
  });

  // The program's one call is all there is: no fix is asked for, and nothing is got ready for one.
  const none = await captureConsole("warn", () => runProgram({ projectDir, budget: { calls: 1 }, maxRepairAttempts: 3, timeout: 20_000 }));
  assert.equal(none.result.status, "failed");
  assert.match(none.result.reason, /^Program failed, and no repair was tried\. The budget is spent: 1 of 1 calls to a model made\.\nprogram\.ts exited with code 1/);
  assert.match(none.result.reason, /it does not work at all/);
  assert.equal(fixes, 0);
  assert.deepEqual(journalsOf(projectDir)[0].map((record) => record.kind).filter((kind) => kind.startsWith("fix")), []);
  assert.deepEqual(none.messages, ["[trama] The budget is spent: 1 of 1 calls to a model made."]);
  assert.deepEqual(journalsOf(projectDir)[0].slice(-2).map((record) => [record.kind, record.spent]), [["budget", "The budget is spent: 1 of 1 calls to a model made."], ["end", undefined]]);
  // Room for both of the program's calls and no more: no call is refused, and nothing is printed — the result says
  // why there was no repair, and the journal that the budget was spent when the run ended.
  const exact = await captureConsole("warn", () => runProgram({ projectDir, budget: { calls: 2 }, maxRepairAttempts: 3, timeout: 20_000 }));
  assert.match(exact.result.reason, /^Program failed, and no repair was tried\. The budget is spent: 2 of 2 calls to a model made\.\n/);
  assert.match(exact.result.reason, /it does not work an answer/);
  assert.deepEqual([exact.messages, fixes], [[], 0]);
  assert.deepEqual(journalsOf(projectDir)[1].filter((record) => record.kind === "budget").map((record) => record.spent), ["The budget is spent: 2 of 2 calls to a model made."]);

  // Room for the program's calls and one fix: the fix is tried, fails — its program uses what is left — and no second is asked for.
  const one = await captureConsole("warn", () => runProgram({ projectDir, budget: { calls: 4 }, maxRepairAttempts: 3, timeout: 20_000 }));
  assert.match(one.result.reason, /^Failed after 1 repair attempt\(s\), and no further repair was tried\. The budget is spent: 4 of 4 calls to a model made\.\n/);
  assert.match(one.result.reason, /it still does not work, fix 1, at all/);
  assert.equal(fixes, 1);
  // With room enough, repairs go on as they always did.
  const many = await runProgram({ projectDir, budget: { calls: 100 }, maxRepairAttempts: 2, timeout: 20_000 });
  assert.match(many.reason, /^Failed after 2 repair attempts: /);
  assert.equal(fixes, 3);
});

test("a run a program asks for is held to the budget of the run that asked, and to its own if it is given one — less, never more", async (t) => {
  const parentDir = makeTempDir("trama-budget-");
  const childDir = makeTempDir("trama-budget-");
  t.after(() => { cleanupTempDir(parentDir); cleanupTempDir(childDir); });
  createProjectFixture(childDir, { programSource: ASKS });
  createProjectFixture(parentDir, {
    programSource: `import { ctx, agent } from "@trama-dev/runtime";
import { runProgram } from "@trama-dev/runtime/runner";
const child = (budget) => runProgram({ projectDir: ${JSON.stringify(childDir)}, args: { times: 3 }, budget, maxRepairAttempts: 0, timeout: 20000 })
  .then((run) => run.result.went, (err) => String(err.message));
const first = await child(ctx.input.args.first);
const own = await agent.instruct("the parent's own").catch((err) => String(err.message));
const second = await child(ctx.input.args.second);
await ctx.done({ first, own, second });
`,
  });
  standIn(t, { ask: async (prompt, call) => { call.used(took(100)); return `answer to ${prompt}`; } });
  const run = (budget, args = {}) => captureConsole("warn", () => runProgram({ projectDir: parentDir, args, budget, maxRepairAttempts: 0, timeout: 30_000 }));
  const answers = [0, 1, 2].map((i) => `answer to question ${i}`);
  const above = (why) => `trama runtime error: Error: The budget of a run this one is part of is spent: ${why}`;
  const own = (why) => `trama runtime error: Error: The budget is spent: ${why}`;

  // Five calls for the tree: the first child's three, the parent's one, and one of the second child's.
  const five = await run({ calls: 5 });
  assert.deepEqual(five.result.result, {
    first: answers,
    own: "answer to the parent's own",
    second: [answers[0], above("5 of 5 calls to a model made."), above("5 of 5 calls to a model made.")],
  });
  // (Each run says once that it can ask no more: the child, and then nobody else did.)
  assert.deepEqual(five.messages, ["[trama] The budget of a run this one is part of is spent: 5 of 5 calls to a model made."]);
  // The journal of the run whose budget it was says so too, though it was a run it asked for that was refused.
  assert.deepEqual(journalsOf(parentDir).at(-1).filter((record) => record.kind === "budget").map((record) => record.spent), ["The budget is spent: 5 of 5 calls to a model made."]);
  assert.deepEqual(journalsOf(childDir).map((journal) => journal.filter((record) => record.kind === "budget").map((record) => record.spent)),
    [[], ["The budget of a run this one is part of is spent: 5 of 5 calls to a model made."]]);

  // A child given less than there is has that; one given more than there is has what there is.
  const narrowed = await run({ calls: 6 }, { first: { calls: 1 }, second: { calls: 100 } });
  assert.deepEqual(narrowed.result.result, {
    first: [answers[0], own("1 of 1 calls to a model made."), own("1 of 1 calls to a model made.")],
    own: "answer to the parent's own",
    second: answers,
  });
  const widened = await run({ calls: 2 }, { first: { calls: 100 } });
  assert.deepEqual(widened.result.result.first, [answers[0], answers[1], above("2 of 2 calls to a model made.")]);
  assert.equal(widened.result.result.own, own("2 of 2 calls to a model made."));

  // What is no budget is the request's fault, and nothing is run for it.
  const refused = await run(undefined, { first: { dollars: 1 }, second: { calls: 1.5 } });
  assert.equal(refused.result.result.first, 'trama runtime error: Invalid field: budget has no cap "dollars": its caps are cost, tokens, calls');
  assert.equal(refused.result.result.second, "trama runtime error: Invalid field: budget.calls must be a whole number that is not negative (got 1.5)");

  // The budget of each is in its own journal.
  const last = journalsOf(childDir).filter((journal) => journal[0].budget !== undefined).map((journal) => journal[0].budget);
  assert.deepEqual(last, [{ calls: 1 }, { calls: 100 }, { calls: 100 }]);
});

test("the config's budget is a run's where it is given none — a run nobody's program asked for — and a create's or an update's", async (t) => {
  const fakeHome = makeTempDir("trama-budget-home-");
  const childDir = makeTempDir("trama-budget-");
  t.after(() => { cleanupTempDir(fakeHome); cleanupTempDir(childDir); });
  const projectDir = join(fakeHome, ".trama", "projects", "asker");
  createProjectFixture(projectDir, { programSource: ASKS });
  createProjectFixture(childDir, { programSource: ASKS });
  const config = (budget) => writeJson(join(fakeHome, ".trama", "config.json"), { maxRepairAttempts: 0, ...(budget !== undefined && { budget }) });
  standIn(t, { ask: async (prompt, call) => { call.used(took(100)); return `answer to ${prompt}`; } });
  const went = async (options = {}) => (await runProgram({ projectDir, args: { times: 3 }, timeout: 20_000, ...options })).result.went.map((how) => how.startsWith("answer"));

  await withEnv({ HOME: fakeHome }, async () => {
    config({ calls: 2 });
    assert.deepEqual(loadConfig().budget, { calls: 2 });
    await captureConsole("warn", async () => {
      assert.deepEqual(await went(), [true, true, false]);
      // A run given a budget of its own has that one, and not the config's beside it.
      assert.deepEqual(await went({ budget: { calls: 3 } }), [true, true, true]);
      assert.deepEqual(await went({ budget: {} }), [true, true, true]);
      assert.deepEqual(await went({ budget: null }), [true, true, false], "null is a budget not given");
    });

    // A run a program asks for is under the budget of the run that asked — not under the config's again, by itself.
    createProjectFixture(join(fakeHome, ".trama", "projects", "parent"), {
      programSource: `import { ctx } from "@trama-dev/runtime";
import { runProgram } from "@trama-dev/runtime/runner";
const run = await runProgram({ projectDir: ${JSON.stringify(childDir)}, args: { times: 3 }, maxRepairAttempts: 0, timeout: 20000 });
await ctx.done({ went: run.result.went });
`,
    });
    const nested = await runProgram({ projectDir: join(fakeHome, ".trama", "projects", "parent"), budget: { calls: 10 }, timeout: 30_000 });
    assert.deepEqual(nested.result.went, [0, 1, 2].map((i) => `answer to question ${i}`));

    // A config whose budget is none is refused for what is wrong with it.
    for (const [budget, why] of [
      [{ dollars: 1 }, /^Error: Invalid config: "budget" has no cap "dollars"/],
      [{ cost: "1" }, /^Error: Invalid config: "budget"\.cost must be a number that is not negative \(got "1"\)/],
      [7, /^Error: Invalid config: "budget" is an object of caps/],
    ]) {
      config(budget);
      assert.throws(() => loadConfig(), why);
    }
    config(undefined);
    assert.equal(loadConfig().budget, undefined);
    writeJson(join(fakeHome, ".trama", "config.json"), { budget: null });
    assert.equal(loadConfig().budget, undefined, "null is how JSON says a field is not there");
  });
});

test("what writing a program used is said, and is on record with its validation; and writing and validating are held to the config's budget together", async (t) => {
  const fakeHome = makeTempDir("trama-budget-home-");
  t.after(() => cleanupTempDir(fakeHome));
  const config = (more) => writeJson(join(fakeHome, ".trama", "config.json"), { maxRepairAttempts: 1, ...more });
  const projectDir = join(fakeHome, ".trama", "projects", "made");
  const PROGRAM = `import { ctx, agent } from "@trama-dev/runtime";
await ctx.done({ said: await agent.instruct("a question of the program's") });
`;
  let wrote = PROGRAM;
  standIn(t, {
    ask: async (prompt, call) => {
      if (prompt.startsWith("a question")) { call.used(took(50)); return "an answer"; }
      call.used(took(1234));
      return wrote;
    },
    repair: async () => assert.fail("no fix was to be asked for"),
  });

  await withEnv({ HOME: fakeHome }, async () => {
    config({});
    const made = await captureConsole("log", () => createProject("made", "make it"));
    assert.ok(made.messages.includes("[trama] writing the program used 1234 tokens  $1.2340"), made.messages.join("\n"));
    // The validation's journal has it, before anything the candidate did; and adds it up with the rest.
    const [records] = journalsOf(projectDir);
    assert.deepEqual(records.slice(0, 2).map((record) => [record.kind, record.purpose ?? record.for, record.input]), [["run", "validate", undefined], ["usage", "generate", 1234]]);
    assert.equal(records[0].budget, undefined);
    const shown = (await captureConsole("log", async () => printJournals(projectDir, "made", {}))).messages.join("\n");
    assert.match(shown, /^ +\d+\.\d+s  writing the program used 1234 tokens  \$1\.2340$/m);
    assert.match(shown, /end: done  \(1284 tokens  \$1\.2840 in all\)$/m);

    // An update the same. Under a budget of one call, writing the program is that call: the candidate's own is refused,
    // it fails, no fix is asked for — and the program is as it was.
    config({ budget: { calls: 1 } });
    wrote = PROGRAM.replace("a question of the program's", "a question of the new program's");
    const refused = await captureConsole("warn", () => captureConsole("log", () => updateProject("made", "change it").catch((err) => err)));
    assert.match(refused.result.result.message, /^Update failed — the program is unchanged\.\nProgram failed: Program failed, and no repair was tried\. The budget is spent: 1 of 1 calls to a model made\./);
    assert.ok(refused.result.messages.includes("[trama] writing the program used 1234 tokens  $1.2340"));
    assert.deepEqual(refused.messages, ["[trama] The budget is spent: 1 of 1 calls to a model made."]);
    assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), PROGRAM.trim());
    assert.deepEqual(journalsOf(projectDir)[1][0].budget, { calls: 1 });
    assert.deepEqual(journalsOf(projectDir)[1].filter((record) => record.kind === "budget").map((record) => record.spent), ["The budget is spent: 1 of 1 calls to a model made."]);
    // With room for both, it goes through.
    config({ budget: { calls: 2, cost: 100 } });
    await captureConsole("log", () => updateProject("made", "change it"));
    assert.match(readFileSync(join(projectDir, "program.ts"), "utf-8"), /the new program's/);

    // A backend that says nothing of what a call used has nothing said of it.
    standIn(t, { ask: async (prompt) => (prompt.startsWith("a question") ? "an answer" : wrote) });
    const silent = await captureConsole("log", () => updateProject("made", "change it once more"));
    assert.deepEqual(silent.messages.filter((line) => /used/.test(line)), []);
    assert.deepEqual(journalsOf(projectDir).at(-1).filter((record) => record.kind === "usage"), []);

    // What a model that failed half-way had used is said too, though there is no validation to record it with.
    standIn(t, { ask: async (_prompt, call) => { call.used(took(77)); throw new Error("the model is away"); } });
    const failed = await captureConsole("log", () => updateProject("made", "change it again").catch((err) => err));
    assert.match(failed.result.message, /the model is away/);
    assert.ok(failed.messages.includes("[trama] writing the program used 77 tokens  $0.0770"));
    assert.equal(journalsOf(projectDir).length, 4, "no validation, no journal");
  });

  // A writing that is stopped — by whoever asked for it, or by the budget — says what it took once its backend has let go of it.
  await withEnv({ HOME: fakeHome }, async () => {
    const lateToSay = (prompt, call) => new Promise((_resolve, reject) => {
      const stopped = () => setTimeout(() => { call.used(took(4321)); reject(new Error("stopped")); }, 40);
      call.signal.addEventListener("abort", stopped);
      call.sofar(took(3000));
    });
    standIn(t, { ask: lateToSay });
    config({});
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 30);
    const cancelled = await captureConsole("log", () => updateProject("made", "change it", { signal: stop.signal }).catch((err) => err));
    assert.match(cancelled.result.message, /Aborted/);
    assert.ok(cancelled.messages.includes("[trama] writing the program used 4321 tokens  $4.3210"), cancelled.messages.join("\n"));
    config({ budget: { cost: 2 } });
    const capped = await captureConsole("warn", () => captureConsole("log", () => updateProject("made", "change it").catch((err) => err)));
    assert.match(capped.result.result.message, /The budget is spent: \$3\.0000 used of \$2\./);
    assert.deepEqual(capped.messages, ["[trama] The budget is spent: $3.0000 used of $2."]);
    assert.ok(capped.result.messages.includes("[trama] writing the program used 4321 tokens  $4.3210"));
  });

  // A validation asked for directly says what it is told was used, and no more.
  const { messages } = await captureConsole("log", () => validateProgram(projectDir, createBackend({ provider: "fake", model: "plain" }), `import { ctx } from "@trama-dev/runtime";\nawait ctx.done();\n`, {
    timeout: 20_000, maxRepairAttempts: 0, maxIterations: 10, journalRuns: 20, budget: {}, wrote: [took(5), took(6)],
  }));
  assert.deepEqual(messages.filter((line) => /used/.test(line)), []);
  const last = journalsOf(projectDir).at(-1);
  assert.deepEqual(last.filter((record) => record.kind === "usage").map((record) => [record.for, record.input]), [["generate", 5], ["generate", 6]]);
  assert.deepEqual(last[0].budget, {}, "a budget is written down as it was given: one with no caps says that none was set");
});

test("a participant of a session is given a budget as it is spawned, and has that each time it is run", async (t) => {
  const workerDir = makeTempDir("trama-budget-");
  const session = await Session.createTemp("trama-budget-session-");
  t.after(() => { cleanupTempDir(workerDir); cleanupTempDir(session.workspaceDir); });
  createProjectFixture(workerDir, {
    programSource: `import { ctx, agent } from "@trama-dev/runtime";
const went = [];
for (let i = 0; i < 2; i++) went.push(await agent.instruct("question " + i).then(() => "answered", () => "refused"));
if (!ctx.resumed) { ctx.state.first = went; await ctx.yield("once more"); }
await ctx.done({ first: ctx.state.first, again: went });
`,
  });
  standIn(t, { ask: async (_prompt, call) => { call.used(took(1)); return "an answer"; } });

  const budget = { calls: 1 };
  const handle = session.spawn("worker", { projectDir: workerDir, budget, maxRepairAttempts: 0, timeout: 20_000 });
  // (What becomes of the object after the participant is spawned is not the participant's budget.)
  budget.calls = 100;
  await captureConsole("warn", async () => {
    assert.equal((await handle.wait()).status, "yielded");
    const resumed = await (await handle.resume()).wait();
    assert.deepEqual(resumed.result, { first: ["answered", "refused"], again: ["answered", "refused"] });
  });
  await assert.rejects(() => session.spawn("worker", { projectDir: workerDir, budget: "lots", maxRepairAttempts: 0, timeout: 20_000 }).wait(), /budget is an object of caps/);
  // (What is no plain object is handed on as it is, to be refused for what it is: a copy of it would be a budget of no caps.)
  await assert.rejects(() => session.spawn("worker", { projectDir: workerDir, budget: new Map([["calls", 1]]), maxRepairAttempts: 0, timeout: 20_000 }).wait(), /got an object that is not a plain one/);
});

test("trama run takes a budget from its command line, and holds the run to it", async (t) => {
  const fakeHome = makeTempDir("trama-budget-home-");
  t.after(() => cleanupTempDir(fakeHome));
  createProjectFixture(join(fakeHome, ".trama", "projects", "asker"), { programSource: ASKS });
  writeJson(join(fakeHome, ".trama", "config.json"), { maxRepairAttempts: 0 });
  const cli = (...args) => runNodeCommand([join(REPO_ROOT, "packages", "cli", "dist", "index.js"), "run", "asker", ...args], { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome } });

  // No call may be made: the program's are refused, and it says so itself. (No model is reached: none was to be asked.)
  const none = await cli("--arg", "times=1", "--budget", "calls=0", "--budget", "cost=2.50");
  assert.equal(none.exitCode, 0, none.stderr);
  assert.match(none.stderr, /\[trama\] The budget is spent: 0 of 0 calls to a model made\./);
  const [records] = journalsOf(join(fakeHome, ".trama", "projects", "asker"));
  assert.deepEqual(records[0].budget, { calls: 0, cost: 2.5 });
  assert.deepEqual(readJson(join(fakeHome, ".trama", "projects", "asker", "state.json")).__trama_done ?? null, null);

  // Without the option the run has the config's budget, as any run given none of its own.
  writeJson(join(fakeHome, ".trama", "config.json"), { maxRepairAttempts: 0, budget: { calls: 0 } });
  const byConfig = await cli("--arg", "times=1");
  assert.equal(byConfig.exitCode, 0, byConfig.stderr);
  assert.match(byConfig.stderr, /\[trama\] The budget is spent: 0 of 0 calls to a model made\./);
  assert.deepEqual(journalsOf(join(fakeHome, ".trama", "projects", "asker")).at(-1)[0].budget, { calls: 0 });

  for (const [bad, why] of [
    ["calls", /Invalid --budget format: "calls"\. Expected cap=number/],
    ["5", /Invalid --budget format: "5"\. Expected cap=number/],
    ["calls=", /Invalid --budget format: "calls="/],
    ["calls=many", /Invalid --budget format: "calls=many"/],
    ["dollars=2", /budget has no cap "dollars"/],
    ["__proto__=5", /budget has no cap "__proto__"/],
    ["constructor=5", /budget has no cap "constructor"/],
    ["cost=-1", /budget\.cost must be a number that is not negative/],
    ["calls=1.5", /budget\.calls must be a whole number/],
  ]) {
    const refused = await cli("--budget", bad);
    assert.equal(refused.exitCode, 1, bad);
    assert.match(refused.stderr, why, bad);
  }
  const twice = await cli("--budget", "cost=1", "--budget", "calls=3", "--budget", "cost=2");
  assert.equal(twice.exitCode, 1);
  assert.match(twice.stderr, /--budget cost is given twice\./);
});

test("a call's choice of skills, templates and extensions crosses the bridge as it was made, and what is no choice is refused there", async (t) => {
  const projectDir = makeTempDir("trama-harness-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    programSource: `import { ctx, agent } from "@trama-dev/runtime";
const told = (err: any) => String(err.message);
const went = [];
went.push(await agent.instruct("first", { skills: true, templates: ["review"], extensions: true }));
went.push(await agent.generate({ prompt: "second", schema: { a: "string" }, skills: ["pdf", "tables"], extensions: false }));
went.push(await agent.instruct("third", { skills: [], templates: true }));
went.push(await agent.instruct("fourth"));
for (const bad of [{ skills: "all" }, { skills: [1] }, { templates: 1 }, { templates: { review: true } }, { extensions: "yes" }, { extensions: ["mcp"] }, { extensions: 1 }, { skill: true }]) {
  went.push(await agent.instruct("refused", bad as any).catch(told));
}
went.push(await agent.generate({ prompt: "refused", schema: { a: "string" }, skills: 0 } as any).catch(told));
// A typed answer's prompt is not read as a template: what says how to answer follows it.
went.push(await agent.generate({ prompt: "/review refused", schema: { a: "string" }, templates: true } as any).catch(told));
await ctx.done({ went });
`,
  });
  const asked = [];
  standIn(t, {
    ask: async (prompt, { cwd, signal, used, sofar, system, ...call }) => {
      asked.push({ prompt: prompt.split("\n")[0], ...call });
      return prompt.startsWith("second") ? '{"a":"x"}' : `answer to ${prompt}`;
    },
  });

  const { result } = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 20_000 });
  assert.deepEqual(asked, [
    { prompt: "first", skills: true, templates: ["review"], extensions: true },
    // (A typed answer's prompt is text, whatever it begins with: the backend is told so where it might read it otherwise.)
    { prompt: "second", skills: ["pdf", "tables"], extensions: false, asText: true },
    { prompt: "third", skills: [], templates: true },
    { prompt: "fourth" },
  ]);
  assert.deepEqual(result.went, [
    "answer to first", { a: "x" }, "answer to third", "answer to fourth",
    "trama runtime error: Invalid field: skills (expected boolean or strings or undefined)",
    "trama runtime error: Invalid field: skills (expected boolean or strings or undefined)",
    "trama runtime error: Invalid field: templates (expected boolean or strings or undefined)",
    "trama runtime error: Invalid field: templates (expected boolean or strings or undefined)",
    "trama runtime error: Invalid field: extensions (expected boolean or undefined)",
    "trama runtime error: Invalid field: extensions (expected boolean or undefined)",
    "trama runtime error: Invalid field: extensions (expected boolean or undefined)",
    "trama runtime error: Unknown field: skill (this call takes: prompt, system, model, thinking, tools, skills, extensions, cutOff, templates)",
    "trama runtime error: Invalid field: skills (expected boolean or strings or undefined)",
    "trama runtime error: Unknown field: templates (this call takes: prompt, schema, system, model, thinking, tools, skills, extensions, cutOff)",
  ]);
  // The journal has a call as it was made.
  const [records] = journalsOf(projectDir);
  assert.deepEqual(records.find((record) => record.kind === "call" && record.seq === 1).request, { prompt: "first", skills: true, templates: ["review"], extensions: true });
});

test("what a call that was cut off used is counted before its run is over, recorded or not — where a budget holds it to anything", async (t) => {
  const fakeHome = makeTempDir("trama-budget-home-");
  const childDir = makeTempDir("trama-budget-");
  t.after(() => { cleanupTempDir(fakeHome); cleanupTempDir(childDir); });
  // (Nothing is recorded: a run then waits for its backend only for the count's sake.)
  writeJson(join(fakeHome, ".trama", "config.json"), { maxRepairAttempts: 0, journalRuns: 0 });
  const parentDir = join(fakeHome, ".trama", "projects", "parent");
  createProjectFixture(childDir, { programSource: `import { agent } from "@trama-dev/runtime";\nawait agent.instruct("slow");\n` });
  createProjectFixture(parentDir, {
    programSource: `import { ctx, agent } from "@trama-dev/runtime";
import { runProgram } from "@trama-dev/runtime/runner";
import { existsSync } from "node:fs";
const stop = new AbortController();
const child = runProgram({ projectDir: ${JSON.stringify(childDir)}, signal: stop.signal, maxRepairAttempts: 0, timeout: 20000 });
while (!existsSync("child-is-asking")) await new Promise((resolve) => setTimeout(resolve, 20));
stop.abort();
await child;
await ctx.done({ after: await agent.instruct("after").catch((err) => String(err.message)) });
`,
  });
  const { writeFileSync } = await import("fs");
  standIn(t, {
    ask: (prompt, call) => new Promise((resolve, reject) => {
      if (prompt === "after") return resolve("answered");
      // The child's call: once it is cancelled, its backend takes a while to let go, and says then what it used.
      call.signal.addEventListener("abort", () => setTimeout(() => { call.used(took(5000)); reject(new Error("stopped")); }, 150));
      writeFileSync(join(parentDir, "child-is-asking"), "");
    }),
  });

  await withEnv({ HOME: fakeHome }, async () => {
    const { result } = await captureConsole("warn", () => runProgram({ projectDir: parentDir, budget: { cost: 1 }, timeout: 30_000 }));
    assert.deepEqual(result.result, { after: "trama runtime error: Error: The budget is spent: $5.0000 used of $1." });
    // Where nothing holds the count to anything, a run that is not recorded goes on without waiting, as it always did.
    const { rmSync } = await import("fs");
    rmSync(join(parentDir, "child-is-asking"));
    const free = await runProgram({ projectDir: parentDir, timeout: 30_000 });
    assert.deepEqual(free.result, { after: "answered" });
  });
});

test("a run in which a call was stopped for the budget has that on record, though its backend then said the call used less", async (t) => {
  const projectDir = makeTempDir("trama-budget-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { programSource: ASKS });
  standIn(t, {
    ask: (_prompt, call) => new Promise((_resolve, reject) => {
      call.signal.addEventListener("abort", () => { call.used(took(200)); reject(new Error("stopped")); });
      call.sofar(took(1500));
    }),
  });
  const { messages, result } = await captureConsole("warn", () => runProgram({ projectDir, args: { times: 1 }, budget: { cost: 1 }, maxRepairAttempts: 0, timeout: 20_000 }));
  assert.deepEqual(result.result.went, ["trama runtime error: Error: The budget is spent: $1.5000 used of $1."]);
  assert.deepEqual(messages, ["[trama] The budget is spent: $1.5000 used of $1."]);
  assert.deepEqual(journalsOf(projectDir)[0].filter((record) => record.kind === "budget").map((record) => record.spent), ["The budget is spent: $1.5000 used of $1."]);
});
