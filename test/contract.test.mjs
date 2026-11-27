import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { addVersion, describeProject, describeProjects, listProjects, replayProgram, runProgram } from "../packages/runtime/dist/index.js";
import { printJournals } from "../packages/runtime/dist/journal-view.js";
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
    // (A name written wrongly, of an argument it is to have: the refusal says what was left out, too.)
    [{ wrod: "a", time: 3 }, new RegExp(`takes — missing key: word\\. Not taken, and left out: "wrod", "time"\\. ${TAKEN}$`)],
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

  // An argument the project does not take is left out of what its program is given — as what a tool does not declare is,
  // and what a run gives beside what its project says — and it is said: on the run's record, and aloud to whoever started the run.
  const said = await withEnv({ HOME: it.fakeHome }, () => captureConsole("warn", () => captureConsole("log", () => runProgram({ projectDir: it.at("words"), args: { word: "a", time: 3, tims: "4" }, timeout: 30_000 }))));
  assert.deepEqual(said.result.result.result, { args: { word: "a" }, kinds: { word: "string" } });
  assert.deepEqual(said.messages.filter((line) => /takes no argument/.test(line)), [`[trama] ${it.at("words")} takes no argument "time", "tims": left out. It takes: word, times?, loud?, more?.`]);
  assert.deepEqual(journalsOf(it.at("words")).at(-1).filter((record) => record.kind === "left-out").map((record) => record.args), [["time", "tims"]]);
  assert.equal((await captureConsole("log", async () => printJournals(it.at("words"), "words", {}))).messages.filter((line) => /not taken, and left out of what the program was given: "time", "tims"/.test(line)).length, 1);
  // Runs asked with other arguments are other runs by their mark, whatever of them the program was given.
  assert.notEqual(linesOf(it.at("words")).at(-1).input, linesOf(it.at("words")).at(0).input);
  // A run a program asked for: on its record, and not said aloud — there is nobody there who typed it. And whoever
  // checks the run is handed its arguments as they were asked, what was left out among them: it judges what was asked for.
  const more = homeWith(t, {
    words: { program: ECHOES, more: { parameters: TAKES } },
    asks: { program: `import { ctx } from "@trama-dev/runtime";\nimport { resolveProject, runProgram } from "@trama-dev/runtime/runner";\nconst ran = await runProgram({ projectDir: resolveProject("words"), args: { word: "a", times: "2", id: 7 }, checkWith: "judge", maxRepairAttempts: 0 });\nawait ctx.done({ had: ran.result, notes: ran.check?.notes });\n` },
    judge: { program: `import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ ok: true, notes: JSON.stringify((ctx.input.args as any).args) });\n` },
  });
  const asked = await withEnv({ HOME: more.fakeHome }, () => captureConsole("warn", () => captureConsole("log", () => runProgram({ projectDir: more.at("asks"), timeout: 60_000 }))));
  assert.deepEqual(asked.result.result.result, { had: { args: { word: "a", times: 2 }, kinds: { word: "string", times: "number" } }, notes: JSON.stringify({ word: "a", times: 2, id: 7 }) });
  assert.deepEqual([asked.messages.filter((line) => /takes no argument/.test(line)), journalsOf(more.at("words")).at(-1).filter((record) => record.kind === "left-out").map((record) => record.args)], [[], [["id"]]]);

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

test("an argument written as text where an object or a list is declared is read as the one it writes, as a number is: from a command line every argument is text", async (t) => {
  const TAKES_THESE = { "opts?": "object: whatever is set", "list?": ["number"], "pair?": { a: "number", "b?": "string" }, "any?": "json", "word?": "string" };
  const it = homeWith(t, { takes: { program: ECHOES, more: { description: "Takes an object, a list and a pair.", parameters: TAKES_THESE } } });
  const given = async (args) => (await it.run("takes", { args })).result.result.args;
  // The text of each is read as what it writes — and held as that: a pair to its fields, a list to its items.
  assert.deepEqual(await given({ opts: '{"deep": {"n": [1, null]}, "s": "x"}', list: " [1, 2] ", pair: '{"a": 1, "c": true}' }), { opts: { deep: { n: [1, null] }, s: "x" }, list: [1, 2], pair: { a: 1 } });
  // What is given as what it is, is that — and where any value is taken, or text, text is text: nothing is read out of it.
  assert.deepEqual(await given({ opts: { k: 1 }, list: [], any: '{"a": 1}', word: "[1]" }), { opts: { k: 1 }, list: [], any: '{"a": 1}', word: "[1]" });
  // Text that does not write the kind that is declared stays the text it is, and is refused as that.
  for (const [args, why] of [
    [{ opts: "not json" }, /takes — opts: expected an object, got string\./],
    [{ opts: "[1]" }, /opts: expected an object, got string\./],
    [{ opts: "null" }, /opts: expected an object, got string\./],
    [{ opts: [1] }, /opts: expected an object, got a list\./],
    [{ list: '{"a": 1}' }, /list: expected a list, got string\./],
    [{ list: '["one"]' }, /list\[0\]: expected number, got string\./],
    [{ pair: "[]" }, /pair: expected an object, got string\./],
    [{ pair: '{"b": "x"}' }, /missing key: pair\.a/],
    // (Each argument is read by itself: one that writes nothing does not keep the next from being read, and held — here, found wanting.)
    [{ pair: "nope", list: '["one"]' }, /takes — list\[0\]: expected number, got string\./],
  ]) await assert.rejects(it.run("takes", { args }), why, JSON.stringify(args));
  // To whoever chooses the project it is told as an object: by its kind.
  const said = await withEnv({ HOME: it.fakeHome }, () => describeProject("takes"));
  assert.deepEqual(said.schema.parameters.properties.opts, { type: "object", description: "whatever is set" });
});

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

test("what a run gives beside what its project says it gives is left out, and it is said — as of an argument the project does not take: on the run's record, and aloud to whoever started the run", async (t) => {
  const returns = { said: "string", "times?": "number", lines: [{ n: "number" }], "any?": "json" };
  const it = homeWith(t, {
    gives: { program: GIVES, more: { returns } },
    asks: { program: `import { ctx } from "@trama-dev/runtime";\nimport { resolveProject, runProgram } from "@trama-dev/runtime/runner";\nconst ran = await runProgram({ projectDir: resolveProject("gives"), args: ctx.input.args });\nawait ctx.done({ had: ran.result });\n` },
  });
  const heard = (fn) => withEnv({ HOME: it.fakeHome }, () => captureConsole("warn", () => captureConsole("log", fn))).then(({ result, messages }) => ({ result: result.result, warned: messages.filter((line) => /left out of what the run gave/.test(line)) }));
  const noted = (name) => journalsOf(it.at(name)).at(-1).filter((record) => record.kind === "left-out").map(({ at: _at, kind: _kind, ...record }) => record);
  const give = { said: "a", lines: [{ n: 1, extra: true }, { n: 2, extra: false, other: 0 }], also: "x", any: { whatever: { it: "holds" } } };

  // The result is what the project says it gives — and what else the program handed over is named, by where it was: once for every item of a list.
  const ran = await heard(() => runProgram({ projectDir: it.at("gives"), args: { give }, timeout: 30_000 }));
  assert.deepEqual(ran.result, { status: "done", result: { said: "a", lines: [{ n: 1 }, { n: 2 }], any: { whatever: { it: "holds" } } } });
  assert.deepEqual(ran.warned, [`[trama] the result has "lines[].extra", "lines[].other", "also", which the project does not say it gives: left out of what the run gave. It gives: said, times?, lines, any?.`]);
  assert.deepEqual(noted("gives"), [{ result: ["lines[].extra", "lines[].other", "also"] }]);
  // And it is shown with the run, call by call.
  const shown = await captureConsole("log", async () => printJournals(it.at("gives"), "gives", {}));
  assert.equal(shown.messages.filter((line) => /left out of what the run gave: "lines\[\]\.extra", "lines\[\]\.other", "also"/.test(line)).length, 1, shown.messages.join("\n"));

  // Nothing left out, nothing said: of a result that is what was declared, of one that did not fit, of a project that says nothing of what it gives.
  const whole = await heard(() => runProgram({ projectDir: it.at("gives"), args: { give: { said: "a", lines: [] } }, timeout: 30_000 }));
  assert.deepEqual([whole.warned, noted("gives")], [[], []]);
  const unfit = await heard(() => runProgram({ projectDir: it.at("gives"), args: { give: { said: 1, lines: [], also: "x" } }, timeout: 30_000 }));
  assert.deepEqual([unfit.result.status, unfit.warned, noted("gives")], ["failed", [], []]);
  // (A done that failed left nothing out: the one that settled the run says what it left out, and no other.)
  const mended = await heard(() => runProgram({ projectDir: it.at("gives"), args: { give: { said: 1, also: "x" }, then: { said: "b", lines: [], later: 1 } }, timeout: 30_000 }));
  assert.deepEqual([mended.result.status, noted("gives")], ["done", [{ result: ["later", "refused"] }]]);

  // A run a program asked for: on its record, and not said aloud.
  const asked = await heard(() => runProgram({ projectDir: it.at("asks"), args: { give }, timeout: 60_000 }));
  assert.deepEqual([asked.result.result.had.said, asked.warned, noted("gives")], ["a", [], [{ result: ["lines[].extra", "lines[].other", "also"] }]]);

  // And where a program is validated — a version put on record — whoever asked for that is told, as of a run: what the
  // new program gives and the project does not say is the first thing they would want to know of it.
  writeJson(join(it.at("gives"), "meta.json"), { ...readJson(join(it.at("gives"), "meta.json")), input: { prompt: "p", args: { give: { said: "a", lines: [] } } } });
  const version = await heard(() => addVersion("gives", `import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ said: "a", lines: [], letters: 1 });\n`));
  assert.deepEqual([version.result, version.warned], [{ version: 2 }, [`[trama] the result has "letters", which the project does not say it gives: left out of what the run gave. It gives: said, times?, lines, any?.`]]);
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

test("the examples say what they are for, take and give — those a runner starts in a role among them: each is read as it is written", async () => {
  const said = {};
  for (const name of ["coding-harness", "improve-by-check", "check-by-command", "repair-harness"]) {
    said[name] = await describeProject(join(REPO_ROOT, "examples", name));
    assert.ok(typeof said[name].description === "string" && said[name].description.length > 40, name);
    assert.equal(said[name].schema.returns.type, "object", name);
  }
  assert.deepEqual(Object.keys(said["coding-harness"].parameters), ["task?", "turns?", "forgetAt?", "model?", "programs?"]);
  assert.deepEqual([said["improve-by-check"].schema.parameters.required, Object.keys(said["improve-by-check"].parameters).length], [["project", "check"], 12]);
  // What a runner itself starts — a checker, a fixer — says what one is handed: what the runner hands beside that, one day, is left out and not refused.
  assert.deepEqual(said["repair-harness"].schema.parameters.required, ["program", "error"]);
  assert.deepEqual(Object.keys(said["check-by-command"].parameters), ["command?", "seconds?", "result?", "args?", "journal?", "run?", "used?", "workspace?"]);
});
