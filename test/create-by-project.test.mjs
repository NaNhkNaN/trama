import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { llm } from "./fake-llm.mjs";
import { createProject, describeProject, runProgram } from "../packages/runtime/dist/index.js";
import { REPO_ROOT, captureConsole, cleanupTempDir, createProjectFixture, makeTempDir, readJson, runNodeCommand, wholeLines, withEnv, writeJson } from "./helpers.mjs";

// A project's making: what it is to take and give is born with its program — said by whoever asks for the project,
// or else by whoever writes its program, once, in the meta.json of the copy it works in — and its first program can
// be asked of a project (`createWith`) as an update can. From then on what the project says of itself is the
// project's. (Importing the stand-in for the model means a test here fails where pi's agent is asked for anything
// it did not provide.)

const SAYS = (n) => `import { ctx } from "@trama-dev/runtime";
const { add } = ctx.input.args as { add?: number };
await ctx.done({ n: ${n} + (add ?? 0) });
`;
const PUT_BACK = /\[trama\] meta\.json was changed in the copy that was worked in: it is put back as it was, and nothing of that is kept/;

function homeWith(t, projects = {}, config = { maxRepairAttempts: 0 }) {
  const fakeHome = makeTempDir("trama-create-home-"), notes = makeTempDir("trama-create-seen-");
  t.after(() => { cleanupTempDir(fakeHome); cleanupTempDir(notes); });
  writeJson(join(fakeHome, ".trama", "config.json"), config);
  const at = (name) => join(fakeHome, ".trama", "projects", name);
  for (const [name, { program }] of Object.entries(projects)) createProjectFixture(at(name), { programSource: program, metaInput: { prompt: `the ${name}`, args: {} } });
  const seen = join(notes, "seen.jsonl");
  writeFileSync(seen, "");
  const original = { ...llm };
  t.after(() => { Object.assign(llm, original); });
  /** What `fn` comes to, and what was warned of meanwhile. */
  const heard = (fn) => withEnv({ HOME: fakeHome, SEEN_BY_WRITER: seen }, () => captureConsole("warn", () => captureConsole("log", fn))).then(({ result, messages }) => ({ result: result.result, warned: messages, logged: result.messages }));
  // pi's agent, played: what it is told (its system prompt) is kept, and `does(cwd, meta)` is what it does in its copy before it answers.
  const told = [];
  const piWrites = (program, does = () => {}) => {
    llm.ask = async (_prompt, call) => {
      told.push(call.system);
      await does(call.cwd, JSON.parse(readFileSync(join(call.cwd, "meta.json"), "utf-8")));
      return program;
    };
  };
  return {
    fakeHome, at, heard, told, piWrites,
    seen: () => wholeLines(seen).map((line) => JSON.parse(line)),
    meta: (name) => readJson(join(at(name), "meta.json")),
    program: (name) => readFileSync(join(at(name), "program.ts"), "utf-8"),
    index: (name) => readFileSync(join(at(name), "history", "index.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line)),
    lines: (name) => (existsSync(join(at(name), "history", "runs.jsonl")) ? readFileSync(join(at(name), "history", "runs.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line)) : []),
    run: (name, options = {}) => heard(() => runProgram({ projectDir: at(name), timeout: 60_000, ...options })).then(({ result }) => result),
  };
}
const says = (cwd, meta, more) => writeFileSync(join(cwd, "meta.json"), JSON.stringify({ ...meta, ...more }, null, 2));

test("a project is made with what it is to take and give, where whoever asks says so: it is in its meta.json before anything is written, whoever writes is told it and cannot change it, and the program is validated under it", async (t) => {
  const it = homeWith(t);
  const GIVEN = { description: "Says a number.", parameters: { "add?": "number: what to add" }, returns: { n: "number" } };
  // (A writer that would have it give something else, and says so where it works.)
  it.piWrites(SAYS(1), (cwd, meta) => says(cwd, meta, { returns: { word: "string" } }));
  const made = await it.heard(() => createProject("words", "Say a number.", { args: { add: 2 }, ...GIVEN }));
  const { input, description, parameters, returns } = it.meta("words");
  assert.deepEqual([input, { description, parameters, returns }], [{ prompt: "Say a number.", args: { add: 2 } }, GIVEN]);
  assert.equal(made.warned.filter((line) => PUT_BACK.test(line)).length, 1);
  assert.match(it.told[0], /\n\nWhat the project says it takes and gives \(its meta\.json\): the program is held to it[^\n]*\n\{[^]*"add\?": "number: what to add"[^]*"n": "number"/);
  assert.doesNotMatch(it.told[0], /Say in meta\.json/);
  // Its first version was made under it; and it is told as any project's is.
  assert.match(it.index("words")[0].contract, /^[0-9a-f]{64}$/);
  assert.deepEqual([(await it.run("words")).result, (await it.run("words", { args: { add: "5" } })).result], [{ n: 3 }, { n: 6 }]);
  assert.equal((await withEnv({ HOME: it.fakeHome }, () => describeProject("words"))).schema.returns.properties.n.type, "number");

  // A program that does not give what was asked for is no program for the project.
  it.piWrites(`import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ word: "one" });\n`);
  await assert.rejects(it.heard(() => createProject("other", "Say a number.", GIVEN)), /The result does not fit what [^\n]* gives — missing key: n/);

  // What is no shape is refused before anything is made, or asked of a model; and so is what requires an argument the project is not made with.
  const asked = it.told.length;
  await assert.rejects(it.heard(() => createProject("odd", "p", { parameters: "string" })), /What "odd" is to take and give cannot be read — "parameters" is what the project takes: an object of the fields a run is given/);
  await assert.rejects(it.heard(() => createProject("odd", "p", { returns: { a: "text" } })), /What "odd" is to take and give cannot be read — "returns": Schema validation failed: unsupported schema type "text"/);
  await assert.rejects(it.heard(() => createProject("odd", "p", { parameters: { file: "string" } })),
    /The arguments do not fit what [^\n]*odd takes — missing key: file\.[^\n]*\nA project is validated by a run of it with the arguments it is made with: what it requires is to be among them, or written as what may be absent \("name\?"\)\./);
  assert.deepEqual([it.told.length, existsSync(it.at("odd"))], [asked, false]);
  // With the argument, it is made.
  it.piWrites(`import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ read: String((ctx.input.args as any).file) });\n`);
  await it.heard(() => createProject("reads", "p", { args: { file: "a.txt" }, parameters: { file: "string" } }));
  assert.deepEqual((await it.run("reads")).result, { read: "a.txt" });
});

test("where whoever asks does not say what a project takes and gives, whoever writes its program says it, in the meta.json of its copy: the description, the parameters and what it returns — those alone — and from then on it is the project's", async (t) => {
  const SAID = { description: "Says a number, and adds to it.", parameters: { "add?": "number: what to add" }, returns: { n: "number" } };
  const it = homeWith(t);
  it.piWrites(SAYS(1), (cwd, meta) => says(cwd, meta, SAID));
  const made = await it.heard(() => createProject("words", "Say a number."));
  const { input, description, parameters, returns, ...rest } = it.meta("words");
  assert.deepEqual([{ description, parameters, returns }, input, Object.keys(rest).includes("checkWith")], [SAID, { prompt: "Say a number.", args: {} }, false]);
  // Nothing was put back: it said what it was asked to say, and no more.
  assert.equal(made.warned.filter((line) => PUT_BACK.test(line)).length, 0);
  // And what it said is the project's by now, and no part of what was made beside the program: nothing is said to have been made or changed there, nor to have failed to arrive.
  assert.deepEqual([made.logged.filter((line) => /beside the program/.test(line)), made.warned.filter((line) => /meta\.json|did not reach|could not be carried/.test(line))], [[], []]);
  // It was told to, with how it is written and what the project is made with.
  assert.match(it.told[0], /\n\nSay in meta\.json, here, what the project does not say of itself yet — "description", "parameters", "returns"[^]*The project is made with these arguments, and is validated by a run of it with them: \{\}/);
  assert.match(it.index("words")[0].contract, /^[0-9a-f]{64}$/);
  // Held to it from its first run on: what it takes — and what it does not is left out.
  assert.deepEqual((await it.run("words", { args: { add: "2", other: 1 } })).result, { n: 3 });

  // Whatever else it did to the file is put back, and said: what the project was made with, who checks it.
  it.piWrites(SAYS(1), (cwd, meta) => says(cwd, meta, { ...SAID, checkWith: "nobody", input: { prompt: "another", args: { add: 40 } } }));
  const more = await it.heard(() => createProject("more", "Say a number."));
  assert.deepEqual([it.meta("more").input, "checkWith" in it.meta("more"), it.meta("more").returns, more.warned.filter((line) => PUT_BACK.test(line)).length], [{ prompt: "Say a number.", args: {} }, false, SAID.returns, 1]);

  // Of what whoever asks did say, nothing is the writer's: the rest it says.
  it.piWrites(SAYS(1), (cwd, meta) => says(cwd, meta, { ...SAID, returns: { word: "string" } }));
  const part = await it.heard(() => createProject("part", "Say a number.", { returns: { n: "number: the number" } }));
  assert.deepEqual([it.meta("part").returns, it.meta("part").parameters, it.meta("part").description, part.warned.filter((line) => PUT_BACK.test(line)).length], [{ n: "number: the number" }, SAID.parameters, SAID.description, 1]);
  assert.match(it.told.at(-1), /Say in meta\.json, here, what the project does not say of itself yet — "description", "parameters" — for whoever/);

  // A writer that says nothing leaves a project that says nothing, as it was.
  it.piWrites(SAYS(1));
  await it.heard(() => createProject("silent", "Say a number."));
  assert.deepEqual(["parameters" in it.meta("silent"), "contract" in it.index("silent")[0], (await it.run("silent", { args: { add: 1, other: 2 } })).result], [false, false, { n: 2 }]);

  // It is the answer's other half, and no part of what was made beside the program: taken where nothing else of the copy is.
  const discards = homeWith(t, {}, { maxRepairAttempts: 0, agentChanges: "discard" });
  discards.piWrites(SAYS(1), (cwd, meta) => { says(cwd, meta, SAID); writeFileSync(join(cwd, "beside.txt"), "x"); });
  await discards.heard(() => createProject("words", "Say a number."));
  assert.deepEqual([discards.meta("words").returns, existsSync(join(discards.at("words"), "beside.txt"))], [SAID.returns, false]);

  // What is no shape is no contract, and no project comes of it — its program is left to be looked at, saying nothing of itself.
  it.piWrites(SAYS(1), (cwd, meta) => says(cwd, meta, { parameters: { add: "numbr" } }));
  await assert.rejects(it.heard(() => createProject("unread", "p")), /What was said, in meta\.json, of what the project takes and gives cannot be read — "parameters": Schema validation failed: unsupported schema type "numbr" for key "add"/);
  assert.deepEqual([it.program("unread"), "parameters" in it.meta("unread")], [SAYS(1).trim(), false]);
  // Nor is one that requires what the project is not made with.
  it.piWrites(SAYS(1), (cwd, meta) => says(cwd, meta, { parameters: { add: "number" } }));
  await assert.rejects(it.heard(() => createProject("needs", "p")), /takes — missing key: add\.[^\n]*\nA project is validated by a run of it with the arguments it is made with/);
  // And the program is validated under what was said of it: one that does not give what its writer said it gives is no program for the project.
  it.piWrites(`import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ word: "one" });\n`, (cwd, meta) => says(cwd, meta, SAID));
  await assert.rejects(it.heard(() => createProject("unfit", "p")), /The result does not fit what [^\n]* gives — missing key: n/);
});

/** A project that writes a new project's first program: no model in it. What it was handed is written down. */
const MAKER = `import { ctx, workspace } from "@trama-dev/runtime";
import { appendFileSync } from "node:fs";
const args = ctx.input.args as any;
if (args.prompt === undefined) await ctx.done({ nothing: "to write" });
else {
  appendFileSync(process.env.SEEN_BY_WRITER!, JSON.stringify({
    handed: Object.keys(args).sort(), prompt: args.prompt, kept: args.kept, files: await workspace.list("*"),
    meta: JSON.parse(await workspace.read("meta.json")), pwd: (await workspace.shell("pwd")).stdout.trim() === args.copy,
  }) + "\\n");
  const meta = JSON.parse(await workspace.read("meta.json"));
  await workspace.write("meta.json", JSON.stringify({ ...meta, description: "Says a number.", returns: meta.returns ?? { n: "number" } }));
  await workspace.write("made-by.txt", "the maker");
  await ctx.done({ program: ${JSON.stringify(SAYS(1))} });
}
`;
/** A program that has a project made by a writer. */
const ASKS = `import { ctx } from "@trama-dev/runtime";
import { createProject, describeProject } from "@trama-dev/runtime/runner";
await createProject("asked-for", "Say a number.", { createWith: "maker", parameters: { "add?": "number" } });
await ctx.done({ says: await describeProject("asked-for") });
`;

test("a project's first program is asked of the project a call names, or the configuration: it works in the copy of the new project, handed what is asked and no program — and what it answers with is validated and installed, and what it says the project takes and gives is taken, as of any writer", async (t) => {
  const it = homeWith(t, { maker: { program: MAKER }, asker: { program: ASKS } });
  llm.ask = async () => assert.fail("pi's agent was asked for the program");
  await it.heard(() => createProject("words", "Say a number.", { createWith: "maker", args: { add: 1 } }));
  assert.deepEqual([it.program("words"), readFileSync(join(it.at("words"), "made-by.txt"), "utf-8")], [SAYS(1), "the maker"]);
  const [saw] = it.seen();
  assert.deepEqual([saw.handed, saw.prompt, saw.kept, saw.pwd, saw.files.includes("meta.json"), saw.files.includes("program.ts"), saw.meta.input], [["copy", "kept", "prompt", "types"], "Say a number.", true, true, true, false, { prompt: "Say a number.", args: { add: 1 } }]);
  assert.deepEqual([it.meta("words").description, it.meta("words").returns, it.index("words").map(({ version, reason }) => [version, reason])], ["Says a number.", { n: "number" }, [[1, "create"]]]);
  // The writing is a run of the writer's own project, which says what it was for.
  assert.deepEqual(it.lines("maker").map((line) => [line.for, line.status]), [["create", "done"]]);
  assert.deepEqual((await it.run("words")).result, { n: 2 });

  // Named in the configuration; and what names no project is no making — nothing is left of it.
  const configured = homeWith(t, { maker: { program: MAKER } }, { maxRepairAttempts: 0, createWith: "maker" });
  await configured.heard(() => createProject("words", "Say a number."));
  assert.equal(configured.program("words"), SAYS(1));
  await assert.rejects(it.heard(() => createProject("none", "p", { createWith: "nobody" })), /createWith names no project: there is none at .*nobody/);
  assert.equal(existsSync(it.at("none")), false);

  // Asked for by a program, by its runner: with what whoever asks says of it, which the writer finds said and leaves.
  const ran = await it.run("asker", { label: "asker" });
  assert.equal(ran.status, "done", ran.reason);
  assert.deepEqual([ran.result.says.parameters, ran.result.says.returns, ran.result.says.description], [{ "add?": "number" }, { n: "number" }, "Says a number."]);
  assert.deepEqual(it.seen().at(-1).meta.parameters, { "add?": "number" });
});

test("the command line makes a project by the writer that is named, with what it is to take and give read from a file", async (t) => {
  const it = homeWith(t, { maker: { program: MAKER } });
  const seen = join(it.fakeHome, "seen.jsonl");
  writeFileSync(seen, "");
  const trama = (...args) => runNodeCommand([join(REPO_ROOT, "packages", "cli", "dist", "index.js"), ...args], { cwd: it.fakeHome, env: { ...process.env, HOME: it.fakeHome, SEEN_BY_WRITER: seen } });
  const SAYS_IT = { description: "Says a number.", parameters: { "add?": "number: what to add" }, returns: { n: "number" } };
  writeJson(join(it.fakeHome, "contract.json"), SAYS_IT);
  const made = await trama("create", "words", "Say a number.", "--with", "maker", "--contract", "contract.json", "--arg", "add=1");
  assert.match(made.stdout, /Created words\./, made.stderr);
  const { description, parameters, returns, input } = it.meta("words");
  // (From a command line every argument is text: held to what the project takes, it is the number.)
  assert.deepEqual([{ description, parameters, returns }, input, it.program("words")], [SAYS_IT, { prompt: "Say a number.", args: { add: "1" } }, SAYS(1)]);
  assert.deepEqual((await it.run("words")).result, { n: 2 });
  // What the file is to be: JSON, an object, of those three and no other — a name written wrongly is no contract.
  for (const [text, why] of [
    ["not json", /--contract takes a file of JSON — an object of "description", "parameters", "returns" — and contract\.json is none: /],
    [JSON.stringify(["description"]), /--contract takes a file of JSON — an object of "description", "parameters", "returns" — and contract\.json is none: it is a list/],
    [JSON.stringify({ ...SAYS_IT, paramters: {} }), /--contract: "paramters" is none of "description", "parameters", "returns"\./],
  ]) {
    writeFileSync(join(it.fakeHome, "contract.json"), text);
    const refused = await trama("create", "other", "p", "--contract", "contract.json");
    assert.match(refused.stderr, why, text);
    assert.equal(existsSync(it.at("other")), false, text);
  }
  assert.match((await trama("create", "other", "p", "--contract", "nowhere.json")).stderr, /^Error: [^\n]*nowhere\.json/);
});
