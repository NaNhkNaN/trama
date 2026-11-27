import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { llm } from "./fake-llm.mjs";
import { createProject, describeProject, runProgram, updateProject } from "../packages/runtime/dist/index.js";
import { REPO_ROOT, captureConsole, cleanupTempDir, createProjectFixture, makeTempDir, readJson, withEnv, writeJson } from "./helpers.mjs";

// The writer that is in the repository to begin from (examples/write-by-harness): a program that has a harness
// write a project's program — its next, or its first. It words what is asked, has the harness do the work in the copy it was handed —
// examples/coding-harness, which works in its run's workspace — and hands back program.ts as the harness left it.

const HARNESS = join(REPO_ROOT, "examples", "coding-harness"), WRITER = join(REPO_ROOT, "examples", "write-by-harness");
const quietly = (fn) => captureConsole("warn", () => captureConsole("log", fn)).then(({ result }) => result);
const SAYS = (n) => `import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ n: ${n} });\n`;

/** What a conversation with the model begins with, as the model's library is handed it: the task. */
const taskOf = (request) => { const said = request.context.messages[0].content; return typeof said === "string" ? said : said.map((part) => part.text ?? "").join(""); };

/** A home with a project to update, and the two examples copied among the user's projects — and a model that is played. */
function scene(t, plays) {
  const fakeHome = makeTempDir("trama-update-harness-home-");
  t.after(() => cleanupTempDir(fakeHome));
  writeJson(join(fakeHome, ".trama", "config.json"), { maxRepairAttempts: 0 });
  const at = (name) => join(fakeHome, ".trama", "projects", name);
  createProjectFixture(at("words"), { programSource: SAYS(1), metaInput: { prompt: "the words", args: {} } });
  writeJson(join(at("words"), "meta.json"), { ...readJson(join(at("words"), "meta.json")), description: "Says a number.", returns: { n: "number" } });
  cpSync(HARNESS, at("coding-harness"), { recursive: true });
  cpSync(WRITER, at("write-by-harness"), { recursive: true });
  // What the model is asked, request by request — and what it does: a tool's call, played by `plays`.
  const requests = [];
  const original = { ...llm };
  t.after(() => { Object.assign(llm, original); });
  llm.complete = async (request, call) => {
    requests.push(request);
    const does = plays(request, requests.length);
    call.used({ model: "fake/plain", input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
    return { role: "assistant", content: [{ type: "toolCall", id: `call-${requests.length}`, name: does.name, arguments: does.args ?? {} }], stopReason: "toolUse", model: "fake/plain", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } };
  };
  const inHome = (fn) => withEnv({ HOME: fakeHome }, () => quietly(fn)).then(({ result }) => result);
  const lines = (name) => (existsSync(join(at(name), "history", "runs.jsonl")) ? readFileSync(join(at(name), "history", "runs.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  return { fakeHome, at, inHome, requests, lines, program: (name) => readFileSync(join(at(name), "program.ts"), "utf-8"), taskOf };
}
/** A model that writes what `text` says of the task it is given, the first time it is asked in a conversation, and says it is done the next. */
const writes = (text) => (request) => (request.context.messages.length === 1 && taskOf(request).startsWith("Rewrite program.ts")
  ? { name: "write", args: { path: "program.ts", content: text(taskOf(request)) } }
  : { name: "finish", args: { summary: "it is written" } });

test("the writer has a harness write the program, in the copy it was handed: the harness is told what is asked and what holds of the project, and what it leaves in program.ts is the update", async (t) => {
  const it = scene(t, writes(() => SAYS(2)));
  await it.inHome(() => runProgram({ projectDir: it.at("words"), timeout: 30_000 }));
  writeFileSync(join(it.at("words"), "state.json"), JSON.stringify({ seen: 3 }));
  assert.deepEqual(await it.inHome(() => updateProject("words", "Say two, not one.", { updateWith: "write-by-harness" })), { version: 2 });
  assert.equal(it.program("words"), SAYS(2));
  // Two requests, both the harness's: the writer itself asks no model.
  assert.equal(it.requests.length, 2);
  const task = it.taskOf(it.requests[0]);
  // What the harness was told: what is asked; that it works in a copy of the project, where meta.json says what the
  // program is held to; whether what it makes beside the program is kept; and the API a program has.
  assert.match(task, /^Rewrite program\.ts, in the current directory: a TypeScript program for the trama runtime\. What is asked of the new version:\n\nSay two, not one\.\n\n/);
  assert.match(task, /meta\.json says what the project is for, and — where it says — what a run of it takes \(`parameters`\) and gives \(`returns`\): the program is held to that, and meta\.json is not yours to change\./);
  assert.match(task, /What the program needs beside it[^\n]*is kept with the program/);
  assert.match(task, /\n\nThe runtime's API, as a program has it:\n[^]*interface Ctx/);
  // Whose runs they were: the writer's, for the update; the harness's, in the workspace it was handed on — and none of the project's but its validation.
  assert.deepEqual([it.lines("write-by-harness").map((line) => [line.for, line.status]), it.lines("coding-harness").map((line) => [line.for ?? null, line.status]), it.lines("words").length], [[["update", "done"]], [[null, "done"]], 1]);
  assert.deepEqual(it.lines("write-by-harness")[0].used, { calls: 2, tokens: 30, cost: 0.02 });

  // Kept beside the program: the harness is told that nothing it makes beside program.ts is kept.
  await it.inHome(() => updateProject("words", "Say two again.", { updateWith: "write-by-harness", install: false }));
  assert.match(it.taskOf(it.requests[2]), /Nothing you make here beside program\.ts is kept\./);
  // Its own arguments — which harness, which model does the work, how long it may take — are its project's (its meta.json): a model named there is the one the harness asks.
  writeJson(join(it.at("write-by-harness"), "meta.json"), { ...readJson(join(it.at("write-by-harness"), "meta.json")), input: { prompt: "p", args: { model: "fake/small", turns: 7 } } });
  await it.inHome(() => updateProject("words", "And once more.", { updateWith: "write-by-harness", install: false }));
  assert.equal(it.requests.at(-1).model, "fake/small");
});

test("the writer says what it is for, what it is handed and what it gives; with nothing to write it says so and ends; and a harness that failed, or left no program, is no update", async (t) => {
  const it = scene(t, () => ({ name: "finish", args: { summary: "nothing was written" } }));
  const said = await it.inHome(() => describeProject(it.at("write-by-harness")));
  assert.deepEqual([said.schema.parameters.required, Object.keys(said.parameters), Object.keys(said.returns)],
    [[], ["prompt?", "program?", "kept?", "types?", "copy?", "harness?", "model?", "turns?", "seconds?"], ["program?", "said?", "nothing?"]]);
  // As a validation of it runs it: with nothing.
  assert.deepEqual((await it.inHome(() => runProgram({ projectDir: it.at("write-by-harness"), timeout: 30_000 }))).result, { nothing: "to write: it was not handed what is asked, or where to work" });
  assert.equal(it.requests.length, 0);
  // A harness that there is none of.
  await it.inHome(() => runProgram({ projectDir: it.at("words"), timeout: 30_000 }));
  writeJson(join(it.at("write-by-harness"), "meta.json"), { ...readJson(join(it.at("write-by-harness"), "meta.json")), input: { prompt: "p", args: { harness: "nobody" } } });
  // (Said in the writer's own words, with what to do about it: a harness copied under another name is not found by the one the writer has for it.)
  await assert.rejects(it.inHome(() => updateProject("words", "x", { updateWith: "write-by-harness" })),
    /The project asked for the update failed: [^]*Error: The harness that is to do the writing is not among your projects: "nobody"\. Copy one there — trama examples coding-harness — or say which project it is: "harness", among this project's own arguments in its meta\.json \(\{ "input": \{ "args": \{ "harness": "…" \} \} \}\)\.\n/);
  assert.equal(it.requests.length, 0);
  // And with nothing to write it does not look for one: a validation of the writer is none of the harness.
  assert.deepEqual((await it.inHome(() => runProgram({ projectDir: it.at("write-by-harness"), timeout: 30_000 }))).result, { nothing: "to write: it was not handed what is asked, or where to work" });
  assert.match(readFileSync(join(WRITER, "README.md"), "utf-8"), /copied under another name \(`trama examples coding-harness --as my-harness`\) is to be named to the writer: `"args": \{ "harness": "my-harness" \}`/);
  // A harness that is there, and fails: no update — the program it left where it was is not handed back as one.
  createProjectFixture(it.at("faulty"), { programSource: 'throw new Error("the harness has a fault of its own");\n' });
  writeJson(join(it.at("write-by-harness"), "meta.json"), { ...readJson(join(it.at("write-by-harness"), "meta.json")), input: { prompt: "p", args: { harness: "faulty" } } });
  await assert.rejects(it.inHome(() => updateProject("words", "x", { updateWith: "write-by-harness" })), /The project asked for the update failed: [^]*The harness failed: [^]*the harness has a fault of its own/);
  assert.equal(readFileSync(join(it.at("words"), "history", "index.jsonl"), "utf-8").trim().split("\n").length, 1);
  assert.equal(it.program("words"), SAYS(1));
});

test("the coding harness, through the writer, updates the coding harness: what it writes of itself is validated as any update is, and is the harness from then on", async (t) => {
  const mark = "\n// (Written by itself.)\n";
  const it = scene(t, writes(() => readFileSync(join(HARNESS, "program.ts"), "utf-8") + mark));
  await it.inHome(() => runProgram({ projectDir: it.at("coding-harness"), args: { task: "Nothing: say that you are done." }, timeout: 60_000 }));
  assert.deepEqual(await it.inHome(() => updateProject("coding-harness", "Be a better harness.", { updateWith: "write-by-harness" })), { version: 2 });
  assert.ok(it.program("coding-harness").endsWith(mark));
  const index = readFileSync(join(it.at("coding-harness"), "history", "index.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(index.map(({ version, reason, parent }) => [version, reason, parent ?? null]), [[1, "found", null], [2, "update", 1]]);
  // It was version 1 of the harness that wrote version 2 — which then ran, to be validated.
  assert.deepEqual(it.lines("coding-harness").map((line) => line.version), [1, 1]);
});

test("at a project's making the writer has the harness write its first program, and say in meta.json what the project takes and gives: the harness is told so, with programs to go by", async (t) => {
  const SAID = { description: "Says a number, and adds to it.", parameters: { "add?": "number: what to add" }, returns: { n: "number" } };
  const PROGRAM = `import { ctx } from "@trama-dev/runtime";\nconst { add } = ctx.input.args as { add?: number };\nawait ctx.done({ n: 1 + (add ?? 0) });\n`;
  const lastSaid = (request) => { const said = request.context.messages.at(-1).content; return typeof said === "string" ? said : said.map((part) => part.text ?? "").join(""); };
  // The model, played: it reads meta.json, writes it again with what the project takes and gives, writes the program, and says it is done.
  const it = scene(t, (request) => {
    const done = request.context.messages.filter((message) => message.role === "toolResult").length;
    if (done === 0) return { name: "read", args: { path: "meta.json" } };
    if (done === 1) return { name: "write", args: { path: "meta.json", content: JSON.stringify({ ...JSON.parse(lastSaid(request)), ...SAID }, null, 2) } };
    if (done === 2) return { name: "write", args: { path: "program.ts", content: PROGRAM } };
    return { name: "finish", args: { summary: "it is written" } };
  });
  await it.inHome(() => createProject("made", "Say a number, and add to it what is given.", { createWith: "write-by-harness" }));
  assert.equal(it.program("made"), PROGRAM);
  const { description, parameters, returns, input } = readJson(join(it.at("made"), "meta.json"));
  assert.deepEqual([{ description, parameters, returns }, input], [SAID, { prompt: "Say a number, and add to it what is given.", args: {} }]);
  // What the harness was told: that the program is a project's first, what is asked of it, to say in meta.json what
  // the project does not say of itself — and programs, for what one looks like.
  const task = it.taskOf(it.requests[0]);
  assert.match(task, /^Write program\.ts, in the current directory: a TypeScript program for the trama runtime, the first of a project that is new\. What is asked of it:\n\nSay a number, and add to it what is given\.\n\n/);
  assert.match(task, /Say there, too, what the project does not say of itself yet[^\n]*"description"[^\n]*"parameters"[^\n]*"returns"/);
  assert.match(task, /\n\nThe runtime's API, as a program has it:\n[^]*interface Ctx[^]*\n\nPrograms, for what one looks like:\n\/\/ Example A: /);
  assert.doesNotMatch(task, /Rewrite program\.ts|the new version/);
  assert.deepEqual(it.lines("write-by-harness").map((line) => [line.for, line.status]), [["create", "done"]]);
  // And the project is held to what was said, from its first run.
  assert.deepEqual((await it.inHome(() => runProgram({ projectDir: it.at("made"), args: { add: "2", other: 1 }, timeout: 30_000 }))).result, { n: 3 });
  // An update's task has no programs to go by: there is one.
  await it.inHome(() => updateProject("made", "Say more.", { updateWith: "write-by-harness", install: false })).catch(() => {});
  assert.doesNotMatch(it.taskOf(it.requests.at(-1)), /Programs, for what one looks like/);
});
