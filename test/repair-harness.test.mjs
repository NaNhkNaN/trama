import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "child_process";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runProgram } from "../packages/runtime/dist/runner.js";
import { printJournals } from "../packages/runtime/dist/journal-view.js";
import { user } from "./pi-user.mjs";
import { REPO_ROOT, captureConsole, cleanupTempDir, createProjectFixture, makeTempDir, withEnv } from "./helpers.mjs";

// The harness that is in the repository to begin from (examples/repair-harness): a program that fixes programs.
// Here it is asked for a fix as a run asks for one, with nothing stood in for but the provider — which plays a
// model that goes wrong in each way the harness is written to meet, before it hands the fix over.

const EXAMPLE = join(REPO_ROOT, "examples", "repair-harness");

const BROKEN = `import { ctx, tools } from "@trama-dev/runtime";
const text = await tools.read("data.txt");
await ctx.done({ words: text.split(" ").lenght.toFixed(0) });
`;
const MENDED = BROKEN.replace("lenght", "length");

const journalsOf = (projectDir) => {
  const dir = join(projectDir, "logs", "journal");
  return readdirSync(dir).sort().map((file) => readFileSync(join(dir, file), "utf-8").trim().split("\n").map((line) => JSON.parse(line)));
};

/**
 * A user with a model, a project that fails, and the harness among their projects. `plays(request, n)` says
 * what the model does with its nth request: "fail" (the provider is down), words, or a tool's call — { name,
 * args } — which is cut off at the reply's limit where it says `cut`.
 */
async function scene(t, plays) {
  const requests = [];
  const provider = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const request = JSON.parse(body);
      requests.push(request);
      const does = plays(request, requests.length);
      if (does === "fail") {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "down for a moment" } }));
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (choices, usage) => res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "fake", choices, ...(usage && { usage }) })}\n\n`);
      if (typeof does === "string") {
        send([{ index: 0, delta: { role: "assistant", content: does }, finish_reason: null }]);
        send([{ index: 0, delta: {}, finish_reason: "stop" }]);
      } else {
        const written = does.cut ? JSON.stringify(does.args).slice(0, -6) : JSON.stringify(does.args);
        send([{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: { name: does.name, arguments: written } }] }, finish_reason: null }]);
        send([{ index: 0, delta: {}, finish_reason: does.cut ? "length" : "tool_calls" }]);
      }
      send([], { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 });
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
  it.put(it.agentDir, ".trama/config.json", JSON.stringify({ provider: "fake", model: "plain", repairWith: "repair-harness" }));
  // (Among the user's projects, as its README says to put it.)
  const harness = join(it.agentDir, ".trama", "projects", "repair-harness");
  cpSync(EXAMPLE, harness, { recursive: true });
  const projectDir = makeTempDir("trama-harness-broken-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { programSource: BROKEN });
  writeFileSync(join(projectDir, "data.txt"), "the heron waits at low tide");
  return {
    requests, harness, projectDir,
    run: (options = {}) => withEnv(it.env, () => captureConsole("warn", () => runProgram({ projectDir, maxRepairAttempts: 1, timeout: 60_000, ...options }))),
  };
}
/** What the tools have said so far, as a provider is sent it. */
const saidByTools = (request) => request.messages.filter((message) => message.role === "tool").map((message) => message.content);

test("the harness fixes a program as a run asks it to: it looks, mends what the model gets wrong on the way, and hands the program over", async (t) => {
  // A model that goes wrong in every way there is, in turn, and is put right each time.
  const script = [
    "fail",                                                                 // the provider is down: asked again
    "Let me have a look at this.",                                          // words and no tool: told to use them
    { name: "list", args: { pattern: "**" } },
    { name: "read", args: { file: "data.txt" } },                           // not what `read` declared: told what it takes
    { name: "read", args: { path: "data.txt" } },
    { name: "open", args: {} },                                             // no such tool: told which there are
    { name: "shell", args: { command: "wc -w < data.txt | tr -d ' '" } },
    { name: "record", args: {} },
    { name: "write", args: { path: "mended-by.txt", content: "the harness, at length" }, cut: true }, // cut off: not run
    { name: "write", args: { path: "mended-by.txt", content: "the harness" } },
    { name: "hand_over", args: { program: MENDED } },
  ];
  const it = await scene(t, (_request, n) => script[n - 1] ?? "there is nothing more in the script");
  const { result } = await it.run({ budget: { tokens: 50_000 } });
  assert.deepEqual(result, { status: "done", result: { words: "6" } });
  assert.equal(readFileSync(join(it.projectDir, "program.ts"), "utf-8"), MENDED);
  // What it put right in the copy beside the program is the project's too — once, as it was written whole.
  assert.equal(readFileSync(join(it.projectDir, "mended-by.txt"), "utf-8"), "the harness");
  assert.equal(it.requests.length, script.length);

  // What the model was told: what it is to do, that what it changes is kept, and the API — and of the failure.
  const [system, first] = it.requests[1].messages;
  assert.equal(system.role, "system");
  assert.match(system.content, /^You fix a TypeScript program so that it runs\./);
  assert.match(system.content, /what you change there is kept/);
  assert.match(system.content, /interface Ctx[^]*complete\(request: ModelRequest\)/);
  assert.match(first.content, /^The program, program\.ts:\n\nimport \{ ctx, tools \}[^]*How it failed:[^]*toFixed/);
  assert.deepEqual(it.requests[1].tools.map((tool) => tool.function.name), ["list", "read", "write", "shell", "record", "hand_over", "give_up"]);

  // What the tools said, in turn — as the last request has it.
  const said = saidByTools(it.requests.at(-1));
  assert.equal(said.length, 8);
  // (The copy: the project, with the log of the run that failed and without its journals.)
  assert.equal(said[0], ".gitignore\ndata.txt\nlogs/latest.jsonl\nmeta.json\npackage.json\nprogram.ts");
  assert.match(said[1], /missing key: path/);
  assert.equal(said[2], "the heron waits at low tide");
  assert.equal(said[3], 'There is no tool "open". The tools: list, read, write, shell, record, hand_over, give_up.');
  assert.equal(said[4], "exit code 0\n6\n");
  // (The record of the run that failed: where the program read its file, and how it ended.)
  assert.match(said[5], /"endpoint":"\/tools\/read"[^]*"kind":"attempt-end"|"kind":"call"[^]*tools\/read/);
  assert.match(said[6], /^Your reply was cut off at its limit before this call was whole: it was not run\./);
  assert.equal(said[7], "written");
  // And where it said words and called nothing, it was told to work.
  assert.ok(it.requests[2].messages.some((message) => message.role === "user" && /Work with the tools/.test(JSON.stringify(message.content))));

  // All of it is on record, in the harness's own journal: each request, and each thing done between them.
  const [records] = journalsOf(it.harness);
  const calls = records.filter((record) => record.kind === "call").map((record) => record.endpoint);
  assert.deepEqual(calls.filter((endpoint) => endpoint !== "/agent/complete"), ["/workspace/list", "/workspace/read", "/workspace/shell", "/workspace/shell", "/workspace/write", "/ctx/done"]);
  assert.equal(calls.filter((endpoint) => endpoint === "/agent/complete").length, script.length);
  const shown = (await captureConsole("log", async () => printJournals(it.harness, "it", {}))).messages.join("\n");
  assert.match(shown, /end: done +\(12000 tokens +\$0\.0140 in all\)/);
});

test("the harness gives up where it is to: a provider that goes on failing, and a model that never hands a program over", async (t) => {
  const down = await scene(t, () => "fail");
  const failed = await down.run();
  assert.equal(failed.result.status, "failed");
  assert.match(failed.result.reason, /No fix came back: The project asked for the fix failed: [^]*The model could not be asked, 4 times in a row: 500/);
  assert.equal(down.requests.length, 4);
  assert.equal(readFileSync(join(down.projectDir, "program.ts"), "utf-8"), BROKEN);

  const idle = await scene(t, () => ({ name: "list", args: { pattern: "*.txt" } }));
  const never = await idle.run();
  assert.match(never.result.reason, /No fix came back: The project asked for the fix failed: [^]*The model was asked 40 times and handed no program over\./);
  assert.equal(idle.requests.length, 40);

  // A model that says there is no fix is taken at its word: the run fails with why, and nobody is asked again.
  const none = await scene(t, () => ({ name: "give_up", args: { why: "the answer it checks for is nowhere to be had" } }));
  const gaveUp = await none.run({ maxRepairAttempts: 3 });
  assert.equal(gaveUp.result.status, "failed");
  assert.match(gaveUp.result.reason, /No fix came back: It was said that there is none to be had: the answer it checks for is nowhere to be had$/);
  assert.equal(none.requests.length, 1);
  assert.match(none.requests[0].messages[0].content, /then there is no fix: do not hand over such a program\. Call give_up/);
  assert.equal(readFileSync(join(none.projectDir, "program.ts"), "utf-8"), BROKEN);

  // And where nothing changed beside the program is kept, the model is told so.
  const told = await scene(t, () => ({ name: "hand_over", args: { program: MENDED } }));
  writeFileSync(join(told.harness, "..", "..", "config.json"), JSON.stringify({ provider: "fake", model: "plain", repairWith: "repair-harness", agentChanges: "discard" }));
  assert.deepEqual((await told.run()).result, { status: "done", result: { words: "6" } });
  assert.match(told.requests[0].messages[0].content, /Nothing you change in the copy is kept/);
  assert.equal(existsSync(join(told.projectDir, "mended-by.txt")), false);
});

test("the harness type-checks against the API a program has, as it is written", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "trama-types-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // (As a project has the runtime: by its name, among its own modules.)
  cpSync(EXAMPLE, dir, { recursive: true });
  createProjectFixture(dir, { programSource: readFileSync(join(EXAMPLE, "program.ts"), "utf-8"), packageJson: { name: "repair-harness", type: "module" } });
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
