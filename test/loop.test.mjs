import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "crypto";
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { llm } from "./fake-llm.mjs";
import { inputMarkOf, readHistory, replayProgram, runProgram } from "../packages/runtime/dist/index.js";
import { rollbackTo, runProgram as runWithoutMaking, validateProgram } from "../packages/runtime/dist/runner.js";
import { createBackend } from "../packages/runtime/dist/runner-backend.js";
import { readHistory as historyOnFile } from "../packages/runtime/dist/history.js";
import { REPO_ROOT, captureConsole, cleanupTempDir, createProjectFixture, makeTempDir, readJson, withEnv, writeJson } from "./helpers.mjs";

// The loop, as a program: what a program needs of its runner to hold a project's versions against each other and
// keep the better — the project's history as its run's record has it, and a version gone back to — and a program
// that does it, examples/improve-by-check. The kernel has the facts and the two moves; which version is the
// better is said in the program, and nowhere else.

const hashOf = (text) => createHash("sha256").update(text).digest("hex");
const journalsOf = (projectDir) => {
  const dir = join(projectDir, "logs", "journal");
  return readdirSync(dir).sort().map((file) => readFileSync(join(dir, file), "utf-8").trim().split("\n").map((line) => JSON.parse(line)));
};
const indexOf = (projectDir) => readFileSync(join(projectDir, "history", "index.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
const linesOf = (projectDir) => readFileSync(join(projectDir, "history", "runs.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));

/** A home, with projects in it by name: each a program, and what its meta.json says it is started with. */
function homeWith(t, projects, config = { maxRepairAttempts: 0 }) {
  const fakeHome = makeTempDir("trama-loop-home-");
  t.after(() => cleanupTempDir(fakeHome));
  writeJson(join(fakeHome, ".trama", "config.json"), config);
  const at = (name) => join(fakeHome, ".trama", "projects", name);
  for (const [name, { program, args = {}, more = {} }] of Object.entries(projects)) {
    createProjectFixture(at(name), { programSource: program, metaInput: { prompt: `the ${name}`, args } });
    if (Object.keys(more).length > 0) writeJson(join(at(name), "meta.json"), { ...readJson(join(at(name), "meta.json")), ...more });
  }
  return { fakeHome, at };
}
/** What `fn` comes to, and what was said meanwhile — none of it shown. */
const quietly = (fn) => captureConsole("warn", () => captureConsole("log", fn)).then(({ result }) => result);

const ONE = `import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ n: (ctx.input.args as any).n ?? 1 });\n`;
const TWO = ONE.replace("?? 1", "?? 2");

const ASKS = `import { ctx } from "@trama-dev/runtime";
import { inputMarkOf, readHistory, resolveProject, rollbackProject } from "@trama-dev/runtime/runner";
const told = (err: any) => String(err.message);
const dir = resolveProject("target");
const before = await readHistory(dir);
const latest = await readHistory(dir, { runs: 1 });
const none = await readHistory(dir, { runs: 0 });
const mark = await inputMarkOf(dir, { n: 7 });
const went = await rollbackProject("target", 1);
const again = await rollbackProject("target", 1);
const noSuch = await rollbackProject("target", 9).then(() => "went", told);
const noNumber = await rollbackProject("target", 1.5).then(() => "went", told);
const missing = await rollbackProject("never-made", 1).then(() => "went", told);
const after = await readHistory(dir);
await ctx.done({ before, latest, none, mark, went, again, noSuch, noNumber, missing, after });
`;

test("a program reads a project's history, and goes back to a version of it, by its runner: on its run's record — and in a replay it is told what it was told, and nothing is gone back to", async (t) => {
  const { fakeHome, at } = homeWith(t, { target: { program: ONE, args: { base: 1 } }, asker: { program: ASKS } });
  const target = at("target");
  await withEnv({ HOME: fakeHome }, async () => {
    await quietly(() => runProgram({ projectDir: target, args: { n: 7 }, timeout: 30_000 }));
    writeFileSync(join(target, "program.ts"), TWO);
    await quietly(() => runProgram({ projectDir: target, timeout: 30_000 }));
    await quietly(() => runProgram({ projectDir: target, args: { n: 8 }, timeout: 30_000 }));
    const onFile = historyOnFile(target);
    assert.deepEqual([onFile.versions.length, onFile.runs.length, onFile.current], [2, 3, 2]);

    const { result: ran, messages } = await quietly(() => runProgram({ projectDir: at("asker"), label: "asker", timeout: 30_000 }));
    const { before, latest, none, mark, went, again, noSuch, noNumber, missing, after } = ran.result;
    // The history, as it is on file: all of it, or the latest of its runs.
    assert.deepEqual([before, latest, none], [onFile, { ...onFile, runs: onFile.runs.slice(-1) }, { ...onFile, runs: [] }]);
    // The mark of what a run is started with, by which the runs on record that were started with the same are found.
    assert.deepEqual([mark === onFile.runs[0].input, mark === onFile.runs[1].input, mark === onFile.runs[2].input], [true, false, false]);
    // Gone back to, as a new version; what is the program already is not; and what cannot be gone back to is said.
    assert.deepEqual([went, again], [{ version: 3, from: 1 }, { unchanged: true, version: 3 }]);
    assert.match(noSuch, /^trama runtime error: Error: No version 9 is in the history of .*target: `trama history <name>` shows those there are\.$/);
    assert.equal(noNumber, "trama runtime error: Error: A version is named by its number: 1 and up.");
    assert.equal(missing, 'trama runtime error: Error: Project "never-made" not found. Run `trama list` to see available projects.');
    assert.deepEqual([after.current, after.versions.at(-1).reason, after.versions.at(-1).from, after.runs], [3, "rollback", 1, onFile.runs]);
    assert.deepEqual([readFileSync(join(target, "program.ts"), "utf-8"), indexOf(target).length], [ONE, 3]);
    // Said under the name of the run that asked, as what a run has made is.
    for (const line of [
      "[asker] target is at version 1 again, as version 3. The program was not run, and nothing else of the project was changed.",
      "[asker] target is at version 3 already: nothing was changed.",
    ]) assert.ok(messages.includes(line), `${line}\n— not among:\n${messages.join("\n")}`);

    // Each is a call on the run's record.
    const [run] = journalsOf(at("asker"));
    const calls = run.filter((record) => record.kind === "call").map((record) => [record.endpoint, record.request.runs ?? record.request.version ?? record.request.args ?? null]);
    assert.deepEqual(calls, [["/project/history", null], ["/project/history", 1], ["/project/history", 0], ["/project/mark", { n: 7 }],
      ["/project/rollback", 1], ["/project/rollback", 1], ["/project/rollback", 9], ["/project/rollback", 1.5], ["/project/rollback", 1], ["/project/history", null], ["/ctx/done", null]]);

    // The project moves on. Replayed, the program is told what it was told then: it ends as it did, and the project is not touched.
    assert.deepEqual(rollbackTo(target, 2), { version: 4, from: 2 });
    const { result: replay } = await quietly(() => replayProgram({ projectDir: at("asker") }));
    assert.deepEqual([replay.same, replay.answered, replay.sameEnd, replay.left ?? null], [true, 10, true, null]);
    assert.deepEqual([indexOf(target).length, readFileSync(join(target, "program.ts"), "utf-8")], [4, TWO]);
  });
});

test("the mark of what a run is started with is of what its program is given: what the run was asked with, laid over what the project's own meta.json says", async (t) => {
  const { fakeHome, at } = homeWith(t, { target: { program: ONE, args: { base: 1, n: 3 } } });
  const target = at("target");
  await withEnv({ HOME: fakeHome }, async () => {
    // Outside a program it is told where it is asked.
    const [asked, same, laidOver, other] = await Promise.all([inputMarkOf(target, { n: 7 }), inputMarkOf(target, { n: 7, base: 1 }), inputMarkOf(target, { base: 1 }), inputMarkOf(target)]);
    assert.match(asked, /^[0-9a-f]{16}$/);
    assert.deepEqual([same === asked, laidOver === asked, other === asked, other === await inputMarkOf(target, { n: 3 })], [true, false, false, true]);
    await quietly(() => runProgram({ projectDir: target, args: { n: 7 }, timeout: 30_000 }));
    assert.equal(linesOf(target)[0].input, asked);
    // The project is to start its program with something else: runs asked for with the same are not runs of the same.
    writeJson(join(target, "meta.json"), { ...readJson(join(target, "meta.json")), input: { prompt: "the target", args: { base: 2, n: 3 } } });
    await quietly(() => runProgram({ projectDir: target, args: { n: 7 }, timeout: 30_000 }));
    assert.deepEqual([linesOf(target)[1].input === asked, linesOf(target)[1].input === await inputMarkOf(target, { n: 7 })], [false, true]);
    assert.deepEqual(await readHistory(target, { runs: 1 }), { ...historyOnFile(target), runs: historyOnFile(target).runs.slice(-1) });
  });
});

test("a candidate that would go back to a version is validated up to where it asks, having read what it read; and a runner that was given no way to change a project says so", async (t) => {
  const { fakeHome, at } = homeWith(t, { target: { program: ONE }, asker: { program: ONE } });
  const target = at("target");
  const GOES_BACK = `import { ctx } from "@trama-dev/runtime";
import { readHistory, resolveProject, rollbackProject } from "@trama-dev/runtime/runner";
const history = await readHistory(resolveProject("target"));
const went = await rollbackProject("target", 1).then((it) => it, (err: any) => String(err.message));
await ctx.done({ versions: history.versions.length, went });
`;
  await withEnv({ HOME: fakeHome }, async () => {
    await quietly(() => runProgram({ projectDir: target, timeout: 30_000 }));
    writeFileSync(join(target, "program.ts"), TWO);
    await quietly(() => runProgram({ projectDir: target, timeout: 30_000 }));

    const { messages } = await captureConsole("log", () =>
      validateProgram(at("asker"), createBackend({ provider: "fake", model: "plain" }), GOES_BACK, { timeout: 20_000, maxRepairAttempts: 0, maxIterations: 10, journalRuns: 20 }));
    assert.ok(messages.includes("[trama] validated up to where it has a project made or changed"), messages.join("\n"));
    const validation = journalsOf(at("asker")).at(-1);
    // (The history was read, and answered; the going back was asked, and is where the validation ended: never answered.)
    const answered = new Map(validation.filter((record) => record.kind === "result").map((record) => [record.seq, record.ok]));
    assert.deepEqual(validation.filter((record) => record.kind === "call").map((record) => [record.endpoint, answered.get(record.seq) ?? null]), [["/project/history", true], ["/project/rollback", null]]);
    assert.equal(validation.find((record) => record.kind === "exit").validated, "hand-off");
    assert.deepEqual([indexOf(target).length, readFileSync(join(target, "program.ts"), "utf-8")], [2, TWO]);

    // Run by a runner that has no way to make or change a project, it is told so — and has read the history all the same.
    writeFileSync(join(at("asker"), "program.ts"), GOES_BACK);
    const { result } = await captureConsole("log", () => runWithoutMaking({ projectDir: at("asker"), timeout: 30_000, maxRepairAttempts: 0 }));
    assert.deepEqual(result.result, { versions: 2, went: "trama runtime error: Error: This runner was not given a way to make projects, or change them: createProject, updateProject and rollbackProject are carried out where a run is started by way of @trama-dev/runtime/runner." });
    assert.equal(indexOf(target).length, 2);
  });
});

// --- examples/improve-by-check: one round of the loop, a run ---

/** A program that says a word in capitals where it knows the word; of others it says the beginning so (`half`), or nothing of the kind. */
const SAYS = (good, more = "word") => `import { ctx } from "@trama-dev/runtime";
const GOOD: string[] = ${JSON.stringify(good)};
const { word } = ctx.input.args as { word: string };
await ctx.done({ said: GOOD.includes(word) ? word.toUpperCase() : ${more} });
`;
const HALF = "word[0].toUpperCase() + word.slice(1)";
/** A judge with no model in it: good where the word is said in capitals, half as good where it begins so — and at a loss where it is handed BOOM. */
const JUDGE = `import { ctx } from "@trama-dev/runtime";
import { existsSync } from "node:fs";
const { result, args } = ctx.input.args as any;
if (result.said === "BOOM") throw new Error("the judge has a fault of its own");
// (A judge is its program and its project: with this file in it, it finds everything good.)
const whole = existsSync("lenient.txt") || result.said === args.word.toUpperCase(), begun = result.said[0] === args.word[0].toUpperCase();
await ctx.done({ ok: whole, score: whole ? 1 : begun ? 0.5 : 0, notes: whole ? "as it should be" : "it is to say " + args.word.toUpperCase() + ", and said " + result.said });
`;
const LOOP = readFileSync(join(REPO_ROOT, "examples", "improve-by-check", "program.ts"), "utf-8");
const [A, B, C, D] = ["a", "b", "c", "d"].map((word) => ({ word }));

/** A home with the project `words`, its judge — and another, lenient one — and the loop; and a model that writes `candidates`, one at each asking. */
function loopOver(t, first, candidates) {
  const home = homeWith(t, { words: { program: first, args: { word: "a" } }, judge: { program: JUDGE }, lenient: { program: JUDGE }, improve: { program: LOOP } });
  writeFileSync(join(home.at("lenient"), "lenient.txt"), "");
  const prompts = [];
  const original = llm.ask;
  llm.ask = async (prompt) => { prompts.push(prompt); return candidates[prompts.length - 1] ?? assert.fail("the model was asked once more than the test provided for"); };
  t.after(() => { llm.ask = original; });
  const words = home.at("words");
  const round = (args) => withEnv({ HOME: home.fakeHome }, () => quietly(() =>
    runProgram({ projectDir: home.at("improve"), args: { project: "words", check: "judge", ...args }, label: "improve", timeout: 60_000 })));
  return {
    ...home, words, prompts, round,
    program: () => readFileSync(join(words, "program.ts"), "utf-8"),
    versions: () => indexOf(words).filter((line) => line.version).map(({ version, reason, from }) => [version, reason, ...(from ? [from] : [])]),
    lines: () => (existsSync(join(words, "history", "runs.jsonl")) ? linesOf(words) : []),
  };
}

test("the loop keeps a version that is found better: it runs the program on each input, asks for an update with what was found wanting, runs the new one, and holds the two against each other", async (t) => {
  const it = loopOver(t, SAYS(["a"]), [SAYS(["a", "b"])]);
  // (One run is on record already, checked by the same judge: it is not paid for again.)
  await withEnv({ HOME: it.fakeHome }, () => quietly(() => runProgram({ projectDir: it.words, args: A, checkWith: it.at("judge"), timeout: 30_000 })));
  assert.equal(it.lines().length, 1);

  const { result: ran, messages } = await it.round({ inputs: [A, B], runs: 2, ask: "Say every word in capitals." });
  assert.deepEqual(ran, { status: "done", result: {
    kept: true, from: 1, to: 2, before: { ok: 2, of: 4, score: 0.5 }, after: { ok: 4, of: 4, score: 1 },
    why: "Version 2 is kept: 4 of 4 runs were found good where 2 of 4 were, at a mean score of 1 where it was 0.5.",
  } }, messages.join("\n"));
  assert.deepEqual([it.program(), it.versions()], [SAYS(["a", "b"]).trim(), [[1, "found"], [2, "update"]]]);
  // What the model was asked: what is wanted, and what was found wanting — of each input, once — and nothing of what was found good.
  assert.equal(it.prompts.length, 1);
  assert.equal(it.prompts[0].split("\n\nOutput the complete updated program.ts.")[0],
    'Say every word in capitals.\n\nRuns of the program as it is were checked, and these were found wanting:\n- started with {"word":"b"}: it is to say B, and said b');
  // The runs: three before (one of the four was there), four after — each checked, none fixed.
  assert.deepEqual(it.lines().map((line) => [line.version, line.check.ok]), [[1, true], [1, true], [1, false], [1, false], [2, true], [2, true], [2, true], [2, true]]);

  // A round more: everything it would ask is on record, and nothing is found wanting — no run, and no model.
  // (Told as a command line tells it: a list as JSON, a number as text.)
  const { result: again } = await it.round({ inputs: JSON.stringify([A, B]), runs: "2" });
  assert.deepEqual(again.result, { kept: false, from: 2, before: { ok: 4, of: 4, score: 1 }, why: "Nothing was asked for: no run that may be shown was found wanting, and no `ask` says what else is wanted." });
  assert.deepEqual([it.lines().length, it.prompts.length, it.versions().length], [8, 1, 2]);
  // (And of what is on record, as many as are asked for: not all there are.)
  assert.deepEqual((await it.round({ inputs: [A, B] })).result.result.before, { ok: 2, of: 2, score: 1 });

  // The round is a run like any: replayed, it goes the way it went, with nothing run and nothing changed.
  const journals = readdirSync(join(it.at("improve"), "logs", "journal")).sort();
  const { result: replay } = await withEnv({ HOME: it.fakeHome }, () => quietly(() => replayProgram({ projectDir: it.at("improve"), run: journals[0].replace(/\.jsonl$/, "") })));
  assert.deepEqual([replay.same, replay.sameEnd, replay.left ?? null, it.lines().length, it.versions().length], [true, true, null, 8, 2]);
});

test("the loop goes back where the new version is not found better: worse, or no better — and keeps one that is as often good and better by its score", async (t) => {
  for (const [what, candidate, after, kept, why] of [
    ["worse", SAYS([]), { ok: 0, of: 2, score: 0 }, false, "Version 1 is put back: 0 of 2 runs of version 2 were found good where 1 of 2 were."],
    ["no better", SAYS(["cd"]), { ok: 1, of: 2, score: 0.5 }, false, "Version 1 is put back: 1 of 2 runs of version 2 were found good as 1 of 2 were, at a mean score of 0.5 where it was 0.5 — no better, and the one before is the one that is known."],
    ["better by its score", SAYS(["ab"], HALF), { ok: 1, of: 2, score: 0.75 }, true, "Version 2 is kept: 1 of 2 runs were found good as 1 of 2 were, at a mean score of 0.75 where it was 0.5."],
    // (A run that fails is a run that was not found good, at no score: it does not drop out of the count.)
    ["a failing run", SAYS(["ab"], 'word === "cd" ? (() => { throw new Error("no cd"); })() : word'), { ok: 1, of: 2, score: 0.5 }, false, undefined],
  ]) {
    // (Words of two letters: one that begins in a capital is not all in capitals.)
    const it = loopOver(t, SAYS(["ab"]), [candidate]);
    const { result: ran, messages } = await it.round({ inputs: [{ word: "ab" }, { word: "cd" }] });
    const { why: said, ...rest } = ran.result;
    assert.deepEqual(rest, { kept, from: 1, to: 2, before: { ok: 1, of: 2, score: 0.5 }, after }, `${what}\n${messages.join("\n")}`);
    if (why) assert.equal(said, why, what);
    // Gone back to is a version more: the text of the one before, and nothing on record lost.
    assert.deepEqual([it.program(), it.versions()], kept ? [candidate.trim(), [[1, "found"], [2, "update"]]] : [SAYS(["ab"]), [[1, "found"], [2, "update"], [3, "rollback", 1]]], what);
    assert.equal(it.lines().length, 4, what);
  }

  // How often it was found good comes first: a version found good more often is kept, though its mean score is the lower.
  const often = loopOver(t, SAYS(["ab"], HALF), [SAYS(["ab", "cd"])]);
  const { result: more } = await often.round({ inputs: ["ab", "cd", "ef", "gh"].map((word) => ({ word })) });
  assert.deepEqual(more.result, {
    kept: true, from: 1, to: 2, before: { ok: 1, of: 4, score: 0.625 }, after: { ok: 2, of: 4, score: 0.5 },
    why: "Version 2 is kept: 2 of 4 runs were found good where 1 of 4 were, at a mean score of 0.5 where it was 0.625.",
  });
});

test("inputs held back decide, and are never shown: a version written to the inputs it was told of is not kept for them", async (t) => {
  for (const [candidate, kept, after] of [[SAYS(["a", "b"]), false, { ok: 0, of: 2, score: 0 }], [SAYS(["a", "b", "c", "d"]), true, { ok: 2, of: 2, score: 1 }]]) {
    const it = loopOver(t, SAYS(["a"]), [candidate]);
    const { result: ran } = await it.round({ inputs: [A, B], heldBack: [C, D] });
    const { why, ...rest } = ran.result;
    assert.deepEqual(rest, { kept, from: 1, to: 2, before: { ok: 0, of: 2, score: 0 }, after });
    assert.match(why, kept ? /^Version 2 is kept: 2 of 2 runs were found good where 0 of 2 were/ : /^Version 1 is put back: 0 of 2 runs of version 2 were found good as 0 of 2 were/);
    // Every input was run, before and after; what was held back is in no prompt.
    assert.equal(it.lines().length, 8);
    assert.deepEqual([/"word":"b"/.test(it.prompts[0]), /"word":"[cd]"|\b[CD]\b/.test(it.prompts[0])], [true, false], it.prompts[0]);
    assert.equal(it.program(), kept ? candidate.trim() : SAYS(["a"]));
  }
  // Without any held back, the same version is kept for what it was told.
  const shown = loopOver(t, SAYS(["a"]), [SAYS(["a", "b"])]);
  assert.equal((await shown.round({ inputs: [A, B] })).result.result.kept, true);
});

test("the loop stops without deciding where there is nothing to decide by — no update came of the asking, or a check could not be made — and the project's program is the one it was", async (t) => {
  // The model writes a program that does not run: the update comes to nothing.
  const unwritten = loopOver(t, SAYS(["a"]), [`throw new Error("not a program that runs");`]);
  const { result: failed } = await unwritten.round({ inputs: [A, B] });
  const { why, ...rest } = failed.result;
  assert.deepEqual(rest, { kept: false, from: 1, before: { ok: 1, of: 2, score: 0.5 } });
  assert.match(why, /^No update came of the asking: .*Update failed — the program is unchanged\./s);
  assert.deepEqual([unwritten.program(), unwritten.versions()], [SAYS(["a"]), [[1, "found"]]]);

  // The judge is at a loss over the new version: the one before is put back, and it is said why.
  const unjudged = loopOver(t, SAYS(["a"]), [SAYS(["a"], 'word === "b" ? "BOOM" : word')]);
  const { result: back } = await unjudged.round({ inputs: [A, B] });
  assert.deepEqual({ ...back.result, why: "" }, { kept: false, from: 1, to: 2, before: { ok: 1, of: 2, score: 0.5 }, why: "" });
  assert.match(back.result.why, /^Version 1 is put back: a check of version 2 could not be made — The project asked for the check failed: /);
  assert.deepEqual([unjudged.program(), unjudged.versions()], [SAYS(["a"]), [[1, "found"], [2, "update"], [3, "rollback", 1]]]);

  // The judge is at a loss over the program as it is: nothing is asked for, and nothing changed.
  const never = loopOver(t, SAYS([], '"BOOM"'), []);
  const { result: none } = await never.round({ inputs: [A] });
  assert.match(none.result.why, /^Nothing was changed: a check could not be made — The project asked for the check failed: /);
  assert.deepEqual([none.result.kept, never.prompts.length, never.versions()], [false, 0, [[1, "found"]]]);

  // What it is to be told: which project, which judge, and what to run it on. (Why it failed is in what it said as it did.)
  for (const [args, why] of [
    [{ project: undefined }, /It is not said which project to improve, or which checks it: "project" and "check", each by its name\./],
    [{ check: undefined }, /It is not said which project to improve, or which checks it/],
    [{ inputs: [] }, /It is not said what to run the project on: "inputs", a list of arguments\./],
    [{ inputs: "{}" }, /"inputs" is to be a list of arguments/],
    [{ heldBack: [1] }, /"heldBack" is to be a list of arguments/],
    [{ runs: 0 }, /"runs" is how many runs of each input: 1 or more\./],
    [{ runs: 1.5 }, /"runs" is how many runs of each input: 1 or more\./],
  ]) {
    const { result: refused } = await never.round({ inputs: [A], ...args });
    assert.equal(refused.status, "failed", JSON.stringify(args));
    assert.match(journalsOf(never.at("improve")).at(-1).findLast((record) => record.kind === "exit").stderr, why, JSON.stringify(args));
  }
});

test("a verdict on record is taken where it is this judge's, as the judge is now: not another judge's at another place, and not this one's from before its program was changed", async (t) => {
  const it = loopOver(t, SAYS(["a"]), [SAYS(["a"])]);
  const checked = (args, judge) => withEnv({ HOME: it.fakeHome }, () => quietly(() => runProgram({ projectDir: it.words, args, checkWith: it.at(judge), timeout: 30_000 })));
  // b was found good — by a judge that finds everything good: the same program, in another project.
  assert.equal((await checked(B, "lenient")).result.check.ok, true);
  // a was found wanting — by the judge as it was, before its program was changed to what it is. (Which has checked something since: it is on record as it is.)
  writeFileSync(join(it.at("judge"), "program.ts"), JUDGE.replace('existsSync("lenient.txt") ||', "false &&"));
  assert.equal((await checked(A, "judge")).result.check.ok, false);
  writeFileSync(join(it.at("judge"), "program.ts"), JUDGE);
  assert.equal((await checked(C, "judge")).result.check.ok, false);

  // Neither is this judge's word: both inputs are run, and judged by it.
  const { result: ran } = await it.round({ inputs: [A, B] });
  assert.deepEqual([ran.result.before, ran.result.kept], [{ ok: 1, of: 2, score: 0.5 }, false]);
  assert.deepEqual(it.lines().map((line) => [line.version, line.check.by === it.at("judge"), line.check.ok]),
    [[1, false, true], [1, true, false], [1, true, false], [1, true, true], [1, true, false], [2, true, true], [2, true, false]]);
});
