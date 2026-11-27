import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "fs";
import { join } from "path";
import "./fake-llm.mjs";
import { readHistory, runProgram } from "../packages/runtime/dist/index.js";
import { REPO_ROOT, captureConsole, cleanupTempDir, createProjectFixture, makeTempDir, runNodeCommand, withEnv, writeJson } from "./helpers.mjs";

// What judges a run is out of that run's reach — by its runner's own calls. A run asks its runner for a project
// to be made or changed, and the runner does it: but not to the project that checks that run, nor to the one that
// fixes it, nor to those of a run it is part of. And whoever starts a run can say that it is given no way to make
// or change projects at all, as a run that checks, fixes or writes is given none. (What a program does to files
// with its own hands is another matter: a boundary's, which is the user's to choose. The stand-in for the model
// is imported so that a test fails where a model is asked: nothing here asks one.)

const CLI_ENTRY = join(REPO_ROOT, "packages", "cli", "dist", "index.js");

/** A judge that is never satisfied; and what a run that would be judged kindly writes in its place. */
const JUDGE = `import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ ok: false, notes: "as it was" });\n`;
const KIND = `import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ ok: true, notes: "written by the judged" });\n`;
const HELLO = `import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ said: "hello" });\n`;

/** A program that asks its runner to change the project its argument \`who\` names — in each way there is — and says how each went. */
const MEDDLES = `import { ctx } from "@trama-dev/runtime";
import { addVersion, rollbackProject, updateProject } from "@trama-dev/runtime/runner";
const { who } = ctx.input.args as { who: string };
const told = (err: any) => String(err.message);
const went = [
  await addVersion(who, ${JSON.stringify(KIND)}).then((made) => "version " + made.version, told),
  await rollbackProject(who, 1).then(() => "went back", told),
  await updateProject(who, "write another").then(() => "updated", told),
];
await ctx.done({ went });
`;
/** A program that has another do the meddling: a run it starts — with what its argument \`with\` says, where it says. */
const HAS_IT_DONE = `import { ctx } from "@trama-dev/runtime";
import { resolveProject, runProgram } from "@trama-dev/runtime/runner";
const { who, ...more } = ctx.input.args as any;
const ran = await runProgram({ projectDir: resolveProject("worker"), args: { who }, maxRepairAttempts: 0, timeout: 60000, ...(more.with ?? {}) });
await ctx.done({ went: (ran.result as any)?.went ?? ran.reason });
`;

function home(t) {
  const fakeHome = makeTempDir("trama-reach-home-");
  t.after(() => cleanupTempDir(fakeHome));
  writeJson(join(fakeHome, ".trama", "config.json"), { maxRepairAttempts: 0 });
  const at = (name) => join(fakeHome, ".trama", "projects", name);
  for (const [name, programSource] of Object.entries({ judge: JUDGE, fixer: HELLO, other: HELLO, worker: MEDDLES, outer: HAS_IT_DONE })) createProjectFixture(at(name), { programSource });
  return { fakeHome, at };
}
const programOf = (dir) => readFileSync(join(dir, "program.ts"), "utf-8");
const quietly = async (fn) => (await captureConsole("warn", () => captureConsole("log", fn))).result.result;

test("what checks a run, and what fixes it, is not that run's to change through its runner — nor a run's that it starts; any other project is", async (t) => {
  const { fakeHome, at } = home(t);
  await withEnv({ HOME: fakeHome }, async () => {
    // The run is checked by `judge`, and asks for `judge` to be changed in each way there is: none is carried out,
    // each is refused in words — and the run is judged by the judge as it was.
    const judged = await quietly(() => runProgram({ projectDir: at("worker"), args: { who: "judge" }, checkWith: "judge", timeout: 60_000 }));
    assert.equal(judged.result.went.length, 3);
    for (const said of judged.result.went) assert.match(said, /Project "judge" is the one that checks this run, or a run it is part of: what checks a run, or fixes it, is not that run's to change\./);
    assert.deepEqual([judged.check.ok, judged.check.notes], [false, "as it was"]);
    assert.equal(programOf(at("judge")), JUDGE);
    assert.deepEqual((await readHistory(at("judge"))).versions.map((version) => version.reason), ["found"]);

    // Nor by a run it starts: what is out of a run's reach is out of the reach of all it has done for it.
    const through = await quietly(() => runProgram({ projectDir: at("outer"), args: { who: "judge" }, checkWith: "judge", timeout: 60_000 }));
    for (const said of through.result.went) assert.match(said, /is the one that checks this run, or a run it is part of/);
    assert.equal(programOf(at("judge")), JUDGE);

    // So of who fixes it — where the run may be fixed, and so has one.
    const fixed = await quietly(() => runProgram({ projectDir: at("worker"), args: { who: "fixer" }, repairWith: "fixer", maxRepairAttempts: 1, timeout: 60_000 }));
    for (const said of fixed.result.went) assert.match(said, /Project "fixer" is the one that fixes this run, or a run it is part of/);
    assert.equal(programOf(at("fixer")), HELLO);
    // (A run that is not to be fixed has no fixer, whoever is named for one: that project is like any other to it.)
    const unfixed = await quietly(() => runProgram({ projectDir: at("worker"), args: { who: "fixer" }, repairWith: "fixer", maxRepairAttempts: 0, timeout: 60_000 }));
    assert.match(unfixed.result.went[0], /^version \d+$/);

    // A project that is neither is changed as it always was — in a run that is checked, too.
    const free = await quietly(() => runProgram({ projectDir: at("worker"), args: { who: "other" }, checkWith: "judge", timeout: 60_000 }));
    assert.deepEqual(free.result.went.slice(0, 2), ["version 2", "went back"]);
    // And the judge itself, by a run it does not judge.
    const unjudged = await quietly(() => runProgram({ projectDir: at("worker"), args: { who: "judge" }, timeout: 60_000 }));
    assert.match(unjudged.result.went[0], /^version \d+$/);
  });
});

test("a run is given no way to make or change projects where whoever starts it says so — and nothing it starts is given one, whatever that is started with", async (t) => {
  const { fakeHome, at } = home(t);
  const NONE = /This run has no way to make projects, or change them: it was started without one/;
  await withEnv({ HOME: fakeHome }, async () => {
    const without = await quietly(() => runProgram({ projectDir: at("worker"), args: { who: "other" }, making: false, timeout: 60_000 }));
    assert.equal(without.result.went.length, 3);
    for (const said of without.result.went) assert.match(said, NONE);
    assert.deepEqual((await readHistory(at("other"))).versions.length, 0);

    // What it starts has none either: asked for with one, it is not given what its asker does not have.
    const below = await quietly(() => runProgram({ projectDir: at("outer"), args: { who: "other", with: { making: true } }, making: false, timeout: 60_000 }));
    for (const said of below.result.went) assert.match(said, NONE);
    // And a program says it of a run it starts, as a host does: by its runner.
    const asked = await quietly(() => runProgram({ projectDir: at("outer"), args: { who: "other", with: { making: false } }, timeout: 60_000 }));
    for (const said of asked.result.went) assert.match(said, NONE);
    assert.equal(programOf(at("other")), HELLO);
    // (With nothing said, it has the way its asker has — and so where it is said to have one.)
    const given = await quietly(() => runProgram({ projectDir: at("outer"), args: { who: "other" }, timeout: 60_000 }));
    assert.match(given.result.went[0], /^version \d+$/);
    const said = await quietly(() => runProgram({ projectDir: at("worker"), args: { who: "other" }, making: true, timeout: 60_000 }));
    assert.match(said.result.went[0], /^version \d+$/);
  });

  // The command line says it too.
  const ran = await runNodeCommand([CLI_ENTRY, "run", "worker", "--arg", "who=fixer", "--no-making", "--json"], { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome } });
  assert.equal(ran.exitCode, 0, ran.stderr);
  for (const said of JSON.parse(ran.stdout).result.went) assert.match(said, NONE);
  const help = await runNodeCommand([CLI_ENTRY, "run", "--help"], { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome } });
  assert.match(help.stdout, /--no-making\s+Give the run no way to make projects, or change them/);
});
