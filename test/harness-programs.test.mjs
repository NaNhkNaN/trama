import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { readHistory, runProgram, showHistory } from "../packages/runtime/dist/index.js";
import { user } from "./pi-user.mjs";
import { REPO_ROOT, captureConsole, cleanupTempDir, createProjectFixture, makeTempDir, readJson, withEnv, writeJson } from "./helpers.mjs";

// An agent in trama uses trama: the harness that comes with it (examples/coding-harness), asked to (`programs`),
// hands its model the user's programs — to list, look at, run, make, and change by the archive's own moves. Each
// tool is one call of the runner's and no more: under the run's budget, on its record. Here the provider is stood
// in for, and plays a model that uses them.

const EXAMPLE = join(REPO_ROOT, "examples", "coding-harness");
const GREET = `import { ctx } from "@trama-dev/runtime";\nconst { name } = ctx.input.args as { name: string };\nawait ctx.done({ greeting: "Hello, " + name + "!" });\n`;
const HOLA = GREET.replace("Hello", "Hola");
const COUNTS = `import { ctx } from "@trama-dev/runtime";\nconst { text } = ctx.input.args as { text: string };\nawait ctx.done({ words: text.split(" ").filter(Boolean).length });\n`;

/** A user with a model that does what `plays(request, n)` says with its nth request (words, or a tool's call), the harness among their projects — and a codebase beside. */
async function scene(t, plays) {
  const requests = [];
  const provider = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const request = JSON.parse(body);
      requests.push(request);
      const does = plays(request, requests.length);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (choices, usage) => res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "fake", choices, ...(usage && { usage }) })}\n\n`);
      if (typeof does === "string") {
        send([{ index: 0, delta: { role: "assistant", content: does }, finish_reason: null }]);
        send([{ index: 0, delta: {}, finish_reason: "stop" }]);
      } else {
        send([{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: { name: does.name, arguments: JSON.stringify(does.args ?? {}) } }] }, finish_reason: null }]);
        send([{ index: 0, delta: {}, finish_reason: "tool_calls" }]);
      }
      send([], { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => { provider.closeAllConnections(); provider.close(); });
  const it = await user(t);
  it.put(it.agentDir, "models.json", JSON.stringify({ providers: { fake: {
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: "openai-completions", apiKey: "k", models: [{ id: "plain", cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } }],
  } } }));
  it.put(it.agentDir, ".trama/config.json", JSON.stringify({ provider: "fake", model: "plain", maxRepairAttempts: 0 }));
  const at = (name) => join(it.agentDir, ".trama", "projects", name);
  createProjectFixture(at("harness"), { programSource: readFileSync(join(EXAMPLE, "program.ts"), "utf-8") });
  const { description, parameters, returns } = readJson(join(EXAMPLE, "meta.json"));
  writeJson(join(at("harness"), "meta.json"), { ...readJson(join(at("harness"), "meta.json")), description, parameters, returns });
  createProjectFixture(at("greet"), { programSource: GREET, metaInput: { prompt: "greet", args: { name: "world" } } });
  writeJson(join(at("greet"), "meta.json"), { ...readJson(join(at("greet"), "meta.json")), description: "Greets by name.", parameters: { name: "string: who is greeted" }, returns: { greeting: "string" } });
  createProjectFixture(at("fails"), { programSource: `throw new Error("it breaks");` });
  createProjectFixture(at("judge"), { programSource: `import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ ok: false, score: 0.25, notes: "never good enough" });\n` });
  const codebase = makeTempDir("trama-programs-code-");
  t.after(() => cleanupTempDir(codebase));
  writeFileSync(join(codebase, "notes.txt"), "the heron waits at low tide\n");
  return {
    requests, at, codebase, env: it.env,
    run: (args = {}, options = {}) => withEnv(it.env, () => captureConsole("warn", () => captureConsole("log", () =>
      runProgram({ projectDir: at("harness"), workspaceDir: codebase, args: { task: "Use what programs there are.", ...args }, timeout: 120_000, ...options })))).then((said) => said.result.result),
    history: (name) => withEnv(it.env, () => readHistory(at(name))),
  };
}
const saidByTools = (request) => request.messages.filter((message) => message.role === "tool").map((message) => message.content);
const journalOf = (projectDir) => {
  const dir = join(projectDir, "logs", "journal");
  return readFileSync(join(dir, readdirSync(dir).sort().at(-1)), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
};

test("asked to, the harness hands its model the user's programs: to list, look at, run, make of a program it wrote, give a version more, and make that the program — each by the runner, on the run's record", async (t) => {
  const script = [
    { name: "programs" },
    { name: "program", args: { name: "greet" } },
    { name: "program_guide" },
    { name: "run_program", args: { name: "greet", args: { name: "Ada", loud: true } } },   // an argument it does not take: left out, and said
    { name: "run_program", args: { name: "greet", args: { name: 7 } } },                   // one that does not fit: no run, and why
    { name: "run_program", args: { name: "nobody" } },
    { name: "write", args: { path: "count.ts", content: COUNTS } },
    { name: "make_program", args: { name: "wordcount", description: "Counts the words of a text.", parameters: { text: "string: the text" }, returns: { words: "number" }, file: "count.ts", args: { text: "one two" } } },
    { name: "run_program", args: { name: "wordcount", args: { text: "the heron waits at low tide" } } },
    { name: "write", args: { path: "broken.ts", content: `throw new Error("it does not work");` } },
    { name: "make_program", args: { name: "broken", description: "Does not work.", file: "broken.ts" } },   // what does not run is no program
    { name: "make_program", args: { name: "absent", description: "Is not there.", file: "no-such-file.ts" } },
    { name: "write", args: { path: "hola.ts", content: HOLA } },
    { name: "add_version", args: { name: "greet", file: "hola.ts", detail: "in Spanish" } },
    { name: "run_program", args: { name: "greet", version: 2, args: { name: "Ada" } } },
    { name: "use_version", args: { name: "greet", version: 2 } },
    { name: "program", args: { name: "greet" } },
    { name: "run_program", args: { name: "fails" } },                                      // a run that fails: said as that, and how
    { name: "run_program", args: { name: "greet", args: { name: "Ada" }, check: "judge" } },   // a run that is judged: the verdict with what it gave
    { name: "finish", args: { summary: "used them, made one, changed one" } },
  ];
  const it = await scene(t, (_request, n) => script[n - 1] ?? "there is nothing more in the script");
  const ran = await it.run({ programs: true });
  assert.equal(ran.status, "done", ran.reason);
  assert.equal(ran.result.summary, "used them, made one, changed one");

  // What the model had, and was told of it.
  const [system] = it.requests[0].messages;
  assert.deepEqual(it.requests[0].tools.map((tool) => tool.function.name), ["files", "read", "read_lines", "write", "edit", "shell", "programs", "program", "program_guide", "run_program", "make_program", "add_version", "use_version", "finish"]);
  assert.match(system.content, /^You work on the codebase in the current directory[^]*You also have programs: trama projects[^]*One of them is the harness you are at work in/);

  const said = saidByTools(it.requests.at(-1));
  assert.equal(said.length, script.length - 1);
  // The programs there are, each by what it is for — and which is the harness itself.
  assert.deepEqual(said[0].split("\n").map((line) => line.split(" — ")[0]), ["fails", "greet", "harness (the harness you are at work in)", "judge"]);
  assert.match(said[0], /^fails — \(it does not say what it is for\)\ngreet — Greets by name\.\n/);
  // One of them: what it takes and gives, its own arguments, where it is, its versions.
  assert.match(said[1], /^greet — Greets by name\.\nIt takes: \{"name":"string: who is greeted"\}\nIt gives: \{"greeting":"string"\}\nIts own arguments, which a run has where it gives none: \{"name":"world"\}\n/);
  assert.ok(said[1].includes(`Its files are in ${it.at("greet")}: program.ts is the program, and history/ has the text of each version (0001.ts, and so on).`), said[1]);
  assert.match(said[1], /\nNo version of it is on record yet: it has not been run\.$/);
  // How a program is written: the whole of it, however long.
  assert.match(said[2], /^A project is a directory[^]*The runtime's API:[^]*Programs, for what one looks like:/);
  assert.ok(said[2].length > 20_000 && !/characters more: ask for less/.test(said[2]));
  // A run of one: what it gave — and what was left out of what it was given; or that there was no run, and why.
  assert.equal(said[3], 'The run is done. It gave: {"greeting":"Hello, Ada!"}\n(Left out of what it was given, since greet does not take it: loud. It takes: name.)');
  assert.match(said[4], /The arguments do not fit[^]*name: expected string, got 7\. It takes: name\./);
  assert.match(said[5], /Project "nobody" not found/);
  // A program the model wrote, made a project — and run.
  assert.equal(said[6], "written");
  assert.equal(said[7], "wordcount is made, and is among the programs from here on: it is its version 1, and ran once to be validated, with the arguments it was made with.");
  assert.equal(said[8], 'The run is done. It gave: {"words":6}');
  assert.match(said[10], /it does not work/);
  assert.match(said[11], /The file could not be read[^]*no-such-file\.ts/);
  // A version more of one that is there: beside the program, run by its number, and then made the program.
  assert.match(said[13], /^Version 2 of greet is on record, beside its program: validated — it ran once, with the project's own arguments\. Run it by its number \(run_program with version 2\); make it the program with use_version\.$/);
  assert.equal(said[14], 'The run is done. It gave: {"greeting":"Hola, Ada!"}');
  assert.equal(said[15], "greet is at version 2 again, as its version 3: that is its program from here on.");
  assert.match(said[16], /\nIts versions:\n  v1 found — 1 run: 1 done\n  v2 update of v1, beside the program, "in Spanish" — 1 run: 1 done\n  v3 rollback from v2 ← the program — no runs$/);

  assert.match(said[17], /^The run failed: [^]*it breaks/);
  assert.equal(said[18], 'The run is done. It gave: {"greeting":"Hola, Ada!"}\nIts check: found wanting, score 0.25 — never good enough');

  // What came of it: a project made with what it says of itself, and no other; a program changed by the archive's moves.
  const made = readJson(join(it.at("wordcount"), "meta.json"));
  assert.deepEqual([readFileSync(join(it.at("wordcount"), "program.ts"), "utf-8"), made.description, made.parameters, made.returns, made.input], [COUNTS, "Counts the words of a text.", { text: "string: the text" }, { words: "number" }, { prompt: "Counts the words of a text.", args: { text: "one two" } }]);
  assert.deepEqual([existsSync(it.at("broken")), existsSync(it.at("absent"))], [false, false]);
  assert.equal(readFileSync(join(it.at("greet"), "program.ts"), "utf-8"), HOLA);
  assert.deepEqual((await it.history("greet")).versions.map(({ version, reason, aside }) => [version, reason, aside ?? false]), [[1, "found", false], [2, "update", true], [3, "rollback", false]]);
  // On the run's record: every one of them a call of the runner's — and a run it started works where the harness works.
  const record = journalOf(it.at("harness"));
  const calls = record.filter((line) => line.kind === "call").map((line) => line.endpoint);
  for (const endpoint of ["/project/describe", "/project/history", "/run/program", "/project/create", "/project/version", "/project/rollback"]) assert.ok(calls.includes(endpoint), endpoint);
  const runs = record.filter((line) => line.kind === "call" && line.endpoint === "/run/program").map((line) => line.request);
  assert.deepEqual([...new Set(runs.map((request) => request.workspaceDir))], [realpathSync(it.codebase)]);
  assert.deepEqual([...new Set(runs.map((request) => request.maxRepairAttempts))], [0]);
});

test("what a tool of the programs' takes as an object is declared as one — a model is told its kind — and what is given for it and is none is said so, in words to try again by", async (t) => {
  // (The first model to have these tools — 2026-11-26 — was told no kind for these fields, and wrote every object as
  // its JSON text: eighteen times of eighteen. A field that is an object says so now.)
  const script = [
    { name: "write", args: { path: "count.ts", content: COUNTS } },
    { name: "run_program", args: { name: "greet", args: '{"name": "Ada"}' } },
    { name: "make_program", args: { name: "wordcount", description: "Counts.", file: "count.ts", parameters: '{"text": "string"}' } },
    { name: "add_version", args: { name: "greet", file: "count.ts", returns: ["words"] } },
    { name: "make_program", args: { name: "wordcount", description: "Counts the words of a text.", file: "count.ts", parameters: { text: "string: the text" }, returns: { words: "number" }, args: { text: "one two three" } } },
    { name: "finish", args: { summary: "made it" } },
  ];
  const it = await scene(t, (_request, n) => script[n - 1] ?? "there is nothing more in the script");
  const ran = await it.run({ programs: true });
  assert.equal(ran.status, "done", ran.reason);
  const declared = Object.fromEntries(it.requests[0].tools.map((tool) => [tool.function.name, tool.function.parameters.properties]));
  assert.deepEqual(
    [declared.run_program.args.type, declared.make_program.parameters.type, declared.make_program.returns.type, declared.make_program.args.type, declared.add_version.parameters.type, declared.add_version.returns.type],
    ["object", "object", "object", "object", "object", "object"]);
  const said = saidByTools(it.requests.at(-1));
  assert.equal(said[1], "Schema validation failed: args: expected an object, got string");
  assert.equal(said[2], "Schema validation failed: parameters: expected an object, got string");
  assert.equal(said[3], "Schema validation failed: returns: expected an object, got a list");
  assert.match(said[4], /^wordcount is made/);
  const made = readJson(join(it.at("wordcount"), "meta.json"));
  assert.deepEqual([made.parameters, made.returns, made.input.args], [{ text: "string: the text" }, { words: "number" }, { text: "one two three" }]);
  assert.deepEqual((await it.history("greet")).versions.length, 0);
});

test("not asked to, the harness is as it was: the tools it had, and nothing said of programs", async (t) => {
  const script = [{ name: "programs" }, { name: "finish", args: { summary: "nothing" } }];
  const it = await scene(t, (_request, n) => script[n - 1] ?? "there is nothing more in the script");
  const ran = await it.run();
  assert.equal(ran.status, "done", ran.reason);
  assert.deepEqual(it.requests[0].tools.map((tool) => tool.function.name), ["files", "read", "read_lines", "write", "edit", "shell", "finish"]);
  assert.doesNotMatch(it.requests[0].messages[0].content, /programs/);
  assert.match(saidByTools(it.requests.at(-1))[0], /^There is no tool "programs"/);
});

test("in a run that is given no way to make projects, the harness's model is told so where it asks for one made or changed — and has the programs to look at and run all the same", async (t) => {
  const script = [
    { name: "write", args: { path: "count.ts", content: COUNTS } },
    { name: "make_program", args: { name: "wordcount", description: "Counts.", file: "count.ts", args: { text: "a" } } },
    { name: "add_version", args: { name: "greet", file: "count.ts" } },
    { name: "use_version", args: { name: "greet", version: 1 } },
    { name: "run_program", args: { name: "greet", args: { name: "Ada" } } },
    { name: "finish", args: { summary: "could not" } },
  ];
  const it = await scene(t, (_request, n) => script[n - 1] ?? "there is nothing more in the script");
  const ran = await it.run({ programs: true }, { making: false });
  assert.equal(ran.status, "done", ran.reason);
  const said = saidByTools(it.requests.at(-1));
  for (const at of [1, 2, 3]) assert.match(said[at], /This run has no way to make projects, or change them/);
  assert.equal(said[4], 'The run is done. It gave: {"greeting":"Hello, Ada!"}');
  assert.deepEqual([existsSync(it.at("wordcount")), readFileSync(join(it.at("greet"), "program.ts"), "utf-8")], [false, GREET]);
});

test("the harness's model changes the harness it is at work in: a version of it, validated, made the program — in force from the next run, and on record as a program changed while it ran", async (t) => {
  let harnessDir;
  const script = [
    () => ({ name: "shell", args: { command: `cat '${harnessDir}/program.ts' > mine.ts && echo '// a line more, by the model at work in it' >> mine.ts`, seconds: 60 } }),
    { name: "add_version", args: { name: "harness", file: "mine.ts", detail: "a line more" } },
    // (A version of a harness is validated as any program is: by a run of it — which asks the model, for the project's own prompt.)
    { name: "finish", args: { summary: "the validation's run: nothing to do" } },
    { name: "use_version", args: { name: "harness", version: 2 } },
    { name: "finish", args: { summary: "changed myself" } },
  ];
  const it = await scene(t, (_request, n) => { const does = script[n - 1] ?? "there is nothing more in the script"; return typeof does === "function" ? does() : does; });
  harnessDir = realpathSync(it.at("harness"));
  const was = readFileSync(join(harnessDir, "program.ts"), "utf-8");
  const ran = await it.run({ programs: true });
  assert.equal(ran.status, "done", ran.reason);
  assert.equal(ran.result.summary, "changed myself");
  // The validation's run was the harness as a plain program: asked for the project's own prompt, with no programs.
  assert.equal(it.requests[2].messages[1].content, "test prompt");
  assert.equal(it.requests[2].tools.length, 7);
  const said = saidByTools(it.requests.at(-1));
  assert.match(said[1], /^Version 2 of harness is on record, beside its program/);
  assert.equal(said[2], "harness is at version 2 again, as its version 3: that is its program from here on. (It is the harness you are at work in: this run goes on as it began, and the next is of the new program.)");
  assert.equal(readFileSync(join(harnessDir, "program.ts"), "utf-8"), `${was}// a line more, by the model at work in it\n`);
  assert.deepEqual((await it.history("harness")).versions.map(({ version, reason, parent, from }) => [version, reason, parent ?? from ?? null]), [[1, "found", null], [2, "update", 1], [3, "rollback", 2]]);
  const shown = (await withEnv(it.env, () => captureConsole("log", () => showHistory("harness", { runs: true })))).messages.join("\n");
  assert.match(shown, /done .*the program was changed while it ran: v3 since/);
});
