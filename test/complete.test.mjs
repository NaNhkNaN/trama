import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { llm } from "./fake-llm.mjs";
import { requestOf } from "../packages/runtime/dist/model-request.js";
import { createMeter } from "../packages/runtime/dist/budget.js";
import { runProgram } from "../packages/runtime/dist/runner.js";
import { createBackend } from "../packages/runtime/dist/runner-backend.js";
import { createAgent } from "../packages/runtime/dist/agent.js";
import { printJournals, requestsWhole } from "../packages/runtime/dist/journal-view.js";
import { openJournal } from "../packages/runtime/dist/journal.js";
import { REPO_ROOT, captureConsole, cleanupTempDir, createProjectFixture, makeTempDir } from "./helpers.mjs";

// One request to a model, and one reply: what a program that is its own harness asks by. The request is held to
// its shape before anything is asked; it is a call to the run's budget, counted as any; and it is on record.
// (How pi's own models answer it is in complete-pi.test.mjs.)

/** A report of usage: so many tokens read, at a dollar a thousand. */
const took = (tokens) => ({ model: "p/m", input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, cost: tokens / 1000 });
/** A reply, as a model's library makes one: with more on it than a program is told of. */
const reply = (content, stopReason = "stop") => ({
  role: "assistant", content, api: "an-api", provider: "p", model: "m", stopReason, timestamp: 7,
  usage: { input: 400, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 400, cost: { input: 0.4, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.4 } },
});
const says = (text) => reply([{ type: "text", text }]);

const journalsOf = (projectDir) => {
  const dir = join(projectDir, "logs", "journal");
  return readdirSync(dir).sort().map((file) => readFileSync(join(dir, file), "utf-8").trim().split("\n").map((line) => JSON.parse(line)));
};

/** Stand in for the model while a test runs. */
function standIn(t, complete) {
  const original = llm.complete;
  llm.complete = complete;
  t.after(() => { llm.complete = original; });
}

test("a request is held to its shape: what a model is sent is what was declared, and nothing else", () => {
  const asked = requestOf({
    system: "You add.",
    messages: [
      { role: "user", content: "What is 2 + 3?" },
      { ...reply([{ type: "thinking", thinking: "…", thinkingSignature: "sig" }, { type: "toolCall", id: "c1", name: "add", arguments: { a: 2, b: 3 } }], "toolUse"), kept: { by: "the provider" } },
      { role: "toolResult", toolCallId: "c1", toolName: "add", content: "5" },
      { role: "user", content: [{ type: "text", text: "and this?" }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" }] },
      { role: "toolResult", toolCallId: "c2", toolName: "add", content: [{ type: "text", text: "no" }], isError: true },
    ],
    tools: [{ name: "add", description: "Adds two numbers.", parameters: { a: "number", b: "number: the second" }, parallel: true }],
    model: "p/m", thinking: "high", maxTokens: 500, temperature: 0, toolChoice: "none", timeout: 9000,
  });
  assert.deepEqual(asked, {
    context: {
      systemPrompt: "You add.",
      messages: [
        { role: "user", content: "What is 2 + 3?" },
        // A reply goes back as it came: with what the provider put on it, and a program was never told of.
        { ...reply([{ type: "thinking", thinking: "…", thinkingSignature: "sig" }, { type: "toolCall", id: "c1", name: "add", arguments: { a: 2, b: 3 } }], "toolUse"), kept: { by: "the provider" } },
        { role: "toolResult", toolCallId: "c1", toolName: "add", content: [{ type: "text", text: "5" }], isError: false },
        { role: "user", content: [{ type: "text", text: "and this?" }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" }] },
        { role: "toolResult", toolCallId: "c2", toolName: "add", content: [{ type: "text", text: "no" }], isError: true },
      ],
      // A tool is declared: what it is called with, as a model is told. (Whether it may run beside another is nobody's question here.)
      tools: [{
        name: "add", description: "Adds two numbers.",
        parameters: {
          type: "object", additionalProperties: false, required: ["a", "b"],
          properties: { a: { type: "number" }, b: { type: "number", description: "the second" } },
        },
      }],
    },
    model: "p/m", thinking: "high", maxTokens: 500, temperature: 0, toolChoice: "none", timeout: 9000,
  });
  // The least of it: a message. (And what is given as null is not given.)
  assert.deepEqual(requestOf({ messages: [{ role: "user", content: "hi" }], system: null, tools: null, model: undefined }), { context: { messages: [{ role: "user", content: "hi" }] } });
  // (No tools named is no tools.)
  assert.deepEqual(requestOf({ messages: [{ role: "user", content: "hi" }], tools: [] }), { context: { messages: [{ role: "user", content: "hi" }] } });
});

test("a request that is not one is refused, in words that say where it is wrong", () => {
  const user = { role: "user", content: "hi" };
  const wrong = (request, words) => assert.throws(() => requestOf(request), (err) => {
    assert.equal(err.message, words);
    return true;
  });
  wrong({}, "messages is the conversation so far, a list of messages with at least one in it: got undefined");
  wrong({ messages: [] }, "messages is the conversation so far, a list of messages with at least one in it: got an empty list");
  wrong({ messages: "hi" }, "messages is the conversation so far, a list of messages with at least one in it: got \"hi\"");
  wrong({ messages: [user, "hello"] }, "messages[1] is a message — from the user, a reply as it came, or a tool's result: got \"hello\"");
  wrong({ messages: [{ role: "system", content: "be brief" }] }, 'messages[0]: a message\'s role is "user", "assistant" or "toolResult", not "system" (what a model is told to be is the request\'s `system`)');
  wrong({ messages: [{ role: "tool", content: "5" }] }, 'messages[0]: a message\'s role is "user", "assistant" or "toolResult", not "tool"');
  wrong({ messages: [{ content: "hi" }] }, 'messages[0]: a message\'s role is "user", "assistant" or "toolResult", not undefined');

  // From the user: text, or parts of text and images — and nothing beside.
  wrong({ messages: [{ role: "user" }] }, "messages[0].content is text, or a list of parts — text and images: got undefined");
  wrong({ messages: [{ role: "user", content: 5 }] }, "messages[0].content is text, or a list of parts — text and images: got 5");
  wrong({ messages: [{ role: "user", content: [] }] }, "messages[0].content is text, or a list of parts — text and images: got an empty list");
  wrong({ messages: [{ role: "user", content: ["hi"] }] }, 'messages[0].content[0] is a part — { type: "text", text } or { type: "image", mimeType, data }: got "hi"');
  wrong({ messages: [{ role: "user", content: [{ type: "toolCall", id: "c", name: "n", arguments: {} }] }] }, 'messages[0].content[0] is a part — { type: "text", text } or { type: "image", mimeType, data }: got one of type "toolCall"');
  wrong({ messages: [{ role: "user", content: [{ type: "text", text: 5 }] }] }, "messages[0].content[0].text is text: got 5");
  wrong({ messages: [{ role: "user", content: [{ type: "text", text: "hi", cache: true }] }] }, "messages[0].content[0] has a field a part of text does not take: cache (it takes: type, text)");
  wrong({ messages: [{ role: "user", content: [{ type: "image", mimeType: "image/bmp", data: "aGk=" }] }] }, "messages[0].content[0] is an image of a kind a model is shown — image/png, image/jpeg, image/gif, image/webp — with its data in base64");
  wrong({ messages: [{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "not base64!" }] }] }, "messages[0].content[0] is an image of a kind a model is shown — image/png, image/jpeg, image/gif, image/webp — with its data in base64");
  wrong({ messages: [{ role: "user", content: "hi", timestamp: 1 }] }, "messages[0] has a field a user's message does not take: timestamp (it takes: role, content)");

  // A reply: as it came. What is held is what could not be one.
  wrong({ messages: [user, { role: "assistant", content: "hello" }] }, "messages[1].content is a reply's parts, as the reply came: got \"hello\"");
  wrong({ messages: [user, { role: "assistant", content: [5] }] }, "messages[1].content[0] is a part of a reply, as the reply came: got 5");
  wrong({ messages: [user, { role: "assistant", content: [{ text: "hello" }] }] }, "messages[1].content[0] is a part of a reply, as the reply came: it has no type");
  wrong({ messages: [user, { role: "assistant", content: [{ type: "toolCall", id: "c", name: "add" }] }] }, "messages[1].content[0] is a tool's call — its id, the tool's name, and its arguments — as the reply came");

  // A tool's result: whose it is, and what it said.
  wrong({ messages: [user, { role: "toolResult", toolName: "add", content: "5" }] }, "messages[1].toolCallId is the id of the call it answers, as the reply had it: got undefined");
  wrong({ messages: [user, { role: "toolResult", toolCallId: "", toolName: "add", content: "5" }] }, 'messages[1].toolCallId is the id of the call it answers, as the reply had it: got ""');
  wrong({ messages: [user, { role: "toolResult", toolCallId: "c", content: "5" }] }, "messages[1].toolName is the name of the tool that was called: got undefined");
  wrong({ messages: [user, { role: "toolResult", toolCallId: "c", toolName: "add" }] }, "messages[1].content is text, or a list of parts — text and images: got undefined");
  wrong({ messages: [user, { role: "toolResult", toolCallId: "c", toolName: "add", content: "5", isError: "no" }] }, "messages[1].isError is true or false: got \"no\"");
  wrong({ messages: [user, { role: "toolResult", toolCallId: "c", toolName: "add", content: "5", details: {} }] }, "messages[1] has a field a tool's result does not take: details (it takes: role, toolCallId, toolName, content, isError)");

  // What goes with the conversation.
  wrong({ messages: [user], system: 5 }, "system is text: got 5");
  wrong({ messages: [user], tools: "add" }, "tools is a list of tools, each declared: got \"add\"");
  wrong({ messages: [user], tools: ["read"] }, 'tools[0]: a tool is declared here — its name, its description, its parameters — and not named: no agent is asked, whose tool "read" would be');
  wrong({ messages: [user], tools: [{ name: "add" }] }, 'tools: The tool "add" has no description: it is all a model is told of what the tool is for');
  wrong({ messages: [user], tools: [{ name: "add", description: "Adds." }, { name: "add", description: "Adds again." }] }, 'tools: Two tools are named "add": a tool is called by its name');
  wrong({ messages: [user], model: 5 }, 'model is a model by name, "provider/model": got 5');
  wrong({ messages: [user], model: "opus" }, 'model is a model by name, "provider/model": got "opus"');
  wrong({ messages: [user], thinking: 3 }, "thinking is a level by name: got 3");
  wrong({ messages: [user], maxTokens: 0 }, "maxTokens is a whole number above 0: got 0");
  wrong({ messages: [user], maxTokens: 1.5 }, "maxTokens is a whole number above 0: got 1.5");
  wrong({ messages: [user], temperature: -1 }, "temperature is a number that is not negative: got -1");
  wrong({ messages: [user], temperature: "hot" }, "temperature is a number that is not negative: got \"hot\"");
  wrong({ messages: [user], toolChoice: "required" }, 'toolChoice is "auto" or "none": got "required"');
  wrong({ messages: [user], timeout: 0 }, "timeout is milliseconds, a number above 0: got 0");
  wrong({ messages: [user], timeout: "1s" }, "timeout is milliseconds, a number above 0: got \"1s\"");
  wrong({ messages: [user], headers: { "x-key": "k" } }, "a request has no headers: it has messages, system, tools, model, thinking, maxTokens, temperature, toolChoice, timeout");
  wrong("hi", "a request is an object — the conversation so far (messages), and what goes with it: got \"hi\"");
});

test("a request to a model is a call of the run's: admitted, counted for what its reply used, and refused where the budget is spent", async (t) => {
  const ask = { context: { messages: [{ role: "user", content: "hi" }] } };
  let asked = 0;
  standIn(t, async (request, call) => {
    asked += 1;
    assert.deepEqual(request, ask);
    call.used(took(400));
    return says(`reply ${asked}`);
  });

  // Three at 40 cents under a dollar: the third reaches it, and is still answered — the fourth is refused, and nothing is asked.
  const said = [], heard = [];
  const meter = createMeter({ cost: 1 });
  const backend = createBackend({ provider: "p", model: "m" }, meter, (why) => said.push(why));
  for (const n of [1, 2, 3]) assert.deepEqual(await backend.complete(ask, { used: (usage) => heard.push(usage) }), says(`reply ${n}`));
  await assert.rejects(backend.complete(ask, {}), { message: "The budget is spent: $1.2000 used of $1." });
  assert.equal(asked, 3);
  assert.deepEqual(heard, [took(400), took(400), took(400)]);
  assert.deepEqual(said, ["The budget is spent: $1.2000 used of $1."]);
  assert.equal(backend.refused(), "The budget is spent: $1.2000 used of $1.");

  // Each is one call, as an agent's is: and in the budget of a run above too.
  const above = createMeter({ tokens: 1000 });
  const two = createBackend({ provider: "p", model: "m" }, createMeter({ calls: 2 }, above));
  await two.complete(ask, {});
  await two.complete(ask, {});
  await assert.rejects(two.complete(ask, {}), { message: "The budget is spent: 2 of 2 calls to a model made." });
  const beside = createBackend({ provider: "p", model: "m" }, createMeter({}, above));
  await beside.complete(ask, {});
  await assert.rejects(beside.complete(ask, {}), { message: "The budget of a run this one is part of is spent: 1200 tokens used of 1000." });
  assert.equal(asked, 6);

  // One that fails has used what it used; and one that is cancelled rejects at once, whatever its backend is still at.
  standIn(t, async (_request, call) => { call.used(took(100)); throw new Error("no key"); });
  const failing = createMeter({ tokens: 150 });
  const fails = createBackend({ provider: "p", model: "m" }, failing);
  await assert.rejects(fails.complete(ask, {}), { message: "no key" });
  await assert.rejects(fails.complete(ask, {}), { message: "no key" });
  await assert.rejects(fails.complete(ask, {}), { message: "The budget is spent: 200 tokens used of 150." });

  let letGo;
  standIn(t, (_request, call) => new Promise((resolve) => { letGo = () => { call.used(took(50)); resolve(says("late")); }; }));
  const stopped = createMeter({ tokens: 60 });
  const stops = createBackend({ provider: "p", model: "m" }, stopped);
  const stop = new AbortController();
  const waiting = stops.complete(ask, { signal: stop.signal });
  await new Promise((resolve) => setImmediate(resolve));
  stop.abort();
  await assert.rejects(waiting, { message: "Aborted" });
  // (What it had used by the time its backend let go of it is counted: the next is asked against that.)
  letGo();
  await stops.letGo();
  assert.equal(stopped.spent(), undefined);
  standIn(t, async (_request, call) => { call.used(took(50)); return says("next"); });
  assert.deepEqual(await stops.complete(ask, {}), says("next"));
  assert.equal(stopped.spent(), "The budget is spent: 100 tokens used of 60.");
});

test("a request waits no longer than its run: what stops the run's agent calls stops it, and what it used is said where the run's are", async () => {
  const stop = new AbortController();
  let given;
  // A backend that answers when it is told to stop, and not before.
  const backend = {
    complete: (_request, call) => {
      given = call;
      return new Promise((_resolve, reject) => { call.signal.addEventListener("abort", () => reject(new Error("Aborted"))); });
    },
  };
  const agent = createAgent(backend, "/nowhere", stop.signal);
  const used = () => {};
  const waiting = agent.complete({ context: { messages: [{ role: "user", content: "hi" }] } }, used);
  assert.equal(given.used, used);
  assert.equal(given.signal.aborted, false);
  stop.abort();
  await assert.rejects(waiting, { message: "Aborted" });
  // (And one that nobody counts for is handed nobody to tell.)
  const beside = createAgent({ complete: async (_request, call) => ({ told: "used" in call }) }, "/nowhere");
  assert.deepEqual(await beside.complete({ context: { messages: [{ role: "user", content: "hi" }] } }), { told: false });
});

/** A program that is its own harness: it asks, runs the tool the model calls, and asks again — until the model answers. */
const LOOPS = `import { ctx, agent } from "@trama-dev/runtime";
const add = { name: "add", description: "Adds two numbers.", parameters: { a: "number", b: "number" }, run: ({ a, b }) => a + b };
const messages = [{ role: "user", content: "What is 2 + 3?" }];
let reply;
try {
  for (;;) {
    reply = await agent.complete({ system: "You add.", messages, tools: [add], maxTokens: 500, ...ctx.input.args.with });
    messages.push(reply);
    if (reply.stopReason !== "toolUse") break;
    for (const call of reply.content.filter((part) => part.type === "toolCall")) {
      messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: String(add.run(call.arguments)) });
    }
  }
  // (What is not there is left out: a result is what JSON can say.)
  await ctx.done(JSON.parse(JSON.stringify({ said: reply.content.find((part) => part.type === "text")?.text, stopped: reply.stopReason, why: reply.errorMessage, messages: messages.length })));
} catch (err) {
  await ctx.done({ failed: String(err.message), messages: messages.length });
}
`;

test("a program asks a model by the bridge: the conversation is the program's, and each request is on record with what it used", async (t) => {
  const projectDir = makeTempDir("trama-complete-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { programSource: LOOPS });
  const requests = [];
  const calls = reply([{ type: "toolCall", id: "c1", name: "add", arguments: { a: 2, b: 3 } }], "toolUse");
  standIn(t, async (request, call) => {
    requests.push(request);
    call.used(took(400));
    return request.context.messages.some((message) => message.role === "toolResult") ? says("5") : calls;
  });

  const result = await runProgram({ projectDir, maxRepairAttempts: 0, timeout: 20_000 });
  assert.deepEqual(result, { status: "done", result: { said: "5", stopped: "stop", messages: 4 } });

  // What the backend was handed: the tool declared and no function, and — the second time — the reply as it came, and the tool's result.
  const tools = [{ name: "add", description: "Adds two numbers.", parameters: { type: "object", additionalProperties: false, required: ["a", "b"], properties: { a: { type: "number" }, b: { type: "number" } } } }];
  assert.deepEqual(requests, [
    { context: { systemPrompt: "You add.", messages: [{ role: "user", content: "What is 2 + 3?" }], tools }, maxTokens: 500 },
    { context: { systemPrompt: "You add.", tools, messages: [
      { role: "user", content: "What is 2 + 3?" }, calls, { role: "toolResult", toolCallId: "c1", toolName: "add", content: [{ type: "text", text: "5" }], isError: false },
    ] }, maxTokens: 500 },
  ]);

  // On record: each request as the program made it, its reply, and what it used — and the run's sum.
  const [records] = journalsOf(projectDir);
  const asked = records.filter((record) => record.kind === "call" && record.endpoint === "/agent/complete");
  assert.deepEqual(asked.map((record) => record.seq), [1, 2]);
  assert.deepEqual(asked[0].request, {
    system: "You add.", messages: [{ role: "user", content: "What is 2 + 3?" }], maxTokens: 500,
    tools: [{ name: "add", description: "Adds two numbers.", parameters: { a: "number", b: "number" } }],
  });
  // The second is written down beside the first: what it has that the first had is not written again — and is put back by whoever reads.
  assert.deepEqual(asked[1].request, {
    messagesBefore: 1, unchanged: ["system", "tools"], maxTokens: 500,
    messages: [calls, { role: "toolResult", toolCallId: "c1", toolName: "add", content: "5" }],
  });
  const whole = requestsWhole(records);
  assert.deepEqual(whole.get(1), asked[0].request);
  assert.deepEqual(whole.get(2), { ...asked[0].request, messages: [...asked[0].request.messages, ...asked[1].request.messages] });
  assert.deepEqual(records.filter((record) => record.kind === "result" && record.seq <= 2).map((record) => [record.ok, record.result.stopReason]), [[true, "toolUse"], [true, "stop"]]);
  assert.deepEqual(records.filter((record) => record.kind === "usage").map(({ seq, model, input, cost }) => ({ seq, model, input, cost })), [
    { seq: 1, model: "p/m", input: 400, cost: 0.4 }, { seq: 2, model: "p/m", input: 400, cost: 0.4 },
  ]);
  const shown = (await captureConsole("log", async () => printJournals(projectDir, "it", {}))).messages.join("\n");
  assert.match(shown, /#1 +agent\/complete +What is 2 \+ 3\? +ok +\d+ms +400 tokens +\$0\.4000$/m);
  // (Of a conversation, the last that was said in it is what the request is known by.)
  assert.match(shown, /#2 +agent\/complete +5 +ok +\d+ms +400 tokens +\$0\.4000$/m);
  assert.match(shown, /end: done +\(800 tokens +\$0\.8000 in all\)$/m);
});

test("a conversation is written down as what each request adds to the one before it, and read back whole", async (t) => {
  const projectDir = makeTempDir("trama-complete-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir);
  const user = (content) => ({ role: "user", content });
  const tools = [{ name: "add", description: "Adds." }];
  const requests = [
    { system: "S", tools, messages: [user("one")] },
    { system: "S", tools, messages: [user("one"), user("two"), user("three")] },
    // A message of before is other than it was (a harness that forgets does that): written again from there on.
    { system: "S", tools, messages: [user("one"), user("TWO"), user("three"), user("four")] },
    // Asked again, as it was.
    { system: "S", tools, messages: [user("one"), user("TWO"), user("three"), user("four")] },
    // What the model is told to be is other than it was: that is written, and what is the same is not.
    { system: "S2", tools, maxTokens: 9, messages: [user("one"), user("TWO"), user("three"), user("four"), user("five")] },
    // Another conversation altogether: whole, as the first.
    { messages: [user("new")] },
  ];
  const journal = openJournal(projectDir, 5, { purpose: "run" });
  // (Another call between two requests changes nothing of how they are written.)
  for (const request of requests) {
    journal.call("/agent/complete", request).end({ ok: true, result: {} });
    journal.call("/tools/read", { path: "a.txt", messages: "not a conversation" }).end({ ok: true, result: "" });
  }
  journal.note("end", {});
  journal.close();
  const records = journalsOf(projectDir)[0];
  const said = ["system", "tools"];
  assert.deepEqual(records.filter((record) => record.kind === "call" && record.endpoint === "/agent/complete").map((record) => record.request), [
    requests[0],
    { messagesBefore: 1, unchanged: said, messages: [user("two"), user("three")] },
    { messagesBefore: 1, unchanged: said, messages: [user("TWO"), user("three"), user("four")] },
    { messagesBefore: 4, unchanged: said, messages: [] },
    { messagesBefore: 4, unchanged: ["tools"], system: "S2", maxTokens: 9, messages: [user("five")] },
    { messages: [user("new")] },
  ]);
  assert.deepEqual(records.filter((record) => record.endpoint === "/tools/read")[0].request, { path: "a.txt", messages: "not a conversation" });
  assert.deepEqual([...requestsWhole(records).values()], requests);
  assert.deepEqual([...requestsWhole(records).keys()], [1, 3, 5, 7, 9, 11]);
  const shown = (await captureConsole("log", async () => printJournals(projectDir, "it", {}))).messages.join("\n");
  assert.match(shown, /#3 +agent\/complete +three +ok/);
  assert.match(shown, /#7 +agent\/complete +\(asked again, as before\) +ok/);
});

test("of what comes back, a program reads what is the model's doing — and is failed by what is not", async (t) => {
  const projectDir = makeTempDir("trama-complete-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { programSource: LOOPS });
  const run = (args = {}, options = {}) => runProgram({ projectDir, args, maxRepairAttempts: 0, timeout: 20_000, ...options });

  // A provider's failure, and a reply cut off at its limit, are replies: whoever is the harness decides what to make of them.
  standIn(t, async () => ({ ...reply([], "error"), errorMessage: "500 the provider is down" }));
  assert.deepEqual((await run()).result, { stopped: "error", why: "500 the provider is down", messages: 2 });
  standIn(t, async () => reply([{ type: "text", text: "The answer is" }], "length"));
  assert.deepEqual((await run()).result, { said: "The answer is", stopped: "length", messages: 2 });

  // What could not be asked fails the call, with why: a model there is none of, and a budget that is spent.
  standIn(t, async () => { throw new Error('Unknown model "p/none". A model is named "provider/model", as pi\'s model catalog has it.'); });
  assert.deepEqual((await run()).result, { failed: 'trama runtime error: Error: Unknown model "p/none". A model is named "provider/model", as pi\'s model catalog has it.', messages: 1 });
  let asked = 0;
  standIn(t, async (_request, call) => { asked += 1; call.used(took(400)); return reply([{ type: "toolCall", id: `c${asked}`, name: "add", arguments: { a: 1, b: 1 } }], "toolUse"); });
  const { result: spent } = await captureConsole("warn", () => run({}, { budget: { calls: 2 } }));
  assert.deepEqual(spent.result, { failed: "trama runtime error: Error: The budget is spent: 2 of 2 calls to a model made.", messages: 5 });
  assert.equal(asked, 2);

  // And a request that is none is the program's mistake: said as one, before anything is asked or counted.
  asked = 0;
  const { result: refused } = await captureConsole("warn", () => run({ with: { messages: [{ role: "user", content: "hi" }, { role: "tool", content: "5" }] } }, { budget: { calls: 2 } }));
  assert.deepEqual(refused.result, { failed: 'trama runtime error: Invalid field: messages[1]: a message\'s role is "user", "assistant" or "toolResult", not "tool"', messages: 1 });
  assert.equal(asked, 0);
  assert.deepEqual((await run({ with: { headers: { "x-key": "k" } } })).result, { failed: "trama runtime error: Unknown field: headers (this call takes: messages, system, tools, model, thinking, maxTokens, temperature, toolChoice, timeout)", messages: 1 });
  // (A tool whose function is missing is declared all the same: nothing here would call it.)
  standIn(t, async (request) => says(JSON.stringify(request.context.tools.map((tool) => tool.name))));
  assert.equal((await run({ with: { tools: [{ name: "only_declared", description: "Is never run." }] } })).result.said, '["only_declared"]');
});

test("a harness type-checks as a program would write one: a reply goes back into the conversation, and its parts are told apart by their type", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "trama-types-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const types = join(REPO_ROOT, "packages", "runtime", "dist", "types.js");
  writeFileSync(join(dir, "program.mts"), `import type { Agent, AgentTool, ModelMessage, ModelReply, ModelRequest, ToolCallPart } from ${JSON.stringify(types)};
declare const agent: Agent;
const add: AgentTool = { name: "add", description: "Adds.", parameters: { a: "number", b: "number" }, run: ({ a, b }: any) => a + b };
const messages: ModelMessage[] = [{ role: "user", content: "What is 2 + 3?" }, { role: "user", content: [{ type: "text", text: "and this?" }, { type: "image", mimeType: "image/png", data: "aGk=" }] }];
const request: ModelRequest = { system: "You add.", messages, tools: [add, { name: "declared", description: "Has no function." }], model: "p/m", thinking: "high", maxTokens: 500, temperature: 0, toolChoice: "none", timeout: 1000 };
const reply: ModelReply = await agent.complete(request);
messages.push(reply);
export const calls: ToolCallPart[] = [];
for (const part of reply.content) {
  if (part.type === "toolCall") {
    calls.push(part);
    messages.push({ role: "toolResult", toolCallId: part.id, toolName: part.name, content: String(part.arguments.a), isError: false });
  } else if (part.type === "text") {
    export_(part.text.toUpperCase());
  } else {
    export_(part.thinking);
  }
}
declare function export_(text: string): void;
export const stopped: "stop" | "toolUse" | "length" | "error" = reply.stopReason;
export const spent: number = reply.usage.input + reply.usage.cost.total;
// (What its provider put on it is carried, and is nothing a program is told the kind of.)
export const carried: unknown = reply.responseId;
// A reply is data: it is kept as state, and comes back as what it was.
const kept: ModelMessage[] = JSON.parse(JSON.stringify(messages));
export const again = await agent.complete({ messages: kept });
// @ts-expect-error — what a model is told to be is the request's system, and no message
messages.push({ role: "system", content: "be brief" });
// @ts-expect-error — a tool's result says whose it is
messages.push({ role: "toolResult", content: "5" });
// @ts-expect-error — a request is a conversation
export const none = await agent.complete({ system: "You add." });
// @ts-expect-error — a model is told to call what it will, or nothing
export const must = await agent.complete({ messages, toolChoice: "required" });
// @ts-expect-error — thinking is a level by name
export const hard = await agent.complete({ messages, thinking: "hard" });
`);
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { noEmit: true, strict: true, target: "es2022", module: "nodenext", moduleResolution: "nodenext", skipLibCheck: true, types: [] },
    files: ["program.mts"],
  }));
  try {
    execFileSync(process.execPath, [join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", dir], { encoding: "utf-8", stdio: "pipe" });
  } catch (err) {
    assert.fail(`the program does not type-check:\n${err.stdout}${err.stderr}`);
  }
});
