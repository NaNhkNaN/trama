import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { llm } from "./fake-llm.mjs";
import { createProject, replayProgram, runProgram, updateProject } from "../packages/runtime/dist/index.js";
import { createContext } from "../packages/runtime/dist/context.js";
import { printJournals } from "../packages/runtime/dist/journal-view.js";
import { captureConsole, cleanupTempDir, createProjectFixture, makeTempDir, readJson, withEnv, writeJson, writeText } from "./helpers.mjs";

// A program ends its run as failed, in its own words: ctx.fail(reason). What was asked cannot be done — and nothing
// is wrong with the program. So the run has failed with what the program said, and nothing else; it is not fixed,
// where a program that threw is; and it has no result. (Until now a program had one way to fail: to throw — which
// is told as node tells of a process that died, and answered with a fix of the program.)

const quietly = (fn) => captureConsole("error", () => captureConsole("warn", () => captureConsole("log", fn))).then(({ result }) => result.result.result);
const GOOD = (n) => `import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ n: ${n} });\n`;
const FAILS = `import { ctx, tools } from "@trama-dev/runtime";
ctx.state.kept = "checkpointed";
await ctx.checkpoint();
ctx.state.kept = "not kept";
await tools.write("before.txt", "x");
if (ctx.input.args.give === undefined) await ctx.fail("It is not said what to give: \\"give\\", among the arguments.\\nNothing was done.");
await tools.write("after.txt", "x");
await ctx.done({ gave: ctx.input.args.give });
`;

/** A home with projects in it by name, and a model that is played. */
function scene(t, config = { maxRepairAttempts: 3 }) {
  const fakeHome = makeTempDir("trama-fail-home-");
  t.after(() => cleanupTempDir(fakeHome));
  writeJson(join(fakeHome, ".trama", "config.json"), config);
  const at = (name) => join(fakeHome, ".trama", "projects", name);
  const original = { ...llm };
  t.after(() => { Object.assign(llm, original); });
  const inHome = (fn) => withEnv({ HOME: fakeHome }, () => quietly(fn));
  const heard = async (fn) => {
    const { messages: errors, result: { messages: warned, result: { messages: logged, result } } } = await withEnv({ HOME: fakeHome }, () => captureConsole("error", () => captureConsole("warn", () => captureConsole("log", fn))));
    return { result, said: [...logged, ...warned, ...errors] };
  };
  const project = (name, program, more = {}) => { createProjectFixture(at(name), { programSource: program, metaInput: { prompt: `the ${name}`, args: {} } }); writeJson(join(at(name), "meta.json"), { ...readJson(join(at(name), "meta.json")), ...more }); return at(name); };
  const journals = (name) => { const dir = join(at(name), "logs", "journal"); return existsSync(dir) ? readdirSync(dir).sort().map((file) => readFileSync(join(dir, file), "utf-8").trim().split("\n").map((line) => JSON.parse(line))) : []; };
  const lines = (name) => readFileSync(join(at(name), "history", "runs.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  return { fakeHome, at, inHome, heard, project, journals, lines };
}

test("a program ends its run as failed in its own words: the run has failed with what it said and nothing else, the program goes no further — and no fix is asked for, where one is for a program that threw", async (t) => {
  const it = scene(t);
  it.project("gives", FAILS);
  llm.repair = async () => { throw new Error("a fix was asked for of a program that said its run had failed"); };
  const failed = await it.heard(() => runProgram({ projectDir: it.at("gives"), timeout: 30_000 }));
  // The run's reason is the program's, to the letter: no word of the runner's before it, nothing of how a process ended.
  assert.deepEqual(failed.result, { status: "failed", reason: 'It is not said what to give: "give", among the arguments.\nNothing was done.' });
  // The program went no further than the call; and it is the program it was.
  assert.deepEqual([existsSync(join(it.at("gives"), "before.txt")), existsSync(join(it.at("gives"), "after.txt")), readFileSync(join(it.at("gives"), "program.ts"), "utf-8")], [true, false, FAILS]);
  // Its state is what it had kept: ending a run so keeps nothing more.
  assert.deepEqual(readJson(join(it.at("gives"), "state.json")), { kept: "checkpointed" });
  // Said as the run goes, as any ending is; and nothing of a process that died.
  assert.equal(failed.said.filter((line) => line === "[trama] failed").length, 1, failed.said.join("\n"));
  assert.equal(failed.said.some((line) => /exited with code|triggerUncaughtException|Node\.js v/.test(line)), false, failed.said.join("\n"));
  // On record: the attempt's own word, the run's end, and the run's line in the history — the first line of what was said.
  const [record] = it.journals("gives");
  assert.deepEqual(record.filter((each) => each.kind === "exit").map((each) => [each.code, each.outcome]), [[0, failed.result]]);
  assert.deepEqual(record.filter((each) => each.kind === "fix-request").length, 0);
  assert.deepEqual(record.at(-1).result, failed.result);
  assert.deepEqual((({ status, reason, repaired }) => ({ status, reason, repaired }))(it.lines("gives").at(-1)), { status: "failed", reason: 'It is not said what to give: "give", among the arguments.', repaired: undefined });
  const shown = (await withEnv({ HOME: it.fakeHome }, () => captureConsole("log", async () => printJournals(it.at("gives"), "gives", {})))).messages.join("\n");
  assert.match(shown, /attempt 0 over: exit code 0 → failed, as its program said: It is not said what to give: "give", among the arguments\./);

  // With what it needs, it is done — and a program that throws is fixed, as it was: that is what a fix is for.
  assert.deepEqual(await it.inHome(() => runProgram({ projectDir: it.at("gives"), args: { give: 1 }, timeout: 30_000 })), { status: "done", result: { gave: 1 } });
  it.project("throws", `throw new Error("a fault of the program's");\n`);
  let asked = 0;
  llm.repair = async () => { asked += 1; return GOOD(1); };
  assert.deepEqual(await it.inHome(() => runProgram({ projectDir: it.at("throws"), timeout: 30_000 })), { status: "done", result: { n: 1 } });
  assert.equal(asked, 1);

  // A run a program asked for comes back to it so: failed, with the words.
  it.project("asks", `import { ctx } from "@trama-dev/runtime";\nimport { runProgram } from "@trama-dev/runtime/runner";\nawait ctx.done({ came: await runProgram({ projectDir: ${JSON.stringify(it.at("gives"))}, timeout: 20000 }) });\n`);
  assert.deepEqual((await it.inHome(() => runProgram({ projectDir: it.at("asks"), timeout: 30_000 }))).result.came, failed.result);
  // Said with no reason, that is what is said.
  it.project("silent", `import { ctx } from "@trama-dev/runtime";\nawait ctx.fail("  ");\n`);
  assert.deepEqual(await it.inHome(() => runProgram({ projectDir: it.at("silent"), timeout: 30_000 })), { status: "failed", reason: "The program ended its run as failed, and did not say why." });
  // (A reason is text: what is none is the call's failure — and a program that dies of that has thrown.)
  it.project("odd", `import { ctx } from "@trama-dev/runtime";\nawait ctx.fail(new Error("not text") as unknown as string);\n`);
  const odd = await it.inHome(() => runProgram({ projectDir: it.at("odd"), maxRepairAttempts: 0, timeout: 30_000 }));
  assert.match(odd.reason, /^Program failed \(repair disabled\): [^]*invalid field: reason \(expected string\)/);
});

test("a run ends once — by done, by yield or by fail: after one, the others are refused, and the same said again does nothing", async (t) => {
  const projectDir = makeTempDir("trama-fail-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);
  const quiet = { print: () => {} };
  const failed = createContext(projectDir, {}, quiet);
  failed.fail("it cannot be done");
  assert.deepEqual(failed.ended, { status: "failed", reason: "it cannot be done" });
  failed.fail("said again, otherwise");
  assert.deepEqual(failed.ended, { status: "failed", reason: "it cannot be done" });
  for (const [call, does] of [["done", () => failed.done({}, { n: 1 })], ["yield", () => failed.yield({}, "later")], ["checkpoint", () => failed.checkpoint({ a: 1 })]]) {
    assert.throws(does, new RegExp(`^Error: Cannot call ctx\\.${call}\\(\\) after ctx\\.fail\\(\\) — the run has ended, and its state is settled\\.$`), call);
  }
  // (Nothing of the state was written by it.)
  assert.equal(existsSync(join(projectDir, "state.json")), false);
  const done = createContext(projectDir, {}, quiet);
  done.done({}, { n: 1 });
  assert.throws(() => done.fail("after all"), /^Error: Cannot call ctx\.fail\(\) after ctx\.done\(\) — the run has ended, and its state is settled\.$/);
  const yielded = createContext(projectDir, {}, quiet);
  yielded.yield({}, "later");
  assert.throws(() => yielded.fail("after all"), /^Error: Cannot call ctx\.fail\(\) after ctx\.yield\(\) — the run has ended, and its state is settled\.$/);
  assert.deepEqual([done.ended.status, yielded.ended.status], ["done", "yielded"]);
  // The mark of a yield that the run took up from is left as it is, as where a program dies: the run after takes up from it again.
  writeJson(join(projectDir, "state.json"), { __trama_yield: { reason: "waiting" }, n: 1 });
  createContext(projectDir, readJson(join(projectDir, "state.json")), quiet).fail("not yet");
  assert.deepEqual(readJson(join(projectDir, "state.json")), { __trama_yield: { reason: "waiting" }, n: 1 });
});

test("a fix whose program then ends its run as failed has not worked: nothing of it reaches the project, no other is asked for — and the run says both", async (t) => {
  const it = scene(t);
  const BROKEN = `throw new Error("a fault of the program's");\n`;
  it.project("throws", BROKEN);
  let asked = 0;
  llm.repair = async (_prompt, call) => { asked += 1; writeText(join(call.cwd, "beside.txt"), "made by the fixer"); return `import { ctx } from "@trama-dev/runtime";\nawait ctx.fail("It cannot be done: the answer is not known.");\n`; };
  const ran = await it.inHome(() => runProgram({ projectDir: it.at("throws"), timeout: 30_000 }));
  assert.equal(ran.status, "failed");
  assert.match(ran.reason, /^Failed after 1 repair attempt\(s\): program\.ts exited with code 1[^]*a fault of the program's[^]*\nThe fix was tried, and its program ended the run as failed: It cannot be done: the answer is not known\.$/);
  assert.deepEqual([asked, readFileSync(join(it.at("throws"), "program.ts"), "utf-8"), existsSync(join(it.at("throws"), "beside.txt"))], [1, BROKEN, false]);
  assert.equal(it.lines("throws").at(-1).repaired, undefined);
});

test("a candidate that ends its run as failed has failed its validation, in its words: no project is made of it, no update — and nobody is asked to fix it", async (t) => {
  const it = scene(t);
  const CANNOT = `import { ctx } from "@trama-dev/runtime";\nawait ctx.fail("It needs a key, and has none.");\n`;
  llm.repair = async () => { throw new Error("a fix was asked for of a candidate that said its run had failed"); };
  await assert.rejects(it.inHome(() => createProject("handed", "say it", { program: CANNOT })), /^Error: Program failed: It needs a key, and has none\.$/);
  assert.equal(existsSync(it.at("handed")), false);
  it.project("words", GOOD(1));
  llm.ask = async () => CANNOT;
  await assert.rejects(it.inHome(() => updateProject("words", "need a key")), /^Error: Update failed — the program is unchanged\.\nProgram failed: It needs a key, and has none\.$/);
  assert.equal(readFileSync(join(it.at("words"), "program.ts"), "utf-8"), GOOD(1));
});

test("a run that ended by its program's word is replayed to the same end", async (t) => {
  const it = scene(t, { maxRepairAttempts: 0 });
  it.project("gives", FAILS);
  const failed = await it.inHome(() => runProgram({ projectDir: it.at("gives"), timeout: 30_000 }));
  const again = await it.inHome(() => replayProgram({ projectDir: it.at("gives") }));
  assert.deepEqual([again.left, again.result, again.recordedResult, again.sameEnd, again.same], [undefined, failed, failed, true, true]);
});

test("the runtime's own writer and fixer say in a line that their agent could not be asked — as their run's failure, in its words: no process that died is told of", async (t) => {
  const it = scene(t, { maxRepairAttempts: 1 });
  llm.ask = async () => { throw new Error("No API key found for a-provider.\n\nUse /login to log in."); };
  llm.repair = llm.ask;
  const made = await it.heard(() => createProject("hello", "say hello").catch((err) => String(err)));
  assert.equal(made.result, "Error: The project asked for the program failed: trama runtime error: Error: No API key found for a-provider.\n\nUse /login to log in.");
  assert.equal(made.said.some((line) => /exited with code|triggerUncaughtException|Node\.js v|    at /.test(line)), false, made.said.join("\n"));
  assert.equal(made.said.filter((line) => line === "[create] [trama] failed").length, 1, made.said.join("\n"));
  assert.equal(existsSync(it.at("hello")), false);
  it.project("throws", `throw new Error("a fault of the program's");\n`);
  const ran = await it.heard(() => runProgram({ projectDir: it.at("throws"), timeout: 30_000 }));
  assert.match(ran.result.reason, /\nNo fix came back: The project asked for the fix failed: trama runtime error: Error: No API key found for a-provider\.\n\nUse \/login to log in\.$/);
  assert.equal(ran.said.filter((line) => line === "[fix] [trama] failed").length, 1, ran.said.join("\n"));
  // And of an answer that is no program, the writer says so in a line.
  llm.ask = async () => "IN THE FILE: it is written.";
  await assert.rejects(it.inHome(() => createProject("unmade", "say nine")), /^Error: The project asked for the program failed: The model said that the program is in program\.ts, and there is none there\.$/);
  llm.ask = async () => "```ts\n```";
  await assert.rejects(it.inHome(() => createProject("unmade", "say nine")), /^Error: The project asked for the program failed: The model answered with no program\.$/);
});
