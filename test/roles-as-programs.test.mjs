import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync, realpathSync } from "fs";
import { join } from "path";
import { llm } from "./fake-llm.mjs";
import { createProject, runProgram, updateProject } from "../packages/runtime/dist/index.js";
import { RUNTIME_TYPES } from "../packages/runtime/dist/runner.js";
import { execFile, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { ownMark } from "../packages/runtime/dist/project.js";
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
  assert.match(asked[0].prompt, /^say a number\n\nOutput ONLY the TypeScript program\. No markdown fences\. No explanation\. \(Or the one line that begins "IN THE FILE:", /);
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
  assert.match(asked[2].prompt, /^say a third\n\nOutput the complete updated program\.ts\. No partial patches\. No markdown fences\. No explanation\. \(Or the one line that begins "IN THE FILE:", /);

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

test("the program is program.ts as the agent left it, where its answer says so — \"IN THE FILE:\" — and is then no program itself; any other answer is the program, whatever was done to the file", async (t) => {
  const it = scene(t, { maxRepairAttempts: 1 });
  const programOf = (name) => readFileSync(join(it.at(name), "program.ts"), "utf-8");
  it.project("words", GOOD(1));
  // The agent changes the file where it works, and says so in a line — as a model with tools for files does, of a
  // long program (2026-11-27: thirteen times of thirteen it answered with a note, and the note was taken for the program).
  const asked = [];
  let does = (cwd) => { writeText(join(cwd, "program.ts"), GOOD(5)); return "\nIN THE FILE: I changed the number in `program.ts` to 5. I didn't run the program."; };
  llm.ask = async (prompt, call) => { asked.push({ prompt, system: call.system }); return does(call.cwd); };
  llm.repair = async () => { throw new Error("no fix was to be asked for: the program is the file"); };
  await it.inHome(() => updateProject("words", "say five"));
  assert.equal(programOf("words"), GOOD(5));
  // It is told of that way — beside what it was told, of which no word is changed.
  assert.match(asked[0].system, /The program itself is what you answer with, whatever you wrote to program\.ts here\. Unless your answer is one line that begins "IN THE FILE:" and says what you did: the program is then program\.ts here, as you left it — written there, or changed where it was\.\n\n/);
  assert.match(asked[0].prompt, /^say five\n\nOutput the complete updated program\.ts\. No partial patches\. No markdown fences\. No explanation\. \(Or the one line that begins "IN THE FILE:", where the change is made in program\.ts as you left it\.\)$/);
  // So of a project's first program: there was no file, and there is one.
  await it.inHome(() => createProject("made", "say five"));
  assert.equal(programOf("made"), GOOD(5));
  assert.match(asked[1].prompt, /^say five\n\nOutput ONLY the TypeScript program\. No markdown fences\. No explanation\. \(Or the one line that begins "IN THE FILE:", where the program is in program\.ts as you left it\.\)$/);
  // Any other answer is the program, whatever was done to the file: a draft tried in place is not what was handed over.
  does = (cwd) => { writeText(join(cwd, "program.ts"), GOOD(6)); return "```ts\n" + GOOD(7) + "```\n"; };
  await it.inHome(() => updateProject("words", "say seven"));
  assert.equal(programOf("words").trim(), GOOD(7).trim());
  // (Nor is a program that speaks of the words an answer that begins with them.)
  does = (cwd) => { writeText(join(cwd, "program.ts"), GOOD(6)); return "// IN THE FILE: is how an agent says where the program is.\n" .replace(/^/, GOOD(8)); };
  await it.inHome(() => updateProject("words", "say eight, and of the words"));
  assert.equal(programOf("words").trim(), (GOOD(8) + "// IN THE FILE: is how an agent says where the program is.").trim());
  does = (cwd) => { writeText(join(cwd, "program.ts"), GOOD(6)); return "```ts\n" + GOOD(7) + "```\n"; };
  await it.inHome(() => updateProject("words", "say seven again"));
  // It says so of a file that is as it was, or is not there, or has nothing in it: no update, and said in words — nothing is validated.
  const validations = () => it.journals("words").filter((journal) => journal[0].purpose === "validate").length;
  const before = validations();
  does = () => "IN THE FILE: I changed it.";
  await assert.rejects(it.inHome(() => updateProject("words", "say eight")), /The project asked for the update failed: [^]*The model said that the change is made in program\.ts, and that file is as it was\./);
  does = (cwd) => { writeText(join(cwd, "program.ts"), "  \n"); return "IN THE FILE: I emptied it."; };
  await assert.rejects(it.inHome(() => updateProject("words", "say nothing")), /The model said that the program is in program\.ts, and there is none there\./);
  does = () => "IN THE FILE: it is written.";
  await assert.rejects(it.inHome(() => createProject("unmade", "say nine")), /The model said that the program is in program\.ts, and there is none there\./);
  assert.deepEqual([validations(), existsSync(it.at("unmade")), programOf("words").trim()], [before, false, GOOD(7).trim()]);
  // An answer that says there is none is that, whatever was done to the file.
  does = (cwd) => { writeText(join(cwd, "program.ts"), GOOD(9)); return "NO PROGRAM: it cannot be said."; };
  await assert.rejects(it.inHome(() => updateProject("words", "say what cannot be said")), /It was said that there is none to be written: it cannot be said\.$/);
  // Where nothing made beside the program is kept, the file that is the program is the program all the same.
  writeJson(join(it.fakeHome, ".trama", "config.json"), { maxRepairAttempts: 1, agentChanges: "discard" });
  does = (cwd) => { writeText(join(cwd, "program.ts"), GOOD(10)); writeText(join(cwd, "beside.txt"), "x"); return "IN THE FILE: done."; };
  await it.inHome(() => updateProject("words", "say ten"));
  assert.deepEqual([programOf("words"), existsSync(join(it.at("words"), "beside.txt"))], [GOOD(10), false]);
  assert.match(asked.at(-1).system, /Nothing you write here is kept — only the program you answer with\. Unless your answer is one line that begins "IN THE FILE:"/);
  writeJson(join(it.fakeHome, ".trama", "config.json"), { maxRepairAttempts: 1 });

  // The fixer the same: the agent fixes the file where it works and says so in a line.
  const BROKEN = `import { ctx } from "@trama-dev/runtime";\nthrow new Error("the answer is not known");\n`;
  it.project("fails", BROKEN);
  const fixes = [];
  let fixing = (cwd) => { writeText(join(cwd, "program.ts"), GOOD(11)); return "IN THE FILE: I fixed the typo in `program.ts`. I haven't re-run the program."; };
  llm.repair = async (prompt, call) => { fixes.push(prompt); return fixing(call.cwd); };
  const fixed = await it.inHome(() => runProgram({ projectDir: it.at("fails"), timeout: 30_000 }));
  assert.deepEqual([fixed.status, fixed.result, programOf("fails")], ["done", { n: 11 }, GOOD(11)]);
  assert.match(fixes[0], /\n\nOutput ONLY the fixed program: the whole of it, also where it is the project that needed fixing\. No explanation\. \(Or, where you fixed program\.ts where it is, one line that begins "IN THE FILE:" and says what was wrong: the fixed program is then that file as you left it\.\)$/);
  // Any other answer is the fix, whatever was done to the file.
  writeText(join(it.at("fails"), "program.ts"), BROKEN);
  fixing = (cwd) => { writeText(join(cwd, "program.ts"), GOOD(12)); return "```ts\n" + GOOD(13) + "```"; };
  assert.deepEqual((await it.inHome(() => runProgram({ projectDir: it.at("fails"), timeout: 30_000 }))).result, { n: 13 });
  // Said of a file that is as it was, with nothing else changed: no fix — as the runner says it of any.
  writeText(join(it.at("fails"), "program.ts"), BROKEN);
  fixing = () => "IN THE FILE: it is fixed.";
  assert.match((await it.inHome(() => runProgram({ projectDir: it.at("fails"), timeout: 30_000 }))).reason, /The repair returned the program unchanged, and changed nothing else in the project\./);
  // ...and a fix where what was wrong was in the project, and the program is as it was.
  const NEEDS = `import { ctx, tools } from "@trama-dev/runtime";\nawait ctx.done({ said: (await tools.read("data.txt")).trim() });\n`;
  it.project("needs", NEEDS);
  fixing = (cwd) => { writeText(join(cwd, "data.txt"), "there now\n"); return "IN THE FILE: data.txt was missing; program.ts needed no change."; };
  const beside = await it.inHome(() => runProgram({ projectDir: it.at("needs"), timeout: 30_000 }));
  assert.deepEqual([beside.status, beside.result, programOf("needs")], ["done", { said: "there now" }, NEEDS]);
  // An answer that says there is no fix is that, whatever was done to the file: nothing of it is tried, or kept.
  writeText(join(it.at("fails"), "program.ts"), BROKEN);
  fixing = (cwd) => { writeText(join(cwd, "program.ts"), GOOD(14)); return "NO FIX: the answer is nowhere to be had."; };
  const none = await it.inHome(() => runProgram({ projectDir: it.at("fails"), timeout: 30_000 }));
  assert.match(none.reason, /No fix came back: It was said that there is none to be had: the answer is nowhere to be had\.$/);
  assert.equal(programOf("fails"), BROKEN);
});

test("where a later runtime comes with another writer than the one among the user's projects, it is said once — whether the user's is as it came, and what to do — and the user's is left as it is, and is who writes", async (t) => {
  const it = scene(t);
  llm.ask = async () => GOOD(1);
  const NOTES = join(it.fakeHome, ".trama", "came-with.json");
  const version = readJson(join(REPO_ROOT, "packages", "runtime", "package.json")).version;
  const said = async (name) => (await it.heard(() => createProject(name, "say a number"))).said.filter((line) => /comes with another/.test(line));
  await it.inHome(() => createProject("one", "say a number"));
  // On record, beside the projects: what was put there, and by which runtime — the mark of its files.
  const came = { runtime: version, mark: ownMark("program-writer") };
  assert.deepEqual(readJson(NOTES), { "program-writer": { came, seen: came } });
  // (The mark is of what the program does: a README of the user's own, and a package.json written over, make it no
  // other. A file of it that is gone does — and is told from one with nothing in it.)
  writeText(join(it.at("program-writer"), "README.md"), "mine\n");
  writeJson(join(it.at("program-writer"), "package.json"), { type: "module", name: "mine" });
  assert.equal(ownMark("program-writer", it.at("program-writer")), came.mark);
  const apart = makeTempDir("trama-mark-");
  t.after(() => cleanupTempDir(apart));
  cpSync(it.at("program-writer"), apart, { recursive: true });
  rmSync(join(apart, "example-programs.txt"));
  const gone = ownMark("program-writer", apart);
  writeText(join(apart, "example-programs.txt"), "");
  assert.equal(new Set([came.mark, gone, ownMark("program-writer", apart)]).size, 3);
  // Nothing more is said while the runtime is the one that was last looked under — whatever is done to the project.
  writeText(join(it.at("program-writer"), "program.ts"), BY_LENGTH);
  assert.deepEqual(await said("two"), []);
  assert.notEqual(ownMark("program-writer", it.at("program-writer")), came.mark);

  // As an earlier runtime left things: the copy as it came then, untouched since — and this runtime comes with another.
  const earlier = { runtime: "0.0.1", mark: ownMark("program-writer", it.at("program-writer")) };
  writeJson(NOTES, { "program-writer": { came: earlier, seen: earlier } });
  const told = await said("three");
  assert.equal(told.length, 1, told.join("\n"));
  assert.match(told[0], new RegExp(`^\\[trama\\] program-writer among your projects \\(.*/\\.trama/projects/program-writer\\) is as it came with trama 0\\.0\\.1, and trama ${version.replace(/\./g, "\\.")} comes with another \\(.*/programs/program-writer\\)\\. Yours is still the one that writes a project's program: to have the new one, move yours away — it is put there anew\\.$`));
  // The user's is who wrote, and is as it was. And it is said once: looked at under this runtime, from here on.
  assert.deepEqual([readFileSync(join(it.at("three"), "program.ts"), "utf-8"), readFileSync(join(it.at("program-writer"), "program.ts"), "utf-8")], [GOOD(12), BY_LENGTH]);
  assert.deepEqual(readJson(NOTES), { "program-writer": { came: earlier, seen: came } });
  assert.deepEqual(await said("four"), []);

  // Changed by the user since it came: said as that.
  const other = { runtime: "0.0.1", mark: "the mark of other files" };
  writeJson(NOTES, { "program-writer": { came: other, seen: other } });
  const changed = await said("five");
  assert.equal(changed.length, 1, changed.join("\n"));
  assert.match(changed[0], new RegExp(`^\\[trama\\] trama ${version.replace(/\./g, "\\.")} comes with another program-writer \\(.*/programs/program-writer\\) than the one among your projects \\(.*/\\.trama/projects/program-writer\\), which is not as it came\\. Yours is the one that writes a project's program, and is left as you have it\\.$`));
  // Where what this runtime comes with is what the one before came with, there is nothing new to say of.
  writeJson(NOTES, { "program-writer": { came: other, seen: { runtime: "0.0.1", mark: came.mark } } });
  assert.deepEqual(await said("six"), []);
  assert.deepEqual(readJson(NOTES)["program-writer"].seen, came);
  // With no note of it (the file gone), one that is not the runtime's own is said to be not as it came, once; nothing is noted as come.
  rmSync(NOTES);
  assert.equal((await said("seven")).length, 1);
  assert.deepEqual([readJson(NOTES), await said("eight")], [{ "program-writer": { seen: came } }, []]);
  // Moved away, it is put there anew, as this runtime has it — and noted so; the one moved away is a project still.
  renameSync(it.at("program-writer"), it.at("writer-of-mine"));
  await it.inHome(() => createProject("nine", "say a number"));
  assert.deepEqual([filesOf(it.at("program-writer")), readJson(NOTES)], [filesOf(WRITER), { "program-writer": { came, seen: came } }]);
  await it.inHome(() => createProject("ten", "say a number", { createWith: "writer-of-mine" }));
  assert.equal(readFileSync(join(it.at("ten"), "program.ts"), "utf-8"), GOOD(12));
  // (A note that cannot be read is no note: nothing fails for it.)
  // (And one that is as this runtime has it, of which nothing is noted, is spoken of to nobody: it is noted as come.)
  writeText(NOTES, "{ not json");
  assert.deepEqual(await said("eleven"), []);
  assert.deepEqual(readJson(NOTES), { "program-writer": { came, seen: came } });
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
