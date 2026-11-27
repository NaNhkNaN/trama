import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHash } from "crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { llm } from "./fake-llm.mjs";
import { installValidatedProgram, replayProgram, rollbackTo, runProgram, validateProgram } from "../packages/runtime/dist/runner.js";
import { createBackend } from "../packages/runtime/dist/runner-backend.js";
import { MAX_RUNS_FILE, readHistory } from "../packages/runtime/dist/history.js";
import { REPO_ROOT, captureConsole, cleanupTempDir, createProjectFixture, makeTempDir, runNodeCommand, withEnv, writeJson } from "./helpers.mjs";

// History as a lineage: every program that is run is a version on record, every run leaves a line with the
// version it was of and how it went — kept as history is, and not for twenty runs as journals are — and a version
// can be gone back to. What is here is fact: which version, how it ended, what its check said, what it used.
// Nothing here says which is better.

const defaultsHome = makeTempDir("trama-lineage-defaults-");
const realHome = process.env.HOME;
process.env.HOME = defaultsHome;
after(() => {
  process.env.HOME = realHome;
  cleanupTempDir(defaultsHome);
});

const hashOf = (text) => createHash("sha256").update(text).digest("hex");
const ONE = `import { ctx } from "@trama-dev/runtime";
const { does, n } = ctx.input.args as any;
if (does === "fail") throw new Error("the program has a fault\\nand a second line of it");
if (does === "yield") await ctx.yield("more to do");
else await ctx.done({ n: n ?? 1 });
`;
const TWO = ONE.replace("n: n ?? 1", "n: n ?? 2");
const THREE = ONE.replace("n: n ?? 1", "n: n ?? 3");

const project = (t, programSource = ONE) => {
  const projectDir = makeTempDir("trama-lineage-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { programSource });
  return projectDir;
};
const run = (projectDir, more = {}) => captureConsole("log", () => runProgram({ projectDir, maxRepairAttempts: 0, timeout: 30_000, ...more })).then(({ result }) => result);
const versionFile = (projectDir, version) => readFileSync(join(projectDir, "history", `${String(version).padStart(4, "0")}.ts`), "utf-8");
const indexOf = (projectDir) => readFileSync(join(projectDir, "history", "index.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
const linesOf = (projectDir, file = "runs.jsonl") => readFileSync(join(projectDir, "history", file), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
const journalRuns = (projectDir) => (existsSync(join(projectDir, "logs", "journal")) ? readdirSync(join(projectDir, "logs", "journal")).sort().map((file) => file.replace(/\.jsonl$/, "")) : []);
/** A line without what is of the moment: when, and how long. */
const told = ({ at: _at, ms: _ms, ...line }) => line;

test("a program that is run is a version on record, and every run leaves a line: the version it was of, how it ended, what it used, and a mark of what it was started with", async (t) => {
  const projectDir = project(t);
  const before = Date.now();
  assert.deepEqual((await run(projectDir, { args: { n: 7 } })).result, { n: 7 });
  const after = Date.now();

  // The program was written by hand, and was on no record: it is one now — found, as it was when it was run.
  const [first, ...others] = indexOf(projectDir);
  assert.deepEqual(others, []);
  assert.deepEqual({ ...first, timestamp: "" }, { version: 1, reason: "found", timestamp: "", sha256: hashOf(ONE) });
  assert.equal(versionFile(projectDir, 1), ONE);
  // The run's line: with the run's id, by which its journal is found while that is kept.
  const [line] = linesOf(projectDir);
  assert.deepEqual(told(line), { run: journalRuns(projectDir)[0], version: 1, status: "done", used: { calls: 0, tokens: 0, cost: 0 }, input: line.input });
  assert.match(line.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  // (When it began: the time is the run's, and how long it took is beside it.)
  assert.ok(Date.parse(line.at) >= before && Date.parse(line.at) + line.ms <= after + 5, `${line.at} + ${line.ms}ms, in ${new Date(before).toISOString()} to ${new Date(after).toISOString()}`);
  assert.ok(Number.isInteger(line.ms) && line.ms >= 0);
  assert.match(line.input, /^[0-9a-f]{16}$/);

  // Run again as it is: the same version, and nothing new on record but the line. What it was started with is
  // told by a mark, not kept: the same for the same, another for another.
  await run(projectDir, { args: { n: 7 } });
  await run(projectDir, { args: { n: 8 } });
  await run(projectDir);
  assert.equal(indexOf(projectDir).length, 1);
  const inputs = linesOf(projectDir).map((each) => each.input);
  assert.deepEqual([inputs[1] === inputs[0], inputs[2] === inputs[0], inputs[3] === inputs[0], inputs[3] === inputs[2]], [true, false, false, false]);
  assert.deepEqual(linesOf(projectDir).map((each) => each.run), journalRuns(projectDir));
  // (The same arguments are the same in whatever order they were written, and to whatever depth.)
  const marks = [];
  for (const args of [{ a: 1, b: { c: 2, d: [3, { e: 4, f: 5 }] } }, { b: { d: [3, { f: 5, e: 4 }], c: 2 }, a: 1 }, { a: 1, b: { c: 2, d: [{ e: 4, f: 5 }, 3] } }]) {
    const other = project(t);
    await run(other, { args });
    marks.push(linesOf(other)[0].input);
  }
  assert.deepEqual([marks[1] === marks[0], marks[2] === marks[0]], [true, false]);

  // How a run ended is on its line, with the first line of why where it did not end as done.
  assert.equal((await run(projectDir, { args: { does: "fail" } })).status, "failed");
  assert.equal((await run(projectDir, { args: { does: "yield" } })).status, "yielded");
  const [failed, yielded] = linesOf(projectDir).slice(-2);
  assert.deepEqual([failed.status, failed.reason, failed.version], ["failed", "Program failed (repair disabled): program.ts exited with code 1", 1]);
  assert.deepEqual([yielded.status, yielded.reason], ["yielded", "more to do"]);

  // Changed by hand, and run: another version, and the run is of that one.
  writeFileSync(join(projectDir, "program.ts"), TWO);
  assert.deepEqual((await run(projectDir)).result, { n: 2 });
  assert.deepEqual(indexOf(projectDir).map(({ version, reason, sha256 }) => [version, reason, sha256]), [[1, "found", hashOf(ONE)], [2, "found", hashOf(TWO)]]);
  assert.equal(versionFile(projectDir, 2), TWO);
  assert.deepEqual(linesOf(projectDir).map((each) => each.version), [1, 1, 1, 1, 1, 1, 2]);

  // As it is read back: the versions, the runs, and which version the program is now.
  const history = readHistory(projectDir);
  assert.deepEqual(history.versions.map(({ version, reason, sha256 }) => [version, reason, sha256]), [[1, "found", hashOf(ONE)], [2, "found", hashOf(TWO)]]);
  assert.deepEqual([history.runs, history.current], [linesOf(projectDir), 2]);

  // Changed back by hand to what it was: that is the program after the second version, and is on record as
  // the third — the latest version is the program that was last run, whatever text an earlier one had.
  writeFileSync(join(projectDir, "program.ts"), ONE);
  await run(projectDir);
  assert.deepEqual(indexOf(projectDir).map(({ version, sha256 }) => [version, sha256]), [[1, hashOf(ONE)], [2, hashOf(TWO)], [3, hashOf(ONE)]]);
  assert.deepEqual([linesOf(projectDir).at(-1).version, readHistory(projectDir).current], [3, 3]);
});

test("a run's line has what its check said and what it used of a model; and a run the runner itself made — a check, a fix — says in its own project's history what it was for", async (t) => {
  const took = (tokens) => ({ model: "p/m", input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, cost: tokens / 1000 });
  const original = { ...llm };
  llm.complete = async (_request, call) => { call.used(took(400)); return { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" }; };
  t.after(() => { Object.assign(llm, original); });

  const CHECKER = `import { ctx, agent } from "@trama-dev/runtime";
const { result } = ctx.input.args as any;
for (const turn of [1, 2]) await agent.complete({ messages: [{ role: "user", content: "turn " + turn }] });
if (result.n === 13) throw new Error("the checker has a fault of its own");
await ctx.done({ ok: result.n < 5, score: result.n / 10, notes: "n".repeat(result.n === 4 ? 500 : 3) });
`;
  const projectDir = project(t), checker = project(t, CHECKER);
  const by = { by: checker, program: hashOf(CHECKER) };
  await run(projectDir, { checkWith: checker, args: { n: 2 } });
  await run(projectDir, { checkWith: checker, args: { n: 9 } });
  await run(projectDir, { checkWith: checker, args: { n: 4 } });
  await run(projectDir, { checkWith: checker, args: { n: 13 } });
  await run(projectDir, { args: { n: 2 } });
  const [good, bad, long, unmade, unchecked] = linesOf(projectDir);
  // The verdict, and who gave it; what the run used in all — its checker's requests among it.
  assert.deepEqual([good.check, good.used], [{ ...by, ok: true, score: 0.2, notes: "nnn" }, { calls: 2, tokens: 800, cost: 0.8 }]);
  // And by which model: here its checker's, the one there was. A run that asked no model says none.
  assert.deepEqual([good.models, "models" in unchecked], [{ "p/m": { calls: 2, tokens: 800, cost: 0.8 } }, false]);
  assert.deepEqual(bad.check, { ...by, ok: false, score: 0.9, notes: "nnn" });
  // (A line is short: of long notes, and of why a check could not be made, it has the beginning.)
  assert.deepEqual([long.check.ok, long.check.notes], [true, `${"n".repeat(200)}…`]);
  assert.deepEqual([Object.keys(unmade.check).sort(), unmade.check.error.length <= 201], [["by", "error", "program"], true]);
  assert.match(unmade.check.error, /^The project asked for the check failed: /);
  assert.equal("check" in unchecked, false);

  // The checker's own history: its program is a version there, and each of its runs says it was a check.
  assert.deepEqual(indexOf(checker).map(({ version, reason }) => [version, reason]), [[1, "found"]]);
  assert.deepEqual(linesOf(checker).map((each) => [each.for, each.version, each.status]), [["check", 1, "done"], ["check", 1, "done"], ["check", 1, "done"], ["check", 1, "failed"]]);
  assert.equal("for" in good, false);

  // A run that was fixed: the program as it failed is on record — it can be gone back to — and the fix is the
  // next version; the line says which the run began as, which it ended as, and by which attempt.
  const BROKEN = ONE.replace("n: n ?? 1", "n: (n ?? 1).toFixd(0)");
  const broken = project(t, BROKEN), fixer = project(t, `import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ program: (ctx.input.args as any).program.replace("toFixd", "toFixed") });\n`);
  assert.equal((await run(broken)).status, "failed");
  const mended = await captureConsole("warn", () => run(broken, { repairWith: fixer, maxRepairAttempts: 2 }));
  assert.deepEqual(mended.result, { status: "done", result: { n: "1" } });
  assert.deepEqual(indexOf(broken).map(({ version, reason, sha256 }) => [version, reason, sha256]), [[1, "found", hashOf(BROKEN)], [2, "repair", hashOf(BROKEN.replace("toFixd", "toFixed"))]]);
  assert.equal(versionFile(broken, 1), BROKEN);
  // (The line of the run before is there as it was: what a fix's trial did in its copy is merged, and this is no part of it.)
  assert.deepEqual(linesOf(broken).map((each) => [each.status, each.version, each.ended, each.repaired]), [["failed", 1, undefined, undefined], ["done", 1, 2, 1]]);
  assert.deepEqual(linesOf(fixer).map((each) => [each.for, each.status]), [["fix", "done"]]);
  assert.equal(readHistory(broken).current, 2);
});

test("only a run leaves a line: not a validation, not a replay — and a run that is not recorded leaves one all the same, without the id of a journal", async (t) => {
  const projectDir = project(t);
  await run(projectDir);
  const before = readFileSync(join(projectDir, "history", "runs.jsonl"), "utf-8");
  await validateProgram(projectDir, createBackend({ provider: "fake", model: "plain" }), TWO, { timeout: 20_000, maxRepairAttempts: 0, journalRuns: 20 });
  assert.equal((await replayProgram({ projectDir })).same, true);
  assert.equal(readFileSync(join(projectDir, "history", "runs.jsonl"), "utf-8"), before);
  assert.deepEqual(readdirSync(join(projectDir, "history")).sort(), ["0001.ts", "index.jsonl", "runs.jsonl"]);

  const quiet = makeTempDir("trama-lineage-quiet-");
  t.after(() => cleanupTempDir(quiet));
  writeJson(join(quiet, ".trama", "config.json"), { journalRuns: 0 });
  const journals = journalRuns(projectDir);
  await withEnv({ HOME: quiet }, () => run(projectDir));
  const [, unrecorded] = linesOf(projectDir);
  assert.deepEqual([journalRuns(projectDir), "run" in unrecorded, unrecorded.version, unrecorded.status], [journals, false, 1, "done"]);

  // What cannot be written of a run is not the run's failure. (A file where the lines go that takes none.)
  const closed = project(t);
  mkdirSync(join(closed, "history", "runs.jsonl"));
  const { result, messages } = await captureConsole("warn", () => run(closed));
  assert.deepEqual(result, { status: "done", result: { n: 1 } });
  assert.ok(messages.some((message) => /^\[trama\] the run is not in the project's history: /.test(message)), messages.join("\n"));
});

test("runs of one project at the same time, each by a runner of its own, leave the program on record once and a whole line each", async (t) => {
  const CLI_ENTRY = join(REPO_ROOT, "packages", "cli", "dist", "index.js");
  const fakeHome = makeTempDir("trama-lineage-home-");
  t.after(() => cleanupTempDir(fakeHome));
  const projectDir = join(fakeHome, ".trama", "projects", "demo");
  createProjectFixture(projectDir, { programSource: ONE });
  const trama = (...args) => runNodeCommand([CLI_ENTRY, ...args], { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome } });
  // (Run once before, by itself: what a project's first run makes ready for it is not what this is about.)
  assert.equal((await trama("run", "demo")).exitCode, 0);
  writeFileSync(join(projectDir, "program.ts"), TWO);
  const ran = await Promise.all(Array.from({ length: 6 }, (_, n) => trama("run", "demo", "--arg", `n=${n}`)));
  assert.deepEqual(ran.map((each) => each.exitCode), [0, 0, 0, 0, 0, 0], ran.map((each) => each.stderr).join("\n"));
  assert.deepEqual(indexOf(projectDir).map(({ version, reason, sha256 }) => [version, reason, sha256]), [[1, "found", hashOf(ONE)], [2, "found", hashOf(TWO)]]);
  assert.deepEqual(readdirSync(join(projectDir, "history")).sort(), ["0001.ts", "0002.ts", "index.jsonl", "runs.jsonl"]);
  const lines = linesOf(projectDir).slice(1);
  assert.deepEqual([lines.length, lines.map((each) => each.version), new Set(lines.map((each) => each.run)).size], [6, [2, 2, 2, 2, 2, 2], 6]);
});

test("the runs on record are the latest: the file they are in is put aside when it is full, in the place of the one put aside before", async (t) => {
  const projectDir = project(t);
  const runs = join(projectDir, "history", "runs.jsonl"), aside = join(projectDir, "history", "runs.1.jsonl");
  const filled = (mark) => {
    const line = `${JSON.stringify({ at: "2026-01-01T00:00:00.000Z", status: "done", mark, pad: "x".repeat(900) })}\n`;
    writeFileSync(runs, line.repeat(Math.ceil(MAX_RUNS_FILE / line.length)));
    return Math.ceil(MAX_RUNS_FILE / line.length);
  };
  // Not yet full: the run's line is added to it.
  writeFileSync(runs, `${JSON.stringify({ at: "2026-01-01T00:00:00.000Z", status: "done", mark: "early" })}\n`);
  await run(projectDir);
  assert.deepEqual([linesOf(projectDir).map((each) => each.mark ?? each.status), existsSync(aside)], [["early", "done"], false]);

  const first = filled("first");
  await run(projectDir, { args: { n: 5 } });
  assert.deepEqual([linesOf(projectDir).length, linesOf(projectDir, "runs.1.jsonl").length, linesOf(projectDir, "runs.1.jsonl")[0].mark], [1, first, "first"]);
  // Read back, they are one list, oldest first.
  const history = readHistory(projectDir);
  assert.deepEqual([history.runs.length, history.runs[0].mark, history.runs.at(-1).version], [first + 1, "first", 1]);
  assert.ok(statSync(runs).size < 1000);

  const second = filled("second");
  await run(projectDir);
  assert.deepEqual([linesOf(projectDir).length, linesOf(projectDir, "runs.1.jsonl").length, linesOf(projectDir, "runs.1.jsonl")[0].mark], [1, second, "second"]);
  assert.deepEqual(readdirSync(join(projectDir, "history")).sort(), ["0001.ts", "index.jsonl", "runs.1.jsonl", "runs.jsonl"]);
});

test("a history is read as it is on record: versions written before a version's hash was kept are told by their files, and what the program is now is said only where it is the latest version", async (t) => {
  const projectDir = project(t, "// two");
  writeFileSync(join(projectDir, "history", "0001.ts"), "// one");
  writeFileSync(join(projectDir, "history", "0002.ts"), "// two");
  writeFileSync(join(projectDir, "history", "index.jsonl"), [
    { version: 1, reason: "create", timestamp: "2026-11-01T00:00:00.000Z", prompt: "make it" },
    { reason: "update-repair", timestamp: "2026-11-02T00:00:00.000Z", error: "it broke while it was tried" },
    { version: 2, reason: "update", timestamp: "2026-11-02T00:00:00.000Z", prompt: "make it better" },
    { version: 3, reason: "repair", timestamp: "2026-11-03T00:00:00.000Z", error: "its file is gone" },
  ].map((line) => JSON.stringify(line)).join("\n") + "\nnot a line of it\n");
  writeFileSync(join(projectDir, "history", "0003.ts"), "// two");
  const history = readHistory(projectDir);
  assert.deepEqual(history, {
    versions: [
      { version: 1, reason: "create", at: "2026-11-01T00:00:00.000Z", sha256: hashOf("// one"), detail: "make it" },
      // (Written before a version's line said which it was written from: an update and a fix are of the version before them.)
      { version: 2, reason: "update", at: "2026-11-02T00:00:00.000Z", sha256: hashOf("// two"), detail: "make it better", parent: 1 },
      { version: 3, reason: "repair", at: "2026-11-03T00:00:00.000Z", sha256: hashOf("// two"), detail: "its file is gone", parent: 2 },
    ],
    runs: [],
    current: 3,
  });
  // A program that was changed since is no version, until it is run.
  writeFileSync(join(projectDir, "program.ts"), "// three");
  assert.equal("current" in readHistory(projectDir), false);
  // A project with no history has none.
  assert.deepEqual(readHistory(project(t)), { versions: [], runs: [] });
});

test("a version is gone back to by becoming the program again, as a new version: nothing is run, nothing else of the project is touched, and nothing on record is lost", async (t) => {
  const projectDir = project(t);
  await run(projectDir);
  writeFileSync(join(projectDir, "program.ts"), TWO);
  await run(projectDir);
  writeFileSync(join(projectDir, "notes.txt"), "the project's own");
  const state = readFileSync(join(projectDir, "state.json"), "utf-8"), journals = journalRuns(projectDir), lines = linesOf(projectDir);

  assert.deepEqual(rollbackTo(projectDir, 1), { version: 3, from: 1 });
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), ONE);
  const added = indexOf(projectDir).at(-1);
  assert.deepEqual({ ...added, timestamp: "" }, { version: 3, reason: "rollback", timestamp: "", sha256: hashOf(ONE), from: 1 });
  assert.deepEqual([versionFile(projectDir, 3), versionFile(projectDir, 2)], [ONE, TWO]);
  // Not run, and nothing else of the project changed: its state, its files, its records.
  assert.deepEqual([readFileSync(join(projectDir, "state.json"), "utf-8"), readFileSync(join(projectDir, "notes.txt"), "utf-8"), journalRuns(projectDir), linesOf(projectDir)], [state, "the project's own", journals, lines]);
  const history = readHistory(projectDir);
  assert.deepEqual([history.current, history.versions.at(-1)], [3, { version: 3, reason: "rollback", at: added.timestamp, sha256: hashOf(ONE), from: 1 }]);
  // Run, it is of that version: the program is on record as it is.
  assert.deepEqual((await run(projectDir)).result, { n: 1 });
  assert.deepEqual([indexOf(projectDir).length, linesOf(projectDir).at(-1).version], [3, 3]);

  // A program that was changed by hand and never run is put on record before another takes its place.
  writeFileSync(join(projectDir, "program.ts"), THREE);
  assert.deepEqual(rollbackTo(projectDir, 2), { version: 5, from: 2 });
  assert.deepEqual(indexOf(projectDir).slice(-2).map(({ version, reason, from, sha256 }) => [version, reason, from, sha256]), [[4, "found", undefined, hashOf(THREE)], [5, "rollback", 2, hashOf(TWO)]]);
  assert.deepEqual([versionFile(projectDir, 4), readFileSync(join(projectDir, "program.ts"), "utf-8")], [THREE, TWO]);

  // A version that is the program already is not gone back to: there is nothing to do, and nothing is recorded.
  assert.deepEqual(rollbackTo(projectDir, 2), { unchanged: true, version: 5 });
  assert.deepEqual(rollbackTo(projectDir, 5), { unchanged: true, version: 5 });
  assert.equal(indexOf(projectDir).length, 5);

  // What is no version of the project is none to go back to.
  assert.throws(() => rollbackTo(projectDir, 9), /No version 9 is in the history of .*: `trama history <name>` shows those there are\./);
  for (const wrong of [0, 1.5, -1, "1", NaN]) assert.throws(() => rollbackTo(projectDir, wrong), /A version is named by its number: 1 and up\./, String(wrong));
  // And a program that may not be replaced is not: nothing is put on record for it either.
  chmodSync(join(projectDir, "program.ts"), 0o444);
  try {
    assert.throws(() => rollbackTo(projectDir, 1), /^Error: The program cannot be replaced: .*program\.ts is read-only\.$/);
  } finally {
    chmodSync(join(projectDir, "program.ts"), 0o644);
  }
  assert.deepEqual([indexOf(projectDir).length, readFileSync(join(projectDir, "program.ts"), "utf-8")], [5, TWO]);
});

test("trama history shows each version and how its runs went, the verdicts of each checker by themselves; trama rollback goes back to one", async (t) => {
  const CLI_ENTRY = join(REPO_ROOT, "packages", "cli", "dist", "index.js");
  const fakeHome = makeTempDir("trama-lineage-home-");
  t.after(() => cleanupTempDir(fakeHome));
  const projectDir = join(fakeHome, ".trama", "projects", "demo"), checker = join(fakeHome, ".trama", "projects", "checker");
  createProjectFixture(projectDir, { programSource: ONE });
  const CHECKER = `import { ctx } from "@trama-dev/runtime";\nconst { result } = ctx.input.args as any;\nawait ctx.done({ ok: result.n < 5, score: result.n / 10 });\n`;
  createProjectFixture(checker, { programSource: CHECKER });
  // (No fix is asked for where a run fails: nobody is there to ask.)
  writeJson(join(fakeHome, ".trama", "config.json"), { maxRepairAttempts: 0 });
  const trama = (...args) => runNodeCommand([CLI_ENTRY, ...args], { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome } });

  const none = await trama("history", "demo");
  assert.equal(none.exitCode, 0, none.stderr);
  assert.match(none.stdout, /^No version of demo is on record: its program has not been made by trama, or run, since history was kept\.\n$/);

  assert.equal((await trama("run", "demo", "--arg", "n=2", "--check", "checker")).exitCode, 0);
  assert.equal((await trama("run", "demo", "--arg", "n=8", "--check", "checker")).exitCode, 1);
  assert.equal((await trama("run", "demo", "--arg", "does=fail")).exitCode, 1);
  writeFileSync(join(projectDir, "program.ts"), TWO);
  assert.equal((await trama("run", "demo")).exitCode, 0);

  const shown = await trama("history", "demo");
  assert.equal(shown.exitCode, 0, shown.stderr);
  const when = "\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d";
  assert.match(shown.stdout, new RegExp(
    `^v1  found  ${when}  ${hashOf(ONE).slice(0, 8)}\\n` +
    `    3 runs: 2 done, 1 failed; [\\d.]+s on the mean\\n` +
    `    checked by ${checker} \\(program ${hashOf(CHECKER).slice(0, 8)}\\): 1 of 2 ok; score 0\\.5 on the mean\\n` +
    `v2  found  ${when}  ${hashOf(TWO).slice(0, 8)}  ← the program now\\n` +
    `    1 run: 1 done; [\\d.]+s on the mean\\n` +
    `4 runs are on record, the first of ${when}\\.\\n$`));

  const [first] = linesOf(projectDir);
  const each = await trama("history", "demo", "--runs");
  assert.match(each.stdout, new RegExp(`\\n      ${first.run}  done  ok \\(score 0\\.2\\)  [\\d.]+s\\n      \\S+  done  not ok \\(score 0\\.8\\)  [\\d.]+s\\n      \\S+  failed  [\\d.]+s  Program failed \\(repair disabled\\): program\\.ts exited with code 1\\nv2 `));

  const back = await trama("rollback", "demo", "1");
  assert.equal(back.exitCode, 0, back.stderr);
  assert.match(back.stdout, /^demo is at version 1 again, as version 3\. The program was not run, and nothing else of the project was changed\.\n$/);
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), ONE);
  const after = await trama("history", "demo");
  assert.match(after.stdout, new RegExp(`\\nv3  rollback  ${when}  ${hashOf(ONE).slice(0, 8)}  from v1  ← the program now\\n    no runs on record\\n4 runs are on record, the first of ${when}\\.\\n$`));
  const again = await trama("rollback", "demo", "3");
  assert.deepEqual([again.exitCode, again.stdout], [0, "demo is at version 3 already: nothing was changed.\n"]);

  // A program changed since its last version is said to be on no record.
  writeFileSync(join(projectDir, "program.ts"), THREE);
  assert.match((await trama("history", "demo")).stdout, /\nThe program as it is now is on no record: it was changed after version 3, and is recorded when it is next run\.\n$/);

  for (const wrong of ["9", "one"]) {
    const refused = await trama("rollback", "demo", wrong);
    assert.equal(refused.exitCode, 1, wrong);
    assert.match(refused.stderr, wrong === "9" ? /No version 9 is in the history of/ : /A version is named by its number: 1 and up\./);
  }
});

// --- the history as an archive: what a version was written from, and which model did a run's work ---

test("a version says which it was written from, where that is known — an update and a fix: the version the program was — and says that it is not known, where the program was on no record", async (t) => {
  const projectDir = project(t);
  await run(projectDir);
  installValidatedProgram(projectDir, { source: TWO }, "update", "make it two");
  // Changed by hand since, and not run: the program an update is then written from is on no record.
  writeFileSync(join(projectDir, "program.ts"), THREE);
  installValidatedProgram(projectDir, { source: ONE }, "update", "make it one again");
  rollbackTo(projectDir, 2);
  assert.deepEqual(indexOf(projectDir).map(({ timestamp: _timestamp, sha256: _sha256, prompt: _prompt, ...line }) => line), [
    { version: 1, reason: "found" },
    { version: 2, reason: "update", parent: 1 },
    { version: 3, reason: "update", parent: null },
    // (A version gone back to is the text of one there is: it was written from nothing.)
    { version: 4, reason: "rollback", from: 2 },
  ]);
  // Read back: the parent where there is one — and none where the line says there is none, which is not "the one before".
  assert.deepEqual(readHistory(projectDir).versions.map((version) => [version.version, version.parent ?? null, "parent" in version]), [[1, null, false], [2, 1, true], [3, null, false], [4, null, false]]);

  // A fix is written from the program that failed.
  const BROKEN = ONE.replace("n: n ?? 1", "n: (n ?? 1).toFixd(0)");
  const broken = project(t, BROKEN), fixer = project(t, `import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ program: (ctx.input.args as any).program.replace("toFixd", "toFixed") });\n`);
  await captureConsole("warn", () => run(broken, { repairWith: fixer, maxRepairAttempts: 2 }));
  assert.deepEqual(indexOf(broken).map(({ version, reason, parent }) => [version, reason, parent]), [[1, "found", undefined], [2, "repair", 1]]);
});

test("a run's line says which models did its work: what each was asked and used, by the runner's count — the runs it asked for among it — and nothing of a call that named no model", async (t) => {
  const original = { ...llm };
  // (The model that serves a request is the one its last word names: none, where it names none.)
  llm.complete = async (request, call) => {
    const asked = JSON.stringify(request);
    const named = ["big", "small", "none"].find((name) => asked.includes(`"${name}"`));
    // (It says what it has used twice, as a backend does while a call lasts: each word of it replaces the last, and the call is one.)
    for (const sofar of [40, 100]) call.used({ ...(named !== "none" && { model: `p/${named}` }), input: sofar, output: 0, cacheRead: 0, cacheWrite: 0, cost: sofar / 1000 });
    return { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" };
  };
  t.after(() => { Object.assign(llm, original); });
  const ASKS = `import { ctx, agent } from "@trama-dev/runtime";
import { runProgram } from "@trama-dev/runtime/runner";
const { models, then } = ctx.input.args as { models: string[]; then?: string };
for (const model of models) await agent.complete({ messages: [{ role: "user", content: model }] });
if (then) await runProgram({ projectDir: then, args: { models: ["small"] }, maxRepairAttempts: 0 });
await ctx.done({});
`;
  const projectDir = project(t, ASKS), other = project(t, ASKS);
  const went = await run(projectDir, { args: { models: ["big", "small", "big", "none"] } });
  assert.equal(went.status, "done", went.reason);
  await run(projectDir, { args: { models: ["big"], then: other } });
  await run(projectDir, { args: { models: [] } });
  const [mixed, asking, none] = linesOf(projectDir);
  assert.deepEqual([mixed.used, mixed.models], [{ calls: 4, tokens: 400, cost: 0.4 }, { "p/big": { calls: 2, tokens: 200, cost: 0.2 }, "p/small": { calls: 1, tokens: 100, cost: 0.1 } }]);
  // What a run it asked for used is its own too, as it is of its budget.
  assert.deepEqual([asking.used.calls, asking.models], [2, { "p/big": { calls: 1, tokens: 100, cost: 0.1 }, "p/small": { calls: 1, tokens: 100, cost: 0.1 } }]);
  assert.deepEqual(linesOf(other).map((line) => line.models), [{ "p/small": { calls: 1, tokens: 100, cost: 0.1 } }]);
  assert.equal("models" in none, false);
  assert.deepEqual(readHistory(projectDir).runs.map((line) => Object.keys(line.models ?? {})), [["p/big", "p/small"], ["p/big", "p/small"], []]);
});
