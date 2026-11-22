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
  const requests = [];
  const provider = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const request = JSON.parse(body);
      requests.push(request);
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
  it.put(it.agentDir, ".trama/config.json", JSON.stringify({ provider: "fake", model: "plain" }));
  const projectDir = makeTempDir("trama-coding-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { programSource: readFileSync(join(EXAMPLE, "program.ts"), "utf-8"), packageJson: { name: "codebase", type: "module" } });
  mkdirSync(join(projectDir, "src"));
  writeFileSync(join(projectDir, "src", "greet.js"), 'export const greet = (name) => "Helo, " + name;\n');
  writeFileSync(join(projectDir, "notes.txt"), NOTES);
  return {
    requests, projectDir,
    run: (args = {}, options = {}) => withEnv(it.env, () => captureConsole("warn", () => runProgram({ projectDir, args: { task: "Greet properly.", ...args }, maxRepairAttempts: 0, timeout: 60_000, ...options }))),
  };
}
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
    { name: "shell", args: { command: "node -e \"import('./src/shout.js').then((m) => console.log(m.shout('Ada')))\"" } },
    "That should do it.",                                                         // words and no tool: told to go on, or to finish
    { name: "finish", args: { summary: "greet says Hello, and there is a shout" } },
  ];
  const it = await scene(t, (_request, n) => script[n - 1] ?? "there is nothing more in the script");
  const { result } = await it.run();
  assert.deepEqual(result, { status: "done", result: { summary: "greet says Hello, and there is a shout", asked: script.length, forgotten: 0 } });
  assert.equal(readFileSync(join(it.projectDir, "src", "greet.js"), "utf-8"), 'export const greet = (name) => "Hello, " + name;\n');
  assert.equal(readFileSync(join(it.projectDir, "notes.txt"), "utf-8"), NOTES);

  // What the model was told, and had.
  const [system, first] = it.requests[1].messages;
  assert.match(system.content, /^You work on the codebase in the current directory/);
  assert.equal(first.content, "Greet properly.");
  assert.deepEqual(it.requests[1].tools.map((tool) => tool.function.name), ["files", "read", "read_lines", "write", "edit", "shell", "finish"]);

  // What the tools said, in turn — as the last request has it.
  const said = saidByTools(it.requests.at(-1));
  assert.equal(said.length, 8);
  assert.deepEqual(said[0].trim().split("\n"), [".gitignore", "meta.json", "notes.txt", "package.json", "program.ts", "src/greet.js"]);
  assert.equal(said[1], 'export const greet = (name) => "Helo, " + name;\n');
  assert.equal(said[2], NOTES.split("\n").slice(1, 3).map((line, at) => `${at + 2}\t${line}`).join("\n"));
  assert.match(said[3], /^The passage is not in the file as you wrote it/);
  assert.match(said[4], /^The passage is in the file 11 times/);
  assert.equal(said[5], "edited");
  assert.equal(said[6], "written");
  assert.equal(said[7], "exit code 0\nHELLO, ADA!\n");
  assert.ok(it.requests.at(-1).messages.some((message) => message.role === "user" && /when the task is done, call finish/.test(JSON.stringify(message.content))));
});

test("the harness forgets what old tools said where a conversation has grown long — by its own count, or when the provider says it is too long", async (t) => {
  const reads = (n) => (n <= 14 ? { name: "read", args: { path: "notes.txt" } } : { name: "finish", args: { summary: "read enough" } });
  const forgotten = (content) => /^line 1: [^]{150,220}\n\[… forgotten: \d+ characters more\. Ask again if it is wanted\.\]$/.test(content);

  // By its own count: told to forget once a request has read more than one token — which the first has.
  const counting = await scene(t, (_request, n) => reads(n));
  const { result } = await counting.run({ forgetAt: 1 });
  assert.equal(result.status, "done");
  assert.ok(result.result.forgotten >= 1, "it forgot");
  const said = saidByTools(counting.requests.at(-1));
  assert.equal(said.length, 14);
  // (The latest twelve are whole; what is older is cut to its beginning.)
  assert.deepEqual(said.map(forgotten), [true, true, ...Array(12).fill(false)]);
  assert.deepEqual(said.slice(2), Array(12).fill(NOTES));
  // Until there are more than twelve, nothing is cut: the thirteenth request has twelve answers, whole.
  assert.deepEqual(saidByTools(counting.requests[12]), Array(12).fill(NOTES));

  // When the provider says so: it forgets, and asks again — the request that was refused, shorter.
  const refused = await scene(t, (_request, n) => (n === 15 ? 400 : n === 16 ? { name: "finish", args: { summary: "read enough" } } : reads(n)), "This model's maximum context length is 4096 tokens.");
  const again = await refused.run();
  assert.deepEqual(again.result, { status: "done", result: { summary: "read enough", asked: 16, forgotten: 1 } });
  assert.deepEqual(saidByTools(refused.requests[14]).map(forgotten), Array(14).fill(false));
  assert.deepEqual(saidByTools(refused.requests[15]).map(forgotten), [true, true, ...Array(12).fill(false)]);
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
