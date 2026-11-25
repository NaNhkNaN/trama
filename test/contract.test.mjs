import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describeProject, describeProjects, listProjects, replayProgram, runProgram } from "../packages/runtime/dist/index.js";
import { REPO_ROOT, captureConsole, cleanupTempDir, createProjectFixture, makeTempDir, readJson, withEnv, writeJson } from "./helpers.mjs";

// What a project takes and gives: said in its meta.json, in the words a tool is declared in — description,
// parameters, returns — and held by the runner: a run whose arguments do not fit is not begun, and what a run
// gives is held to what was said. It is the project's, not its program's: an update writes the program alone.

const quietly = (fn) => captureConsole("warn", () => captureConsole("log", fn)).then(({ result }) => result);
const journalsOf = (projectDir) => {
  const dir = join(projectDir, "logs", "journal");
  return existsSync(dir) ? readdirSync(dir).sort().map((file) => readFileSync(join(dir, file), "utf-8").trim().split("\n").map((line) => JSON.parse(line))) : [];
};
const linesOf = (projectDir) => (existsSync(join(projectDir, "history", "runs.jsonl")) ? readFileSync(join(projectDir, "history", "runs.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line)) : []);

/** A home with projects in it by name: each a program, what it is started with, and what its meta.json says beside. */
function homeWith(t, projects) {
  const fakeHome = makeTempDir("trama-contract-home-");
  t.after(() => cleanupTempDir(fakeHome));
  writeJson(join(fakeHome, ".trama", "config.json"), { maxRepairAttempts: 0 });
  const at = (name) => join(fakeHome, ".trama", "projects", name);
  for (const [name, { program, args = {}, more = {} }] of Object.entries(projects)) {
    createProjectFixture(at(name), { programSource: program, metaInput: { prompt: `the ${name}`, args } });
    writeJson(join(at(name), "meta.json"), { ...readJson(join(at(name), "meta.json")), ...more });
  }
  const run = (name, options = {}) => withEnv({ HOME: fakeHome }, () => quietly(() => runProgram({ projectDir: at(name), timeout: 30_000, ...options })));
  return { fakeHome, at, run };
}

/** A program that gives back what it was started with, and what kind each thing is. */
const ECHOES = `import { ctx } from "@trama-dev/runtime";
const args = ctx.input.args as Record<string, unknown>;
await ctx.done({ args, kinds: Object.fromEntries(Object.entries(args).map(([key, value]) => [key, typeof value])) });
`;
const TAKES = { word: "string: the word to say", "times?": "number: how often", "loud?": "boolean", "more?": "json" };

test("a run whose arguments do not fit what its project takes is not begun: no program is started — and an argument written as text where a number or a boolean is declared is read as one", async (t) => {
  const it = homeWith(t, { words: { program: ECHOES, more: { description: "Says a word.", parameters: TAKES } }, plain: { program: ECHOES } });
  // They fit: the program has them, each of its kind. (From a command line every one is text.)
  assert.deepEqual((await it.run("words", { args: { word: "a" } })).result.result, { args: { word: "a" }, kinds: { word: "string" } });
  assert.deepEqual((await it.run("words", { args: { word: "a", times: "3", loud: "true", more: "7" } })).result.result,
    { args: { word: "a", times: 3, loud: true, more: "7" }, kinds: { word: "string", times: "number", loud: "boolean", more: "string" } });
  assert.deepEqual((await it.run("words", { args: { word: "12", times: 2, loud: false, more: { any: [1] } } })).result.result.kinds, { word: "string", times: "number", loud: "boolean", more: "object" });
  assert.equal(linesOf(it.at("words")).length, 3);

  // They do not: the run is refused, in words that say what is wrong — and what the project takes.
  const TAKEN = 'It takes: word, times\\?, loud\\?, more\\?\\.';
  for (const [args, why] of [
    [{}, new RegExp(`Error: The arguments do not fit what .*words takes — missing key: word\\. ${TAKEN}$`)],
    [{ word: 1 }, /takes — word: expected string, got 1\./],
    [{ word: "a", times: "three" }, /takes — times: expected number, got string\./],
    [{ word: "a", times: "" }, /takes — times: expected number, got string\./],
    [{ word: "a", loud: "yes" }, /takes — loud: expected boolean, got string\./],
    // An argument it does not take is a mistake of whoever gave it — a name written wrongly, most often — and is not passed over.
    [{ word: "a", time: 3 }, new RegExp(`takes — it takes no argument "time"\\. ${TAKEN}$`)],
  ]) {
    await assert.rejects(it.run("words", { args }), why, JSON.stringify(args));
  }
  // Nothing was begun: no line of history, no journal, more than the three runs made.
  assert.deepEqual([linesOf(it.at("words")).length, journalsOf(it.at("words")).length], [3, 3]);

  // What the project's own meta.json starts it with is under what a run gives, as it was — and is held with it.
  const own = homeWith(t, { words: { program: ECHOES, args: { word: "own", times: "2" }, more: { parameters: TAKES } }, wrong: { program: ECHOES, args: { times: 1 }, more: { parameters: TAKES } } });
  assert.deepEqual((await own.run("words")).result.result.args, { word: "own", times: 2 });
  assert.deepEqual((await own.run("words", { args: { times: 5 } })).result.result.args, { word: "own", times: 5 });
  await assert.rejects(own.run("wrong"), /missing key: word/);

  // A project that says nothing of what it takes takes what it is given, as it is.
  assert.deepEqual((await it.run("plain", { args: { times: "3", anything: [1] } })).result.result, { args: { times: "3", anything: [1] }, kinds: { times: "string", anything: "object" } });
});

/** A program that gives what it is told to — and, where that is refused, says so and gives something else. */
const GIVES = `import { ctx } from "@trama-dev/runtime";
const { give, then } = ctx.input.args as { give: unknown; then?: unknown };
try {
  await ctx.done(give);
} catch (err) {
  if (then === undefined) throw err;
  await ctx.done({ ...(then as object), refused: String((err as Error).message) });
}
`;

test("what a run gives is held to what its project says it gives: the declared fields and no others — and a result that does not fit fails the call, so a run that ends there has failed", async (t) => {
  const returns = { said: "string", "times?": "number", lines: [{ n: "number" }] };
  const it = homeWith(t, { gives: { program: GIVES, more: { returns } }, word: { program: GIVES, more: { returns: "string" } }, free: { program: GIVES } });
  // It fits: what is given is the result — the fields that were declared, and no others.
  const fits = await it.run("gives", { args: { give: { said: "a", lines: [{ n: 1, extra: true }], also: "x" } } });
  assert.deepEqual(fits.result, { status: "done", result: { said: "a", lines: [{ n: 1 }] } });
  // It does not: the call fails, in the program — which ended there, so the run failed; and why is said.
  const not = await it.run("gives", { args: { give: { said: 1, lines: [] } } });
  assert.equal(not.result.status, "failed");
  assert.match(not.result.reason, /The result does not fit what .*gives gives — said: expected string, got 1/);
  assert.match((await it.run("gives", { args: { give: { said: "a" } } })).result.reason, /gives — missing key: lines/);
  assert.match((await it.run("gives", { args: { give: "a word" } })).result.reason, /gives — response is not an object|gives — .*expected an object/);
  // A done that failed settled nothing: a program that goes on can still end its run, with what fits.
  const mended = await it.run("gives", { args: { give: { said: 1 }, then: { said: "b", lines: [] } } });
  assert.equal(mended.result.status, "done");
  assert.deepEqual({ said: mended.result.result.said, lines: mended.result.result.lines }, { said: "b", lines: [] });
  // What is given need be no object: any shape that can be written.
  assert.deepEqual((await it.run("word", { args: { give: "a word" } })).result, { status: "done", result: "a word" });
  assert.match((await it.run("word", { args: { give: 3 } })).result.reason, /expected string, got 3/);
  // A project that says nothing of what it gives gives what its program does.
  assert.deepEqual((await it.run("free", { args: { give: { anything: [1, null] } } })).result.result, { anything: [1, null] });
});

test("what a project says it takes and gives is written as shapes are, or the project is refused by name — before a run of it is begun", async (t) => {
  for (const [more, why] of [
    [{ parameters: "string" }, /Malformed meta\.json in .* — "parameters" is what the project takes: an object of the fields a run is given/],
    [{ parameters: ["string"] }, /"parameters" is what the project takes: an object of the fields/],
    [{ parameters: { a: "text" } }, /Malformed meta\.json in .* — "parameters": Schema validation failed: unsupported schema type "text" for key "a"/],
    [{ returns: { a: ["string", "number"] } }, /"returns": Schema validation failed: the list at "a" is written with 2 elements/],
    [{ returns: 3 }, /"returns": Schema validation failed: unsupported schema type "3"/],
    [{ description: 3 }, /"description" is what the project is for, in words: text/],
  ]) {
    const it = homeWith(t, { odd: { program: ECHOES, more } });
    await assert.rejects(it.run("odd"), why, JSON.stringify(more));
    assert.equal(journalsOf(it.at("odd")).length, 0, JSON.stringify(more));
  }
});

/** A program that asks its runner what projects there are, and what one of them takes and gives. */
const ASKS = `import { ctx } from "@trama-dev/runtime";
import { describeProject, describeProjects } from "@trama-dev/runtime/runner";
await ctx.done({ one: await describeProject("words"), all: (await describeProjects()).map(({ name, description }) => [name, description ?? null]) });
`;

test("what a project takes and gives is told without its program being run: to a program by its runner — on its run's record, and a replay is told the same — and to whoever lists the projects", async (t) => {
  const returns = { said: "string" };
  const it = homeWith(t, {
    words: { program: ECHOES, more: { description: "Says a word, as often as it is told to.", parameters: TAKES, returns } },
    plain: { program: ECHOES }, asker: { program: ASKS },
  });
  const WORDS = {
    name: "words", description: "Says a word, as often as it is told to.", parameters: TAKES, returns,
    // (As JSON Schema too, which is how a model is told of a tool.)
    schema: {
      parameters: { type: "object", properties: { word: { type: "string", description: "the word to say" }, times: { type: "number", description: "how often" }, loud: { type: "boolean" }, more: {} }, required: ["word"], additionalProperties: false },
      returns: { type: "object", properties: { said: { type: "string" } }, required: ["said"], additionalProperties: false },
    },
  };
  await withEnv({ HOME: it.fakeHome }, async () => {
    assert.deepEqual(await describeProject("words"), WORDS);
    // By a path too, as a project is named to be checked by. One that says nothing has a name, and no more.
    assert.deepEqual(await describeProject(it.at("plain")), { name: "plain" });
    assert.deepEqual((await describeProjects()).map(({ name }) => name), ["asker", "plain", "words"]);
    await assert.rejects(describeProject("nowhere"), /no project/i);
  });
  // No program was run for it.
  assert.equal(journalsOf(it.at("words")).length, 0);

  // A program asks its runner: the answer is on its run's record.
  const ran = await it.run("asker", { label: "asker" });
  assert.equal(ran.result.status, "done", ran.result.reason);
  assert.deepEqual(ran.result.result, { one: WORDS, all: [["asker", null], ["plain", null], ["words", WORDS.description]] });
  const journal = journalsOf(it.at("asker")).at(-1);
  assert.deepEqual(journal.filter((record) => record.kind === "call" && record.endpoint === "/project/describe").map((record) => record.request), [{ name: "words" }, {}]);
  // And a replay is told what the run was told — not what the project has come to say since.
  writeJson(join(it.at("words"), "meta.json"), { ...readJson(join(it.at("words"), "meta.json")), description: "Something else now." });
  const { result: replay } = await withEnv({ HOME: it.fakeHome }, () => quietly(() => replayProgram({ projectDir: it.at("asker"), run: ran.result.run ?? readdirSync(join(it.at("asker"), "logs", "journal")).sort().at(-1).replace(/\.jsonl$/, "") })));
  assert.deepEqual([replay.same, replay.left ?? null], [true, null]);

  // Listed: a project by what it is for, where it says so — and by what it was made with, where it does not.
  const { messages } = await withEnv({ HOME: it.fakeHome }, () => captureConsole("log", () => listProjects()));
  assert.match(messages.find((line) => /^\s+words\s/.test(line)), /words {2}Something else now\. {2}/);
  assert.match(messages.find((line) => /^\s+plain\s/.test(line)), /plain {2}the plain {2}/);
});

test("a version's line has a mark of what the project took and gave when the version was made: the same while that is the same, and none where the project says nothing of it", async (t) => {
  const it = homeWith(t, { words: { program: ECHOES, more: { parameters: TAKES } }, plain: { program: ECHOES } });
  const indexOf = (name) => readFileSync(join(it.at(name), "history", "index.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  await it.run("words", { args: { word: "a" } });
  await it.run("plain");
  const [first] = indexOf("words");
  assert.match(first.contract, /^[0-9a-f]{64}$/);
  assert.equal("contract" in indexOf("plain")[0], false);
  // The program is changed, and the project takes what it took: the same mark.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(it.at("words"), "program.ts"), `${ECHOES}// changed\n`);
  await it.run("words", { args: { word: "a" } });
  // It is changed again, and the project says it gives something now: another.
  writeFileSync(join(it.at("words"), "program.ts"), `${ECHOES}// changed again\n`);
  writeJson(join(it.at("words"), "meta.json"), { ...readJson(join(it.at("words"), "meta.json")), returns: { args: "json", kinds: "json" } });
  await it.run("words", { args: { word: "a" } });
  const marks = indexOf("words").map((line) => line.contract);
  assert.deepEqual([marks.length, marks[1] === marks[0], marks[2] === marks[0], /^[0-9a-f]{64}$/.test(marks[2])], [3, true, false, true]);
  // (A description is no part of it: what a project is for, in words, holds a run to nothing.)
  writeFileSync(join(it.at("words"), "program.ts"), `${ECHOES}// and again\n`);
  writeJson(join(it.at("words"), "meta.json"), { ...readJson(join(it.at("words"), "meta.json")), description: "Says what it was given." });
  await it.run("words", { args: { word: "a" } });
  assert.equal(indexOf("words")[3].contract, marks[2]);
  const { readHistory } = await import("../packages/runtime/dist/history.js");
  assert.deepEqual(readHistory(it.at("words")).versions.map((version) => version.contract), [...marks, marks[2]]);
});

test("the examples say what they are for and what they give — and those a person starts, what they take: each is read as it is written", async () => {
  const said = {};
  for (const name of ["coding-harness", "improve-by-check", "check-by-command", "repair-harness"]) {
    said[name] = await describeProject(join(REPO_ROOT, "examples", name));
    assert.ok(typeof said[name].description === "string" && said[name].description.length > 40, name);
    assert.equal(said[name].schema.returns.type, "object", name);
  }
  assert.deepEqual(Object.keys(said["coding-harness"].parameters), ["task?", "turns?", "forgetAt?", "model?"]);
  assert.deepEqual([said["improve-by-check"].schema.parameters.required, Object.keys(said["improve-by-check"].parameters).length], [["project", "check"], 11]);
  // What a runner itself starts — a checker, a fixer — is given what the runner gives one, which is the runner's to say: they do not say what they take.
  assert.deepEqual(["parameters" in said["check-by-command"], "parameters" in said["repair-harness"]], [false, false]);
});
