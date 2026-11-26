import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { llm } from "./fake-llm.mjs";
import { addVersion, readHistory, replayProgram, rollbackProject, runProgram, updateProject } from "../packages/runtime/dist/index.js";
import { REPO_ROOT, captureConsole, cleanupTempDir, createProjectFixture, makeTempDir, runNodeCommand, withEnv, writeJson } from "./helpers.mjs";

// The history as an archive: a version can be put on record without becoming the program — written by the
// runner's writer, from the program or from a version that is named, or handed over as a text — and a run can
// be of any version, by its number. Which of them is the program is one fact among them: `current`.
// So a version is held against another without either being installed for it, and a project is never left
// holding a program that was not yet judged.

const hashOf = (text) => createHash("sha256").update(text).digest("hex");
const quietly = (fn) => captureConsole("warn", () => captureConsole("log", fn)).then(({ result }) => result);
const SAYS = (n, more = "") => `import { ctx } from "@trama-dev/runtime";
const { add } = ctx.input.args as { add?: number };
${more}await ctx.done({ n: ${n} + (add ?? 0) });
`;
const [ONE, TWO, THREE, FOUR, FIVE, SIX] = [1, 2, 3, 4, 5, 6].map((n) => SAYS(n));

function homeWith(t, projects) {
  const fakeHome = makeTempDir("trama-archive-home-");
  t.after(() => cleanupTempDir(fakeHome));
  writeJson(join(fakeHome, ".trama", "config.json"), { maxRepairAttempts: 0 });
  const at = (name) => join(fakeHome, ".trama", "projects", name);
  for (const [name, { program, args = {}, more = {} }] of Object.entries(projects)) {
    createProjectFixture(at(name), { programSource: program, metaInput: { prompt: `the ${name}`, args } });
    if (Object.keys(more).length > 0) writeJson(join(at(name), "meta.json"), { input: { prompt: `the ${name}`, args }, ...more });
  }
  const inHome = (fn) => withEnv({ HOME: fakeHome }, () => quietly(fn));
  // What the writer is asked, and what it answers: one text at each asking.
  const asked = [];
  const original = { ...llm };
  const writes = (...texts) => { llm.ask = async (prompt, call) => { asked.push({ prompt, system: call.system }); return texts.shift() ?? assert.fail("the writer was asked once more than the test provided for"); }; };
  t.after(() => { Object.assign(llm, original); });
  return {
    fakeHome, at, inHome, asked, writes,
    program: (name) => readFileSync(join(at(name), "program.ts"), "utf-8"),
    index: (name) => readFileSync(join(at(name), "history", "index.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line)).map(({ timestamp: _timestamp, sha256: _sha256, ...line }) => line),
    lines: (name) => (existsSync(join(at(name), "history", "runs.jsonl")) ? readFileSync(join(at(name), "history", "runs.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line)) : []),
    journals: (name) => readdirSync(join(at(name), "logs", "journal")).sort().map((file) => readFileSync(join(at(name), "logs", "journal", file), "utf-8").trim().split("\n").map((line) => JSON.parse(line))),
    history: (name) => withEnv({ HOME: fakeHome }, () => readHistory(at(name))),
  };
}

test("a version is put on record without becoming the program: written by the runner's writer — from the program, or from a version that is named — or handed over as a text; and the program is the one it was", async (t) => {
  const it = homeWith(t, { words: { program: ONE } });
  const run = (options = {}) => it.inHome(() => runProgram({ projectDir: it.at("words"), timeout: 30_000, ...options })).then(({ result }) => result);
  assert.deepEqual((await run()).result, { n: 1 });

  // Written from the program as it is, and kept beside it.
  it.writes(TWO);
  assert.deepEqual((await it.inHome(() => updateProject("words", "say two", { install: false }))).result, { version: 2 });
  assert.equal(it.program("words"), ONE);
  assert.deepEqual(it.index("words"), [{ version: 1, reason: "found" }, { version: 2, reason: "update", parent: 1, aside: true, prompt: "say two" }]);
  assert.equal(readFileSync(join(it.at("words"), "history", "0002.ts"), "utf-8"), TWO.trim());
  // What the program is, is what it was: the version beside it is not "the latest" it is told against — and a run
  // of the project is a run of the program, which is on record already and is not put there again.
  let history = await it.history("words");
  assert.deepEqual([history.current, history.versions.map((version) => [version.version, version.aside ?? false, version.parent ?? null])], [1, [[1, false, null], [2, true, 1]]]);
  assert.deepEqual((await run()).result, { n: 1 });
  assert.deepEqual([it.index("words").length, it.lines("words").map((line) => line.version)], [2, [1, 1]]);

  // Written from a version that is named — which is not the program: the writer is shown that version's text.
  it.writes(THREE);
  assert.deepEqual((await it.inHome(() => updateProject("words", "say three", { from: 2, install: false }))).result, { version: 3 });
  assert.match(it.asked[1].system, /Current program\.ts:\n[^]*await ctx\.done\(\{ n: 2 \+ \(add \?\? 0\) \}\);/);
  assert.doesNotMatch(it.asked[1].system, /n: 1 \+/);
  assert.deepEqual(it.index("words")[2], { version: 3, reason: "update", parent: 2, aside: true, prompt: "say three" });
  assert.equal(it.program("words"), ONE);

  // Handed over as a text: no writer is asked. It is validated as an update's is — a text that does not run is no version.
  assert.deepEqual((await it.inHome(() => addVersion("words", FOUR, { parent: 1, detail: "written elsewhere" }))).result, { version: 4 });
  assert.deepEqual(it.index("words")[3], { version: 4, reason: "update", parent: 1, aside: true, prompt: "written elsewhere" });
  assert.equal(readFileSync(join(it.at("words"), "history", "0004.ts"), "utf-8"), FOUR);
  // (With no parent named, it is of the program as it is.)
  assert.deepEqual((await it.inHome(() => addVersion("words", FIVE))).result, { version: 5 });
  assert.deepEqual(it.index("words")[4], { version: 5, reason: "update", parent: 1, aside: true });
  await assert.rejects(it.inHome(() => addVersion("words", `throw new Error("no program at all");\n`)), /The version is not put on record\.[^]*no program at all/);
  await assert.rejects(it.inHome(() => addVersion("words", SIX, { parent: 9 })), /No version 9 is in the history of /);
  await assert.rejects(it.inHome(() => updateProject("words", "from nowhere", { from: 9, install: false })), /No version 9 is in the history of /);
  assert.deepEqual([it.index("words").length, it.asked.length, it.program("words")], [5, 2, ONE]);

  // An update as it was — installed — says which version it made; and can be written from a version named, too.
  it.writes(SIX);
  assert.deepEqual((await it.inHome(() => updateProject("words", "say six", { from: 3 }))).result, { version: 6 });
  assert.deepEqual([it.index("words")[5], it.program("words")], [{ version: 6, reason: "update", parent: 3, prompt: "say six" }, SIX.trim()]);
  history = await it.history("words");
  assert.equal(history.current, 6);
  // A version kept beside the program becomes the program as any version does: by being gone to.
  assert.deepEqual((await it.inHome(() => rollbackProject("words", 4))).result, { version: 7, from: 4 });
  assert.deepEqual([it.program("words"), (await it.history("words")).current, (await run()).result], [FOUR, 7, { n: 4 }]);
});

test("a run is of the version it names: that version's program, with the project as it is — the program is not touched, the run's line says which version it was of, and it is not fixed where it fails", async (t) => {
  // (The project says what it takes: a number given on a command line, where everything is text, is then the number.)
  const it = homeWith(t, { words: { program: ONE, more: { parameters: { "add?": "number" } } }, judge: { program: `import { ctx } from "@trama-dev/runtime";\nconst { result } = ctx.input.args as any;\nawait ctx.done({ ok: result.n > 1, score: result.n });\n` } });
  const run = (options = {}) => it.inHome(() => runProgram({ projectDir: it.at("words"), timeout: 30_000, ...options })).then(({ result }) => result);
  await run();
  await it.inHome(() => addVersion("words", TWO));
  const FAULTY = SAYS(3, `if (add === 13) throw new Error("the version has a fault");\n`);
  await it.inHome(() => addVersion("words", FAULTY));

  // The version's program is run: the project's is where it was, and on no new record.
  assert.deepEqual(await run({ version: 2, args: { add: 10 } }), { status: "done", result: { n: 12 } });
  assert.deepEqual((await run({ version: 1 })).result, { n: 1 });
  assert.deepEqual([it.program("words"), it.index("words").length, (await it.history("words")).current], [ONE, 3, 1]);
  assert.deepEqual(it.lines("words").map((line) => [line.version, line.status, "ended" in line]), [[1, "done", false], [2, "done", false], [1, "done", false]]);
  // Its record says which version it was of — and of which text.
  const journal = it.journals("words").at(-2);
  assert.equal(journal.find((record) => record.kind === "run").version, 2);
  assert.equal(journal.find((record) => record.kind === "attempt").program.sha256, hashOf(TWO));
  // Checked as any run is: the verdict is of that version's work.
  const checked = await run({ version: 2, checkWith: it.at("judge") });
  assert.deepEqual([checked.check.ok, checked.check.score, it.lines("words").at(-1).version, it.lines("words").at(-1).check.ok], [true, 2, 2, true]);

  // It fails: it is not fixed, whatever the run was allowed — a fix would be a version nobody asked for. (No fix is asked for, though one is there to be had.)
  let fixes = 0;
  llm.repair = async () => { fixes += 1; return SAYS(3); };
  const failed = await run({ version: 3, args: { add: 13 }, maxRepairAttempts: 2 });
  assert.deepEqual([failed.status, fixes], ["failed", 0]);
  assert.match(failed.reason, /the version has a fault/);
  assert.deepEqual([it.index("words").length, it.program("words"), it.lines("words").at(-1).version], [3, ONE, 3]);
  // A version there is none of is no run.
  await assert.rejects(run({ version: 7 }), /No version 7 is in the history of /);
  await assert.rejects(run({ version: 1.5 }), /A version is named by its number: 1 and up\./);

  // A version kept beside the program that has the program's very text is not what the program is: a run of the program is of the version the program is.
  assert.deepEqual((await it.inHome(() => addVersion("words", ONE))).result, { version: 4 });
  await run();
  assert.deepEqual([it.lines("words").at(-1).version, (await it.history("words")).current, it.index("words").length], [1, 1, 4]);

  // By the command line: --at-version.
  const cli = await runNodeCommand([join(REPO_ROOT, "packages", "cli", "dist", "index.js"), "run", "words", "--at-version", "2", "--arg", "add=1"], { env: { ...process.env, HOME: it.fakeHome } });
  assert.equal(cli.code ?? cli.exitCode ?? 0, 0, cli.stderr);
  assert.deepEqual([it.lines("words").at(-1).version, it.journals("words").at(-1).find((record) => record.kind === "call" && record.endpoint === "/ctx/done").request.result], [2, { n: 3 }]);

  // A run of a version says nothing of the program: one changed by hand since, and on no record, is on none after it.
  writeFileSync(join(it.at("words"), "program.ts"), SAYS(9));
  const versions = it.index("words").length;
  assert.deepEqual((await run({ version: 2 })).result, { n: 2 });
  assert.deepEqual([it.index("words").length, (await it.history("words")).current ?? null], [versions, null]);
});

/** A program that has versions made and run by its runner. */
const MAKES = `import { ctx } from "@trama-dev/runtime";
import { addVersion, readHistory, runProgram, updateProject } from "@trama-dev/runtime/runner";
const { words, text } = ctx.input.args as { words: string; text: string };
const written = await updateProject("words", "say two", { install: false });
const handed = await addVersion("words", text, { parent: written.version, detail: "handed over" });
const ran = await runProgram({ projectDir: words, version: handed.version, maxRepairAttempts: 0 });
const history = await readHistory(words, { runs: 0 });
await ctx.done({ written, handed, ran: ran.result, current: history.current, beside: history.versions.filter((version) => version.aside).map((version) => version.version) });
`;

test("a program has versions made and run by its runner: on its run's record — and in a replay it is told what it was told, and nothing is made or run", async (t) => {
  const it = homeWith(t, { words: { program: ONE }, maker: { program: MAKES } });
  await it.inHome(() => runProgram({ projectDir: it.at("words"), timeout: 30_000 }));
  it.writes(TWO);
  const { result: ran } = await it.inHome(() => runProgram({ projectDir: it.at("maker"), args: { words: it.at("words"), text: THREE }, label: "maker", timeout: 60_000 }));
  assert.equal(ran.status, "done", ran.reason);
  assert.deepEqual(ran.result, { written: { version: 2 }, handed: { version: 3 }, ran: { n: 3 }, current: 1, beside: [2, 3] });
  assert.deepEqual(it.index("words").map((line) => [line.version, line.parent ?? null, line.aside ?? false]), [[1, null, false], [2, 1, true], [3, 2, true]]);
  const calls = it.journals("maker").at(-1).filter((record) => record.kind === "call").map((record) => [record.endpoint, record.request.install ?? null, record.request.version ?? null]);
  assert.deepEqual(calls.filter(([endpoint]) => endpoint !== "/ctx/done"), [["/project/update", false, null], ["/project/version", null, null], ["/run/program", null, 3], ["/project/history", null, null]]);

  // Replayed: the same, and the project it worked on is as it was — no version more, no run more.
  const before = [it.index("words").length, it.lines("words").length, it.asked.length];
  const run = readdirSync(join(it.at("maker"), "logs", "journal")).sort().at(-1).replace(/\.jsonl$/, "");
  const { result: replay } = await it.inHome(() => replayProgram({ projectDir: it.at("maker"), run }));
  assert.deepEqual([replay.same, replay.left ?? null], [true, null]);
  assert.deepEqual([it.index("words").length, it.lines("words").length, it.asked.length], before);
});

test("a version is run where its program runs: what is beside the program is beside it — a module its program imports by a relative path is found — and nothing of the run is left in the project; a replay of such a run is of that version", async (t) => {
  const WITH = (more, last = "") => `import { ctx } from "@trama-dev/runtime";\nimport { word } from "./lib.ts";\n${last}await ctx.done({ word: word${more} });\n`;
  const it = homeWith(t, { words: { program: WITH("") } });
  const project = it.at("words");
  writeFileSync(join(project, "lib.ts"), `export const word = "one";\n`);
  const run = (options = {}) => it.inHome(() => runProgram({ projectDir: project, timeout: 30_000, ...options })).then(({ result }) => result);
  assert.deepEqual(await run(), { status: "done", result: { word: "one" } });
  // Versions beside the program: one that says where its own file is, one with a fault, one more.
  const WHERE = `import { ctx } from "@trama-dev/runtime";\nimport { word } from "./lib.ts";\nawait ctx.done({ word: word + " more", at: new URL(".", import.meta.url).pathname });\n`;
  const FAULTY = WITH("", `if ((ctx.input.args as any).fail) throw new Error("the version has a fault");\n`);
  for (const [text, version] of [[WHERE, 2], [FAULTY, 3], [WITH(' + " again"'), 4]]) assert.deepEqual((await it.inHome(() => addVersion("words", text))).result, { version });
  const there = () => readdirSync(project).sort();
  const before = there();

  // Each is run as the program is: from the project's own directory, with what is beside the program beside it.
  assert.deepEqual(await run({ version: 2 }), { status: "done", result: { word: "one more", at: `${realpathSync(project)}/` } });
  assert.deepEqual((await run({ version: 1 })).result, { word: "one" });
  // Two at once, of two versions: each its own.
  const both = await it.inHome(() => Promise.all([2, 4].map((version) => runProgram({ projectDir: project, version, timeout: 30_000 }))));
  assert.deepEqual(both.result.map((ran) => ran.result.word), ["one more", "one again"]);
  // One that fails is a run that failed, as it was.
  const failed = await run({ version: 3, args: { fail: true } });
  assert.equal(failed.status, "failed");
  assert.match(failed.reason, /the version has a fault/);
  // Nothing of any of those runs is left in the project, and its program is the one it was.
  assert.deepEqual([there(), it.program("words"), readFileSync(join(project, "lib.ts"), "utf-8")], [before, WITH(""), `export const word = "one";\n`]);
  // What is beside the program is the project's, as it is when the version is run: not what was there when the version was made.
  writeFileSync(join(project, "lib.ts"), `export const word = "uno";\n`);
  assert.deepEqual((await run({ version: 4 })).result, { word: "uno again" });

  // A replay of a run that was of a version is of that version — whatever the program has been made since.
  const ofFour = it.lines("words").at(-1);
  assert.equal(ofFour.version, 4);
  writeFileSync(join(project, "program.ts"), `import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ word: "the program as it is now" });\n`);
  const replayed = (await it.inHome(() => replayProgram({ projectDir: project, run: ofFour.run }))).result;
  assert.deepEqual([replayed.sameProgram, replayed.result, replayed.recordedResult], [true, { status: "done", result: { word: "uno again" } }, { status: "done", result: { word: "uno again" } }]);
  // (One that names a program to replay is of the program it names, as before.)
  const named = (await it.inHome(() => replayProgram({ projectDir: project, run: ofFour.run, program: WITH(' + " named"') }))).result;
  assert.deepEqual([named.sameProgram, named.result.result], [false, { word: "uno named" }]);
  assert.deepEqual(there(), before);
});
