import assert from "node:assert/strict";
import test, { after } from "node:test";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { createServer } from "http";
import { llm } from "./fake-llm.mjs";
import { replayProgram, runProgram, validateProgram } from "../packages/runtime/dist/runner.js";
import { createBackend } from "../packages/runtime/dist/runner-backend.js";
import { REPO_ROOT, cleanupTempDir, createProjectFixture, makeTempDir, runNodeCommand } from "./helpers.mjs";

// A replay: a project's program run again with its calls answered from the record of an earlier run, and none of
// them carried out. Nothing is asked of a model, nothing is written to the project, nothing is spent: what comes of
// it is how far the program went the way it had gone, and where it left the record.
//
// (The model is a stand-in that exists while a run is recorded and at no other time: a replay that asked it
// anything would be answered "the test did not expect a request to the model", and would not go as recorded.)

const defaultsHome = makeTempDir("trama-replay-defaults-");
const realHome = process.env.HOME;
process.env.HOME = defaultsHome;
after(() => {
  process.env.HOME = realHome;
  cleanupTempDir(defaultsHome);
});

const reply = (content, stopReason = "stop") => ({
  role: "assistant", content, api: "an-api", provider: "p", model: "m", stopReason, timestamp: 7,
  usage: { input: 400, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 400, cost: { input: 0.4, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.4 } },
});
const says = (text) => reply([{ type: "text", text }]);
const lastSaid = (request) => { const { content } = request.context.messages.at(-1); return typeof content === "string" ? content : JSON.stringify(content); };

const project = (t, programSource) => {
  const projectDir = makeTempDir("trama-replay-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { programSource });
  return projectDir;
};
/** Run a project with the model stood in for, so that the run is on record — and with no model once it is. */
async function recorded(projectDir, stubs = {}, more = {}) {
  const original = { ...llm };
  Object.assign(llm, stubs);
  try {
    return await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 20_000, ...more });
  } finally {
    Object.assign(llm, original);
  }
}
const replay = (projectDir, more = {}) => replayProgram({ projectDir, ...more });
const journalDir = (projectDir) => join(projectDir, "logs", "journal");
const runsOf = (projectDir) => readdirSync(journalDir(projectDir)).sort().map((file) => file.replace(/\.jsonl$/, ""));
const recordsOf = (projectDir, run = runsOf(projectDir).at(-1)) =>
  readFileSync(join(journalDir(projectDir), `${run}.jsonl`), "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const rewrite = (projectDir, run, change) =>
  writeFileSync(join(journalDir(projectDir), `${run}.jsonl`), change(recordsOf(projectDir, run)).map((record) => JSON.stringify(record)).join("\n") + "\n");
/** All that a project holds, but what its runtime is linked in by: each file by its path, with what is in it. */
function held(dir, under = "") {
  return readdirSync(join(dir, under)).sort().flatMap((name) => {
    const path = join(under, name);
    if (name === "node_modules") return [];
    return statSync(join(dir, path)).isDirectory() ? held(dir, path) : [[path, readFileSync(join(dir, path), "utf-8")]];
  });
}

const WORKS = `import { ctx, agent, tools } from "@trama-dev/runtime";
const messages: any[] = [{ role: "user", content: "Count." }];
const first = await agent.complete({ messages });
const ran = await tools.shell("echo ran >> ran.txt; echo out");
await tools.write("made.txt", "made by the program");
const read = await tools.read("made.txt");
let missing = "";
try { await tools.read("no-such.txt"); } catch (err: any) { missing = String(err.message); }
const failed = await tools.shell("echo no >&2; exit 3");
messages.push(first, { role: "user", content: ran.stdout + read });
const second: any = await agent.complete({ messages });
await ctx.log("nearly done");
await ctx.done({ said: second.content[0].text, ran: ran.stdout, read, missing, failed });
`;
const model = { complete: async (request) => says(`said to: ${lastSaid(request)}`) };

test("a run is replayed from its record: every call answered as it was and none carried out — nothing asked of a model, nothing written, the project as it was", async (t) => {
  const projectDir = project(t, WORKS);
  const first = await recorded(projectDir, model);
  const done = { said: "said to: out\nmade by the program", ran: "out\n", read: "made by the program", missing: "trama runtime error: Error: File not found: no-such.txt", failed: { exitCode: 3, stdout: "", stderr: "no\n" } };
  assert.deepEqual(first, { status: "done", result: done });
  assert.equal(readFileSync(join(projectDir, "ran.txt"), "utf-8"), "ran\n");

  // The project as it was before the run, as far as the run's own work goes: what it made is taken away again.
  rmSync(join(projectDir, "ran.txt"));
  rmSync(join(projectDir, "made.txt"));
  const before = held(projectDir), [run] = runsOf(projectDir);

  assert.deepEqual(await replay(projectDir), {
    run, attempt: 0, sameProgram: true,
    // (Seven calls of the program's to the world: what it says to its own run — a line logged, its end — is no part of them.)
    recorded: 7, answered: 7, unasked: 0, other: [],
    result: { status: "done", result: done }, recordedResult: { status: "done", result: done },
    sameEnd: true, same: true,
  });
  // Nothing was carried out — no command ran, no file was written — and nothing of the project is other than it
  // was: its state, its log, its journals (a replay is not a run of the project's, and leaves no journal).
  assert.deepEqual(held(projectDir), before);
  assert.deepEqual(runsOf(projectDir), [run]);

  // The run to answer from is the latest that is one: a validation since is not.
  await recorded(projectDir, model);
  const [, second] = runsOf(projectDir);
  const original = { ...llm };
  Object.assign(llm, model);
  try {
    await validateProgram(projectDir, createBackend({ provider: "fake", model: "plain" }), WORKS, { timeout: 20_000, maxRepairAttempts: 0, maxIterations: 10, journalRuns: 20 });
  } finally {
    Object.assign(llm, original);
  }
  assert.equal(runsOf(projectDir).length, 3);
  assert.equal((await replay(projectDir)).run, second);
  // ...or the one that is named.
  assert.equal((await replay(projectDir, { run })).run, run);
  await assert.rejects(replay(projectDir, { run: "2020-01-01T00-00-00-000Z-aaaaaa" }), /No journal for run "2020-01-01T00-00-00-000Z-aaaaaa"/);
  const fresh = project(t, WORKS);
  await assert.rejects(replay(fresh), /No run of the project is on record/);
});

test("a program that was changed is answered as far as it asks what was asked: where it first asks otherwise it has left the record, and the replay ends there, saying where", async (t) => {
  const projectDir = project(t, WORKS);
  await recorded(projectDir, model);
  const before = held(projectDir);
  const tried = (program, more = {}) => replay(projectDir, { program, ...more });

  // Another command: the first call is answered, and the second is where it leaves. The program is stopped there.
  const other = await tried(WORKS.replace("echo ran >> ran.txt; echo out", "echo other >> ran.txt; echo out"));
  assert.deepEqual({ ...other, left: { ...other.left, why: "" } }, {
    run: other.run, attempt: 0, sameProgram: false, recorded: 7, answered: 1, unasked: 6, other: [],
    left: { call: 2, endpoint: "/tools/shell", why: "" }, recordedResult: other.recordedResult, sameEnd: false, same: false,
  });
  assert.equal(other.left.why, `/command at character 5: asked "echo other >> ran.txt; echo out" | recorded "echo ran >> ran.txt; echo out"`);
  // (What is tried is given to the replay: the project's own program is as it was, and nothing of it has run.)
  assert.deepEqual(held(projectDir), before);

  // The same, a call answered wherever its kind is the recorded one, whatever it asks: it gets through what was
  // answered — which is another thing to know of it — and each call that asked otherwise is said.
  const loose = await tried(WORKS.replace("echo ran >> ran.txt; echo out", "echo other >> ran.txt; echo out"), { loose: true });
  // (It ended as recorded, and yet did not go as recorded: it asked otherwise on the way.)
  assert.deepEqual([loose.answered, loose.unasked, loose.left, loose.result.status, loose.sameEnd, loose.same], [7, 0, undefined, "done", true, false]);
  assert.deepEqual(loose.other.map(({ call, endpoint }) => [call, endpoint]), [[2, "/tools/shell"]]);
  assert.match(loose.other[0].difference, /^\/command at character 5: asked "echo other/);

  // A call of another kind is off the record by either rule.
  for (const how of [{}, { loose: true }]) {
    const kind = await tried(WORKS.replace(`await tools.write("made.txt", "made by the program");`, `await tools.read("ran.txt");`), how);
    assert.deepEqual([kind.answered, kind.left], [2, { call: 3, endpoint: "/tools/read", why: "another call: asked /tools/read | recorded /tools/write" }]);
  }
  // One call more than the record has: it leaves where the record ends.
  const beyond = await tried(WORKS.replace(`await ctx.log("nearly done");`, `await tools.read("made.txt");`));
  assert.deepEqual([beyond.answered, beyond.unasked, beyond.left], [7, 0, { call: 8, endpoint: "/tools/read", why: "the record has no more calls" }]);
  // One call fewer, at the end: it goes its own whole way, which is not the record's.
  const short = await tried(WORKS.replace("const second: any = await agent.complete({ messages });", "const second: any = first;"));
  assert.deepEqual([short.answered, short.unasked, short.left, short.result.status, short.same], [6, 1, undefined, "done", false]);

  // What a program says to its own run is no call to the world: a line more in its log, or none, changes nothing...
  const quiet = await tried(WORKS.replace(`await ctx.log("nearly done");`, `await ctx.log("one"); await ctx.log("two");`));
  assert.deepEqual([quiet.answered, quiet.sameProgram, quiet.same], [7, false, true]);
  // ...and its end is carried out, to be held against the recorded end: the whole way, to another end.
  const ended = await tried(WORKS.replace("said: second.content[0].text,", "said: 'something else',"));
  assert.deepEqual([ended.answered, ended.unasked, ended.left, ended.same], [7, 0, undefined, false]);
  assert.deepEqual([ended.result.result.said, ended.recordedResult.result.said], ["something else", "said to: out\nmade by the program"]);
  // A program that fails where the recorded one did not: that is its end.
  const fails = await tried(WORKS.replace(`await ctx.log("nearly done");`, `throw new Error("it breaks here");`));
  assert.deepEqual([fails.answered, fails.result.status, fails.sameEnd, fails.same], [7, "failed", false, false]);
  assert.match(fails.result.reason, /it breaks here/);
});

test("nothing of a replayed run is carried out, wherever it had its effect: no command runs again, no request is sent again — and a request is known for the recorded one though its secrets are not on record", async (t) => {
  const outside = makeTempDir("trama-replay-outside-");
  t.after(() => cleanupTempDir(outside));
  const marker = join(outside, "ran.txt");
  let hits = 0;
  const server = createServer((req, res) => { hits += 1; res.end(`hit ${hits}, ${req.headers.authorization === "Bearer s3cret" ? "let in" : "kept out"}`); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;
  const projectDir = project(t, `import { ctx, tools } from "@trama-dev/runtime";
const { marker, url } = ctx.input.args as any;
const ran = await tools.shell("echo ran >> " + JSON.stringify(marker) + "; sleep 3; echo slept");
const got = await tools.fetch(url, { headers: { Authorization: "Bearer s3cret" } });
await ctx.done({ ran: ran.stdout, got: got.body });
`);
  const first = await recorded(projectDir, {}, { args: { marker, url } });
  assert.deepEqual(first, { status: "done", result: { ran: "slept\n", got: "hit 1, let in" } });
  assert.doesNotMatch(readFileSync(join(journalDir(projectDir), `${runsOf(projectDir)[0]}.jsonl`), "utf-8"), /s3cret/);

  // (With what the run was started with, which is on record: nothing is given to the replay.)
  const began = Date.now(), again = await replay(projectDir);
  assert.deepEqual([again.answered, again.left, again.result, again.same], [2, undefined, first, true]);
  assert.equal(readFileSync(marker, "utf-8"), "ran\n", "the command ran once: when the run was recorded");
  assert.equal(hits, 1, "the request was sent once");
  assert.ok(Date.now() - began < 2500, "and no time was waited that the command had taken");
});

test("a run that failed is replayed to its failure: that is its end, and the same one — in whatever words", async (t) => {
  const FAILS = `import { ctx, tools } from "@trama-dev/runtime";\nconst ran = await tools.shell("echo out");\nthrow new Error("it fails after " + ran.stdout.trim() + ", in " + process.cwd());\n`;
  const projectDir = project(t, FAILS);
  const first = await recorded(projectDir);
  assert.equal(first.status, "failed");
  const again = await replay(projectDir);
  assert.deepEqual([again.answered, again.left, again.result.status, again.recordedResult.status, again.sameEnd, again.same], [1, undefined, "failed", "failed", true, true]);
  assert.match(again.result.reason, /it fails after out, in /);
  assert.notEqual(again.result.reason, again.recordedResult.reason, "it failed in a copy: the words tell of where");
  // One that no longer fails has another end.
  const mended = await replay(projectDir, { program: FAILS.replace(/throw new Error\(.*\);/, "await ctx.done({});") });
  assert.deepEqual([mended.answered, mended.result.status, mended.sameEnd, mended.same], [1, "done", false, false]);

  // A program that comes to the recorded end without making every recorded call did not go as recorded.
  const SPARE = `import { ctx, tools } from "@trama-dev/runtime";\nconst ran = await tools.shell("echo out");\nawait tools.shell("echo spare");\nawait ctx.done({ ran: ran.stdout });\n`;
  const spare = project(t, SPARE);
  assert.equal((await recorded(spare)).status, "done");
  const fewer = await replay(spare, { program: SPARE.replace(`await tools.shell("echo spare");\n`, "") });
  assert.deepEqual([fewer.recorded, fewer.answered, fewer.unasked, fewer.left, fewer.sameEnd, fewer.same], [2, 1, 1, undefined, true, false]);
});

test("a run the program asked for is answered from the record and not started; and what a program asks by the place it is in is known for what it asked, though a replay runs it in a copy", async (t) => {
  const base = makeTempDir("trama-replay-session-");
  t.after(() => cleanupTempDir(base));
  const main = join(base, "main"), other = join(base, "other");
  createProjectFixture(other, { programSource: `import { ctx, tools } from "@trama-dev/runtime";\nawait tools.shell("echo ran >> ran.txt");\nawait ctx.done({ doubled: Number(ctx.input.args.n) * 2 });\n` });
  const MAIN = `import { ctx, tools } from "@trama-dev/runtime";
import { runProgram } from "@trama-dev/runtime/runner";
const here = await tools.shell("echo in " + JSON.stringify(process.cwd()));
const child = await runProgram({ projectDir: "../other", args: { n: 2 }, maxRepairAttempts: 0 });
await ctx.done({ here: here.stdout, child });
`;
  createProjectFixture(main, { programSource: MAIN });
  const first = await recorded(main);
  assert.deepEqual([first.status, first.result.child], ["done", { status: "done", result: { doubled: 4 } }]);
  assert.match(first.result.here, /^in .*\/main\n$/);

  // (Each call of such a run is named anew by the program's client, so that it can be stopped: no part of what was asked.)
  const again = await replay(main);
  assert.deepEqual([again.recorded, again.answered, again.left, again.result, again.same], [2, 2, undefined, first, true]);
  assert.equal(readFileSync(join(other, "ran.txt"), "utf-8"), "ran\n", "the other program ran once: when the run was recorded");
  assert.equal(runsOf(other).length, 1);

  // A run the program stopped: its word to stop it is said of that call, and is no call of its own — in a replay
  // the run is answered at once, as stopped, and there is nothing in flight to stop.
  const slow = join(base, "slow"), stops = join(base, "stops");
  createProjectFixture(slow, { programSource: `import { ctx, tools } from "@trama-dev/runtime";\nawait tools.shell("sleep 20");\nawait ctx.done({});\n` });
  createProjectFixture(stops, { programSource: `import { ctx, tools } from "@trama-dev/runtime";
import { runProgram } from "@trama-dev/runtime/runner";
const stop = new AbortController();
setTimeout(() => stop.abort(), 600);
const child = await runProgram({ projectDir: "../slow", maxRepairAttempts: 0, signal: stop.signal });
const after = await tools.shell("echo after");
await ctx.done({ child: child.status, after: after.stdout });
` });
  const stopped = await recorded(stops);
  assert.deepEqual(stopped, { status: "done", result: { child: "failed", after: "after\n" } });
  assert.deepEqual(recordsOf(stops).filter((record) => record.kind === "call").map((record) => record.endpoint), ["/run/program", "/run/stop", "/tools/shell", "/ctx/done"]);
  const once = await replay(stops);
  assert.deepEqual([once.recorded, once.answered, once.left, once.result, once.same], [2, 2, undefined, stopped, true]);

  // Another project asked for is another call.
  const elsewhere = await replay(main, { program: MAIN.replace(`"../other"`, `"../another"`) });
  assert.deepEqual([elsewhere.answered, elsewhere.left.call, elsewhere.left.endpoint], [1, 2, "/run/program"]);
  assert.match(elsewhere.left.why, /^\/projectDir at character \d+: asked ".*\/another" \| recorded ".*\/other"$/);
  assert.doesNotMatch(elsewhere.left.why, /trama-replay-[A-Za-z0-9]{6}\//, "said by the project's place, not by the copy's");
});

const COUNTS = `import { ctx, agent } from "@trama-dev/runtime";
let counted = 0;
const answer = await agent.instruct("count twice", { tools: [{
  name: "count", description: "Counts once more", parameters: { by: "number" },
  run: ({ by }: any) => { counted += by; return "it is " + counted; },
}] });
await ctx.done({ answer, counted });
`;

test("an agent call that had tools of the program's own is replayed with them: the program is asked again what it was asked, and where a tool answers otherwise that is the program leaving its record", async (t) => {
  const projectDir = project(t, COUNTS);
  const asked = [];
  const first = await recorded(projectDir, { ask: async (_prompt, call) => {
    const [count] = call.ownTools;
    asked.push(await count.run({ by: 2 }, "c1", call.signal), await count.run({ by: 3 }, "c2", call.signal));
    return "counted to five";
  } });
  assert.deepEqual([first.result, asked.map((answer) => answer.text)], [{ answer: "counted to five", counted: 5 }, ["it is 2", "it is 5"]]);

  // What the tools did in the program is done again — it counted — though no agent is at work.
  const again = await replay(projectDir);
  assert.deepEqual([again.recorded, again.answered, again.result, again.same], [1, 1, { status: "done", result: { answer: "counted to five", counted: 5 } }, true]);

  // A tool that answers otherwise than it did.
  const other = await replay(projectDir, { program: COUNTS.replace(`return "it is " + counted;`, `return "now " + counted;`) });
  assert.deepEqual([other.answered, other.left.call, other.left.endpoint, other.result], [0, 1, "/agent/instruct", undefined]);
  assert.equal(other.left.why, `its tool "count" answered otherwise: "now 2" | recorded "it is 2"`);
  // A tool that fails where it had answered.
  const failing = await replay(projectDir, { program: COUNTS.replace(`return "it is " + counted;`, `if (counted > 2) throw new Error("too many"); return "it is " + counted;`) });
  assert.equal(failing.left.why, `its tool "count" answered otherwise: failed, "too many" | recorded "it is 5"`);
  // A tool the program no longer has: the call is another call, by what it declares...
  const gone = await replay(projectDir, { program: COUNTS.replace(`name: "count"`, `name: "tally"`) });
  assert.deepEqual([gone.answered, gone.left.call], [0, 1]);
  assert.match(gone.left.why, /^\/tools\/0\/name/);
  // ...and where that is let pass, there is still nobody to ask what was asked.
  const passed = await replay(projectDir, { program: COUNTS.replace(`name: "count"`, `name: "tally"`), loose: true });
  assert.deepEqual([passed.answered, passed.left], [0, { call: 1, endpoint: "/agent/instruct", why: `the record has its tool "count" asked, and the call has no such tool of the program's now` }]);

  // A tool that fails in the very words it had answered in has not answered the same.
  const PLAIN = COUNTS.replace(`return "it is " + counted;`, `return "no";`);
  const plain = project(t, PLAIN);
  await recorded(plain, { ask: async (_prompt, call) => { await call.ownTools[0].run({ by: 1 }, "c1", call.signal); return "asked"; } });
  assert.equal((await replay(plain)).same, true);
  const throws = await replay(plain, { program: PLAIN.replace(`return "no";`, `throw new Error("no");`) });
  assert.equal(throws.left.why, `its tool "count" answered otherwise: failed, "no" | recorded "no"`);

  // The same of a call that is answered in a shape.
  const SHAPED = `import { ctx, agent } from "@trama-dev/runtime";
let counted = 0;
const answer = await agent.generate({ prompt: "count once", schema: { total: "number" }, tools: [{
  name: "count", description: "Counts once more", parameters: { by: "number" },
  run: ({ by }: any) => { counted += by; return "it is " + counted; },
}] });
await ctx.done({ answer, counted });
`;
  const shaped = project(t, SHAPED);
  const made = await recorded(shaped, { ask: async (_prompt, call) => {
    await call.ownTools[0].run({ by: 4 }, "c1", call.signal);
    return JSON.stringify({ total: 4 });
  } });
  assert.deepEqual(made, { status: "done", result: { answer: { total: 4 }, counted: 4 } });
  const shapedAgain = await replay(shaped);
  assert.deepEqual([shapedAgain.answered, shapedAgain.result, shapedAgain.same], [1, made, true]);
});

const KEEPS = `import { ctx, agent } from "@trama-dev/runtime";
ctx.state.n = (Number(ctx.state.n) || 0) + 1;
const said: any = await agent.complete({ messages: [{ role: "user", content: "It is run " + ctx.state.n }] });
await ctx.done({ n: ctx.state.n, said: said.content[0].text });
`;

test("a run begins from the state it began from: that is on record with it, and a replay begins there — whatever the project's state has come to since", async (t) => {
  const projectDir = project(t, KEEPS);
  for (const n of [1, 2, 3]) assert.deepEqual((await recorded(projectDir, model)).result, { n, said: `said to: It is run ${n}` });
  const [one, two, three] = runsOf(projectDir);
  const beganWith = (run) => recordsOf(projectDir, run).find((record) => record.kind === "attempt").state;
  assert.deepEqual([one, two, three].map(beganWith), [{}, { n: 1, __trama_iteration: 1 }, { n: 2, __trama_iteration: 2 }]);

  const before = held(projectDir);
  for (const [run, n] of [[one, 1], [two, 2], [three, 3]]) {
    const again = await replay(projectDir, { run });
    assert.deepEqual([again.answered, again.result, again.same], [1, { status: "done", result: { n, said: `said to: It is run ${n}` } }, true], run);
  }
  assert.deepEqual(held(projectDir), before);
  assert.equal(JSON.parse(readFileSync(join(projectDir, "state.json"), "utf-8")).n, 3);

  // A record made before the state was kept with it: of a run that began with none, that is known all the same...
  const without = (records) => records.map(({ state: _state, ...record }) => record);
  rewrite(projectDir, one, without);
  assert.equal((await replay(projectDir, { run: one })).same, true);
  // ...and of any other it is not, and nothing is replayed from a state made up.
  rewrite(projectDir, two, without);
  await assert.rejects(replay(projectDir, { run: two }), /The record of run \S+ does not say what state it began from \(it was made before that was kept\)/);
});

test("calls that were in flight together are answered in whatever order they are made again; calls that followed one another are not", async (t) => {
  const TOGETHER = `import { ctx, agent, tools } from "@trama-dev/runtime";
const [slow, quick] = await Promise.all([tools.shell("sleep 0.3; echo slow"), tools.shell("echo quick"), tools.read("program.ts")]);
const said: any = await agent.complete({ messages: [{ role: "user", content: slow.stdout + quick.stdout }] });
const then = await tools.shell("echo then");
await ctx.done({ said: said.content[0].text, then: then.stdout });
`;
  const projectDir = project(t, TOGETHER);
  await recorded(projectDir, model);
  const [run] = runsOf(projectDir);
  const calls = recordsOf(projectDir).filter((record) => record.kind === "call").map((record) => record.endpoint);
  assert.deepEqual([...calls.slice(0, 3)].sort(), ["/tools/read", "/tools/shell", "/tools/shell"]);
  // As recorded — and with the three written down in the opposite order of arrival, as they may as well have come.
  for (let time = 0; time < 3; time += 1) { const again = await replay(projectDir); assert.deepEqual([again.answered, again.left, again.same], [5, undefined, true]); }
  rewrite(projectDir, run, (records) => {
    const at = records.map((record, n) => (record.kind === "call" ? n : -1)).filter((n) => n >= 0).slice(0, 3);
    const [a, , c] = at.map((n) => records[n]);
    records[at[0]] = c; records[at[2]] = a;
    return records;
  });
  for (let time = 0; time < 3; time += 1) { const again = await replay(projectDir); assert.deepEqual([again.answered, again.left, again.same], [5, undefined, true]); }

  // One after the other is an order: made the other way round, the first is already off the record.
  const turned = await replay(projectDir, { program: TOGETHER.replace(`const then = await tools.shell("echo then");`, "").replace("const [slow, quick]", `const then = await tools.shell("echo then");\nconst [slow, quick]`) });
  assert.deepEqual([turned.answered, turned.left.call, turned.left.endpoint], [0, 1, "/tools/shell"]);
});

test("a record answers only what it has whole: a call that was never answered, or whose record was too large to keep whole, is where a replay ends", async (t) => {
  // A call in flight when the run's time was up: asked, and never answered.
  const waits = project(t, `import { ctx, tools } from "@trama-dev/runtime";
const quick = await tools.shell("echo quick");
await tools.shell("sleep 30", { timeout: 60000 });
await ctx.done({ quick: quick.stdout });
`);
  assert.equal((await recorded(waits, {}, { timeout: 1500 })).status, "failed");
  const cut = await replay(waits);
  assert.deepEqual([cut.answered, cut.left, cut.result], [1, { call: 2, endpoint: "/tools/shell", why: "the record has no answer for it: the run ended before it was answered" }, undefined]);

  // What was written was more than a record keeps of a text.
  const large = project(t, `import { ctx, tools } from "@trama-dev/runtime";
await tools.write("large.txt", "x".repeat(300_000));
await ctx.done({});
`);
  assert.equal((await recorded(large)).status, "done");
  const big = await replay(large);
  assert.deepEqual([big.answered, big.left], [0, { call: 1, endpoint: "/tools/write", why: "the record does not have it whole: it was too large to keep" }]);

  // An end that was too large to keep whole is no end to hold another against: the record does not say how it ended.
  const ends = project(t, `import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ much: "x".repeat(300_000) });\n`);
  assert.equal((await recorded(ends)).status, "done");
  const ended = await replay(ends);
  assert.deepEqual([ended.recorded, ended.left, ended.result.status, ended.recordedResult, ended.sameEnd, ended.same], [0, undefined, "done", undefined, false, false]);
});

test("a run that was repaired is replayed by its last attempt: the program that came of it", async (t) => {
  const BROKEN = `import { ctx, agent } from "@trama-dev/runtime";\nconst said: any = await agent.complete({ messages: [{ role: "user", content: "first" }] });\nthrow new Error("broken after " + said.content[0].text);\n`;
  const FIXED = `import { ctx, agent, tools } from "@trama-dev/runtime";\nconst said: any = await agent.complete({ messages: [{ role: "user", content: "mended" }] });\nconst ran = await tools.shell("echo ran in " + JSON.stringify(process.cwd()));\nawait ctx.done({ said: said.content[0].text, ran: ran.stdout });\n`;
  const projectDir = project(t, BROKEN);
  const first = await recorded(projectDir, { ...model, repair: async () => FIXED }, { maxRepairAttempts: 1 });
  assert.deepEqual([first.status, first.result.said], ["done", "said to: mended"]);
  // (The fix was tried, and so recorded, in a copy of the project: what it asked by its own place has that place in it.)
  const attempts = recordsOf(projectDir).filter((record) => record.kind === "attempt");
  assert.deepEqual(attempts.map((record) => record.attempt), [0, 1]);
  assert.notEqual(attempts[1].dir, attempts[0].dir);
  assert.equal(first.result.ran, `ran in ${attempts[1].dir}\n`);

  const again = await replay(projectDir);
  assert.deepEqual([again.attempt, again.sameProgram, again.recorded, again.answered, again.result, again.same], [1, true, 2, 2, first, true]);
  // The program as it was before the fix leaves that record at once: it asks what the first attempt asked.
  const before = await replay(projectDir, { program: BROKEN });
  assert.deepEqual([before.attempt, before.answered, before.left.call, before.left.endpoint], [1, 0, 1, "/agent/complete"]);
});

test("trama replay says how a replay went, and ends as it went: the whole way to the recorded end, or not", async (t) => {
  const CLI_ENTRY = join(REPO_ROOT, "packages", "cli", "dist", "index.js");
  const fakeHome = makeTempDir("trama-replay-home-");
  t.after(() => cleanupTempDir(fakeHome));
  const projectDir = join(fakeHome, ".trama", "projects", "demo");
  const DEMO = `import { ctx, tools } from "@trama-dev/runtime";\nconst ran = await tools.shell("echo ran >> ran.txt; echo out");\nawait tools.write("made.txt", "v1");\nawait ctx.done({ out: ran.stdout });\n`;
  createProjectFixture(projectDir, { programSource: DEMO });
  const trama = (...args) => runNodeCommand([CLI_ENTRY, ...args], { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome } });
  assert.equal((await trama("run", "demo")).exitCode, 0);
  const [run] = runsOf(projectDir);

  const same = await trama("replay", "demo");
  assert.equal(same.exitCode, 0, same.stderr);
  assert.match(same.stdout, new RegExp(`replay of run ${run}, attempt 0: the program is the one that was recorded`));
  assert.match(same.stdout, /2 of its 2 calls were answered from the record; none was carried out/);
  assert.match(same.stdout, /it ended as recorded: done/);
  assert.equal(readFileSync(join(projectDir, "ran.txt"), "utf-8"), "ran\n", "the command ran once: when the run was recorded");

  writeFileSync(join(projectDir, "program.ts"), DEMO.replace(`"v1"`, `"v2"`));
  const left = await trama("replay", "demo");
  assert.equal(left.exitCode, 1);
  assert.match(left.stdout, /attempt 0: the program is not the one that was recorded/);
  assert.match(left.stdout, /1 of its 2 calls were answered from the record; none was carried out/);
  assert.match(left.stdout, /it left the record at its call 2 \(\/tools\/write\): \/content at character 1: asked "v2" \| recorded "v1"/);
  assert.equal(readFileSync(join(projectDir, "made.txt"), "utf-8"), "v1");

  const loose = await trama("replay", "demo", run, "--loose");
  assert.equal(loose.exitCode, 1);
  assert.match(loose.stdout, /2 of its 2 calls were answered from the record; none was carried out/);
  assert.match(loose.stdout, /1 of them asked otherwise than was recorded:\n +call 2 \(\/tools\/write\): \/content at character 1: asked "v2" \| recorded "v1"/);
  assert.match(loose.stdout, /it ended as recorded: done/);

  const none = await trama("replay", "demo", "2020-01-01T00-00-00-000Z-aaaaaa");
  assert.equal(none.exitCode, 1);
  assert.match(none.stderr, /No journal for run "2020-01-01T00-00-00-000Z-aaaaaa"/);
  assert.equal(existsSync(join(projectDir, "ran.txt")), true);
});
