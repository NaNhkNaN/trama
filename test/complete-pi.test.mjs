import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { PiAdapter } from "../packages/runtime/dist/pi-adapter.js";
import { createModelRelay, modelNamed } from "../packages/runtime/dist/model-relay.js";
import { user } from "./pi-user.mjs";
import { withEnv } from "./helpers.mjs";

// One request to a model, as pi's own models answer it: asked once, as pi hands a request to a provider, with no
// session of pi's about it. (How a request is held to its shape, counted and recorded is in complete.test.mjs.)

const cost = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 };
const question = { role: "user", content: "What is 2 + 3?" };
const add = { name: "add", description: "Adds two numbers.", parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], additionalProperties: false } };
/** Of what a provider was sent, all but the conversation. */
const besides = ({ messages: _messages, ...rest }) => rest;

/**
 * A user with models of four providers: one that answers (it calls `add` where it is told of it and has no
 * answer of it yet, is cut off where it may say seven tokens, and says "5" otherwise), one that fails, one that
 * never answers, and one there is no key for. The key is whatever TRAMA_TEST_KEY is where a model is asked.
 */
async function models(t) {
  const listening = async (server) => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    return server.address().port;
  };
  const flaky = await listening(createServer((req, res) => {
    req.resume();
    req.on("end", () => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "the provider is down" } })); });
  }));
  const slow = await listening(createServer((req) => { req.resume(); }));
  const it = await user(t, (request, stream) => {
    if (request.max_completion_tokens === 7) {
      stream.says({ role: "assistant", content: "The answer is" });
      stream.says({}, "length");
    } else if ((request.tools ?? []).length > 0 && request.tool_choice !== "none" && !request.messages.some((message) => message.role === "tool")) {
      stream.calls("add", { a: 2, b: 3 });
    } else {
      stream.says({ role: "assistant", content: "5" });
      stream.says({}, "stop");
    }
    stream.done();
  });
  const provider = (port, more = {}) => ({
    baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "$TRAMA_TEST_KEY",
    models: [{ id: "plain", cost }, { id: "thinks", reasoning: true, cost }], ...more,
  });
  it.put(it.agentDir, "models.json", JSON.stringify({ providers: {
    fake: provider(it.port), flaky: provider(flaky), slow: provider(slow), keyless: provider(it.port, { apiKey: "$TRAMA_NO_SUCH_KEY" }),
  } }));
  const env = { ...it.env, TRAMA_TEST_KEY: "the-runners" };
  return { ...it, complete: (request, call = {}, adapter = it.adapter) => withEnv(env, () => adapter.complete(request, call)) };
}

test("a model is asked once, as pi hands a request to a provider — and the conversation goes on by the reply sent back as it came", async (t) => {
  const it = await models(t);
  const used = [];
  const first = await it.complete({ context: { systemPrompt: "You add.", messages: [question], tools: [add] }, maxTokens: 500, temperature: 0 }, { used: (usage) => used.push(usage) });

  // The reply: what the model said — here, that a tool be called — why it stopped, and what that used.
  assert.deepEqual(first.content, [{ type: "toolCall", id: "call-1", name: "add", arguments: { a: 2, b: 3 } }]);
  assert.equal(first.stopReason, "toolUse");
  assert.deepEqual([first.role, first.provider, first.model], ["assistant", "fake", "plain"]);
  assert.deepEqual({ ...first.usage, cost: first.usage.cost.total }, { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 1200, cost: 0.0014 });
  // ...which is said to whoever counts, by pi's price list — once.
  assert.deepEqual(used, [{ model: "fake/plain", input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.0014 }]);

  // What the provider was sent: the request and nothing of an agent's — no prompt of pi's, no tool of pi's — and that once.
  assert.equal(it.requests.length, 1);
  assert.deepEqual(it.requests[0].messages, [{ role: "system", content: "You add." }, { role: "user", content: "What is 2 + 3?" }]);
  assert.deepEqual(it.requests[0].tools, [{ type: "function", function: add }]);
  assert.deepEqual(besides(it.requests[0]), { model: "plain", stream: true, stream_options: { include_usage: true }, store: false, max_completion_tokens: 500, temperature: 0, tools: it.requests[0].tools });
  assert.equal(it.headers[0].authorization, "Bearer the-runners");

  // The conversation gone on: the reply as it came — through JSON, as from a program's state — and what the tool said.
  const kept = JSON.parse(JSON.stringify(first));
  const second = await it.complete({ context: { systemPrompt: "You add.", tools: [add], messages: [
    question, kept, { role: "toolResult", toolCallId: "call-1", toolName: "add", content: [{ type: "text", text: "5" }], isError: false },
  ] } });
  assert.deepEqual([second.content, second.stopReason], [[{ type: "text", text: "5" }], "stop"]);
  assert.deepEqual(it.requests[1].messages, [
    { role: "system", content: "You add." }, { role: "user", content: "What is 2 + 3?" },
    { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "add", arguments: '{"a":2,"b":3}' } }] },
    { role: "tool", content: "5", tool_call_id: "call-1" },
  ]);
  // (Nothing is kept between the two: each is the request it is.)
  assert.equal(it.requests.length, 2);

  // Told of tools and told to call none, the model is asked so.
  const without = await it.complete({ context: { messages: [question], tools: [add] }, toolChoice: "none" });
  assert.equal(without.stopReason, "stop");
  assert.equal(it.requests[2].tool_choice, "none");
});

test("the model is the one named, or the project's — and one that cannot be asked as the request would have it is not asked", async (t) => {
  const it = await models(t);
  const ask = { context: { messages: [question] } };
  const refused = async (request, words, adapter) => {
    const before = it.requests.length;
    await assert.rejects(it.complete(request, {}, adapter), { message: words });
    assert.equal(it.requests.length, before);
  };

  // By name, and thinking at a level it has: as its provider is told to.
  assert.equal((await it.complete({ ...ask, model: "fake/thinks", thinking: "high" })).model, "thinks");
  assert.deepEqual(besides(it.requests.at(-1)), { model: "thinks", stream: true, stream_options: { include_usage: true }, store: false, max_completion_tokens: 16384, reasoning_effort: "high" });
  // (Not at all is a level every model has.)
  await it.complete({ ...ask, thinking: "off" });
  assert.deepEqual(besides(it.requests.at(-1)), { model: "plain", stream: true, stream_options: { include_usage: true }, store: false, max_completion_tokens: 16384 });

  // A level the model has not got: pi would give the nearest without a word. A model pi has not got, by name or as
  // the project's; and one there is no key for.
  await refused({ ...ask, thinking: "high" }, 'The model fake/plain does not think at level "high". Its levels: off.');
  await refused({ ...ask, model: "fake/thinks", thinking: "max" }, 'The model fake/thinks does not think at level "max". Its levels: off, minimal, low, medium, high.');
  await refused({ ...ask, model: "fake/none" }, 'Unknown model "fake/none". A model is named "provider/model", as pi\'s model catalog has it.');
  await refused({ ...ask, model: "nowhere/plain" }, 'Unknown model "nowhere/plain". A model is named "provider/model", as pi\'s model catalog has it.');
  await refused({ ...ask, model: "keyless/plain" }, 'The model keyless/plain cannot be asked: pi has no key for the provider "keyless".');
  const gone = new PiAdapter({ provider: "fake", model: "gone" });
  t.after(() => gone.close());
  await refused(ask, "The project's model, fake/gone, is not one pi has. A request to a model is answered by the model it names, or by the project's: there is no agent here whose own choice it could fall back on.", gone);
  // (...which a request that names one does not need.)
  assert.equal((await it.complete({ ...ask, model: "fake/plain" }, {}, gone)).stopReason, "stop");
});

test("what is the provider's doing is a reply: one that failed, one that was cut off, one that did not come in time — and a request that is cancelled rejects", async (t) => {
  const it = await models(t);
  const ask = { context: { messages: [question] } };
  const used = [];
  const heard = { used: (usage) => used.push(usage) };

  // Failed: said in the reply, and asked once — whether to ask again is for whoever is the harness.
  const failed = await it.complete({ ...ask, model: "flaky/plain" }, heard);
  assert.deepEqual([failed.stopReason, failed.errorMessage, failed.content], ["error", '500: {"message":"the provider is down"}', []]);
  // (What used nothing is not said to have used anything.)
  assert.deepEqual(used, []);

  // Cut off at its limit: what there was of it, and that it was — and it was paid for.
  const cut = await it.complete({ ...ask, maxTokens: 7 }, heard);
  assert.deepEqual([cut.stopReason, cut.content], ["length", [{ type: "text", text: "The answer is" }]]);
  assert.equal(used.length, 1);

  // Not in time: as long as the request says a provider is waited for.
  const began = Date.now();
  const late = await it.complete({ ...ask, model: "slow/plain", timeout: 300 }, heard);
  assert.equal(late.stopReason, "error");
  assert.match(late.errorMessage, /timed out/i);
  assert.ok(Date.now() - began < 5000, "it waited no longer than it was told to");

  // Cancelled: no reply — the call is over, and the provider is let go of.
  const stop = new AbortController();
  const waiting = it.complete({ ...ask, model: "slow/plain" }, { signal: stop.signal });
  setTimeout(() => stop.abort(), 200);
  await assert.rejects(waiting, { message: "Aborted" });
  stop.abort();
  await assert.rejects(it.complete(ask, { signal: stop.signal }), { message: "Aborted" });
  assert.equal(used.length, 1);
});

test("a run that has variables has its models asked with them: by a process started with them, which is where its key is", async (t) => {
  const it = await models(t);
  const apart = new PiAdapter({ provider: "fake", model: "plain" }, { ...it.env, TRAMA_TEST_KEY: "the-runs" });
  t.after(() => apart.close());
  const used = [];
  const reply = await it.complete({ context: { messages: [question] } }, { used: (usage) => used.push(usage) }, apart);
  assert.deepEqual([reply.content, reply.stopReason], [[{ type: "text", text: "5" }], "stop"]);
  // (This process has another key, and it is not the one that was sent.)
  assert.equal(it.headers.at(-1).authorization, "Bearer the-runs");
  assert.deepEqual(used, [{ model: "fake/plain", input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.0014 }]);
  // What stands against asking is said from there as from here.
  await assert.rejects(it.complete({ context: { messages: [question] }, model: "fake/none" }, {}, apart), { message: 'Unknown model "fake/none". A model is named "provider/model", as pi\'s model catalog has it.' });
  await assert.rejects(it.complete({ context: { messages: [question] }, thinking: "high" }, {}, apart), { message: 'The model fake/plain does not think at level "high". Its levels: off.' });
  // And its own adapter, beside: with this process's key, as before.
  await it.complete({ context: { messages: [question] } });
  assert.equal(it.headers.at(-1).authorization, "Bearer the-runners");
});

test("a model is found by its name where either part of the name may have strokes of its own; and a relay asked by name answers for itself", async (t) => {
  const has = (...names) => ({ getModel: (provider, id) => (names.includes(`${provider}|${id}`) ? `${provider}|${id}` : undefined) });
  assert.equal(modelNamed(has("openrouter|meta/llama"), "openrouter/meta/llama"), "openrouter|meta/llama");
  assert.equal(modelNamed(has("a/b|c"), "a/b/c"), "a/b|c");
  // (Of two it could be, the provider whose name is shorter.)
  assert.equal(modelNamed(has("a/b|c", "a|b/c"), "a/b/c"), "a|b/c");
  assert.equal(modelNamed(has("a|b"), "a/c"), undefined);
  assert.equal(modelNamed(has("a|b"), "ab"), undefined);

  // By name, a relay is never one to say "ask it yourself": whoever asks so has nothing to ask by.
  const it = await models(t);
  const relay = createModelRelay();
  t.after(() => relay.close());
  const last = (request) => withEnv({ ...it.env, TRAMA_TEST_KEY: "k" }, async () => {
    let event;
    for await (event of await relay.ask(request)) { /* to the last */ }
    return event;
  });
  const context = { messages: [question] };
  const unknown = await last({ named: "fake/none", model: { provider: "fake", id: "none" }, context, options: {} });
  assert.deepEqual([unknown.type, unknown.unasked, unknown.error.stopReason], ["error", "model", "error"]);
  assert.equal((await last({ named: "keyless/plain", model: { provider: "keyless", id: "plain" }, context, options: {} })).unasked, "key");
  assert.equal((await last({ named: "fake/plain", model: { provider: "fake", id: "plain" }, context, options: { reasoning: "low" } })).unasked, "thinking");
  const asked = await last({ named: "fake/plain", model: { provider: "", id: "" }, context, options: {} });
  assert.deepEqual([asked.type, asked.unasked, asked.message.content], ["done", undefined, [{ type: "text", text: "5" }]]);
  // (And one that is not by name is held to its model to the letter, as it was: what is not that is not asked here.)
  assert.equal(await withEnv({ ...it.env, TRAMA_TEST_KEY: "k" }, () => relay.ask({ model: { provider: "fake", id: "plain" }, context, options: {} })), undefined);
});
