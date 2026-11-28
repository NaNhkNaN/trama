import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync, realpathSync } from "fs";
import { join } from "path";
import { llm } from "./fake-llm.mjs";
import { createProject, runProgram, updateProject } from "../packages/runtime/dist/index.js";
import { RUNTIME_TYPES } from "../packages/runtime/dist/runner.js";
import { execFile, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, symlinkSync } from "node:fs";
import { REPO_ROOT, captureConsole, cleanupTempDir, createProjectFixture, makeTempDir, readJson, withEnv, writeJson, writeText } from "./helpers.mjs";

// Who writes a project's program, and who fixes one that failed, where nobody is named: two programs that come with
// the runtime (packages/runtime/programs) — each a project among the user's, put there the first time it is wanted,
// and the user's from then on. The runtime has no words of its own for either: what the agent is asked is the
// program's to say. And what a program needs to do that work: its agent at work in its workspace, a way for a
// writer to say that there is no program to be written, and the program in a model's reply.

const OWN = join(REPO_ROOT, "packages", "runtime", "programs"), WRITER = join(OWN, "program-writer"), FIXER = join(OWN, "program-fixer");
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
  /** The same, with what was said aloud the while: `said`, every line in the order of its channel — what is said as it goes, then what is warned of. */
  const heard = async (fn) => {
    const { messages: warned, result: { messages: logged, result } } = await withEnv({ HOME: fakeHome }, () => captureConsole("warn", () => captureConsole("log", fn)));
    return { result, said: [...logged, ...warned] };
  };
  /** The records of a project's runs, a journal each, oldest first. */
  const journals = (name) => {
    const dir = join(at(name), "logs", "journal");
    return existsSync(dir) ? readdirSync(dir).sort().map((file) => readFileSync(join(dir, file), "utf-8").trim().split("\n").map((line) => JSON.parse(line))) : [];
  };
  const project = (name, program, { args = {}, more = {}, state } = {}) => {
    createProjectFixture(at(name), { programSource: program, metaInput: { prompt: `the ${name}`, args } });
    writeJson(join(at(name), "meta.json"), { ...readJson(join(at(name), "meta.json")), ...more });
    if (state) writeJson(join(at(name), "state.json"), state);
    return at(name);
  };
  return { fakeHome, at, inHome, heard, journals, project };
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

  // Of an update: the program is as it was, no version is made, and nothing was tried.
  await assert.rejects(it.inHome(() => updateProject("words", "give the letters too", { updateWith: "answers" })),
    (err) => { assert.equal(err.message, "Update failed — the program is unchanged.\nIt was said that there is none to be written: it cannot be: give the letters too"); return true; });
  assert.equal(readFileSync(join(it.at("words"), "program.ts"), "utf-8"), GOOD(1));
  // (Nothing was validated: what is on the project's record is that a program was asked for, and why none came.)
  assert.deepEqual(it.journals("words").map((journal) => [journal[0].purpose, journal.at(-1).result.reason]), [["write", "It was said that there is none to be written: it cannot be: give the letters too"]]);
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

/** What a request of the model used, as its library says it: thirty-three tokens, a cent. */
const USED = { model: "fake/plain", input: 30, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.01 };
/** The files of a project that came with the runtime, each by its text. */
const filesOf = (dir) => Object.fromEntries(readdirSync(dir).filter((name) => !["logs", "history", "node_modules", ".gitignore", "state.json"].includes(name)).sort().map((name) => [name, readFileSync(join(dir, name), "utf-8")]));
const AMONG = (name, does) => new RegExp(`^\\[trama\\] ${name} is among your projects \\(.*/\\.trama/projects/${name}\\): it ${does} where nobody else is named, and is yours to change\\.$`);
/** A writer of the user's own making, that asks no model: the program it answers with says how long what was asked is. */
const BY_LENGTH = `import { ctx } from "@trama-dev/runtime";
const { prompt } = ctx.input.args as { prompt?: string };
if (prompt === undefined) await ctx.done({ nothing: "to write" });
else await ctx.done({ program: 'import { ctx } from "@trama-dev/runtime";\\nawait ctx.done({ n: ' + prompt.length + ' });\\n' });
`;

test("where nobody is named to write a program, the runtime's own writer writes it: a project among the user's — put there the first time, and said so once — whose words to the agent are its own, and the user's to change", async (t) => {
  const it = scene(t);
  const asked = [];
  llm.ask = async (prompt, call) => { asked.push({ prompt, system: call.system, cwd: realpathSync(call.cwd), model: call.model }); call.used?.(USED); return "```ts\n" + GOOD(asked.length) + "```\n"; };

  // The first making: the writer is put among the user's projects as it came with the runtime, and it is said.
  assert.equal(existsSync(it.at("program-writer")), false);
  const first = await it.heard(() => createProject("one", "say a number", { description: "Says a number.", returns: { n: "number" } }));
  assert.deepEqual(filesOf(it.at("program-writer")), filesOf(WRITER));
  assert.equal(first.said.filter((line) => AMONG("program-writer", "writes a project's program").test(line)).length, 1, first.said.join("\n"));
  assert.equal(readFileSync(join(it.at("one"), "program.ts"), "utf-8").trim(), GOOD(1).trim());
  // What the agent was asked is what the writer's program says: once, at work in a copy of the project, by the model the project is made with.
  assert.equal(asked.length, 1);
  assert.match(asked[0].system, /^You are generating a TypeScript program for the trama runtime\.\n\n[^]*\n\nWhat the project says it takes and gives \(its meta\.json\): the program is held to it/);
  assert.match(asked[0].prompt, /^say a number\n\nOutput ONLY the TypeScript program\. No markdown fences\. No explanation\.$/);
  assert.notEqual(asked[0].cwd, realpathSync(it.at("one")));
  const made = readJson(join(it.at("one"), "meta.json"));
  assert.equal(asked[0].model, `${made.provider}/${made.model}`);
  // It is a run of the writer's project, on that project's record: its agent asked in its workspace.
  const calls = it.journals("program-writer").flat().filter((record) => record.kind === "call" && record.endpoint === "/agent/instruct");
  assert.deepEqual(calls.map((record) => record.request.workspace), [true]);
  // And on the record of what it wrote: who wrote it, and what that took — which is said aloud too.
  const written = it.journals("one").flat().filter((record) => record.kind === "written");
  assert.deepEqual(written.map(({ by, used }) => ({ by: realpathSync(by), used })), [{ by: realpathSync(it.at("program-writer")), used: { calls: 1, tokens: 33, cost: 0.01 } }]);
  assert.equal(first.said.filter((line) => line === "[trama] writing the program used 33 tokens  $0.0100").length, 1, first.said.join("\n"));

  // What the project does not say of itself yet, whoever writes its first program is to say — and is told so; with programs to go by.
  assert.match(asked[0].system, /\n\nSay in meta\.json, here, what the project does not say of itself yet — "parameters" — for whoever is to choose this program among others/);
  assert.match(asked[0].system, /\n\nExamples:\n\/\/ Example A: /);

  // From then on it is there, and nothing more is said of it: for a making, and for an update.
  const second = await it.heard(() => createProject("two", "say another"));
  writeJson(join(it.at("one"), "state.json"), { count: 2 });
  const third = await it.heard(() => updateProject("one", "say a third"));
  assert.equal([...second.said, ...third.said].filter((line) => /is among your projects/.test(line)).length, 0);
  assert.equal(asked.length, 3);
  assert.match(asked[1].system, /\n\nSay in meta\.json, here, what the project does not say of itself yet — "description", "parameters", "returns" — /);
  assert.doesNotMatch(asked[1].system, /What the project says it takes and gives \(its meta\.json\)|Current program\.ts/);
  // An update is told what the project says, what it was first asked for, the program as it is and what it has kept — and nothing of saying what is said.
  assert.match(asked[2].system, /\n\nWhat the project says it takes and gives \(its meta\.json\): [^]*\n\nOriginal prompt: say a number\n\nCurrent program\.ts:\n[^]*\n\nCurrent state:\n\{\n  "count": 2\n\}$/);
  assert.doesNotMatch(asked[2].system, /Say in meta\.json/);
  assert.match(asked[2].prompt, /^say a third\n\nOutput the complete updated program\.ts\. No partial patches\. No markdown fences\. No explanation\.$/);

  // It is the user's: changed, the changed one is who writes — and the runtime has no words of its own to fall back on (no model is asked).
  writeText(join(it.at("program-writer"), "program.ts"), BY_LENGTH);
  llm.ask = async () => { throw new Error("the runtime asked a model for a program by itself"); };
  await it.inHome(() => createProject("three", "say a number"));
  assert.equal(readFileSync(join(it.at("three"), "program.ts"), "utf-8"), GOOD(12));
  await it.inHome(() => updateProject("three", "say another one"));
  assert.equal(readFileSync(join(it.at("three"), "program.ts"), "utf-8"), GOOD(15));
  // (And so of the writer itself: its next version is written by it, as any project's is.)
  await it.inHome(() => updateProject("program-writer", "be as you are"));
  assert.equal(readFileSync(join(it.at("program-writer"), "program.ts"), "utf-8"), GOOD(13));
});

test("the runtime's own writer is not put where somebody is named to write, nor where a program is handed over — and where something that is no project has its name, the making is refused before anything is made", async (t) => {
  const it = scene(t);
  it.project("by-length", BY_LENGTH);
  await it.inHome(() => createProject("named", "say a number", { createWith: "by-length" }));
  await it.inHome(() => createProject("handed", "say a number", { program: GOOD(5) }));
  await it.inHome(() => updateProject("named", "say another one", { updateWith: "by-length" }));
  assert.equal(existsSync(it.at("program-writer")), false);
  // (And by the configuration, as by the call.)
  writeJson(join(it.fakeHome, ".trama", "config.json"), { maxRepairAttempts: 0, createWith: "by-length", updateWith: "by-length" });
  await it.inHome(() => createProject("configured", "say a number"));
  assert.equal(existsSync(it.at("program-writer")), false);

  // Something in the way of it: said, with where it is — and no project is made, no program changed.
  writeJson(join(it.fakeHome, ".trama", "config.json"), { maxRepairAttempts: 0 });
  writeText(it.at("program-writer"), "no project\n");
  const IN_THE_WAY = /program-writer writes a project's program where nobody else is named, and is to be a project among yours: what is at .*\/\.trama\/projects\/program-writer is none\. Move it away, or name who is to write \(createWith, updateWith\)\./;
  await assert.rejects(it.inHome(() => createProject("unmade", "say a number")), IN_THE_WAY);
  assert.equal(existsSync(it.at("unmade")), false);
  await assert.rejects(it.inHome(() => updateProject("named", "say a third thing")), IN_THE_WAY);
  assert.equal(readFileSync(join(it.at("named"), "program.ts"), "utf-8"), GOOD(15));
  // (A making of a project by the writer's own name finds the writer there, once it is: the name is taken.)
  const other = scene(t);
  llm.ask = async () => GOOD(1);
  await assert.rejects(other.inHome(() => createProject("program-writer", "write programs")), /Project "program-writer" already exists\./);
  assert.deepEqual(filesOf(other.at("program-writer")), filesOf(WRITER));
});

test("a writing that came to nothing is on the project's record, whoever wrote: who was asked, what that took, and why nothing came of it — a journal of its own", async (t) => {
  const it = scene(t);
  it.project("words", GOOD(1));
  llm.ask = async (_prompt, call) => { call.used?.(USED); return "\n NO PROGRAM: the project says it gives `n` alone.\n"; };
  const none = await it.heard(() => updateProject("words", "give the letters too").catch((err) => err.message));
  assert.equal(none.result, "Update failed — the program is unchanged.\nIt was said that there is none to be written: the project says it gives `n` alone.");
  assert.equal(readFileSync(join(it.at("words"), "program.ts"), "utf-8"), GOOD(1));
  assert.equal(none.said.filter((line) => line === "[trama] writing the program used 33 tokens  $0.0100").length, 1, none.said.join("\n"));
  const record = it.journals("words");
  assert.equal(record.length, 1);
  assert.deepEqual(record[0].map(({ kind, purpose, by, used, result, journal }) => [kind, purpose ?? (by && realpathSync(by)) ?? result?.reason ?? (journal && "the writer's"), used ?? result?.status]), [
    ["run", "write", undefined],
    ["child", "update", undefined],
    ["written", realpathSync(it.at("program-writer")), { calls: 1, tokens: 33, cost: 0.01 }],
    ["end", "It was said that there is none to be written: the project says it gives `n` alone.", "failed"],
  ]);
  // (The run that is named there is the writer's own, on the writer's record.)
  const child = record[0].find((each) => each.kind === "child");
  assert.equal(it.journals("program-writer").some((journal) => journal[0].run === child.run), true);
  // By a writer of the user's that is named, the same.
  it.project("answers", ANSWERS);
  await it.inHome(() => updateProject("words", "nor this", { updateWith: "answers" }).catch(() => {}));
  assert.deepEqual(it.journals("words").at(-1).map((each) => [each.kind, each.used ?? each.purpose ?? each.result?.status]), [["run", "write"], ["child", "update"], ["written", { calls: 0, tokens: 0, cost: 0 }], ["end", "failed"]], "a writer that asked no model used nothing, and that is what is said: who was asked, and why nothing came of it");
  // Where nobody came to be asked — a writer whose run is not begun: it takes what it was not handed — nothing is left.
  it.project("strict", ANSWERS, { more: { parameters: { needed: "string: what no runner hands a writer" } } });
  const before = it.journals("words").length;
  await assert.rejects(it.inHome(() => updateProject("words", "nor this", { updateWith: "strict" })), /The arguments do not fit what .*strict takes — missing key: needed\./);
  assert.equal(it.journals("words").length, before);
  // Of a making that comes to nothing there is no project to leave it on.
  await assert.rejects(it.inHome(() => createProject("unmade", "make something")), /^Error: It was said that there is none to be written: the project says it gives `n` alone\.$/);
  assert.equal(existsSync(it.at("unmade")), false);
});

test("where nobody is named to fix a program that failed, the runtime's own fixer is asked: a project among the user's — there before the run begins, said so once, out of that run's reach — and the user's to change", async (t) => {
  const it = scene(t, { maxRepairAttempts: 1 });
  const BROKEN = `import { ctx } from "@trama-dev/runtime";\nthrow new Error("the answer is not known");\n`;
  const asked = [];
  llm.repair = async (prompt, call) => { asked.push({ prompt, system: call.system, cwd: realpathSync(call.cwd) }); call.used?.(USED); return "```ts\n" + GOOD(asked.length) + "```"; };
  it.project("fails", BROKEN);
  const first = await it.heard(() => runProgram({ projectDir: it.at("fails"), timeout: 30_000 }));
  assert.deepEqual([first.result.status, first.result.result], ["done", { n: 1 }]);
  assert.deepEqual(filesOf(it.at("program-fixer")), filesOf(FIXER));
  assert.equal(first.said.filter((line) => AMONG("program-fixer", "fixes a program that failed").test(line)).length, 1, first.said.join("\n"));
  assert.equal(readFileSync(join(it.at("fails"), "program.ts"), "utf-8").trim(), GOOD(1).trim());
  // What the agent was asked is what the fixer's program says: once, at work in a copy of the failing project.
  assert.equal(asked.length, 1);
  assert.equal(asked[0].system, "You are a TypeScript repair tool.");
  assert.match(asked[0].prompt, /^Fix this program so it runs\.\n\n[^]*\nBroken program:\nimport \{ ctx \} from "@trama-dev\/runtime";\nthrow new Error\("the answer is not known"\);\n\n\nError:\n/);
  assert.match(asked[0].prompt, /\nThe record of the run that failed — each call the program made, and what came back — is at \S+\.jsonl, a line of JSON for each\.\n/);
  assert.notEqual(asked[0].cwd, realpathSync(it.at("fails")));
  // On the failing run's record: the fix was asked of the fixer's project, and what it took.
  const fixes = it.journals("fails").flat().filter((record) => record.kind === "fix");
  assert.deepEqual(fixes.map(({ ok, by, used }) => ({ ok, by: realpathSync(by), used })), [{ ok: true, by: realpathSync(it.at("program-fixer")), used: { calls: 1, tokens: 33, cost: 0.01 } }]);
  assert.deepEqual(it.journals("program-fixer").flat().filter((record) => record.kind === "call" && record.endpoint === "/agent/instruct").map((record) => record.request.workspace), [true]);

  // It is there before a run begins — one that may be fixed — and is out of that run's reach: what fixes a run is not that run's to change.
  const other = scene(t, { maxRepairAttempts: 1 });
  other.project("sly", `import { ctx } from "@trama-dev/runtime";
import { addVersion } from "@trama-dev/runtime/runner";
try { await addVersion("program-fixer", ${JSON.stringify(GOOD(0))}); await ctx.done({ changed: true }); }
catch (err) { await ctx.done({ refused: (err as Error).message }); }
`);
  const sly = await other.heard(() => runProgram({ projectDir: other.at("sly"), timeout: 30_000 }));
  assert.match(sly.result.result.refused, /Project "program-fixer" is the one that fixes this run, or a run it is part of: what checks a run, or fixes it, is not that run's to change\./);
  assert.deepEqual(filesOf(other.at("program-fixer")), filesOf(FIXER));
  assert.equal(sly.said.filter((line) => /program-fixer is among your projects/.test(line)).length, 1);
  // A run that is not to be fixed looks for nobody, and nothing is put anywhere; nor where somebody is named to fix.
  const plain = scene(t);
  plain.project("runs", GOOD(1));
  plain.project("fixer-of-mine", GOOD(2));
  await plain.inHome(() => runProgram({ projectDir: plain.at("runs"), timeout: 30_000 }));
  await plain.inHome(() => runProgram({ projectDir: plain.at("runs"), timeout: 30_000, maxRepairAttempts: 2, repairWith: "fixer-of-mine" }));
  assert.equal(existsSync(plain.at("program-fixer")), false);

  // It is the user's: changed, the changed one is asked — and the runtime has no words of its own to fall back on (no model is asked).
  writeText(join(it.at("program-fixer"), "program.ts"), `import { ctx } from "@trama-dev/runtime";\nconst { program } = ctx.input.args as { program?: string };\nawait ctx.done(program === undefined ? { nothing: "to fix" } : { unfixable: "nobody knows the answer" });\n`);
  writeText(join(it.at("fails"), "program.ts"), BROKEN);
  llm.repair = async () => { throw new Error("the runtime asked a model for a fix by itself"); };
  const none = await it.inHome(() => runProgram({ projectDir: it.at("fails"), timeout: 30_000 }));
  assert.match(none.reason, /No fix came back: It was said that there is none to be had: nobody knows the answer$/);
  // Where the model says there is no fix, the fixer as it came says so too.
  const said = scene(t, { maxRepairAttempts: 2 });
  said.project("fails", BROKEN);
  llm.repair = async () => "NO FIX: the answer is nowhere to be had.";
  assert.match((await said.inHome(() => runProgram({ projectDir: said.at("fails"), timeout: 30_000 }))).reason, /^Failed after 1 repair attempt\(s\): [^]*No fix came back: It was said that there is none to be had: the answer is nowhere to be had\.$/);
});

test("the two come with the runtime: they are in what is packed of it — and each, run with nothing to do, says so and ends, which is how a version of it is validated", async (t) => {
  for (const [dir, name] of [[WRITER, "program-writer"], [FIXER, "program-fixer"]]) {
    assert.deepEqual(Object.keys(filesOf(dir)).filter((file) => file !== "example-programs.txt"), ["README.md", "meta.json", "package.json", "program.ts"], name);
    assert.equal(existsSync(join(REPO_ROOT, "examples", name)), false, `${name} is the runtime's, and no example to be copied`);
  }
  // (Listed as npm would pack the package: nothing is packed, and nothing of the repository is touched.)
  const listing = await new Promise((resolve, reject) => execFile("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: join(REPO_ROOT, "packages", "runtime"), encoding: "utf-8" }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout))));
  const files = JSON.parse(listing)[0].files.map((file) => file.path);
  for (const path of ["programs/program-writer/program.ts", "programs/program-writer/example-programs.txt", "programs/program-writer/meta.json", "programs/program-fixer/program.ts", "programs/program-fixer/meta.json"]) assert.ok(files.includes(path), path);
  const it = scene(t);
  llm.ask = async () => { throw new Error("nothing is asked of a model where there is nothing to do"); };
  for (const [dir, name] of [[WRITER, "program-writer"], [FIXER, "program-fixer"]]) {
    it.project(name, readFileSync(join(dir, "program.ts"), "utf-8"));
    assert.equal(typeof (await it.inHome(() => runProgram({ projectDir: it.at(name), timeout: 30_000 }))).result.nothing, "string", name);
  }
});

test("the two type-check against the API a program has, as they are written", (t) => {
  for (const [from, name] of [[WRITER, "program-writer"], [FIXER, "program-fixer"]]) {
    const dir = makeTempDir("trama-types-");
    t.after(() => cleanupTempDir(dir));
    // (As a project has the runtime: by its name, among its own modules.)
    cpSync(from, dir, { recursive: true });
    mkdirSync(join(dir, "node_modules", "@trama-dev"), { recursive: true });
    symlinkSync(join(REPO_ROOT, "packages", "runtime"), join(dir, "node_modules", "@trama-dev", "runtime"));
    writeJson(join(dir, "tsconfig.json"), {
      compilerOptions: { noEmit: true, strict: true, target: "es2022", module: "nodenext", moduleResolution: "nodenext", skipLibCheck: true, types: [] },
      files: ["program.ts"],
    });
    try {
      execFileSync(process.execPath, [join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", dir], { encoding: "utf-8", stdio: "pipe" });
    } catch (err) {
      assert.fail(`${name} does not type-check:\n${err.stdout}${err.stderr}`);
    }
  }
});
