import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { llm } from "./fake-llm.mjs";
import { createProject, runProgram, updateProject } from "../packages/runtime/dist/index.js";
import { runProgram as runWithoutMaking, validateProgram } from "../packages/runtime/dist/runner.js";
import { createBackend } from "../packages/runtime/dist/runner-backend.js";
import { printJournals } from "../packages/runtime/dist/journal-view.js";
import { captureConsole, cleanupTempDir, createProjectFixture, makeTempDir, waitFor, withEnv, writeJson } from "./helpers.mjs";

// A program asks its runner for a project to be made or changed, as it asks it for a run: nothing of
// that is done in the program's own process. (Which these tests can tell at a glance: the model is a
// stand-in that exists in this process, the runner's, and in no other.)

/** A report of usage: so many tokens read, at a dollar a thousand. */
const took = (tokens) => ({ model: "p/m", input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, cost: tokens / 1000 });

const journalsOf = (projectDir) => {
  const dir = join(projectDir, "logs", "journal");
  return readdirSync(dir).sort().map((file) => readFileSync(join(dir, file), "utf-8").trim().split("\n").map((line) => JSON.parse(line)));
};

function standIn(t, { ask, repair }) {
  const original = { ask: llm.ask, repair: llm.repair };
  if (ask) llm.ask = ask;
  if (repair) llm.repair = repair;
  t.after(() => Object.assign(llm, original));
}

/** A home with a project `maker` in it, whose program is `source`; and where the projects it makes will be. */
function homeWith(t, source, config = { maxRepairAttempts: 0 }) {
  const fakeHome = makeTempDir("trama-making-home-");
  t.after(() => cleanupTempDir(fakeHome));
  writeJson(join(fakeHome, ".trama", "config.json"), config);
  const projects = join(fakeHome, ".trama", "projects");
  createProjectFixture(join(projects, "maker"), { programSource: source });
  return { fakeHome, projects, makerDir: join(projects, "maker") };
}

/** What a model writes when it is asked for a program: one that says which it is. */
const WRITES = (what) => `import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ said: ${JSON.stringify(what)} });\n`;

const MAKES = `import { ctx } from "@trama-dev/runtime";
import { createProject, updateProject, runProgram } from "@trama-dev/runtime/runner";
const told = (err: any) => String(err.message);
const created = await createProject("made", "write the first", { model: "another-model", args: { n: 5 } }).then(() => "created", told);
const again = await createProject("made", "write it once more").then(() => "created", told);
const updated = await updateProject("made", "write the second").then(() => "updated", told);
const missing = await updateProject("never-made", "write anything").then(() => "updated", told);
const nests = await createProject("nests", "write one that makes another").then(() => "created", told);
const ran = await runProgram({ projectDir: ${"`${process.env.HOME}/.trama/projects/made`"}, maxRepairAttempts: 0, timeout: 20000 });
await ctx.done({ created, again, updated, missing, nests, ran });
`;

test("a program has a project made, and changed, by its runner: under the run's name, on its record, and with what it used said", async (t) => {
  const { fakeHome, projects, makerDir } = homeWith(t, MAKES);
  const asked = [];
  standIn(t, {
    ask: async (prompt, call) => {
      asked.push(prompt.split("\n")[0]);
      call.used(took(100));
      if (prompt.startsWith("write one that makes another")) {
        return `import { ctx } from "@trama-dev/runtime";\nimport { createProject } from "@trama-dev/runtime/runner";\nawait createProject("inner", "p");\nawait ctx.done();\n`;
      }
      return WRITES(prompt.split("\n")[0]);
    },
  });

  const { messages, result } = await withEnv({ HOME: fakeHome }, () =>
    captureConsole("log", () => runProgram({ projectDir: makerDir, label: "maker", timeout: 30_000 })));
  assert.deepEqual(result.result, {
    created: "created",
    again: 'trama runtime error: Error: Project "made" already exists.',
    updated: "updated",
    missing: 'trama runtime error: Error: Project "never-made" not found. Run `trama list` to see available projects.',
    nests: "created",
    ran: { status: "done", result: { said: "write the second" } },
  });
  assert.deepEqual(asked, ["write the first", "write the second", "write one that makes another"]);
  assert.equal(existsSync(join(projects, "inner")), false);
  assert.equal(readFileSync(join(projects, "made", "program.ts"), "utf-8"), WRITES("write the second").trim());
  // What the program said the project is to be made with — its model, the arguments its program starts with — it is made with.
  const meta = JSON.parse(readFileSync(join(projects, "made", "meta.json"), "utf-8"));
  assert.deepEqual([meta.model, meta.input], ["another-model", { prompt: "write the first", args: { n: 5 } }]);

  // What is said of the making is said under the name of the run that asked for it.
  for (const line of [
    '[maker] Generating program for "made"...',
    "[maker] [trama] writing the program used 100 tokens  $0.1000",
    "[maker] Validating program...",
    "[maker] Created made. Run with: trama run made",
    '[maker] Updating "made"...',
    "[maker] Updated made. Run with: trama run made",
    // (...what a validation says of its candidate among it.)
    "[maker] [trama] validated up to where it has a project made or changed",
  ]) assert.ok(messages.includes(line), `${line}\n— not among:\n${messages.join("\n")}`);

  // The run's journal has each asking as a call, and says which validation it started; the validation's says which call started it.
  const [run] = journalsOf(makerDir);
  const calls = run.filter((record) => record.kind === "call").map((record) => [record.seq, record.endpoint, record.request.name]);
  assert.deepEqual(calls.slice(0, 4), [[1, "/project/create", "made"], [2, "/project/create", "made"], [3, "/project/update", "made"], [4, "/project/update", "never-made"]]);
  const validations = journalsOf(join(projects, "made")).filter((journal) => journal[0].purpose === "validate");
  assert.deepEqual(validations.map((journal) => [journal[0].label, journal[0].parent.run, journal[0].parent.seq]), [["maker", run[0].run, 1], ["maker", run[0].run, 3]]);
  assert.deepEqual(run.filter((record) => record.kind === "child").slice(0, 2).map((record) => [record.seq, record.run]), [[1, validations[0][0].run], [3, validations[1][0].run]]);
  const shown = (await captureConsole("log", async () => printJournals(makerDir, "maker", {}))).messages.join("\n");
  assert.match(shown, /#1 +project\/create +made: write the first +ok/);
  assert.match(shown, new RegExp(`#1 +started validation ${validations[0][0].run}$`, "m"));
  assert.match(shown, /#2 +project\/create +made: write it once more +failed .*already exists/);
});

test("a project a program has made is counted in its run's budget, and stopped with its run", async (t) => {
  const SPENDS = `import { ctx, agent } from "@trama-dev/runtime";
import { createProject } from "@trama-dev/runtime/runner";
const told = (err: any) => String(err.message);
const first = await createProject("one", "write one").then(() => "created", told);
const own = await agent.instruct("a question of the program's own").then(() => "answered", told);
const second = await createProject("two", "write two").then(() => "created", told);
await ctx.done({ first, own, second });
`;
  // (The config's budget would admit no call at all: it is not what holds a project a run's program asked for.)
  const { fakeHome, projects, makerDir } = homeWith(t, SPENDS, { maxRepairAttempts: 0, budget: { calls: 0 } });
  standIn(t, { ask: async (prompt, call) => { call.used(took(100)); return prompt.startsWith("a question") ? "an answer" : WRITES(prompt.split("\n")[0]); } });

  await withEnv({ HOME: fakeHome }, async () => {
    const two = await captureConsole("warn", () => captureConsole("log", () => runProgram({ projectDir: makerDir, budget: { calls: 2 }, timeout: 30_000 })));
    assert.deepEqual(two.result.result.result, {
      first: "created",
      own: "answered",
      second: "trama runtime error: Error: The budget of a run this one is part of is spent: 2 of 2 calls to a model made.",
    });
    assert.equal(existsSync(join(projects, "one", "program.ts")), true);
    assert.equal(existsSync(join(projects, "two")), false, "a project that could not be written is not left behind");
    assert.equal(journalsOf(join(projects, "one"))[0][0].budget, undefined, "the budget is the run's, and is in the run's journal");
    assert.deepEqual(two.messages, ["[trama] The budget is spent: 2 of 2 calls to a model made."], "it is said once for the run, in the run's words");

    // ...however many projects come up against it, and whether or not the program then asks its own agent.
    // (The first to come up against it here is a project: what is said is still what the run would say.)
    (await import("fs")).rmSync(join(projects, "one"), { recursive: true, force: true });
    const none = await captureConsole("warn", () => captureConsole("log", () => runProgram({ projectDir: makerDir, label: "maker", budget: { calls: 0 }, timeout: 30_000 })));
    assert.deepEqual(none.messages, ["[maker] [trama] The budget is spent: 0 of 0 calls to a model made."]);
    assert.match(none.result.result.result.first, /The budget of a run this one is part of is spent: 0 of 0 calls/);

    // Outside a program the config's budget is what holds, as before.
    await assert.rejects(() => captureConsole("warn", () => captureConsole("log", () => createProject("three", "write three"))), /The budget is spent: 0 of 0 calls to a model made\./);
  });
});

test("a project being made for a program is stopped when the program no longer wants it, when its run is stopped, and when its time is up", async (t) => {
  const WAITS = `import { ctx } from "@trama-dev/runtime";
import { createProject } from "@trama-dev/runtime/runner";
const stop = new AbortController();
if (ctx.input.args.giveUp) setTimeout(() => stop.abort(), 300);
const made = await createProject("slow", "write slowly", { signal: stop.signal }).then(() => "created", (err: any) => String(err.message));
await ctx.done({ made });
`;
  const { fakeHome, projects, makerDir } = homeWith(t, WAITS);
  // A model that does not answer until it is told to stop.
  let asking = 0, stopped = 0;
  // (...and that takes a moment to let go once it is: a run is not over before what it was having made is.)
  standIn(t, { ask: (_prompt, call) => new Promise((_resolve, reject) => { asking += 1; call.signal.addEventListener("abort", () => setTimeout(() => { stopped += 1; reject(new Error("stopped")); }, 150)); }) });

  await withEnv({ HOME: fakeHome }, async () => {
    // The program gives up: it is answered that the making was stopped, and goes on.
    const gaveUp = await captureConsole("log", () => runProgram({ projectDir: makerDir, args: { giveUp: true }, timeout: 30_000 }));
    assert.deepEqual([gaveUp.result.status, asking, stopped], ["done", 1, 1]);
    assert.match(gaveUp.result.result.made, /Aborted/);
    assert.equal(existsSync(join(projects, "slow")), false, "what was being made is taken away again");

    // The run is stopped: so is what it was having made, before the run is over.
    const stop = new AbortController();
    const running = captureConsole("log", () => runProgram({ projectDir: makerDir, signal: stop.signal, timeout: 30_000 }));
    await waitFor(() => asking === 2, "the model to be asked for the program");
    stop.abort();
    assert.equal((await running).result.status, "failed");
    assert.deepEqual([asking, stopped, existsSync(join(projects, "slow"))], [2, 2, false]);

    // Its time is up: the program's clock goes on while a project is made for it — that is the program's own work.
    const late = await captureConsole("log", () => runProgram({ projectDir: makerDir, timeout: 1_500 }));
    assert.match(late.result.reason, /timeout/);
    assert.deepEqual([asking, stopped, existsSync(join(projects, "slow"))], [3, 3, false]);
  });
});

test("a candidate that would have a project made or changed is validated up to where it asks: none is made", async (t) => {
  const { fakeHome, projects } = homeWith(t, WRITES("unused"));
  const NESTS = `import { ctx } from "@trama-dev/runtime";
import { createProject } from "@trama-dev/runtime/runner";
await createProject("inner", "write the inner one");
await ctx.done({ made: "inner" });
`;
  const asked = [];
  standIn(t, { ask: async (prompt) => { asked.push(prompt.split("\n")[0]); return prompt.startsWith("write the outer") ? NESTS : WRITES("inner"); } });

  await withEnv({ HOME: fakeHome }, async () => {
    const { messages } = await captureConsole("log", () => createProject("outer", "write the outer one"));
    assert.ok(messages.includes("[trama] validated up to where it has a project made or changed"), messages.join("\n"));
    assert.deepEqual(asked, ["write the outer one"], "the inner project's program was never asked for");
    assert.deepEqual([existsSync(join(projects, "outer", "program.ts")), existsSync(join(projects, "inner"))], [true, false]);
    assert.deepEqual(journalsOf(join(projects, "outer"))[0].find((record) => record.kind === "exit").validated, "hand-off");

    // Run for real, it makes it.
    const ran = await captureConsole("log", () => runProgram({ projectDir: join(projects, "outer"), timeout: 30_000 }));
    assert.deepEqual(ran.result, { status: "done", result: { made: "inner" } });
    assert.equal(existsSync(join(projects, "inner", "program.ts")), true);
  });

  // The same of a candidate validated by itself, and of one that would change a project.
  const projectDir = join(projects, "maker");
  for (const call of [`createProject("another", "p")`, `updateProject("maker", "p")`]) {
    const candidate = `import { ctx } from "@trama-dev/runtime";\nimport { createProject, updateProject } from "@trama-dev/runtime/runner";\nawait ${call};\nawait ctx.done();\n`;
    const { messages } = await withEnv({ HOME: fakeHome }, () => captureConsole("log", () =>
      validateProgram(projectDir, createBackend({ provider: "fake", model: "plain" }), candidate, { timeout: 20_000, maxRepairAttempts: 0, maxIterations: 10 })));
    assert.ok(messages.includes("[trama] validated up to where it has a project made or changed"), call);
  }
  assert.equal(existsSync(join(projects, "another")), false);
});

test("the program a project is made with for a program is validated with the variables of the run that asked", async (t) => {
  const { fakeHome, projects, makerDir } = homeWith(t, `import { ctx } from "@trama-dev/runtime";
import { createProject } from "@trama-dev/runtime/runner";
await ctx.done({ made: await createProject("needs-role", "write it").then(() => "created", (err: any) => String(err.message).split("\\n")[0]) });
`);
  // (Whether the agent that writes it is served in a process of its own — which is where a run's variables are an agent's — is the adapter's to say.)
  const apart = [];
  standIn(t, { ask: async function () {
    apart.push(this.apart);
    return `import { ctx } from "@trama-dev/runtime";\nif (process.env.ROLE !== "the maker's") throw new Error("no ROLE here");\nawait ctx.done();\n`;
  } });

  await withEnv({ HOME: fakeHome }, async () => {
    const without = await captureConsole("log", () => runProgram({ projectDir: makerDir, timeout: 30_000 }));
    assert.match(without.result.result.made, /^trama runtime error: Error: Program failed/);
    const { rmSync } = await import("fs");
    rmSync(join(projects, "needs-role"), { recursive: true, force: true });
    const having = await captureConsole("log", () => runProgram({ projectDir: makerDir, env: { ROLE: "the maker's" }, timeout: 30_000 }));
    assert.deepEqual(having.result.result, { made: "created" });
    // (The names of the variables are on the validation's record, as on a run's: not what they hold.)
    assert.deepEqual(journalsOf(join(projects, "needs-role")).at(-1)[0].env, ["ROLE"]);
    // ...and the agent that wrote it had them too, where there were any.
    assert.deepEqual(apart, [false, true]);
  });
});

test("what a program gives to have a project made is held to what that call takes, and a runner that was given no way to make one says so", async (t) => {
  const { fakeHome, projects, makerDir } = homeWith(t, `import { ctx } from "@trama-dev/runtime";
import { createProject, updateProject } from "@trama-dev/runtime/runner";
const told = (err: any) => String(err.message);
const went = [];
went.push(await createProject("x", "p", { model: "m", args: { a: 1 }, bogus: true } as any).then(() => "created", told));
went.push(await createProject("x", "p", { name: "y" } as any).then(() => "created", told));
went.push(await updateProject("x", "p", { model: "m" } as any).then(() => "updated", told));
went.push(await (createProject as any)("x").then(() => "created", told));
went.push(await createProject("../x", "p").then(() => "created", told));
await ctx.done({ went });
`);
  standIn(t, { ask: async () => WRITES("x") });

  await withEnv({ HOME: fakeHome }, async () => {
    const { result } = await captureConsole("log", () => runProgram({ projectDir: makerDir, timeout: 30_000 }));
    assert.deepEqual(result.result.went, [
      "trama runtime error: Unknown field: bogus (this call takes: name, prompt, model, args, id)",
      "name is what the call is made with, and cannot be given as an option",
      "trama runtime error: Unknown field: model (this call takes: name, prompt, from, install, updateWith, id)",
      "trama runtime error: Missing or invalid field: prompt (expected string)",
      'trama runtime error: Error: Invalid project name: "../x". Must be a simple directory name without path separators.',
    ]);
    assert.equal(existsSync(join(projects, "x")), false);

    // (The runner as it is by itself, not by way of the surface that knows how a program is written.)
    const bare = await runWithoutMaking({ projectDir: makerDir, timeout: 30_000 });
    assert.match(bare.result.went[4], /This runner was not given a way to make projects/);
  });
});

test("outside a program a project is made, and changed, where it is asked for — as it always was", async (t) => {
  const { fakeHome, projects } = homeWith(t, WRITES("unused"));
  standIn(t, { ask: async (prompt) => WRITES(prompt.split("\n")[0]) });
  await withEnv({ HOME: fakeHome }, async () => {
    const { messages } = await captureConsole("log", async () => {
      await createProject("plain", "write plainly");
      await updateProject("plain", "write otherwise");
    });
    assert.deepEqual(messages.filter((line) => !line.startsWith("[trama]")), [
      'Generating program for "plain"...', "Validating program...", "Created plain. Run with: trama run plain",
      'Updating "plain"...', "Validating updated program...", "Updated plain. Run with: trama run plain",
    ]);
    const [first] = journalsOf(join(projects, "plain"));
    assert.deepEqual(["label" in first[0], "parent" in first[0], "env" in first[0]], [false, false, false]);
  });
});

test("a run a program asks for can have projects made as its own program can: the way to make them goes down the tree with the runs", async (t) => {
  const { fakeHome, projects, makerDir } = homeWith(t, `import { ctx } from "@trama-dev/runtime";
import { runProgram } from "@trama-dev/runtime/runner";
const kid = await runProgram({ projectDir: process.env.HOME + "/.trama/projects/kid", label: "kid", maxRepairAttempts: 0, timeout: 20000 });
await ctx.done({ kid });
`);
  createProjectFixture(join(projects, "kid"), {
    programSource: `import { ctx } from "@trama-dev/runtime";
import { createProject } from "@trama-dev/runtime/runner";
await ctx.done({ made: await createProject("by-the-kid", "write it").then(() => "created", (err: any) => String(err.message)) });
`,
  });
  standIn(t, { ask: async (prompt) => WRITES(prompt.split("\n")[0]) });
  const { messages, result } = await withEnv({ HOME: fakeHome }, () => captureConsole("log", () => runProgram({ projectDir: makerDir, timeout: 30_000 })));
  assert.deepEqual(result.result, { kid: { status: "done", result: { made: "created" } } });
  assert.ok(messages.includes("[kid] Created by-the-kid. Run with: trama run by-the-kid"), messages.join("\n"));
  assert.equal(existsSync(join(projects, "by-the-kid", "program.ts")), true);
});

test("a project made for a run a program asked for is counted in every budget above that run", async (t) => {
  const { fakeHome, projects, makerDir } = homeWith(t, `import { ctx } from "@trama-dev/runtime";
import { runProgram } from "@trama-dev/runtime/runner";
const kid = await runProgram({ projectDir: process.env.HOME + "/.trama/projects/kid", maxRepairAttempts: 0, timeout: 20000 });
await ctx.done({ kid: kid.result });
`);
  createProjectFixture(join(projects, "kid"), {
    programSource: `import { ctx, agent } from "@trama-dev/runtime";
import { createProject } from "@trama-dev/runtime/runner";
const told = (err: any) => String(err.message);
const first = await agent.instruct("a question").then(() => "answered", told);
const made = await createProject("by-the-kid", "write one that asks").then(() => "created", told);
const second = await agent.instruct("a question").then(() => "answered", told);
await ctx.done({ first, made, second });
`,
  });
  // (The writing is the tree's second call, the candidate's own question its third, and the kid's second question the fourth.)
  const ASKS_ONCE = `import { ctx, agent } from "@trama-dev/runtime";\nawait ctx.done({ said: await agent.instruct("a question of the candidate's") });\n`;
  standIn(t, { ask: async (prompt, call) => { call.used(took(1)); return prompt.startsWith("write one") ? ASKS_ONCE : "an answer"; } });

  await withEnv({ HOME: fakeHome }, async () => {
    const all = await captureConsole("warn", () => captureConsole("log", () => runProgram({ projectDir: makerDir, budget: { calls: 4 }, timeout: 30_000 })));
    assert.deepEqual(all.result.result.result.kid, { first: "answered", made: "created", second: "answered" });
    (await import("fs")).rmSync(join(projects, "by-the-kid"), { recursive: true, force: true });
    const three = await captureConsole("warn", () => captureConsole("log", () => runProgram({ projectDir: makerDir, budget: { calls: 3 }, timeout: 30_000 })));
    assert.deepEqual(three.result.result.result.kid, {
      first: "answered",
      made: "created",
      second: "trama runtime error: Error: The budget of a run this one is part of is spent: 3 of 3 calls to a model made.",
    });
    // One call fewer, and it is the candidate's own that is refused: the project is not made, for its program does not run.
    (await import("fs")).rmSync(join(projects, "by-the-kid"), { recursive: true, force: true });
    const two = await captureConsole("warn", () => captureConsole("log", () => runProgram({ projectDir: makerDir, budget: { calls: 2 }, timeout: 30_000 })));
    assert.match(two.result.result.result.kid.made, /^trama runtime error: Error: Program failed/);
    assert.match(two.result.result.result.kid.second, /The budget of a run this one is part of is spent: 2 of 2 calls/);
  });
});

test("a fix that is being tried can have a project made, as it can ask for a run: it is made for real", async (t) => {
  const { fakeHome, projects, makerDir } = homeWith(t, `throw new Error("it does not work yet");\n`, { maxRepairAttempts: 1 });
  const FIXED = `import { ctx } from "@trama-dev/runtime";
import { createProject } from "@trama-dev/runtime/runner";
await createProject("by-the-fix", "write it");
await ctx.done({ made: "by the fix" });
`;
  standIn(t, { ask: async (prompt) => WRITES(prompt.split("\n")[0]), repair: async () => FIXED });
  const { result } = await withEnv({ HOME: fakeHome }, () => captureConsole("warn", () => captureConsole("log", () => runProgram({ projectDir: makerDir, timeout: 30_000 }))));
  assert.deepEqual(result.result, { status: "done", result: { made: "by the fix" } });
  assert.equal(readFileSync(join(projects, "by-the-fix", "program.ts"), "utf-8"), WRITES("write it").trim());
  assert.equal(readFileSync(join(makerDir, "program.ts"), "utf-8").trim(), FIXED.trim());
});

test("a making is known by the name it was given, as a run is: one name is one thing asked for, and it can be stopped before it has begun", async (t) => {
  const { fakeHome, projects, makerDir } = homeWith(t, `import { ctx } from "@trama-dev/runtime";
import { readFileSync } from "fs";
const { token } = JSON.parse(readFileSync(process.env.TRAMA_INIT!, "utf-8"));
const post = async (path: string, body: unknown) => {
  const res = await fetch("http://127.0.0.1:" + process.env.TRAMA_PORT + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
    body: JSON.stringify(body),
  });
  return [res.status, (await res.text()).slice(0, 90)];
};
const first = post("/project/create", { name: "slow", prompt: "write slowly", id: "one" });
await new Promise((resolve) => setTimeout(resolve, 150));
// The name is taken while the first is being made: by another making, and by a run.
const second = await post("/project/create", { name: "other", prompt: "write", id: "one" });
const third = await post("/run/program", { projectDir: "/nowhere", id: "one" });
const nameless = await post("/project/update", { name: "slow", prompt: "write", id: "" });
// Stopped by its name, it ends; and one stopped before it was asked for is never begun.
const stopped = await post("/run/stop", { id: "one" });
const ended = await first;
await post("/run/stop", { id: "ahead" });
const ahead = await post("/project/create", { name: "never", prompt: "write", id: "ahead" });
// Once it is over the name is free again.
const again = await post("/project/create", { name: "quick", prompt: "write quickly", id: "one" });
await ctx.done({ second, third, nameless, stopped, ended, ahead, again });
`);
  let asked = 0;
  standIn(t, {
    ask: (prompt, call) => new Promise((resolve, reject) => {
      asked += 1;
      if (prompt.startsWith("write quickly")) return resolve(WRITES("quick"));
      call.signal.addEventListener("abort", () => reject(new Error("stopped")));
    }),
  });
  const { result } = await withEnv({ HOME: fakeHome }, () => captureConsole("log", () => runProgram({ projectDir: makerDir, timeout: 30_000 })));
  assert.equal(result.status, "done", result.reason);
  const { second, third, nameless, stopped, ended, ahead, again } = result.result;
  assert.deepEqual([second, third], [[400, "Duplicate run id: one"], [400, "Duplicate run id: one"]]);
  assert.deepEqual([nameless[0], /expected a non-empty string/.test(nameless[1])], [400, true]);
  assert.deepEqual([stopped[0], ended[0], /Aborted/.test(ended[1])], [200, 500, true]);
  assert.deepEqual([ahead[0], /Aborted/.test(ahead[1])], [500, true]);
  assert.equal(again[0], 200);
  // The model was asked for the first and for the last: never for the one whose name was taken, nor for the one stopped ahead.
  assert.equal(asked, 2);
  assert.deepEqual(["slow", "other", "never", "quick"].map((name) => existsSync(join(projects, name))), [false, false, false, true]);
});
