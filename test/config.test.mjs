import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { REPO_ROOT, cleanupTempDir, createProjectFixture, makeTempDir, readJson, runNodeCommand, writeJson, writeText } from "./helpers.mjs";

// What stands where a command says nothing — who writes, who fixes, which model, what a run may use; and of a
// project: who checks its runs, its model, its own arguments — is said from the command line: trama config. (It was
// said by editing JSON, which is what both first users did.) And a run names who fixes it: --fix-with.

const CLI_ENTRY = join(REPO_ROOT, "packages", "cli", "dist", "index.js");
const GOOD = (n) => `import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ n: ${n} });\n`;

function home(t) {
  const fakeHome = makeTempDir("trama-config-home-");
  t.after(() => cleanupTempDir(fakeHome));
  const at = (name) => join(fakeHome, ".trama", "projects", name);
  const trama = (...args) => runNodeCommand([CLI_ENTRY, ...args], { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome } });
  const FILE = join(fakeHome, ".trama", "config.json");
  return { fakeHome, at, trama, FILE, file: () => (existsSync(FILE) ? readJson(FILE) : undefined) };
}

test("trama config: the user's configuration is shown as it holds, and a thing of it is set, or taken out, from the command line — held to what the configuration is held to, and written only where it holds", async (t) => {
  const it = home(t);
  // With nothing said, all of it: what a fresh home has.
  const all = await it.trama("config");
  assert.deepEqual([all.exitCode, all.stderr], [0, ""]);
  assert.deepEqual(JSON.parse(all.stdout), { provider: "anthropic", model: "claude-opus-5-5", maxRepairAttempts: 3, defaultTimeout: 300000, journalRuns: 20, agentChanges: "keep" });
  assert.equal(it.file(), undefined, "looking writes nothing");

  // Who fixes: a project, which is to be there.
  const nobody = await it.trama("config", "repairWith", "nobody");
  assert.equal(nobody.exitCode, 1);
  assert.match(nobody.stderr, /repairWith names no project: there is none at .*\/\.trama\/projects\/nobody/);
  assert.equal(it.file(), undefined);
  createProjectFixture(it.at("mender"), { programSource: GOOD(0) });
  const set = await it.trama("config", "repairWith", "mender");
  assert.deepEqual([set.exitCode, set.stderr, it.file()], [0, "", { repairWith: "mender" }]);
  assert.equal((await it.trama("config", "repairWith")).stdout, "mender\n");
  assert.equal(JSON.parse((await it.trama("config")).stdout).repairWith, "mender");
  // A number is a number; what is none is refused, and nothing is written.
  await it.trama("config", "maxRepairAttempts", "1");
  assert.deepEqual(it.file(), { repairWith: "mender", maxRepairAttempts: 1 });
  for (const [key, value, why] of [
    ["maxRepairAttempts", "many", /"maxRepairAttempts" is a number, and "many" is none\./],
    ["maxRepairAttempts", "1.5", /Invalid config: "maxRepairAttempts" must be a non-negative integer \(got 1\.5\)/],
    ["agentChanges", "some", /Invalid config: "agentChanges" must be "keep" or "discard"/],
    ["colour", "blue", /The configuration has no "colour": it holds provider, model, maxRepairAttempts, defaultTimeout, journalRuns, agentChanges, repairWith, updateWith, createWith, agents, budget\./],
    ["model.name", "x", /"model\.name" names nothing the configuration holds: a part is named of agents \(agents\.<name>\) and of budget \(budget\.cost, budget\.tokens, budget\.calls\) alone\./],
    ["agents.claude", "npx an-adapter", /"agents\.claude" is written as JSON, and this is none: /],
    ["budget.cost", "-1", /Invalid config: /],
  ]) {
    const refused = await it.trama("config", key, value);
    assert.equal(refused.exitCode, 1, key);
    assert.match(refused.stderr, why, key);
    assert.deepEqual(it.file(), { repairWith: "mender", maxRepairAttempts: 1 }, key);
  }
  // A part of a budget, and an agent from outside by its name — as JSON.
  await it.trama("config", "budget.cost", "2.5");
  await it.trama("config", "agents.claude", '{"command":"npx","args":["-y","an-adapter"]}');
  await it.trama("config", "model", "another-model");
  assert.deepEqual(it.file(), { repairWith: "mender", maxRepairAttempts: 1, budget: { cost: 2.5 }, agents: { claude: { command: "npx", args: ["-y", "an-adapter"] } }, model: "another-model" });
  assert.equal((await it.trama("config", "budget.cost")).stdout, "2.5\n");
  // Taken out: the thing, or the part — and with its last part the whole.
  for (const key of ["repairWith", "budget.cost", "maxRepairAttempts"]) assert.equal((await it.trama("config", key, "--unset")).exitCode, 0, key);
  assert.deepEqual(it.file(), { agents: { claude: { command: "npx", args: ["-y", "an-adapter"] } }, model: "another-model" });
  assert.equal((await it.trama("config", "repairWith")).stdout, "");
  const both = await it.trama("config", "model", "x", "--unset");
  assert.equal(both.exitCode, 1);
  assert.match(both.stderr, /--unset takes a thing out: it is given no value\./);
  // What else the file had is kept as it was; a file that is no configuration is said to be none, and is left.
  writeJson(it.FILE, { model: "m", note: "of the user's own" });
  await it.trama("config", "journalRuns", "5");
  assert.deepEqual(it.file(), { model: "m", note: "of the user's own", journalRuns: 5 });
  writeText(it.FILE, "{ not json");
  const broken = await it.trama("config", "journalRuns", "6");
  assert.equal(broken.exitCode, 1);
  assert.match(broken.stderr, /Malformed config at /);
  assert.equal(readFileSync(it.FILE, "utf-8"), "{ not json");
});

test("trama config --project: who checks a project's runs, its model and its own arguments are set from the command line — an argument held to what the project says it takes", async (t) => {
  const it = home(t);
  createProjectFixture(it.at("sum"), { programSource: `import { ctx } from "@trama-dev/runtime";
const { a = 0, b = 0 } = ctx.input.args as { a?: number; b?: number };
await ctx.done({ sum: a + b });
` });
  const META = { description: "Adds two numbers.", parameters: { "a?": "number", "b?": "number" }, returns: { sum: "number" }, input: { prompt: "p", args: {} } };
  writeJson(join(it.at("sum"), "meta.json"), META);
  createProjectFixture(it.at("judge"), { programSource: `import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ ok: false, notes: "never good enough" });\n` });
  const meta = () => readJson(join(it.at("sum"), "meta.json"));
  const shown = await it.trama("config", "--project", "sum");
  assert.deepEqual([shown.exitCode, JSON.parse(shown.stdout)], [0, { args: {} }]);

  // An argument of its own: read as what the project says it takes, and what a run has where the run gives none.
  assert.equal((await it.trama("config", "--project", "sum", "args.a", "2")).exitCode, 0);
  assert.deepEqual(meta(), { ...META, input: { prompt: "p", args: { a: 2 } } });
  assert.deepEqual(JSON.parse((await it.trama("run", "sum", "--arg", "b=3", "--json")).stdout).result, { sum: 5 });
  for (const [key, value, why] of [
    ["args.a", "two", /The arguments do not fit what .*sum takes/],
    ["args.c", "1", /sum does not take "c": it takes a, b\./],
    ["args", "1", /"args" names nothing of a project's that is set here: checkWith, model, provider, and an argument of its own \(args\.<name>\)\./],
    ["checkWith", "nobody", /checkWith names no project: there is none at /],
    ["checkWith", "sum", /A project is not asked to check itself/],
    ["model", "", /"model" must be a non-empty string/],
  ]) {
    const refused = await it.trama("config", "--project", "sum", key, value);
    assert.equal(refused.exitCode, 1, key);
    assert.match(refused.stderr, why, key);
    assert.deepEqual(meta(), { ...META, input: { prompt: "p", args: { a: 2 } } }, key);
  }
  // Who checks its runs, from then on: a run that names nobody is checked by it.
  assert.equal((await it.trama("config", "--project", "sum", "checkWith", "judge")).exitCode, 0);
  assert.equal(meta().checkWith, "judge");
  const ran = await it.trama("run", "sum", "--json");
  assert.deepEqual([ran.exitCode, JSON.parse(ran.stdout).check.ok, JSON.parse(ran.stdout).check.notes], [1, false, "never good enough"]);
  await it.trama("config", "--project", "sum", "model", "its-own-model");
  assert.deepEqual(JSON.parse((await it.trama("config", "--project", "sum")).stdout), { checkWith: "judge", model: "its-own-model", args: { a: 2 } });
  assert.equal((await it.trama("config", "--project", "sum", "args.a")).stdout, "2\n");
  // Taken out again: the project is as it was.
  for (const key of ["checkWith", "model", "args.a"]) assert.equal((await it.trama("config", "--project", "sum", key, "--unset")).exitCode, 0, key);
  assert.deepEqual(meta(), META);
  // Of a project that says nothing of what it takes, an argument is the text it was given.
  await it.trama("config", "--project", "judge", "args.strict", "yes");
  assert.deepEqual(readJson(join(it.at("judge"), "meta.json")).input.args, { strict: "yes" });
  const none = await it.trama("config", "--project", "nobody");
  assert.equal(none.exitCode, 1);
  assert.match(none.stderr, /Project "nobody" not found/);
});

test("trama run --fix-with: a run names the project that is asked for a fix, where its program fails", async (t) => {
  const it = home(t);
  createProjectFixture(it.at("fails"), { programSource: `throw new Error("it breaks");\n` });
  createProjectFixture(it.at("mender"), { programSource: `import { ctx } from "@trama-dev/runtime";
const { program } = ctx.input.args as { program?: string };
await ctx.done(program === undefined ? { nothing: "to fix" } : { program: ${JSON.stringify(GOOD(7))} });
` });
  const ran = await it.trama("run", "fails", "--fix-with", "mender", "--json");
  assert.deepEqual([ran.exitCode, JSON.parse(ran.stdout)], [0, { status: "done", result: { n: 7 } }]);
  assert.equal(readFileSync(join(it.at("fails"), "program.ts"), "utf-8"), GOOD(7));
  assert.equal(existsSync(it.at("program-fixer")), false, "nobody else was looked for");
  const nobody = await it.trama("run", "fails", "--fix-with", "nobody");
  assert.equal(nobody.exitCode, 1);
  assert.match(nobody.stderr, /repairWith names no project: there is none at /);
});
