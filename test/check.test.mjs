import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHash } from "crypto";
import { cpSync, existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { llm } from "./fake-llm.mjs";
import { replayProgram, runProgram, validateProgram } from "../packages/runtime/dist/runner.js";
import { createBackend } from "../packages/runtime/dist/runner-backend.js";
import { printJournals } from "../packages/runtime/dist/journal-view.js";
import { REPO_ROOT, captureConsole, cleanupTempDir, createProjectFixture, isAlive, makeTempDir, readJson, runNodeCommand, waitFor, withEnv, writeJson } from "./helpers.mjs";

// A check of a run, by a project: where a run — or the project run — names one (`checkWith`), that project's
// program is run once the run has ended as done, with a copy of the project as the run left it for its workspace,
// and what it ends with is the verdict: on the run's result and on its record. It says what the work is worth;
// that the run is done it does not change. (Importing the stand-in for the model means a test here fails where a
// model is asked for anything that it did not provide.)

const defaultsHome = makeTempDir("trama-check-defaults-");
const realHome = process.env.HOME;
process.env.HOME = defaultsHome;
after(() => {
  process.env.HOME = realHome;
  cleanupTempDir(defaultsHome);
});

/** A program that says how many words its file has, and makes a file. What else it does is said by its argument `does`. */
const WORKS = `import { ctx, tools } from "@trama-dev/runtime";
const { does } = ctx.input.args as any;
const text = await tools.read("data.txt");
await tools.write("made.txt", "made by the run");
if (does === "fail") throw new Error("the program has a fault");
if (does === "yield") await ctx.yield("more to do");
else await ctx.done({ words: String(text.split(" ").length) });
`;

/**
 * A project that checks: no model in it, so that what it is handed and what becomes of what it does is all a
 * test sees. What it does is said by the file `how.txt` of the copy it is handed ("pass" without one).
 */
const CHECKER = `import { ctx, agent, workspace } from "@trama-dev/runtime";
import { appendFileSync } from "node:fs";
const { result, args, journal, run, ...more } = ctx.input.args as any;
const how = await workspace.read("how.txt").catch(() => "pass");
const copy = (await workspace.shell("pwd")).stdout.trim();
appendFileSync(process.env.SEEN_BY_CHECKER!, JSON.stringify({
  pid: process.pid, how, result, args, journal, run, more: Object.keys(more), copy,
  files: await workspace.list("*"), program: await workspace.read("program.ts"), mine: process.env.MINE ?? null,
}) + "\\n");
// What it does in the copy is nobody's but its own.
await workspace.write("checked-by.txt", "the checker");
if (how === "ask") for (const turn of [1, 2]) await agent.complete({ messages: [{ role: "user", content: "turn " + turn }] });
// (At work for ten minutes: a promise nobody settles would be no work at all, and node would end the program there.)
if (how === "wait") await new Promise((resolve) => setTimeout(resolve, 600_000));
if (how === "fail") throw new Error("the checker has a fault of its own");
if (how === "yield") await ctx.yield("not now");
else if (how === "say nothing") await ctx.done({ note: "no verdict here" });
else if (how === "no boolean") await ctx.done({ ok: "yes" });
else if (how === "no number") await ctx.done({ ok: true, score: "high" });
else if (how === "no text") await ctx.done({ ok: true, notes: ["a", "b"] });
else if (how === "no") await ctx.done({ ok: false, score: 0.25, notes: "two words short", more: "is not taken" });
else if (how === "bare") await ctx.done({ ok: true });
else await ctx.done({ ok: result.words === "6", score: 1, notes: "six words, as there are" });
`;
const hashOf = (text) => createHash("sha256").update(text).digest("hex");

const journalsOf = (projectDir) => {
  const dir = join(projectDir, "logs", "journal");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().map((file) => readFileSync(join(dir, file), "utf-8").trim().split("\n").map((line) => JSON.parse(line)));
};

/** A project that works, a project that checks, and what the checker wrote down each time it was asked. */
function projects(t, how, programSource = WORKS) {
  const projectDir = makeTempDir("trama-check-work-"), checker = makeTempDir("trama-check-checker-"), notes = makeTempDir("trama-check-seen-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(checker); cleanupTempDir(notes); });
  createProjectFixture(projectDir, { programSource, metaInput: { prompt: "count the words", args: { of: "the project" } } });
  writeFileSync(join(projectDir, "data.txt"), "the heron waits at low tide");
  if (how) writeFileSync(join(projectDir, "how.txt"), how);
  createProjectFixture(checker, { programSource: CHECKER });
  const seen = join(notes, "seen.jsonl");
  writeFileSync(seen, "");
  return {
    projectDir, checker, seenAt: seen,
    by: { by: checker, program: hashOf(CHECKER) },
    seen: () => readFileSync(seen, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    run: (options = {}) => withEnv({ SEEN_BY_CHECKER: seen }, () => captureConsole("log", () =>
      runProgram({ projectDir, checkWith: checker, maxRepairAttempts: 0, timeout: 30_000, ...options }))),
  };
}

test("a run that is done is checked by the project it names: with a copy of the project as the run left it, and what the checker ends with is the verdict — on the result, and on the record", async (t) => {
  const it = projects(t);
  const { result, messages } = await it.run({ args: { from: "the run" }, env: { MINE: "the run's" } });
  assert.deepEqual(result, { status: "done", result: { words: "6" }, check: { ...it.by, ok: true, score: 1, notes: "six words, as there are" } });
  assert.ok(messages.includes(`[trama] checked by ${it.checker}: ok (score 1) — six words, as there are`), messages.join("\n"));

  // What the checker was handed: what the program ended with, what the run was started with, the record of the
  // run — and nothing else; a copy of the project as the run left it, which is not the project; the run's variables.
  const [told, ...more] = it.seen();
  assert.deepEqual(more, []);
  const [records] = journalsOf(it.projectDir);
  assert.deepEqual({ how: told.how, result: told.result, args: told.args, more: told.more, mine: told.mine },
    { how: "pass", result: { words: "6" }, args: { of: "the project", from: "the run" }, more: [], mine: "the run's" });
  assert.deepEqual([told.run, told.journal], [records[0].run, join(realpathSync(it.projectDir), "logs", "journal", `${records[0].run}.jsonl`)]);
  assert.deepEqual(told.files, [".gitignore", "data.txt", "made.txt", "meta.json", "package.json", "program.ts", "state.json"]);
  assert.notEqual(told.copy, realpathSync(it.projectDir));
  // What it did there is thrown away with the copy: a check changes nothing.
  assert.equal(existsSync(told.copy), false, "the copy is gone with the check");
  assert.equal(existsSync(join(it.projectDir, "checked-by.txt")), false);
  assert.equal(isAlive(told.pid), false);

  // On record: the run that was started for the check, and the check — who made it, by its program's hash, and
  // what it said — after the program's own end and before the run's; and the run's end has it.
  assert.deepEqual(records.map((record) => record.kind).slice(-4), ["exit", "child", "check", "end"]);
  const child = records.at(-3), { at, ms, ...check } = records.at(-2);
  assert.equal(child.purpose, "check");
  assert.deepEqual(check, { kind: "check", ...it.by, ok: true, score: 1, notes: "six words, as there are" });
  assert.ok(Number.isFinite(ms) && ms >= 0);
  assert.deepEqual(records.at(-1).result, result);
  // (The program's own end is as it was: its word, and not the check's.)
  assert.deepEqual(records.at(-4).outcome, { status: "done", result: { words: "6" } });
  // The checker's own journal, in its own project, says whose it was — a run like any, and not one that is fixed.
  const [checkers] = journalsOf(it.checker);
  assert.equal(checkers[0].run, child.run);
  assert.deepEqual({ parent: checkers[0].parent, depth: checkers[0].depth, maxRepairAttempts: checkers[0].maxRepairAttempts, label: checkers[0].label, workspace: checkers[0].workspace },
    { parent: { run: records[0].run, journal: told.journal }, depth: 1, maxRepairAttempts: 0, label: "check", workspace: told.copy });
  assert.equal(checkers.at(-1).kind, "end");

  const shown = (await captureConsole("log", async () => printJournals(it.projectDir, "it", {}))).messages.join("\n");
  assert.match(shown, new RegExp(`s  the check is asked of a project: run ${child.run}\\n +[\\d.]+s  checked by ${it.checker} \\(program ${hashOf(CHECKER).slice(0, 8)}\\): ok  score 1  six words, as there are\\n`));
});

test("a verdict says what the work is worth, and does not change how the run ended: one that is not ok is a run that is done", async (t) => {
  const it = projects(t, "no");
  const { result, messages } = await it.run();
  // (Of what a checker ends with, the verdict is taken and nothing else.)
  assert.deepEqual(result, { status: "done", result: { words: "6" }, check: { ...it.by, ok: false, score: 0.25, notes: "two words short" } });
  assert.ok(messages.includes(`[trama] checked by ${it.checker}: not ok (score 0.25) — two words short`), messages.join("\n"));
  assert.deepEqual(journalsOf(it.projectDir)[0].at(-1).result.status, "done");
  const shown = (await captureConsole("log", async () => printJournals(it.projectDir, "it", {}))).messages.join("\n");
  assert.match(shown, /checked by .*: not ok  score 0\.25  two words short\n/);

  // A verdict may be the one word.
  const bare = projects(t, "bare");
  const said = await bare.run();
  assert.deepEqual(said.result.check, { ...bare.by, ok: true });
  assert.ok(said.messages.includes(`[trama] checked by ${bare.checker}: ok`));
});

test("a check that could not be made is said as that, and never as a verdict: a checker that failed, did not end its work, or ended with no verdict", async (t) => {
  // (The run may be fixed: the checker is not — nobody is asked for a fix of it.)
  const made = async (how) => {
    const it = projects(t, how);
    const { result, messages } = await it.run({ maxRepairAttempts: 2 });
    assert.deepEqual([result.status, result.result, Object.keys(result.check).sort()], ["done", { words: "6" }, ["by", "error", "program"]], how);
    assert.deepEqual({ by: result.check.by, program: result.check.program }, it.by);
    assert.ok(messages.some((message) => message.startsWith(`[trama] not checked by ${it.checker}: `)), messages.join("\n"));
    const { at: _at, ms: _ms, ...check } = journalsOf(it.projectDir)[0].at(-2);
    assert.deepEqual(check, { kind: "check", ...it.by, error: result.check.error });
    assert.equal(journalsOf(it.checker).length, 1, "it was run once");
    return result.check.error;
  };
  assert.match(await made("fail"), /^The project asked for the check failed: [^]*the checker has a fault of its own/);
  assert.match(await made("yield"), /^The project asked for the check did not end its work: not now$/);
  const noVerdict = "The project asked for the check answered with no verdict: its result is to be { ok, score?, notes? } — whether the work is good (true or false), how good where it says (a number), and why where it says (a text).";
  for (const how of ["say nothing", "no boolean", "no number", "no text"]) assert.equal(await made(how), noVerdict, how);

  const shown = projects(t, "say nothing");
  await shown.run();
  const lines = (await captureConsole("log", async () => printJournals(shown.projectDir, "it", {}))).messages.join("\n");
  assert.match(lines, /s  not checked by .* \(program [0-9a-f]{8}\): The project asked for the check answered with no verdict/);
});

test("only a run that is done is checked: not one that failed or yielded, not a validation, not a replay", async (t) => {
  for (const does of ["fail", "yield"]) {
    const it = projects(t);
    const { result } = await it.run({ args: { does } });
    assert.deepEqual([result.status, "check" in result, it.seen(), journalsOf(it.checker)], [does === "fail" ? "failed" : "yielded", false, [], []], does);
    assert.equal(journalsOf(it.projectDir)[0].some((record) => record.kind === "check"), false);
  }

  // A project that names its checker itself: a candidate for its program is validated, and not checked.
  const it = projects(t);
  const meta = readJson(join(it.projectDir, "meta.json"));
  writeJson(join(it.projectDir, "meta.json"), { ...meta, checkWith: it.checker });
  await withEnv({ SEEN_BY_CHECKER: it.seenAt }, () =>
    validateProgram(it.projectDir, createBackend({ provider: "fake", model: "plain" }), WORKS, { timeout: 20_000, maxRepairAttempts: 0, maxIterations: 10, journalRuns: 20 }));
  assert.deepEqual([it.seen(), journalsOf(it.projectDir).length], [[], 1]);
  // Run, it is checked — the project's own word is enough...
  const { result } = await it.run({ checkWith: undefined });
  assert.deepEqual(result.check, { ...it.by, ok: true, score: 1, notes: "six words, as there are" });
  assert.equal(it.seen().length, 1);
  // ...and replayed, it is not: a replay carries nothing out. It goes as recorded, to the program's own end.
  const again = await withEnv({ SEEN_BY_CHECKER: it.seenAt }, () => replayProgram({ projectDir: it.projectDir }));
  assert.deepEqual([again.same, again.result, again.recordedResult], [true, { status: "done", result: { words: "6" } }, { status: "done", result: { words: "6" } }]);
  assert.deepEqual([it.seen().length, journalsOf(it.checker).length], [1, 1]);
});

test("who checks is said by whoever asks for the run, or else by the project: by a path, or by a name among the user's projects", async (t) => {
  // The project names one beside it, by a path from where the project is — and one a run names is asked in its place.
  const base = makeTempDir("trama-check-named-");
  t.after(() => cleanupTempDir(base));
  const projectDir = join(base, "work"), beside = join(base, "beside"), named = join(defaultsHome, ".trama", "projects", "checks"), seen = join(base, "seen.jsonl");
  t.after(() => cleanupTempDir(named));
  createProjectFixture(projectDir, { programSource: WORKS });
  writeFileSync(join(projectDir, "data.txt"), "the heron waits at low tide");
  for (const checker of [beside, named]) createProjectFixture(checker, { programSource: CHECKER });
  writeFileSync(seen, "");
  const run = (options = {}) => withEnv({ SEEN_BY_CHECKER: seen }, () => captureConsole("log", () => runProgram({ projectDir, maxRepairAttempts: 0, timeout: 30_000, ...options })));
  const setMeta = (checkWith) => writeJson(join(projectDir, "meta.json"), { input: { prompt: "p", args: {} }, ...(checkWith !== undefined && { checkWith }) });

  setMeta(undefined);
  assert.equal("check" in (await run()).result, false, "a run nobody names a checker for is not checked");
  setMeta("../beside");
  assert.equal((await run()).result.check.by, realpathSync(beside));
  assert.equal((await run({ checkWith: "checks" })).result.check.by, named);
  setMeta("checks");
  assert.equal((await run()).result.check.by, named);
  assert.deepEqual([journalsOf(beside).length, journalsOf(named).length], [1, 2]);

  // A run that could not be checked as it was to be is not begun: nothing is run, and nothing is on record.
  const before = journalsOf(projectDir).length;
  setMeta(undefined);
  await assert.rejects(run({ checkWith: join(base, "nobody") }), /checkWith names no project: there is none at .*nobody/);
  await assert.rejects(run({ checkWith: projectDir }), /A project is not asked to check itself: checkWith names the project that is run\./);
  for (const wrong of [7, "", ["checks"]]) {
    setMeta(wrong);
    await assert.rejects(run(), /Malformed meta\.json in .* — "checkWith" is to name a project: by a path, or by its name among the user's projects\./, JSON.stringify(wrong));
  }
  setMeta("../nobody");
  await assert.rejects(run(), /checkWith names no project: there is none at .*nobody/);
  assert.equal(journalsOf(projectDir).length, before);
});

test("a check is the checked run's own: what its model is asked is counted in that run's budget, and where the budget is spent the check cannot be made", async (t) => {
  const took = (tokens) => ({ model: "p/m", input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, cost: tokens / 1000 });
  const original = llm.complete;
  let requests = 0;
  llm.complete = async (_request, call) => { requests += 1; call.used(took(400)); return { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" }; };
  t.after(() => { llm.complete = original; });

  // Counted: two requests at 400 tokens. On record where they were made — in the checker's journal — and said
  // where the check is: on the checked run's record, and in what that run used in all.
  const counted = projects(t, "ask");
  assert.equal((await counted.run({ budget: { tokens: 5000 } })).result.check.ok, true);
  assert.equal(requests, 2);
  const [check] = journalsOf(counted.projectDir)[0].filter((record) => record.kind === "check");
  assert.deepEqual(check.used, { calls: 2, tokens: 800, cost: 0.8 });
  const shown = (await captureConsole("log", async () => printJournals(counted.projectDir, "it", {}))).messages.join("\n");
  assert.match(shown, /checked by .*: ok  score 1  six words, as there are  800 tokens +\$0\.8000$/m);
  assert.match(shown, /end: done +\(800 tokens +\$0\.8000 in all\)/);
  // (A checker that asked no model has used nothing, and nothing is said of it.)
  const none = projects(t);
  await none.run();
  assert.equal("used" in journalsOf(none.projectDir)[0].at(-2), false);

  // Held: with one call allowed, the checker's second request is refused — it fails, and there is no verdict.
  requests = 0;
  const held = projects(t, "ask");
  const { result } = await held.run({ budget: { calls: 1 } });
  assert.deepEqual([result.status, "ok" in result.check, requests], ["done", false, 1]);
  assert.match(result.check.error, /The project asked for the check failed: [^]*The budget of a run this one is part of is spent: 1 of 1 calls to a model made\./);
});

test("the run a check is made by is a run for that and nothing more: not itself checked, and stopped with the run it checks", async (t) => {
  // A checker that names a checker of its own: nobody checks the check.
  const it = projects(t);
  const third = makeTempDir("trama-check-third-");
  t.after(() => cleanupTempDir(third));
  createProjectFixture(third, { programSource: CHECKER });
  writeJson(join(it.checker, "meta.json"), { ...readJson(join(it.checker, "meta.json")), checkWith: third });
  const { result } = await it.run();
  assert.deepEqual([result.check.ok, it.seen().length, journalsOf(third)], [true, 1, []]);
  assert.equal(journalsOf(it.checker)[0].some((record) => record.kind === "check"), false);

  // A run that is stopped while it is being checked is done, and was not checked; what checked it is gone, and its copy.
  const slow = projects(t, "wait");
  const stop = new AbortController();
  const going = slow.run({ signal: stop.signal });
  await waitFor(() => slow.seen().length === 1, "the checker to be at work", 20_000);
  const began = Date.now();
  stop.abort();
  const stopped = (await going).result;
  assert.deepEqual(stopped, { status: "done", result: { words: "6" }, check: { ...slow.by, error: "The run was stopped before its check was made." } });
  assert.ok(Date.now() - began < 15_000);
  const [told] = slow.seen();
  assert.deepEqual([isAlive(told.pid), existsSync(told.copy)], [false, false]);
});

test("a run that was fixed is checked as it ended: the fix is the project's by then, and what the checker is handed has it", async (t) => {
  const BROKEN = WORKS.replace(".length", ".lenght.toFixed(0)");
  const it = projects(t, undefined, BROKEN);
  const original = llm.repair;
  llm.repair = async () => WORKS;
  t.after(() => { llm.repair = original; });
  const { result } = await it.run({ maxRepairAttempts: 1 });
  assert.deepEqual(result, { status: "done", result: { words: "6" }, check: { ...it.by, ok: true, score: 1, notes: "six words, as there are" } });
  const [told] = it.seen();
  // (A fix is taken without the blank lines round it.)
  assert.equal(told.program, WORKS.trim());
  const [records] = journalsOf(it.projectDir);
  assert.deepEqual(records.filter((record) => ["attempt", "check"].includes(record.kind)).map((record) => record.kind), ["attempt", "attempt", "check"]);
  assert.deepEqual([readFileSync(join(it.projectDir, "history", "0001.ts"), "utf-8"), readFileSync(join(it.projectDir, "history", "0002.ts"), "utf-8")], [BROKEN, WORKS.trim()]);
});

test("a checker is a program like any: it can hold the run it checks to its own record, which is not yet at its end", async (t) => {
  const projectDir = makeTempDir("trama-check-work-"), checker = makeTempDir("trama-check-replays-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(checker); });
  createProjectFixture(projectDir, { programSource: WORKS });
  writeFileSync(join(projectDir, "data.txt"), "the heron waits at low tide");
  createProjectFixture(checker, { programSource: `import { ctx } from "@trama-dev/runtime";
import { replayProgram } from "@trama-dev/runtime/runner";
import { dirname } from "node:path";
const { journal, run, result } = ctx.input.args as any;
const went = await replayProgram({ projectDir: dirname(dirname(dirname(journal))), run });
await ctx.done({ ok: went.same && went.result.result.words === result.words, notes: went.answered + " of " + went.recorded + " calls, the same: " + went.same });
` });
  const result = await runProgram({ projectDir, checkWith: checker, maxRepairAttempts: 0, timeout: 30_000 });
  assert.deepEqual(result.check, { by: checker, program: result.check.program, ok: true, notes: "2 of 2 calls, the same: true" });
});

test("a program asks for a run that is checked as it asks for any run: the verdict is in what it is answered, and on its record to be replayed from", async (t) => {
  const base = makeTempDir("trama-check-asked-");
  t.after(() => cleanupTempDir(base));
  const work = join(base, "work"), checker = join(base, "checker"), asker = join(base, "asker"), seen = join(base, "seen.jsonl");
  createProjectFixture(work, { programSource: WORKS });
  writeFileSync(join(work, "data.txt"), "the heron waits at low tide");
  createProjectFixture(checker, { programSource: CHECKER });
  createProjectFixture(asker, { programSource: `import { ctx } from "@trama-dev/runtime";
import { runProgram } from "@trama-dev/runtime/runner";
const ran = await runProgram({ projectDir: "../work", checkWith: "../checker", maxRepairAttempts: 0 });
await ctx.done({ ran });
` });
  writeFileSync(seen, "");
  const result = await withEnv({ SEEN_BY_CHECKER: seen }, () => runProgram({ projectDir: asker, maxRepairAttempts: 0, timeout: 30_000 }));
  assert.deepEqual(result, { status: "done", result: { ran: { status: "done", result: { words: "6" }, check: { by: realpathSync(checker), program: hashOf(CHECKER), ok: true, score: 1, notes: "six words, as there are" } } } });
  const asked = journalsOf(asker)[0].find((record) => record.kind === "call" && record.endpoint === "/run/program");
  assert.equal(asked.request.checkWith, realpathSync(checker));
  // The checker's run is three deep: the asker's, the run it asked for, the check of that.
  assert.equal(journalsOf(checker)[0][0].depth, 2);

  const again = await replayProgram({ projectDir: asker });
  assert.deepEqual([again.answered, again.same, again.result], [1, true, result]);
  assert.equal(journalsOf(checker).length, 1);
});

test("trama run --check names who checks the run, says the verdict, and ends well only where the work was found good; trama journal shows the check", async (t) => {
  const CLI_ENTRY = join(REPO_ROOT, "packages", "cli", "dist", "index.js");
  const fakeHome = makeTempDir("trama-check-home-");
  t.after(() => cleanupTempDir(fakeHome));
  const work = join(fakeHome, ".trama", "projects", "work"), checker = join(fakeHome, ".trama", "projects", "checker"), seen = join(fakeHome, "seen.jsonl");
  createProjectFixture(work, { programSource: WORKS });
  writeFileSync(join(work, "data.txt"), "the heron waits at low tide");
  createProjectFixture(checker, { programSource: CHECKER });
  writeFileSync(seen, "");
  const trama = (...args) => runNodeCommand([CLI_ENTRY, ...args], { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome, SEEN_BY_CHECKER: seen } });

  const unchecked = await trama("run", "work");
  assert.equal(unchecked.exitCode, 0, unchecked.stderr);
  assert.doesNotMatch(unchecked.stdout, /checked by/);

  const good = await trama("run", "work", "--check", "checker");
  assert.equal(good.exitCode, 0, good.stderr);
  assert.match(good.stdout, new RegExp(`\\[trama\\] checked by ${checker}: ok \\(score 1\\) — six words, as there are\\n`));
  const shown = await trama("journal", "work");
  assert.match(shown.stdout, new RegExp(`checked by ${checker} \\(program ${hashOf(CHECKER).slice(0, 8)}\\): ok  score 1  six words, as there are\\n`));

  writeFileSync(join(work, "how.txt"), "no");
  const bad = await trama("run", "work", "--check", "checker");
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stdout, /\[trama\] done\n/);
  assert.match(bad.stdout, new RegExp(`\\[trama\\] checked by ${checker}: not ok \\(score 0\\.25\\) — two words short\\n`));
  assert.match(bad.stderr, /^Error: The run is done, and its check says the work is not good\.\n$/);

  writeFileSync(join(work, "how.txt"), "fail");
  const unmade = await trama("run", "work", "--check", "checker");
  assert.equal(unmade.exitCode, 1);
  assert.match(unmade.stdout, new RegExp(`\\[trama\\] not checked by ${checker}: The project asked for the check failed: `));
  // (What the checker's program wrote as it failed is shown too, under its name.)
  assert.match(unmade.stderr, /^Error: The run is done, and its check could not be made\.\n/m);

  const nobody = await trama("run", "work", "--check", "nobody");
  assert.equal(nobody.exitCode, 1);
  assert.match(nobody.stderr, /checkWith names no project: there is none at .*nobody/);
});

test("the checker that is in the repository to begin from checks by a command: good where the command ends well in the project as the run left it", async (t) => {
  const EXAMPLE = join(REPO_ROOT, "examples", "check-by-command");
  const projectDir = makeTempDir("trama-check-work-"), checker = makeTempDir("trama-check-example-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(checker); });
  createProjectFixture(projectDir, { programSource: WORKS });
  writeFileSync(join(projectDir, "data.txt"), "the heron waits at low tide");
  cpSync(EXAMPLE, checker, { recursive: true });
  const meta = readJson(join(checker, "meta.json"));
  const checkedBy = async (args) => {
    writeJson(join(checker, "meta.json"), { ...meta, input: { ...meta.input, args } });
    return (await captureConsole("log", () => runProgram({ projectDir, checkWith: checker, maxRepairAttempts: 0, timeout: 30_000 }))).result;
  };

  const good = await checkedBy({ command: `test "$(cat made.txt)" = "made by the run" && echo it is there` });
  assert.deepEqual([good.status, good.check.ok, good.check.notes], ["done", true, "it is there\n"]);
  const bad = await checkedBy({ command: "echo looked; echo not found >&2; exit 2" });
  assert.deepEqual([bad.status, bad.check.ok, bad.check.notes], ["done", false, "exit code 2\nlooked\nnot found\n"]);
  const slow = await checkedBy({ command: "echo begun; sleep 20", seconds: 1 });
  assert.deepEqual([slow.check.ok, slow.check.notes], [false, "It was not done after the 1s it was given.\nbegun\n"]);
  // What a command printed is long: the end of it is kept, where a failure shows.
  const long = await checkedBy({ command: "seq 1 3000; exit 1" });
  assert.ok(long.check.notes.length < 2200 && long.check.notes.endsWith("\n2999\n3000\n") && long.check.notes.startsWith("exit code 1\n…"), long.check.notes.slice(0, 60));
  // A checker that was not told its command has no verdict to give.
  const untold = await checkedBy({});
  assert.match(untold.check.error, /The project asked for the check failed: [^]*It is not said what command checks/);
});
