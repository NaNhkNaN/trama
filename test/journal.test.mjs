import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHash } from "crypto";
import { createServer } from "http";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "fs";
import { join } from "path";
import { llm } from "./fake-llm.mjs";
import { createBackend, loadConfig, runProgram, validateProgram } from "../packages/runtime/dist/runner.js";
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
import { Session } from "@trama-dev/session";
const session = await Session.create({ workspace: ${JSON.stringify(wsDir)} });
const result = await session.spawn("scout", { projectDir: ${JSON.stringify(workerDir)}, maxRepairAttempts: 0, timeout: 20000 }).wait();
const seen = await session.workspace.read("from-worker.txt");
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
  // The program that created the session reaches its workspace through the bridge, so that is on record too.
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
    timeout: 20_000, maxRepairAttempts: 0, maxIterations: 10, journalRuns: 5,
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
      timeout: 20_000, maxRepairAttempts: 0, maxIterations: 10, journalRuns: 5,
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

  const candidate = `import { Session } from "@trama-dev/session";
const session = await Session.create({ workspace: "./workspace" });
await session.spawn("p", { projectDir: ${JSON.stringify(participantDir)} }).wait();`;
  await validateProgram(projectDir, createBackend(loadConfig()), candidate, {
    timeout: 20_000, maxRepairAttempts: 0, maxIterations: 10, journalRuns: 5,
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
