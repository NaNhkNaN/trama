import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, existsSync, readFileSync, realpathSync } from "fs";
import { join } from "path";
import { llm } from "./fake-llm.mjs";
import { describeProject, runProgram, updateProject } from "../packages/runtime/dist/index.js";
import { REPO_ROOT, captureConsole, cleanupTempDir, createProjectFixture, makeTempDir, readJson, wholeLines, withEnv, writeJson } from "./helpers.mjs";

// The harness that is somebody else's (examples/harness-by-agent): a program that hands its task to an agent from
// outside — the user's choice of one, by its name in the configuration — at work where the run works. Run with a
// `task` as examples/coding-harness is, it sits where that sits: pointed at a codebase, or as the harness a writer
// has write a project's program. The agent is the stand-in of outside-agent.test.mjs; no model is asked by trama.

const EXAMPLE = join(REPO_ROOT, "examples", "harness-by-agent"), WRITER = join(REPO_ROOT, "examples", "write-by-harness");
const FAKE = join(REPO_ROOT, "test", "fake-acp-agent.mjs");
const fakeAgent = (told) => ({ command: process.execPath, args: [FAKE], env: { FAKE_ACP: JSON.stringify(told) } });
const quietly = (fn) => captureConsole("warn", () => captureConsole("log", fn)).then(({ result }) => result);
const SAYS = (n) => `import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ n: ${n} });\n`;

/** A home with the example among the user's projects, the agents `agents(log)` names in its configuration, and a codebase to work on. */
function scene(t, agents) {
  const fakeHome = makeTempDir("trama-by-agent-home-"), codebase = makeTempDir("trama-by-agent-codebase-"), aside = makeTempDir("trama-by-agent-aside-");
  t.after(() => { for (const each of [fakeHome, codebase, aside]) cleanupTempDir(each); });
  const log = join(aside, "log");
  writeJson(join(fakeHome, ".trama", "config.json"), { maxRepairAttempts: 0, agents: agents(log) });
  const at = (name) => join(fakeHome, ".trama", "projects", name);
  cpSync(EXAMPLE, at("harness-by-agent"), { recursive: true });
  const original = { ...llm };
  t.after(() => { Object.assign(llm, original); });
  for (const [name, asks] of Object.entries(llm)) if (typeof asks === "function") llm[name] = async () => assert.fail(`a model was asked by trama itself (${name})`);
  const inHome = (fn) => withEnv({ HOME: fakeHome }, () => quietly(fn)).then(({ result }) => result);
  const sent = () => (existsSync(log) ? wholeLines(log).map((line) => JSON.parse(line)) : []);
  return {
    fakeHome, codebase, at, inHome, sent,
    run: (name, options) => inHome(() => runProgram({ projectDir: at(name), maxRepairAttempts: 0, timeout: 60_000, ...options })),
    /** Where each process of an agent's was started, and what each was asked: in order. */
    started: () => sent().filter((message) => message.started).map((message) => message.started.cwd),
    asked: () => sent().filter((message) => message.method === "session/prompt").map((message) => message.params.prompt[0].text),
    /** A project's own arguments, said in its meta.json: what a run of it has where the run gives none. */
    own: (name, args) => { const meta = readJson(join(at(name), "meta.json")); writeJson(join(at(name), "meta.json"), { ...meta, input: { ...meta.input, args } }); },
    lines: (name) => (existsSync(join(at(name), "history", "runs.jsonl")) ? readFileSync(join(at(name), "history", "runs.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line)) : []),
    program: (name) => readFileSync(join(at(name), "program.ts"), "utf-8"),
  };
}

test("the harness that is somebody else's hands its task to the agent that is named, at work where the run works: in the run's workspace, or with none in its own project — and says what the agent said, and how its turn ended", async (t) => {
  const it = scene(t, (log) => ({
    named: fakeAgent({ log, says: ["Looking. ", "The sum is fixed."], ids: ["a", "b"], writes: { "fixed.txt": "by the agent" } }),
    cut: fakeAgent({ log, says: ["So far"], stop: "max_tokens", usage: false }),
    spent: fakeAgent({ log, says: ["So far"], stop: "max_turn_requests", usage: false }),
    refuses: fakeAgent({ log, says: ["No."], stop: "refusal" }),
    dies: fakeAgent({ log, dies: "turn" }),
    models: fakeAgent({ log, models: { current: null, options: ["small", "large"] }, says: ["served by {model}"] }),
    slow: fakeAgent({ log, hangs: "obeys" }),
    absent: { command: "no-such-agent-anywhere" },
  }));
  const ran = await it.run("harness-by-agent", { workspaceDir: it.codebase, args: { task: "Fix the sum.", agent: "named" } });
  assert.equal(ran.status, "done", JSON.stringify(ran));
  const { session, usage, ...said } = ran.result;
  // What it ends with: the agent's answer (the last of what it said), whether its turn ended as one does, and what it said it used — its own account.
  assert.deepEqual([said, typeof session, usage.total], [{ summary: "The sum is fixed.", ok: true, stopReason: "end_turn" }, "string", 1234]);
  // The agent was started in the codebase, asked the task and no more, and what it wrote is there — and not in the harness's own project.
  assert.deepEqual([it.started(), it.asked()], [[realpathSync(it.codebase)], ["Fix the sum."]]);
  assert.deepEqual([readFileSync(join(it.codebase, "fixed.txt"), "utf-8"), existsSync(join(it.at("harness-by-agent"), "fixed.txt"))], ["by the agent", false]);

  // What it takes: which agent is not left to be guessed — a run that does not say is not begun.
  const says = await it.inHome(() => describeProject("harness-by-agent"));
  assert.deepEqual([Object.keys(says.parameters), Object.keys(says.returns)], [["task?", "agent", "model?", "system?", "seconds?"], ["summary?", "ok", "stopReason?", "session?", "usage?"]]);
  await assert.rejects(it.run("harness-by-agent", { workspaceDir: it.codebase, args: { task: "x" } }), /harness-by-agent takes — missing key: agent/);
  assert.equal(it.started().length, 1);

  // Said once, in the project's own arguments, it is the agent of every run that names none; what else a run says is handed on.
  it.own("harness-by-agent", { agent: "named" });
  const again = await it.run("harness-by-agent", { workspaceDir: it.codebase, args: { task: "Fix the sum.", system: "Be brief.", seconds: "30" } });
  assert.equal(again.status, "done", JSON.stringify(again));
  assert.equal(it.asked().at(-1), "[Standing instructions, from whoever asked for this work: they hold for all of it.]\nBe brief.\n\n[The work asked for]\nFix the sum.");
  // A model, for an agent that has none of its own; and how long the agent may take — in seconds, text from a command line read as a number.
  assert.equal((await it.run("harness-by-agent", { workspaceDir: it.codebase, args: { task: "x", agent: "models", model: "large" } })).result.summary, "served by large");
  const slow = await it.run("harness-by-agent", { workspaceDir: it.codebase, args: { task: "x", agent: "slow", seconds: "1" } });
  assert.equal(slow.status, "failed");
  // (Said by the harness itself — ctx.fail — as how its run ended: its words are the run's reason from the first.)
  assert.match(slow.reason, /^The agent did not do the work \(timed-out\): It was not done after the 1000ms it was given/);
  // With no workspace it works in its own project, as examples/coding-harness does; with no task, on the project's own prompt.
  const alone = await it.run("harness-by-agent", {});
  assert.equal(alone.status, "done", JSON.stringify(alone));
  assert.deepEqual([it.started().at(-1), it.asked().at(-1)], [realpathSync(it.at("harness-by-agent")), readJson(join(it.at("harness-by-agent"), "meta.json")).input.prompt]);

  // A turn that ended at a limit of the agent's own is said, and is the run's result: the work may be done all the same, and a judge can look.
  for (const [agent, limit] of [["cut", "max_tokens"], ["spent", "max_turn_requests"]]) {
    const cut = await it.run("harness-by-agent", { workspaceDir: it.codebase, args: { task: "Fix the sum.", agent } });
    assert.deepEqual([cut.status, cut.result?.ok, cut.result?.stopReason, cut.result?.summary, "usage" in (cut.result ?? {})], ["done", false, limit, "So far", false], agent);
  }
  // A call that did not go through is a run that failed, and says what stood in its way: an agent that is not there,
  // one that refuses the work, one that ends in the middle of it. And so is an agent the configuration does not name.
  for (const [agent, why] of [["absent", /^The agent did not do the work \(not-installed\): /], ["refuses", /^The agent did not do the work \(refused\): The agent refused the work\.$/], ["dies", /^The agent did not do the work \(failed\): /]]) {
    const failed = await it.run("harness-by-agent", { workspaceDir: it.codebase, args: { task: "Fix the sum.", agent } });
    assert.equal(failed.status, "failed", agent);
    assert.match(failed.reason, why, agent);
  }
  const nobody = await it.run("harness-by-agent", { workspaceDir: it.codebase, args: { task: "Fix the sum.", agent: "nobody" } });
  assert.equal(nobody.status, "failed");
  assert.match(nobody.reason, /No agent is named "nobody" in the configuration \("agents"\): it names named, cut, spent, refuses, dies, models, slow, absent\./);
});

test("it sits where a harness that is a program sits: named as the harness of the writer, an update is written by an agent from outside — in the copy, and validated, recorded and installed as any is", async (t) => {
  const it = scene(t, (log) => ({ named: fakeAgent({ log, says: ["It is written."], writes: { "program.ts": SAYS(2) } }) }));
  cpSync(WRITER, it.at("write-by-harness"), { recursive: true });
  createProjectFixture(it.at("words"), { programSource: SAYS(1), metaInput: { prompt: "the words", args: {} } });
  writeJson(join(it.at("words"), "meta.json"), { ...readJson(join(it.at("words"), "meta.json")), description: "Says a number.", returns: { n: "number" } });
  // Whose harness the writer has write, and whose agent that harness is: each said in the project's own arguments.
  it.own("write-by-harness", { harness: "harness-by-agent" });
  it.own("harness-by-agent", { agent: "named" });
  await it.run("words", {});

  assert.deepEqual(await it.inHome(() => updateProject("words", "Say two, not one.", { updateWith: "write-by-harness" })), { version: 2 });
  assert.equal(it.program("words"), SAYS(2));
  assert.deepEqual((await it.run("words", {})).result, { n: 2 });
  // The agent was asked once, in the writer's words, and worked in the copy the writer was handed: not in the project.
  assert.equal(it.asked().length, 1);
  assert.match(it.asked()[0], /^Rewrite program\.ts, in the current directory: a TypeScript program for the trama runtime\. What is asked of the new version:\n\nSay two, not one\.\n\n/);
  assert.notEqual(it.started()[0], realpathSync(it.at("words")));
  // Whose runs they were: the writer's, for the update; the harness's, in the workspace it was handed on.
  assert.deepEqual([it.lines("write-by-harness").map((line) => [line.for, line.status]), it.lines("harness-by-agent").map((line) => [line.for ?? null, line.status])], [[["update", "done"]], [[null, "done"]]]);
});
