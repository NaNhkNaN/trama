import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "child_process";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { replayProgram, runProgram } from "../packages/runtime/dist/runner.js";
import { user } from "./pi-user.mjs";
import { isDeepStrictEqual } from "node:util";
import { REPO_ROOT, captureConsole, cleanupTempDir, createProjectFixture, makeTempDir, readJson, withEnv, writeJson } from "./helpers.mjs";

// The harness for work on a codebase that is in the repository to begin from (examples/coding-harness): a
// program that is its own loop over `agent.complete`. Here it is run as a project is, with nothing stood in for
// but the provider — which plays a model at work, going wrong in the ways the harness is written to meet.

const EXAMPLE = join(REPO_ROOT, "examples", "coding-harness");
const NOTES = Array.from({ length: 60 }, (_, at) => `line ${at + 1}: ${"the heron waits at low tide. ".repeat(3)}`).join("\n");

/**
 * A user with a model, and a codebase whose program is the harness. `plays(request, n)` says what the model does
 * with its nth request: a number (the provider refuses, with that status and `said`), words, or a tool's call.
 */
async function scene(t, plays, said = "down for a moment") {
  const requests = [], sizes = [];
  const provider = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const request = JSON.parse(body);
      requests.push(request);
      sizes.push(read(body));
      const does = plays(request, requests.length);
      if (typeof does === "number") {
        res.writeHead(does, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: said } }));
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (choices, usage) => res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "fake", choices, ...(usage && { usage }) })}\n\n`);
      if (typeof does === "string") {
        send([{ index: 0, delta: { role: "assistant", content: does }, finish_reason: null }]);
        send([{ index: 0, delta: {}, finish_reason: "stop" }]);
      } else {
        send([{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: { name: does.name, arguments: JSON.stringify(does.args ?? {}) } }] }, finish_reason: null }]);
        send([{ index: 0, delta: {}, finish_reason: "tool_calls" }]);
      }
      send([], { prompt_tokens: read(body), completion_tokens: 200, total_tokens: read(body) + 200 });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => { provider.closeAllConnections(); provider.close(); });
  const it = await user(t);
  it.put(it.agentDir, "models.json", JSON.stringify({ providers: { fake: {
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: "openai-completions", apiKey: "k",
    models: [{ id: "plain", cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } }, { id: "small", cost: { input: 0.1, output: 0.2, cacheRead: 0.05, cacheWrite: 0 } }],
  } } }));
  it.put(it.agentDir, ".trama/config.json", JSON.stringify({ provider: "fake", model: "plain" }));
  const projectDir = makeTempDir("trama-coding-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { programSource: readFileSync(join(EXAMPLE, "program.ts"), "utf-8"), packageJson: { name: "codebase", type: "module" } });
  // (Held to what the example says it takes and gives, as a copy of it is.)
  const { description, parameters, returns } = readJson(join(EXAMPLE, "meta.json"));
  writeJson(join(projectDir, "meta.json"), { ...readJson(join(projectDir, "meta.json")), description, parameters, returns });
  mkdirSync(join(projectDir, "src"));
  writeFileSync(join(projectDir, "src", "greet.js"), 'export const greet = (name) => "Helo, " + name;\n');
  writeFileSync(join(projectDir, "notes.txt"), NOTES);
  return {
    requests, sizes, projectDir,
    run: (args = {}, options = {}) => withEnv(it.env, () => captureConsole("warn", () => runProgram({ projectDir, args: { task: "Greet properly.", ...args }, maxRepairAttempts: 0, timeout: 60_000, ...options }))),
    replay: (options = {}) => withEnv(it.env, () => captureConsole("warn", () => replayProgram({ projectDir, ...options }))),
    /** The model is gone: whatever is asked of it from here on is not answered. */
    gone: () => new Promise((resolve) => { provider.closeAllConnections(); provider.close(resolve); }),
  };
}
/** What the stand-in says a request read, in tokens: a quarter of its bytes. */
const read = (body) => Math.round(body.length / 4);
const saidByTools = (request) => request.messages.filter((message) => message.role === "tool").map((message) => message.content);

test("the harness does work on a codebase: it looks, edits, runs, mends what the model gets wrong on the way, and ends when the model says it is done", async (t) => {
  const script = [
    500,                                                                          // the provider is down: asked again
    { name: "files" },
    { name: "read", args: { path: "src/greet.js" } },
    { name: "read_lines", args: { path: "notes.txt", from: 2, to: 3 } },
    { name: "edit", args: { path: "src/greet.js", find: "Hallo", replace: "Hello" } },   // not in the file: told so
    { name: "edit", args: { path: "notes.txt", find: "line 1", replace: "LINE 1" } },   // there more than once: told how often
    { name: "edit", args: { path: "src/greet.js", find: "Helo", replace: "Hello" } },
    { name: "write", args: { path: "src/shout.js", content: 'import { greet } from "./greet.js";\nexport const shout = (name) => greet(name).toUpperCase() + "!";\n' } },
    { name: "shell", args: { command: "node -e \"import('./src/shout.js').then((m) => console.log(m.shout('Ada')))\"", seconds: 60 } },
    { name: "shell", args: { command: "echo begun; sleep 20; echo late", seconds: 1 } }, // not done in the time it gave it: told so
    { name: "shell", args: { command: "echo hi", seconds: 0 } },                   // no time at all, and more than there is: told what it may be
    { name: "shell", args: { command: "echo hi", seconds: 86400 } },
    { name: "shell", args: { command: "echo hi" } },                               // no time said: told that it is to be
    "That should do it.",                                                         // words and no tool: told to go on, or to finish
    { name: "finish", args: { summary: "greet says Hello, and there is a shout" } },
  ];
  const it = await scene(t, (_request, n) => script[n - 1] ?? "there is nothing more in the script");
  const { result } = await it.run();
  // What it answers with: what the model said it did — and beside it what was done, by the harness's own count of
  // the codebase's files that are not as they were, whoever changed them and by which tool.
  assert.deepEqual(result, { status: "done", result: {
    summary: "greet says Hello, and there is a shout", asked: script.length, forgotten: 0, summed: 0,
    files: { changed: ["src/greet.js"], made: ["src/shout.js"], gone: [] },
  } });
  assert.equal(readFileSync(join(it.projectDir, "src", "greet.js"), "utf-8"), 'export const greet = (name) => "Hello, " + name;\n');
  assert.equal(readFileSync(join(it.projectDir, "notes.txt"), "utf-8"), NOTES);

  // What the model was told, and had.
  const [system, first] = it.requests[1].messages;
  assert.match(system.content, /^You work on the codebase in the current directory/);
  assert.equal(first.content, "Greet properly.");
  assert.deepEqual([...new Set(it.requests.map((request) => request.model))], ["plain"]);
  assert.deepEqual(it.requests[1].tools.map((tool) => tool.function.name), ["files", "read", "read_lines", "write", "edit", "shell", "finish"]);

  // What the tools said, in turn — as the last request has it.
  const said = saidByTools(it.requests.at(-1));
  assert.equal(said.length, 12);
  assert.deepEqual(said[0].trim().split("\n"), [".gitignore", "meta.json", "notes.txt", "package.json", "program.ts", "src/greet.js"]);
  assert.equal(said[1], 'export const greet = (name) => "Helo, " + name;\n');
  assert.equal(said[2], NOTES.split("\n").slice(1, 3).map((line, at) => `${at + 2}\t${line}`).join("\n"));
  assert.match(said[3], /^The passage is not in the file as you wrote it/);
  assert.match(said[4], /^The passage is in the file 11 times/);
  assert.equal(said[5], "edited");
  assert.equal(said[6], "written");
  assert.equal(said[7], "exit code 0\nHELLO, ADA!\n");
  // A command has the time the model gives it — and the model is told that it has, how much there is at most, and
  // what to do about more. One that is not done in its time is said to have been stopped, with what it had printed:
  // not handed back as a command that failed.
  const shell = it.requests[1].tools.find((tool) => tool.function.name === "shell").function;
  assert.deepEqual(shell.parameters.required, ["command", "seconds"]);
  assert.match(shell.description, /It has the seconds you give it, and is stopped when they are up[^]*1800 at most[^]*in the background/);
  assert.match(said[8], /^It was stopped: it was not done after the 1s it was given\. [^]*1800s at most[^]*What it had printed:\nbegun\n$/);
  assert.doesNotMatch(said[8], /late|exit code|\ntimeout/);
  assert.equal(said[9], "seconds is to be from 1 to 1800: how long the command may take.");
  assert.equal(said[10], said[9]);
  assert.match(said[11], /missing key: seconds/);
  assert.ok(it.requests.at(-1).messages.some((message) => message.role === "user" && /when the task is done, call finish/.test(JSON.stringify(message.content))));
});

test("the harness works in its run's workspace where the run has one: the codebase is there, and the project it is the program of is left as it is", async (t) => {
  const script = [
    { name: "files" },
    { name: "edit", args: { path: "src/greet.js", find: "Helo", replace: "Hello" } },
    { name: "write", args: { path: "NOTES.md", content: "greet was put right\n" } },
    { name: "read", args: { path: "NOTES.md" } },
    { name: "shell", args: { command: "pwd && ls", seconds: 60 } },
    { name: "finish", args: { summary: "greet says Hello" } },
  ];
  const it = await scene(t, (_request, n) => script[n - 1] ?? "there is nothing more in the script");
  // A codebase somewhere else: the run is pointed at it.
  const codebase = makeTempDir("trama-coding-work-");
  t.after(() => cleanupTempDir(codebase));
  mkdirSync(join(codebase, "src"));
  writeFileSync(join(codebase, "src", "greet.js"), 'export const greet = (name) => "Helo, " + name;\n');
  writeFileSync(join(codebase, "README.md"), "a codebase of its own\n");

  // (And the work is done by the model the run names, where it names one: not the project's own.)
  const { result } = await it.run({ model: "fake/small" }, { workspaceDir: codebase });
  assert.deepEqual(result, { status: "done", result: { summary: "greet says Hello", asked: script.length, forgotten: 0, summed: 0, files: { changed: ["src/greet.js"], made: ["NOTES.md"], gone: [] } } });
  assert.deepEqual([...new Set(it.requests.map((request) => request.model))], ["small"]);
  // The work is in the workspace; the project's own file of the same name is as it was.
  assert.equal(readFileSync(join(codebase, "src", "greet.js"), "utf-8"), 'export const greet = (name) => "Hello, " + name;\n');
  assert.equal(readFileSync(join(it.projectDir, "src", "greet.js"), "utf-8"), 'export const greet = (name) => "Helo, " + name;\n');
  assert.deepEqual([readFileSync(join(codebase, "NOTES.md"), "utf-8"), existsSync(join(it.projectDir, "NOTES.md"))], ["greet was put right\n", false]);
  // What the model was shown is the codebase: its files and no other — not the harness's own program, nor what the runner keeps beside it.
  const said = saidByTools(it.requests.at(-1));
  assert.deepEqual(said[0].trim().split("\n"), ["README.md", "src/greet.js"]);
  assert.deepEqual(said.slice(1, 4), ["edited", "written", "greet was put right\n"]);
  assert.match(said[4], new RegExp(`^exit code 0\\n\\S*${codebase.split("/").at(-1)}\\nNOTES\\.md\\nREADME\\.md\\nsrc\\n$`));
});

test("the harness forgets what old tools said where a conversation has grown long: the oldest first, and enough to bring it well back — by its own count, or when the provider says it is too long", async (t) => {
  const reads = (n, times = 14) => (n <= times ? { name: "read", args: { path: "notes.txt" } } : { name: "finish", args: { summary: "read enough" } });
  // (Cut to its beginning, and marked — with the harness's record after it, where it was the latest to be cut.)
  const forgotten = (content) => /^line 1: [^]{150,220}\n\[… forgotten: \d+ characters more\. Ask again if it is wanted\.\](\n\[Kept by the harness, which forgets nothing — [^\]]*\])?$/.test(content);
  /** Which of the tools' answers a request has cut short: the oldest of them, one after the other, and never the latest two. */
  const cutIn = (request) => {
    const marks = saidByTools(request).map(forgotten), cut = marks.filter(Boolean).length;
    assert.deepEqual(marks, marks.map((_, at) => at < cut), "the oldest are forgotten, and no other");
    assert.ok(marks.length - cut >= Math.min(2, marks.length), "the latest two are whole");
    return cut;
  };

  // By its own count: a request may read 8,000 tokens, and what a tool says here is some 1,400.
  const AT = 8000;
  // (Twelve times: so that the request it ends with is one that is over as well — see below.)
  const counting = await scene(t, (_request, n) => reads(n, 12));
  const { result } = await counting.run({ forgetAt: AT });
  assert.equal(result.status, "done");
  const cuts = counting.requests.map(cutIn);
  assert.equal(cuts.at(-1) + 2 <= 12, true);
  // No request comes to more than the most it may be and what one turn adds to it...
  for (const [at, size] of counting.sizes.entries()) assert.ok(size < AT + 2000, `request ${at + 1} read ${size} tokens`);
  // ...and where it had come to more, it was cut well back — to some six tenths of that, and not to just under
  // it (each cut costs the provider's cache) nor to all but the latest two (what a model has read is of use to it).
  const over = counting.sizes.findIndex((size) => size > AT);
  assert.ok(over > 3 && over < 13, `the ${over + 1}th request was the first over`);
  assert.equal(cuts[over], 0);
  assert.ok(counting.sizes[over + 1] < 0.6 * AT + 2000 && counting.sizes[over + 1] > 0.3 * AT, `cut back to ${counting.sizes[over + 1]} tokens`);
  assert.ok(saidByTools(counting.requests[over + 1]).length - cuts[over + 1] >= 3, "more than the latest two are whole");
  // So it goes on: it grows again, and is cut again — as often as it was over with more to come (nothing is
  // forgotten for a request that will not be made), and it says how often that was.
  assert.ok(result.result.forgotten >= 2);
  assert.ok(counting.sizes.at(-1) > AT, "the last request was over too");
  assert.equal(result.result.forgotten, counting.sizes.slice(0, -1).filter((size) => size > AT).length);
  assert.equal(result.result.forgotten, cuts.filter((cut, at) => at > 0 && cut > cuts[at - 1]).length);

  // What is forgotten is forgotten only where that brings the conversation back: the latest two answers are what
  // the model is at work on, and are no part of what can be — so where the rest would not do, nothing is cut, and
  // the conversation is summed up (see below). Here: three answers, and a mark that the first alone does not reach.
  let sums = 0;
  const tight = await scene(t, (request, n) => (!request.tools?.length ? `## Done\nsumming-up ${++sums}` : n <= 3 ? { name: "read", args: { path: "notes.txt" } } : { name: "finish", args: { summary: "read enough" } }));
  const held = await tight.run({ forgetAt: 3500 });
  assert.deepEqual([held.result.status, held.result.result.forgotten, held.result.result.summed, sums], ["done", 0, 1, 1]);
  for (const request of tight.requests.filter((request) => request.tools?.length)) assert.equal(cutIn(request), 0);
  assert.deepEqual(saidByTools(tight.requests.at(-1)), [NOTES]);

  // When the provider says so: half of what was sent is forgotten, and it asks again — the request that was refused, shorter.
  const refused = await scene(t, (_request, n) => (n === 15 ? 400 : n === 16 ? { name: "finish", args: { summary: "read enough" } } : reads(n)), "This model's maximum context length is 4096 tokens.");
  const again = await refused.run();
  assert.deepEqual(again.result, { status: "done", result: { summary: "read enough", asked: 16, forgotten: 1, summed: 0, files: { changed: [], made: [], gone: [] } } });
  assert.equal(cutIn(refused.requests[14]), 0);
  assert.equal(cutIn(refused.requests[15]), 9, "of fourteen answers, nine: what it takes to be rid of half of what was sent");
  // (Nine cut at once, and one record: after the latest of them, where what follows is whole.)
  const kept = "\n[Kept by the harness, which forgets nothing — the codebase's files that are not as they were when you began: none.]";
  assert.deepEqual(saidByTools(refused.requests[15]).map((said) => said.endsWith(kept)), Array.from({ length: 14 }, (_, at) => at === 8));
  assert.ok(refused.sizes[15] < 0.6 * refused.sizes[14] && refused.sizes[15] > 0.4 * refused.sizes[14]);
});

test("where the harness forgets, it says what has been done: the files that are not as they were, by what is in them — whichever tool changed them", async (t) => {
  // A model that changes a file by the harness's edit (to one as long as it was: it is what is in a file that
  // tells, not its size), makes one and removes one by the shell, and then reads until what it read is forgotten — twice.
  const script = [
    { name: "edit", args: { path: "src/greet.js", find: "Helo", replace: "Hola" } },
    { name: "shell", args: { command: "printf made > by-shell.txt && rm .gitignore", seconds: 30 } },
    ...Array(9).fill({ name: "read", args: { path: "notes.txt" } }),
    { name: "finish", args: { summary: "done" } },
  ];
  const it = await scene(t, (_request, n) => script[n - 1]);
  const { result } = await it.run({ forgetAt: 8000 });
  const files = { changed: ["src/greet.js"], made: ["by-shell.txt"], gone: [".gitignore"] };
  assert.deepEqual(result, { status: "done", result: { summary: "done", asked: 12, forgotten: 2, summed: 0, files } });

  // The model is told beforehand that it will be so, and what to go by.
  assert.match(it.requests[0].messages[0].content, /What tools said long ago is cut short as the conversation grows[^]*go by that, and not by memory, for what you have changed\.$/);
  // Each time something is forgotten, the latest answer to be cut has the record after it, as it stood then: the
  // conversation is other than it was from there on anyway, and before it nothing is.
  const record = "[Kept by the harness, which forgets nothing — the codebase's files that are not as they were when you began: changed: src/greet.js; new: by-shell.txt; gone: .gitignore.]";
  const stub = /^line 1: [^]{150,220}\n\[… forgotten: \d+ characters more\. Ask again if it is wanted\.\]$/;
  const [edited, ran, ...read] = saidByTools(it.requests.at(-1));
  assert.deepEqual([edited, ran], ["edited", "exit code 0\n"]);
  const withRecord = read.map((said, at) => (said.endsWith(`\n${record}`) ? at : -1)).filter((at) => at >= 0);
  assert.equal(withRecord.length, 2, "one record for each forgetting");
  const cut = read.filter((said) => said !== NOTES);
  assert.ok(cut.length > 2 && cut.length <= 7 && read.slice(cut.length).every((said) => said === NOTES), "the oldest are cut, the rest whole");
  // (After the latest of each lot that was cut — the second after the last of all that are.)
  assert.equal(withRecord[1], cut.length - 1);
  for (const [at, said] of cut.entries()) assert.match(withRecord.includes(at) ? said.slice(0, -record.length - 1) : said, stub);
  // (What was cut once is not cut again, record and all: it is in the last request as it was in the one after it was cut.)
  const first = it.requests.findIndex((request) => saidByTools(request).some((said) => said.endsWith(`\n${record}`)));
  assert.equal(saidByTools(it.requests[first])[2 + withRecord[0]], read[withRecord[0]]);

  // Where nothing is other than it was, that is said — and a file changed and changed back is as it was.
  const idle = await scene(t, (_request, n) => (n === 1 ? { name: "shell", args: { command: "cp src/greet.js keep && echo x > src/greet.js && mv keep src/greet.js", seconds: 30 } } : n <= 7 ? { name: "read", args: { path: "notes.txt" } } : { name: "finish", args: { summary: "done" } }));
  const none = await idle.run({ forgetAt: 8000 });
  assert.deepEqual([none.result.result.forgotten, none.result.result.files], [1, { changed: [], made: [], gone: [] }]);
  assert.ok(saidByTools(idle.requests.at(-1)).some((said) => said.endsWith("\n[Kept by the harness, which forgets nothing — the codebase's files that are not as they were when you began: none.]")));
});

test("the record leaves out what the codebase's .gitignore leaves out — what is built is no part of the work — and has all of it where git is not to be had", async (t) => {
  const script = [
    { name: "shell", args: { command: "mkdir -p build deep/build && echo x > build/out.js && echo y > src/new.js && echo z > scratch.tmp && echo w >> build/old.js && echo v > deep/build/out.js && echo u > deep/kept.tmp", seconds: 30 } },
    { name: "finish", args: { summary: "built" } },
  ];
  const ignoring = (projectDir) => {
    writeFileSync(join(projectDir, ".gitignore"), "node_modules/\nlogs/\nhistory/\nstate.json\nbuild/\n*.tmp\n");
    mkdirSync(join(projectDir, "build"));
    mkdirSync(join(projectDir, "deep"));
    writeFileSync(join(projectDir, "build", "old.js"), "old\n");
    // (As git reads it: a .gitignore further down says what is left out, and what is not, from there on.)
    writeFileSync(join(projectDir, "deep", ".gitignore"), "!kept.tmp\n");
  };
  const it = await scene(t, (_request, n) => script[n - 1]);
  ignoring(it.projectDir);
  assert.deepEqual((await it.run()).result.result.files, { changed: [], made: ["deep/kept.tmp", "src/new.js"], gone: [] });

  // Without git — here, one that fails — every file is in it.
  const bin = makeTempDir("trama-coding-bin-");
  t.after(() => cleanupTempDir(bin));
  writeFileSync(join(bin, "git"), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
  const without = await scene(t, (_request, n) => script[n - 1]);
  ignoring(without.projectDir);
  const { result } = await without.run({}, { env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.deepEqual(result.result.files, { changed: ["build/old.js"], made: ["build/out.js", "deep/build/out.js", "deep/kept.tmp", "scratch.tmp", "src/new.js"], gone: [] });
});

/** Whether a request begins as the one before it was, whole: what a provider's cache of a conversation goes by. */
const goesOnFrom = (request, before) => isDeepStrictEqual(request.messages.slice(0, before.messages.length), before.messages);
/** A model at work whose provider also answers a request to sum up (one with no tools) — with a summing-up that says which it is. */
function working(t, script) {
  const state = { sums: 0, work: 0 };
  return scene(t, (request) => (!request.tools?.length ? `## Done\nsumming-up ${++state.sums}` : script(++state.work))).then((it) => ({ ...it, state }));
}

test("where forgetting is not enough the harness sums up: the model's own words are never forgotten, and outgrow what may be read", async (t) => {
  // A model whose own words are long, and what its tools say short: it writes a file of six thousand characters at each turn.
  const AT = 8000, long = (n) => `${n}: ${"the tide comes in, the tide goes out. ".repeat(160)}`;
  const it = await working(t, (n) => (n <= 12 ? { name: "write", args: { path: `out/${String(n).padStart(2, "0")}.txt`, content: long(n) } } : { name: "finish", args: { summary: "wrote twelve" } }));
  const { result } = await it.run({ forgetAt: AT });
  const made = Array.from({ length: 12 }, (_, at) => `out/${String(at + 1).padStart(2, "0")}.txt`);
  assert.deepEqual(result, { status: "done", result: { summary: "wrote twelve", asked: 13, forgotten: 0, summed: it.state.sums, files: { changed: [], made, gone: [] } } });
  assert.ok(it.state.sums >= 2, `summed up ${it.state.sums} times`);

  // The model at work is told beforehand that it may come to this, as it is told of forgetting.
  assert.match(it.requests[0].messages[0].content, /and where it outgrows that too, what came before its latest steps is summed up\. Either way you are told which of the codebase's files/);
  // A request to sum up has no tools, and is no part of the work: the model is told what it is to do, and is
  // handed the task and the work so far as a record — what was said, what was called (cut short where it is long)
  // and what came back.
  const at = it.requests.map((request, n) => (request.tools?.length ? -1 : n)).filter((n) => n >= 0);
  assert.equal(at.length, it.state.sums);
  const [told, asked] = it.requests[at[0]].messages;
  assert.equal(it.requests[at[0]].messages.length, 2);
  assert.match(told.content, /^You sum up the work a model has done so far on a codebase[^]*you call no tools/);
  const record = typeof asked.content === "string" ? asked.content : asked.content.map((part) => part.text).join("");
  assert.match(record, /^\[The task\]: Greet properly\.\n\n\[Model called\]: write\(\{"path":"out\/01\.txt","content":"1: the tide comes in[^]{1500,2100} \[… \d+ characters more\]\)\n\n\[write said\]: written\n\n\[Model called\]: write\(\{"path":"out\/02\.txt"/);
  assert.match(record, /\n\n---\n\nThe above is the record of the work so far\.[^]*## Done[^]*## Left to do[^]*## To know[^]*$/);
  // The latest turn is not in it: that is kept as it is.
  const before = it.requests[at[0] - 1], after = it.requests[at[0] + 1];
  const latest = before.messages.filter((message) => message.role === "assistant").length + 1;
  assert.ok(record.includes(`out/${String(latest - 1).padStart(2, "0")}.txt`) && !record.includes(`out/${String(latest).padStart(2, "0")}.txt`), `the turns before the ${latest}th`);

  // The work goes on from the task, the summing-up, the harness's record of the files, and the latest turn as it was.
  assert.deepEqual(after.messages.map((message) => message.role), ["system", "user", "assistant", "tool"]);
  assert.match(after.messages[1].content, new RegExp(`^Greet properly\\.\\n\\n\\[[^\\]]*summed up[^\\]]*\\]\\n\\n## Done\\nsumming-up 1\\n\\n\\[Kept by the harness, which forgets nothing — the codebase's files that are not as they were when you began: new: ${made.slice(0, latest).join(", ")}\\.\\]$`));
  // (And it is said whose the summing-up is: the model's own, of this same run — a model took one for notes of whoever asked.)
  assert.match(after.messages[1].content, /\[[^\]]*in this same run[^\]]*summed up — by you yourself[^\]]*your own account of your own work, and no one else's notes\. Go on from there\.\]/);
  assert.equal(JSON.parse(after.messages[2].tool_calls[0].function.arguments).path, `out/${String(latest).padStart(2, "0")}.txt`);
  assert.equal(after.messages[3].content, "written");
  assert.ok(it.sizes[at[0] - 1] > AT && it.sizes[at[0] + 1] < 0.5 * AT, `from ${it.sizes[at[0] - 1]} tokens to ${it.sizes[at[0] + 1]}`);
  // The next summing-up has the one before it to go by, and is the only one the work then goes on from.
  const again = it.requests[at[1]].messages[1].content;
  assert.match(typeof again === "string" ? again : again.map((part) => part.text).join(""), /^\[The task\]: Greet properly\.\n\n\[Summed up before\]: ## Done\nsumming-up 1\n\n\[Model called\]: write\(/);
  const then = it.requests[at[1] + 1].messages[1].content;
  assert.ok(then.includes("summing-up 2") && !then.includes("summing-up 1"));

  // And between one summing-up and the next, every request begins as the one before it was: nothing is cut for nothing.
  const work = it.requests.filter((request) => request.tools?.length);
  assert.equal(work.filter((request, n) => n > 0 && !goesOnFrom(request, work[n - 1])).length, it.state.sums);
});

test("a conversation is cut only where that brings it well back — never a little at every turn: by forgetting while that does it, and by summing up from where it does not", async (t) => {
  // As a model at long work goes: commands of some length, and reading between them. What it read can be forgotten,
  // and for a while that is enough; what it said itself grows all the while, and in the end is most of what there is.
  const AT = 8000, command = `: ${"a command of some length; ".repeat(110)}\necho ok`;
  const it = await working(t, (n) => (n > 32 ? { name: "finish", args: { summary: "long work" } } : n % 2 ? { name: "shell", args: { command, seconds: 30 } } : { name: "read", args: { path: "notes.txt" } }));
  // (Some forty requests and their commands: given longer than a run here has otherwise, for a machine that is busy.)
  const { result } = await it.run({ forgetAt: AT }, { timeout: 240_000 });
  assert.equal(result.status, "done");
  const { forgotten, summed } = result.result;
  assert.ok(forgotten >= 2 && summed >= 2 && summed === it.state.sums, `forgot ${forgotten} times, summed up ${summed} times`);
  // Each time the conversation was not as it had been, it was one of those — and it was then well under the mark.
  const work = it.requests.filter((request) => request.tools?.length), sizes = it.sizes.filter((_, n) => it.requests[n].tools?.length);
  const breaks = work.map((request, n) => (n > 0 && !goesOnFrom(request, work[n - 1]) ? n : -1)).filter((n) => n > 0);
  assert.equal(breaks.length, forgotten + summed);
  for (const n of breaks) assert.ok(sizes[n - 1] > AT && sizes[n] < 0.8 * AT, `request ${n + 1}: from ${sizes[n - 1]} tokens to ${sizes[n]}`);
  // So no request is far over it, and the work never goes on with only what the latest two tools said in whole.
  for (const [n, size] of sizes.entries()) assert.ok(size < AT + 2500, `request ${n + 1} read ${size} tokens`);
  assert.ok(breaks.every((n, at) => at === 0 || n - breaks[at - 1] >= 3), `cut at requests ${breaks.map((n) => n + 1).join(", ")}`);
});

test("where a conversation cannot be kept within what may be read, the harness says so and stops: before anything is spent on it", async (t) => {
  const cannot = (forgetAt) => new RegExp(`The conversation cannot be kept within ${forgetAt} tokens: the task and the latest of the work alone come to some \\d+\\.`);
  // What may be read is less than the task and one turn come to: there is nothing to forget, and nothing to sum up.
  const least = await working(t, () => ({ name: "read", args: { path: "notes.txt" } }));
  const none = await least.run({ forgetAt: 1 });
  assert.deepEqual([none.result.status, least.state], ["failed", { sums: 0, work: 1 }]);
  assert.match(none.result.reason, cannot(1));
  // There is something before the latest turn, but that turn is too much by itself: summing the rest up would not do.
  const big = await working(t, (n) => (n === 1 ? { name: "files" } : { name: "shell", args: { command: "cat notes.txt notes.txt", seconds: 30 } }));
  const still = await big.run({ forgetAt: 3000 });
  // (Three requests: the third is the first to have the long answer in it, and says what it came to.)
  assert.deepEqual([still.result.status, big.state], ["failed", { sums: 0, work: 3 }]);
  assert.match(still.result.reason, cannot(3000));
  // The provider says it is too long, and there is nothing to forget or to sum up: the same.
  const refusing = await scene(t, (_request, n) => (n === 1 ? { name: "files" } : 400), "This model's maximum context length is 4096 tokens.");
  const refused = await refusing.run();
  assert.equal(refused.result.status, "failed");
  assert.match(refused.result.reason, cannot(120000));
  assert.equal(refusing.requests.length, 2);
  // A summing-up that is itself more than may be read would be made again at every turn: said as well, the first time.
  const wordy = await scene(t, (request) => (request.tools?.length ? { name: "write", args: { path: "out.txt", content: "the tide. ".repeat(900) } } : "it went on and on. ".repeat(2500)));
  const tooLong = await wordy.run({ forgetAt: 8000 });
  assert.equal(tooLong.result.status, "failed");
  assert.match(tooLong.result.reason, /The conversation cannot be kept within 8000 tokens: summed up, with the latest of the work, it still comes to some \d+\./);
  assert.equal(wordy.requests.filter((request) => !request.tools?.length).length, 1);
  // A provider that will not sum up: asked as often as any request is, and then it is said.
  let asked = 0;
  const down = await scene(t, (request) => (request.tools?.length ? { name: "write", args: { path: "out.txt", content: "the tide. ".repeat(900) } } : (asked += 1, 500)));
  const failed = await down.run({ forgetAt: 8000 });
  assert.equal(failed.result.status, "failed");
  assert.match(failed.result.reason, /The conversation outgrew what may be read, and could not be summed up: 500/);
  assert.equal(asked, 4);
  // A summing-up of nothing is none: it is asked for again, and the work goes on from the one that says something.
  let blank = 0, work = 0;
  const once = await scene(t, (request) => (!request.tools?.length ? ((blank += 1) === 1 ? " " : "## Done\nthe second")
    : (work += 1) <= 6 ? { name: "write", args: { path: "out.txt", content: "the tide. ".repeat(900) } } : { name: "finish", args: { summary: "wrote" } }));
  const went = await once.run({ forgetAt: 8000 });
  assert.deepEqual([went.result.status, went.result.result.summed, blank], ["done", 1, 2]);
  assert.ok(once.requests.at(-1).messages[1].content.includes("\n\n## Done\nthe second\n\n[Kept by the harness"));
});

test("a run of the harness is replayed from its record, the model gone: it goes by what it is told and not by the clock — a command that was stopped at its time is one in a replay, which takes no time", async (t) => {
  const script = [
    { name: "shell", args: { command: "echo begun; sleep 5", seconds: 1 } },
    { name: "shell", args: { command: "printf 'it gave up\\ntimeout' >&2; exit 1", seconds: 30 } },
    { name: "edit", args: { path: "src/greet.js", find: "Helo", replace: "Hello" } },
    { name: "read", args: { path: "notes.txt" } },
    { name: "finish", args: { summary: "mended" } },
  ];
  const it = await scene(t, (_request, n) => script[n - 1]);
  const { result } = await it.run();
  assert.equal(result.status, "done");
  assert.match(saidByTools(it.requests[1])[0], /^It was stopped: it was not done after the 1s it was given\.[^]*What it had printed:\nbegun\n$/);
  // (A command that ended by itself is not one that was stopped, whatever the last word it wrote.)
  assert.match(saidByTools(it.requests[2])[1], /^exit code 1\n[^]*it gave up\ntimeout$/);
  await it.gone();
  const asked = it.requests.length;

  const again = (await it.replay()).result;
  assert.deepEqual([again.left, again.answered, again.unasked, again.same], [undefined, again.recorded, 0, true]);
  assert.deepEqual(again.result, result);
  assert.equal(it.requests.length, asked, "the model was asked nothing");
});

test("the harness gives up where it is to: a provider that goes on failing, and a model that never says it is done", async (t) => {
  const down = await scene(t, () => 500);
  const failed = await down.run();
  assert.equal(failed.result.status, "failed");
  assert.match(failed.result.reason, /The model could not be asked, 4 times in a row: 500/);
  assert.equal(down.requests.length, 4);

  const idle = await scene(t, () => ({ name: "files" }));
  const never = await idle.run({ turns: 5 });
  assert.match(never.result.reason, /The model was asked 5 times and did not say it was done\./);
  assert.equal(idle.requests.length, 5);
});

test("the harness type-checks against the API a program has, as it is written", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "trama-types-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(EXAMPLE, dir, { recursive: true });
  execFileSync("mkdir", ["-p", join(dir, "node_modules", "@trama-dev")]);
  execFileSync("ln", ["-s", join(REPO_ROOT, "packages", "runtime"), join(dir, "node_modules", "@trama-dev", "runtime")]);
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { noEmit: true, strict: true, target: "es2022", module: "nodenext", moduleResolution: "nodenext", skipLibCheck: true, types: [] },
    files: ["program.ts"],
  }));
  try {
    execFileSync(process.execPath, [join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", dir], { encoding: "utf-8", stdio: "pipe" });
  } catch (err) {
    assert.fail(`the harness does not type-check:\n${err.stdout}${err.stderr}`);
  }
});
