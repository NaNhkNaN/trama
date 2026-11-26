import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
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
/** What the loop says it takes and gives (its meta.json): every round here is held to it, as a copy of the example is. */
const LOOP_SAYS = (({ description, parameters, returns }) => ({ description, parameters, returns }))(readJson(join(REPO_ROOT, "examples", "improve-by-check", "meta.json")));
const [A, B, C, D] = ["a", "b", "c", "d"].map((word) => ({ word }));

/** A home with the project `words`, its judge — and another, lenient one — and the loop; and a model that writes `candidates`, one at each asking. */
function loopOver(t, first, candidates, judge = JUDGE) {
  const home = homeWith(t, { words: { program: first, args: { word: "a" } }, judge: { program: judge }, lenient: { program: JUDGE }, improve: { program: LOOP, more: LOOP_SAYS } });
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
  // It was written and kept beside the program — of version 1, the program as it was — judged there, and only then made the program: as a version more, of its text.
  assert.deepEqual([it.program(), it.versions()], [SAYS(["a", "b"]).trim(), [[1, "found"], [2, "update"], [3, "rollback", 2]]]);
  assert.deepEqual(indexOf(it.words).filter((line) => line.version === 2).map(({ parent, aside }) => [parent, aside]), [[1, true]]);
  // What the model was asked: what is wanted, and what was found wanting — of each input, once — and nothing of what was found good.
  assert.equal(it.prompts.length, 1);
  assert.equal(it.prompts[0].split("\n\nOutput the complete updated program.ts.")[0],
    'Say every word in capitals.\n\nRuns of the program as it is were checked, and these were found wanting:\n- started with {"word":"b"}: it is to say B, and said b');
  // The runs: three before (one of the four was there), four after — of the version by its number, each checked, none fixed.
  assert.deepEqual(it.lines().map((line) => [line.version, line.check.ok]), [[1, true], [1, true], [1, false], [1, false], [2, true], [2, true], [2, true], [2, true]]);

  // A round more: everything it would ask is on record, and nothing is found wanting — no run, and no model.
  // (Told as a command line tells it: a list as JSON, a number as text.)
  const { result: again } = await it.round({ inputs: JSON.stringify([A, B]), runs: "2" });
  // (The program is version 3 now, and the verdicts of version 2 are its own: it is that text.)
  assert.deepEqual(again.result, { kept: false, from: 3, before: { ok: 4, of: 4, score: 1 }, why: "Nothing was asked for: no run that may be shown was found wanting, and no `ask` says what else is wanted." });
  assert.deepEqual([it.lines().length, it.prompts.length, it.versions().length], [8, 1, 3]);
  // (And of what is on record, as many as are asked for: not all there are.)
  assert.deepEqual((await it.round({ inputs: [A, B] })).result.result.before, { ok: 2, of: 2, score: 1 });

  // The round is a run like any: replayed, it goes the way it went, with nothing run and nothing changed.
  const journals = readdirSync(join(it.at("improve"), "logs", "journal")).sort();
  const { result: replay } = await withEnv({ HOME: it.fakeHome }, () => quietly(() => replayProgram({ projectDir: it.at("improve"), run: journals[0].replace(/\.jsonl$/, "") })));
  assert.deepEqual([replay.same, replay.sameEnd, replay.left ?? null, it.lines().length, it.versions().length], [true, true, null, 8, 3]);
});

test("the program stays what it is where the new version is not found better: worse, or no better — and one that is as often good and better by its score is kept", async (t) => {
  for (const [what, candidate, after, kept, why] of [
    ["worse", SAYS([]), { ok: 0, of: 2, score: 0 }, false, "Version 1 stays: 0 of 2 runs of version 2 were found good where 1 of 2 were."],
    ["no better", SAYS(["cd"]), { ok: 1, of: 2, score: 0.5 }, false, "Version 1 stays: 1 of 2 runs of version 2 were found good as 1 of 2 were, at a mean score of 0.5 where it was 0.5 — no better, and the one before is the one that is known."],
    ["better by its score", SAYS(["ab"], HALF), { ok: 1, of: 2, score: 0.75 }, true, "Version 2 is kept: 1 of 2 runs were found good as 1 of 2 were, at a mean score of 0.75 where it was 0.5."],
  ]) {
    // (Words of two letters: one that begins in a capital is not all in capitals.)
    const it = loopOver(t, SAYS(["ab"]), [candidate]);
    const { result: ran, messages } = await it.round({ inputs: [{ word: "ab" }, { word: "cd" }] });
    const { why: said, ...rest } = ran.result;
    assert.deepEqual(rest, { kept, from: 1, to: 2, before: { ok: 1, of: 2, score: 0.5 }, after }, `${what}\n${messages.join("\n")}`);
    if (why) assert.equal(said, why, what);
    // Not kept, it was never the program: there is nothing to go back to, and it is on record, beside the program. Kept, it is made the program.
    assert.deepEqual([it.program(), it.versions()], kept ? [candidate.trim(), [[1, "found"], [2, "update"], [3, "rollback", 2]]] : [SAYS(["ab"]), [[1, "found"], [2, "update"]]], what);
    assert.equal(it.lines().length, 4, what);
  }

  // A round that kept nothing left the program what it was: the verdicts on record of it are its verdicts still.
  // The round after makes no run of it again — it asks for the next update.
  const back = loopOver(t, SAYS(["ab"]), [SAYS([]), SAYS(["ab", "cd"])]);
  const two = [{ word: "ab" }, { word: "cd" }];
  assert.equal((await back.round({ inputs: two })).result.result.kept, false);
  assert.deepEqual([back.versions(), back.lines().map((line) => line.version)], [[[1, "found"], [2, "update"]], [1, 1, 2, 2]]);
  const { result: next } = await back.round({ inputs: two });
  assert.deepEqual({ ...next.result, why: "" }, { kept: true, from: 1, to: 3, before: { ok: 1, of: 2, score: 0.5 }, after: { ok: 2, of: 2, score: 1 }, why: "" });
  assert.deepEqual([back.lines().map((line) => line.version), back.prompts.length], [[1, 1, 2, 2, 3, 3], 2]);
  // (The program's own verdicts: not those of the version that was tried beside it and not kept.)
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
    assert.match(why, kept ? /^Version 2 is kept: 2 of 2 runs were found good where 0 of 2 were/ : /^Version 1 stays: 0 of 2 runs of version 2 were found good as 0 of 2 were/);
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

  // The judge is at a loss over the new version: the one before stays, and it is said why.
  const unjudged = loopOver(t, SAYS(["a"]), [SAYS(["a"], 'word === "b" ? "BOOM" : word')]);
  const { result: back } = await unjudged.round({ inputs: [A, B] });
  assert.deepEqual({ ...back.result, why: "" }, { kept: false, from: 1, to: 2, before: { ok: 1, of: 2, score: 0.5 }, why: "" });
  assert.match(back.result.why, /^Version 1 stays: a check of version 2 could not be made — The project asked for the check failed: /);
  assert.deepEqual([unjudged.program(), unjudged.versions()], [SAYS(["a"]), [[1, "found"], [2, "update"]]]);

  // The judge is at a loss over the program as it is: nothing is asked for, and nothing changed.
  const never = loopOver(t, SAYS([], '"BOOM"'), []);
  const { result: none } = await never.round({ inputs: [A] });
  assert.match(none.result.why, /^Nothing was changed: a check could not be made — The project asked for the check failed: /);
  assert.deepEqual([none.result.kept, never.prompts.length, never.versions()], [false, 0, [[1, "found"]]]);

  // What it is to be told: which project, which judge — by what it says it takes (its meta.json), a round without them
  // is not begun: no program is started for it, and nothing is on record.
  for (const [args, why] of [
    [{ project: undefined }, /The arguments do not fit what .*improve takes — project: expected string, got undefined\. It takes: project, check, inputs\?, heldBack\?, runs\?, ask\?, from\?, by\?, margin\?, confirm\?, tell\?, write\?\./],
    [{ check: undefined }, /improve takes — check: expected string, got undefined\./],
    [{ project: undefined, projct: "words" }, /improve takes — project: expected string, got undefined\. Not taken, and left out: "projct"\./],
  ]) {
    const begun = journalsOf(never.at("improve")).length;
    await assert.rejects(never.round({ inputs: [A], ...args }), why, JSON.stringify(args));
    assert.equal(journalsOf(never.at("improve")).length, begun, JSON.stringify(args));
  }
  // And what a shape does not say — what a list is to hold, how many is too few — the program says itself. (Why it failed is in what it said as it did.)
  for (const [args, why] of [
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
  // And where the loop's project does not say what it takes — the program copied without its meta.json's word, or that
  // word taken out — the program says that too: a round is begun, and fails for it, with nothing asked for or changed.
  const bare = loopOver(t, SAYS(["a"]), []);
  const { parameters, returns, ...unsaid } = readJson(join(bare.at("improve"), "meta.json"));
  assert.ok(parameters);
  writeJson(join(bare.at("improve"), "meta.json"), unsaid);
  for (const args of [{ project: undefined }, { check: undefined }, { project: 1 }]) {
    const { result: refused } = await bare.round({ inputs: [A], ...args });
    assert.equal(refused.status, "failed", JSON.stringify(args));
    assert.match(journalsOf(bare.at("improve")).at(-1).findLast((record) => record.kind === "exit").stderr, /It is not said which project to improve, or which checks it: "project" and "check", each by its name\./, JSON.stringify(args));
  }
  // (Nothing was asked of a model, and the project it was to improve was not so much as run: it has no history.)
  assert.deepEqual([bare.prompts.length, existsSync(join(bare.words, "history", "index.jsonl")), bare.program()], [0, false, SAYS(["a"])]);
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
      { kept: false, before: steady, after: { ok: 2, of: 2, score: 2.3539 }, all: { before: { ok: 4, of: 4 }, after: { ok: 4, of: 4 } }, why: "Version 1 stays: a mean score of 2.3539 where it was 2.3026, not higher by more than 0.1." }, true],
    // What is held back is all good, and cheaper: by that alone it would be kept. It is wrong where it was shown — and a run found wanting is one, wherever.
    ["cheaper, and wrong on an input that was shown", SPENDS({ "*": 10 }), SPENDS({ "*": 5 }, ["b"]),
      { kept: false, before: steady, after: { ok: 2, of: 2, score: 2.9957 }, all: { before: { ok: 4, of: 4 }, after: { ok: 3, of: 4 } }, why: "Version 1 stays: 3 of 4 runs of version 2, all inputs counted, were found good where 4 of 4 were — a smaller part, input by input (0.75 where it was 1), whatever its score." }, true],
    // More often right, and dearer: by how often it is found good it would be kept whatever it used. Here the score decides, once no fewer are good.
    ["dearer, and more often right", SPENDS({ "*": 10 }, ["c"]), SPENDS({ "*": 20 }),
      { kept: false, before: { ok: 1, of: 2, score: 2.3026 }, after: { ok: 2, of: 2, score: 1.6094 }, all: { before: { ok: 3, of: 4 }, after: { ok: 4, of: 4 } }, why: "Version 1 stays: a mean score of 1.6094 where it was 2.3026, not higher by more than 0.1." }, true],
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
    "Version 1 stays: 2 of 2 runs of version 2 were found good as 2 of 2 were, at a mean score of 2.3539 where it was 2.3026 — not better by more than 0.1, and the one before is the one that is known.");
});

test("confirm: a version that passes is not kept for the runs that chose it alone — the runs that decide are made again, and it is kept where it passes with those too", async (t) => {
  // Cheap for its first two runs, dear after: it looks better, and is not.
  const slid = loopOver(t, SPENDS({ "*": 10 }), [SLIDES(5, 25, 2)], WEIGHS);
  const { result: back, messages } = await slid.round({ inputs: [A, B], ask: "Use less.", by: "score", margin: 0.1, confirm: "1" });
  assert.deepEqual(back.result, {
    kept: false, from: 1, to: 2, before: { ok: 2, of: 2, score: 2.3026 }, after: { ok: 4, of: 4, score: 2.191 }, all: { before: { ok: 2, of: 2 }, after: { ok: 4, of: 4 } }, confirmed: 2,
    why: "Version 1 stays: a mean score of 2.191 where it was 2.3026, not higher by more than 0.1. It had passed by its first runs; with the 2 made again, it does not.",
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
    [{ confirm: 1.5 }, /"confirm" is how many times the runs that decide are made again: 0 or more\./],
    [{ tell: "nothing" }, /"tell" is which runs the writer is told of: wanting, or all\./],
  ]) {
    const { result: refused } = await plain.round({ inputs: [A], ...args });
    assert.equal(refused.status, "failed", JSON.stringify(args));
    assert.match(journalsOf(plain.at("improve")).at(-1).findLast((record) => record.kind === "exit").stderr, why, JSON.stringify(args));
  }
  // (What is no number at all is refused before that, by what the loop says it takes.)
  await assert.rejects(plain.round({ inputs: [A], margin: "much" }), /improve takes — margin: expected number, got string\./);
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

// --- what a round knows of the rounds before it ---

test("a round is told what the rounds before it tried, from the program as it is, and did not keep: what each changed, and what came of its runs — each once, and none of what was tried from another program", async (t) => {
  // (A first program with no line break at its end, as a program an update writes has none: so that what an update changed is all that differs.)
  const first = SAYS(["ab"]).trim();
  const it = loopOver(t, first, [SAYS([]), SAYS([]), SAYS(["zz"], HALF), SAYS(["ab", "cd"]), SAYS(["zz"]), SAYS(["ab", "cd", "ef"])]);
  const two = [{ word: "ab" }, { word: "cd" }];
  const asked = () => it.prompts.at(-1).split("\n\nOutput the complete updated program.ts.")[0];
  const WANTING = 'Runs of the program as it is were checked, and these were found wanting:\n- started with {"word":"cd"}: it is to say CD, and said cd';
  const changed = (line, to) => `What it changed, as a diff from the program as it is:\n  ${line}c${line}\n  < const GOOD: string[] = ["ab"];\n  ---\n  > const GOOD: string[] = ${to};`;

  // The first round has nothing before it.
  assert.equal((await it.round({ inputs: two })).result.result.kept, false);
  assert.equal(asked(), WANTING);
  // The second is told of the first's: the version, what its runs came to against the program's own, and what it changed.
  assert.equal((await it.round({ inputs: two })).result.result.kept, false);
  const TRIED = "Tried before, from the program as it is — none was kept. Write something else:";
  assert.equal(asked(), `${WANTING}\n\n${TRIED}\n- version 2: 0 of 2 runs found good, at a mean score of 0, where the program as it is has 1 of 2 at 0.5. ${changed(2, "[]")}`);
  // The same text tried twice is told once, as the latest try of it; another, beside it.
  assert.equal((await it.round({ inputs: two })).result.result.kept, false);
  assert.equal(asked(), `${WANTING}\n\n${TRIED}\n- version 3: 0 of 2 runs found good, at a mean score of 0, where the program as it is has 1 of 2 at 0.5. ${changed(2, "[]")}`);
  assert.equal((await it.round({ inputs: two })).result.result.kept, true);
  assert.match(asked(), /\n- version 3: 0 of 2 runs found good[^]*\n- version 4: 0 of 2 runs found good, at a mean score of 0\.5, where the program as it is has 1 of 2 at 0\.5\. What it changed/);
  // The history is the tries, each of the program it was written from, and the one that was kept made the program: no going back and forth.
  assert.deepEqual(indexOf(it.words).filter((line) => line.version).map(({ version, reason, parent, from }) => [version, reason, parent ?? from]), [[1, "found", undefined], [2, "update", 1], [3, "update", 1], [4, "update", 1], [5, "update", 1], [6, "rollback", 5]]);
  // A version was kept: the program is another now, and what was tried from the one before is nothing to it —
  // on the very inputs those were judged on, too.
  assert.equal((await it.round({ inputs: two, ask: "Say more of them." })).result.result.kept, false);
  assert.equal(asked(), "Say more of them.");
  await it.round({ inputs: [...two, { word: "ef" }] });
  assert.equal(asked(), 'Runs of the program as it is were checked, and these were found wanting:\n- started with {"word":"ef"}: it is to say EF, and said ef');

  // Where inputs are held back, what came of a try is said of those — they decided — as a count and a mean, and nothing more of them.
  const held = loopOver(t, first, [SAYS([]), SAYS(["ab", "cd"])]);
  await held.round({ inputs: [{ word: "ab" }, { word: "cd" }], heldBack: [{ word: "gh" }] });
  await held.round({ inputs: [{ word: "ab" }, { word: "cd" }], heldBack: [{ word: "gh" }] });
  assert.match(held.prompts[1], /\n- version 2: 0 of 1 runs found good, at a mean score of 0, where the program as it is has 0 of 1 at 0\. What it changed/);
  assert.doesNotMatch(held.prompts[1], /"gh"|GH/);
  // An update that wrote the program as it is has tried nothing: there is nothing of it to tell.
  const same = loopOver(t, first, [first, SAYS([])]);
  assert.equal((await same.round({ inputs: two })).result.result.kept, false);
  await same.round({ inputs: two });
  assert.deepEqual([same.versions().map(([version, reason]) => [version, reason]).slice(0, 2), /Tried before/.test(same.prompts[1])], [[[1, "found"], [2, "update"]], false]);

  // A version a check of which could not be made was never judged: it is not told as tried —
  // whatever runs of it happened to be judged first — where one the loop judged and did not keep is.
  const lost = loopOver(t, first, [SAYS(["ab"], 'word === "cd" ? "BOOM" : word'), SAYS([]), SAYS([]), SAYS([])]);
  assert.match((await lost.round({ inputs: two })).result.result.why, /^Version 1 stays: a check of version 2 could not be made/);
  assert.equal(lost.lines().filter((line) => line.version === 2 && line.check?.ok === true).length, 1);
  assert.equal((await lost.round({ inputs: two })).result.result.kept, false);
  assert.doesNotMatch(lost.prompts[1], /Tried before/);
  await lost.round({ inputs: two });
  assert.deepEqual([lost.prompts[2].match(/\n- version \d+/g), lost.versions().length], [["\n- version 3"], 4]);
  // It is read from the project's history — the versions written from the program, and what the runs of each came to —
  // and is no memory of the loop's: the loop keeps no list of what it tried, and one that has lost what it keeps is told the same.
  const keeps = (home) => Object.keys(readJson(join(home.at("improve"), "state.json"))).filter((key) => !key.startsWith("__trama")).sort();
  assert.deepEqual([keeps(lost), keeps(it)], [["notes", "said"], ["notes", "said"]]);
  rmSync(join(lost.at("improve"), "state.json"));
  await lost.round({ inputs: two });
  assert.deepEqual(lost.prompts[3].match(/\n- version \d+/g), ["\n- version 4"]);

  // What a try changed is told whole where it is long — a version a model writes of a harness changes much of it —
  // and cut where it is longer than a writer has use for.
  const grown = (lines) => `${first}\n${"// a line of the try, as long as lines go\n".repeat(lines)}// the last line of it`;
  const much = loopOver(t, first, [grown(280), grown(700), SAYS([])]);
  await much.round({ inputs: two });
  await much.round({ inputs: two });
  assert.match(much.prompts[1], /\n- version 2: [^]*\n  > \/\/ the last line of it\n/);
  await much.round({ inputs: two });
  assert.deepEqual([much.prompts[2].match(/\n- version \d+/g), much.prompts[2].split("// the last line of it").length - 1], [["\n- version 2", "\n- version 3"], 1]);

  // Of what was tried, the five latest are told: a writer has no use for all of it.
  const many = loopOver(t, first, [1, 2, 3, 4, 5, 6].map((n) => SAYS([`w${n}`])).concat(SAYS([])));
  for (let n = 0; n < 6; n++) await many.round({ inputs: two });
  await many.round({ inputs: two });
  assert.deepEqual(many.prompts[6].match(/\n- version \d+/g), [3, 4, 5, 6, 7].map((n) => `\n- version ${n}`));

  // The rounds, replayed, go as they went: what was read of the versions is on the record.
  const journals = readdirSync(join(it.at("improve"), "logs", "journal")).sort();
  for (const run of [journals[1], journals[3]]) {
    const { result: replay } = await withEnv({ HOME: it.fakeHome }, () => quietly(() => replayProgram({ projectDir: it.at("improve"), run: run.replace(/\.jsonl$/, "") })));
    assert.deepEqual([replay.same, replay.left ?? null], [true, null]);
  }
});

test("what the judge said of a run is told whole, round after round: the loop keeps it, where the project's history keeps the beginning — and keeps no more than the program as it is has use for", async (t) => {
  // A judge that says much: more than a line of history keeps.
  const LONG = WEIGHS.replace('"used " + result.cost', '"used " + result.cost + ". Where it went: " + "the reading of the modules, and then the writing of them again; ".repeat(6) + "and that is all (" + (ctx.input.args as any).args.word + ")"');
  const first = SPENDS({ "*": 10 }, ["b"]);
  const it = loopOver(t, first, [SPENDS({ "*": 20 }, ["b"]), SPENDS({ "*": 30 }, ["b"])], LONG);
  const whole = (word, wrong) => `used 10. Where it went: ${"the reading of the modules, and then the writing of them again; ".repeat(6)}and that is all (${word})${wrong ? ", and got it wrong" : ""}`;
  const told = () => it.prompts.at(-1).split("\n\nTried before")[0].split("\n\nOutput the complete")[0];
  const expected = `Use less.\n\nRuns of the program as it is were checked, and these were found wanting:\n- started with {"word":"b"}: ${whole("b", true)}\n\nAnd these were found good — what the judge said of each:\n- started with {"word":"a"}: ${whole("a", false)}`;
  const args = { inputs: [A, B], heldBack: [C], ask: "Use less.", by: "score", tell: "all" };
  await it.round(args);
  assert.equal(told(), expected);
  // (The record has the beginning of it.)
  assert.ok(it.lines()[0].check.notes.endsWith("…") && it.lines()[0].check.notes.length < whole("a", false).length);
  // The round after takes its verdicts from the record — and tells them as whole as the first did.
  await it.round(args);
  assert.deepEqual([told(), it.lines().length], [expected, 9]);
  // What it keeps: of the program as it is — not of the two it went back from — and of the inputs that are shown.
  const state = readJson(join(it.at("improve"), "state.json"));
  const marks = await withEnv({ HOME: it.fakeHome }, () => Promise.all([A, B].map((input) => inputMarkOf(it.words, input))));
  assert.deepEqual([Object.keys(state.notes), Object.keys(state.notes[hashOf(first)]).sort(), state.notes[hashOf(first)][marks[1]]], [[hashOf(first)], [...marks].sort(), [whole("b", true)]]);

  // What the loop heard is told for what the record has only where it is the same verdict: a later run of the same
  // program on the same input, made by somebody else and come to something else, is told as the record has it.
  const drifts = loopOver(t, SLIDES(10, 20, 1), [SPENDS({ "*": 50 }), SPENDS({ "*": 50 })], LONG);
  await drifts.round({ inputs: [A], ask: "Use less.", by: "score", tell: "all" });
  assert.match(drifts.prompts[0], /- started with \{"word":"a"\}: used 10\. Where it went: [^\n]*and that is all \(a\)\n/);
  await withEnv({ HOME: drifts.fakeHome }, () => quietly(() => runProgram({ projectDir: drifts.words, args: A, checkWith: drifts.at("judge"), timeout: 30_000 })));
  await drifts.round({ inputs: [A], ask: "Use less.", by: "score", tell: "all" });
  assert.match(drifts.prompts[1], /- started with \{"word":"a"\}: used 20\. Where it went: [^\n]*…\n/);

  // A verdict the loop did not hear itself — a run somebody else made — is told as far as the record has it.
  const other = loopOver(t, first, [SPENDS({ "*": 20 }, ["b"])], LONG);
  for (const input of [A, B, C]) await withEnv({ HOME: other.fakeHome }, () => quietly(() => runProgram({ projectDir: other.words, args: input, checkWith: other.at("judge"), timeout: 30_000 })));
  await other.round(args);
  assert.match(other.prompts[0], /- started with \{"word":"a"\}: used 10\. Where it went: [^\n]*…\n/);
});

// --- a run that failed ---

/**
 * A program that what is around it fails, on one word, so many times — as a harness is failed by a model that
 * cannot be reached. (How many times are left is in a file beside everything.)
 */
const FALTERS = (good, left, more = "word") => `import { ctx } from "@trama-dev/runtime";
import { readFileSync, writeFileSync } from "node:fs";
const GOOD: string[] = ${JSON.stringify(good)};
const { word } = ctx.input.args as { word: string };
const left = Number(readFileSync(${JSON.stringify(left)}, "utf-8"));
if (word === "cd" && left > 0) { writeFileSync(${JSON.stringify(left)}, String(left - 1)); throw new Error("the model could not be reached"); }
await ctx.done({ said: GOOD.includes(word) ? word.toUpperCase() : ${more} });
`;

test("a run that failed is made again, once, and what the second comes to is what counts; one that fails again is, of the program as it is, a run found wanting — and of a version being tried, a round that decides nothing: the version is not judged by it", async (t) => {
  const aside = makeTempDir("trama-loop-aside-");
  t.after(() => cleanupTempDir(aside));
  const left = join(aside, "left.txt");
  const first = SAYS(["ab"]).trim(), two = [{ word: "ab" }, { word: "cd" }];
  const statuses = (it, version) => it.lines().filter((line) => line.version === version).map((line) => line.status);

  // What is around a version fails one run of it, once: the run is made again, and the version is judged by that.
  writeFileSync(left, "1");
  const once = loopOver(t, first, [FALTERS(["ab", "cd"], left)]);
  const { result: passed } = await once.round({ inputs: two });
  assert.deepEqual(passed.result, {
    kept: true, from: 1, to: 2, before: { ok: 1, of: 2, score: 0.5 }, after: { ok: 2, of: 2, score: 1 }, remade: 1,
    why: "Version 2 is kept: 2 of 2 runs were found good where 1 of 2 were, at a mean score of 1 where it was 0.5. 1 run failed and was made again: what came of it then is what is counted.",
  });
  assert.deepEqual(statuses(once, 2), ["done", "failed", "done"]);

  // And where the version is no better for it, it is told as tried by the runs it was judged by: the one that failed is none of them.
  writeFileSync(left, "1");
  const worse = loopOver(t, first, [FALTERS([], left), SAYS([])]);
  assert.equal((await worse.round({ inputs: two })).result.result.why,
    "Version 1 stays: 0 of 2 runs of version 2 were found good where 1 of 2 were. 1 run failed and was made again: what came of it then is what is counted.");
  await worse.round({ inputs: two });
  assert.match(worse.prompts[1], /\n- version 2: 0 of 2 runs found good, at a mean score of 0, where the program as it is has 1 of 2 at 0\.5\. What it changed/);

  // It fails again: nothing is decided. The program stays — it was never replaced — and the version is not judged: not found worse.
  writeFileSync(left, "2");
  const twice = loopOver(t, first, [FALTERS(["ab", "cd"], left), SAYS([]), SAYS([]), SAYS(["ab", "cd"])]);
  const { result: undecided } = await twice.round({ inputs: two });
  assert.deepEqual({ ...undecided.result, why: "" }, { kept: false, from: 1, to: 2, before: { ok: 1, of: 2, score: 0.5 }, remade: 1, why: "" });
  assert.match(undecided.result.why, /^Version 1 stays, and nothing is decided: a run of version 2 failed, and failed when it was made again — whether that is the version's doing is not known\. [^]*the model could not be reached/);
  assert.deepEqual([twice.program(), twice.versions(), statuses(twice, 2)], [first, [[1, "found"], [2, "update"]], ["done", "failed", "failed"]]);
  // The round after is told of it as what it is — written, and not judged, with what the run said as it failed and
  // what the version changed — and not as tried.
  await twice.round({ inputs: two });
  const NOT_JUDGED = "Written before, from the program as it is, and not judged: a run of each failed, and failed when it was made again. Whether that was the version's doing is not known — where it was, do not write that again:";
  const told = twice.prompts[1].split("\n\nOutput the complete updated program.ts.")[0];
  assert.doesNotMatch(told, /Tried before/);
  assert.match(told, new RegExp(`\\n\\n${NOT_JUDGED.replace(/[.:—']/g, "\\$&")}\\n- version 2: started with \\{"word":"cd"\\}: [^]*the model could not be reached[^]* What it changed, as a diff from the program as it is:\\n  2c2,3\\n`));
  // The round after that, of both: the one it judged and did not keep, and the one it did not judge.
  await twice.round({ inputs: two });
  assert.match(twice.prompts[2], /\n\nTried before[^\n]*\n- version 3: 0 of 2 runs found good[^]*\n\nWritten before[^\n]*\n- version 2: started with/);
  // What the loop keeps for it is words alone: what the run said as it failed, of which a line of history has the first
  // line — by the program's text, then by the version. Which versions were written, and which of them judged, is read from the history.
  const state = readJson(join(twice.at("improve"), "state.json"));
  assert.deepEqual([Object.keys(state.said), Object.keys(state.said[hashOf(first)]), "tried" in state, "unjudged" in state], [[hashOf(first)], ["2"], false, false]);
  assert.match(state.said[hashOf(first)][2], /^started with \{"word":"cd"\}: The run failed, and failed when it was made again: [^]*the model could not be reached/);
  // A version is kept: the program is another, and what was written from the one before and not judged is nothing to it.
  assert.equal((await twice.round({ inputs: two })).result.result.kept, true);
  assert.deepEqual(readJson(join(twice.at("improve"), "state.json")).said, {});
  // Of those not judged, the three latest are told. (Each another text: the same text written again is told once, as its latest.)
  const many = loopOver(t, first, [1, 2, 3, 4].map((n) => FALTERS(["ab", "cd", `w${n}`], left)).concat(SAYS([]), FALTERS(["ab", "cd", "w4"], left), SAYS([])));
  for (let n = 0; n < 4; n++) { writeFileSync(left, "2"); await many.round({ inputs: two }); }
  await many.round({ inputs: two });
  assert.deepEqual(many.prompts[4].match(/\n- version \d+/g), ["\n- version 3", "\n- version 4", "\n- version 5"]);
  writeFileSync(left, "2");
  await many.round({ inputs: two });
  assert.deepEqual(many.prompts[5].match(/\n- version \d+/g), ["\n- version 6", "\n- version 3", "\n- version 4", "\n- version 5"]);
  // That too is read from the history — a version whose latest run of an input did not end done — and a loop that has
  // lost what it keeps is told of the same versions: with what the history has of the failure, its first line.
  rmSync(join(many.at("improve"), "state.json"));
  await many.round({ inputs: two });
  assert.deepEqual(many.prompts[6].match(/\n- version \d+/g), ["\n- version 6", "\n- version 3", "\n- version 4", "\n- version 7"]);
  assert.match(many.prompts[6], /\n- version 7: started with \{"word":"cd"\}: \S[^\n]* What it changed, as a diff/);
  assert.doesNotMatch(many.prompts[6].split("\n- version 7: ")[1].split(" What it changed")[0], /the model could not be reached/);

  // A run of an input that is held back fails twice: nothing is decided — and of what the run said as it failed, the
  // writer is told nothing. (A program could say there what it was started with.) Whoever runs the loop is told.
  writeFileSync(left, "2");
  const held = loopOver(t, first, [FALTERS(["ab", "cd"], left), SAYS([])]);
  const { result: unseen } = await held.round({ inputs: [{ word: "ab" }], heldBack: [{ word: "cd" }], ask: "Say more." });
  assert.match(unseen.result.why, /^Version 1 stays, and nothing is decided: [^]*the model could not be reached/);
  await held.round({ inputs: [{ word: "ab" }], heldBack: [{ word: "cd" }], ask: "Say more." });
  assert.match(held.prompts[1], /\n- version 2: a run of an input that is held back\. What it changed, as a diff/);
  assert.doesNotMatch(held.prompts[1].split("What it changed")[0], /could not be reached|"cd"/);
  // (Nor does the loop keep it: what it does not have it cannot tell.)
  assert.deepEqual(readJson(join(held.at("improve"), "state.json")).said, {});

  // The program as it is fails once: the run is made again, and it is judged by that. Twice: it is a run found
  // wanting, and the writer is told what it said as it failed — that is what there is to mend.
  writeFileSync(left, "1");
  const blip = loopOver(t, FALTERS(["ab", "cd"], left), []);
  const { result: fine } = await blip.round({ inputs: two });
  assert.deepEqual([fine.result.before, fine.result.why, statuses(blip, 1)], [{ ok: 2, of: 2, score: 1 }, "Nothing was asked for: no run that may be shown was found wanting, and no `ask` says what else is wanted.", ["done", "failed", "done"]]);
  writeFileSync(left, "2");
  const broken = loopOver(t, FALTERS(["ab", "cd"], left), [SAYS(["ab", "cd"])]);
  const { result: mended } = await broken.round({ inputs: two });
  assert.deepEqual([mended.result.kept, mended.result.before, mended.result.after, mended.result.remade], [true, { ok: 1, of: 2, score: 0.5 }, { ok: 2, of: 2, score: 1 }, 1]);
  assert.match(broken.prompts[0], /found wanting:\n- started with \{"word":"cd"\}: The run failed, and failed when it was made again: [^]*the model could not be reached/);
});

// --- who writes ---

test("write: the update is written by the project that is named, and not by pi's agent — judged and kept as any is", async (t) => {
  // A writer with no model in it: it knows one more word. (Run with nothing to write, as a validation of it would run it, it ends.)
  const WRITER = `import { ctx } from "@trama-dev/runtime";
const { prompt, program } = ctx.input.args as { prompt?: string; program?: string };
if (prompt === undefined || program === undefined) await ctx.done({});
else await ctx.done({ program: program.replace('["a"]', '["a","b"]') + "// asked: " + prompt.split("\\n")[0] + "\\n" });
`;
  const home = homeWith(t, { words: { program: SAYS(["a"]), args: { word: "a" } }, judge: { program: JUDGE }, improve: { program: LOOP, more: LOOP_SAYS }, writer: { program: WRITER } });
  const original = llm.ask;
  llm.ask = async () => assert.fail("pi's agent was asked for the update");
  t.after(() => { llm.ask = original; });
  const { result: ran } = await withEnv({ HOME: home.fakeHome }, () => quietly(() =>
    runProgram({ projectDir: home.at("improve"), args: { project: "words", check: "judge", inputs: [A, B], write: "writer" }, label: "improve", timeout: 60_000 })));
  assert.deepEqual({ ...ran.result, why: "" }, { kept: true, from: 1, to: 2, before: { ok: 1, of: 2, score: 0.5 }, after: { ok: 2, of: 2, score: 1 }, why: "" });
  assert.equal(readFileSync(join(home.at("words"), "program.ts"), "utf-8"), `${SAYS(["a"]).replace('["a"]', '["a","b"]')}// asked: Runs of the program as it is were checked, and these were found wanting:\n`);
  assert.deepEqual(linesOf(home.at("writer")).map((line) => [line.for, line.status]), [["update", "done"]]);
});
