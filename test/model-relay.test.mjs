import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { setTimeout as later } from "node:timers/promises";
import { PiAdapter } from "../packages/runtime/dist/pi-adapter.js";
import { createMeter } from "../packages/runtime/dist/budget.js";
import { CutOff } from "../packages/runtime/dist/agent-backend.js";
import { createBackend } from "../packages/runtime/dist/runner.js";
import { createModelRelay, dataOf, isData, leaner, marked, notAsked, relayClient, relayServer, unmarked, usageAtEnd, whole, wholeOf } from "../packages/runtime/dist/model-relay.js";
import { EXTENSION, hostsHere, user } from "./pi-user.mjs";
import { isAlive, waitFor, withEnv } from "./helpers.mjs";

// Where a model is asked, and what is made of what it used. trama stands where pi hands a request to a
// provider: there a call is asked whether its model may be asked again, and there a reply's usage is seen.
// And a call that has extensions has its model asked by its runner, where it can be: the count is then
// read where no extension is.

const total = (usage) => usage.input + usage.output;
const keyOf = (headers) => headers.authorization;
/** The user's models, with a key that is whatever TRAMA_TEST_KEY is where the model is asked: which says who asked. */
const withKeyBy = (it) => it.put(it.agentDir, "models.json", JSON.stringify({ providers: { fake: {
  baseUrl: `http://127.0.0.1:${it.port}/v1`, api: "openai-completions", apiKey: "$TRAMA_TEST_KEY",
  // (A header the provider's every request goes with, unless a request says otherwise.)
  headers: { "x-configured": "yes" },
  models: [
    { id: "plain", cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } },
    // A model whose prompt cache does not last, and is dear to miss: pi keeps such a cache warm, by requests of its own.
    { id: "warm", cost: { input: 1000, output: 2, cacheRead: 0.5, cacheWrite: 0 }, promptCache: { short: 11 } },
    // A model that thinks: its provider has an option of its own for how hard.
    { id: "thinks", reasoning: true, cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } },
    // A model that is sampled its own way.
    { id: "sampled", samplingParams: { top_p: 0.5, seed: 7 }, cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } },
  ],
} } }));
/** A call, with the key the runner has at the time. */
const askedWith = (it, key, prompt, call = {}) => withEnv({ ...it.env, TRAMA_TEST_KEY: key }, () => it.adapter.ask(prompt, { cwd: it.cwd, ...call }));
/** A model that has the agent use the extension's tool where it has one, then answers. */
const usesTheTool = (request, stream) => {
  const tools = (request.tools ?? []).map((tool) => tool.function.name);
  if (tools.includes("mine_tool") && !request.messages.some((message) => message.role === "tool")) stream.calls("mine_tool");
  else { stream.says({ role: "assistant", content: "hello from the fake" }); stream.says({}, "stop"); }
  stream.done();
};
/** An extension's code that has its process say next to nothing of what its call used, whatever it used. */
const SAYS_LITTLE = `if (!globalThis.saysLittle) {
    globalThis.saysLittle = true;
    const send = process.send?.bind(process);
    if (send) process.send = (message, ...rest) => {
      const of = ["sofar", "had", "used"].find((word) => message && typeof message === "object" && word in message);
      return send(of ? { [of]: { ...message[of], input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } } : message, ...rest);
    };
  }`;
/**
 * An extension's code that asks the model something for itself, by pi, when `event` comes — each of the ways named,
 * in turn — and writes down how each went. As pi's agent asks ("streamSimple"); by the options of the model's own
 * provider ("complete"); and so, with a hand of its own in the asking ("itself": it would see what the provider is
 * sent) — which is asked where the extension is, whoever asks its call's model otherwise.
 */
const ASKS_AT = (event, ...ways) => `pi.on("${event}", async (_event, ctx) => {
    const context = { messages: [{ role: "user", content: [{ type: "text", text: "an extension asks" }], timestamp: Date.now() }] };
    for (const way of ${JSON.stringify(ways)}) {
      const reply = way === "streamSimple" ? await ctx.modelRegistry.streamSimple(ctx.model, context, {}).result() : await ctx.modelRegistry.complete(ctx.model, context, way === "itself" ? { onPayload: () => undefined } : {});
      note("asked for itself at ${event}, by " + way + ": " + reply.stopReason);
    }
  });`;
/** The processes that serve this process's calls, or ask models for them. */
const hostsOfMine = () => execFileSync("ps", ["-Ao", "pid=,ppid=,command="], { encoding: "utf-8" }).split("\n")
  .filter((line) => line.includes("agent-host.js") && Number(line.trim().split(/\s+/)[1]) === process.pid).map((line) => Number(line.trim().split(/\s+/)[0]));

test("the model of a call that has extensions is asked by the call's runner: with the runner's key, whatever the process that serves the call has", async (t) => {
  const it = await user(t, usesTheTool);
  withKeyBy(it);
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine"));

  // The process that serves the calls is started with one key...
  assert.equal(await askedWith(it, "the first", "say hello", { extensions: true }), "hello from the fake");
  const [host] = it.pids();
  assert.notEqual(host, process.pid);
  // ...and the runner has another by the time of the next call: the model is asked with the runner's.
  const said = [];
  assert.equal(await askedWith(it, "the second", "say hello", { extensions: true, sofar: (usage) => said.push(["sofar", total(usage)]), used: (usage) => said.push(["used", total(usage), usage.model]) }), "hello from the fake");
  assert.deepEqual(it.pids(), [host], "the same process served both");
  assert.deepEqual(it.headers.slice(-2).map(keyOf), ["Bearer the second", "Bearer the second"]);
  // What the call used is said as it always was; and the extension's tool was used where the extension is.
  assert.deepEqual(said, [["sofar", 1200], ["used", 2400, "fake/plain"]]);
  assert.match(JSON.stringify(it.requests.at(-1).messages), /the mine tool answers/);
  assert.ok(it.seen().every(([pid]) => pid === host));

  // A call without extensions is asked for here, as it always was; and nothing but a call's model is asked by anybody else.
  assert.equal(await askedWith(it, "the third", "say hello"), "hello from the fake");
  assert.equal(keyOf(it.headers.at(-1)), "Bearer the third");
});

test("what a call used is what its runner saw its model's replies use, whatever the call's process says of it", async (t) => {
  const it = await user(t, (request, stream) => {
    // A model that has the agent read a file, twice, before it answers.
    const read = request.messages.filter((message) => message.role === "tool").length;
    if (read < 2) stream.calls("read", { path: "a.txt" });
    else { stream.says({ role: "assistant", content: "hello from the fake" }); stream.says({}, "stop"); }
    stream.done();
  });
  withKeyBy(it);
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", SAYS_LITTLE));

  const said = [];
  assert.equal(await askedWith(it, "a key", "read a.txt, twice", { extensions: true, sofar: (usage) => said.push(["sofar", total(usage)]), used: (usage) => said.push(["used", total(usage)]) }), "hello from the fake");
  assert.deepEqual(said, [["sofar", 1200], ["sofar", 2400], ["used", 3600]]);

  // And so a budget holds such a call where it holds any: at what it used, not at what was said of it.
  await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, async () => {
    const backend = createBackend({ provider: "fake", model: "plain" }, createMeter({ tokens: 2000 }));
    t.after(() => backend.close());
    const before = it.requests.length;
    await assert.rejects(() => backend.ask("read a.txt, twice", { cwd: it.cwd, extensions: true }), /The budget is spent: 2400 tokens used of 2000/);
    assert.equal(it.requests.length, before + 2, "the third request was not made");
  });
});

test("a model is asked where the call is served, as it always was, where an extension has a hand in the asking — and the count is then that process's word", async (t) => {
  const hands = {
    "it has made the model's provider its own": `pi.registerProvider("fake", { headers: { "x-from": "the extension" } });`,
    "it reads what a provider is sent, and may change it": `pi.on("before_provider_request", (event) => ({ ...event.payload, user: "an extension's" }));`,
    "it hears what a provider answers": `pi.on("after_provider_response", () => {});`,
  };
  for (const [how, body] of Object.entries(hands)) {
    const it = await user(t);
    withKeyBy(it);
    it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `${SAYS_LITTLE}\n  ${body}`));
    await askedWith(it, "the first", "say hello", { extensions: true });
    const said = [];
    assert.equal(await askedWith(it, "the second", "say hello", { extensions: true, used: (usage) => said.push(total(usage)) }), "hello from the fake", how);
    // Asked by the process that serves the call — the key is the one it was started with — and as the extension would have it.
    assert.equal(keyOf(it.headers.at(-1)), "Bearer the first", how);
    if (how.includes("its own")) assert.equal(it.headers.at(-1)["x-from"], "the extension");
    if (how.includes("change it")) assert.equal(it.requests.at(-1).user, "an extension's");
    assert.deepEqual(said, [1], `${how}: what was used is what that process said`);
  }
});

test("what an extension asks a model for itself is on its call's account: counted, held to the call's budget, and not asked once the call is cancelled or its session gone", async (t) => {
  // (An extension that also asks once more when its session is gone: something it started and did not wait for.)
  const ASKS_AFTER = `pi.on("session_shutdown", (_event, ctx) => {
    // (Where it writes things down is kept from now: by then the test's own process no longer says where.)
    const models = ctx.modelRegistry, model = ctx.model, seen = process.env.TRAMA_TEST_SEEN;
    const late = (what) => appendFileSync(seen, process.pid + " " + what + "\\n");
    const context = { messages: [{ role: "user", content: [{ type: "text", text: "an extension asks, late" }], timestamp: Date.now() }] };
    setTimeout(() => models.streamSimple(model, context, {}).result().then((reply) => late("asked for itself after all was over: " + reply.stopReason), (err) => late("asked after all was over, and it threw: " + err.message)), 300);
  });`;
  const asked = (it) => it.seen().map(([, what]) => what).filter((what) => what.startsWith("asked"));
  for (const where of ["here", "in a process of its own"]) {
    const it = await user(t);
    withKeyBy(it);
    it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `${ASKS_AT("agent_end", "streamSimple", "complete", "itself")}\n  ${ASKS_AT("session_shutdown", "streamSimple")}\n  ${ASKS_AFTER}`));
    // (Served here by the adapter itself, as a host serves a call; or by a host.)
    const ask = (prompt, call) => withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, () => (where === "here" ? it.adapter.serve(prompt, { cwd: it.cwd, ...call }) : it.adapter.ask(prompt, { cwd: it.cwd, ...call })));

    const said = [], had = [];
    assert.equal(await ask("say hello", { extensions: true, had: (usage) => had.push(total(usage)), sofar: (usage) => said.push(["sofar", total(usage)]), used: (usage) => said.push(["used", total(usage)]) }), "hello from the fake", where);
    // (Whoever counts was told as each of the five replies came — whoever asked for it, by whichever way, and the last
    // as the session was ending — and not only before the next request, or at the end.)
    assert.deepEqual([...new Set(had)], [1200, 2400, 3600, 4800, 6000], where);
    // The agent's request, and the extension's four — by each of pi's ways of asking, the last as it was told that
    // its session was over (to sum up what was done, say): each used something, what had been used was said before
    // each of them was made, and what the call used in the end has all of them.
    assert.deepEqual(asked(it), ["asked for itself at agent_end, by streamSimple: stop", "asked for itself at agent_end, by complete: stop", "asked for itself at agent_end, by itself: stop", "asked for itself at session_shutdown, by streamSimple: stop"], where);
    assert.equal(it.requests.length, 5, where);
    assert.deepEqual(said, [["sofar", 1200], ["sofar", 2400], ["sofar", 3600], ["sofar", 4800], ["used", 6000]], where);
    // Once its session was gone, nothing more was asked on its account.
    await waitFor(() => asked(it).length === 5, "what the extension asked late to have ended");
    assert.equal(asked(it)[4], "asked for itself after all was over: aborted", where);
    assert.equal(it.requests.length, 5, where);

    // Under a budget its request is one the call may not have: the model is not asked.
    await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, async () => {
      const backend = createBackend({ provider: "fake", model: "plain" }, createMeter({ tokens: 1000 }));
      t.after(() => backend.close());
      // (A backend's calls with extensions are served by hosts: here that is what is asked of it either way.)
      await assert.rejects(() => backend.ask("say hello", { cwd: it.cwd, extensions: true }), /The budget is spent: 1200 tokens used of 1000/, where);
      assert.equal(it.requests.length, 6, `${where}: the extension's requests were not made`);
    });
  }

  // Where the call is served, by what serves it: whoever hears what the call has used cancels it there, and the model is
  // not asked — nor is anything more said of a call that is cancelled, whatever would have its model asked after.
  {
    const it = await user(t);
    withKeyBy(it);
    it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", ASKS_AT("agent_end", "streamSimple", "complete")));
    const stop = new AbortController(), said = [];
    const call = withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, () => it.adapter.serve("say hello", {
      cwd: it.cwd, extensions: true, signal: stop.signal,
      sofar: (usage) => { said.push(total(usage)); stop.abort(); },
    }));
    await assert.rejects(call, /Aborted/);
    assert.deepEqual(asked(it), ["asked for itself at agent_end, by streamSimple: aborted", "asked for itself at agent_end, by complete: aborted"]);
    assert.equal(it.requests.length, 1);
    assert.deepEqual(said, [1200]);
  }

  // And a call that is cancelled while whoever was to hear has yet to answer is not held by them.
  {
    const it = await user(t, usesTheTool);
    withKeyBy(it);
    it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine"));
    const stop = new AbortController();
    let told;
    const heard = new Promise((resolve) => { told = resolve; });
    const call = withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, () => it.adapter.serve("say hello", {
      cwd: it.cwd, extensions: true, signal: stop.signal, sofar: () => { told(); return new Promise(() => {}); },
    }));
    call.catch(() => {});
    await heard;
    const started = Date.now();
    stop.abort();
    await assert.rejects(call, /Aborted/);
    assert.ok(Date.now() - started < 2_000, `it was let go of at once: ${Date.now() - started}ms`);
    assert.equal(it.requests.length, 1);
  }
});

test("a request pi makes of its own to keep a provider's cache warm is the call's too: said before it is made, counted, and not made for a call that is out of budget", async (t) => {
  const warmed = { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, prompt_tokens_details: { cached_tokens: 400 } };
  const holds = (event) => EXTENSION("mine", `pi.on("${event}", () => new Promise((resolve) => setTimeout(resolve, 2500)));`);
  const one = async (event) => {
    const it = await user(t, (_request, stream) => { stream.says({ role: "assistant", content: "hello from the fake" }); stream.says({}, "stop"); stream.done(warmed); });
    withKeyBy(it);
    it.put(it.agentDir, "extensions/mine.ts", holds(event));
    const config = { provider: "fake", model: "warm" };
    const adapter = new PiAdapter(config);
    t.after(() => adapter.close());
    return { it, config, serve: (call) => withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, () => adapter.serve("say hello", { cwd: it.cwd, extensions: true, ...call })) };
  };

  // While the call is under way — its agent done, an extension still hearing of that, or of the session's end — pi asks
  // again by itself: the call is told first, and what the call used in the end has it.
  for (const event of ["agent_end", "session_shutdown"]) {
    const { it, serve } = await one(event);
    const said = [];
    assert.equal(await serve({ sofar: (usage) => said.push(["sofar", it.requests.length]), used: (usage) => said.push(["used", usage.input + usage.cacheRead + usage.output]) }), "hello from the fake");
    assert.ok(it.requests.length >= 2, `pi asked again to keep the cache warm: ${it.requests.length} requests`);
    // (Each such request was said before it was made — when one request had been made, and then two — and what it used is in the count.)
    assert.deepEqual(said.slice(0, -1), it.requests.slice(1).map((_request, at) => ["sofar", at + 1]));
    assert.deepEqual(said.at(-1), ["used", 1200 * it.requests.length]);
  }

  // Served in a process of its own, such a request is asked by the runner, as the agent's turns are.
  {
    const { it, config } = await one("agent_end");
    const hosted = new PiAdapter(config);
    t.after(() => hosted.close());
    const ask = (key) => withEnv({ ...it.env, TRAMA_TEST_KEY: key }, () => hosted.ask("say hello", { cwd: it.cwd, extensions: true }));
    await ask("the first");
    const before = it.requests.length;
    await ask("the second");
    assert.ok(it.requests.length - before >= 2, `pi asked again to keep the cache warm: ${it.requests.length - before} requests`);
    assert.deepEqual(it.headers.slice(before).map(keyOf), it.requests.slice(before).map(() => "Bearer the second"));
  }

  // And a call whose budget is spent by its one answer has no cache kept warm at more cost.
  {
    const { it, config } = await one("agent_end");
    await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, async () => {
      const backend = createBackend(config, createMeter({ tokens: 1000 }));
      t.after(() => backend.close());
      await assert.rejects(() => backend.ask("say hello", { cwd: it.cwd, extensions: true }), /The budget is spent/);
      assert.equal(it.requests.length, 1);
    });
  }
});

test("the calls of a run that was given variables have their models asked by a process started with the same, which serves no call", async (t) => {
  let hold = false;
  const held = [];
  const it = await user(t, (request, stream) => (hold ? held.push(request) : usesTheTool(request, stream)));
  withKeyBy(it);
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", SAYS_LITTLE));
  const theirs = new PiAdapter({ provider: "fake", model: "plain" }, { TRAMA_TEST_KEY: "the run's" });
  t.after(() => theirs.close());
  const ask = (call) => withEnv({ ...it.env, TRAMA_TEST_KEY: "the runner's" }, () => theirs.ask("say hello", { cwd: it.cwd, ...call }));
  // Without extensions: one process, which serves the call and asks its model — there is nobody's code in it but pi's and trama's.
  await ask({});
  assert.equal(keyOf(it.headers.at(-1)), "Bearer the run's");
  assert.equal(hostsHere(), 1);

  // With them: the process that serves the call, and one beside it that asks — with the run's key, and counting for itself.
  const said = [];
  assert.equal(await ask({ extensions: true, used: (usage) => said.push(total(usage)) }), "hello from the fake");
  assert.deepEqual(it.headers.slice(-2).map(keyOf), ["Bearer the run's", "Bearer the run's"]);
  assert.deepEqual(said, [2400], "what the model's replies used, though the call's process said next to nothing");
  assert.equal(hostsHere(), 2);

  // The one that asks is lost: the next call has another.
  const [asker] = hostsOfMine().filter((pid) => !it.pids().includes(pid));
  process.kill(asker, "SIGKILL");
  await waitFor(() => !isAlive(asker), "the process that asks to be gone");
  said.length = 0;
  assert.equal(await ask({ extensions: true, used: (usage) => said.push(total(usage)) }), "hello from the fake");
  assert.deepEqual(said, [2400]);
  assert.equal(hostsHere(), 2);

  // ...and a call whose model was being asked when it was lost is not left waiting: the request ends there.
  hold = true;
  const waiting = ask({ extensions: true });
  waiting.catch(() => {});
  await waitFor(() => held.length === 1, "the model to be asked");
  const [again] = hostsOfMine().filter((pid) => !it.pids().includes(pid));
  process.kill(again, "SIGKILL");
  await assert.rejects(waiting, /The process that was asking the model ended before the reply had come\./);
  hold = false;

  // They end with what they were for.
  await theirs.close();
  assert.equal(hostsHere(), 0);
});

test("an event of a reply is sent with what it adds, and is given the reply so far again where it is wanted", () => {
  // The events of a reply as pi makes them: every one but the last with the whole reply so far — one object, which goes on changing.
  const partial = { role: "assistant", content: [], model: "plain", usage: { input: 0, output: 0 } };
  const events = [];
  const push = (event) => events.push({ ...event, partial });
  push({ type: "start" });
  partial.content.push({ type: "thinking", thinking: "", signature: "s" });
  push({ type: "thinking_start", contentIndex: 0 });
  partial.content[0].thinking += "hm";
  push({ type: "thinking_delta", contentIndex: 0, delta: "hm" });
  push({ type: "thinking_end", contentIndex: 0, content: "hm" });
  partial.content.push({ type: "text", text: "" });
  push({ type: "text_start", contentIndex: 1 });
  for (const delta of ["hel", "lo ", "there"]) {
    partial.content[1].text += delta;
    push({ type: "text_delta", contentIndex: 1, delta });
  }
  push({ type: "text_end", contentIndex: 1, content: "hello there" });
  partial.content.push({ type: "toolCall", id: "c1", name: "read", arguments: {} });
  push({ type: "toolcall_start", contentIndex: 2 });
  partial.content[2].arguments = { path: "a.txt" };
  push({ type: "toolcall_delta", contentIndex: 2, delta: '{"path":"a.txt"}' });
  push({ type: "toolcall_end", contentIndex: 2, toolCall: partial.content[2] });
  partial.usage = { input: 1000, output: 200 };
  const message = { ...partial, stopReason: "toolUse" };
  events.push({ type: "done", reason: "toolUse", message });

  // Sent late — when the reply is already whole, as an event read a moment after it was made may be — and read again.
  const lean = leaner();
  const sent = events.map((event) => JSON.parse(JSON.stringify(lean(event))));
  assert.ok(sent.slice(0, -1).every((event) => !("partial" in event)), "no event but the last carries the reply");
  assert.ok(JSON.stringify(sent[6]).length < 200, "a word of the text is sent as that word");
  const state = {};
  const read = sent.map((event) => whole(event, state));
  // The words are those that had come by each event, and no more: they are put together from what each added.
  assert.deepEqual(read.map((event) => event.partial?.content[1]?.text), [undefined, undefined, undefined, undefined, "", "hel", "hello ", "hello there", "hello there", "hello there", "hello there", "hello there", undefined]);
  assert.deepEqual(read[3].partial.content[0], { type: "thinking", thinking: "hm", signature: "s" });
  assert.deepEqual(read.at(-2).partial.content, message.content);
  assert.deepEqual(read.at(-2).partial.model, "plain");
  assert.deepEqual(read.at(-1), JSON.parse(JSON.stringify(events.at(-1))), "the last is the reply, whole, as it was");
  assert.deepEqual(read.map((event) => event.type), events.map((event) => event.type));
  assert.deepEqual(usageAtEnd(read.at(-1)), { input: 1000, output: 200 });
  assert.equal(usageAtEnd(read[0]), undefined);

  // A tool call's arguments can only be sent whole — pi puts them together in its own way — and are not sent whole with
  // every piece of them once they are long: what is sent of a long one grows with its length, not with its square.
  const call = { type: "toolCall", id: "c2", name: "write", arguments: { text: "" } };
  const long = { role: "assistant", content: [call] };
  const pieces = 5000, piece = "x".repeat(40);
  const other = leaner(), back = {};
  let sentBytes = 0, wholes = 0, shown = "";
  const through = (event) => {
    const wire = JSON.stringify(other({ ...event, partial: long }));
    sentBytes += wire.length;
    if (wire.includes('"block"')) wholes += 1;
    return whole(JSON.parse(wire), back);
  };
  through({ type: "start" });
  through({ type: "toolcall_start", contentIndex: 0 });
  for (let at = 0; at < pieces; at++) {
    call.arguments.text += piece;
    shown = through({ type: "toolcall_delta", contentIndex: 0, delta: piece }).partial.content[0].arguments.text;
    // (While it is short it is shown as it is; after, as it was a little while before — never as more than it is.)
    if (at < 200) assert.equal(shown.length, call.arguments.text.length);
    assert.ok(shown.length <= call.arguments.text.length && shown.length >= call.arguments.text.length / 1.6, `piece ${at}: shown ${shown.length} of ${call.arguments.text.length}`);
  }
  assert.equal(through({ type: "toolcall_end", contentIndex: 0, toolCall: call }).partial.content[0].arguments.text.length, pieces * piece.length);
  assert.ok(wholes < 240, `sent whole ${wholes} times for ${pieces} pieces`);
  assert.ok(sentBytes < 12 * pieces * piece.length, `${sentBytes} bytes sent for ${pieces * piece.length} of arguments`);
});

test("a request goes over a channel and its reply comes back: served, not served, refused, cancelled, and ended when either end is done", async () => {
  const model = { provider: "fake", id: "plain", api: "openai-completions" };
  const reply = (text, usage) => ({ type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text }], usage: { input: usage, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
  // Somebody who asks: knows one model, answers in two events, and waits to be cancelled where asked to.
  const cancelled = [];
  const asked = [];
  const knows = {
    async ask(request, signal) {
      asked.push(request);
      if (request.model.id !== "plain") return undefined;
      return (async function* () {
        if (request.context === "wait") {
          await new Promise((resolve) => signal.addEventListener("abort", resolve));
          cancelled.push(request.context);
          yield notAsked(request.model, "Aborted");
          return;
        }
        yield { type: "start", partial: { content: [] } };
        yield reply(`answer to ${request.context}`, 7);
      })();
    },
  };
  // The two ends, joined as two processes would join them: each message a copy, and a turn later.
  let refuse = false;
  const used = [];
  const sent = [];
  const later = (to) => (message) => { const copy = JSON.parse(JSON.stringify(message)); sent.push(JSON.parse(JSON.stringify(message))); setImmediate(() => to(copy)); };
  const server = relayServer(knows, later((answer) => client.heard(answer.relayed)), { refuse: () => refuse, replied: (usage) => used.push(usage.input) });
  const client = relayClient(later((message) => server.heard(message)));
  const all = async (events) => { const got = []; for await (const event of events) got.push(event); return got; };

  // Served: the events, to the last; and what the reply used is told where it was served.
  const served = await all(await client.relay.ask({ model, context: "one", options: {} }));
  assert.deepEqual(served.map((event) => event.type), ["start", "done"]);
  assert.equal(served[1].message.content[0].text, "answer to one");
  assert.deepEqual(used, [7]);
  // What goes with a request is what it was on the other side: also where a record has nothing under a name, which the
  // channel itself does not say — and the name is where it was among the record's names.
  const options = { temperature: 0, nothing: undefined, headers: { "x-configured": undefined, "X-Configured": "mine", "x-own": "said" }, deep: [{ list: [{ unset: undefined, set: null }] }] };
  await all(await client.relay.ask({ model, context: "one", options }));
  assert.deepEqual(asked.at(-1).options, options);
  assert.deepEqual([Object.keys(asked.at(-1).options), Object.keys(asked.at(-1).options.headers), Object.keys(asked.at(-1).options.deep[0].list[0])], [["temperature", "nothing", "headers", "deep"], ["x-configured", "X-Configured", "x-own"], ["unset", "set"]]);
  // (Said beside the request by a word that is under each such name on the way; and nothing is said beside a request that has none.)
  const [plain, sparse] = sent.filter((message) => "relay" in message).map((message) => message.relay);
  assert.equal("mark" in plain, false);
  assert.deepEqual(plain.request.options, {});
  assert.match(sparse.mark, /^nothing:[0-9a-f-]{36}$/);
  assert.deepEqual(sparse.request.options, { temperature: 0, nothing: sparse.mark, headers: { "x-configured": sparse.mark, "X-Configured": "mine", "x-own": "said" }, deep: [{ list: [{ unset: sparse.mark, set: null }] }] });
  // A request by a number another is being asked by is not served: nothing is asked, and the other is not disturbed.
  const first = client.relay.ask({ model, context: "wait", options: {} });
  await waitFor(() => asked.at(-1)?.context === "wait", "the request to be being asked", 2000);
  const at = asked.length, number = sent.findLast((message) => "relay" in message).relay.id;
  server.heard({ relay: { id: number, request: { model, context: "one", options: {} } } });
  // And one that goes with what cannot be gone through is not served, and fails nobody.
  let deep = {};
  for (let depth = 0; depth < 100_000; depth += 1) deep = { deep };
  server.heard({ relay: { id: 10_000, request: { model, context: "one", options: deep }, mark: "x" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(asked.length, at);
  assert.deepEqual(sent.at(-1), { relayed: { id: 10_000, not: true } });
  server.heard({ relayAbort: number });
  assert.deepEqual((await all(await first)).map((event) => event.error.errorMessage), ["Aborted"]);
  cancelled.length = 0;
  // Not one the other end can ask: nothing comes, and whoever asked knows to ask by itself.
  assert.equal(await client.relay.ask({ model: { ...model, id: "other" }, context: "two", options: {} }), undefined);
  // Refused: it ends as a request that was cancelled, and nothing was asked.
  refuse = true;
  const refused = await all(await client.relay.ask({ model, context: "three", options: {} }));
  assert.deepEqual(refused.map((event) => [event.type, event.reason, event.error.stopReason, event.error.usage.input]), [["error", "aborted", "aborted", 0]]);
  refuse = false;
  // Cancelled by whoever asked: the other end is told, and stops asking.
  const stop = new AbortController();
  const waiting = client.relay.ask({ model, context: "wait", options: {} }, stop.signal);
  setTimeout(() => stop.abort(), 20);
  assert.deepEqual((await all(await waiting)).map((event) => event.reason), ["aborted"]);
  assert.deepEqual(cancelled, ["wait"]);
  // Cancelled before it was asked: nothing is sent.
  const already = await all(await client.relay.ask({ model, context: "wait", options: {} }, AbortSignal.abort()));
  assert.deepEqual([already.map((event) => event.reason), cancelled], [["aborted"], ["wait"]]);
  // Whoever asked is done while a reply is waited for: it ends there as cancelled. And the other end, done, asks no further.
  // The other end gone while a reply is waited for: it ends there as failed — nobody cancelled it — and nothing more is asked by this end.
  // And the other end, done, asks no further.
  const left = client.relay.ask({ model, context: "wait", options: {} }), had = asked.length;
  await waitFor(() => asked.length > had, "the request to be being asked", 2000);
  client.close();
  server.close();
  assert.deepEqual((await all(await left)).map((event) => [event.reason, event.error.stopReason, event.error.errorMessage]), [["error", "error", "The process that was asking the model ended before the reply had come."]]);
  assert.deepEqual(cancelled, ["wait", "wait"]);
  assert.equal(await client.relay.ask({ model, context: "four", options: {} }), undefined);

  // What cannot be said back fails nobody: whoever asks for others goes on. And of a request that is not asked, what
  // is said of its model is its names — whatever else came as the model may be nothing a channel will carry.
  const unsaid = [];
  const onUnsaid = (err) => unsaid.push(err);
  process.on("unhandledRejection", onUnsaid);
  // (A request that is refused; one that cannot be asked whether it is; one that is served; one nobody here can serve.)
  const unheard = () => { throw new RangeError("cannot be said"); };
  for (const [on, id] of [[{ refuse: () => true }, "plain"], [{ refuse: () => { throw new Error("nobody to ask whether"); } }, "plain"], [{}, "plain"], [{}, "other"]]) {
    relayServer(knows, unheard, on).heard({ relay: { id: 1, request: { model: { ...model, id }, context: "one", options: {} } } });
  }
  // (Nor does what came as a model and is none, or one whose names will not be said; nor what cannot be gone through, with nobody to hear that.)
  const odd = [];
  const hears = relayServer(knows, (answer) => odd.push(answer));
  hears.heard({ relay: { id: 3, request: { model: null, context: "one", options: {} } } });
  hears.heard({ relay: { id: 4, request: { model: { provider: { toString() { throw new Error("no name"); } }, id: "plain" }, context: "one", options: {} } } });
  relayServer(knows, unheard).heard({ relay: { id: 5, request: { model, context: "one", options: deep }, mark: "x" } });
  // (Nor a request that cannot so much as be taken up; nor whoever is asked whether, failing by what cannot be said.)
  hears.heard({ relay: { id: 6, request: Object.defineProperty({ model, context: "one", options: {} }, "more", { enumerable: true, get() { throw new Error("not to be read"); } }) } });
  relayServer(knows, (answer) => odd.push(answer), { refuse: () => { throw Object.create(null); } }).heard({ relay: { id: 7, request: { model, context: "one", options: {} } } });
  const back = [];
  relayServer(knows, (answer) => back.push(answer), { refuse: () => true }).heard({ relay: { id: 2, request: { model: { provider: "fake", id: "plain", api: { deep: "as it likes" }, more: 10n }, context: "one", options: {} } } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  process.off("unhandledRejection", onUnsaid);
  assert.deepEqual(unsaid, []);
  // (Each is answered, as not served or as failed; the model named by its names where it had any that could be said.)
  const answered = Object.fromEntries(odd.map((answer) => [answer.relayed.id, answer.relayed.not ? "not served" : [answer.relayed.event.type, answer.relayed.event.error.provider, answer.relayed.event.error.errorMessage.replace(/^(The model could not be asked: ).*(null|name|why)\.?$/, "$1…$2")]]));
  assert.deepEqual(answered, {
    3: ["error", "", "The model could not be asked: …null"],
    4: ["error", "", "The model could not be asked: …name"],
    6: "not served",
    7: ["error", "fake", "The model could not be asked: …why"],
  });
  // (And each is done with: the same number can be asked by again.)
  odd.length = 0;
  for (const id of [3, 6]) hears.heard({ relay: { id, request: { model, context: "one", options: {} } } });
  await waitFor(() => odd.length === 4, "the requests to be answered", 2000);
  assert.deepEqual(odd.map((answer) => [answer.relayed.id, answer.relayed.event.type]).sort(), [[3, "done"], [3, "start"], [6, "done"], [6, "start"]]);
  assert.deepEqual(back.map((answer) => [answer.relayed.event.error.provider, answer.relayed.event.error.model, answer.relayed.event.error.api, answer.relayed.event.error.errorMessage]), [["fake", "plain", undefined, "The call is to ask no more."]]);

  // A request that cannot be put on the channel at all is one nobody served.
  const mute = relayClient(() => { throw new TypeError("Do not know how to serialize a BigInt"); });
  assert.equal(await mute.relay.ask({ model, context: { n: 10n }, options: {} }), undefined);
});

test("what goes with a request that is handed over is what of its options is data, by whatever name; and a request with something that would be missed is not handed over", async () => {
  const stop = new AbortController();
  // Data is what is the same on the other side of a channel: text, numbers, yes and no, nothing, and lists and plain records of those.
  for (const data of ["text", "", 0, -1.5, true, false, null, [], {}, [1, "two", null, [true]], { a: { b: [{ c: null }] } }, Object.assign(Object.create(null), { a: 1 }), { nothing: undefined }, { [Symbol("kind")]: "of pi's schemas", a: 1 }]) assert.equal(isData(data), true, JSON.stringify(data));
  const itself = { name: "holds itself" };
  itself.self = itself;
  const twice = { shared: [1] };
  for (const [what, not] of [
    ["nothing at all", undefined], ["a function", () => {}], ["a number that is none", NaN], ["a number without end", Infinity], ["a number too large for one", 10n], ["a symbol", Symbol("one")],
    ["a date", new Date(0)], ["bytes", new Uint8Array(2)], ["a map", new Map()], ["a signal", stop.signal], ["a thing of a kind of its own", new (class Thing { a = 1; })()],
    ["a list that would have itself gone through otherwise than place by place", Object.assign([() => {}, new Date(0)], { [Symbol.iterator]: function* () { yield 1; } })],
    ["a list of a kind of its own", new (class List extends Array {})(1, 2)], ["a list that says otherwise than it shows", Object.assign([1], { toJSON: () => "other" })],
    ["a record that says otherwise than it shows, and does not show that", Object.defineProperty({ a: 1 }, "toJSON", { value: () => "other" })], ["a record that holds one such", { a: [Object.defineProperty({}, "toJSON", { value: () => 1 })] }],
    ["a list with a gap", [1, undefined]], ["a list with a hole", [1, , 3]], ["a record with a function", { a: { b: () => {} } }], ["a list with a date", [[new Date(0)]]], ["what holds itself", itself],
  ]) assert.equal(isData(not), false, what);
  // (What is held twice, and not by itself, is data: it is two of the same on the other side.)
  assert.equal(isData({ one: twice, two: twice, list: [twice, twice] }), true);

  // What goes with a request: all of it, as it is — but the word to stop by, which goes beside it.
  assert.deepEqual(dataOf({ reasoningEffort: "high", serviceTier: "flex", thinking: { enabled: true, budgetTokens: 1024 }, signal: stop.signal, maxRetries: undefined, headers: { a: undefined } }),
    { reasoningEffort: "high", serviceTier: "flex", thinking: { enabled: true, budgetTokens: 1024 }, maxRetries: undefined, headers: { a: undefined } });
  assert.deepEqual(dataOf(undefined), {});
  // Anything that is not data, and the request is not one to hand over: whoever made it may mean something by it.
  for (const [name, value] of [["onPayload", () => {}], ["convertToLlm", () => {}], ["client", new (class Client {})()], ["since", new Date(0)], ["list", [undefined]], ["signals", { signal: stop.signal }]]) assert.equal(dataOf({ reasoningEffort: "high", [name]: value }), undefined, name);
  // Nor is one with a key of the asker's own, a way of its own to the provider, a span to report to, a reply to be fetched later.
  for (const cannotGo of ["apiKey", "fetch", "telemetry", "deferred"]) assert.equal(dataOf({ reasoning: "high", [cannotGo]: "x" }), undefined, cannotGo);

  // An option is under its own name, whatever the name.
  const named = dataOf(JSON.parse('{ "__proto__": { "sessionId": "another\'s" }, "constructor": 1 }'));
  assert.deepEqual([Object.keys(named), named.sessionId, Object.getPrototypeOf(named) === Object.prototype], [["__proto__", "constructor"], undefined, true]);

  // Where data has nothing under a name, a word is put there for the way that is nothing else in the data, and
  // taken out again: the name is then where it was, with nothing under it.
  const sparse = { a: undefined, b: { c: undefined, d: [{ e: undefined, f: 1 }, null, "text"] }, g: null, h: 0, i: undefined };
  const { data: onTheWay, mark } = marked(sparse);
  assert.match(mark, /^nothing:[0-9a-f-]{36}$/);
  assert.notEqual(marked(sparse).mark, mark);
  assert.deepEqual(onTheWay, { a: mark, b: { c: mark, d: [{ e: mark, f: 1 }, null, "text"] }, g: null, h: 0, i: mark });
  assert.deepEqual(sparse.b.d[0], { e: undefined, f: 1 }, "what was marked is a copy");
  const came = unmarked(JSON.parse(JSON.stringify(onTheWay)), mark);
  assert.deepEqual(came, sparse);
  assert.deepEqual([Object.keys(came), Object.keys(came.b), Object.keys(came.b.d[0])], [["a", "b", "g", "h", "i"], ["c", "d"], ["e", "f"]]);
  // Data that has no such name goes as it is, and nothing is said beside it.
  for (const full of [undefined, null, "text", 3, [], {}, { a: null, b: [1, { c: false }] }]) assert.deepEqual(marked(full), { data: full });
  // (A copy, either way: of what the data shows, name by name.)
  const shown = { a: 1, b: [{ c: "x" }] };
  Object.defineProperty(shown, "toJSON", { value: () => "something else" });
  assert.deepEqual(JSON.parse(JSON.stringify(marked(shown).data)), { a: 1, b: [{ c: "x" }] });
  // The word is taken out from under a record's names, and nowhere else; and what is no such word takes nothing out.
  assert.deepEqual(unmarked({ a: "m", list: ["m", { b: "m", c: "mm" }], "m": 1 }, "m"), { a: undefined, list: ["m", { b: undefined, c: "mm" }], "m": 1 });
  for (const none of [undefined, null, "", 7, {}, ["m"]]) assert.deepEqual(unmarked({ a: "m", b: "", c: 7 }, none), { a: "m", b: "", c: 7 }, JSON.stringify(none));
  const own = unmarked(JSON.parse('{ "__proto__": "m", "a": { "__proto__": "m" } }'), "m");
  assert.deepEqual([Object.keys(own), Object.keys(own.a), Object.getPrototypeOf(own) === Object.prototype, "m" in {}], [["__proto__", "a"], ["__proto__"], true, false]);

  // What comes all at once comes as a reply of one event, and is had whole of it; a request that failed before it was one fails, saying why.
  const reply = async function* (...events) { yield* events; };
  assert.deepEqual(await wholeOf(reply({ type: "done", message: { output: ["an image"] } })), { output: ["an image"] });
  assert.deepEqual(await wholeOf(reply({ type: "start" }, { type: "done", message: "the last" })), "the last");
  await assert.rejects(() => wholeOf(reply(notAsked({ provider: "p", id: "m" }, "The call is to ask no more."))), { message: "The call is to ask no more." });
  await assert.rejects(() => wholeOf(reply()), { message: "The model was not asked." });
  await assert.rejects(() => wholeOf(reply({ type: "start" })), { message: "The model was not asked." });
});

test("a relay asks by the ways pi has of asking a model, and by nothing else its models can do", async (t) => {
  const it = await user(t, ofAllKinds());
  withAllKinds(it);
  await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, async () => {
    const relay = createModelRelay();
    t.after(() => relay.close());
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const models = await ModelRuntime.create();
    const chat = models.getModel("fake", "plain"), painter = models.getModelOfType("image", "openrouter", "black-forest-labs/flux-3-image"), judge = models.getModelOfType("classifier", "openrouter", "~liquid/d1-latest");
    const context = { messages: [{ role: "user", content: [{ type: "text", text: "asked by a relay" }], timestamp: 1 }] };
    const lastOf = async (events) => { let last; for await (const event of events) last = event; return last; };
    // Each way: the model it is for, of its kind — and the reply, to its last event, which has what it used.
    assert.equal(usageAtEnd(await lastOf(await relay.ask({ model: chat, context, options: {} }))).input, 1000);
    // (By the provider's own options: one that is nothing to a request as pi's agent makes it is sent — and not, asked that way.)
    const thinks = models.getModel("fake", "thinks");
    assert.equal(usageAtEnd(await lastOf(await relay.ask({ by: "stream", model: thinks, context, options: { temperature: 0.5, reasoningEffort: "low" } }))).input, 1000);
    assert.deepEqual([it.requests.at(-1).temperature, it.requests.at(-1).reasoning_effort], [0.5, "low"]);
    assert.equal(usageAtEnd(await lastOf(await relay.ask({ model: thinks, context, options: { reasoningEffort: "low" } }))).input, 1000);
    assert.equal(it.requests.at(-1).reasoning_effort, undefined);
    const images = await lastOf(await relay.ask({ by: "generateImages", model: painter, context: { input: [{ type: "text", text: "a heron" }] }, options: {} }));
    assert.deepEqual([images.type, images.message.stopReason, images.message.output.length, usageAtEnd(images).output], ["done", "stop", 1, 2000]);
    const judged = await lastOf(await relay.ask({ by: "classify", model: judge, context: { state: {}, questions: { how: { type: "choice", instructions: "How?", criteria: { standard: "a", complex: "b" } } } }, options: {} }));
    assert.deepEqual([judged.type, judged.message.answers.how.choice, usageAtEnd(judged).input], ["done", "standard", 300]);
    assert.equal(it.requests.length, 5);
    // A model of one kind is not asked by the way of another: it is not the model the asker has.
    assert.equal(await relay.ask({ by: "classify", model: painter, context: {}, options: {} }), undefined);
    assert.equal(await relay.ask({ by: "generateImages", model: chat, context: {}, options: {} }), undefined);
    assert.equal(await relay.ask({ by: "stream", model: judge, context, options: {} }), undefined);
    // And a way that is none of these is not one to ask by, whatever pi's models have by that name.
    for (const by of ["login", "logout", "refresh", "setRuntimeApiKey", "getAuth", "cancelDeferred", "fetchDeferred", "streamDeferred", "complete", "constructor", "toString", "__proto__", "", 7]) {
      assert.equal(await relay.ask({ by, model: chat, context, options: {} }), undefined, String(by));
    }
    assert.equal(it.requests.length, 5);
    // What cannot go with a request is held to here as where it was sent from.
    assert.equal(await relay.ask({ by: "stream", model: chat, context, options: { apiKey: "another's" } }), undefined);
    assert.equal(it.requests.length, 5);
  });
});

test("a reply that was asked for elsewhere is handed to its session as pi makes a reply: with the whole of it so far, as each part comes", async (t) => {
  const it = await user(t, (_request, stream) => {
    for (const words of ["hello ", "from ", "the fake"]) stream.says({ role: "assistant", content: words });
    stream.says({}, "stop");
    stream.done();
  });
  withKeyBy(it);
  // An extension that writes down what it is shown of a reply as it comes: what kind of thing came, what a reply is made of, and its words so far.
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `pi.on("message_update", (event) => {
    const reply = event.message ?? {};
    note("shown " + JSON.stringify([event.assistantMessageEvent.type, Object.keys(reply).sort(), (reply.content ?? []).map((part) => part.text)]));
  });`));
  const shown = () => it.seen().flatMap(([pid, what]) => (what.startsWith("shown ") ? [[pid, ...JSON.parse(what.slice(6))]] : []));

  // Asked for here, by the process that serves the call...
  assert.equal(await withEnv({ ...it.env, TRAMA_TEST_KEY: "here" }, () => it.adapter.serve("say hello", { cwd: it.cwd, extensions: true })), "hello from the fake");
  const here = shown();
  assert.ok(here.length >= 5 && here.every(([pid]) => pid === process.pid));
  // ...and for a call in a process of its own, by its runner (whose key it is asked with).
  await askedWith(it, "the first", "say hello", { extensions: true });
  assert.equal(await askedWith(it, "the second", "say hello", { extensions: true }), "hello from the fake");
  assert.equal(keyOf(it.headers.at(-1)), "Bearer the second");
  const [host] = it.pids().filter((pid) => pid !== process.pid);
  const there = shown().filter(([pid]) => pid === host).slice(-here.length);
  // The same things come, in the same order, and a reply is made of the same. (Of nothing a reply here is not made of: what
  // pi shows here of a reply so far is what it is by the time it is looked at, which may be a little more than had come.)
  assert.deepEqual(there.map(([, kind]) => kind), here.map(([, kind]) => kind));
  assert.deepEqual(there.at(-1)[2], here.at(-1)[2]);
  for (const [at, [, kind, made]] of there.entries()) assert.deepEqual(made.filter((part) => !here[at][2].includes(part)), [], kind);
  assert.ok(there[0][2].includes("role") && there[0][2].includes("content") && there[0][2].includes("model"));
  // And the words so far are those that had come with each part, and no more.
  assert.deepEqual(there.filter(([, kind]) => kind === "text_delta").map(([, , , words]) => words), [["hello "], ["hello from "], ["hello from the fake"]]);
  assert.deepEqual(there.at(-1)[3], ["hello from the fake"]);
});

test("a model the runner cannot ask as the call would is asked by the process that serves the call: one it has otherwise, and one it has no key for", async (t) => {
  const it = await user(t), other = await user(t);
  withKeyBy(it);
  // (Another user's pi: it knows a model by the same name — at another address.)
  withKeyBy(other);
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine"));
  await askedWith(it, "the first", "say hello", { extensions: true });
  const [host] = it.pids();

  // The runner's pi has the model otherwise than the call's has it.
  assert.equal(await withEnv({ ...other.env, TRAMA_TEST_KEY: "the second" }, () => it.adapter.ask("say hello", { cwd: it.cwd, extensions: true })), "hello from the fake");
  assert.equal(keyOf(it.headers.at(-1)), "Bearer the first");
  assert.equal(other.requests.length, 0, "nothing was asked at the other address");
  // The runner has no key for the model's provider.
  assert.equal(await withEnv({ ...it.env, TRAMA_TEST_KEY: undefined }, () => it.adapter.ask("say hello", { cwd: it.cwd, extensions: true })), "hello from the fake");
  assert.equal(keyOf(it.headers.at(-1)), "Bearer the first");
  assert.deepEqual(it.pids(), [host]);
  assert.equal(it.requests.length, 3);
});

test("a call whose process has to be ended is taken to have used what its replies used: as its runner saw them, or as the process last said", async (t) => {
  const freezes = `pi.on("message_end", (event) => { if (event.message.role === "assistant") { note("frozen"); for (;;) {} } });`;
  const cases = {
    // Its model asked by its runner: what the reply used was seen there, whatever the process said of it before it stopped.
    "asked by its runner": `${SAYS_LITTLE}\n  ${freezes}`,
    // Its model asked by the process itself (an extension hears what a provider answers): what it said as the reply came is all there is.
    "asked by itself": `pi.on("after_provider_response", () => {});\n  ${freezes}`,
  };
  for (const [how, body] of Object.entries(cases)) {
    const it = await user(t);
    withKeyBy(it);
    it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", body));
    const stop = new AbortController(), said = [];
    const call = askedWith(it, "a key", "say hello", { extensions: true, signal: stop.signal, used: (usage) => said.push(total(usage)) });
    call.catch(() => {});
    await waitFor(() => it.seen().some(([, what]) => what === "frozen"), `${how}: the process to stop`);
    const [host] = it.pids();
    stop.abort();
    await assert.rejects(call, /Aborted/, how);
    assert.deepEqual(said, [1200], how);
    await waitFor(() => !isAlive(host), `${how}: the process to be gone`);
  }
});

test("a model is asked no further for a call whose process is gone — by the runner, or by the process that asks for a run that was given variables", async (t) => {
  for (const given of [undefined, { TRAMA_TEST_KEY: "the run's" }]) {
    const it = await user(t, () => { /* a model that does not answer */ });
    withKeyBy(it);
    it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine"));
    const adapter = new PiAdapter({ provider: "fake", model: "plain" }, given);
    t.after(() => adapter.close());
    const call = withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, () => adapter.ask("say hello", { cwd: it.cwd, extensions: true }));
    call.catch(() => {});
    await waitFor(() => it.requests.length === 1 && it.pids().length === 1, "the model to be asked");
    assert.equal(keyOf(it.headers[0]), given ? "Bearer the run's" : "Bearer a key");
    assert.equal(it.dropped(), 0);
    process.kill(it.pids()[0], "SIGKILL");
    await assert.rejects(call, { message: "The agent's process ended before it had answered (SIGKILL): the call was not finished." });
    await waitFor(() => it.dropped() === 1, "the request to be let go of");
    await adapter.close();
  }
});

test("a request made up by an extension and put on its process's channel is the call's: asked on its account while the call lasts, and not once it is cancelled", async (t) => {
  const it = await user(t);
  withKeyBy(it);
  // A command that says to the runner, as trama's own code in its process would, that the call has a request for its model.
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `pi.registerCommand("forge", { description: "asks the runner itself", handler: async (args, ctx) => {
    note("forging");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const context = { messages: [{ role: "user", content: [{ type: "text", text: "made up" }], timestamp: Date.now() }] };
    process.send({ relay: { id: 424242, request: { model: ctx.model, context, options: {} } } });
    // (Until the runner has answered it, however long that takes it — or, told to be brief, for a moment: nobody may answer.)
    await new Promise((resolve) => {
      const heard = (word) => { if (word?.relayed?.id === 424242 && (word.relayed.not || ["done", "error"].includes(word.relayed.event?.type))) resolve(); };
      process.on("message", heard);
      setTimeout(resolve, args.includes("briefly") ? 600 : 20_000).unref();
    });
  } });`));

  // While the call lasts: the model is asked, and what that used is the call's — though its process, which asked nothing, says it used nothing.
  const said = [];
  await assert.rejects(() => askedWith(it, "a key", "/forge", { extensions: true, used: (usage) => said.push(total(usage)) }), /The prompt was taken by an extension/);
  assert.equal(it.requests.length, 1);
  assert.match(JSON.stringify(it.requests[0].messages), /made up/);
  assert.deepEqual(said, [1200]);

  // Once the call is cancelled: nothing is asked for it.
  const stop = new AbortController(), noted = it.seen().length;
  const call = askedWith(it, "a key", "/forge briefly", { extensions: true, signal: stop.signal });
  call.catch(() => {});
  await waitFor(() => it.seen().length > noted + 1, "the command to begin");
  stop.abort();
  await assert.rejects(call, /Aborted/);
  await later(700);
  assert.equal(it.requests.length, 1);
});

test("a conversation that holds what cannot be sent is no reason for a call to fail: a tool may keep what it will beside its result", async (t) => {
  const it = await user(t, (request, stream) => {
    const tools = (request.tools ?? []).map((tool) => tool.function.name);
    if (tools.includes("counts") && !request.messages.some((message) => message.role === "tool")) stream.calls("counts");
    else { stream.says({ role: "assistant", content: "hello from the fake" }); stream.says({}, "stop"); }
    stream.done();
  });
  withKeyBy(it);
  // A tool that keeps, beside what it tells the model, a number too large for most things and a thing that holds itself.
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `pi.registerTool({ name: "counts", label: "counts", description: "Counts", parameters: { type: "object", properties: {} }, async execute() {
    const details = { count: 10n };
    details.self = details;
    return { content: [{ type: "text", text: "ten" }], details };
  } });`));
  await askedWith(it, "the first", "say hello", { extensions: true });
  const said = [];
  assert.equal(await askedWith(it, "the second", "say hello", { extensions: true, used: (usage) => said.push(total(usage)) }), "hello from the fake");
  assert.deepEqual(said, [2400]);
  // Its model was asked by the runner while the conversation could be sent, and by the process that serves the call once it
  // could not: what is sent of a conversation is all of it, as it is — a provider may be one that takes it so.
  assert.deepEqual(it.headers.slice(-2).map(keyOf), ["Bearer the second", "Bearer the first"]);
  assert.match(JSON.stringify(it.requests.at(-1).messages), /ten/);

  // And what a tool keeps that can be sent, though it is not what it was on the other side — a date, a list with a
  // gap in it — is nothing a provider is sent of the agent's conversation: its model is asked by the runner all the same.
  const kept = await user(t, (request, stream) => {
    if (!request.messages.some((message) => message.role === "tool")) stream.calls("keeps");
    else { stream.says({ role: "assistant", content: "hello from the fake" }); stream.says({}, "stop"); }
    stream.done();
  });
  withKeyBy(kept);
  kept.put(kept.agentDir, "extensions/mine.ts", EXTENSION("mine", `pi.registerTool({ name: "keeps", label: "keeps", description: "Keeps", parameters: { type: "object", properties: {} }, async execute() {
    return { content: [{ type: "text", text: "kept" }], details: { when: new Date(0), list: [1, undefined] } };
  } });`));
  await askedWith(kept, "the first", "say hello", { extensions: true });
  assert.equal(await askedWith(kept, "the second", "say hello", { extensions: true }), "hello from the fake");
  assert.deepEqual(kept.headers.slice(-2).map(keyOf), ["Bearer the second", "Bearer the second"]);
  assert.match(JSON.stringify(kept.requests.at(-1).messages), /kept/);
});

test("a process an extension has made other than it was — its variables, its way to the network — asks its call's model itself", async (t) => {
  const shapes = {
    // A key the extension brings (from a file of its own, say), where the runner has another for the same provider.
    "its variables": [`process.env.TRAMA_TEST_KEY = "the extension's";`, (headers) => assert.equal(keyOf(headers), "Bearer the extension's")],
    // Something of the extension's before every request the process makes.
    "its way to the network": [`if (!globalThis.wrapped) {
    globalThis.wrapped = true;
    const real = globalThis.fetch;
    globalThis.fetch = (input, init = {}) => real(input, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers ?? {})), "x-seen-by": "the extension" } });
  }`, (headers) => assert.deepEqual([keyOf(headers), headers["x-seen-by"]], ["Bearer the first", "the extension"])],
  };
  for (const [how, [body, check]] of Object.entries(shapes)) {
    const it = await user(t);
    withKeyBy(it);
    it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", body));
    await askedWith(it, "the first", "say hello", { extensions: true });
    assert.equal(await askedWith(it, "the second", "say hello", { extensions: true }), "hello from the fake", how);
    check(it.headers.at(-1));
  }
});

test("a reply is counted once, where an extension's provider asks another model by the session's own models", async (t) => {
  const it = await user(t, (request, stream) => {
    const read = request.messages.filter((message) => message.role === "tool").length;
    if (read < 1) stream.calls("read", { path: "a.txt" });
    else { stream.says({ role: "assistant", content: "hello from the fake" }); stream.says({}, "stop"); }
    stream.done();
  });
  const priced = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 };
  it.put(it.agentDir, "models.json", JSON.stringify({ providers: {
    fake: { baseUrl: `http://127.0.0.1:${it.port}/v1`, api: "openai-completions", apiKey: "$TRAMA_TEST_KEY", models: [{ id: "plain", cost: priced }] },
    inner: { baseUrl: `http://127.0.0.1:${it.port}/v1`, api: "openai-completions", apiKey: "$TRAMA_TEST_KEY", models: [{ id: "i1", cost: priced }] },
  } }));
  // A provider of the extension's own, which has another model asked — by the way pi gives an extension to ask one:
  // there and then, or (where the test says so) from a queue that was set up when the extension was loaded.
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `let models;
  pi.on("session_start", (_event, ctx) => { models = ctx.modelRegistry; });
  const queue = globalThis.queue ??= [];
  globalThis.worker ??= setInterval(() => { for (const job of queue.splice(0)) job(); }, 20).unref();
  const asks = (context, options) => models.streamSimple(models.find("inner", "i1"), context, { signal: options?.signal });
  pi.registerProvider("fake", { name: "Wrapped", baseUrl: "http://127.0.0.1:9/unused", apiKey: "none", api: "wrapped",
    models: [{ id: "plain", name: "plain", reasoning: false, input: ["text"], cost: ${JSON.stringify(priced)}, contextWindow: 100000, maxTokens: 4000 }],
    streamSimple: (_model, context, options) => (process.env.TRAMA_TEST_QUEUED ? (async function* () {
      yield* await new Promise((resolve) => queue.push(() => resolve(asks(context, options))));
    })() : asks(context, options)) });`));
  for (const where of ["here", "in a process of its own", "here, from a queue", "in a process of its own, from a queue"]) {
    const said = [], before = it.requests.length;
    const call = { cwd: it.cwd, extensions: true, sofar: (usage) => said.push(["sofar", total(usage)]), used: (usage) => said.push(["used", total(usage), Math.round(usage.cost * 1e6)]) };
    // (A process is started with what it is to do: one for each way.)
    const adapter = new PiAdapter({ provider: "fake", model: "plain" });
    t.after(() => adapter.close());
    const env = { ...it.env, TRAMA_TEST_KEY: "a key", TRAMA_TEST_QUEUED: where.includes("queue") ? "1" : undefined };
    assert.equal(await withEnv(env, () => (where.startsWith("here") ? adapter.serve("read a.txt", call) : adapter.ask("read a.txt", call))), "hello from the fake", where);
    await adapter.close();
    assert.equal(it.requests.length, before + 2, where);
    assert.deepEqual(said.at(-1), ["used", 2400, 2800], where);
    assert.ok(said.slice(0, -1).every(([word, tokens]) => word === "sofar" && tokens === 1200), `${where}: ${JSON.stringify(said)}`);
  }
});

test("requests an extension makes up are held to the call's budget one by one, as its own are", async (t) => {
  const it = await user(t);
  withKeyBy(it);
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `pi.registerCommand("forge", { description: "asks the runner itself, five times", handler: async (_args, ctx) => {
    const context = { messages: [{ role: "user", content: [{ type: "text", text: "made up" }], timestamp: Date.now() }] };
    for (let at = 0; at < 5; at++) {
      process.send({ relay: { id: 424242 + at, request: { model: ctx.model, context, options: { maxTokens: 77, apiKey: "of its own" } } } });
      await new Promise((resolve) => setTimeout(resolve, 400));
      process.send({ relay: { id: 524242 + at, request: { model: ctx.model, context, options: { maxTokens: 77 } } } });
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  } });`));
  await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, async () => {
    const backend = createBackend({ provider: "fake", model: "plain" }, createMeter({ tokens: 2000 }));
    t.after(() => backend.close());
    await assert.rejects(() => backend.ask("/forge", { cwd: it.cwd, extensions: true }), /The budget is spent: 2400 tokens used of 2000/);
  });
  // Two were made — the second being under the cap when it was asked for — and no more; and none with what a request may not bring.
  assert.equal(it.requests.length, 2);
  assert.deepEqual(it.requests.map((request) => request.max_completion_tokens ?? request.max_tokens), [77, 77]);
  assert.deepEqual(it.headers.map(keyOf), ["Bearer a key", "Bearer a key"]);
});

test("a call that is cancelled has its model asked no further by its runner, whether or not its process can hear that", async (t) => {
  const it = await user(t, () => { /* a model that does not answer */ });
  withKeyBy(it);
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine"));
  const stop = new AbortController();
  const call = askedWith(it, "a key", "say hello", { extensions: true, signal: stop.signal });
  call.catch(() => {});
  await waitFor(() => it.requests.length === 1 && it.pids().length === 1, "the model to be asked");
  const [host] = it.pids();
  // The process is stopped where it stands: it hears nothing, and says nothing.
  process.kill(host, "SIGSTOP");
  t.after(() => { try { process.kill(host, "SIGKILL"); } catch { /* gone */ } });
  const started = Date.now();
  stop.abort();
  await waitFor(() => it.dropped() === 1, "the request to be let go of");
  assert.ok(Date.now() - started < 2_000, `at once, not when the process is given up: ${Date.now() - started}ms`);
  await assert.rejects(call, /Aborted/);
});

test("whoever counts knows what a call has used as its replies come: a call beside it is held to that, though the first has not said its last", async (t) => {
  const it = await user(t);
  withKeyBy(it);
  // An extension that takes its time hearing that its session is over: the call it served is a while in ending. (And
  // whose process says nothing of what the call has used as its replies come: where the runner asked for them, it knows.)
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `pi.on("session_shutdown", () => new Promise((resolve) => setTimeout(resolve, 2000)));
  if (!globalThis.quiet) {
    globalThis.quiet = true;
    const send = process.send?.bind(process);
    if (send) process.send = (message, ...rest) => (message && typeof message === "object" && "had" in message ? true : send(message, ...rest));
  }`));
  await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, async () => {
    const backend = createBackend({ provider: "fake", model: "plain" }, createMeter({ tokens: 1000 }));
    t.after(() => backend.close());
    let ended = false;
    const first = backend.ask("say hello", { cwd: it.cwd, extensions: true }).finally(() => { ended = true; });
    await waitFor(() => it.requests.length === 1, "the model to be asked");
    await later(500);
    assert.equal(ended, false, "the first call is still ending");
    // The budget is spent by the first call's one reply, and the second is refused for it now.
    await assert.rejects(() => backend.ask("say hello", { cwd: it.cwd }), /The budget is spent: 1200 tokens used of 1000/);
    assert.equal(ended, false);
    assert.equal(await first, "hello from the fake");
    assert.equal(it.requests.length, 1);
  });
});

test("a call that has its answer keeps it: what an extension would ask beside it, the budget being spent, is not asked — and that is all", async (t) => {
  const twice = (request, stream) => {
    // A model that has the agent read a file before it answers: two replies, the second of which takes a call over a cap of 2000.
    if (JSON.stringify(request.messages).includes("an extension asks")) { stream.says({ role: "assistant", content: "to the extension" }); stream.says({}, "stop"); }
    else if (!request.messages.some((message) => message.role === "tool")) stream.calls("read", { path: "a.txt" });
    else { stream.says({ role: "assistant", content: "the answer" }); stream.says({}, "stop"); }
    stream.done();
  };
  const asked = (it) => it.seen().map(([, what]) => what).filter((what) => what.startsWith("asked"));

  // Held to a budget, by a backend: served in a process of its own.
  {
    const it = await user(t, twice);
    withKeyBy(it);
    it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", ASKS_AT("session_shutdown", "streamSimple", "complete", "itself")));
    await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, async () => {
      const spent = [];
      const backend = createBackend({ provider: "fake", model: "plain" }, createMeter({ tokens: 2000 }), (why) => spent.push(why));
      t.after(() => backend.close());
      const used = [], told = [];
      assert.equal(await backend.ask("read a.txt", { cwd: it.cwd, extensions: true, used: (usage) => used.push(total(usage)), sofar: (usage, answered) => told.push([total(usage), answered]) }), "the answer");
      // (Whoever a program has listening is told what the backend was: how much, and whether the call had its answer by then.)
      assert.deepEqual(told, [[1200, false], [2400, true]]);
      assert.deepEqual(asked(it), ["asked for itself at session_shutdown, by streamSimple: aborted", "asked for itself at session_shutdown, by complete: aborted", "asked for itself at session_shutdown, by itself: aborted"]);
      assert.equal(it.requests.length, 2);
      assert.deepEqual(used, [2400]);
      // (A request was refused for the budget, and that is said, as it is of any.)
      assert.deepEqual(spent, ["The budget is spent: 2400 tokens used of 2000."]);
      assert.equal(backend.refused(), "The budget is spent: 2400 tokens used of 2000.");
      // And with room, the extension is answered, and what it asked is the call's.
      const roomy = createBackend({ provider: "fake", model: "plain" }, createMeter({ tokens: 20000 }));
      t.after(() => roomy.close());
      used.length = 0;
      assert.equal(await roomy.ask("read a.txt", { cwd: it.cwd, extensions: true, used: (usage) => used.push(total(usage)) }), "the answer");
      assert.deepEqual(asked(it).slice(3), ["asked for itself at session_shutdown, by streamSimple: stop", "asked for itself at session_shutdown, by complete: stop", "asked for itself at session_shutdown, by itself: stop"]);
      assert.deepEqual(used, [6000]);
    });
  }

  // By what serves the call, whoever hears: told that the call has its answer, they say no — and are asked no more.
  {
    const it = await user(t, twice);
    withKeyBy(it);
    it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", ASKS_AT("session_shutdown", "streamSimple", "complete")));
    const heard = [];
    const answer = await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, () => it.adapter.serve("read a.txt", {
      cwd: it.cwd, extensions: true, sofar: (usage, answered) => { heard.push([total(usage), answered]); return !answered; },
    }));
    assert.equal(answer, "the answer");
    assert.deepEqual(heard, [[1200, false], [2400, true]]);
    assert.deepEqual(asked(it), ["asked for itself at session_shutdown, by streamSimple: aborted", "asked for itself at session_shutdown, by complete: aborted"]);
    assert.equal(it.requests.length, 2);

    // (Before a call has its answer a no is no way to stop it — it is stopped by being cancelled: said without that, it changes nothing.)
    assert.equal(await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, () => it.adapter.serve("read a.txt", { cwd: it.cwd, sofar: () => false })), "the answer");
    assert.equal(it.requests.length, 4);
    // ...in a process of its own, with its model asked by its runner, as here: it has its answer, and what its extension
    // would ask beside that is what the no refuses.
    assert.equal(await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, () => it.adapter.ask("read a.txt", { cwd: it.cwd, extensions: true, sofar: () => false })), "the answer");
    assert.equal(it.requests.length, 6);
    assert.deepEqual(asked(it).slice(-2), ["asked for itself at session_shutdown, by streamSimple: aborted", "asked for itself at session_shutdown, by complete: aborted"]);
  }
});

test("what an extension asks of a provider that is its own code is counted as that provider says, once", async (t) => {
  const it = await user(t, (request, stream) => {
    if (!request.messages.some((message) => message.role === "tool")) stream.calls("read", { path: "a.txt" });
    else { stream.says({ role: "assistant", content: "hello from the fake" }); stream.says({}, "stop"); }
    stream.done();
  });
  withKeyBy(it);
  // A provider that answers by itself, and says what that used; and an extension that asks it for itself while a tool runs.
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `pi.registerProvider("own", { name: "Own", baseUrl: "http://127.0.0.1:9/unused", apiKey: "none", api: "own-api",
    models: [{ id: "o1", name: "o1", reasoning: false, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4000 }],
    streamSimple: (model) => (async function* () {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const message = { role: "assistant", content: [{ type: "text", text: "own words" }], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 700, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 750, cost: { input: 0.0007, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0008 } }, stopReason: "stop", timestamp: Date.now() };
      yield { type: "start", partial: { ...message, content: [] } };
      yield { type: "done", reason: "stop", message };
    })() });
  pi.on("tool_execution_start", async (_event, ctx) => {
    const asked = ctx.modelRegistry.streamSimple(ctx.modelRegistry.find("own", "o1"), { messages: [{ role: "user", content: "for the extension", timestamp: Date.now() }] }, {}).result().then((reply) => note("asked its own: " + reply.stopReason));
    // (Waited for or not, as the test says: not waited for, the agent's next request is made while the provider is still at it.)
    if (!process.env.TRAMA_TEST_BESIDE) await asked;
  });
  pi.on("session_shutdown", () => new Promise((resolve) => setTimeout(resolve, 300)));`));
  for (const where of ["here", "in a process of its own", "here, beside the agent's work", "in a process of its own, beside the agent's work"]) {
    const said = [];
    const call = { cwd: it.cwd, extensions: true, tools: ["read"], sofar: (usage) => said.push(["sofar", total(usage)]), used: (usage) => said.push(["used", total(usage)]) };
    const adapter = new PiAdapter({ provider: "fake", model: "plain" });
    t.after(() => adapter.close());
    const env = { ...it.env, TRAMA_TEST_KEY: "a key", TRAMA_TEST_BESIDE: where.includes("beside") ? "1" : undefined };
    assert.equal(await withEnv(env, () => (where.startsWith("here") ? adapter.serve("read a.txt", call) : adapter.ask("read a.txt", call))), "hello from the fake", where);
    await adapter.close();
    assert.equal(it.seen().at(-1)[1], "asked its own: stop", where);
    // The agent's two requests, and the extension's one of its own provider: all three in what the call used in the end —
    // and, where the extension waited for its own, said before the agent's next was made.
    assert.deepEqual(said.at(-1), ["used", 3150], where);
    if (!where.includes("beside")) assert.deepEqual(said, [["sofar", 1200], ["sofar", 1950], ["used", 3150]], where);
  }
});

test("what an extension asks a model from where it has a hand in the agent's own asking is asked and counted like anything it asks", async (t) => {
  const it = await user(t, (request, stream) => {
    const asked = JSON.stringify(request.messages);
    if (asked.includes("is this right")) { stream.says({ role: "assistant", content: "it is" }); stream.says({}, "stop"); }
    else if (!request.messages.some((message) => message.role === "tool")) stream.calls("read", { path: "a.txt" });
    else { stream.says({ role: "assistant", content: "hello from the fake" }); stream.says({}, "stop"); }
    stream.done();
  });
  withKeyBy(it);
  // An extension that has each request of the agent's looked at by a model before it goes.
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `pi.on("before_provider_request", async (_event, ctx) => {
    const context = { messages: [{ role: "user", content: [{ type: "text", text: "is this right" }], timestamp: Date.now() }] };
    const reply = await ctx.modelRegistry.streamSimple(ctx.model, context, {}).result();
    note("had it looked at: " + reply.stopReason);
  });`));
  for (const where of ["here", "in a process of its own"]) {
    const said = [], before = it.requests.length;
    const call = { cwd: it.cwd, extensions: true, sofar: (usage) => said.push(["sofar", total(usage)]), used: (usage) => said.push(["used", total(usage)]) };
    assert.equal(await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, () => (where === "here" ? it.adapter.serve("read a.txt", call) : it.adapter.ask("read a.txt", call))), "hello from the fake", where);
    // Two requests of the agent's and two of the extension's — each of its own made while the agent's is being made
    // ready, before that one goes: four replies used something, and the two requests of the second turn were each
    // made with what the first turn had used said first.
    assert.equal(it.requests.length, before + 4, where);
    assert.deepEqual(said, [["sofar", 2400], ["sofar", 2400], ["used", 4800]], where);
  }
});

test("a call that ended with a failure of its own keeps that, whatever an extension would ask beside it and whatever the budget has come to", async (t) => {
  const it = await user(t, (request, stream) => {
    if (JSON.stringify(request.messages).includes("an extension asks")) { stream.says({ role: "assistant", content: "to the extension" }); stream.says({}, "stop"); }
    else { stream.says({ role: "assistant", content: "cut he" }); stream.says({}, "length"); }
    stream.done();
  });
  withKeyBy(it);
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", ASKS_AT("session_shutdown", "streamSimple")));
  await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, async () => {
    for (const [tokens, asked, requests] of [[1000, "aborted", 1], [5000, "stop", 3]]) {
      const backend = createBackend({ provider: "fake", model: "plain" }, createMeter({ tokens }));
      t.after(() => backend.close());
      await assert.rejects(() => backend.ask("say hello", { cwd: it.cwd, extensions: true }), (err) => err instanceof CutOff && err.text === "cut he", `under ${tokens}`);
      assert.equal(it.seen().at(-1)[1], `asked for itself at session_shutdown, by streamSimple: ${asked}`);
      assert.equal(it.requests.length, requests);
    }
  });
});

test("requests made up beside a call that has its answer are refused one by one as the budget is spent, and the answer stands", async (t) => {
  const it = await user(t);
  withKeyBy(it);
  // As its session ends, the extension puts four requests on its process's channel, one after the other: as trama's own code there would.
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `pi.on("session_shutdown", async (_event, ctx) => {
    const context = { messages: [{ role: "user", content: [{ type: "text", text: "made up" }], timestamp: Date.now() }] };
    for (let at = 0; at < 4; at++) {
      process.send({ relay: { id: 624242 + at, request: { model: ctx.model, context, options: {}, answered: true } } });
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  });`));
  await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, async () => {
    const backend = createBackend({ provider: "fake", model: "plain" }, createMeter({ tokens: 2000 }));
    t.after(() => backend.close());
    const used = [];
    assert.equal(await backend.ask("say hello", { cwd: it.cwd, extensions: true, used: (usage) => used.push(total(usage)) }), "hello from the fake");
    // The call's one request, and the first of the four — under the cap when it was asked for. None after it was made:
    // a no is a no for the rest of the call.
    assert.equal(it.requests.length, 2);
    assert.deepEqual(used, [2400]);
  });
});

test("a call that could not have the tools it named is one that failed: what an extension asks as it is told the session ends is asked, and is the call's", async (t) => {
  const it = await user(t);
  withKeyBy(it);
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", ASKS_AT("session_shutdown", "streamSimple")));
  for (const where of ["here", "in a process of its own"]) {
    const used = [], before = it.requests.length;
    const call = { cwd: it.cwd, extensions: true, tools: ["read", "nope"], used: (usage) => used.push(total(usage)) };
    await assert.rejects(() => withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, () => (where === "here" ? it.adapter.serve("say hello", call) : it.adapter.ask("say hello", call))),
      { message: 'The agent cannot be given the tools ["read","nope"]: pi would give it ["read"].' }, where);
    assert.equal(it.seen().at(-1)[1], "asked for itself at session_shutdown, by streamSimple: stop", where);
    assert.equal(it.requests.length, before + 1, where);
    assert.deepEqual(used, [1200], where);
  }

  // Held to a budget as anything asked beside a call that is over is: the second of two is not made once the first has spent it.
  const twice = await user(t);
  withKeyBy(twice);
  twice.put(twice.agentDir, "extensions/mine.ts", EXTENSION("mine", ASKS_AT("session_shutdown", "streamSimple", "complete")));
  await withEnv({ ...twice.env, TRAMA_TEST_KEY: "a key" }, async () => {
    const backend = createBackend({ provider: "fake", model: "plain" }, createMeter({ tokens: 1000 }));
    t.after(() => backend.close());
    await assert.rejects(() => backend.ask("say hello", { cwd: twice.cwd, extensions: true, tools: ["read", "nope"] }), { message: 'The agent cannot be given the tools ["read","nope"]: pi would give it ["read"].' });
    assert.deepEqual(twice.seen().map(([, what]) => what).filter((what) => what.startsWith("asked")), ["asked for itself at session_shutdown, by streamSimple: stop", "asked for itself at session_shutdown, by complete: aborted"]);
    assert.equal(twice.requests.length, 1);
  });
});

// --- What an extension asks as its session ends, and how long that is waited for ---

/** A model that answers the agent at once, and what an extension asks for itself when `late(nth)` says: after so long, or (undefined) never. */
const slowForExtensions = (late) => {
  let asks = 0;
  return (request, stream) => {
    const answer = (text) => { stream.says({ role: "assistant", content: text }); stream.says({}, "stop"); stream.done(); };
    if (!JSON.stringify(request.messages).includes("an extension asks")) return answer("hello from the fake");
    const after = late(asks += 1);
    if (after !== undefined) setTimeout(() => answer("to the extension"), after);
  };
};
const notedBy = (it, start) => it.seen().map(([, what]) => what).filter((what) => what.startsWith(start));
/** When an extension wrote down something that ends with the time it was (" at <ms>") — the last such note. */
const notedAt = (it, start) => Number(notedBy(it, start).at(-1)?.match(/ at (\d+)$/)?.[1]);
const withoutTimes = (notes) => notes.map((what) => what.replace(/ at \d+$/, ""));

test("an extension that is asking a model as its session ends is waited for, past the while it is given when it asks nothing: it is answered, and what it asked is the call's", async (t) => {
  // Three seconds, then five and a half: more than the five an extension is given, together and the second by itself.
  // The first is asked by the runner (as pi asks), the second where the extension is (it has a hand of its own in the asking).
  const it = await user(t, slowForExtensions((nth) => (nth === 1 ? 3000 : 5500)));
  withKeyBy(it);
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `${ASKS_AT("session_shutdown", "streamSimple", "itself")}
  pi.on("session_shutdown", async () => { note("told of the end at " + Date.now()); });`));
  const used = [], began = Date.now();
  const answer = await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, () => it.adapter.ask("say hello", { cwd: it.cwd, extensions: true, used: (usage) => used.push(total(usage)) }));
  const back = Date.now();
  assert.equal(answer, "hello from the fake");
  // (For as long as the asking took, and not the while an extension is given on top of that.)
  assert.ok(back - began >= 8500, `the call came back after ${back - began} ms`);
  assert.ok(back - notedAt(it, "told") < 8500 + 4000, `the call came back ${back - notedAt(it, "told")} ms after its extensions were told of the end`);
  // Both were answered by the time the call came back, and both are in what it says it used.
  assert.deepEqual(notedBy(it, "asked"), ["asked for itself at session_shutdown, by streamSimple: stop", "asked for itself at session_shutdown, by itself: stop"]);
  assert.deepEqual(used, [3600]);
  assert.equal(it.dropped(), 0);
});

test("the while an extension is given as its session ends is its own, all told: the time a model takes is not counted in it, and what it takes beside that is", async (t) => {
  // It asks, is at something of its own for three and a half seconds, asks again, and is at it for as long again:
  // seven seconds of its own, where it is given five — and a second each time for the model, which is not its own.
  const it = await user(t, slowForExtensions(() => 1000));
  withKeyBy(it);
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `pi.on("session_shutdown", async (_event, ctx) => {
    const context = { messages: [{ role: "user", content: [{ type: "text", text: "an extension asks" }], timestamp: Date.now() }] };
    for (const round of [1, 2]) {
      const reply = await ctx.modelRegistry.streamSimple(ctx.model, context, {}).result();
      note("asked, round " + round + ": " + reply.stopReason);
      await new Promise((resolve) => setTimeout(resolve, 3500));
    }
    note("asked and done");
  });`));
  const used = [], began = Date.now();
  await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, () => it.adapter.ask("say hello", { cwd: it.cwd, extensions: true, used: (usage) => used.push(total(usage)) }));
  const took = Date.now() - began;
  // Both were answered and are the call's; and the call came back when the extension's five seconds were up —
  // a second and a half into its second turn at its own work, and not at the end of it: it had not come to its
  // last word by then.
  assert.deepEqual(notedBy(it, "asked"), ["asked, round 1: stop", "asked, round 2: stop"]);
  assert.deepEqual(used, [3600]);
  assert.ok(took >= 6500, `the call came back after ${took} ms`);
});

test("what an extension has asked beside its answer to the session's end is waited for too", async (t) => {
  // (One request at a time — as pi asks, by a provider's own options, and so with a hand of the extension's own in
  // it, which is asked where the extension is — so that nothing else is being asked while it is on its way from
  // being made ready to being answered.)
  for (const ask of ["ctx.modelRegistry.streamSimple(ctx.model, context, {}).result()", "ctx.modelRegistry.complete(ctx.model, context, {})", "ctx.modelRegistry.complete(ctx.model, context, { onPayload: () => undefined })"]) {
    const it = await user(t, slowForExtensions(() => 1500));
    withKeyBy(it);
    it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `pi.on("session_shutdown", (_event, ctx) => {
    const context = { messages: [{ role: "user", content: [{ type: "text", text: "an extension asks" }], timestamp: Date.now() }] };
    // (Not waited for by the extension: it has answered before the model has.)
    void ${ask}.then((reply) => note("asked beside: " + reply.stopReason + " at " + Date.now()));
  });`));
    const used = [], began = Date.now();
    await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, () => it.adapter.ask("say hello", { cwd: it.cwd, extensions: true, used: (usage) => used.push(total(usage)) }));
    const back = Date.now();
    // (For as long as it takes, and no longer: nothing more is waited for once nothing is being asked.)
    assert.ok(back - began >= 1500, `${ask}: the call came back after ${back - began} ms`);
    assert.ok(back - notedAt(it, "asked") < 4000, `${ask}: the call came back ${back - notedAt(it, "asked")} ms after the reply`);
    assert.deepEqual(withoutTimes(notedBy(it, "asked")), ["asked beside: stop"], ask);
    assert.deepEqual(used, [2400], ask);
  }
});

test("an extension asking as its session ends is waited for no longer than pi gives a request: what is still being asked then is stopped, wherever it is asked", async (t) => {
  // A model that never answers the extension; and a user whose pi gives a request two seconds — said either of
  // the ways pi's settings have for it.
  const BOTH = `pi.on("session_shutdown", async (_event, ctx) => {
    const context = { messages: [{ role: "user", content: [{ type: "text", text: "an extension asks" }], timestamp: Date.now() }] };
    // (Each with something of its own to be stopped by, which never says so: a signal of the system's, and one of the extension's own making.)
    const made = Object.assign(new EventTarget(), { aborted: false, reason: undefined, throwIfAborted() {} });
    const madeToo = Object.assign(new EventTarget(), { aborted: false, reason: undefined, throwIfAborted() {} });
    const replies = await Promise.all([ctx.modelRegistry.streamSimple(ctx.model, context, { signal: new AbortController().signal }).result(), ctx.modelRegistry.complete(ctx.model, context, { signal: made }), ctx.modelRegistry.complete(ctx.model, context, { signal: madeToo, onPayload: () => undefined })]);
    note("asked both: " + replies.map((reply) => reply.stopReason).join(", "));
  });`;
  for (const [where, settings] of [["in a process of its own", { retry: { provider: { timeoutMs: 2000 } } }], ["here", { httpIdleTimeoutMs: 2000 }]]) {
    const it = await user(t, slowForExtensions(() => undefined));
    withKeyBy(it);
    it.put(it.agentDir, "settings.json", JSON.stringify(settings));
    // Asked all at once: as pi asks and by a provider's own options — by the runner, where the call is served apart —
    // and with a hand of the extension's own in the asking, which is asked where the extension is.
    it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", BOTH));
    const used = [], began = Date.now();
    const call = { cwd: it.cwd, extensions: true, used: (usage) => used.push(total(usage)) };
    await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, async () => {
      const answer = await (where === "here" ? it.adapter.serve("say hello", call) : it.adapter.ask("say hello", call));
      const took = Date.now() - began;
      assert.equal(answer, "hello from the fake", where);
      // (After the two seconds, and long before the five minutes pi gives where its settings say nothing.)
      assert.ok(took >= 2000 && took < 60_000, `${where}: the call came back after ${took} ms`);
      // No request was left being made: the model's server saw all three let go of.
      await waitFor(() => it.dropped() === 3, `${where}: the three requests to be let go of`, 2000);
      await waitFor(() => notedBy(it, "asked").length === 1, `${where}: the extension to have heard`, 2000);
    });
    assert.deepEqual(notedBy(it, "asked"), ["asked both: aborted, aborted, aborted"], where);
    assert.deepEqual(used, [1200], where);
    assert.equal(it.requests.length, 4, where);
  }
});

test("where pi gives a request no limit, or the longest there is, an extension asking as its session ends is waited for all the same", async (t) => {
  for (const settings of [{ httpIdleTimeoutMs: "disabled" }, { retry: { provider: { timeoutMs: 2 ** 31 - 1 } } }]) {
    const it = await user(t, slowForExtensions(() => 1500));
    withKeyBy(it);
    it.put(it.agentDir, "settings.json", JSON.stringify(settings));
    it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", ASKS_AT("session_shutdown", "streamSimple")));
    const used = [];
    await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, () => it.adapter.ask("say hello", { cwd: it.cwd, extensions: true, used: (usage) => used.push(total(usage)) }));
    assert.deepEqual(notedBy(it, "asked"), ["asked for itself at session_shutdown, by streamSimple: stop"], JSON.stringify(settings));
    assert.deepEqual(used, [2400], JSON.stringify(settings));
  }
});

test("a call that is cancelled while its extension is asking, as the session ends, has that stopped at once — where the extension is, too", async (t) => {
  const it = await user(t, slowForExtensions(() => undefined));
  withKeyBy(it);
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", ASKS_AT("session_shutdown", "itself")));
  const cancel = new AbortController();
  const call = withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, () => it.adapter.ask("say hello", { cwd: it.cwd, extensions: true, signal: cancel.signal }));
  call.catch(() => {});
  await waitFor(() => it.requests.length === 2, "the extension to be asking", 30_000);
  cancel.abort();
  // (Well before the process that serves the call would be given up on, and ended.)
  await waitFor(() => it.dropped() === 1, "the request to be let go of", 3000);
  // (Whether a call that had its answer when it was cancelled still gives it is not what this is about.)
  await call.then(() => {}, () => {});
  assert.deepEqual(notedBy(it, "asked"), ["asked for itself at session_shutdown, by itself: aborted"]);
});

test("a reply that is stopped at the limit has used what it had used by then, and that is the call's — wherever it was asked", async (t) => {
  // A model that begins its reply to the extension, says what that has used so far, and says no more.
  const inPart = (request, stream) => {
    if (!JSON.stringify(request.messages).includes("an extension asks")) { stream.says({ role: "assistant", content: "hello from the fake" }); stream.says({}, "stop"); return stream.done(); }
    stream.says({ role: "assistant", content: "the beginning of a summary" });
    stream.uses({ prompt_tokens: 5000, completion_tokens: 700, total_tokens: 5700 });
  };
  for (const [pool, way] of [["the runner asks", "streamSimple"], ["the runner asks, by a provider's own options", "complete"], ["a process of the run's asks", "streamSimple"], ["the call's own process asks", "itself"]]) {
    const it = await user(t, inPart);
    withKeyBy(it);
    it.put(it.agentDir, "settings.json", JSON.stringify({ retry: { provider: { timeoutMs: 1500 } } }));
    it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", ASKS_AT("session_shutdown", way)));
    const adapter = pool === "a process of the run's asks" ? new PiAdapter({ provider: "fake", model: "plain" }, { TRAMA_TEST_KEY: "the run's" }) : it.adapter;
    if (adapter !== it.adapter) t.after(() => adapter.close());
    const used = [];
    await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, () => adapter.ask("say hello", { cwd: it.cwd, extensions: true, used: (usage) => used.push(total(usage)) }));
    assert.deepEqual(used, [6900], pool);
  }
});

test("a setting pi would not take does not keep extensions from being told that their session is over", async (t) => {
  const it = await user(t);
  it.put(it.agentDir, "settings.json", JSON.stringify({ httpIdleTimeoutMs: "abc" }));
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `pi.on("session_shutdown", async () => { note("told of the end"); });`));
  // (pi itself fails a call with such a setting: that is as it was. What is not: the session's end going unsaid.)
  await it.ask("say hello", { extensions: true }).catch(() => {});
  assert.deepEqual(notedBy(it, "told"), ["told of the end"]);
});

test("the time pi gives a request is a model's, not an extension's own: a limit shorter than the while extensions are given does not cut that short", async (t) => {
  const it = await user(t);
  it.put(it.agentDir, "settings.json", JSON.stringify({ retry: { provider: { timeoutMs: 1000 } } }));
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `pi.on("session_shutdown", async () => { await new Promise((resolve) => setTimeout(resolve, 2500)); note("told, and done with it"); });`));
  assert.equal(await it.ask("say hello", { extensions: true }), "hello from the fake");
  assert.deepEqual(notedBy(it, "told"), ["told, and done with it"]);
});

test("a request an extension makes with a signal of its own making is asked all the same, and stopped when that signal says so", async (t) => {
  // (The model answers the extension's first two requests, and never its third.)
  const it = await user(t, slowForExtensions((nth) => (nth === 3 ? undefined : 0)));
  withKeyBy(it);
  // (Not the system's AbortSignal: something that can be listened to and says whether it has said to stop — all that pi itself asks of one.)
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `pi.on("agent_end", async (_event, ctx) => {
    const context = { messages: [{ role: "user", content: [{ type: "text", text: "an extension asks" }], timestamp: Date.now() }] };
    const { getEventListeners } = await import("node:events");
    const signal = () => Object.assign(new EventTarget(), { aborted: false, reason: undefined, throwIfAborted() {} });
    const one = signal();
    const replies = [await ctx.modelRegistry.streamSimple(ctx.model, context, { signal: one }).result(), await ctx.modelRegistry.complete(ctx.model, context, { signal: one })];
    note("asked with a signal of its own: " + replies.map((reply) => reply.stopReason + (reply.errorMessage ? " (" + reply.errorMessage + ")" : "")).join(", "));
    // (Whoever was listening to it for a request listens no more when the request is over.)
    await new Promise((resolve) => setTimeout(resolve, 50));
    note("listening to it still: " + getEventListeners(one, "abort").length);
    const stops = signal();
    setTimeout(() => { stops.aborted = true; stops.dispatchEvent(new Event("abort")); }, 300);
    const last = await ctx.modelRegistry.complete(ctx.model, context, { signal: stops });
    note("asked, and stopped by it: " + last.stopReason);
  });`));
  const used = [];
  await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, () => it.adapter.ask("say hello", { cwd: it.cwd, extensions: true, used: (usage) => used.push(total(usage)) }));
  assert.deepEqual(notedBy(it, "asked"), ["asked with a signal of its own: stop, stop", "asked, and stopped by it: aborted"]);
  assert.deepEqual(notedBy(it, "listening"), ["listening to it still: 0"]);
  assert.deepEqual(used, [3600]);
  // (Stopped where it was being asked, not only given up on by whoever asked.)
  await waitFor(() => it.dropped() === 1, "the request to be let go of", 1000);
});

test("the time a model is given for what extensions ask as a session ends is for all of it: what one request took, the next has not", async (t) => {
  // Two seconds, as the user's pi has it; and a model that takes a second and a fifth over each request.
  for (const where of ["in a process of its own", "here"]) {
    const it = await user(t, slowForExtensions(() => 1200));
    withKeyBy(it);
    it.put(it.agentDir, "settings.json", JSON.stringify({ retry: { provider: { timeoutMs: 2000 } } }));
    it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", ASKS_AT("session_shutdown", "complete", "complete", "complete")));
    const used = [], heard = [];
    // (Here, whoever hears what the call has used answers for the first two requests, and never again: once
    // what was being asked has been stopped, nobody is asked whether more may be — nobody may be there.)
    const call = { cwd: it.cwd, extensions: true, used: (usage) => used.push(total(usage)), ...(where === "here" && { sofar: (usage, answered) => (heard.push([total(usage), answered]) <= 2 ? true : new Promise(() => {})) }) };
    await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, async () => {
      await (where === "here" ? it.adapter.serve("say hello", call) : it.adapter.ask("say hello", call));
      await waitFor(() => notedBy(it, "asked").length === 3, `${where}: the extension to have heard of all three`, 2000);
    });
    // The first was answered; the second was stopped four fifths of a second in; the third was not asked.
    assert.deepEqual(notedBy(it, "asked").map((what) => what.slice(what.lastIndexOf(": ") + 2)), ["stop", "aborted", "aborted"], where);
    assert.deepEqual(used, [2400], where);
    assert.equal(it.requests.length, 3, where);
    if (where === "here") assert.deepEqual(heard, [[1200, true], [2400, true]]);
  }
});

test("a call cancelled while its extensions are still being told that the session begins has what they are asking stopped, and asks nothing as they are told that it is over", async (t) => {
  // (The model never answers the extension, which asks it as the session begins and waits for the answer.)
  const it = await user(t, slowForExtensions(() => undefined));
  withKeyBy(it);
  // (At the end it asks with nothing to be stopped by, and with a signal of its own making: neither is sent.)
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `const context = () => ({ messages: [{ role: "user", content: [{ type: "text", text: "an extension asks" }], timestamp: Date.now() }] });
  pi.on("session_start", async (_event, ctx) => {
    note("slow to begin");
    const reply = await ctx.modelRegistry.complete(ctx.model, context(), {});
    note("asked for itself at session_start: " + reply.stopReason);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    const made = Object.assign(new EventTarget(), { aborted: false, reason: undefined, throwIfAborted() {} });
    const first = await ctx.modelRegistry.streamSimple(ctx.model, context(), {}).result();
    note("asked for itself at session_shutdown, by streamSimple: " + first.stopReason);
    const second = await ctx.modelRegistry.complete(ctx.model, context(), { signal: made });
    note("asked for itself at session_shutdown, by complete: " + second.stopReason);
  });`));
  const cancel = new AbortController();
  const call = withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, () => it.adapter.ask("say hello", { cwd: it.cwd, extensions: true, signal: cancel.signal }));
  call.catch(() => {});
  await waitFor(() => it.requests.length === 1, "the extension to be asking as the session begins", 30_000);
  cancel.abort();
  await assert.rejects(call, /Abort/);
  // (Stopped there and then, and not when the process that serves the call is given up on.)
  await waitFor(() => it.dropped() === 1, "the request to be let go of", 3000);
  await waitFor(() => notedBy(it, "asked").length === 3, "the extension to have been told that the session is over", 4000);
  assert.deepEqual(notedBy(it, "asked"), ["asked for itself at session_start: aborted", "asked for itself at session_shutdown, by streamSimple: aborted", "asked for itself at session_shutdown, by complete: aborted"]);
  assert.equal(it.requests.length, 1);
});

test("a reply that does not end when it is stopped does not hold its call: the call comes back a moment after the limit", async (t) => {
  const it = await user(t);
  it.put(it.agentDir, "settings.json", JSON.stringify({ retry: { provider: { timeoutMs: 1500 } } }));
  // A provider that is the extension's own code, begins a reply, and neither goes on nor listens to anything.
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `pi.registerProvider("own", { name: "Own", baseUrl: "http://127.0.0.1:9/unused", apiKey: "none", api: "own-api",
    models: [{ id: "o1", name: "o1", reasoning: false, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4000 }],
    streamSimple: (model) => (async function* () {
      yield { type: "start", partial: { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } };
      await new Promise(() => {});
    })() });
  pi.on("session_shutdown", (_event, ctx) => {
    note("asking its own, which will not end at " + Date.now());
    void ctx.modelRegistry.streamSimple(ctx.modelRegistry.find("own", "o1"), { messages: [{ role: "user", content: "for the extension", timestamp: Date.now() }] }, {}).result().catch(() => {});
  });`));
  assert.equal(await it.ask("say hello", { extensions: true }), "hello from the fake");
  const took = Date.now() - notedAt(it, "asking");
  assert.deepEqual(withoutTimes(notedBy(it, "asking")), ["asking its own, which will not end"]);
  // (The time a model is given, and the moment what was stopped has to end in — and no more than that.)
  assert.ok(took >= 2400 && took < 60_000, `the call came back ${took} ms after it was asked`);
});

test("a cancelled call is not held by a reply that does not end when it is stopped: it fails at once, and the process that served it serves on", async (t) => {
  // The model does not answer the agent while the first call lasts; and the extension has a provider of its own
  // that begins a reply and neither goes on nor listens to anything, which it asks as the agent's turn begins.
  let answers = false;
  const it = await user(t, (request, stream) => {
    if (!answers) return;
    stream.says({ role: "assistant", content: "hello from the fake" });
    stream.says({}, "stop");
    stream.done();
  });
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `pi.registerProvider("own", { name: "Own", baseUrl: "http://127.0.0.1:9/unused", apiKey: "none", api: "own-api",
    models: [{ id: "o1", name: "o1", reasoning: false, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4000 }],
    streamSimple: (model) => (async function* () {
      yield { type: "start", partial: { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } };
      await new Promise(() => {});
    })() });
  // (Once, in the call that is to be cancelled: the next call of the process asks nothing of the kind.)
  pi.on("turn_start", (_event, ctx) => {
    if (globalThis.__tramaAskedItsOwn) return;
    globalThis.__tramaAskedItsOwn = true;
    void ctx.modelRegistry.streamSimple(ctx.modelRegistry.find("own", "o1"), { messages: [{ role: "user", content: "for the extension", timestamp: Date.now() }] }, {}).result().catch(() => {});
  });`));
  const cancel = new AbortController();
  const call = it.ask("say hello", { extensions: true, signal: cancel.signal });
  call.catch(() => {});
  await waitFor(() => it.requests.length === 1, "the agent to be asking", 30_000);
  const cancelled = Date.now();
  cancel.abort();
  await assert.rejects(call, /Abort/);
  // (Well before a process that will not let go of its call is given up on, which is five seconds.)
  assert.ok(Date.now() - cancelled < 4000, `the call failed ${Date.now() - cancelled} ms after it was cancelled`);
  answers = true;
  assert.equal(await it.ask("say hello", { extensions: true }), "hello from the fake");
  assert.equal(it.pids().length, 1);
});

test("what an extension asks a model as its session begins is its call's, where the call then fails before its agent was set going: counted, and held to the budget", async (t) => {
  const asks = `const asksNow = async (ctx, when) => {
    const context = { messages: [{ role: "user", content: [{ type: "text", text: "an extension asks" }], timestamp: Date.now() }] };
    const reply = await ctx.modelRegistry.complete(ctx.model, context, {});
    note("asked for itself as the session " + when + ": " + reply.stopReason);
  };
  pi.on("session_start", (_event, ctx) => asksNow(ctx, "begins"));
  pi.on("session_shutdown", (_event, ctx) => asksNow(ctx, "ends"));`;
  // A call that names what its model has not — how hard to think — fails when its session is there, and not before.
  // (Served in this process too, where nobody else is there to say what it used: it says so itself.)
  {
    const it = await user(t);
    withKeyBy(it);
    it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", asks));
    const said = [];
    await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, () => assert.rejects(it.adapter.serve("say hello", {
      cwd: it.cwd, extensions: true, thinking: "high", sofar: (usage) => { said.push(["sofar", total(usage)]); }, had: (usage) => said.push(["had", total(usage)]), used: (usage) => said.push(["used", total(usage)]),
    }), /think/i));
    assert.deepEqual(said, [["had", 1200], ["sofar", 1200], ["had", 2400], ["used", 2400]]);
  }
  for (const [budget, noted, used, requests] of [
    [{}, ["asked for itself as the session begins: stop", "asked for itself as the session ends: stop"], [2400], 2],
    [{ tokens: 100 }, ["asked for itself as the session begins: stop", "asked for itself as the session ends: aborted"], [1200], 1],
  ]) {
    const it = await user(t);
    withKeyBy(it);
    it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", asks));
    await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, async () => {
      const spent = [], said = [];
      const backend = createBackend({ provider: "fake", model: "plain" }, createMeter(budget), (why) => spent.push(why));
      t.after(() => backend.close());
      await assert.rejects(backend.ask("say hello", { cwd: it.cwd, extensions: true, thinking: "high", used: (usage) => said.push(total(usage)) }), /think/i);
      assert.deepEqual(notedBy(it, "asked"), noted, JSON.stringify(budget));
      assert.deepEqual(said, used, JSON.stringify(budget));
      assert.equal(it.requests.length, requests, JSON.stringify(budget));
      assert.equal(spent.length, budget.tokens === undefined ? 0 : 1, JSON.stringify(budget));
    });
  }
});

test("a call that is cancelled while its extensions are waited for, a reply of theirs not ending, is let go of there and then", async (t) => {
  const it = await user(t);
  // (The same provider that neither goes on nor listens — asked, once, as the session ends, and not waited for by the extension.)
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `pi.registerProvider("own", { name: "Own", baseUrl: "http://127.0.0.1:9/unused", apiKey: "none", api: "own-api",
    models: [{ id: "o1", name: "o1", reasoning: false, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4000 }],
    streamSimple: (model) => (async function* () {
      yield { type: "start", partial: { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } };
      await new Promise(() => {});
    })() });
  pi.on("session_shutdown", (_event, ctx) => {
    if (globalThis.__tramaAskedItsOwnAtTheEnd) return;
    globalThis.__tramaAskedItsOwnAtTheEnd = true;
    void ctx.modelRegistry.streamSimple(ctx.modelRegistry.find("own", "o1"), { messages: [{ role: "user", content: "for the extension", timestamp: Date.now() }] }, {}).result().catch(() => {});
    setTimeout(() => note("asking its own as the session ends"), 300);
  });`));
  const cancel = new AbortController();
  const call = it.ask("say hello", { extensions: true, signal: cancel.signal });
  call.catch(() => {});
  // (It is waited for by now: a model is taken to be at work, for as long as pi gives one — five minutes.)
  await waitFor(() => notedBy(it, "asking").length === 1, "the extension to be asking", 30_000);
  cancel.abort();
  await call.then(() => {}, () => {});
  // The process that served it was not given up on: it serves the next call.
  assert.equal(await it.ask("say hello", { extensions: true }), "hello from the fake");
  assert.equal(it.pids().length, 1);
});

test("whoever hears what a call has used, and does not answer, does not hold what an extension asks for good: it is refused when the session is let go of", async (t) => {
  const it = await user(t, slowForExtensions(() => 0));
  withKeyBy(it);
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", ASKS_AT("session_shutdown", "complete", "complete")));
  // (Served here; and whoever hears answers for the extension's first request, and for nothing after it.)
  const heard = [];
  await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, async () => {
    assert.equal(await it.adapter.serve("say hello", { cwd: it.cwd, extensions: true, sofar: (usage, answered) => (heard.push([total(usage), answered]) <= 1 ? true : new Promise(() => {})) }), "hello from the fake");
    await waitFor(() => notedBy(it, "asked").length === 2, "the extension to have heard of both", 2000);
  });
  // The second was being made ready for as long as the extension had of its own time, and was then not asked.
  assert.deepEqual(notedBy(it, "asked").map((what) => what.slice(what.lastIndexOf(": ") + 2)), ["stop", "aborted"]);
  assert.deepEqual(heard, [[1200, true], [2400, true]]);
  assert.equal(it.requests.length, 2);
});

test("nor does it where the question was put while the call was still at its work: what an extension asked beside the agent is refused when the session is let go of", async (t) => {
  const it = await user(t);
  withKeyBy(it);
  // (Asked as the agent ends, and not waited for by the extension: the call is not over when it is asked.)
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `pi.on("agent_end", (_event, ctx) => {
    const context = { messages: [{ role: "user", content: [{ type: "text", text: "an extension asks" }], timestamp: Date.now() }] };
    void ctx.modelRegistry.complete(ctx.model, context, {}).then((reply) => note("asked beside the agent: " + reply.stopReason));
  });`));
  const heard = [];
  await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, async () => {
    assert.equal(await it.adapter.serve("say hello", { cwd: it.cwd, extensions: true, sofar: (usage, answered) => { heard.push([total(usage), answered]); return new Promise(() => {}); } }), "hello from the fake");
    await waitFor(() => notedBy(it, "asked").length === 1, "the extension to have heard", 2000);
  });
  assert.deepEqual(notedBy(it, "asked"), ["asked beside the agent: aborted"]);
  assert.deepEqual(heard, [[1200, false]]);
  assert.equal(it.requests.length, 1);
});

// --- The other ways pi has of asking a model: by a provider's own options, for images, of a classifier, for a reply kept for later ---

/** What an extension asks with: one message, of the text given. */
const SAYING = `const saying = (text) => ({ messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] });`;
/** The text of the last message of a request, as the model's server saw it. */
const lastSaid = (request) => request.messages.at(-1).content.at(-1).text;

test("what an extension asks by a provider's own options is asked by the call's runner too, where all that goes with it is data — and where the extension is, where something is not, or is the asker's own", async (t) => {
  const it = await user(t);
  withKeyBy(it);
  // Each asks by pi, with what it is named for; and writes down how it went.
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `pi.on("agent_end", async (_event, ctx) => {
    ${SAYING}
    const models = ctx.modelRegistry, model = ctx.model;
    const ways = {
      "complete, bare": () => models.complete(model, saying("complete, bare"), {}),
      "complete, with data": () => models.complete(model, saying("complete, with data"), { temperature: 0.25, headers: { "x-mine": "said" }, sessionId: "its own", nothing: undefined, deep: { list: [1, "two", null, { three: true }] } }),
      "stream": () => models.stream(model, saying("stream"), { maxTokens: 64 }).result(),
      "complete, with an option of the provider's own": () => models.complete(models.find("fake", "thinks"), saying("complete, with an option of the provider's own"), { reasoningEffort: "low" }),
      "complete, with a hook": () => models.complete(model, saying("complete, with a hook"), { onResponse: () => {} }),
      "complete, with what is no data": () => models.complete(model, saying("complete, with what is no data"), { since: new Date(0) }),
      "complete, with a list that has a gap": () => models.complete(model, saying("complete, with a list that has a gap"), { list: [1, undefined] }),
      "complete, with a key of its own": () => models.complete(model, saying("complete, with a key of its own"), { apiKey: "its own" }),
      "complete, of what is no data": () => models.complete(model, { messages: [{ role: "user", content: [{ type: "text", text: "complete, of what is no data" }], timestamp: Date.now(), at: new Date(0) }] }, {}),
      "streamSimple, with a hook": () => models.streamSimple(model, saying("streamSimple, with a hook"), { onPayload: () => undefined }).result(),
      "streamSimple, its headers made other": () => models.streamSimple(model, saying("streamSimple, its headers made other"), { transformHeaders: (headers) => ({ ...headers, "x-made": "other" }) }).result(),
      "streamSimple, its headers left": () => models.streamSimple(model, saying("streamSimple, its headers left"), { transformHeaders: (headers) => ({ ...headers }) }).result(),
      "streamSimple, its headers made none": () => models.streamSimple(model, saying("streamSimple, its headers made none"), { transformHeaders: () => null }).result(),
      "streamSimple, a header that cannot be told": () => models.streamSimple(model, saying("streamSimple, a header that cannot be told"), { transformHeaders: (headers) => ({ ...headers, "x-big": 10n }) }).result(),
      "complete, with what goes deeper than can be followed": () => { let deep = {}; for (let at = 0; at < 20000; at += 1) deep = { deep }; return models.complete(model, saying("complete, with what goes deeper than can be followed"), { deep }); },
      "streamSimple, a header taken out": () => models.streamSimple(model, saying("streamSimple, a header taken out"), { transformHeaders: (headers) => ({ ...headers, "User-Agent": undefined }) }).result(),
      "streamSimple, its headers in another order": () => models.streamSimple(model, saying("streamSimple, its headers in another order"), { headers: { "x-one": "1", "x-two": "2" }, transformHeaders: (headers) => Object.fromEntries(Object.entries(headers).reverse()) }).result(),
      "streamSimple, with a function that is nothing to a provider": () => models.streamSimple(model, saying("streamSimple, with a function that is nothing to a provider"), { mine: () => {} }).result(),
    };
    for (const [name, ask] of Object.entries(ways)) note("asked " + name + ": " + (await ask()).stopReason);
  });`));
  // The process that serves the calls is started with one key, and the runner has another by the next call.
  await askedWith(it, "the first", "say hello", { extensions: true });
  const before = it.requests.length, used = [];
  await askedWith(it, "the second", "say hello", { extensions: true, used: (usage) => used.push(total(usage)) });
  const who = Object.fromEntries(it.requests.slice(before + 1).map((request, at) => [lastSaid(request), keyOf(it.headers[before + 1 + at])]));
  const RUNNER = "Bearer the second", HOST = "Bearer the first";
  assert.deepEqual(who, {
    "complete, bare": RUNNER,
    "complete, with data": RUNNER,
    "stream": RUNNER,
    "complete, with an option of the provider's own": RUNNER,
    // A hook of the asker's own is its hand in the request; what is no data may mean something to a provider, and
    // would not be what it is on the other side; a key of the asker's own is the key the request is to be made by.
    "complete, with a hook": HOST,
    "complete, with what is no data": HOST,
    "complete, with a list that has a gap": HOST,
    "complete, with a key of its own": "Bearer its own",
    "complete, of what is no data": HOST,
    "streamSimple, with a hook": HOST,
    "streamSimple, its headers made other": HOST,
    // (What made nothing of the headers is no hand in the request. Any other function is one its asker may mean
    // something by, whatever pi's providers make of it today: only of a request pi's agent makes for itself is
    // what is not data left behind.)
    "streamSimple, its headers left": RUNNER,
    // (A name with nothing under it is a name; and so is the order they are in: pi lays headers one over another by both.)
    "streamSimple, its headers made none": HOST,
    // (What cannot be told, or followed to its end, is not known to be what it was, or to be data: such a request is
    // asked where it was made, as pi would ask it.)
    "streamSimple, a header that cannot be told": HOST,
    "complete, with what goes deeper than can be followed": HOST,
    "streamSimple, a header taken out": HOST,
    "streamSimple, its headers in another order": HOST,
    "streamSimple, with a function that is nothing to a provider": HOST,
  });
  // What went with a request went with it, wherever it was asked.
  const sent = (text) => it.requests.findLastIndex((request) => lastSaid(request) === text);
  assert.equal(it.requests[sent("complete, with data")].temperature, 0.25);
  assert.equal(it.headers[sent("complete, with data")]["x-mine"], "said");
  assert.equal(it.requests[sent("stream")].max_completion_tokens ?? it.requests[sent("stream")].max_tokens, 64);
  assert.equal(it.headers[sent("streamSimple, its headers made other")]["x-made"], "other");
  // (A header pi's provider has of its own, which the request's are laid over: named with nothing under it, it is not pi's.)
  assert.match(it.headers[sent("streamSimple, its headers left")]["user-agent"], /^pi\//);
  assert.doesNotMatch(it.headers[sent("streamSimple, a header taken out")]["user-agent"], /^pi\//);
  // (An option that is the provider's own, and nothing to a request as pi's agent makes one: asked by the way it was asked by.)
  assert.equal(it.requests[sent("complete, with an option of the provider's own")].reasoning_effort, "low");
  assert.equal(it.headers[sent("streamSimple, a header that cannot be told")]["x-big"], "10");
  // Every one was answered, and is in what the call used: the agent's request, and the eighteen.
  assert.deepEqual(notedBy(it, "asked").slice(-18).map((what) => what.slice(what.lastIndexOf(": ") + 2)), Array(18).fill("stop"));
  assert.deepEqual(used, [19 * 1200]);
});

/** A user whose pi has an image model and a classifier answered by the test's server, beside the chat model: with a key that says who asked. */
const withAllKinds = (it) => it.put(it.agentDir, "models.json", JSON.stringify({ providers: {
  fake: { baseUrl: `http://127.0.0.1:${it.port}/v1`, api: "openai-completions", apiKey: "$TRAMA_TEST_KEY", models: [{ id: "plain", cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } }, { id: "thinks", reasoning: true, cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } }] },
  // (One of pi's own providers, reached at the test's server: it has models that make images, and models that classify.)
  openrouter: { baseUrl: `http://127.0.0.1:${it.port}/v1`, apiKey: "$TRAMA_TEST_KEY" },
} }));
/** A model's server that answers each kind as its kind is answered — after `late(kind)` ms, or never where that is undefined. */
const ofAllKinds = (late = () => 0) => (request, stream, _nth, path) => {
  const kind = path.endsWith("/systemone") ? "classifier" : request.stream === false ? "image" : "chat";
  const answer = () => {
    if (kind === "classifier") return stream.whole({ answers: { how: { type: "choice", choice: "standard", probabilities: { standard: 0.9, complex: 0.1 }, confidence: 0.9 } }, usage: { input_tokens: 300, output_tokens: 5 } });
    if (kind === "image") return stream.whole({ id: "made", usage: { prompt_tokens: 40, completion_tokens: 2000 }, choices: [{ message: { content: "", images: [{ image_url: { url: "data:image/png;base64,AAAA" } }] } }] });
    stream.says({ role: "assistant", content: "hello from the fake" });
    stream.says({}, "stop");
    stream.done();
  };
  const after = late(kind);
  if (after === 0) answer();
  else if (after !== undefined) setTimeout(answer, after);
};
/** An extension's code that asks for an image, and then a classifier, when `event` comes — with `options` — and writes down what came of each. */
const ASKS_ALL_KINDS_AT = (event, options = "{}") => `pi.on("${event}", async (_event, ctx) => {
    const models = ctx.modelRegistry;
    const images = await models.generateImages(models.findOfType("image", "openrouter", "black-forest-labs/flux-3-image"), { input: [{ type: "text", text: "a heron at low tide" }] }, ${options});
    note("asked for an image: " + images.stopReason + ", " + (images.errorMessage ?? images.output.filter((one) => one.type === "image").length + " made"));
    const judged = await models.classify(models.findOfType("classifier", "openrouter", "~liquid/d1-latest"), { state: { prompt: "say hello" }, questions: { how: { type: "choice", instructions: "How hard is it?", criteria: { standard: "Ordinary", complex: "Hard" } } } }, ${options});
    note("asked a classifier: " + judged.stopReason + ", " + (judged.errorMessage ?? judged.answers.how.choice));
  });`;
/** What the image and the classifier's answer used, as the server above says: 2040 and 305. */
const IMAGE = 2040, JUDGED = 305;

test("a model that makes images and one that classifies are asked by the call's runner as any model is: counted as their replies come, said before they are asked, and asked where the extension is where it has a hand in it", async (t) => {
  const kinds = (it, from) => it.paths.slice(from).map((path, at) => [path.endsWith("/systemone") ? "classifier" : it.requests[from + at].stream === false ? "image" : "chat", keyOf(it.headers[from + at])]);
  const RUNNER = "Bearer the second", HOST = "Bearer the first";
  // (Who asks the agent's model, and who the other two: a session where an extension has a hand in every request asks
  // all its models itself; a request that goes with a hook of its asker's is that one request.)
  for (const [how, body, options, agents, asker] of [
    ["nobody has a hand in the asking", "", "{}", RUNNER, RUNNER],
    ["an extension hears what a provider answers", `pi.on("after_provider_response", () => {});`, "{}", HOST, HOST],
    ["the request goes with a hook of its asker's", "", "{ onResponse: () => {} }", RUNNER, HOST],
  ]) {
    const it = await user(t, ofAllKinds());
    withAllKinds(it);
    it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `${ASKS_ALL_KINDS_AT("agent_end", options)}\n  ${body}`));
    await askedWith(it, "the first", "say hello", { extensions: true });
    const before = it.requests.length, said = [], had = [];
    await askedWith(it, "the second", "say hello", { extensions: true, had: (usage) => had.push(total(usage)), sofar: (usage) => said.push(["sofar", total(usage)]), used: (usage) => said.push(["used", total(usage)]) });
    assert.deepEqual(kinds(it, before), [["chat", agents], ["image", asker], ["classifier", asker]], how);
    assert.deepEqual(notedBy(it, "asked").slice(-2), ["asked for an image: stop, 1 made", "asked a classifier: stop, standard"], how);
    // What each used is the call's: said as its reply came, said before the next was asked, and in what the call used.
    assert.deepEqual([...new Set(had)], [1200, 1200 + IMAGE, 1200 + IMAGE + JUDGED], how);
    assert.deepEqual(said, [["sofar", 1200], ["sofar", 1200 + IMAGE], ["used", 1200 + IMAGE + JUDGED]], how);
  }
});

test("a call that is out of budget has no image made and nothing classified: neither is asked, and each ends saying so — whoever would have asked", async (t) => {
  const refused = ["asked for an image: error, The call is to ask no more.", "asked a classifier: error, The call is to ask no more."];
  // By a backend, held to a budget the agent's reply has spent: served in a process of its own, its models asked by the runner.
  {
    const it = await user(t, ofAllKinds());
    withAllKinds(it);
    it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", ASKS_ALL_KINDS_AT("session_shutdown")));
    await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, async () => {
      const backend = createBackend({ provider: "fake", model: "plain" }, createMeter({ tokens: 1000 }));
      t.after(() => backend.close());
      const used = [];
      assert.equal(await backend.ask("say hello", { cwd: it.cwd, extensions: true, used: (usage) => used.push(total(usage)) }), "hello from the fake");
      assert.deepEqual(notedBy(it, "asked"), refused);
      assert.equal(it.requests.length, 1);
      assert.deepEqual(used, [1200]);
      // And with room, an image's cost in tokens is the budget's as any reply's is: the classifier is not asked once the image has spent it.
      const roomy = createBackend({ provider: "fake", model: "plain" }, createMeter({ tokens: 3000 }));
      t.after(() => roomy.close());
      used.length = 0;
      assert.equal(await roomy.ask("say hello", { cwd: it.cwd, extensions: true, used: (usage) => used.push(total(usage)) }), "hello from the fake");
      assert.deepEqual(notedBy(it, "asked").slice(2), ["asked for an image: stop, 1 made", refused[1]]);
      assert.deepEqual(used, [1200 + IMAGE]);
      assert.equal(roomy.refused(), `The budget is spent: ${1200 + IMAGE} tokens used of 3000.`);
    });
  }
  // By what serves the call, here: whoever hears what the call has used says no once it has its answer.
  {
    const it = await user(t, ofAllKinds());
    withAllKinds(it);
    it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", ASKS_ALL_KINDS_AT("session_shutdown")));
    const heard = [];
    assert.equal(await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, () => it.adapter.serve("say hello", { cwd: it.cwd, extensions: true, sofar: (usage, answered) => { heard.push([total(usage), answered]); return !answered; } })), "hello from the fake");
    assert.deepEqual(notedBy(it, "asked"), refused);
    // (Asked once, of the image; and no more, having said no.)
    assert.deepEqual(heard, [[1200, true]]);
    assert.equal(it.requests.length, 1);
  }
});

test("an extension that is having an image made, or something classified, as its session ends is waited for as one asking for a reply is — and what is still asked when the time is up, or the call cancelled, is stopped where it is asked", async (t) => {
  // Waited for, past the five seconds extensions are given: a classifier that takes five and a half. Served apart, and asked by the runner.
  {
    const it = await user(t, ofAllKinds((kind) => (kind === "classifier" ? 5500 : 0)));
    withAllKinds(it);
    it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", ASKS_ALL_KINDS_AT("session_shutdown")));
    const used = [], began = Date.now();
    await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, () => it.adapter.ask("say hello", { cwd: it.cwd, extensions: true, used: (usage) => used.push(total(usage)) }));
    assert.ok(Date.now() - began >= 5500, `the call came back after ${Date.now() - began} ms`);
    assert.deepEqual(notedBy(it, "asked"), ["asked for an image: stop, 1 made", "asked a classifier: stop, standard"]);
    assert.deepEqual(used, [1200 + IMAGE + JUDGED]);
    assert.equal(it.dropped(), 0);
  }
  // Stopped when the time pi gives a request is up: an image that is never made. Where the call is served apart (the
  // runner asks), and here (what serves the call asks).
  for (const where of ["in a process of its own", "here"]) {
    const it = await user(t, ofAllKinds((kind) => (kind === "image" ? undefined : 0)));
    withAllKinds(it);
    it.put(it.agentDir, "settings.json", JSON.stringify({ retry: { provider: { timeoutMs: 1500 } } }));
    it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", ASKS_ALL_KINDS_AT("session_shutdown")));
    const call = { cwd: it.cwd, extensions: true }, began = Date.now();
    await withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, async () => {
      assert.equal(await (where === "here" ? it.adapter.serve("say hello", call) : it.adapter.ask("say hello", call)), "hello from the fake", where);
      const took = Date.now() - began;
      assert.ok(took >= 1500 && took < 60_000, `${where}: the call came back after ${took} ms`);
      await waitFor(() => it.dropped() === 1, `${where}: the request to be let go of`, 2000);
      await waitFor(() => notedBy(it, "asked").length === 2, `${where}: the extension to have heard of both`, 2000);
    });
    // The image's making was stopped; and the classifier, which the extension came to when its session was gone, was not asked.
    assert.match(notedBy(it, "asked")[0], /^asked for an image: aborted, /, where);
    assert.equal(notedBy(it, "asked")[1], "asked a classifier: error, The call is to ask no more.", where);
    assert.equal(it.requests.length, 2, where);
  }
  // Stopped at once when the call is cancelled.
  {
    const it = await user(t, ofAllKinds((kind) => (kind === "classifier" ? undefined : 0)));
    withAllKinds(it);
    it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", ASKS_ALL_KINDS_AT("session_shutdown")));
    const cancel = new AbortController();
    const call = withEnv({ ...it.env, TRAMA_TEST_KEY: "a key" }, () => it.adapter.ask("say hello", { cwd: it.cwd, extensions: true, signal: cancel.signal }));
    call.catch(() => {});
    await waitFor(() => it.requests.length === 3, "the classifier to be asked", 30_000);
    cancel.abort();
    await waitFor(() => it.dropped() === 1, "the request to be let go of", 3000);
    await call.then(() => {}, () => {});
    await waitFor(() => notedBy(it, "asked a classifier").length === 1, "the extension to have heard", 2000);
    assert.match(notedBy(it, "asked a classifier")[0], /^asked a classifier: aborted, /);
  }
});

/**
 * An extension with a provider of pi's own making, for tests: one that keeps a reply for later, when asked to, and
 * writes it out at `speed` tokens a second when it is fetched. `body` is what the extension does with it.
 */
const KEEPS_FOR_LATER = (speed, body) => `import { appendFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
export default function (pi) {
  const note = (what) => appendFileSync(process.env.TRAMA_TEST_SEEN, process.pid + " " + what + "\\n");
  const faux = fauxProvider({ provider: "later", tokensPerSecond: ${speed} });
  pi.registerProvider(faux.provider);
  const context = { messages: [{ role: "user", content: [{ type: "text", text: "an extension asks" }], timestamp: Date.now() }] };
  /** Has a reply of sixty words kept for later; gives the model, and what the reply is to be fetched by. */
  const kept = async (ctx) => {
    const model = ctx.modelRegistry.find("later", faux.models[0].id);
    faux.setResponses([fauxAssistantMessage(Array(60).fill("word").join(" "))]);
    const first = await ctx.modelRegistry.streamSimple(model, context, { deferred: true }).result();
    return { model, handle: first.deferred, first };
  };
  /** How a call of pi's went, that may throw. */
  const tried = (work) => work.then(() => "done", (err) => "threw: " + err.message);
  ${body}
}
`;

test("a reply that was kept for later is the call's when it is fetched: counted, said as it comes, waited for as the session ends, and stopped with the call — and to have a provider give one up is refused nobody", async (t) => {
  // Counted: asked for as the agent ends, where the call is served (a provider of an extension's is nobody else's to ask).
  for (const where of ["here", "in a process of its own"]) {
    const it = await user(t);
    it.put(it.agentDir, "extensions/later.ts", KEEPS_FOR_LATER(2000, `pi.on("agent_end", async (_event, ctx) => {
    const { model, handle, first } = await kept(ctx);
    const fetched = await ctx.modelRegistry.runtime.fetchDeferred(model, handle, {});
    note("fetched: " + first.stopReason + ", then " + fetched.stopReason + ", which used " + (fetched.usage.input + fetched.usage.output));
  });`));
    const used = [], had = [], call = { cwd: it.cwd, extensions: true, had: (usage) => had.push(total(usage)), used: (usage) => used.push(total(usage)) };
    await withEnv(it.env, () => (where === "here" ? it.adapter.serve("say hello", call) : it.adapter.ask("say hello", call)));
    const fetched = Number(notedBy(it, "fetched").at(-1)?.match(/^fetched: deferred, then stop, which used (\d+)$/)?.[1]);
    assert.ok(fetched > 0, `${where}: ${notedBy(it, "fetched")}`);
    assert.deepEqual(used, [1200 + fetched], where);
    assert.equal(had.at(-1), 1200 + fetched, where);
  }

  // Waited for: fetched as the session ends, by an extension that does not wait for it — three seconds of writing.
  {
    const it = await user(t);
    it.put(it.agentDir, "extensions/later.ts", KEEPS_FOR_LATER(20, `pi.on("session_shutdown", async (_event, ctx) => {
    const { model, handle } = await kept(ctx);
    void ctx.modelRegistry.runtime.fetchDeferred(model, handle, {}).then((fetched) => note("fetched: " + fetched.stopReason + " at " + Date.now()));
  });`));
    const used = [];
    await it.ask("say hello", { extensions: true, used: (usage) => used.push(total(usage)) });
    const back = Date.now();
    assert.deepEqual(withoutTimes(notedBy(it, "fetched")), ["fetched: stop"]);
    assert.ok(back >= notedAt(it, "fetched"), `the call came back ${notedAt(it, "fetched") - back} ms before the reply had`);
    assert.ok(used[0] > 1200, `the call used ${used[0]}`);
  }

  // Stopped with the call: cancelled while the reply is being fetched. What is asked after is refused — but not
  // that the provider give the reply up, which asks no model: of a provider that can; of one that cannot, it fails as it would for anyone.
  {
    const it = await user(t);
    it.put(it.agentDir, "extensions/later.ts", KEEPS_FOR_LATER(2, `pi.on("session_shutdown", async (_event, ctx) => {
    const { model, handle } = await kept(ctx);
    const runtime = ctx.modelRegistry.runtime;
    note("fetching");
    note("fetched: " + (await runtime.fetchDeferred(model, handle, {})).stopReason);
    const again = await runtime.fetchDeferred(model, handle, {});
    note("fetched again: " + again.stopReason + ", " + again.errorMessage);
    note("had it given up: " + await tried(runtime.cancelDeferred(model, handle, {})) + ", " + faux.state.cancelledDeferred.length + " given up");
    note("had another give one up: " + await tried(runtime.cancelDeferred(ctx.model, handle, {})));
  });`));
    const cancel = new AbortController();
    const call = it.ask("say hello", { extensions: true, signal: cancel.signal });
    call.catch(() => {});
    await waitFor(() => notedBy(it, "fetching").length === 1, "the reply to be being fetched", 30_000);
    cancel.abort();
    await call.then(() => {}, () => {});
    await waitFor(() => notedBy(it, "had another").length === 1, "the extension to have done all it does", 5000);
    assert.deepEqual(notedBy(it, "fetched"), ["fetched: aborted", "fetched again: aborted, The call is to ask no more."]);
    assert.deepEqual(notedBy(it, "had"), ["had it given up: done, 1 given up", "had another give one up: threw: Provider fake does not support deferred responses"]);
  }
});

test("what pi asks for itself beside its agent's turns — a summary of a conversation grown long — is asked by the call's runner as the turns are", async (t) => {
  // A model with little room: after the first turn the conversation is past what pi keeps, and pi asks for a summary of it.
  const kinds = [];
  const it = await user(t, (request, stream) => {
    const summary = !request.tools?.length;
    kinds.push(summary ? "a summary" : "a turn");
    if (!summary && kinds.filter((kind) => kind === "a turn").length === 1) stream.calls("read", { path: "a.txt" });
    else { stream.says({ role: "assistant", content: summary ? "what was done so far" : "the answer" }); stream.says({}, "stop"); }
    stream.done({ prompt_tokens: 2800, completion_tokens: 200, total_tokens: 3000 });
  });
  it.put(it.agentDir, "models.json", JSON.stringify({ providers: { fake: {
    baseUrl: `http://127.0.0.1:${it.port}/v1`, api: "openai-completions", apiKey: "$TRAMA_TEST_KEY",
    models: [{ id: "plain", contextWindow: 3000, maxTokens: 500, cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } }],
  } } }));
  it.put(it.agentDir, "settings.json", JSON.stringify({ compaction: { reserveTokens: 500, keepRecentTokens: 100 } }));
  it.put(it.cwd, "a.txt", "what the file says. ".repeat(200));
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine"));
  // The process that serves the calls is started with one key, and the runner has another by the next call.
  await askedWith(it, "the first", "read a.txt and go on", { extensions: true });
  const before = it.requests.length;
  kinds.length = 0;
  const used = [];
  assert.equal(await askedWith(it, "the second", "read a.txt and go on", { extensions: true, used: (usage) => used.push(total(usage)) }), "the answer");
  assert.ok(kinds.includes("a summary") && kinds.includes("a turn"), `pi summed the conversation up: ${kinds}`);
  assert.deepEqual(it.headers.slice(before).map(keyOf), kinds.map(() => "Bearer the second"));
  assert.deepEqual(used, [kinds.length * 3000]);
});

test("a request that has nothing under a name is the same request asked by the runner: what the name takes out of it is out", async (t) => {
  const it = await user(t);
  withKeyBy(it);
  // Each asked twice: as it is — by the runner — and with a hook of the extension's own, which has it asked where the extension is.
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `pi.on("agent_end", async (_event, ctx) => {
    ${SAYING}
    const models = ctx.modelRegistry, sampled = models.find("fake", "sampled");
    const ways = {
      "a parameter of the model's own, by complete": (text, more) => models.complete(sampled, saying(text), { samplingParams: { top_p: undefined }, ...more }),
      "a parameter of the model's own, by streamSimple": (text, more) => models.streamSimple(sampled, saying(text), { samplingParams: { top_p: undefined }, ...more }).result(),
      "a header of the provider's own": (text, more) => models.complete(ctx.model, saying(text), { headers: { "x-configured": undefined, "x-own": "said" }, ...more }),
      // (pi lays headers one over another in the order of their names, and takes a name for the same whatever its case.)
      "a header taken out, and then put in": (text, more) => models.complete(ctx.model, saying(text), { headers: { "x-configured": undefined, "X-Configured": "mine" }, ...more }),
      "a header put in, and then taken out": (text, more) => models.complete(ctx.model, saying(text), { headers: { "X-Configured": "mine", "x-configured": undefined }, ...more }),
    };
    for (const [name, ask] of Object.entries(ways)) for (const [where, more] of [["handed over", {}], ["asked here", { onResponse: () => {} }]]) note("asked " + name + ", " + where + ": " + (await ask(name + ", " + where, more)).stopReason);
  });`));
  await askedWith(it, "the first", "say hello", { extensions: true });
  const before = it.requests.length;
  await askedWith(it, "the second", "say hello", { extensions: true });
  const seen = Object.fromEntries(it.requests.slice(before + 1).map((request, at) => {
    const headers = it.headers[before + 1 + at];
    return [lastSaid(request), { by: keyOf(headers), top_p: request.top_p, seed: request.seed, configured: headers["x-configured"], own: headers["x-own"] }];
  }));
  const RUNNER = "Bearer the second", HOST = "Bearer the first";
  for (const [where, by] of [["handed over", RUNNER], ["asked here", HOST]]) {
    // (The model's own way of being sampled, less what the request took out of it; the provider's own header, taken out.)
    for (const way of ["by complete", "by streamSimple"]) assert.deepEqual(seen[`a parameter of the model's own, ${way}, ${where}`], { by, top_p: undefined, seed: 7, configured: "yes", own: undefined }, `${way}, ${where}`);
    assert.deepEqual(seen[`a header of the provider's own, ${where}`], { by, top_p: undefined, seed: undefined, configured: undefined, own: "said" }, where);
    assert.equal(seen[`a header taken out, and then put in, ${where}`].by, by, where);
  }
  // (Whatever pi makes of each order, it makes the same of it wherever the request is asked.)
  for (const order of ["a header taken out, and then put in", "a header put in, and then taken out"]) {
    assert.deepEqual({ ...seen[`${order}, handed over`], by: 0 }, { ...seen[`${order}, asked here`], by: 0 }, order);
  }
  assert.notEqual(seen["a header taken out, and then put in, handed over"].configured, seen["a header put in, and then taken out, handed over"].configured);
  // (And a request that says nothing of either has both.)
  assert.equal(it.headers[before]["x-configured"], "yes");
});

test("a provider of an extension's that passes what the agent asked with on to another model, with a hook of its own in it, has that model asked where it is: the hook is its hand in the request", async (t) => {
  const priced = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 };
  // The provider is handed all the agent's request goes with — pi's own hooks among it — and asks a model of pi's with
  // that: as it is; with a hook of its own in the place of one of pi's; and with something more that is no data.
  // (The provider is the call's own model's, made the extension's; the model it asks is another provider's, which is pi's.)
  const PASSES_ON = (more, by) => `let models;
  const by = "${by}";
  pi.on("session_start", (_event, ctx) => { models = ctx.modelRegistry; });
  pi.registerProvider("fake", { name: "Outer", baseUrl: "http://127.0.0.1:9/unused", apiKey: "none", api: "outer-api",
    models: [{ id: "plain", name: "plain", reasoning: false, input: ["text"], cost: ${JSON.stringify(priced)}, contextWindow: 100000, maxTokens: 4000 }],
    streamSimple: (_model, context, options) => models[by](models.find("inner", "i1"), context, { ...options, apiKey: undefined, headers: undefined, env: undefined, ${more} }),
  });`;
  for (const [how, more, asker, noted, by = "streamSimple"] of [
    ["as it is", "", "Bearer the second", []],
    ["with a hook of its own", `onResponse: (response) => { note("its hook was called: " + response.status); }`, "Bearer the first", ["its hook was called: 200"]],
    ["with something more that is no data", `since: new Date(0)`, "Bearer the first", []],
    ["with a function of its own under a name the provider might read", `mine: () => {}`, "Bearer the first", []],
    // (Without all of pi's own hooks it is not a request as the agent makes one; nor is it one asked by the options of
    // the model's own provider, which may read whatever it is given: what the agent's loop is set up by stays with either.)
    ["with one of pi's hooks taken out", `onProviderStreamEvent: undefined`, "Bearer the first", []],
    ["as it is, by the options of the model's own provider", "", "Bearer the first", [], "stream"],
  ]) {
    const it = await user(t);
    it.put(it.agentDir, "models.json", JSON.stringify({ providers: {
      fake: { baseUrl: `http://127.0.0.1:${it.port}/v1`, api: "openai-completions", apiKey: "$TRAMA_TEST_KEY", models: [{ id: "plain", cost: priced }] },
      inner: { baseUrl: `http://127.0.0.1:${it.port}/v1`, api: "openai-completions", apiKey: "$TRAMA_TEST_KEY", models: [{ id: "i1", cost: priced }] },
    } }));
    it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", PASSES_ON(more, by)));
    const ask = (key, call = {}) => withEnv({ ...it.env, TRAMA_TEST_KEY: key }, () => it.adapter.ask("say hello", { cwd: it.cwd, extensions: true, ...call }));
    await ask("the first");
    const before = it.requests.length, from = notedBy(it, "its hook").length, used = [];
    assert.equal(await ask("the second", { used: (usage) => used.push(total(usage)) }), "hello from the fake", how);
    assert.deepEqual(it.headers.slice(before).map(keyOf), [asker], how);
    assert.deepEqual(notedBy(it, "its hook").slice(from), noted, how);
    assert.deepEqual(used, [1200], how);
  }
});
