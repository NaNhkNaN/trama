import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "fs";
import { createServer } from "node:http";
import { join } from "path";
import { runProgram } from "../packages/runtime/dist/runner.js";
import { user } from "./pi-user.mjs";
import { captureConsole, cleanupTempDir, createProjectFixture, makeTempDir, withEnv } from "./helpers.mjs";

// One request to a model, the whole way: a program that is its own harness, the bridge, the runner and its
// count, pi's models, and a provider. (Each part of the way is held closer in complete.test.mjs and
// complete-pi.test.mjs: here they are one after the other, with nothing stood in for but the provider.)

/** A harness of a few lines: it asks, runs the tool the model calls, and asks again — and tries once more where the provider failed. */
const HARNESS = `import { ctx, agent } from "@trama-dev/runtime";
const add = { name: "add", description: "Adds two numbers.", parameters: { a: "number", b: "number" }, run: ({ a, b }) => a + b };
// (The conversation is kept as the program's state: a reply is data.)
const messages = ctx.state.messages ??= [{ role: "user", content: "What is 2 + 3?" }];
let reply, failures = 0;
for (;;) {
  reply = await agent.complete({ system: "You add.", messages, tools: [add] });
  if (reply.stopReason === "error" && ++failures < 2) continue;
  messages.push(reply);
  if (reply.stopReason !== "toolUse") break;
  for (const call of reply.content.filter((part) => part.type === "toolCall")) {
    messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: String(add.run(call.arguments)) });
  }
}
await ctx.done({ said: reply.content.find((part) => part.type === "text")?.text ?? null, stopped: reply.stopReason, failures });
`;

const journalOf = (projectDir) => {
  const dir = join(projectDir, "logs", "journal");
  return readFileSync(join(dir, readdirSync(dir).sort().at(-1)), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
};

test("a program that is its own harness: its requests reach the provider as it made them, are counted in its run's budget, and are on record", async (t) => {
  // The provider: it has `add` called where it has no answer of it yet, says "5" where it has — and fails first, as many times as it is set to.
  let fail = 0;
  const requests = [], headers = [];
  const provider = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const request = JSON.parse(body);
      requests.push(request);
      headers.push(req.headers);
      if (fail > 0) {
        fail -= 1;
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "down for a moment" } }));
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (choices, usage) => res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "fake", choices, ...(usage && { usage }) })}\n\n`);
      if (!request.messages.some((message) => message.role === "tool")) {
        send([{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "add", arguments: '{"a":2,"b":3}' } }] }, finish_reason: null }]);
        send([{ index: 0, delta: {}, finish_reason: "tool_calls" }]);
      } else {
        send([{ index: 0, delta: { role: "assistant", content: "5" }, finish_reason: null }]);
        send([{ index: 0, delta: {}, finish_reason: "stop" }]);
      }
      send([], { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => { provider.closeAllConnections(); provider.close(); });
  // (A user: a directory that is their pi's and their home, with the model in it and trama's choice of it.)
  const it = { ...(await user(t)), requests, headers };
  it.put(it.agentDir, "models.json", JSON.stringify({ providers: { fake: {
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: "openai-completions", apiKey: "$TRAMA_TEST_KEY",
    models: [{ id: "plain", cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } }],
  } } }));
  it.put(it.agentDir, ".trama/config.json", JSON.stringify({ provider: "fake", model: "plain" }));
  const projectDir = makeTempDir("trama-complete-run-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { programSource: HARNESS });
  const run = (options = {}) => withEnv({ ...it.env, TRAMA_TEST_KEY: "the-runners" }, () =>
    captureConsole("warn", () => runProgram({ projectDir, maxRepairAttempts: 0, timeout: 60_000, ...options })));

  const { result } = await run({ budget: { tokens: 5000 } });
  assert.equal(result.status, "done");
  assert.deepEqual(result.result, { said: "5", stopped: "stop", failures: 0 });
  // The provider: two requests, the program's — the second with the model's call and what the program's tool made of it.
  assert.equal(it.requests.length, 2);
  assert.deepEqual(it.requests[0].messages, [{ role: "system", content: "You add." }, { role: "user", content: "What is 2 + 3?" }]);
  assert.deepEqual(it.requests[0].tools.map((tool) => tool.function), [{
    name: "add", description: "Adds two numbers.",
    parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], additionalProperties: false },
  }]);
  assert.deepEqual(it.requests[1].messages.slice(2), [
    { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "add", arguments: '{"a":2,"b":3}' } }] },
    { role: "tool", content: "5", tool_call_id: "call-1" },
  ]);
  assert.equal(it.headers[0].authorization, "Bearer the-runners");
  // The record: each request and what it used, by pi's price list; and the run's sum.
  const records = journalOf(projectDir);
  assert.deepEqual(records.filter((record) => record.kind === "usage").map(({ seq, model, input, output, cost }) => ({ seq, model, input, output, cost })), [
    { seq: 1, model: "fake/plain", input: 1000, output: 200, cost: 0.0014 }, { seq: 2, model: "fake/plain", input: 1000, output: 200, cost: 0.0014 },
  ]);
  // The conversation is the program's, and was kept as its state: a reply is data that JSON holds.
  const state = JSON.parse(readFileSync(join(projectDir, "state.json"), "utf-8"));
  assert.deepEqual(state.messages.map((message) => message.role), ["user", "assistant", "toolResult", "assistant"]);
  assert.equal(state.messages[1].content[0].id, "call-1");

  // Held to a budget as any call: two requests at 1,200 tokens under a cap of 2,000 — the second reaches it and is answered, a third is refused.
  writeState(projectDir, {});
  const spent = await run({ budget: { tokens: 2000 }, args: {} });
  assert.deepEqual(spent.result.result, { said: "5", stopped: "stop", failures: 0 });
  writeState(projectDir, {});
  const short = await run({ budget: { tokens: 1000 } });
  assert.notEqual(short.result.status, "done");
  assert.match(JSON.stringify(short.result), /The budget is spent: 1200 tokens used of 1000\./);
  assert.ok(short.messages.includes("[trama] The budget is spent: 1200 tokens used of 1000."));

  // A provider's failure is the harness's to deal with: this one asks once more, and is answered.
  writeState(projectDir, {});
  fail = 1;
  const before = it.requests.length;
  const again = await run();
  assert.deepEqual(again.result.result, { said: "5", stopped: "stop", failures: 1 });
  assert.equal(it.requests.length - before, 3);

  // And a run that has variables is asked with them: the key is the run's.
  writeState(projectDir, {});
  const own = await run({ env: { TRAMA_TEST_KEY: "the-runs" } });
  assert.deepEqual(own.result.result, { said: "5", stopped: "stop", failures: 0 });
  assert.deepEqual(it.headers.slice(-2).map((headers) => headers.authorization), ["Bearer the-runs", "Bearer the-runs"]);
});

function writeState(projectDir, state) {
  createProjectFixture(projectDir, { programSource: HARNESS, state });
}
