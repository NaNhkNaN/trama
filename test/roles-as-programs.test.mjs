import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, existsSync, readFileSync, readdirSync, realpathSync } from "fs";
import { join } from "path";
import { llm } from "./fake-llm.mjs";
import { createProject, runProgram, updateProject } from "../packages/runtime/dist/index.js";
import { RUNTIME_TYPES } from "../packages/runtime/dist/runner.js";
import { REPO_ROOT, captureConsole, cleanupTempDir, createProjectFixture, makeTempDir, readJson, withEnv, writeJson, writeText } from "./helpers.mjs";

// What the kernel does where nobody is named to write a program, or to fix one — it asks its agent, in a copy of
// the project, in words of its own — written as two programs (examples/program-writer, examples/program-fixer): the
// same request, made by a project. And what a program needs to make it: its agent at work in its workspace, a way
// for a writer to say that there is no program to be written, and the program in a model's reply.

const WRITER = join(REPO_ROOT, "examples", "program-writer"), FIXER = join(REPO_ROOT, "examples", "program-fixer");
const quietly = (fn) => captureConsole("warn", () => captureConsole("log", fn)).then(({ result }) => result.result);
const GOOD = (n) => `import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ n: ${n} });\n`;

/** A home, projects made in it by name, and a model that is played: what it was asked is kept, call by call. */
function scene(t, config = { maxRepairAttempts: 0 }) {
  const fakeHome = makeTempDir("trama-roles-home-");
  t.after(() => cleanupTempDir(fakeHome));
  writeJson(join(fakeHome, ".trama", "config.json"), config);
  const at = (name) => join(fakeHome, ".trama", "projects", name);
  const original = { ...llm };
  t.after(() => { Object.assign(llm, original); });
  const inHome = (fn) => withEnv({ HOME: fakeHome }, () => quietly(fn));
  const project = (name, program, { args = {}, more = {}, state } = {}) => {
    createProjectFixture(at(name), { programSource: program, metaInput: { prompt: `the ${name}`, args } });
    writeJson(join(at(name), "meta.json"), { ...readJson(join(at(name), "meta.json")), ...more });
    if (state) writeJson(join(at(name), "state.json"), state);
    return at(name);
  };
  return { fakeHome, at, inHome, project };
}

test("a program's agent works in the run's workspace where the call says so — and in the project otherwise, as it did; a run with no workspace is told that it has none", async (t) => {
  const it = scene(t);
  it.project("asks", `import { ctx, agent } from "@trama-dev/runtime";
const { where } = ctx.input.args as { where?: unknown };
const how = where === undefined ? {} : { workspace: where as boolean };
const said = await agent.instruct("where are you", how);
const typed = await agent.generate<{ at: string }>({ prompt: "typed: where are you", schema: { at: "string" }, ...how });
await ctx.done({ said, typed: typed.at });
`);
  llm.ask = async (prompt, call) => (prompt.startsWith("typed") ? JSON.stringify({ at: call.cwd }) : call.cwd);
  const work = makeTempDir("trama-roles-work-");
  t.after(() => cleanupTempDir(work));
  const run = (options) => it.inHome(() => runProgram({ projectDir: it.at("asks"), timeout: 30_000, ...options }));

  // Said so: both calls are served there. Not said, or said not: in the project, as a call is without it.
  assert.deepEqual((await run({ workspaceDir: work, args: { where: true } })).result, { said: work, typed: work });
  assert.deepEqual((await run({ workspaceDir: work, args: { where: false } })).result, { said: it.at("asks"), typed: it.at("asks") });
  assert.deepEqual((await run({ workspaceDir: work })).result, { said: it.at("asks"), typed: it.at("asks") });
  assert.deepEqual((await run({})).result, { said: it.at("asks"), typed: it.at("asks") });
  // A run with no workspace has none for its agent: the call fails, and says what would give it one.
  const none = await run({ args: { where: true } });
  assert.equal(none.status, "failed");
  assert.match(none.reason, /This run has no workspace for its agent to work in: one is there where a run is given one \(trama run --workspace <dir>, or workspaceDir\)/);
  // It is said by true or false: anything else is not taken for either.
  const odd = await run({ workspaceDir: work, args: { where: "yes" } });
  assert.equal(odd.status, "failed");
  assert.match(odd.reason, /workspace/);
  // The call is on the run's record as it was made.
  const journals = join(it.at("asks"), "logs", "journal");
  const first = readFileSync(join(journals, readdirSync(journals).sort()[0]), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(first.filter((record) => record.kind === "call" && record.endpoint.startsWith("/agent/")).map((record) => record.request.workspace), [true, true]);
});

test("a program has the program in a model's reply — stripCodeFences — as the kernel reads one: and its author is told so with the API", async (t) => {
  const it = scene(t);
  it.project("reads", `import { ctx, stripCodeFences } from "@trama-dev/runtime";
await ctx.done({ bare: stripCodeFences("const a = 1;\\n"), fenced: stripCodeFences("Here it is:\\n\\n\`\`\`ts\\nconst a = 1;\\n\`\`\`\\n\\nThat is all.") });
`);
  assert.deepEqual((await it.inHome(() => runProgram({ projectDir: it.at("reads"), timeout: 30_000 }))).result, { bare: "const a = 1;", fenced: "const a = 1;" });
  assert.match(RUNTIME_TYPES, /\nexport declare function stripCodeFences\(reply: string\): string;/);
});

/** A writer that is a project, and answers as the prompt it is handed says. */
const ANSWERS = `import { ctx } from "@trama-dev/runtime";
const { prompt } = ctx.input.args as { prompt?: string };
const program = ${JSON.stringify(GOOD(7))};
if (prompt === undefined) await ctx.done({ nothing: "to write" });
else if (prompt.includes("blank")) await ctx.done({ unwritable: "   " });
else if (prompt.includes("both")) await ctx.done({ program, unwritable: "said beside a program, and not gone by" });
else if (prompt.includes("say nothing")) await ctx.done({});
else await ctx.done({ unwritable: \`it cannot be: \${prompt}\` });
`;

test("a writer that is a project may say that there is no program to be written — { unwritable } — as a fixer says there is no fix: nothing is validated, nothing made or changed", async (t) => {
  const it = scene(t, { maxRepairAttempts: 2 });
  it.project("answers", ANSWERS);
  it.project("words", GOOD(1));
  llm.repair = async () => { throw new Error("nobody is asked to mend what was said not to be had"); };
  const journalsOf = (name) => (existsSync(join(it.at(name), "logs", "journal")) ? readdirSync(join(it.at(name), "logs", "journal")).length : 0);

  // Of an update: the program is as it was, no version is made, and nothing was tried.
  await assert.rejects(it.inHome(() => updateProject("words", "give the letters too", { updateWith: "answers" })),
    (err) => { assert.equal(err.message, "Update failed — the program is unchanged.\nIt was said that there is none to be written: it cannot be: give the letters too"); return true; });
  assert.equal(readFileSync(join(it.at("words"), "program.ts"), "utf-8"), GOOD(1));
  assert.equal(journalsOf("words"), 0);
  await assert.rejects(it.inHome(() => updateProject("words", "blank", { updateWith: "answers" })), /\nIt was said that there is none to be written: no reason was given$/);
  // Of a making: there is no project.
  await assert.rejects(it.inHome(() => createProject("made", "make something", { createWith: "answers" })), /^Error: It was said that there is none to be written: it cannot be: make something$/);
  assert.equal(existsSync(it.at("made")), false);
  // Said beside a program, the program is the answer; and an answer that is neither says what one is to be.
  assert.equal(typeof (await it.inHome(() => updateProject("words", "both", { updateWith: "answers" }))).version, "number");
  assert.equal(readFileSync(join(it.at("words"), "program.ts"), "utf-8"), GOOD(7));
  await assert.rejects(it.inHome(() => updateProject("words", "say nothing", { updateWith: "answers" })),
    /The project asked for the update answered with no program: its result is to be \{ program \}, the whole of the new program — or \{ unwritable \}, why there is none to be written\.$/);
  await assert.rejects(it.inHome(() => createProject("made", "say nothing", { createWith: "answers" })),
    /The project asked for the program answered with no program: its result is to be \{ program \}, the whole of the program — or \{ unwritable \}, why there is none to be written\.$/);
});

/** What the model was asked, with what differs from one project to the next taken out: where the project is, and where its run's record. (Seen while it is asked: the copy is gone after.) */
const asAsked = (prompt, call, dir) => ({
  // (Its record is named by where the project really is: on macOS a temp directory is reached through a link.)
  prompt: prompt.split(realpathSync(dir)).join("<project>").split(dir).join("<project>").replace(/<project>\/logs\/journal\/[^\s]+\.jsonl/g, "<journal>"),
  system: call.system,
  // Where it works: a copy of the project — not the project — with what the project says of itself in it.
  inACopy: call.cwd !== dir && existsSync(join(call.cwd, "meta.json")) && readJson(join(call.cwd, "meta.json")).input.prompt === readJson(join(dir, "meta.json")).input.prompt,
});

test("examples/program-writer asks the agent what the kernel asks it, to the letter — for a project's first program and for its next — and what comes of it is the same", async (t) => {
  const it = scene(t);
  cpSync(WRITER, it.at("program-writer"), { recursive: true });
  const asked = [];
  llm.ask = async (prompt, call) => { asked.push({ prompt, call: { system: call.system, cwd: call.cwd, model: call.model }, there: existsSync(join(call.cwd, "meta.json")) ? readJson(join(call.cwd, "meta.json")) : null }); return "```ts\n" + GOOD(asked.length) + "```\n"; };

  // A making: once with what the project takes and gives said by whoever asks, once with it left to whoever writes.
  for (const [n, says] of [[1, { description: "Says a number.", parameters: { "loud?": "boolean" }, returns: { n: "number" } }], [2, { description: "Says a number." }], [3, {}]]) {
    const before = asked.length;
    await it.inHome(() => createProject(`kernel-${n}`, "say a number", { args: { loud: true }, ...says }));
    await it.inHome(() => createProject(`program-${n}`, "say a number", { args: { loud: true }, ...says, createWith: "program-writer" }));
    const [byKernel, byProgram] = asked.slice(before);
    assert.equal(asked.length, before + 2, "each was asked once");
    assert.equal(byProgram.prompt, byKernel.prompt, `making ${n}: what is asked`);
    assert.equal(byProgram.call.system, byKernel.call.system, `making ${n}: what it is told beside`);
    assert.match(byKernel.call.system, /^You are generating a TypeScript program for the trama runtime\./);
    // In a copy of the project that is being made, both: with its meta.json and no program.
    for (const [one, name] of [[byKernel, `kernel-${n}`], [byProgram, `program-${n}`]]) {
      assert.notEqual(one.call.cwd, it.at(name));
      assert.equal(one.there?.input?.prompt, "say a number", name);
    }
    // The model the project is made with is the one asked, by either: the kernel's backend is of it, and the program names it.
    assert.deepEqual([byKernel.call.model, byProgram.call.model], [undefined, `${readJson(join(it.at(`program-${n}`), "meta.json")).provider}/${readJson(join(it.at(`program-${n}`), "meta.json")).model}`]);
    // What comes of it: the program, out of its fences, the project's first version.
    for (const [name, k] of [[`kernel-${n}`, before + 1], [`program-${n}`, before + 2]]) assert.equal(readFileSync(join(it.at(name), "program.ts"), "utf-8").trim(), GOOD(k).trim(), name);
  }

  // An update: of a project with a contract and a state, and of one with neither.
  for (const [n, more, state] of [[1, { description: "Says a number.", returns: { n: "number" } }, { count: 2, seen: ["a"] }], [2, {}, undefined]]) {
    for (const who of ["kernel", "program"]) it.project(`${who}-up-${n}`, GOOD(0), { more, state });
    const before = asked.length;
    const versions = [await it.inHome(() => updateProject(`kernel-up-${n}`, "say another")), await it.inHome(() => updateProject(`program-up-${n}`, "say another", { updateWith: "program-writer" }))];
    assert.deepEqual(versions[1], versions[0], "the same version comes of it");
    for (const [who, k] of [["kernel", before + 1], ["program", before + 2]]) assert.equal(readFileSync(join(it.at(`${who}-up-${n}`), "program.ts"), "utf-8").trim(), GOOD(k).trim(), who);
    const [byKernel, byProgram] = asked.slice(before);
    assert.equal(asked.length, before + 2);
    assert.equal(byProgram.prompt, byKernel.prompt, `update ${n}: what is asked`);
    assert.equal(byProgram.call.system.split(`the program-up-${n}`).join("<prompt>"), byKernel.call.system.split(`the kernel-up-${n}`).join("<prompt>"), `update ${n}: what it is told beside`);
    assert.match(byKernel.call.system, /\n\nOriginal prompt: the kernel-up-\d\n\nCurrent program\.ts:\n/);
    assert.equal(/\n\nCurrent state:\n\{\n  "count": 2,/.test(byKernel.call.system), state !== undefined);
  }

  // Where the model says there is no program, so does the writer: and it is said to whoever asked as the kernel says it.
  llm.ask = async () => "\n NO PROGRAM: the project says it gives `n` alone.\n";
  const none = [];
  for (const how of [{}, { updateWith: "program-writer" }]) await it.inHome(() => updateProject("kernel-up-2", "give more", how)).catch((err) => none.push(err.message));
  assert.deepEqual(none, Array(2).fill("Update failed — the program is unchanged.\nIt was said that there is none to be written: the project says it gives `n` alone."));
  // Run with nothing to write — as it is when a version of it is validated — it says so, and ends.
  llm.ask = async () => { throw new Error("nothing is asked of a model where there is nothing to write"); };
  assert.equal(typeof (await it.inHome(() => runProgram({ projectDir: it.at("program-writer"), timeout: 30_000 }))).result.nothing, "string");
});

test("examples/program-fixer asks the agent for a fix as the kernel asks it, to the letter — and the fix is tried, and kept, as the kernel's is", async (t) => {
  const it = scene(t, { maxRepairAttempts: 1 });
  cpSync(FIXER, it.at("program-fixer"), { recursive: true });
  const BROKEN = `import { ctx } from "@trama-dev/runtime";\nthrow new Error("the answer is not known");\n`;
  const asked = [];
  llm.repair = async (prompt, call) => { asked.push(asAsked(prompt, call, it.at(asked.length === 0 ? "kernel-fails" : "program-fails"))); return "```ts\n" + GOOD(asked.length) + "```"; };
  for (const who of ["kernel", "program"]) it.project(`${who}-fails`, BROKEN);
  const byKernelRun = await it.inHome(() => runProgram({ projectDir: it.at("kernel-fails"), timeout: 30_000 }));
  const byProgramRun = await it.inHome(() => runProgram({ projectDir: it.at("program-fails"), timeout: 30_000, repairWith: "program-fixer" }));
  assert.deepEqual([byKernelRun.status, byKernelRun.result, byProgramRun.status, byProgramRun.result], ["done", { n: 1 }, "done", { n: 2 }]);
  assert.equal(asked.length, 2);
  const [byKernel, byProgram] = asked;
  assert.match(byKernel.prompt, /^Fix this program so it runs\.\n\n[^]*The record of the run that failed[^]* is at <journal>, a line of JSON for each\.\n/);
  assert.deepEqual(byProgram, byKernel);
  assert.equal(byKernel.inACopy, true);
  // The fix is the project's program, by either.
  assert.equal(readFileSync(join(it.at("program-fails"), "program.ts"), "utf-8").trim(), GOOD(2).trim());

  // Where the model says there is no fix, so does the fixer: no program is tried, and the run failed as it had.
  llm.repair = async () => "NO FIX: the answer is nowhere to be had.";
  for (const who of ["kernel", "program"]) writeText(join(it.at(`${who}-fails`), "program.ts"), BROKEN);
  const none = [await it.inHome(() => runProgram({ projectDir: it.at("kernel-fails"), timeout: 30_000 })), await it.inHome(() => runProgram({ projectDir: it.at("program-fails"), timeout: 30_000, repairWith: "program-fixer" }))];
  for (const ran of none) assert.match(ran.reason, /No fix came back: It was said that there is none to be had: the answer is nowhere to be had\.$/);
  // Run with nothing to fix — as it is when a version of it is validated — it says so, and ends.
  llm.repair = async () => { throw new Error("nothing is asked of a model where there is nothing to fix"); };
  assert.equal(typeof (await it.inHome(() => runProgram({ projectDir: it.at("program-fixer"), timeout: 30_000, maxRepairAttempts: 0 }))).result.nothing, "string");
});
