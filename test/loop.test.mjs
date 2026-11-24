import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
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
function loopOver(t, first, candidates, judge = JUDGE) {
  const home = homeWith(t, { words: { program: first, args: { word: "a" } }, judge: { program: judge }, lenient: { program: JUDGE }, improve: { program: LOOP } });
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

  // A version gone back to is the program it was, under another number: the verdicts on record of that program are
  // its verdicts still. The round after one that went back makes no run of it again — it asks for the next update.
  const back = loopOver(t, SAYS(["ab"]), [SAYS([]), SAYS(["ab", "cd"])]);
  const two = [{ word: "ab" }, { word: "cd" }];
  assert.equal((await back.round({ inputs: two })).result.result.kept, false);
  assert.deepEqual([back.versions(), back.lines().map((line) => line.version)], [[[1, "found"], [2, "update"], [3, "rollback", 1]], [1, 1, 2, 2]]);
  const { result: next } = await back.round({ inputs: two });
  assert.deepEqual({ ...next.result, why: "" }, { kept: true, from: 3, to: 4, before: { ok: 1, of: 2, score: 0.5 }, after: { ok: 2, of: 2, score: 1 }, why: "" });
  assert.deepEqual([back.lines().map((line) => line.version), back.prompts.length], [[1, 1, 2, 2, 4, 4], 2]);
  // (But not those of the program it was gone back from, which had the place between.)
  assert.match(back.prompts[1], /- started with \{"word":"cd"\}: it is to say CD, and said cd/);

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

// --- a harness over tasks: a project whose runs work in a workspace, each in a fresh copy of what it is to work on ---

test("a run that worked in a workspace is checked with it: the checker is handed where the work is, beside the copy of the project it has for its own workspace", async (t) => {
  const WORKS_THERE = `import { ctx, workspace } from "@trama-dev/runtime";
const there = await workspace.write("made.txt", "the work").then(() => true, () => false);
await ctx.done({ there });
`;
  const LOOKS = `import { ctx, workspace } from "@trama-dev/runtime";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const { workspace: where, ...rest } = ctx.input.args as any;
const made = typeof where === "string" ? readFileSync(join(where, "made.txt"), "utf-8") : "";
// (Its own workspace is the copy of the project, as ever: the project's program is there, and the work is not.)
const mine = await workspace.list("*");
await ctx.done({ ok: made === "the work", notes: JSON.stringify({ where: where ?? null, rest: Object.keys(rest).sort(), program: mine.includes("program.ts"), made: mine.includes("made.txt") }) });
`;
  const { fakeHome, at } = homeWith(t, { worker: { program: WORKS_THERE }, judge: { program: LOOKS } });
  const work = makeTempDir("trama-loop-work-");
  t.after(() => cleanupTempDir(work));
  await withEnv({ HOME: fakeHome }, async () => {
    const { result: there } = await quietly(() => runProgram({ projectDir: at("worker"), workspaceDir: work, checkWith: at("judge"), timeout: 30_000 }));
    assert.deepEqual([there.result, there.check.ok, JSON.parse(there.check.notes)], [{ there: true }, true, { where: work, rest: ["args", "journal", "result", "run", "used"], program: true, made: false }]);
    // A run that had no workspace has none to hand on.
    const { result: nowhere } = await quietly(() => runProgram({ projectDir: at("worker"), checkWith: at("judge"), timeout: 30_000 }));
    assert.deepEqual([nowhere.result, nowhere.check.ok, JSON.parse(nowhere.check.notes)], [{ there: false }, false, { where: null, rest: ["args", "journal", "result", "run", "used"], program: true, made: false }]);
  });
});

test("the loop over tasks: each run works in a fresh copy of what its input says, the runs are the worker's own and on its record, and nothing is left of the copies", async (t) => {
  // A worker that does its task in its workspace — and uses the task up: a second run in the same place would find nothing to do it from.
  const DOES = (well) => `import { ctx, workspace } from "@trama-dev/runtime";
const text = await workspace.read("in.txt");
await workspace.write("out.txt", ${well ? "text.toUpperCase()" : "text"});
await workspace.write("in.txt", "used up");
await ctx.done({ task: (ctx.input.args as any).task });
`;
  const JUDGES = `import { ctx } from "@trama-dev/runtime";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const { args, workspace } = ctx.input.args as any;
const out = readFileSync(join(workspace, "out.txt"), "utf-8"), wanted = ({ a: "ALPHA", b: "BETA" } as any)[args.task];
await ctx.done({ ok: out === wanted, score: out === wanted ? 1 : 0, notes: out === wanted ? "as it should be" : "out.txt is to be " + wanted + ", and is " + out });
`;
  const { fakeHome, at } = homeWith(t, { worker: { program: DOES(false), args: { task: "a" } }, judge: { program: JUDGES }, improve: { program: LOOP } });
  const tasks = makeTempDir("trama-loop-tasks-");
  t.after(() => cleanupTempDir(tasks));
  for (const [task, text] of [["a", "alpha"], ["b", "beta"]]) {
    mkdirSync(join(tasks, task, "deep"), { recursive: true });
    writeFileSync(join(tasks, task, "in.txt"), text);
    writeFileSync(join(tasks, task, "deep", "kept.txt"), "with the rest");
  }
  const prompts = [];
  const original = llm.ask;
  // (An update's candidate is validated in the worker's own project, where no workspace is: this one would fail there. It is given one that passes — as a harness has its own small piece of work.)
  const BETTER = `import { ctx, workspace } from "@trama-dev/runtime";
const text = await workspace.read("in.txt").catch(() => "");
await workspace.write("out.txt", text.toUpperCase()).catch(() => {});
await workspace.write("in.txt", "used up").catch(() => {});
await ctx.done({ task: (ctx.input.args as any).task });
`;
  llm.ask = async (prompt) => { prompts.push(prompt); return BETTER; };
  t.after(() => { llm.ask = original; });
  const round = (args) => withEnv({ HOME: fakeHome }, () => quietly(() =>
    runProgram({ projectDir: at("improve"), args: { project: "worker", check: "judge", inputs: [{ task: "a" }, { task: "b" }], runs: 2, from: join(tasks, "{task}"), ...args }, label: "improve", timeout: 90_000 })));

  // (Something is in the way where a copy is to be — what a round that was stopped left there: the copy is made in its place, not into it.)
  mkdirSync(join(at("improve"), "work", "v2-0-0"), { recursive: true });
  writeFileSync(join(at("improve"), "work", "v2-0-0", "stale.txt"), "left by a round that was stopped");

  const { result: ran, messages } = await round({});
  assert.deepEqual({ ...ran.result, why: "" }, { kept: true, from: 1, to: 2, before: { ok: 0, of: 4, score: 0 }, after: { ok: 4, of: 4, score: 1 }, why: "" }, messages.join("\n"));
  // Every run was the worker's, in a place of its own — eight runs, eight places — and each was judged where it had worked.
  const runs = journalsOf(at("worker")).filter((journal) => journal[0].purpose === "run");
  assert.deepEqual([runs.length, new Set(runs.map((journal) => journal[0].workspace)).size, linesOf(at("worker")).map((line) => [line.version, line.check.ok])],
    [8, 8, [[1, false], [1, false], [1, false], [1, false], [2, true], [2, true], [2, true], [2, true]]]);
  // (Each under the loop's own project, by a name that says which run it was for: the version, the input, the count.)
  assert.deepEqual(runs.map((journal) => journal[0].workspace.slice(join(realpathSync(at("improve")), "work").length)), ["/v0-0-0", "/v0-0-1", "/v0-1-0", "/v0-1-1", "/v2-0-0", "/v2-0-1", "/v2-1-0", "/v2-1-1"]);
  // What the copies were made from is as it was, and of the copies nothing is left.
  assert.deepEqual([readFileSync(join(tasks, "a", "in.txt"), "utf-8"), readFileSync(join(tasks, "b", "in.txt"), "utf-8"), existsSync(join(at("improve"), "work")) ? readdirSync(join(at("improve"), "work")) : []], ["alpha", "beta", []]);
  assert.match(prompts[0], /- started with \{"task":"b"\}: out\.txt is to be BETA, and is beta/);

  // A round more finds every verdict on record — where a run worked is no part of what it was started with — and runs nothing.
  const { result: again } = await round({});
  assert.deepEqual([again.result.kept, again.result.before, linesOf(at("worker")).length, prompts.length], [false, { ok: 4, of: 4, score: 1 }, 8, 1]);
  // And the first round, replayed, goes as it went: no copy is made for it, and nothing run.
  const journals = readdirSync(join(at("improve"), "logs", "journal")).sort();
  const { result: replay } = await withEnv({ HOME: fakeHome }, () => quietly(() => replayProgram({ projectDir: at("improve"), run: journals[0].replace(/\.jsonl$/, "") })));
  assert.deepEqual([replay.same, replay.sameEnd, replay.left ?? null, linesOf(at("worker")).length], [true, true, null, 8]);

  // What cannot be copied from is said, and so is a place that an input has no word for.
  for (const [from, why] of [[join(tasks, "nowhere", "{task}"), /A fresh copy of .*nowhere\/a could not be made/], [join(tasks, "{name}"), /"from" has \{name\}, and an input has no such argument to put there\./]]) {
    writeFileSync(join(at("worker"), "program.ts"), DOES(false)); // (another program: nothing of it is on record)
    const { result: refused } = await round({ from });
    assert.equal(refused.status, "failed", from);
    assert.match(journalsOf(at("improve")).at(-1).findLast((record) => record.kind === "exit").stderr, why);
  }
});

// --- a version found the better by what a run uses, with the work held good ---

test("a checker is handed what the run had used when its check began: the runner's own count, and nothing of what the check itself uses", async (t) => {
  const took = (tokens) => ({ model: "p/m", input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, cost: tokens / 1000 });
  const original = llm.complete;
  llm.complete = async (_request, call) => { call.used(took(500)); return { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" }; };
  t.after(() => { llm.complete = original; });
  const ASKS_TWICE = `import { ctx, agent } from "@trama-dev/runtime";
for (let turn = 0; turn < Number((ctx.input.args as any).turns ?? 2); turn++) await agent.complete({ messages: [{ role: "user", content: "turn " + turn }] });
await ctx.done({});
`;
  // (A judge that asks a model itself, before it looks: what it was handed is of the run, as it was when the check began.)
  const TELLS = `import { ctx, agent } from "@trama-dev/runtime";
await agent.complete({ messages: [{ role: "user", content: "what do you make of it?" }] });
await ctx.done({ ok: true, notes: JSON.stringify((ctx.input.args as any).used ?? null) });
`;
  const { fakeHome, at } = homeWith(t, { worker: { program: ASKS_TWICE }, judge: { program: TELLS } });
  await withEnv({ HOME: fakeHome }, async () => {
    const used = async (args) => JSON.parse((await quietly(() => runProgram({ projectDir: at("worker"), args, checkWith: at("judge"), timeout: 30_000 }))).result.check.notes);
    assert.deepEqual([await used({}), await used({ turns: 3 }), await used({ turns: 0 })], [{ calls: 2, tokens: 1000, cost: 1 }, { calls: 3, tokens: 1500, cost: 1.5 }, { calls: 0, tokens: 0, cost: 0 }]);
    // (The run's own line has the check's use with its own, as before: three requests, where the judge was told of two.)
    assert.deepEqual(linesOf(at("worker"))[0].used, { calls: 3, tokens: 1500, cost: 1.5 });
  });
});

/** A program that says what its run cost — by its word, or `*` — and whether it got it right. */
const SPENDS = (cost, wrong = []) => `import { ctx } from "@trama-dev/runtime";
const COST: Record<string, number> = ${JSON.stringify(cost)}, WRONG: string[] = ${JSON.stringify(wrong)};
const { word } = ctx.input.args as { word: string };
await ctx.done({ cost: COST[word] ?? COST["*"], right: !WRONG.includes(word) });
`;
/** One that is cheap for its first runs and dear after: what a few runs say of it, the next do not. */
const SLIDES = (first, then, after) => `import { ctx } from "@trama-dev/runtime";
const state = ctx.state as { slid?: number };
state.slid = (state.slid ?? 0) + 1;
await ctx.done({ cost: state.slid <= ${after} ? ${first} : ${then}, right: true });
`;
/** A judge of two things kept apart: whether the work is good, and — whatever it is — a score of what it used (the higher, the less). */
const WEIGHS = `import { ctx } from "@trama-dev/runtime";
const { result } = ctx.input.args as any;
await ctx.done({ ok: result.right, score: Number(Math.log(100 / result.cost).toFixed(4)), notes: "used " + result.cost + (result.right ? "" : ", and got it wrong") });
`;

test("by=score: a version is kept where its mean score is higher by more than the margin, and not a smaller part of all its runs — those of inputs that are shown too — were found good", async (t) => {
  const steady = { ok: 2, of: 2, score: 2.3026 };
  for (const [what, first, candidate, expected, otherwise] of [
    ["cheaper, and as right", SPENDS({ "*": 10 }), SPENDS({ "*": 5 }),
      { kept: true, before: steady, after: { ok: 2, of: 2, score: 2.9957 }, all: { before: { ok: 4, of: 4 }, after: { ok: 4, of: 4 } }, why: "Version 2 is kept: a mean score of 2.9957 where it was 2.3026, higher by more than 0.1; 4 of 4 runs of all inputs found good where 4 of 4 were." }, true],
    ["cheaper by less than the margin", SPENDS({ "*": 10 }), SPENDS({ "*": 9.5 }),
      { kept: false, before: steady, after: { ok: 2, of: 2, score: 2.3539 }, all: { before: { ok: 4, of: 4 }, after: { ok: 4, of: 4 } }, why: "Version 1 is put back: a mean score of 2.3539 where it was 2.3026, not higher by more than 0.1." }, true],
    // What is held back is all good, and cheaper: by that alone it would be kept. It is wrong where it was shown — and a run found wanting is one, wherever.
    ["cheaper, and wrong on an input that was shown", SPENDS({ "*": 10 }), SPENDS({ "*": 5 }, ["b"]),
      { kept: false, before: steady, after: { ok: 2, of: 2, score: 2.9957 }, all: { before: { ok: 4, of: 4 }, after: { ok: 3, of: 4 } }, why: "Version 1 is put back: 3 of 4 runs of version 2, all inputs counted, were found good where 4 of 4 were — a smaller part, input by input (0.75 where it was 1), whatever its score." }, true],
    // More often right, and dearer: by how often it is found good it would be kept whatever it used. Here the score decides, once no fewer are good.
    ["dearer, and more often right", SPENDS({ "*": 10 }, ["c"]), SPENDS({ "*": 20 }),
      { kept: false, before: { ok: 1, of: 2, score: 2.3026 }, after: { ok: 2, of: 2, score: 1.6094 }, all: { before: { ok: 3, of: 4 }, after: { ok: 4, of: 4 } }, why: "Version 1 is put back: a mean score of 1.6094 where it was 2.3026, not higher by more than 0.1." }, true],
  ]) {
    const it = loopOver(t, first, [candidate], WEIGHS);
    const { result: ran, messages } = await it.round({ inputs: [A, B], heldBack: [C, D], ask: "Use less.", by: "score", margin: "0.1" });
    assert.deepEqual(ran.result, { from: 1, to: 2, ...expected }, `${what}\n${messages.join("\n")}`);
    assert.deepEqual([it.program(), it.lines().length], [expected.kept ? candidate.trim() : first, 8], what);
    // (And by the rule there is without it — how often a version is found good, of what was held back, and then its score — each of these is kept.)
    const plain = loopOver(t, first, [candidate], WEIGHS);
    assert.equal((await plain.round({ inputs: [A, B], heldBack: [C, D], ask: "Use less." })).result.result.kept, otherwise, what);
  }

  // The margin is of the rule there is without `by` too: as often good, a score has to be higher by more than it.
  const tied = loopOver(t, SPENDS({ "*": 10 }), [SPENDS({ "*": 9.5 })], WEIGHS);
  assert.equal((await tied.round({ inputs: [A, B], ask: "Use less.", margin: 0.1 })).result.result.why,
    "Version 1 is put back: 2 of 2 runs of version 2 were found good as 2 of 2 were, at a mean score of 2.3539 where it was 2.3026 — not better by more than 0.1, and the one before is the one that is known.");
});

test("confirm: a version that passes is not kept for the runs that chose it alone — the runs that decide are made again, and it is kept where it passes with those too", async (t) => {
  // Cheap for its first two runs, dear after: it looks better, and is not.
  const slid = loopOver(t, SPENDS({ "*": 10 }), [SLIDES(5, 25, 2)], WEIGHS);
  const { result: back, messages } = await slid.round({ inputs: [A, B], ask: "Use less.", by: "score", margin: 0.1, confirm: "1" });
  assert.deepEqual(back.result, {
    kept: false, from: 1, to: 2, before: { ok: 2, of: 2, score: 2.3026 }, after: { ok: 4, of: 4, score: 2.191 }, all: { before: { ok: 2, of: 2 }, after: { ok: 4, of: 4 } }, confirmed: 2,
    why: "Version 1 is put back: a mean score of 2.191 where it was 2.3026, not higher by more than 0.1. It had passed by its first runs; with the 2 made again, it does not.",
  }, messages.join("\n"));
  assert.deepEqual([slid.program(), slid.lines().map((line) => line.version)], [SPENDS({ "*": 10 }), [1, 1, 2, 2, 2, 2]]);
  // (Without it, the same version is kept: for two runs.)
  const unconfirmed = loopOver(t, SPENDS({ "*": 10 }), [SLIDES(5, 25, 2)], WEIGHS);
  assert.equal((await unconfirmed.round({ inputs: [A, B], ask: "Use less.", by: "score", margin: 0.1 })).result.result.kept, true);

  // One that is what it looked: kept, by all its runs. Only the inputs that decide are run again — those held back, where there are any.
  const steady = loopOver(t, SPENDS({ "*": 10 }), [SPENDS({ "*": 5 })], WEIGHS);
  const { result: kept } = await steady.round({ inputs: [A, B], heldBack: [C], ask: "Use less.", by: "score", margin: 0.1, confirm: 2 });
  assert.deepEqual(kept.result, {
    kept: true, from: 1, to: 2, before: { ok: 1, of: 1, score: 2.3026 }, after: { ok: 3, of: 3, score: 2.9957 }, all: { before: { ok: 3, of: 3 }, after: { ok: 5, of: 5 } }, confirmed: 2,
    why: "Version 2 is kept: a mean score of 2.9957 where it was 2.3026, higher by more than 0.1; 5 of 5 runs of all inputs found good where 3 of 3 were. The runs that decide were made again to be sure of it: 2 more, counted here.",
  });
  assert.deepEqual(steady.lines().map((line) => line.version), [1, 1, 1, 2, 2, 2, 2, 2]);
  // How often it is good is held input against input. The runs made again are of what decides alone — and where that is the
  // harder part, a version has a smaller part of *all its runs* good for no fault of its own: more of them are of the hard input.
  const hard = loopOver(t, SPENDS({ "*": 10 }, ["c"]), [SPENDS({ "*": 5 }, ["c"])], WEIGHS);
  const { result: fair } = await hard.round({ inputs: [A, B], heldBack: [C], ask: "Use less.", by: "score", margin: 0.1, confirm: 1 });
  assert.deepEqual([fair.result.kept, fair.result.all, fair.result.confirmed], [true, { before: { ok: 2, of: 3 }, after: { ok: 2, of: 4 } }, 1]);

  // A version that does not pass is not run again: there is nothing to be sure of.
  const plain = loopOver(t, SPENDS({ "*": 10 }), [SPENDS({ "*": 20 })], WEIGHS);
  const { result: none } = await plain.round({ inputs: [A, B], ask: "Use less.", by: "score", confirm: 1 });
  assert.deepEqual([none.result.kept, "confirmed" in none.result, plain.lines().length], [false, false, 4]);
  // The round, replayed, goes as it went: the runs made again among it.
  const journals = readdirSync(join(slid.at("improve"), "logs", "journal")).sort();
  const { result: replay } = await withEnv({ HOME: slid.fakeHome }, () => quietly(() => replayProgram({ projectDir: slid.at("improve"), run: journals[0].replace(/\.jsonl$/, "") })));
  assert.deepEqual([replay.same, replay.left ?? null, slid.lines().length], [true, null, 6]);

  for (const [args, why] of [
    [{ by: "cost" }, /"by" is how a version is found the better: good, or score\./],
    [{ margin: -1 }, /"margin" is by how much a mean score is to be higher: 0 or more\./],
    [{ margin: "much" }, /"margin" is by how much a mean score is to be higher: 0 or more\./],
    [{ confirm: 1.5 }, /"confirm" is how many times the runs that decide are made again: 0 or more\./],
    [{ tell: "nothing" }, /"tell" is which runs the writer is told of: wanting, or all\./],
  ]) {
    const { result: refused } = await plain.round({ inputs: [A], ...args });
    assert.equal(refused.status, "failed", JSON.stringify(args));
    assert.match(journalsOf(plain.at("improve")).at(-1).findLast((record) => record.kind === "exit").stderr, why, JSON.stringify(args));
  }
});

test("tell=all: the writer is told what the judge said of the runs found good too — where what is wanted is not that they be good", async (t) => {
  const told = async (first, args) => {
    const it = loopOver(t, first, [SPENDS({ "*": 5 })], WEIGHS);
    await it.round({ inputs: [A, B], heldBack: [C], ask: "Use less.", ...args });
    return it.prompts[0]?.split("\n\nOutput the complete updated program.ts.")[0];
  };
  const wanting = 'Runs of the program as it is were checked, and these were found wanting:\n- started with {"word":"b"}: used 10, and got it wrong';
  assert.equal(await told(SPENDS({ "*": 10 }, ["b"]), {}), `Use less.\n\n${wanting}`);
  assert.equal(await told(SPENDS({ "*": 10 }, ["b"]), { tell: "all" }), `Use less.\n\n${wanting}\n\nAnd these were found good — what the judge said of each:\n- started with {"word":"a"}: used 10`);
  // (Nothing of what was held back, either way; and where none was wanting, what was said of the good is all there is to tell.)
  assert.equal(await told(SPENDS({ a: 7, "*": 10 }, ["c"]), { tell: "all" }), 'Use less.\n\nRuns of the program as it is were checked, and these were found good — what the judge said of each:\n- started with {"word":"a"}: used 7\n- started with {"word":"b"}: used 10');
  assert.equal(await told(SPENDS({ "*": 10 }), {}), "Use less.");
});
