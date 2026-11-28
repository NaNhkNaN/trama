import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { llm } from "./fake-llm.mjs";
import { describeProject, runProgram, updateProject } from "../packages/runtime/dist/index.js";
import { REPO_ROOT, captureConsole, cleanupTempDir, createProjectFixture, makeTempDir, readJson, runNodeCommand, wholeLines, withEnv, writeJson } from "./helpers.mjs";

// An update asked of a project, and not of pi's agent: where a call — or the configuration — names one
// (`updateWith`), the program that writes is a program like any, run with the copy of the project as its
// workspace. What the runner does round the writing is as it was: the copy, the validation, the record, what is
// installed and what is kept. (Importing the stand-in for the model means a test here fails where pi's agent is
// asked for a program, or for anything, that it did not provide.)

const quietly = (fn) => captureConsole("warn", () => captureConsole("log", fn)).then(({ result }) => result);
const SAYS = (n) => `import { ctx } from "@trama-dev/runtime";
const { add } = ctx.input.args as { add?: number };
await ctx.done({ n: ${n} + (add ?? 0) });
`;
const ONE = SAYS(1);

/**
 * A project that writes: no model in it, so that what it is handed and what becomes of what it does is all that a
 * test sees. What it does is said by the file `how.txt` of the copy it is handed ("write" without one). Run with
 * nothing to write — as a validation of it runs it — it says so and ends.
 */
const WRITER = `import { ctx, agent, workspace } from "@trama-dev/runtime";
import { appendFileSync } from "node:fs";
const { prompt, program, kept, types, copy, ...more } = ctx.input.args as any;
if (prompt === undefined) await ctx.done({ nothing: "to write" });
else {
  const how = (await workspace.read("how.txt").catch(() => "write")).trim();
  appendFileSync(process.env.SEEN_BY_WRITER!, JSON.stringify({
    how, prompt, program, kept, copy, more: Object.keys(more), pwd: (await workspace.shell("pwd")).stdout.trim(),
    knowsTheApi: typeof types === "string" && types.includes("interface Ctx"),
    files: await workspace.list("*"), inWorkspace: await workspace.read("program.ts"), meta: JSON.parse(await workspace.read("meta.json")),
  }) + "\\n");
  // (A writer that asks a model, as one would: twice.)
  if (how === "ask") for (const turn of [1, 2]) await agent.complete({ messages: [{ role: "user", content: "turn " + turn }] });
  // (A writer that rewrites what its program is held to, where it works — or takes it away.)
  if (how.startsWith("rewrite")) await workspace.write("meta.json", JSON.stringify({ ...JSON.parse(await workspace.read("meta.json")), description: "Says a word now.", returns: { word: "string" }, checkWith: "nobody" }));
  if (how === "remove") await workspace.shell("rm meta.json");
  if (how === "fail") throw new Error("the writer has a fault of its own");
  if (how === "say nothing") await ctx.done({ note: "no program here" });
  else if (how === "broken") await ctx.done({ program: 'throw new Error("no program at all");' });
  else if (how === "rewrite to fit") await ctx.done({ program: 'import { ctx } from "@trama-dev/runtime";\\nawait ctx.done({ word: "two" });\\n' });
  else {
    // What it makes beside the program, in the copy.
    await workspace.write("made-by.txt", prompt);
    await ctx.done({ program: program.replace(["n:", "1", "+"].join(" "), ["n:", "2", "+"].join(" ")).trimEnd() + "\\n// written for: " + prompt + "\\n" });
  }
}
`;
const WRITTEN = (from, prompt) => `${from.replace("n: 1 +", "n: 2 +").trimEnd()}\n// written for: ${prompt}\n`;

function homeWith(t, projects, config = { maxRepairAttempts: 0 }) {
  const fakeHome = makeTempDir("trama-update-home-"), notes = makeTempDir("trama-update-seen-");
  t.after(() => { cleanupTempDir(fakeHome); cleanupTempDir(notes); });
  writeJson(join(fakeHome, ".trama", "config.json"), config);
  const at = (name) => join(fakeHome, ".trama", "projects", name);
  for (const [name, { program, more = {}, how }] of Object.entries(projects)) {
    createProjectFixture(at(name), { programSource: program, metaInput: { prompt: `the ${name}`, args: {} } });
    if (Object.keys(more).length > 0) writeJson(join(at(name), "meta.json"), { ...readJson(join(at(name), "meta.json")), ...more });
    if (how) writeFileSync(join(at(name), "how.txt"), how);
  }
  const seen = join(notes, "seen.jsonl");
  writeFileSync(seen, "");
  const original = { ...llm };
  t.after(() => { Object.assign(llm, original); });
  const inHome = (fn) => withEnv({ HOME: fakeHome, SEEN_BY_WRITER: seen }, () => quietly(fn)).then(({ result }) => result);
  return {
    fakeHome, at, inHome,
    /** What `fn` comes to, and what was warned of meanwhile. */
    heard: (fn) => withEnv({ HOME: fakeHome, SEEN_BY_WRITER: seen }, () => captureConsole("warn", () => captureConsole("log", fn))).then(({ result, messages }) => ({ result: result.result, warned: messages })),
    seen: () => wholeLines(seen).map((line) => JSON.parse(line)),
    program: (name) => readFileSync(join(at(name), "program.ts"), "utf-8"),
    index: (name) => readFileSync(join(at(name), "history", "index.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line)).map(({ timestamp: _t, sha256: _s, contract: _c, ...line }) => line),
    lines: (name) => (existsSync(join(at(name), "history", "runs.jsonl")) ? readFileSync(join(at(name), "history", "runs.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line)) : []),
    journals: (name) => readdirSync(join(at(name), "logs", "journal")).sort().map((file) => readFileSync(join(at(name), "logs", "journal", file), "utf-8").trim().split("\n").map((line) => JSON.parse(line))),
    run: (name, options = {}) => inHome(() => runProgram({ projectDir: at(name), timeout: 60_000, ...options })),
  };
}

test("an update is asked of the project a call names: it works in the copy as its workspace, and the program it answers with is validated, recorded and installed as any update is", async (t) => {
  const it = homeWith(t, { words: { program: ONE, more: { description: "Says a number.", returns: { n: "number" } } }, writer: { program: WRITER } });
  await it.run("words");
  writeFileSync(join(it.at("words"), "notes.txt"), "a file of the project");
  assert.deepEqual(await it.inHome(() => updateProject("words", "say two", { updateWith: "writer" })), { version: 2 });

  // What the writer was handed: what is asked, the program it is to write from, whether what it makes beside it is kept,
  // the API as a program's author is shown it, and where it works — its workspace, which is a copy of the project
  // with the project's files, what the project says of itself among them.
  const [saw, ...others] = it.seen();
  assert.deepEqual(others, []);
  assert.deepEqual({ ...saw, copy: "", pwd: "", files: [], meta: null }, { how: "write", prompt: "say two", program: ONE, kept: true, copy: "", more: [], pwd: "", knowsTheApi: true, files: [], inWorkspace: ONE, meta: null });
  // (The copy is gone by now, with the update: its place is told by its name.)
  const plain = (path) => path.replace(/^\/private/, "");
  assert.equal(plain(saw.pwd), plain(saw.copy));
  assert.notEqual(plain(saw.copy), plain(realpathSync(it.at("words"))));
  assert.deepEqual([["meta.json", "notes.txt", "program.ts"].every((file) => saw.files.includes(file)), saw.meta.returns], [true, { n: "number" }]);

  // What became of its answer: the project's program, a version written from the one before — and what it made beside the program is kept with it.
  assert.equal(it.program("words"), WRITTEN(ONE, "say two"));
  assert.deepEqual(it.index("words"), [{ version: 1, reason: "found" }, { version: 2, reason: "update", parent: 1, prompt: "say two" }]);
  assert.equal(readFileSync(join(it.at("words"), "made-by.txt"), "utf-8"), "say two");
  assert.deepEqual((await it.run("words", { args: { add: 1 } })).result, { n: 3 });
  // The writing is a run of the writer's own project, which says what it was for; and the validation's record says who wrote, and what that took.
  assert.deepEqual(it.lines("writer").map((line) => [line.for, line.status, line.version]), [["update", "done", 1]]);
  const validation = it.journals("words").find((journal) => journal[0].purpose === "validate");
  assert.deepEqual(validation.filter((record) => record.kind === "written").map(({ by, used }) => [by, used]), [[it.at("writer"), { calls: 0, tokens: 0, cost: 0 }]]);
});

test("the project that writes is named for a call, or in the configuration — and writes from a version that is named, or a version kept beside the program, as pi's agent does", async (t) => {
  const it = homeWith(t, { words: { program: ONE }, writer: { program: WRITER } }, { maxRepairAttempts: 0, updateWith: "writer" });
  await it.run("words");
  // In the configuration, by its name among the user's projects.
  assert.deepEqual(await it.inHome(() => updateProject("words", "first")), { version: 2 });
  assert.equal(it.program("words"), WRITTEN(ONE, "first"));
  // For a call, by a path — and what names no project is no update.
  await assert.rejects(it.inHome(() => updateProject("words", "x", { updateWith: "nobody" })), /Update failed — the program is unchanged\.\nupdateWith names no project: there is none at .*nobody/);
  // Kept beside the program, and written from a version that is named: the writer has that version's text, in its
  // arguments and in its workspace; it is told that nothing it makes beside the program is kept, and none is.
  assert.deepEqual(await it.inHome(() => updateProject("words", "second", { updateWith: it.at("writer"), from: 1, install: false })), { version: 3 });
  const saw = it.seen().at(-1);
  assert.deepEqual([saw.prompt, saw.program, saw.inWorkspace, saw.kept], ["second", ONE, ONE, false]);
  assert.deepEqual(it.index("words")[2], { version: 3, reason: "update", parent: 1, aside: true, prompt: "second" });
  assert.deepEqual([it.program("words"), readFileSync(join(it.at("words"), "made-by.txt"), "utf-8"), it.seen().length], [WRITTEN(ONE, "first"), "first", 2]);
  assert.equal(readFileSync(join(it.at("words"), "history", "0003.ts"), "utf-8"), WRITTEN(ONE, "second"));
});

test("what comes back that is no update is said as none: a writer that failed, no program, a program that does not run — the project is as it was, and what writes is not itself fixed", async (t) => {
  for (const [how, why] of [
    ["fail", /Update failed — the program is unchanged\.\nThe project asked for the update failed: [^]*the writer has a fault of its own/],
    ["say nothing", /The project asked for the update answered with no program: its result is to be \{ program \}, the whole of the new program — or \{ unwritable \}, why there is none to be written\./],
    ["broken", /Update failed — the program is unchanged\.[^]*no program at all/],
  ]) {
    const it = homeWith(t, { words: { program: ONE, how }, writer: { program: WRITER } }, { maxRepairAttempts: how === "fail" ? 1 : 0 });
    let fixes = 0;
    llm.repair = async () => { fixes += 1; return ONE; };
    await it.run("words");
    await assert.rejects(it.inHome(() => updateProject("words", "say two", { updateWith: "writer" })), why, how);
    assert.deepEqual([it.program("words"), it.index("words").length, existsSync(join(it.at("words"), "made-by.txt")), fixes], [ONE, 1, false, 0], how);
  }
});

/** A program that has a project updated by a writer, and says what came of it. */
const ASKS = `import { ctx } from "@trama-dev/runtime";
import { updateProject } from "@trama-dev/runtime/runner";
let made: unknown, failed: string | undefined;
try { made = await updateProject("words", "say two", { updateWith: "writer", install: false }); } catch (err) { failed = String((err as Error).message); }
await ctx.done({ ...(made !== undefined && { made }), ...(failed !== undefined && { failed }) });
`;

test("an update by a project that a program asked for is that program's run's own: what the writer's model is asked is counted there, held to its budget, and on its record", async (t) => {
  const it = homeWith(t, { words: { program: ONE, how: "ask" }, writer: { program: WRITER }, asker: { program: ASKS } });
  llm.complete = async (_request, call) => { call.used({ model: "p/m", input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.1 }); return { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" }; };
  await it.run("words");
  const ran = await it.run("asker", { label: "asker" });
  assert.deepEqual(ran, { status: "done", result: { made: { version: 2 } } });
  // Counted in the run that asked — and said with the validation, by who wrote.
  assert.deepEqual(it.lines("asker").at(-1).used, { calls: 2, tokens: 200, cost: 0.2 });
  assert.deepEqual(it.journals("asker").at(-1).filter((record) => record.kind === "child").map((record) => record.purpose), ["update", "validate"]);
  assert.deepEqual(it.journals("words").find((journal) => journal[0].purpose === "validate").filter((record) => record.kind === "written").map(({ used }) => used), [{ calls: 2, tokens: 200, cost: 0.2 }]);
  assert.deepEqual(it.journals("writer").at(-1)[0].parent.run, it.journals("asker").at(-1)[0].run);
  // Held to its budget: a run that may ask a model once has a writer that is refused its second request.
  const capped = await it.run("asker", { label: "asker", budget: { calls: 1 } });
  // (Why no update came is said as the runner knows it first: nothing more may be asked of a model under that budget.)
  assert.match(capped.result.failed, /Update failed — the program is unchanged\.\nThe budget of a run this one is part of is spent: 1 of 1 calls to a model made\.$/);
  assert.deepEqual([it.index("words").length, it.lines("writer").map((line) => line.status)], [2, ["done", "failed"]]);
});

test("a project may be written by itself: the writer, asked to update the writer — what it writes is validated as any update is, and is the writer from then on", async (t) => {
  const it = homeWith(t, { words: { program: ONE }, writer: { program: WRITER } });
  await it.run("writer");
  assert.deepEqual(await it.inHome(() => updateProject("writer", "write better", { updateWith: "writer" })), { version: 2 });
  assert.equal(it.program("writer"), WRITTEN(WRITER, "write better"));
  assert.deepEqual(it.index("writer")[1], { version: 2, reason: "update", parent: 1, prompt: "write better" });
  // And it writes: as version 2 of itself.
  await it.run("words");
  assert.deepEqual(await it.inHome(() => updateProject("words", "say two", { updateWith: "writer" })), { version: 2 });
  assert.deepEqual([it.program("words"), it.lines("writer").filter((line) => line.for === "update").map((line) => line.version)], [WRITTEN(ONE, "say two"), [1, 2]]);
});

test("pi's agent, asked for an update, is told what the project says it takes and gives — where it says", async (t) => {
  const it = homeWith(t, { words: { program: ONE, more: { description: "Says a number.", parameters: { "add?": "number: what to add" }, returns: { n: "number" } } }, plain: { program: ONE } });
  const asked = [];
  llm.ask = async (_prompt, call) => { asked.push(call.system); return SAYS(2); };
  await it.inHome(() => updateProject("words", "say two"));
  await it.inHome(() => updateProject("plain", "say two"));
  assert.match(asked[0], /\n\nWhat the project says it takes and gives \(its meta\.json\): the program is held to it[^\n]*\n\{[^]*"parameters": \{\n\s+"add\?": "number: what to add"[^]*"returns": \{\n\s+"n": "number"/);
  assert.doesNotMatch(asked[1], /What the project says it takes and gives/);
});

test("a candidate that fails its validation is fixed by whoever the configuration names to fix: a project, where it names one — and not pi's agent", async (t) => {
  const SLIP = SAYS(2).replace("(add ?? 0)", "(add ?? 0).toFixd(0).length");
  const FIXER = `import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ program: (ctx.input.args as any).program.replace("toFixd", "toFixed") });\n`;
  const it = homeWith(t, { words: { program: ONE }, fixer: { program: FIXER } }, { maxRepairAttempts: 1, repairWith: "fixer" });
  let fixes = 0;
  llm.repair = async () => { fixes += 1; return SAYS(2); };
  llm.ask = async () => SLIP;
  await it.run("words");
  assert.deepEqual(await it.inHome(() => updateProject("words", "say two")), { version: 2 });
  assert.deepEqual([it.program("words"), fixes, it.lines("fixer").map((line) => [line.for, line.status])], [SLIP.replace("toFixd", "toFixed").trim(), 0, [["fix", "done"]]]);
  assert.deepEqual(it.index("words").map((line) => line.reason), ["found", "update-repair", "update"]);

  // And what that fixer asks of a model is counted with the update: in the run of the program that asked for it —
  // pi's agent once, for the program, and the fixer twice.
  const ASKING_FIXER = `import { ctx, agent } from "@trama-dev/runtime";\nfor (const turn of [1, 2]) await agent.complete({ messages: [{ role: "user", content: "turn " + turn }] });\nawait ctx.done({ program: (ctx.input.args as any).program.replace("toFixd", "toFixed") });\n`;
  const UPDATES = `import { ctx } from "@trama-dev/runtime";\nimport { updateProject } from "@trama-dev/runtime/runner";\nawait ctx.done({ made: await updateProject("words", "say two") });\n`;
  const counted = homeWith(t, { words: { program: ONE }, fixer: { program: ASKING_FIXER }, asker: { program: UPDATES } }, { maxRepairAttempts: 1, repairWith: "fixer" });
  llm.ask = async () => SLIP;
  llm.complete = async (_request, call) => { call.used({ model: "p/m", input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.1 }); return { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" }; };
  await counted.run("words");
  assert.deepEqual((await counted.run("asker", { label: "asker" })).result, { made: { version: 2 } });
  assert.deepEqual(counted.lines("asker").at(-1).used, { calls: 3, tokens: 200, cost: 0.2 });
});

test("the command line has what the API has of the archive and of what a project says: an update by a writer, from a version, kept beside the program; a version handed over as a file; a project described", async (t) => {
  const it = homeWith(t, { words: { program: ONE, more: { description: "Says a number.", parameters: { "add?": "number: what to add" }, returns: { n: "number" } } }, writer: { program: WRITER } });
  await it.run("words");
  const seen = join(it.fakeHome, "seen.jsonl");
  writeFileSync(seen, "");
  const trama = (...args) => runNodeCommand([join(REPO_ROOT, "packages", "cli", "dist", "index.js"), ...args], { cwd: it.fakeHome, env: { ...process.env, HOME: it.fakeHome, SEEN_BY_WRITER: seen } });

  // An update: by the writer that is named, kept beside the program — and then from that version, installed.
  const beside = await trama("update", "words", "say two", "--with", "writer", "--beside");
  assert.match(beside.stdout, /Version 2 of words is on record, beside its program\. Run with: trama run words --at-version 2/, beside.stderr);
  assert.deepEqual([it.program("words"), it.index("words")[1]], [ONE, { version: 2, reason: "update", parent: 1, aside: true, prompt: "say two" }]);
  const from = await trama("update", "words", "and more", "--with", "writer", "--from", "2");
  assert.match(from.stdout, /Updated words\./, from.stderr);
  assert.deepEqual([it.program("words"), it.index("words")[2]], [WRITTEN(WRITTEN(ONE, "say two"), "and more"), { version: 3, reason: "update", parent: 2, prompt: "and more" }]);
  assert.match((await trama("update", "words", "x", "--from", "two")).stderr, /--from takes a version's number: 1 and up \(got "two"\)/);

  // A version handed over, as a file — or on standard input: validated, and kept beside the program.
  writeFileSync(join(it.fakeHome, "mine.ts"), SAYS(7));
  const added = await trama("add-version", "words", "mine.ts", "--parent", "1", "--detail", "written by hand");
  assert.match(added.stdout, /Version 4 of words is on record, beside its program\. Run with: trama run words --at-version 4/, added.stderr);
  assert.deepEqual(it.index("words")[3], { version: 4, reason: "update", parent: 1, aside: true, prompt: "written by hand" });
  assert.equal(readFileSync(join(it.at("words"), "history", "0004.ts"), "utf-8"), SAYS(7));
  writeFileSync(join(it.fakeHome, "broken.ts"), 'throw new Error("no program at all");\n');
  const refused = await trama("add-version", "words", "broken.ts");
  // (What the program printed as it failed is shown first, as a validation shows it.)
  assert.match(refused.stderr, /^Error: The version is not put on record\./m);
  assert.match((await trama("add-version", "words", "nowhere.ts")).stderr, /^Error: [^\n]*nowhere\.ts/);
  assert.equal(it.index("words").length, 4);
  // And it is run by its number, and gone to.
  await trama("run", "words", "--at-version", "4", "--arg", "add=1");
  assert.deepEqual([it.lines("words").at(-1).version, it.journals("words").at(-1).find((record) => record.kind === "call" && record.endpoint === "/ctx/done").request.result], [4, { n: 8 }]);

  // A project described: for a person, and as JSON for whoever is to choose among programs — one of them, or all.
  const said = await withEnv({ HOME: it.fakeHome }, () => describeProject("words"));
  assert.deepEqual(JSON.parse((await trama("describe", "words", "--json")).stdout), said);
  assert.deepEqual(JSON.parse((await trama("describe", "--json")).stdout).map(({ name, description }) => [name, description ?? null]), [["words", "Says a number."], ["writer", null]]);
  const shown = (await trama("describe", "words")).stdout;
  assert.match(shown, /^words — Says a number\.\n  takes: \{\n[^]*"add\?": "number: what to add"[^]*\n  gives: \{\n[^]*"n": "number"/);
  assert.match((await trama("describe", "writer")).stdout, /^writer — \(it does not say what it is for\)\n  takes: \(it does not say\)\n  gives: \(it does not say\)\n$/);
});

// --- what a project says of itself is the project's ---

test("what a project says of itself is out of the reach of whoever writes its program: meta.json, rewritten in the copy a writer or a fixer worked in, is put back before the program is tried there, reaches the project in nothing — and it is said", async (t) => {
  const SAYS_OF_ITSELF = { description: "Says a number.", returns: { n: "number" } };
  const metaOf = (it, name = "words") => readFileSync(join(it.at(name), "meta.json"), "utf-8");
  const putBack = (warned) => warned.filter((line) => /\[trama\] meta\.json was changed in the copy that was worked in: it is put back as it was, and nothing of that is kept — what a project says of itself is not for whoever writes or fixes its program to change\./.test(line)).length;

  // A writer that is a project: it rewrites the contract — or takes the file away — and writes a program that fits the project's own.
  for (const [how, said] of [["write", 0], ["rewrite", 1], ["remove", 1]]) {
    const it = homeWith(t, { words: { program: ONE, more: SAYS_OF_ITSELF, how }, writer: { program: WRITER } });
    await it.run("words");
    const was = metaOf(it);
    const { result, warned } = await it.heard(() => updateProject("words", "say two", { updateWith: "writer" }));
    assert.deepEqual(result, { version: 2 }, how);
    // The project says what it said, to the letter; what else the writer made beside the program is kept as it was.
    assert.deepEqual([metaOf(it), putBack(warned), readFileSync(join(it.at("words"), "made-by.txt"), "utf-8")], [was, said, "say two"], how);
    assert.deepEqual((await it.run("words")).result, { n: 2 }, how);
    // Kept beside the program, where nothing of the copy is used: said all the same.
    if (how === "rewrite") assert.equal(putBack((await it.heard(() => updateProject("words", "again", { updateWith: "writer", install: false }))).warned), 1);
  }

  // A program that fits only what its writer made of the contract is held to the project's, and is no update.
  const fits = homeWith(t, { words: { program: ONE, more: SAYS_OF_ITSELF, how: "rewrite to fit" }, writer: { program: WRITER } });
  await fits.run("words");
  const held = metaOf(fits);
  await assert.rejects(fits.heard(() => updateProject("words", "say a word", { updateWith: "writer" })), /Update failed — the program is unchanged\.[^]*The result does not fit what [^\n]* gives — missing key: n/);
  assert.deepEqual([fits.program("words"), metaOf(fits), fits.index("words").length], [ONE, held, 1]);

  // pi's agent has tools in the copy it works in, and is held the same.
  const pi = homeWith(t, { words: { program: ONE, more: SAYS_OF_ITSELF } });
  llm.ask = async (_prompt, call) => {
    writeFileSync(join(call.cwd, "meta.json"), JSON.stringify({ input: { prompt: "p", args: {} }, returns: { word: "string" } }));
    writeFileSync(join(call.cwd, "beside.txt"), "made beside");
    return SAYS(2);
  };
  await pi.run("words");
  const before = metaOf(pi);
  const byPi = await pi.heard(() => updateProject("words", "say two"));
  assert.deepEqual([byPi.result, metaOf(pi), putBack(byPi.warned), readFileSync(join(pi.at("words"), "beside.txt"), "utf-8")], [{ version: 2 }, before, 1, "made beside"]);

  // A copy that was moved away, with a link left in its place, is not written into: nothing is put back where the link leads.
  const elsewhere = makeTempDir("trama-update-elsewhere-");
  t.after(() => cleanupTempDir(elsewhere));
  const moved = homeWith(t, { words: { program: ONE, more: SAYS_OF_ITSELF } });
  llm.ask = async (_prompt, call) => {
    renameSync(call.cwd, `${call.cwd}-moved`);
    symlinkSync(elsewhere, call.cwd);
    return SAYS(2);
  };
  await moved.run("words");
  assert.deepEqual((await moved.heard(() => updateProject("words", "say two"))).result, { version: 2 });
  assert.deepEqual(readdirSync(elsewhere), []);

  // And so of whoever fixes: what a fixer did to meta.json in the copy its fix is tried in is put back before the trial, and is no part of what is kept with the fix.
  const FIXER = `import { ctx, workspace } from "@trama-dev/runtime";
await workspace.write("meta.json", JSON.stringify({ ...JSON.parse(await workspace.read("meta.json")), returns: { word: "string" }, checkWith: "nobody" }));
await workspace.write("mended-by.txt", "the fixer");
await ctx.done({ program: (ctx.input.args as any).program.replace("toFixd", "toFixed") });
`;
  const SLIP = ONE.replace("(add ?? 0)", "(add ?? 0).toFixd(0).length");
  const fixed = homeWith(t, { words: { program: SLIP, more: SAYS_OF_ITSELF }, fixer: { program: FIXER } }, { maxRepairAttempts: 1, repairWith: "fixer" });
  const said = metaOf(fixed);
  const mended = await fixed.heard(() => runProgram({ projectDir: fixed.at("words"), timeout: 60_000 }));
  assert.deepEqual([mended.result, metaOf(fixed), putBack(mended.warned), readFileSync(join(fixed.at("words"), "mended-by.txt"), "utf-8")], [{ status: "done", result: { n: 2 } }, said, 1, "the fixer"]);
  assert.deepEqual((await fixed.run("words")).result, { n: 2 });
});
