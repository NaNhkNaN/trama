import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHash } from "crypto";
import { createServer } from "http";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { runsIn } from "../packages/runtime/dist/journal.js";
import { llm } from "./fake-llm.mjs";
import { runProgram, validateProgram } from "../packages/runtime/dist/runner.js";
import { createBackend } from "../packages/runtime/dist/runner-backend.js";
import { loadConfig } from "../packages/runtime/dist/project.js";
import {
  REPO_ROOT, captureConsole, cleanupTempDir, createProjectFixture, isAlive, makeTempDir, pidIn, runNodeCommand,
  startRunnerProcess, waitFor, withEnv, writeJson, writeText,
} from "./helpers.mjs";

const CLI_ENTRY = join(REPO_ROOT, "packages", "cli", "dist", "index.js");

// Whether runs are recorded, and how many, is configuration. These tests are
// about what gets recorded, so they run against the defaults — not against
// whatever the person running them has in their own ~/.trama/config.json.
const defaultsHome = makeTempDir("trama-journal-defaults-");
const realHome = process.env.HOME;
process.env.HOME = defaultsHome;
after(() => {
  process.env.HOME = realHome;
  cleanupTempDir(defaultsHome);
});

const journalDir = (projectDir) => join(projectDir, "logs", "journal");
const journalFiles = (projectDir) =>
  existsSync(journalDir(projectDir)) ? readdirSync(journalDir(projectDir)).sort() : [];
const readRecords = (path) => readFileSync(path, "utf-8").split("\n").filter(Boolean).map(line => JSON.parse(line));

/** The records of a project's only journal. */
function onlyJournal(projectDir) {
  const files = journalFiles(projectDir);
  assert.equal(files.length, 1, `expected one journal, found: ${JSON.stringify(files)}`);
  return readRecords(join(journalDir(projectDir), files[0]));
}

/** A call and its result, by the call's position. */
const callAt = (records, seq) => ({
  call: records.find(record => record.kind === "call" && record.seq === seq),
  result: records.find(record => record.kind === "result" && record.seq === seq),
});

test("a run is written down: what was run, each call and how it ended, the exit, the end", async (t) => {
  const projectDir = makeTempDir("trama-journal-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { ctx, tools } from "@trama-dev/runtime";
await tools.write("note.txt", "hello");
const text = await tools.read("note.txt");
await tools.read("missing.txt").catch(() => {});
console.log("printed by the program");
await ctx.done({ text });`,
  });

  const result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 20_000, args: { topic: "x" } });
  assert.equal(result.status, "done");

  const [file] = journalFiles(projectDir);
  // It holds what the program read and wrote: its owner's eyes only.
  assert.equal(statSync(join(journalDir(projectDir), file)).mode & 0o777, 0o600);

  const records = onlyJournal(projectDir);
  assert.deepEqual(records.map(record => record.kind), [
    "run", "attempt",
    "call", "result", "call", "result", "call", "result", "call", "result",
    "exit", "end",
  ]);

  const [run, attempt] = records;
  assert.equal(run.v, 1);
  assert.equal(`${run.run}.jsonl`, file, "a run is known by the name of its journal");
  assert.equal(run.purpose, "run");
  assert.deepEqual(run.args, { topic: "x" });
  assert.equal(attempt.attempt, 0);
  assert.equal(
    attempt.program.sha256,
    createHash("sha256").update(readFileSync(join(projectDir, "program.ts"))).digest("hex"),
  );

  assert.deepEqual(callAt(records, 1).call.request, { path: "note.txt", content: "hello" });
  assert.equal(callAt(records, 1).call.endpoint, "/tools/write");
  assert.equal(callAt(records, 2).result.result, "hello");
  // A call that failed is on record as having failed, with why.
  assert.equal(callAt(records, 3).result.ok, false);
  assert.match(callAt(records, 3).result.error, /File not found: missing\.txt/);
  assert.deepEqual(callAt(records, 4).call.request, { state: {}, result: { text: "hello" } });

  const exit = records.at(-2);
  assert.equal(exit.code, 0);
  assert.equal(exit.stdout, "printed by the program\n");
  assert.deepEqual(records.at(-1).result, { status: "done", result: { text: "hello" } });
  // Every record says when, counted from the start of the run.
  assert.equal(records.every((record, i) => Number.isInteger(record.at) && (i === 0 || record.at >= records[i - 1].at)), true);
});

test("a repair is one run in one journal — the failure, the fix asked for and returned, and the attempt that tried it", async (t) => {
  const projectDir = makeTempDir("trama-journal-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { tools } from "@trama-dev/runtime";
await tools.write("before-the-crash.txt", "x");
throw new Error("the original fails");`,
  });

  const fixes = [
    // The first fix fails too. It runs on a copy of the project that is then thrown away;
    // what it did must be on record all the same.
    `import { tools } from "@trama-dev/runtime";
await tools.write("from-the-first-fix.txt", "y");
throw new Error("the first fix fails");`,
    `import { ctx } from "@trama-dev/runtime";
await ctx.done({ fixed: true });`,
  ];
  const originalRepair = llm.repair;
  llm.repair = async () => fixes.shift();

  try {
    const result = await runProgram({ projectDir, maxRepairAttempts: 3, timeout: 20_000 });
    assert.deepEqual(result, { status: "done", result: { fixed: true } });
  } finally {
    llm.repair = originalRepair;
  }

  const records = onlyJournal(projectDir);
  assert.deepEqual(records.filter(record => record.kind !== "call" && record.kind !== "result").map(record => record.kind), [
    "run", "attempt", "exit", "fix-request", "fix", "attempt", "exit", "fix-request", "fix", "attempt", "exit", "end",
  ]);
  assert.deepEqual(records.filter(record => record.kind === "attempt").map(record => record.attempt), [0, 1, 2]);
  assert.deepEqual(records.filter(record => record.kind === "exit").map(record => record.outcome?.status ?? null), [null, null, "done"]);

  const [firstRequest, secondRequest] = records.filter(record => record.kind === "fix-request");
  assert.match(firstRequest.error, /the original fails/);
  assert.match(secondRequest.error, /the first fix fails/);
  const [firstFix] = records.filter(record => record.kind === "fix");
  assert.match(firstFix.source, /from-the-first-fix\.txt/, "the fix that was returned is on record, though it was never installed");

  // What the failed fix did: on record, and nowhere in the project.
  const written = records.filter(record => record.kind === "call").map(record => record.request.path);
  assert.deepEqual(written.filter(Boolean), ["before-the-crash.txt", "from-the-first-fix.txt"]);
  assert.equal(existsSync(join(projectDir, "from-the-first-fix.txt")), false);
  // A fix is tried somewhere else, and the journal says where.
  const [original, firstTrial] = records.filter(record => record.kind === "attempt");
  assert.equal(original.dir, projectDir);
  assert.notEqual(firstTrial.dir, projectDir);
});

test("the journals of a program and of a run it asked for point at each other", async (t) => {
  const entryDir = makeTempDir("trama-journal-entry-");
  const workerDir = makeTempDir("trama-journal-worker-");
  const wsDir = makeTempDir("trama-journal-ws-");
  t.after(() => { cleanupTempDir(entryDir); cleanupTempDir(workerDir); cleanupTempDir(wsDir); });

  createProjectFixture(workerDir, {
    programSource: `import { ctx, workspace } from "@trama-dev/runtime";
await workspace.write("from-worker.txt", "hi");
await ctx.done();`,
  });
  createProjectFixture(entryDir, {
    scaffold: false,
    programSource: `import { ctx } from "@trama-dev/runtime";
import { createWorkspace, runProgram } from "@trama-dev/runtime/runner";
const shared = createWorkspace(${JSON.stringify(wsDir)});
const result = await runProgram({ projectDir: ${JSON.stringify(workerDir)}, workspaceDir: ${JSON.stringify(wsDir)}, label: "scout", maxRepairAttempts: 0, timeout: 20000 });
const seen = await shared.read("from-worker.txt");
await ctx.done({ worker: result.status, seen });`,
  });

  const result = await runProgram({ projectDir: entryDir, maxRepairAttempts: 0, timeout: 30_000 });
  assert.deepEqual(result.result, { worker: "done", seen: "hi" });

  const parent = onlyJournal(entryDir);
  const child = onlyJournal(workerDir);

  const asked = parent.find(record => record.kind === "call" && record.endpoint === "/run/program");
  assert.equal(asked.request.projectDir, workerDir);
  const started = parent.find(record => record.kind === "child");
  assert.equal(started.seq, asked.seq, "the parent's journal says which call started the run");
  assert.equal(started.run, child[0].run);
  assert.equal(started.journal, realpathSync(join(journalDir(workerDir), journalFiles(workerDir)[0])));
  assert.deepEqual(callAt(parent, asked.seq).result.result, { status: "done" });

  assert.deepEqual(child[0].parent, {
    run: parent[0].run,
    journal: realpathSync(join(journalDir(entryDir), journalFiles(entryDir)[0])),
    seq: asked.seq,
  });
  assert.equal(child[0].label, "scout");
  assert.equal(child[0].depth, 1);
  // A program that has a workspace by its directory reaches it through the bridge, so that is on record too.
  const read = parent.find(record => record.kind === "call" && record.endpoint === "/workspace/read");
  assert.deepEqual(read.request, { dir: wsDir, path: "from-worker.txt" });
});

test("what is too long to keep is cut short, and says how long it was", async (t) => {
  const projectDir = makeTempDir("trama-journal-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { ctx, tools } from "@trama-dev/runtime";
await tools.write("big.txt", "a".repeat(1_000_000));
await ctx.done();`,
  });

  await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 20_000 });

  const records = onlyJournal(projectDir);
  const { request, cuts } = callAt(records, 1).call;
  // Its beginning is in its place; that it was cut, and what was there, is noted beside the record's values.
  assert.equal(request.content, "a".repeat(256 * 1024));
  assert.deepEqual(cuts, [{
    path: ["request", "content"],
    cut: "text",
    length: 1_000_000,
    sha256: createHash("sha256").update("a".repeat(1_000_000)).digest("hex"),
  }]);
  assert.equal(callAt(records, 1).result.cuts, undefined, "a record that lost nothing says nothing");
  assert.ok(statSync(join(journalDir(projectDir), journalFiles(projectDir)[0])).size < 400_000);
  // The file itself is whole: only the record of it is shortened.
  assert.equal(readFileSync(join(projectDir, "big.txt"), "utf-8").length, 1_000_000);
});

test("credentials in the headers of a web request are left out of the journal", async (t) => {
  const projectDir = makeTempDir("trama-journal-");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Set-Cookie": "session=secret-from-the-server", "Content-Type": "text/plain" });
    res.end("body from the server");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { cleanupTempDir(projectDir); server.close(); });

  // Headers given as an object, and — as fetch also takes them — as a list of pairs.
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { ctx, tools } from "@trama-dev/runtime";
const url = "http://127.0.0.1:${server.address().port}/thing";
await tools.fetch(url, {
  headers: { Authorization: "Bearer secret-from-the-program", "X-Api-Key": "another-secret", Accept: "text/plain" },
});
await tools.fetch(url, {
  headers: [["X-Auth", "secret-in-a-pair"], ["Ocp-Apim-Subscription-Key", "secret-subscription"], ["X-RateLimit-Remaining-Tokens", "42"]],
});
await ctx.done();`,
  });

  await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 20_000 });

  const records = onlyJournal(projectDir);
  const { call, result } = callAt(records, 1);
  assert.deepEqual(call.request.headers, { Authorization: "[redacted]", "X-Api-Key": "[redacted]", Accept: "text/plain" });
  assert.equal(result.result.headers["set-cookie"], "[redacted]");
  assert.equal(result.result.headers["content-type"], "text/plain");
  assert.equal(result.result.body, "body from the server");
  assert.deepEqual(callAt(records, 2).call.request.headers, [
    ["X-Auth", "[redacted]"],
    ["Ocp-Apim-Subscription-Key", "[redacted]"],
    // Counts tokens; carries none.
    ["X-RateLimit-Remaining-Tokens", "42"],
  ]);
  const text = readFileSync(join(journalDir(projectDir), journalFiles(projectDir)[0]), "utf-8");
  assert.doesNotMatch(text, /secret-/);
  assert.doesNotMatch(text, /another-secret/);
});

test("the bridge's own secret is not in the journal", async (t) => {
  const projectDir = makeTempDir("trama-journal-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { ctx, tools } from "@trama-dev/runtime";
import { readFileSync } from "fs";
await tools.write("token.txt", JSON.parse(readFileSync(process.env.TRAMA_INIT, "utf-8")).token);
await ctx.done();`,
  });

  await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 20_000 });

  // (The program wrote it to a file itself, and that call is recorded like any other;
  // the check is that nothing else in the journal carries it.)
  const token = readFileSync(join(projectDir, "token.txt"), "utf-8");
  const records = onlyJournal(projectDir).filter(record => !(record.kind === "call" && record.seq === 1));
  assert.equal(JSON.stringify(records).includes(token), false);
});

test("a project keeps the journals of its latest runs only, as many as it is configured to", async (t) => {
  const fakeHome = makeTempDir("trama-journal-home-");
  const projectDir = makeTempDir("trama-journal-");
  t.after(() => { cleanupTempDir(fakeHome); cleanupTempDir(projectDir); });
  createProjectFixture(projectDir, { scaffold: false });

  const run = () => runProgram({ projectDir, maxRepairAttempts: 0, timeout: 20_000 });
  await withEnv({ HOME: fakeHome }, async () => {
    writeJson(join(fakeHome, ".trama", "config.json"), { journalRuns: 2 });
    await run();
    const [first] = journalFiles(projectDir);
    await run();
    await run();
    const kept = journalFiles(projectDir);
    assert.equal(kept.length, 2);
    assert.equal(kept.includes(first), false, "the oldest journal makes room for the newest");

    // Zero: nothing is recorded, and what was is left alone.
    writeJson(join(fakeHome, ".trama", "config.json"), { journalRuns: 0 });
    await run();
    assert.deepEqual(journalFiles(projectDir), kept);
  });
});

test("a journal that cannot be written does not get in the way of the run", async (t) => {
  const projectDir = makeTempDir("trama-journal-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { scaffold: false });
  // Something that is not a directory, where the journals would go.
  writeText(join(projectDir, "logs", "journal"), "in the way");

  let result;
  const { messages } = await captureConsole("warn", async () => {
    result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 20_000 });
  });
  assert.equal(result.status, "done");
  assert.equal(messages.filter(message => /not being recorded/.test(message)).length, 1, "it should say so, once");
  assert.equal(readFileSync(join(projectDir, "logs", "journal"), "utf-8"), "in the way");
});

test("journals that cannot be listed are not added to without saying so", { skip: process.getuid?.() === 0 }, async (t) => {
  const { chmodSync } = await import("fs");
  const projectDir = makeTempDir("trama-journal-");
  t.after(() => { chmodSync(journalDir(projectDir), 0o700); cleanupTempDir(projectDir); });
  createProjectFixture(projectDir, { scaffold: false });
  await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 20_000 });

  // Writable, but its contents cannot be listed: older journals could never be made room among.
  chmodSync(journalDir(projectDir), 0o300);
  let result;
  const { messages } = await captureConsole("warn", async () => {
    result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 20_000 });
  });
  chmodSync(journalDir(projectDir), 0o700);
  assert.equal(result.status, "done");
  assert.equal(messages.filter(message => /not being recorded/.test(message)).length, 1);
  assert.equal(journalFiles(projectDir).length, 1, "nothing was added that nothing would ever remove");
});

test("a record is about as big as it is allowed to be, whatever is put in it", async (t) => {
  const { openJournal } = await import("../packages/runtime/dist/journal.js");
  const projectDir = makeTempDir("trama-journal-");
  t.after(() => cleanupTempDir(projectDir));

  const journal = openJournal(projectDir, 5, { purpose: "test" });
  // Half a million short texts: none is long, together they are far too much.
  const many = Object.fromEntries(Array.from({ length: 500_000 }, (_, i) => [`key${i}`, "0123456789"]));
  const started = performance.now();
  journal.note("checkpoint", { small: "kept", many, late: "not reached" });
  const took = performance.now() - started;
  // What cannot be written as JSON at all is noted as such, and the journal goes on.
  journal.note("odd", { when: new Date(0), size: 10n, raw: Buffer.from("abc") });
  const circular = {}; circular.self = circular;
  journal.call("/ctx/checkpoint", { get broken() { throw new Error("cannot be read"); } }).end({ ok: true, result: null });
  journal.note("after");
  journal.close();

  const lines = readFileSync(journal.path, "utf-8").split("\n").filter(Boolean);
  const [, checkpoint, odd, unrecordable, , after] = lines.map(line => JSON.parse(line));
  assert.ok(lines[1].length < 1_300_000, `the record is ${lines[1].length} characters`);
  assert.ok(took < 1_000, `writing it took ${Math.round(took)}ms`);
  assert.equal(checkpoint.small, "kept", "what comes first is kept");
  assert.equal(checkpoint.late, undefined);
  assert.ok(Object.keys(checkpoint.many).length < 500_000);
  // What there was no room for is said to be missing: the rest of `many`, and the rest of the record.
  // (The last text that went in may itself have been cut where the room ran out.)
  assert.deepEqual(checkpoint.cuts.filter(cut => cut.cut === "object"), [{ path: ["many"], cut: "object" }, { path: [], cut: "object" }]);
  assert.ok(checkpoint.cuts.length <= 3, `${checkpoint.cuts.length} cuts noted`);

  assert.equal(odd.when, "1970-01-01T00:00:00.000Z");
  assert.equal(odd.size, "10");
  assert.equal(odd.raw, null);
  assert.deepEqual(odd.cuts, [{ path: ["raw"], cut: "bytes", length: 3 }]);
  assert.match(unrecordable.unrecordable, /cannot be read/);
  assert.equal(after.kind, "after", "one record that could not be written does not end the journal");
});

test("no shape of value gets a record past its size, and none can pass for a note of what was cut", async (t) => {
  const { openJournal } = await import("../packages/runtime/dist/journal.js");
  const projectDir = makeTempDir("trama-journal-");
  t.after(() => cleanupTempDir(projectDir));

  const journal = openJournal(projectDir, 5, { purpose: "test" });
  // Things that are nearly nothing each, and a name that is far too much on its own.
  journal.note("empties", { list: Array.from({ length: 3_000_000 }, () => []) });
  journal.note("name", { ["k".repeat(5_000_000)]: 1 });
  // A name too long to record is passed over; what comes after it is still taken down.
  journal.note("long name", { ["n".repeat(5_000)]: 1, after: "kept" });
  // A long name above a deep value that runs out of room: the name must not come back in every note.
  let deep = { text: "s".repeat(2_000_000), late: 1 };
  for (let i = 0; i < 10; i++) deep = { a: deep, late: 1 };
  journal.note("deep", { data: { ["k".repeat(1_000)]: deep, late: 1 } });
  journal.note("binary", { list: Array.from({ length: 200_000 }, () => Buffer.alloc(4)) });
  // A value shaped like the runtime's own notes is a value like any other.
  journal.note("lookalike", { request: { cut: "text", path: ["request"], length: 9, clipped: "mine" } });
  journal.close();

  const lines = readFileSync(journal.path, "utf-8").split("\n").filter(Boolean).slice(1);
  for (const line of lines) assert.ok(line.length < 1_300_000, `a record of ${line.length} characters`);
  const [empties, name, longName, , binary, lookalike] = lines.map(line => JSON.parse(line));
  assert.deepEqual({ after: longName.after, cuts: longName.cuts }, { after: "kept", cuts: [{ path: [], cut: "object" }] });
  assert.deepEqual(empties.cuts, [{ path: ["list"], cut: "list", length: 3_000_000 }]);
  assert.deepEqual(name.cuts, [{ path: [], cut: "object" }], "a field goes in with its name, or not at all");
  assert.deepEqual(binary.cuts.at(-1), { path: ["list"], cut: "list", length: 200_000 });
  assert.deepEqual(lookalike.request, { cut: "text", path: ["request"], length: 9, clipped: "mine" });
  assert.equal(lookalike.cuts, undefined, "nothing was cut, and the record says so by saying nothing");
});

test("a record goes twelve names into what it is given and no further: a list or an object that deep is left out, and said to be", async (t) => {
  const { openJournal } = await import("../packages/runtime/dist/journal.js");
  const projectDir = makeTempDir("trama-journal-");
  t.after(() => cleanupTempDir(projectDir));
  /** A value under so many names, the field's own being the first. */
  const under = (names, value) => { for (let name = 1; name < names; name += 1) value = { in: value }; return value; };
  const way = (field, names) => [field, ...Array(names - 1).fill("in")];

  const journal = openJournal(projectDir, 5, { purpose: "test" });
  journal.note("deep", {
    // Under eleven names a list is a list, and what is in it is under twelve: text and numbers are kept there...
    kept: under(11, ["text", 7, null]),
    words: under(12, "the innermost"),
    // ...and a list or an object is not, be it empty: the record says nothing was there, and beside it what was.
    list: under(12, [1, 2]),
    object: under(12, {}),
    among: under(11, ["text", { lost: true }, 7]),
    far: under(40, "far too deep"),
  });
  journal.close();

  const [, record] = readFileSync(journal.path, "utf-8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const at = (value, names) => { for (let name = 1; name < names; name += 1) value = value.in; return value; };
  assert.deepEqual(at(record.kept, 11), ["text", 7, null]);
  assert.equal(at(record.words, 12), "the innermost");
  assert.equal(at(record.list, 12), null);
  assert.equal(at(record.object, 12), null);
  assert.deepEqual(at(record.among, 11), ["text", null, 7]);
  assert.equal(at(record.far, 12), null);
  assert.deepEqual(record.cuts, [
    { path: way("list", 12), cut: "depth" },
    { path: way("object", 12), cut: "depth" },
    { path: [...way("among", 11), 1], cut: "depth" },
    { path: way("far", 12), cut: "depth" },
  ]);
});

test("a journal that is still being written is never the one to make room", async (t) => {
  const fakeHome = makeTempDir("trama-journal-home-");
  const projectDir = makeTempDir("trama-journal-");
  t.after(() => { cleanupTempDir(fakeHome); cleanupTempDir(projectDir); });

  // A program that runs its own project three more times, one inside the
  // other. All four runs are going at once, in a project that keeps two.
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { ctx } from "@trama-dev/runtime";
import { runProgram } from "@trama-dev/runtime/runner";
const depth = ctx.input.args.depth ?? 0;
if (depth < 3) await runProgram({ projectDir: process.cwd(), args: { depth: depth + 1 }, maxRepairAttempts: 0, timeout: 30000 });
await ctx.done();`,
  });

  await withEnv({ HOME: fakeHome }, async () => {
    writeJson(join(fakeHome, ".trama", "config.json"), { journalRuns: 2 });
    const result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 30_000 });
    assert.equal(result.status, "done");

    // Nothing was removed from under a run: all four are whole, and each child's parent is there.
    const journals = journalFiles(projectDir).map(name => readRecords(join(journalDir(projectDir), name)));
    assert.equal(journals.length, 4);
    for (const records of journals) {
      assert.equal(records.at(-1).kind, "end");
      if (records[0].parent) assert.equal(existsSync(records[0].parent.journal), true);
    }

    // Once they are over they make room like any others.
    await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 30_000, args: { depth: 3 } });
    assert.equal(journalFiles(projectDir).length, 2);
  });
});

test("a validation is recorded with the project, though it runs in a copy that is thrown away", async (t) => {
  const projectDir = makeTempDir("trama-journal-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { scaffold: false });

  const candidate = `import { ctx, tools } from "@trama-dev/runtime";
await tools.write("made-while-validating.txt", "x");
await ctx.done();`;
  await validateProgram(projectDir, createBackend(loadConfig()), candidate, {
    timeout: 20_000, maxRepairAttempts: 0, journalRuns: 5,
  });

  const records = onlyJournal(projectDir);
  assert.equal(records[0].purpose, "validate");
  assert.equal(callAt(records, 1).call.request.path, "made-while-validating.txt");
  assert.equal(records.at(-1).result.status, "done");
  assert.equal(existsSync(join(projectDir, "made-while-validating.txt")), false);
});

test("a validation that cannot be carried out is on record as that, and so is a program that leaves its state unusable", async (t) => {
  const projectDir = makeTempDir("trama-journal-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { scaffold: false });

  // The candidate prints something, wrecks its state file and exits badly.
  const candidate = `import { writeFileSync } from "fs";
console.log("last words");
writeFileSync("state.json", "{ not json");
process.exit(3);`;
  await assert.rejects(
    validateProgram(projectDir, createBackend(loadConfig()), candidate, {
      timeout: 20_000, maxRepairAttempts: 0, journalRuns: 5,
    }),
    /Corrupt state\.json/,
  );

  const records = onlyJournal(projectDir);
  assert.deepEqual(records.map(record => record.kind), ["run", "attempt", "exit", "end"]);
  const [, , exit, end] = records;
  assert.equal(exit.code, 3);
  assert.equal(exit.stdout, "last words\n");
  assert.match(exit.error, /Corrupt state\.json/);
  assert.match(end.error, /Corrupt state\.json/);
});

test("a validation that ends at a hand-off is on record as that: the call, never answered, and the stop", async (t) => {
  const projectDir = makeTempDir("trama-journal-");
  const participantDir = makeTempDir("trama-journal-participant-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(participantDir); });
  createProjectFixture(projectDir, { scaffold: false });
  createProjectFixture(participantDir, { scaffold: false });

  const candidate = `import { runProgram } from "@trama-dev/runtime/runner";
import { resolve } from "path";
await runProgram({ projectDir: ${JSON.stringify(participantDir)}, workspaceDir: resolve("workspace"), label: "p" });`;
  await validateProgram(projectDir, createBackend(loadConfig()), candidate, {
    timeout: 20_000, maxRepairAttempts: 0, journalRuns: 5,
  });

  const records = onlyJournal(projectDir);
  const asked = records.find(record => record.endpoint === "/run/program");
  assert.equal(asked.request.label, "p");
  assert.equal(records.some(record => record.kind === "result" && record.seq === asked.seq), false, "nobody answered it");
  assert.equal(records.some(record => record.kind === "child"), false, "and no run was started");
  const exit = records.find(record => record.kind === "exit");
  assert.equal(exit.validated, "hand-off");
  assert.deepEqual(exit.outcome, { status: "done" });
  assert.deepEqual(journalFiles(participantDir), [], "the participant was not run, so has nothing on record");
});

test("what comes back for a program that is gone is not recorded as an answer", async (t) => {
  const projectDir = makeTempDir("trama-journal-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { tools } from "@trama-dev/runtime";
await tools.shell("sleep 30", { timeout: 60000 });`,
  });

  // The program times out with a shell command in flight. Stopping the command
  // makes it return — to nobody.
  const result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 1_500 });
  assert.match(result.reason, /timeout/);

  const records = onlyJournal(projectDir);
  const shell = records.find(record => record.endpoint === "/tools/shell");
  assert.equal(records.some(record => record.kind === "result" && record.seq === shell.seq), false);
  assert.equal(records.find(record => record.kind === "exit").timedOut, true);
  assert.equal(records.at(-1).kind, "end");
});

test("the journal of a run whose runner was killed stops where the runner did", async (t) => {
  const fakeHome = makeTempDir("trama-journal-home-");
  const projectDir = makeTempDir("trama-journal-");
  t.after(() => { cleanupTempDir(fakeHome); cleanupTempDir(projectDir); });

  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { tools } from "@trama-dev/runtime";
import { writeFileSync } from "fs";
await tools.write("done-before.txt", "x");
writeFileSync("program.pid", String(process.pid));
await tools.shell("sleep 60", { timeout: 60000 });`,
  });

  const { child, exited } = startRunnerProcess(fakeHome, projectDir);
  await waitFor(() => pidIn(join(projectDir, "program.pid")), "the program to start");
  const programPid = pidIn(join(projectDir, "program.pid"));
  await waitFor(() => journalFiles(projectDir).length === 1 && onlyJournal(projectDir).some(record => record.endpoint === "/tools/shell"), "the shell command to be on record");
  child.kill("SIGKILL");
  await exited;
  await waitFor(() => !isAlive(programPid), "the program to be stopped", 5_000);

  const records = onlyJournal(projectDir);
  // True up to its last line: the call that was answered, the call that never was, and no end.
  assert.equal(callAt(records, 1).result.ok, true);
  const shell = records.find(record => record.endpoint === "/tools/shell");
  assert.equal(records.some(record => record.kind === "result" && record.seq === shell.seq), false);
  assert.equal(records.some(record => record.kind === "end" || record.kind === "exit"), false);
});

test("`trama journal` shows a run call by call, lists the runs on record, and says so when there is none", async (t) => {
  const fakeHome = makeTempDir("trama-journal-home-");
  t.after(() => cleanupTempDir(fakeHome));
  const projects = join(fakeHome, ".trama", "projects");
  createProjectFixture(join(projects, "quiet"), { scaffold: false });
  createProjectFixture(join(projects, "busy"), {
    scaffold: false,
    programSource: `import { ctx, tools } from "@trama-dev/runtime";
await tools.write("note.txt", "hello");
await tools.read("missing.txt").catch(() => {});
await ctx.done();`,
  });

  const trama = (...args) => runNodeCommand([CLI_ENTRY, ...args], { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome } });

  writeJson(join(fakeHome, ".trama", "config.json"), {}); // the defaults, whoever runs this
  assert.match((await trama("journal", "quiet")).stdout, /No runs have been recorded/);

  assert.equal((await trama("run", "busy")).exitCode, 0);
  const shown = await trama("journal", "busy");
  assert.equal(shown.exitCode, 0, shown.stderr);
  assert.match(shown.stdout, /^\S+  run  done$/m);
  assert.match(shown.stdout, /#1 +tools\/write +note\.txt +ok/);
  assert.match(shown.stdout, /#2 +tools\/read +missing\.txt +failed .*File not found/);
  assert.match(shown.stdout, /attempt 0 over: exit code 0 → done/);

  const listed = await trama("journal", "busy", "--list");
  const [run] = journalFiles(join(projects, "busy")).map(name => name.replace(/\.jsonl$/, ""));
  assert.match(listed.stdout, new RegExp(`^${run}  run +3 calls  done$`, "m"));
  assert.equal((await trama("journal", "busy", run)).stdout, shown.stdout, "a run can be asked for by name");

  const unknown = await trama("journal", "busy", "no-such-run");
  assert.equal(unknown.exitCode, 1);
  assert.match(unknown.stderr, /No journal for run "no-such-run"/);
});

test("a journal is kept where the system takes logs/journal, however the links on the way are written", async (t) => {
  const parent = makeTempDir("trama-journal-");
  t.after(() => cleanupTempDir(parent));
  const projectDir = join(parent, "project");
  createProjectFixture(projectDir, { scaffold: false });
  // logs -> x/../.. with x -> deep/dir: as text that is the directory above the project, where
  // something called journal happens to be. The system takes it to the project itself.
  mkdirSync(join(projectDir, "deep", "dir"), { recursive: true });
  symlinkSync(join("deep", "dir"), join(projectDir, "x"));
  symlinkSync("x/../..", join(projectDir, "logs"));
  mkdirSync(join(parent, "journal"));

  const result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 20_000 });
  assert.equal(result.status, "done");
  assert.deepEqual(readdirSync(join(parent, "journal")), [], "nothing was recorded beside the project");
  assert.equal(readdirSync(join(projectDir, "journal")).filter(name => name.endsWith(".jsonl")).length, 1);
});

test("a journal is a file: a pipe, a directory or a link that bears a journal's name is neither read nor removed in its turn", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  const projectDir = makeTempDir("trama-journal-");
  t.after(() => { cleanupTempDir(fakeHome); cleanupTempDir(projectDir); });
  createProjectFixture(projectDir, { programSource: `import { ctx } from "@trama-dev/runtime";\nawait ctx.done();\n` });
  const dir = join(projectDir, "logs", "journal");
  mkdirSync(dir, { recursive: true });
  // Named so as to be the oldest on record, and so the first to make room.
  execFileSync("mkfifo", [join(dir, "0000-a-pipe.jsonl")]);
  mkdirSync(join(dir, "0000-a-directory.jsonl"));
  symlinkSync("0000-a-pipe.jsonl", join(dir, "0000-a-link.jsonl"));

  // Asked first, of the listing alone: opening the pipe to see who is writing it would never return.
  assert.deepEqual(runsIn(dir), []);

  await withEnv({ HOME: fakeHome }, async () => {
    writeJson(join(fakeHome, ".trama", "config.json"), { journalRuns: 1 });
    for (let i = 0; i < 2; i++) assert.equal((await runProgram({ projectDir, timeout: 20_000 })).status, "done");
  });
  assert.equal(runsIn(dir).length, 1, "the runs' own journals are kept and made room for as ever");
  assert.equal(lstatSync(join(dir, "0000-a-pipe.jsonl")).isFIFO(), true);
  assert.equal(existsSync(join(dir, "0000-a-directory.jsonl")), true);
});

test("journal inspection rejects non-anchored >4KB lookalikes, non-positive pids, staged temps, and clips huge BigInts", async (t) => {
  const { journalEntriesOf, openJournal, stillBeingWritten } = await import("../packages/runtime/dist/journal.js");
  const projectDir = makeTempDir("trama-journal-edge-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { scaffold: false });

  const dir = journalDir(projectDir);
  mkdirSync(dir, { recursive: true });

  // A >4KB single-line user .jsonl file that mentions a run header mid-line is not a trama journal.
  const lookalikeRun = "2026-01-01T00-00-00-000Z-aaaaaa";
  const padding = "x".repeat(4500);
  writeText(
    join(dir, `${lookalikeRun}.jsonl`),
    `{"note":"${padding}","embedded":{"at":0,"kind":"run","v":1,"run":"${lookalikeRun}","pid":12345}}`,
  );
  assert.deepEqual(runsIn(dir), []);

  // A truncated journal whose pid is 0 or negative must never be treated as still being written.
  const zeroPidRun = "2026-01-01T00-00-01-000Z-bbbbbb";
  const zeroPidPath = join(dir, `${zeroPidRun}.jsonl`);
  writeText(zeroPidPath, `{"at":0,"kind":"run","v":1,"run":"${zeroPidRun}","pid":0}\n`);
  assert.deepEqual(runsIn(dir), [zeroPidRun]);
  assert.equal(stillBeingWritten(zeroPidPath), false);

  // Clean out the user lookalike, add a staged .trama-tmp-* file, and verify journalEntriesOf omits the whole journal dir.
  const { rmSync } = await import("fs");
  rmSync(join(dir, `${lookalikeRun}.jsonl`));
  writeText(join(dir, `${zeroPidRun}.jsonl.trama-tmp-0123456789ab`), "staged");
  assert.equal(journalEntriesOf(projectDir).size, 1);

  // Huge BigInt values are converted to string and clipped to MAX_TEXT instead of blowing past the record cap.
  const j = openJournal(projectDir, 5, { purpose: "run" });
  j.note("custom", { huge: 10n ** 400_000n });
  j.close();
  const records = readRecords(j.path);
  const custom = records.find(r => r.kind === "custom");
  assert.equal(typeof custom.huge, "string");
  assert.ok(custom.huge.length <= 256 * 1024);
  assert.ok(Array.isArray(custom.cuts) && custom.cuts.length > 0);
});

// --- What is a journal, what is beside the journals, and what a copy of the project carries of them ---

test("a project with a file where its journals would be is run and repaired all the same, unrecorded", async (t) => {
  const projectDir = makeTempDir("trama-journal-");
  createProjectFixture(projectDir, { programSource: `console.error("boom"); process.exit(1);\n` });
  writeText(join(projectDir, "logs", "journal"), "somebody's own");
  const originalRepair = llm.repair;
  llm.repair = async () => `console.log("mended");\n`;
  t.after(() => { llm.repair = originalRepair; cleanupTempDir(projectDir); });

  const { messages, result } = await captureConsole("warn", () =>
    captureConsole("log", () => runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 })));
  assert.equal(result.result.status, "done");
  assert.match(messages.join("\n"), /this run is not being recorded/);
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), `console.log("mended");`);
  assert.equal(readFileSync(join(projectDir, "logs", "journal"), "utf-8"), "somebody's own");
});

test("somebody's own file among the journals is the project's: a fix finds it in its copy, and what it writes beside it arrives", async (t) => {
  const { journalEntriesOf } = await import("../packages/runtime/dist/journal.js");
  const projectDir = makeTempDir("trama-journal-");
  createProjectFixture(projectDir, { programSource: `console.error("boom"); process.exit(1);\n` });
  mkdirSync(journalDir(projectDir), { recursive: true });
  writeText(join(journalDir(projectDir), "notes.txt"), "kept by hand");
  const originalRepair = llm.repair;
  llm.repair = async () => `import { readFileSync, writeFileSync, readdirSync } from "fs";
writeFileSync("logs/journal/out.txt", readFileSync("logs/journal/notes.txt", "utf-8") + ", and read");
writeFileSync("seen.json", JSON.stringify(readdirSync("logs/journal").sort()));
`;
  t.after(() => { llm.repair = originalRepair; cleanupTempDir(projectDir); });

  const { result } = await captureConsole("log", () => runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 }));
  assert.equal(result.status, "done");
  assert.equal(readFileSync(join(journalDir(projectDir), "out.txt"), "utf-8"), "kept by hand, and read");
  // The copy held the file, and none of the journals: not the one being written either.
  assert.deepEqual(JSON.parse(readFileSync(join(projectDir, "seen.json"), "utf-8")), ["notes.txt", "out.txt"]);
  // What is left out of a copy is the journals, one by one — as many as there are — where something else is with them.
  const journals = journalFiles(projectDir).filter(name => name.endsWith(".jsonl"));
  assert.equal(journals.length, 1);
  assert.equal(journalEntriesOf(projectDir).size, journals.length);
});

test("a journal that has its end is not being written, though the process that wrote it lives on", async (t) => {
  const { stillBeingWritten } = await import("../packages/runtime/dist/journal.js");
  const { rmSync } = await import("fs");
  const projectDir = makeTempDir("trama-journal-");
  t.after(() => cleanupTempDir(projectDir));
  const dir = journalDir(projectDir);
  mkdirSync(dir, { recursive: true });
  // A process that is there, and is not this one.
  const other = process.ppid;
  assert.equal(isAlive(other), true);
  const journal = (run, ...records) => {
    const path = join(dir, `${run}.jsonl`);
    writeText(path, [{ at: 0, kind: "run", v: 1, run, pid: other }, ...records].map(record => JSON.stringify(record) + "\n").join(""));
    return path;
  };

  assert.equal(stillBeingWritten(journal("2026-01-01T00-00-00-000Z-aaaaaa", { at: 1, kind: "attempt" })), true);
  assert.equal(stillBeingWritten(journal("2026-01-01T00-00-01-000Z-aaaaaa", { at: 1, kind: "attempt" }, { at: 2, kind: "end" })), false);
  // An end that is longer than what is first looked at is found as well.
  assert.equal(stillBeingWritten(journal("2026-01-01T00-00-02-000Z-aaaaaa", { at: 2, kind: "end", result: "y".repeat(20_000) })), false);
  // And a record that only mentions an end is none.
  assert.equal(stillBeingWritten(journal("2026-01-01T00-00-03-000Z-aaaaaa", { at: 2, kind: "call", body: { kind: "end" } })), true);
  assert.deepEqual(runsIn(dir).length, 4);
  // One that started a moment after its run did — an older trama wrote the time down as it was — is one all the same.
  writeText(join(dir, "2026-01-01T00-00-08-000Z-aaaaaa.jsonl"), JSON.stringify({ at: 3, kind: "run", v: 1, run: "2026-01-01T00-00-08-000Z-aaaaaa", pid: other }) + "\n");
  assert.deepEqual(runsIn(dir).length, 5);
  rmSync(join(dir, "2026-01-01T00-00-08-000Z-aaaaaa.jsonl"));
  // A journal is the journal of the run it is named for: one that begins as another's is none.
  writeText(join(dir, "2026-01-01T00-00-09-000Z-aaaaaa.jsonl"), JSON.stringify({ at: 0, kind: "run", v: 1, run: "2026-01-01T00-00-00-000Z-aaaaaa", pid: other }) + "\n");
  assert.deepEqual(runsIn(dir).length, 4);
});

test("what says how it is to be written down is asked once, also when its answer is itself", async (t) => {
  const { openJournal } = await import("../packages/runtime/dist/journal.js");
  const projectDir = makeTempDir("trama-journal-");
  t.after(() => cleanupTempDir(projectDir));
  const journal = openJournal(projectDir, 5, { purpose: "test" });
  const itself = { n: 1, toJSON() { return this; } };
  journal.note("odd", { itself, when: { toJSON: () => ({ toJSON: () => "asked twice", n: 2 }) } });
  journal.note("after");
  journal.close();

  const [, odd, after] = readRecords(journal.path);
  assert.equal(odd.unrecordable, undefined);
  assert.equal(odd.itself.n, 1);
  assert.equal(odd.when.n, 2);
  assert.equal(after.kind, "after");
});

test("a project whose logs/journal leads back to the project itself is copied whole, less its journals", async (t) => {
  const projectDir = makeTempDir("trama-journal-");
  createProjectFixture(projectDir, { scaffold: false, programSource: `console.error("boom"); process.exit(1);\n` });
  // By links: logs is the project, and so is logs/journal. The journals are written beside the program.
  symlinkSync(".", join(projectDir, "logs"));
  symlinkSync(".", join(projectDir, "journal"));
  writeText(join(projectDir, "kept.txt"), "the project's");
  const originalRepair = llm.repair;
  llm.repair = async () => `import { readFileSync, readdirSync, writeFileSync } from "fs";
writeFileSync("seen.json", JSON.stringify({ kept: readFileSync("kept.txt", "utf-8"), journals: readdirSync(".").filter(name => /^\\d{4}-.*\\.jsonl$/.test(name)) }));
`;
  t.after(() => { llm.repair = originalRepair; cleanupTempDir(projectDir); });

  const { result } = await captureConsole("log", () => runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 }));
  assert.equal(result.status, "done");
  assert.deepEqual(JSON.parse(readFileSync(join(projectDir, "seen.json"), "utf-8")), { kept: "the project's", journals: [] });
  assert.equal(readdirSync(projectDir).filter(name => /^\d{4}-.*\.jsonl$/.test(name)).length, 1);
});

test("a journal nobody here may read, or whose writer's number is somebody else's by now, does not stand in the way", { skip: process.getuid?.() === 0 }, async (t) => {
  const { chmodSync } = await import("fs");
  const { openJournal, stillBeingWritten } = await import("../packages/runtime/dist/journal.js");
  const projectDir = makeTempDir("trama-journal-");
  createProjectFixture(projectDir, { programSource: `console.error("boom"); process.exit(1);\n` });
  const dir = journalDir(projectDir);
  mkdirSync(dir, { recursive: true });
  const record = (run, pid) => JSON.stringify({ at: 0, kind: "run", v: 1, run, pid }) + "\n";
  // Written by a run of another user's: named for its run, and not to be read.
  const sealed = "2026-01-01T00-00-00-000Z-aaaaaa";
  writeText(join(dir, `${sealed}.jsonl`), record(sealed, process.ppid));
  chmodSync(join(dir, `${sealed}.jsonl`), 0o000);
  // Left by a run that was killed; the number its runner had is by now that of a process that is not ours to signal.
  // (The first process of the system is such a one — unless it is ours, as in a container: then this one has no number.)
  const notOurs = (() => { try { process.kill(1, 0); return false; } catch (err) { return err.code === "EPERM"; } })();
  const orphaned = "2026-01-01T00-00-01-000Z-aaaaaa";
  writeText(join(dir, `${orphaned}.jsonl`), record(orphaned, notOurs ? 1 : 0));
  const originalRepair = llm.repair;
  llm.repair = async () => `console.log("mended");\n`;
  t.after(() => { llm.repair = originalRepair; cleanupTempDir(projectDir); });

  assert.deepEqual(runsIn(dir), [sealed, orphaned]);
  assert.equal(stillBeingWritten(join(dir, `${sealed}.jsonl`)), false);
  assert.equal(stillBeingWritten(join(dir, `${orphaned}.jsonl`)), false);
  // The project can be copied — the journal that cannot be read is no part of a copy — and so repaired.
  const { result } = await captureConsole("log", () => runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 }));
  assert.equal(result.status, "done");
  // And both make room in their turn.
  openJournal(projectDir, 1, { purpose: "test" }).close();
  assert.equal(runsIn(dir).includes(sealed) || runsIn(dir).includes(orphaned), false);
});

test("a journal directory that may not be read is no part of a copy: the project is repaired all the same, unrecorded", { skip: process.getuid?.() === 0 }, async (t) => {
  const { chmodSync } = await import("fs");
  const projectDir = makeTempDir("trama-journal-");
  createProjectFixture(projectDir, { programSource: `console.error("boom"); process.exit(1);\n` });
  mkdirSync(journalDir(projectDir), { recursive: true });
  writeText(join(journalDir(projectDir), "notes.txt"), "kept by hand");
  chmodSync(journalDir(projectDir), 0o000);
  const originalRepair = llm.repair;
  llm.repair = async () => `console.log("mended");\n`;
  t.after(() => { llm.repair = originalRepair; chmodSync(journalDir(projectDir), 0o700); cleanupTempDir(projectDir); });

  const { result } = await captureConsole("warn", () => captureConsole("log", () => runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 })));
  assert.equal(result.result.status, "done");
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), `console.log("mended");`);
});

// --- What agent calls ask for, and what they used ---

import { printJournals } from "../packages/runtime/dist/journal-view.js";

test("what an agent call asks for reaches its backend as asked, and what the call used is on record beside it — answered or not", async (t) => {
  const projectDir = makeTempDir("trama-journal-");
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { ctx, agent } from "@trama-dev/runtime";
const told = (err: unknown) => String(err);
const first = await agent.instruct("first", { system: "s", model: "p/m", thinking: "high", tools: ["read"] });
const second = await agent.generate<{ a: string }>({ prompt: "second", schema: { a: "string" }, model: "p/m", thinking: "off", tools: ["read"] });
const third = await agent.instruct("third").catch(told);
const fourth = await agent.instruct("fourth", { tools: ["read", 1] } as any).catch(told);
const fifth = await agent.instruct("fifth", { tools: "read" } as any).catch(told);
const sixth = await agent.instruct("sixth", { thinking: 3 } as any).catch(told);
const seventh = await agent.instruct("seventh", { tools: [], model: undefined, thinking: null } as any);
const eighth = await agent.instruct("eighth", { tool: ["read"] } as any).catch(told);
const ninth = await agent.generate({ prompt: "ninth", schema: { a: "string" }, tool: [] } as any).catch(told);
await ctx.done({ first, second, third, fourth, fifth, sixth, seventh, eighth, ninth });`,
  });

  const asked = [];
  const originalAsk = llm.ask;
  llm.ask = async (prompt, { cwd, signal, used, sofar, had, ...call }) => {
    assert.equal(typeof sofar, "function", "a backend is always given where to say what a call has used so far");
    asked.push({ prompt: prompt.startsWith("Your previous response failed validation") ? "second, again" : prompt.split("\n")[0], ...call });
    // (What a report holds beside what a report is declared to hold is not what a record is made of.)
    used({ model: "p/m", input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.25, kind: "end", seq: 99, at: -1, more: "x" });
    if (prompt === "third") throw new Error("the model is away");
    if (prompt.startsWith("second")) return "not what was asked for";
    if (prompt.includes("second")) return '{"a":"x"}';
    return `answer to ${prompt}`;
  };
  t.after(() => { llm.ask = originalAsk; cleanupTempDir(projectDir); });

  const { result } = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 20_000 });
  assert.deepEqual(result, {
    first: "answer to first",
    second: { a: "x" },
    third: "Error: trama runtime error: Error: the model is away",
    fourth: "Error: trama runtime error: Invalid field: tools (expected strings or tools or undefined)",
    fifth: "Error: trama runtime error: Invalid field: tools (expected strings or tools or undefined)",
    sixth: "Error: trama runtime error: Invalid field: thinking (expected string or undefined)",
    seventh: "answer to seventh",
    // An option that is none — misspelt, or not this call's — is not passed over: the program would think it had been taken.
    eighth: "Error: trama runtime error: Unknown field: tool (this call takes: prompt, system, model, thinking, tools, skills, extensions, cutOff, templates)",
    ninth: "Error: trama runtime error: Unknown field: tool (this call takes: prompt, schema, system, model, thinking, tools, skills, extensions, cutOff)",
  });
  assert.deepEqual(asked, [
    { prompt: "first", system: "s", model: "p/m", thinking: "high", tools: ["read"] },
    { prompt: "second", system: undefined, model: "p/m", thinking: "off", tools: ["read"] },
    { prompt: "second, again", system: undefined, model: "p/m", thinking: "off", tools: ["read"] },
    { prompt: "third", system: undefined },
    { prompt: "seventh", system: undefined, tools: [] },
  ]);

  const records = onlyJournal(projectDir);
  assert.deepEqual(callAt(records, 1).call.request, { prompt: "first", system: "s", model: "p/m", thinking: "high", tools: ["read"] });
  const usage = records.filter(record => record.kind === "usage");
  // Each asking of the backend is one record: the second call asked twice, the refused ones never.
  assert.deepEqual(usage.map(record => record.seq), [1, 2, 2, 3, 7]);
  const { at, ...one } = usage[0];
  assert.deepEqual(one, { kind: "usage", seq: 1, model: "p/m", input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.25 });
  // What a call used is written when the backend says it — before the call's answer, and whether or not it got one.
  assert.equal(callAt(records, 3).result.ok, false);
  assert.ok(records.indexOf(usage[3]) < records.indexOf(callAt(records, 3).result));

  const { messages } = await captureConsole("log", async () => printJournals(projectDir, "it", {}));
  const shown = messages.join("\n");
  assert.match(shown, /#1 +agent\/instruct +first +ok +\d+ms  18 tokens  \$0\.2500$/m);
  assert.match(shown, /#2 +agent\/generate +second +ok +\d+ms  36 tokens  \$0\.5000$/m);
  assert.match(shown, /#3 +agent\/instruct +third +failed +\d+ms +Error: the model is away  18 tokens  \$0\.2500$/m);
  assert.match(shown, /#4 +agent\/instruct +fourth +failed +\d+ms +Invalid field: tools \(expected strings or tools or undefine…$/m);
  assert.match(shown, /end: done  \(90 tokens  \$1\.2500 in all\)$/m);
  assert.doesNotMatch(shown, /asking for the fix/, "what a call used is said with the call, and only there");
  const listed = await captureConsole("log", async () => printJournals(projectDir, "it", { list: true }));
  assert.match(listed.messages.join("\n"), /^\S+  run +10 calls  done  90 tokens  \$1\.2500$/m);
});

test("what asking for a fix used is on record with the run, whether or not a fix came back", async (t) => {
  const mended = makeTempDir("trama-journal-");
  const unmended = makeTempDir("trama-journal-");
  for (const projectDir of [mended, unmended]) {
    createProjectFixture(projectDir, { scaffold: false, programSource: `throw new Error("the original fails");` });
  }
  const originalRepair = llm.repair;
  llm.repair = async (_prompt, call) => {
    call.used({ model: "p/m", input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.5, kind: "end", for: "nothing", more: "x" });
    if (existsSync(join(call.cwd, "unmended"))) throw new Error("no fix today");
    if (existsSync(join(call.cwd, "garbled"))) call.used(undefined);
    return `import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ fixed: true });`;
  };
  t.after(() => { llm.repair = originalRepair; cleanupTempDir(mended); cleanupTempDir(unmended); });
  const used = { kind: "usage", for: "fix", model: "p/m", input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.5 };
  const shapeOf = (records) => records.map(record => record.kind).filter(kind => kind !== "call" && kind !== "result");
  const usageIn = (records) => records.filter(record => record.kind === "usage").map(({ at, ...record }) => record);

  assert.deepEqual(await runProgram({ projectDir: mended, maxRepairAttempts: 3, timeout: 20_000 }), { status: "done", result: { fixed: true } });
  let records = onlyJournal(mended);
  assert.deepEqual(shapeOf(records), ["run", "attempt", "exit", "fix-request", "usage", "fix", "attempt", "exit", "end"]);
  assert.deepEqual(usageIn(records), [used]);

  // What is said that is no report at all is written down as that, and the run goes on as it would have.
  const garbled = makeTempDir("trama-journal-");
  t.after(() => cleanupTempDir(garbled));
  createProjectFixture(garbled, { scaffold: false, programSource: `throw new Error("the original fails");` });
  writeText(join(garbled, "garbled"), "x");
  assert.equal((await runProgram({ projectDir: garbled, maxRepairAttempts: 3, timeout: 20_000 })).status, "done");
  const odd = onlyJournal(garbled).filter(record => record.kind === "usage");
  assert.deepEqual(odd.map(record => typeof record.unrecordable), ["undefined", "string"]);

  // A run that asked no model anything says nothing of what it used.
  assert.equal((await runProgram({ projectDir: mended, maxRepairAttempts: 3, timeout: 20_000 })).status, "done");
  const quiet = await captureConsole("log", async () => printJournals(mended, "it", {}));
  assert.match(quiet.messages.join("\n"), /^\S+  run  done\n(.*\n)*.* end: done$/);
  const listed = await captureConsole("log", async () => printJournals(mended, "it", { list: true }));
  assert.match(listed.messages.join("\n"), /^\S+  run +\d+ calls  done  120 tokens  \$0\.5000\n\S+  run +\d+ calls  done$/);

  writeText(join(unmended, "unmended"), "the copy the fix is asked for in holds this, and is told from the other by it");
  const { result: failed } = await captureConsole("error", () => runProgram({ projectDir: unmended, maxRepairAttempts: 3, timeout: 20_000 }));
  assert.equal(failed.status, "failed");
  records = onlyJournal(unmended);
  assert.deepEqual(shapeOf(records), ["run", "attempt", "exit", "fix-request", "usage", "fix", "end"]);
  assert.deepEqual(usageIn(records), [used]);
  assert.equal(records.find(record => record.kind === "fix").ok, false);

  const { messages } = await captureConsole("log", async () => printJournals(unmended, "it", {}));
  const shown = messages.join("\n");
  assert.match(shown, /asking for the fix used 120 tokens  \$0\.5000$/m);
  assert.match(shown, /end: failed  \(120 tokens  \$0\.5000 in all\)$/m);
});

test("a run's journal ends after the calls it cut off have said what they used — given the time anything asked to stop is given, and no run's but its own", async (t) => {
  const projectDir = makeTempDir("trama-journal-");
  createProjectFixture(projectDir, { scaffold: false, programSource: `throw new Error("the original fails");` });
  const originalRepair = llm.repair;
  t.after(() => { llm.repair = originalRepair; cleanupTempDir(projectDir); });
  const quietly = (run) => captureConsole("error", run).then(({ result }) => result);
  const used = { model: "p/m", input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.5 };
  const lastJournal = () => readRecords(join(journalDir(projectDir), journalFiles(projectDir).at(-1)));

  // A backend that has things to stop first lets go of a cancelled call a little after the call was answered.
  llm.repair = (_prompt, { signal, used: say }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => setTimeout(() => { say(used); reject(new Error("stopped")); }, 100));
  });
  let started = Date.now();
  assert.equal((await quietly(() => runProgram({ projectDir, maxRepairAttempts: 1, timeout: 300 }))).status, "failed");
  assert.ok(Date.now() - started < 3000, "it is waited for no longer than it takes");
  let records = lastJournal();
  assert.deepEqual(records.map(record => record.kind).slice(-4), ["fix-request", "fix", "usage", "end"]);
  assert.deepEqual(records.at(-2), { at: records.at(-2).at, kind: "usage", for: "fix", ...used });

  // One that never lets go is waited for as long as a program that ignores being asked to stop — and then no more:
  // what it says afterwards finds the journal closed, and the next run has nothing of it to wait for.
  let sayLate;
  llm.repair = (_prompt, { used: say }) => new Promise(() => { sayLate = () => say(used); });
  started = Date.now();
  assert.equal((await quietly(() => runProgram({ projectDir, maxRepairAttempts: 1, timeout: 300 }))).status, "failed");
  const waited = Date.now() - started;
  assert.ok(waited > 4500 && waited < 9000, `the run ended ${waited}ms after it began`);
  sayLate();
  records = lastJournal();
  assert.deepEqual(records.map(record => record.kind).slice(-3), ["fix-request", "fix", "end"]);

  llm.repair = async () => { throw new Error("no fix today"); };
  started = Date.now();
  assert.equal((await quietly(() => runProgram({ projectDir, maxRepairAttempts: 1, timeout: 20_000 }))).status, "failed");
  assert.ok(Date.now() - started < 3000, "a run that cut nothing off waits for nothing");

  // What one run cut off is that run's to wait for: another, going on beside it, ends when it is done...
  const beside = makeTempDir("trama-journal-");
  t.after(() => cleanupTempDir(beside));
  createProjectFixture(beside, { scaffold: false, programSource: `throw new Error("this one fails too");` });
  llm.repair = (_prompt, { cwd }) => existsSync(join(cwd, "beside"))
    ? Promise.reject(new Error("no fix today"))
    : new Promise(() => {});
  writeText(join(beside, "beside"), "x");
  const stuck = quietly(() => runProgram({ projectDir, maxRepairAttempts: 1, timeout: 300 }));
  await new Promise(resolve => setTimeout(resolve, 1000)); // (the one that is stuck has cut its call off by now)
  started = Date.now();
  assert.equal((await quietly(() => runProgram({ projectDir: beside, maxRepairAttempts: 1, timeout: 20_000 }))).status, "failed");
  assert.ok(Date.now() - started < 3000, `the run beside it took ${Date.now() - started}ms`);
  assert.equal((await stuck).status, "failed");

  // ...and a run that is not recorded has nowhere to write what it would hear, and does not wait for it.
  writeJson(join(defaultsHome, ".trama", "config.json"), { journalRuns: 0 });
  t.after(() => cleanupTempDir(join(defaultsHome, ".trama")));
  llm.repair = () => new Promise(() => {});
  started = Date.now();
  assert.equal((await quietly(() => runProgram({ projectDir, maxRepairAttempts: 1, timeout: 300 }))).status, "failed");
  assert.ok(Date.now() - started < 3000, `the unrecorded run took ${Date.now() - started}ms`);
});

test("a total that the journal could not hold all of says so", async (t) => {
  const projectDir = makeTempDir("trama-journal-");
  t.after(() => cleanupTempDir(projectDir));
  const run = "2026-11-15T01-02-03-004Z-0a1b2c";
  writeText(join(journalDir(projectDir), `${run}.jsonl`), [
    { at: 0, kind: "run", v: 1, run, pid: 1, purpose: "run" },
    { at: 1, kind: "call", seq: 1, endpoint: "/agent/instruct", request: { prompt: "p" } },
    { at: 2, kind: "usage", seq: 1, model: "p/m", input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.5 },
    { at: 3, kind: "result", seq: 1, ms: 2, ok: true, result: "an answer" },
    { at: 4, kind: "full", bytes: 67108865, note: "calls after this point are not recorded" },
    { at: 5, kind: "end", result: { status: "done" } },
  ].map(record => JSON.stringify(record)).join("\n") + "\n");

  const shown = (await captureConsole("log", async () => printJournals(projectDir, "it", {}))).messages.join("\n");
  assert.match(shown, /end: done  \(120 tokens  \$0\.5000 on record — the journal was full\)$/m);
  let listed = (await captureConsole("log", async () => printJournals(projectDir, "it", { list: true }))).messages.join("\n");
  assert.match(listed, /1 calls  done  120 tokens  \$0\.5000 on record — the journal was full$/);

  // ...also where what is on record is nothing: it filled up before any model was asked, and whatever was asked later is not there.
  const later = "2026-11-15T01-02-03-005Z-0a1b2c";
  writeText(join(journalDir(projectDir), `${later}.jsonl`), [
    { at: 0, kind: "run", v: 1, run: later, pid: 1, purpose: "run" },
    { at: 4, kind: "full", bytes: 67108865, note: "calls after this point are not recorded" },
    { at: 5, kind: "end", result: { status: "done" } },
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  const latest = (await captureConsole("log", async () => printJournals(projectDir, "it", {}))).messages.join("\n");
  assert.match(latest, /end: done  \(no usage on record — the journal was full\)$/m);
  listed = (await captureConsole("log", async () => printJournals(projectDir, "it", { list: true }))).messages.join("\n");
  assert.match(listed, /0 calls  done  no usage on record — the journal was full$/);
});

test("what an agent call comes to after its program has ended is no answer, and is not recorded as one", async (t) => {
  const projectDir = makeTempDir("trama-journal-");
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { agent } from "@trama-dev/runtime";
await agent.instruct("this takes longer than the program has");`,
  });
  // A backend lets go of a cancelled call at once — sooner than the bridge sees the program's connection close.
  const originalAsk = llm.ask;
  llm.ask = (_prompt, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Aborted"))));
  t.after(() => { llm.ask = originalAsk; cleanupTempDir(projectDir); });

  for (let round = 0; round < 3; round++) {
    const result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 1_000 });
    assert.match(result.reason, /timeout/);
    const records = readRecords(join(journalDir(projectDir), journalFiles(projectDir).at(-1)));
    assert.deepEqual(records.map(record => record.kind), ["run", "attempt", "call", "exit", "end"]);
  }
});

test("a run that has waited for what it cut off leaves nothing behind that keeps its process going", async (t) => {
  const projectDir = makeTempDir("trama-journal-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { scaffold: false });
  const waiting = () => process.getActiveResourcesInfo().filter(resource => resource === "Timeout").length;

  assert.equal((await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 20_000 })).status, "done");
  const before = waiting();
  assert.equal((await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 20_000 })).status, "done");
  assert.equal(waiting(), before, "the time it would have given a call that does not let go is not still running");
});

test("a program is given a reply that was cut off where it says to keep one, and a typed answer in lists and objects", async (t) => {
  const { CutOff } = await import("../packages/runtime/dist/agent-backend.js");
  const projectDir = makeTempDir("trama-journal-");
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { ctx, agent, type Schema } from "@trama-dev/runtime";
const told = (err: unknown) => String(err);
const failed = await agent.instruct("cut").catch(told);
const kept = await agent.instruct("cut", { cutOff: "keep" });
const neither = await agent.instruct("cut", { cutOff: "sometimes" } as any).catch(told);
const notAWord = await agent.instruct("cut", { cutOff: true } as any).catch(told);
const schema: Schema = { failures: [{ test: "string", line: "number" }], meta: { tags: ["string"] } };
const typed = await agent.generate<{ failures: Array<{ test: string; line: number }>; meta: { tags: string[] } }>({ prompt: "typed", schema });
const typedKept = await agent.generate({ prompt: "typed and cut", schema: { n: ["number"] }, cutOff: "keep" });
const wrong = await agent.generate({ prompt: "typed", schema: { a: ["string", "number"] } } as any).catch(told);
await ctx.done({ failed, kept, neither, notAWord, typed, typedKept, wrong });`,
  });
  const originalAsk = llm.ask;
  llm.ask = async (prompt) => {
    if (prompt === "cut") throw new CutOff("the work is done, and what is left to say is");
    if (prompt.startsWith("typed and cut")) throw new CutOff('{"n":[1,2,3]}');
    return JSON.stringify({ failures: [{ test: "a", line: 3, more: 1 }], meta: { tags: ["x", "y"], other: true }, beside: 1 });
  };
  t.after(() => { llm.ask = originalAsk; cleanupTempDir(projectDir); });

  const { result } = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 20_000 });
  assert.deepEqual(result, {
    failed: "Error: trama runtime error: Error: The model's answer was cut off at its output limit.",
    kept: "the work is done, and what is left to say is",
    neither: 'Error: trama runtime error: Error: cutOff is "fail" or "keep", not "sometimes"',
    notAWord: "Error: trama runtime error: Invalid field: cutOff (expected string or undefined)",
    typed: { failures: [{ test: "a", line: 3 }], meta: { tags: ["x", "y"] } },
    typedKept: { n: [1, 2, 3] },
    wrong: 'Error: trama runtime error: Error: Schema validation failed: the list at "a" is written with 2 elements — it takes one, the shape of every item',
  });
});

test("journals are in the order they were opened in, by their names: one opened after another by the same runner is never named before it, however little time is between them", async (t) => {
  const { openJournal } = await import("../packages/runtime/dist/journal.js");
  const projectDir = makeTempDir("trama-journal-order-");
  t.after(() => cleanupTempDir(projectDir));
  // (As many as a millisecond has room for, and more: by the clock alone, those of one millisecond are in the order of their random ends.)
  const opened = [];
  for (let i = 0; i < 60; i += 1) { const journal = openJournal(projectDir, 100, { purpose: "test", n: i }); opened.push(journal.run); journal.close(); }
  assert.deepEqual([...opened].sort(), opened);
  assert.equal(new Set(opened.map((run) => run.slice(0, 24))).size, 60, "each by a time of its own");
  // And each says when it was really begun: a name is put after the one before by no more than it has to be.
  const first = Date.parse(JSON.parse(readFileSync(join(projectDir, "logs", "journal", `${opened[0]}.jsonl`), "utf-8").split("\n")[0]).started);
  const last = Date.parse(JSON.parse(readFileSync(join(projectDir, "logs", "journal", `${opened.at(-1)}.jsonl`), "utf-8").split("\n")[0]).started);
  assert.ok(last - first < 5_000, String(last - first));
});
