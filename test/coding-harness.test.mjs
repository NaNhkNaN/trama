import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "child_process";
import { createServer } from "node:http";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runProgram } from "../packages/runtime/dist/runner.js";
import { user } from "./pi-user.mjs";
import { REPO_ROOT, captureConsole, cleanupTempDir, createProjectFixture, makeTempDir, withEnv } from "./helpers.mjs";

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
    models: [{ id: "plain", cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } }],
  } } }));
  it.put(it.agentDir, ".trama/config.json", JSON.stringify({ provider: "fake", model: "plain" }));
  const projectDir = makeTempDir("trama-coding-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { programSource: readFileSync(join(EXAMPLE, "program.ts"), "utf-8"), packageJson: { name: "codebase", type: "module" } });
  mkdirSync(join(projectDir, "src"));
  writeFileSync(join(projectDir, "src", "greet.js"), 'export const greet = (name) => "Helo, " + name;\n');
  writeFileSync(join(projectDir, "notes.txt"), NOTES);
  return {
    requests, sizes, projectDir,
    run: (args = {}, options = {}) => withEnv(it.env, () => captureConsole("warn", () => runProgram({ projectDir, args: { task: "Greet properly.", ...args }, maxRepairAttempts: 0, timeout: 60_000, ...options }))),
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
    summary: "greet says Hello, and there is a shout", asked: script.length, forgotten: 0,
    files: { changed: ["src/greet.js"], made: ["src/shout.js"], gone: [] },
  } });
  assert.equal(readFileSync(join(it.projectDir, "src", "greet.js"), "utf-8"), 'export const greet = (name) => "Hello, " + name;\n');
  assert.equal(readFileSync(join(it.projectDir, "notes.txt"), "utf-8"), NOTES);

  // What the model was told, and had.
  const [system, first] = it.requests[1].messages;
  assert.match(system.content, /^You work on the codebase in the current directory/);
  assert.equal(first.content, "Greet properly.");
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

test("the harness forgets what old tools said where a conversation has grown long: the oldest first, and enough to bring it well back — by its own count, or when the provider says it is too long", async (t) => {
  const reads = (n) => (n <= 14 ? { name: "read", args: { path: "notes.txt" } } : { name: "finish", args: { summary: "read enough" } });
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
  const counting = await scene(t, (_request, n) => reads(n));
  const { result } = await counting.run({ forgetAt: AT });
  assert.equal(result.status, "done");
  const cuts = counting.requests.map(cutIn);
  assert.equal(cuts.at(-1) + 2 <= 14, true);
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

  // Where next to nothing may be read, all that can be forgotten is — and the latest two answers are not: they are
  // what the model is at work on, whatever their size.
  const tight = await scene(t, (_request, n) => (n <= 6 ? { name: "read", args: { path: "notes.txt" } } : { name: "finish", args: { summary: "read enough" } }));
  assert.equal((await tight.run({ forgetAt: 1 })).result.status, "done");
  assert.deepEqual(tight.requests.map(cutIn), [0, 0, 0, 1, 2, 3, 4]);
  assert.deepEqual(saidByTools(tight.requests.at(-1)).slice(-2), [NOTES, NOTES]);

  // When the provider says so: half of what was sent is forgotten, and it asks again — the request that was refused, shorter.
  const refused = await scene(t, (_request, n) => (n === 15 ? 400 : n === 16 ? { name: "finish", args: { summary: "read enough" } } : reads(n)), "This model's maximum context length is 4096 tokens.");
  const again = await refused.run();
  assert.deepEqual(again.result, { status: "done", result: { summary: "read enough", asked: 16, forgotten: 1, files: { changed: [], made: [], gone: [] } } });
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
    ...Array(4).fill({ name: "read", args: { path: "notes.txt" } }),
    { name: "finish", args: { summary: "done" } },
  ];
  const it = await scene(t, (_request, n) => script[n - 1]);
  const { result } = await it.run({ forgetAt: 1 });
  const files = { changed: ["src/greet.js"], made: ["by-shell.txt"], gone: [".gitignore"] };
  assert.deepEqual(result, { status: "done", result: { summary: "done", asked: 7, forgotten: 2, files } });

  // The model is told beforehand that it will be so, and what to go by.
  assert.match(it.requests[0].messages[0].content, /What tools said long ago is cut short as the conversation grows[^]*go by that, and not by memory, for what you have changed\.$/);
  // Each time something is forgotten, the latest answer to be cut has the record after it, as it stood then: the
  // conversation is other than it was from there on anyway, and before it nothing is.
  const record = "[Kept by the harness, which forgets nothing — the codebase's files that are not as they were when you began: changed: src/greet.js; new: by-shell.txt; gone: .gitignore.]";
  const stub = /^line 1: [^]{150,220}\n\[… forgotten: \d+ characters more\. Ask again if it is wanted\.\]$/;
  const [edited, ran, first, second, third, fourth] = saidByTools(it.requests[6]);
  assert.deepEqual([edited, ran, third, fourth], ["edited", "exit code 0\n", NOTES, NOTES]);
  for (const cut of [first, second]) {
    assert.ok(cut.endsWith(`\n${record}`), cut.slice(-300));
    assert.match(cut.slice(0, -record.length - 1), stub);
  }
  // (What was cut once is not cut again, record and all: the fifth request has the first as the seventh has it.)
  assert.equal(saidByTools(it.requests[5])[2], first);
  assert.deepEqual(saidByTools(it.requests[4]), ["edited", "exit code 0\n", NOTES, NOTES]);

  // Where nothing is other than it was, that is said — and a file changed and changed back is as it was.
  const idle = await scene(t, (_request, n) => (n === 1 ? { name: "shell", args: { command: "cp src/greet.js keep && echo x > src/greet.js && mv keep src/greet.js", seconds: 30 } } : n <= 5 ? { name: "read", args: { path: "notes.txt" } } : { name: "finish", args: { summary: "done" } }));
  const none = await idle.run({ forgetAt: 1 });
  assert.deepEqual(none.result.result.files, { changed: [], made: [], gone: [] });
  assert.ok(saidByTools(idle.requests.at(-1)).some((said) => said.endsWith("\n[Kept by the harness, which forgets nothing — the codebase's files that are not as they were when you began: none.]")));
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
