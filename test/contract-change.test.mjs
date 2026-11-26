import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { llm } from "./fake-llm.mjs";
import { addVersion, describeProject, readHistory, replayProgram, rollbackProject, runProgram, updateProject } from "../packages/runtime/dist/index.js";
import { REPO_ROOT, captureConsole, cleanupTempDir, createProjectFixture, makeTempDir, readJson, runNodeCommand, withEnv, writeJson } from "./helpers.mjs";

// What a project takes and gives can be changed by whoever asks for an update, and gone back from. A version is a
// program and what the project took and gave when it was made (`parameters`, `returns`): the text of that is kept
// with the version, a change of it by hand is a version found — as a program changed by hand is — going back to a
// version goes back to what it was made under, and a run of a version is held to that.

const markOf = (said) => createHash("sha256").update(JSON.stringify([said.parameters ?? null, said.returns ?? null])).digest("hex");
const GREETS = (more = "") => `import { ctx } from "@trama-dev/runtime";
const { name = "world" } = ctx.input.args as { name?: string };
await ctx.done({ greeting: "Hello, " + name + "!"${more} });
`;
const WITH_LETTERS = GREETS(", letters: name.length");
const A = { parameters: { "name?": "string: who is greeted" }, returns: { greeting: "string" } };
const B = { parameters: A.parameters, returns: { greeting: "string", letters: "number" } };
/** (As A, and one argument more that may be absent: the program that fits A fits it.) */
const C = { parameters: { ...A.parameters, "loud?": "boolean" }, returns: A.returns };
const LEFT_OUT = /left out of what the run gave/;

function homeWith(t, config = { maxRepairAttempts: 0 }) {
  const fakeHome = makeTempDir("trama-contract-change-home-");
  t.after(() => cleanupTempDir(fakeHome));
  writeJson(join(fakeHome, ".trama", "config.json"), config);
  const at = (name) => join(fakeHome, ".trama", "projects", name);
  createProjectFixture(at("greet"), { programSource: GREETS(), metaInput: { prompt: "Greet whoever is named.", args: {} } });
  writeJson(join(at("greet"), "meta.json"), { ...readJson(join(at("greet"), "meta.json")), description: "Greets by name.", ...A });
  createProjectFixture(at("plain"), { programSource: GREETS(), metaInput: { prompt: "p", args: {} } });
  /** What `fn` comes to, with what was logged and what was warned of meanwhile. */
  const heard = (fn) => withEnv({ HOME: fakeHome }, () => captureConsole("warn", () => captureConsole("log", fn))).then(({ result, messages }) => ({ result: result.result, logged: result.messages, warned: messages }));
  // The writer, played: one text at each asking; what it was told is kept.
  const asked = [];
  const original = { ...llm };
  t.after(() => { Object.assign(llm, original); });
  const writes = (...texts) => { llm.ask = async (prompt, call) => { asked.push({ prompt, system: call.system }); return texts.shift() ?? assert.fail("the writer was asked once more than the test provided for"); }; };
  const meta = (name = "greet") => readJson(join(at(name), "meta.json"));
  return {
    fakeHome, at, heard, asked, writes, meta,
    metaText: (name = "greet") => readFileSync(join(at(name), "meta.json"), "utf-8"),
    says: (name = "greet") => { const { parameters, returns } = meta(name); return { ...(parameters !== undefined && { parameters }), ...(returns !== undefined && { returns }) }; },
    /** A project's meta.json changed by hand: what it takes and gives, or anything else of it. */
    byHand: (more, name = "greet") => { const { parameters: _parameters, returns: _returns, ...rest } = meta(name); writeJson(join(at(name), "meta.json"), { ...rest, ...("parameters" in more || "returns" in more ? {} : { parameters: _parameters, returns: _returns }), ...more }); },
    program: (name = "greet") => readFileSync(join(at(name), "program.ts"), "utf-8").trim(),
    index: (name = "greet") => readFileSync(join(at(name), "history", "index.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line)).filter((line) => line.version).map(({ version, reason, contract, parent, from, aside }) => [version, reason, contract ?? null, ...(parent !== undefined ? [`of ${parent}`] : []), ...(from !== undefined ? [`from ${from}`] : []), ...(aside ? ["beside"] : [])]),
    /** The contracts kept with a project's versions: by their marks, as they were written. */
    kept: (name = "greet") => { const dir = join(at(name), "history", "contracts"); return existsSync(dir) ? Object.fromEntries(readdirSync(dir).sort().map((file) => [file.replace(/\.json$/, ""), readJson(join(dir, file))])) : {}; },
    lines: (name = "greet") => (existsSync(join(at(name), "history", "runs.jsonl")) ? readFileSync(join(at(name), "history", "runs.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line)) : []),
    history: (name = "greet") => withEnv({ HOME: fakeHome }, () => readHistory(at(name))),
    run: (options = {}, name = "greet") => heard(() => runProgram({ projectDir: at(name), timeout: 30_000, ...options })),
  };
}

test("a version is a program and what its project took and gave when it was made: the text of that is kept with it, by its mark — and what a project takes and gives, changed by hand, is a version found when it is next run, as a program changed by hand is", async (t) => {
  const it = homeWith(t);
  assert.deepEqual((await it.run()).result, { status: "done", result: { greeting: "Hello, world!" } });
  assert.deepEqual([it.index(), it.kept(), (await it.history()).current], [[[1, "found", markOf(A)]], { [markOf(A)]: A }, 1]);

  // Changed by hand: the project as it is, is on no record — until it is run, and then it is one: the same program, under what it says now.
  it.byHand(C);
  assert.equal((await it.history()).current, undefined);
  assert.deepEqual((await it.run({ args: { loud: "true" } })).result.status, "done");
  assert.deepEqual([it.index(), it.kept(), (await it.history()).current, it.lines().map((line) => line.version)], [[[1, "found", markOf(A)], [2, "found", markOf(C)]], { [markOf(A)]: A, [markOf(C)]: C }, 2, [1, 2]]);
  // (Two versions of one text: told apart by what each was made under, on its line.)
  const texts = readFileSync(join(it.at("greet"), "history", "index.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line).sha256);
  assert.equal(texts[0], texts[1]);
  // What it is for, and anything else of the file, is no part of a version: changed, the project is the version it was.
  it.byHand({ description: "Greets, by name.", note: "of the owner's own" });
  await it.run();
  assert.deepEqual([it.index().length, (await it.history()).current, it.lines().at(-1).version], [2, 2, 2]);
  // Put back by hand as it was: a version found again — the project is what it is now, and that is the latest on record.
  it.byHand(A);
  await it.run();
  assert.deepEqual([it.index().at(-1), (await it.history()).current, Object.keys(it.kept()).length], [[3, "found", markOf(A)], 3, 2]);

  // What cannot be read as shapes says nothing against the version the project is: no version is made of it, and its run is refused as it ever was.
  it.byHand({ parameters: "no shape at all" });
  assert.equal((await it.history()).current, 3);
  await assert.rejects(it.run(), /Malformed meta\.json/);
  assert.equal(it.index().length, 3);

  // A project that says nothing of what it takes and gives: its versions have no mark, and nothing is kept.
  await it.run({}, "plain");
  assert.deepEqual([it.index("plain"), it.kept("plain")], [[[1, "found", null]], {}]);
});

test("whoever asks for an update may say what the project is to take and give from then on: whoever writes is told it and cannot change it, the new program is validated under it, and the two are the project's together — or neither is", async (t) => {
  const it = homeWith(t);
  await it.run();
  const before = it.metaText();
  it.writes(WITH_LETTERS);
  const updated = await it.heard(() => updateProject("greet", "Also give how many letters the name has, as letters.", { returns: B.returns }));
  assert.deepEqual(updated.result, { version: 2 });
  // What was said is the project's; what was not said is as it was — what it takes, what it is for, what it is started with.
  const { description, input } = it.meta();
  assert.deepEqual([it.says(), description, input, it.program()], [B, "Greets by name.", { prompt: "Greet whoever is named.", args: {} }, WITH_LETTERS.trim()]);
  assert.deepEqual([it.index(), it.kept(), (await it.history()).current], [[[1, "found", markOf(A)], [2, "update", markOf(B), "of 1"]], { [markOf(A)]: A, [markOf(B)]: B }, 2]);
  // The writer was told what the program is to be held to: the new one.
  assert.match(it.asked[0].system, /What the project says it takes and gives \(its meta\.json\): the program is held to it[^]*"letters": "number"/);
  // And it is said, to whoever asked.
  assert.equal(updated.logged.filter((line) => /greet takes and gives otherwise from version 2 on \(trama describe greet\)\./.test(line)).length, 1, updated.logged.join("\n"));
  const ran = await it.run({ args: { name: "Alice" } });
  assert.deepEqual([ran.result, ran.warned.filter((line) => LEFT_OUT.test(line))], [{ status: "done", result: { greeting: "Hello, Alice!", letters: 5 } }, []]);
  assert.deepEqual((await withEnv({ HOME: it.fakeHome }, () => describeProject("greet"))).returns, B.returns);

  // A program that does not fit what was said is no update: the project says what it said, to the letter, and has the program it had.
  const not = homeWith(t);
  await not.run();
  not.writes(GREETS());
  await assert.rejects(not.heard(() => updateProject("greet", "Also give letters.", { returns: B.returns })), /Update failed — the program is unchanged\.[^]*The result does not fit what [^\n]* gives — missing key: letters/);
  assert.deepEqual([not.metaText(), not.program(), not.index()], [before, GREETS().trim(), [[1, "found", markOf(A)]]]);
  // What is no shape, or requires what the project is not started with, is refused before a model is asked.
  await assert.rejects(not.heard(() => updateProject("greet", "p", { returns: { a: "text" } })), /Update failed — the program is unchanged\.\nWhat "greet" is to take and give cannot be read — "returns": Schema validation failed: unsupported schema type "text" for key "a"/);
  await assert.rejects(not.heard(() => updateProject("greet", "p", { parameters: { name: "string" } })), /takes — missing key: name\.[^\n]*\nA project is validated by a run of it with the arguments it is made with/);
  assert.deepEqual([not.asked.length, not.metaText()], [1, before]);

  // What whoever writes did to meta.json where it worked is put back to what was said, and none of it is the project's.
  const meddles = homeWith(t);
  await meddles.run();
  llm.ask = async (_prompt, call) => { writeFileSync(join(call.cwd, "meta.json"), JSON.stringify({ input: { prompt: "p", args: {} }, returns: { greeting: "string", letters: "string" } })); return WITH_LETTERS; };
  const held = await meddles.heard(() => updateProject("greet", "Also give letters.", { returns: B.returns }));
  assert.deepEqual([held.result, meddles.says(), held.warned.filter((line) => /meta\.json was changed in the copy that was worked in/.test(line)).length], [{ version: 2 }, B, 1]);

  // Saying what the project says already is an update like any; and where nothing is said of it, as it ever was.
  // (And leaves the project's meta.json to the letter as it is: one written by hand, in a manner of its own, is not written again for it.)
  writeFileSync(join(it.at("greet"), "meta.json"), JSON.stringify(it.meta()));
  const asWritten = it.metaText();
  it.writes(WITH_LETTERS.replace("Hello", "Hallo"), WITH_LETTERS.replace("Hello", "Hullo"));
  const same = await it.heard(() => updateProject("greet", "Say Hallo.", { returns: B.returns, description: "Greets by name." }));
  assert.equal(it.metaText(), asWritten);
  const plain = await it.heard(() => updateProject("greet", "Say Hullo."));
  assert.equal(it.metaText(), asWritten);
  assert.deepEqual([same.result, plain.result, it.index().slice(2), [...same.logged, ...plain.logged].filter((line) => /takes and gives otherwise/.test(line))], [{ version: 3 }, { version: 4 }, [[3, "update", markOf(B), "of 2"], [4, "update", markOf(B), "of 3"]], []]);
  // What it is for can be said anew with it: the project's word, and no part of a version.
  it.writes(WITH_LETTERS);
  await it.heard(() => updateProject("greet", "Say Hello again.", { description: "Greets by name, and counts its letters." }));
  assert.deepEqual([it.meta().description, it.index().at(-1)], ["Greets by name, and counts its letters.", [5, "update", markOf(B), "of 4"]]);

  // What the project took and gave, where it was changed by hand and is on no record yet, is put on record before another is put in its place.
  it.byHand(C);
  it.writes(WITH_LETTERS.replace("Hello", "Hey"));
  const D = { parameters: C.parameters, returns: B.returns };
  assert.deepEqual((await it.heard(() => updateProject("greet", "Say Hey.", { returns: B.returns }))).result, { version: 7 });
  assert.deepEqual([it.index().slice(5), it.kept()[markOf(C)], it.says()], [[[6, "found", markOf(C)], [7, "update", markOf(D), "of 6"]], C, D]);
  // And an update that says nothing of it, of a project changed so by hand: written from the program it was — a program
  // is written from a program — and made under what the project says now, which is kept with it.
  it.byHand(A);
  it.writes(GREETS().replace("Hello", "Hi"));
  assert.deepEqual((await it.heard(() => updateProject("greet", "Say Hi."))).result, { version: 8 });
  assert.deepEqual([it.index().at(-1), it.says(), (await it.history()).current], [[8, "update", markOf(A), "of 7"], A, 8]);
});

test("a version kept beside the program is on record under what it was made to take and give, where that is said: the project is not touched — by an update that is not installed, and by a text handed over", async (t) => {
  const it = homeWith(t);
  await it.run();
  const before = it.metaText();
  it.writes(WITH_LETTERS);
  assert.deepEqual((await it.heard(() => updateProject("greet", "Also give letters.", { returns: B.returns, install: false }))).result, { version: 2 });
  assert.deepEqual((await it.heard(() => addVersion("greet", WITH_LETTERS.replace("Hello", "Hola"), { returns: B.returns, detail: "in Spanish" }))).result, { version: 3 });
  assert.deepEqual((await it.heard(() => addVersion("greet", GREETS().replace("Hello", "Hola")))).result, { version: 4 });
  assert.deepEqual([it.index(), it.kept(), it.metaText(), it.program(), (await it.history()).current],
    [[[1, "found", markOf(A)], [2, "update", markOf(B), "of 1", "beside"], [3, "update", markOf(B), "of 1", "beside"], [4, "update", markOf(A), "of 1", "beside"]], { [markOf(A)]: A, [markOf(B)]: B }, before, GREETS().trim(), 1]);
  // A text that does not fit what it is handed over under is no version; nor is one handed over under what is no shape.
  await assert.rejects(it.heard(() => addVersion("greet", GREETS(), { returns: B.returns })), /The version is not put on record\.[^]*missing key: letters/);
  await assert.rejects(it.heard(() => addVersion("greet", GREETS(), { parameters: "string" })), /The version is not put on record\.\nWhat "greet" is to take and give cannot be read — "parameters" is what the project takes/);
  assert.deepEqual([it.index().length, it.metaText()], [4, before]);

  // A run of a version is held to what the version was made under, and not to what the project says now: what it gives — and what it takes.
  const ofTwo = await it.run({ version: 2, args: { name: "Ada" } });
  assert.deepEqual([ofTwo.result, ofTwo.warned.filter((line) => LEFT_OUT.test(line))], [{ status: "done", result: { greeting: "Hello, Ada!", letters: 3 } }, []]);
  const KIND = `import { ctx } from "@trama-dev/runtime";\nconst { n } = ctx.input.args as { n?: number };\nawait ctx.done({ greeting: typeof n + " " + Object.keys(ctx.input.args).join(",") });\n`;
  const TAKES_N = { parameters: { "n?": "number" }, returns: A.returns };
  assert.deepEqual((await it.heard(() => addVersion("greet", KIND, TAKES_N))).result, { version: 5 });
  const ofFive = await it.run({ version: 5, args: { n: "3", name: "Ada" } });
  assert.deepEqual(ofFive.result, { status: "done", result: { greeting: "number n" } });
  assert.equal(ofFive.warned.filter((line) => /takes no argument "name": left out\. It takes: n\?\./.test(line)).length, 1, ofFive.warned.join("\n"));
  // (Whoever checks such a run is handed what it was asked with, held as the version takes it.)
  createProjectFixture(it.at("judge"), { programSource: `import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ ok: true, notes: JSON.stringify((ctx.input.args as any).args) });\n` });
  assert.equal((await it.run({ version: 5, args: { n: "3", name: "Ada" }, checkWith: it.at("judge") })).result.check.notes, JSON.stringify({ n: 3, name: "Ada" }));
  // (The program, run as it is, is held to what the project says: as it was.)
  assert.deepEqual((await it.run({ args: { name: "Ada" } })).result.result, { greeting: "Hello, Ada!" });

  // Gone to, a version is the program with what it was made under: and a version of before is then run under what it was made under, still.
  assert.deepEqual((await it.heard(() => rollbackProject("greet", 2))).result, { version: 6, from: 2, contract: "back" });
  assert.deepEqual([it.says(), it.program(), it.index().at(-1)], [B, WITH_LETTERS.trim(), [6, "rollback", markOf(B), "from 2"]]);
  const ofOne = await it.run({ version: 1, args: { name: "Ada" } });
  assert.deepEqual(ofOne.result, { status: "done", result: { greeting: "Hello, Ada!" } });
  // And a replay of that run is of that version, under what it was held to.
  const replayed = (await it.heard(() => replayProgram({ projectDir: it.at("greet"), run: it.lines().at(-1).run }))).result;
  assert.deepEqual([replayed.sameProgram, replayed.result], [true, { status: "done", result: { greeting: "Hello, Ada!" } }]);
});

test("going back to a version goes back to what the project took and gave when it was made, and says so — or, where that is on no record, to the program alone, and says that", async (t) => {
  const it = homeWith(t);
  await it.run();
  it.writes(WITH_LETTERS);
  await it.heard(() => updateProject("greet", "Also give letters.", { returns: B.returns, description: "Greets, and counts." }));

  const back = await it.heard(() => rollbackProject("greet", 1));
  assert.deepEqual(back.result, { version: 3, from: 1, contract: "back" });
  assert.match(back.logged.join("\n"), /greet is at version 1 again, as version 3, and takes and gives what it did when that was made\. The program was not run, and nothing else of the project was changed\./);
  // The program and what it is held to — and nothing else: what the project is for is as it was said last.
  assert.deepEqual([it.says(), it.program(), it.meta().description, it.meta().input, it.index().at(-1), (await it.history()).current], [A, GREETS().trim(), "Greets, and counts.", { prompt: "Greet whoever is named.", args: {} }, [3, "rollback", markOf(A), "from 1"], 3]);
  // So the version of before runs as it did: nothing fails, nothing is fixed, nothing is left out.
  const ran = await it.run({ args: { name: "Ada" }, maxRepairAttempts: 1 });
  assert.deepEqual([ran.result, it.index().length, ran.warned.filter((line) => LEFT_OUT.test(line))], [{ status: "done", result: { greeting: "Hello, Ada!" } }, 3, []]);
  // And forth again; and where the project is that already, nothing is changed.
  assert.deepEqual((await it.heard(() => rollbackProject("greet", 2))).result, { version: 4, from: 2, contract: "back" });
  assert.deepEqual([it.says(), it.program()], [B, WITH_LETTERS.trim()]);
  assert.deepEqual((await it.heard(() => rollbackProject("greet", 2))).result, { unchanged: true, version: 4 });
  // Where what a version was made under is what the project says, it is the program that is gone back to, as it ever was — and no more is said.
  it.writes(WITH_LETTERS.replace("Hello", "Hallo"));
  await it.heard(() => updateProject("greet", "Say Hallo."));
  const plain = await it.heard(() => rollbackProject("greet", 4));
  assert.deepEqual([plain.result, /takes and gives/.test(plain.logged.join("\n"))], [{ version: 6, from: 4 }, false]);

  // A version of the program's own text, made under something else: gone to, the project takes and gives that.
  assert.deepEqual((await it.heard(() => addVersion("greet", it.program(), { parameters: C.parameters }))).result, { version: 7 });
  assert.deepEqual((await it.heard(() => rollbackProject("greet", 7))).result, { version: 8, from: 7, contract: "back" });
  assert.deepEqual([it.says(), it.program()], [{ parameters: C.parameters, returns: B.returns }, WITH_LETTERS.trim()]);

  // What a version was made under is on no record (its text was not kept, as of versions made before texts were): the program alone, and it is said.
  // (Nor is what is kept under its mark and is not what the mark is of: that is not what the version was made under.)
  writeJson(join(it.at("greet"), "history", "contracts", `${markOf(A)}.json`), B);
  assert.equal((await it.heard(() => rollbackProject("greet", 1))).result.contract, "unknown");
  assert.deepEqual((await it.heard(() => rollbackProject("greet", 8))).result, { version: 10, from: 8 });
  rmSync(join(it.at("greet"), "history", "contracts", `${markOf(A)}.json`));
  const alone = await it.heard(() => rollbackProject("greet", 1));
  assert.deepEqual([alone.result, it.says(), it.program()], [{ version: 11, from: 1, contract: "unknown" }, { parameters: C.parameters, returns: B.returns }, GREETS().trim()]);
  assert.match(alone.logged.join("\n"), /greet is at version 1 again, as version 11\. What the project took and gave when version 1 was made is on no record: it takes and gives what it did before this\./);

  // A version made when the project said nothing of what it takes and gives: gone back to, the project says nothing of it again.
  await it.run({}, "plain");
  it.byHand(A, "plain");
  await it.run({}, "plain");
  assert.deepEqual(it.index("plain"), [[1, "found", null], [2, "found", markOf(A)]]);
  assert.deepEqual((await it.heard(() => rollbackProject("plain", 1))).result, { version: 3, from: 1, contract: "back" });
  assert.deepEqual([it.says("plain"), "parameters" in it.meta("plain"), it.index("plain").at(-1)], [{}, false, [3, "rollback", null, "from 1"]]);
  assert.deepEqual((await it.heard(() => rollbackProject("plain", 2))).result, { version: 4, from: 2, contract: "back" });
  assert.deepEqual(it.says("plain"), A);
});

/** A writer that is a project: it writes a program that gives letters where the copy it works in says the project gives them. */
const WRITER = `import { ctx, workspace } from "@trama-dev/runtime";
const { prompt } = ctx.input.args as { prompt?: string };
if (prompt === undefined) await ctx.done({});
else {
  const gives = JSON.parse(await workspace.read("meta.json")).returns ?? {};
  await ctx.done({ program: ${JSON.stringify(GREETS("MORE"))}.replace("MORE", "letters" in gives ? ", letters: name.length" : "") });
}
`;
/** A program that has a project's contract changed, a version made under another, and the first gone back to: by its runner. */
const ASKS = `import { ctx } from "@trama-dev/runtime";
import { addVersion, rollbackProject, updateProject } from "@trama-dev/runtime/runner";
const { text } = ctx.input.args as { text: string };
const updated = await updateProject("greet", "Also give letters.", { updateWith: "writer", returns: { greeting: "string", letters: "number" } });
const beside = await addVersion("greet", text, { returns: { greeting: "string" } });
const back = await rollbackProject("greet", 1);
let refused = "";
try { await updateProject("greet", "x", { nope: 1 } as any); } catch (err: any) { refused = String(err.message); }
await ctx.done({ updated, beside, back, refused });
`;

test("by the command line, and by a program's runner: trama update --contract, trama add-version --contract, and a rollback that says what it put back — and the history says where what a project takes and gives was changed", async (t) => {
  const it = homeWith(t);
  createProjectFixture(it.at("writer"), { programSource: WRITER, metaInput: { prompt: "the writer", args: {} } });
  createProjectFixture(it.at("asks"), { programSource: ASKS, metaInput: { prompt: "asks", args: {} } });
  const trama = (...args) => runNodeCommand([join(REPO_ROOT, "packages", "cli", "dist", "index.js"), ...args], { cwd: it.fakeHome, env: { ...process.env, HOME: it.fakeHome } });
  writeJson(join(it.fakeHome, "b.json"), { returns: B.returns });
  assert.equal((await trama("run", "greet")).exitCode, 0);

  const updated = await trama("update", "greet", "Also give letters.", "--with", "writer", "--contract", "b.json");
  assert.equal(updated.exitCode, 0, updated.stderr);
  assert.match(updated.stdout, /Updated greet\.[^]*greet takes and gives otherwise from version 2 on \(trama describe greet\)\./);
  // (The writer found what was said in the copy it worked in, and wrote to it.)
  assert.deepEqual([it.says(), it.program()], [B, WITH_LETTERS.trim()]);
  assert.deepEqual(JSON.parse((await trama("run", "greet", "--arg", "name=Ada", "--json")).stdout).result, { greeting: "Hello, Ada!", letters: 3 });
  writeFileSync(join(it.fakeHome, "es.ts"), GREETS().replace("Hello", "Hola"));
  writeJson(join(it.fakeHome, "a.json"), { returns: A.returns });
  const added = await trama("add-version", "greet", "es.ts", "--contract", "a.json");
  assert.match(added.stdout, /Version 3 of greet is on record/, added.stderr);
  assert.deepEqual(JSON.parse((await trama("run", "greet", "--at-version", "3", "--arg", "name=Ada", "--json")).stdout).result, { greeting: "Hola, Ada!" });
  const back = await trama("rollback", "greet", "1");
  assert.match(back.stdout, /greet is at version 1 again, as version 4, and takes and gives what it did when that was made\./, back.stderr);
  assert.deepEqual([it.says(), it.program()], [A, GREETS().trim()]);
  // The history says of each version where it was made under something else than the one before it.
  const lines = (await trama("history", "greet")).stdout.split("\n").filter((line) => /^v\d/.test(line));
  assert.deepEqual(lines.map((line) => [line.split(" ")[0], /takes and gives otherwise than v(\d+)/.exec(line)?.[1] ?? null]), [["v1", null], ["v2", "1"], ["v3", "2"], ["v4", null]]);
  // A file that is no contract is refused before anything is done.
  writeFileSync(join(it.fakeHome, "none.json"), JSON.stringify({ returns: B.returns, retruns: {} }));
  assert.match((await trama("update", "greet", "x", "--contract", "none.json")).stderr, /--contract: "retruns" is none of "description", "parameters", "returns"\./);
  assert.match((await trama("add-version", "greet", "es.ts", "--contract", "none.json")).stderr, /--contract: "retruns" is none of/);

  // And where what it takes and gives was changed by hand since: that the project as it is, is on no record yet.
  it.byHand(C);
  assert.match((await trama("history", "greet")).stdout, /\nWhat greet takes and gives was changed by hand after version 4: the project as it is now is on no record, and is recorded when it is next run\.\n$/);
  it.byHand(A);

  // A program asks its runner for the same: what it is told is what was done.
  const asked = await it.run({ args: { text: GREETS().replace("Hello", "Salut") }, timeout: 60_000 }, "asks");
  assert.equal(asked.result.status, "done", JSON.stringify(asked.result));
  const { updated: made, beside, back: went, refused } = asked.result.result;
  assert.deepEqual([made, beside, went, it.says(), it.program()], [{ version: 5 }, { version: 6 }, { version: 7, from: 1, contract: "back" }, A, GREETS().trim()]);
  assert.match(refused, /Unknown field: nope \(this call takes: name, prompt, from, install, updateWith, description, parameters, returns, id\)/);
});
