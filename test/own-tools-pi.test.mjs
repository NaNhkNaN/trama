import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runProgram } from "../packages/runtime/dist/runner.js";
import { EXTENSION, user } from "./pi-user.mjs";
import { cleanupTempDir, createProjectFixture, makeTempDir, waitFor, withEnv } from "./helpers.mjs";

// What pi's agent makes of tools that are its caller's own (see own-tools.test.mjs for how a program comes to
// be the caller). The model is a server in the test's process, and says what the test has it say.

/** A reply that calls tools — each [name, arguments] — all in the one reply. */
const calling = (stream, ...calls) => {
  stream.says({ role: "assistant", tool_calls: calls.map(([name, args], index) => ({ index, id: `call-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) });
  stream.says({}, "tool_calls");
  stream.done();
};
const saying = (stream, words) => { stream.says({ role: "assistant", content: words }); stream.says({}, "stop"); stream.done(); };
/** A model that makes the replies it is given, one for each request, and then answers. */
const scripted = (...replies) => (_request, stream) => (replies.length > 0 ? calling(stream, ...replies.shift()) : saying(stream, "the answer"));
const toolResults = (request) => request.messages.filter((message) => message.role === "tool").map((message) => message.content);

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PARAMETERS = { type: "object", properties: { n: { type: "number", description: "how many" } }, required: ["n"], additionalProperties: false };
/** A tool of the caller's own, which writes down each time it is asked. */
const own = (asked, name, more = {}) => ({
  name, description: `The ${name} tool of the caller's`, parameters: PARAMETERS,
  run: async (args, id, signal) => { asked.push([name, args, id, signal instanceof AbortSignal]); return { text: `${name} says ${args.n}` }; },
  ...more,
});

test("pi's agent has a call's own tools beside the ones it named: declared as they are written, called with what their parameters allow, answered with what they say", async (t) => {
  const asked = [];
  const it = await user(t, scripted([["mine", { n: 1 }]], [["mine", { n: "many" }]], [["mine", { n: 2, more: true }]], [["fails", { n: 3 }]], [["throws", { n: 4 }]]));
  const answer = await it.ask("use your tools", { tools: ["read"], ownTools: [
    own(asked, "mine"),
    own(asked, "fails", { run: async () => ({ text: "it did not work", failed: true }) }),
    own(asked, "throws", { run: async () => { throw new Error("thrown by the caller"); } }),
  ] });
  assert.equal(answer, "the answer");
  // The model is declared the tools the call named and the call's own, each as written.
  assert.deepEqual(it.toolsOf(it.requests[0]), ["read", "mine", "fails", "throws"]);
  assert.deepEqual(it.requests[0].tools.find((tool) => tool.function.name === "mine").function, { name: "mine", description: "The mine tool of the caller's", parameters: PARAMETERS });
  // It was asked for what its parameters allow, and no more: what they do not allow went back to the model, unasked.
  assert.deepEqual(asked, [["mine", { n: 1 }, "call-0", true]]);
  const results = toolResults(it.requests.at(-1));
  assert.equal(results[0], "mine says 1");
  assert.match(results[1], /^Validation failed for tool "mine":\n +- n: expected number, got string/);
  assert.match(results[2], /^Validation failed for tool "mine":\n +- more: unknown field/);
  // A tool's failure is the model's to read, and the call goes on: said so by the tool, or thrown.
  assert.deepEqual(results.slice(3), ["it did not work", "thrown by the caller"]);
  assert.equal(it.requests.length, 6);

  // Where the call names no tools, its own are beside pi's choice; where it names none, its own are all the agent has.
  await it.ask("p", { ownTools: [own(asked, "mine")] });
  assert.deepEqual(it.toolsOf(it.requests.at(-1)), ["read", "bash", "edit", "write", "mine"]);
  await it.ask("p", { tools: [], ownTools: [own(asked, "mine")] });
  assert.deepEqual(it.toolsOf(it.requests.at(-1)), ["mine"]);
});

test("a name that is another tool's is not taken over: the call fails, and no model is asked", async (t) => {
  const it = await user(t);
  const asked = [];
  // pi's own — those it gives an agent unasked, and those it has besides. (pi would have the caller's be the tool, with no word of it.)
  for (const name of ["read", "bash", "grep", "ls"]) {
    await assert.rejects(() => it.ask("p", { ownTools: [own(asked, name)] }), { message: `The tool "${name}" cannot be the call's own: pi has a tool of that name.` });
    await assert.rejects(() => it.ask("p", { tools: ["edit"], ownTools: [own(asked, name)] }), { message: `The tool "${name}" cannot be the call's own: pi has a tool of that name.` });
  }
  await assert.rejects(() => it.ask("p", { ownTools: [own(asked, "mcp__files__read")] }), { message: `The tool "mcp__files__read" cannot be the call's own: a name that begins "mcp__" is a tool of an MCP server's.` });
  await assert.rejects(() => it.ask("p", { ownTools: [own(asked, "mine"), own(asked, "other"), own(asked, "mine")] }), { message: `Two of the call's own tools are named "mine".` });
  assert.equal(it.requests.length, 0);
});

test("the tools a model calls in one reply are run one after the other, unless each says it may run beside another", async (t) => {
  const line = [];
  const waits = (name, ms, more = {}) => ({
    name, description: "Waits", parameters: PARAMETERS, ...more,
    run: async () => { line.push(`${name} begins`); await new Promise((resolve) => setTimeout(resolve, ms)); line.push(`${name} ends`); return { text: name }; },
  });
  const it = await user(t, (request, stream) => (toolResults(request).length > 0 ? saying(stream, "the answer") : calling(stream, ["slow", { n: 1 }], ["quick", { n: 2 }])));
  await it.ask("p", { ownTools: [waits("slow", 200), waits("quick", 10)] });
  assert.deepEqual(line.splice(0), ["slow begins", "slow ends", "quick begins", "quick ends"]);
  // (Whatever the order they ended in, the model has their answers in the order it called them.)
  await it.ask("p", { ownTools: [waits("slow", 200, { parallel: true }), waits("quick", 10, { parallel: true })] });
  assert.deepEqual(line.splice(0), ["slow begins", "quick begins", "quick ends", "slow ends"]);
  assert.deepEqual(toolResults(it.requests.at(-1)), ["slow", "quick"]);
  // One that does not say so has all of them run in turn.
  await it.ask("p", { ownTools: [waits("slow", 200, { parallel: true }), waits("quick", 10)] });
  assert.deepEqual(line.splice(0), ["slow begins", "slow ends", "quick begins", "quick ends"]);
});

test("a call that is cancelled while a tool of its own runs is not held by the tool: the tool is told, and no model is asked again", async (t) => {
  const it = await user(t, scripted([["deaf", { n: 1 }]]));
  const heard = [];
  let began;
  const running = new Promise((resolve) => { began = resolve; });
  // A tool that hears it is to stop, and never answers.
  const deaf = { name: "deaf", description: "Never answers", parameters: PARAMETERS, run: (_args, _id, signal) => new Promise(() => {
    signal.addEventListener("abort", () => heard.push("told to stop"));
    began();
  }) };
  const cancel = new AbortController();
  const asking = it.ask("p", { ownTools: [deaf], signal: cancel.signal }).then(() => "answered", (err) => err.message);
  await running;
  const cancelled = Date.now();
  cancel.abort();
  assert.equal(await asking, "Aborted");
  assert.ok(Date.now() - cancelled < 2_000, `the call was over ${Date.now() - cancelled}ms after it was cancelled`);
  await waitFor(() => heard.length === 1, "the tool to hear that its call was cancelled");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(it.requests.length, 1);
});

test("a call that is served in a process of its own has its caller's tools all the same: each is run where the caller is", async (t) => {
  const asked = [];
  const it = await user(t, scripted([["mine", { n: 1 }]], [["ext_tool", {}]], [["mine", { n: 2 }], ["mine", { n: 3 }]]));
  it.put(it.agentDir, "extensions/ext.ts", EXTENSION("ext"));
  const here = (name) => own(asked, name, { run: async (args, id) => { asked.push([name, args, id, process.pid]); return { text: `${name} says ${args.n} in ${process.pid}` }; } });
  assert.equal(await it.ask("use your tools", { extensions: true, ownTools: [here("mine")] }), "the answer");
  // The agent was in another process, with the extension — and the caller's tool was run in this one.
  assert.ok(it.pids().length === 1 && it.pids()[0] !== process.pid);
  assert.ok(it.seen().some(([, what]) => what === "ext: its tool is used"));
  assert.deepEqual(asked, [["mine", { n: 1 }, "call-0", process.pid], ["mine", { n: 2 }, "call-0", process.pid], ["mine", { n: 3 }, "call-1", process.pid]]);
  assert.ok(it.toolsOf(it.requests[0]).includes("mine") && it.toolsOf(it.requests[0]).includes("ext_tool"));
  assert.deepEqual(toolResults(it.requests.at(-1)), [`mine says 1 in ${process.pid}`, "the ext tool answers", `mine says 2 in ${process.pid}`, `mine says 3 in ${process.pid}`]);

  // A tool of an extension's is not taken over either: found where the agent has all it is to have, before the model is asked.
  const before = it.requests.length;
  await assert.rejects(
    () => it.ask("p", { extensions: true, ownTools: [here("ext_tool")] }),
    (err) => /^The tool "ext_tool" cannot be the call's own: the extension .*ext\.ts has a tool of that name\.$/.test(err.message),
  );
  assert.equal(it.requests.length, before);
});

test("a call served in a process of its own is cancelled as any: a tool of the caller's that is running is told, and the call is not held", async (t) => {
  const it = await user(t, scripted([["deaf", { n: 1 }]]));
  it.put(it.agentDir, "extensions/ext.ts", EXTENSION("ext"));
  const heard = [];
  let began;
  const running = new Promise((resolve) => { began = resolve; });
  const deaf = { name: "deaf", description: "Never answers", parameters: PARAMETERS, run: (_args, _id, signal) => new Promise(() => {
    signal.addEventListener("abort", () => heard.push("told to stop"));
    began();
  }) };
  const cancel = new AbortController();
  const asking = it.ask("p", { extensions: true, ownTools: [deaf], signal: cancel.signal }).then(() => "answered", (err) => err.message);
  await running;
  const cancelled = Date.now();
  cancel.abort();
  assert.equal(await asking, "Aborted");
  assert.ok(Date.now() - cancelled < 3_000, `the call was over ${Date.now() - cancelled}ms after it was cancelled`);
  await waitFor(() => heard.length === 1, "the tool to hear that its call was cancelled");
  assert.equal(it.requests.length, 1);
});

test("a program's tools are its agent's by the real pi, where the call is served here and where it is served by a host — and are called with what they declared, whoever asks", async (t) => {
  const it = await user(t, (request, stream) => {
    const results = toolResults(request);
    const has = (name) => (request.tools ?? []).some((tool) => tool.function.name === name);
    if (results.length === 0 && has("count")) return calling(stream, ["count", { n: 1 }]);
    if (results.length === 0 && has("verdict")) return calling(stream, ["verdict", { ok: true, why: "it holds" }]);
    if (results.length === 0 && has("draw")) return calling(stream, ["draw", {}]);
    return saying(stream, `the model read: ${results.at(-1)}`);
  });
  // An extension that would have the program's tool called for itself, with what the tool does not take — by the
  // channel of the process it is in, as that process asks for a tool.
  it.put(it.agentDir, "extensions/ext.ts", EXTENSION("ext", `pi.on("session_start", () => { process.send?.({ tool: { key: "forged", name: "count", id: "x", args: { n: "a word" } } }); });`));
  const projectDir = makeTempDir("trama-own-tools-pi-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    metaInput: { prompt: "p", args: {} },
    programSource: `import { ctx, agent } from "@trama-dev/runtime";
const got: unknown[] = [];
const count = { name: "count", description: "Counts", parameters: { n: "number: how many" }, run: ({ n }: { n: number }) => { got.push(n); return "counted " + n + " in " + process.pid; } };
const told = (err: any) => String(err.message);
const here = await agent.instruct("count to one", { tools: [count] });
const hosted = await agent.instruct("count to one", { tools: [count], extensions: true });
const taken = await agent.instruct("p", { tools: [{ ...count, name: "ext_tool" }], extensions: true }).catch(told);
const pis = await agent.instruct("p", { tools: ["bash", { ...count, name: "read" }] }).catch(told);
const verdict = { name: "verdict", description: "Hand over the verdict", ends: true, parameters: { ok: "boolean", why: "string" }, run: (said: object) => said };
const typed = await agent.generate({ prompt: "judge it", schema: { ok: "boolean", why: "string" }, tools: [verdict] });
const typedHosted = await agent.generate({ prompt: "judge it", schema: { ok: "boolean", why: "string" }, tools: [verdict], extensions: true });
const png = Buffer.from("${PNG}", "base64");
const drawn = await agent.instruct("draw it", { extensions: true, tools: [{ name: "draw", description: "Draws", ends: true, run: () => ["drawn by the program", png] }] });
await ctx.done({ here, hosted, taken, pis, got, typed, typedHosted, drawn, pid: process.pid });
`,
  });
  const meta = JSON.parse(readFileSync(join(projectDir, "meta.json"), "utf-8"));
  writeFileSync(join(projectDir, "meta.json"), JSON.stringify({ ...meta, provider: "fake", model: "plain" }));

  const { result, status } = await withEnv(it.env, () => runProgram({ projectDir, maxRepairAttempts: 0, timeout: 60_000 }));
  assert.equal(status, "done");
  const { pid } = result;
  // A typed answer handed over by a tool that ends the agent's work is held to its shape as any is — here, and by a host.
  assert.deepEqual([result.typed, result.typedHosted], [{ ok: true, why: "it holds" }, { ok: true, why: "it holds" }]);
  assert.equal(result.drawn, "drawn by the program");
  assert.equal(result.here, `the model read: counted 1 in ${pid}`);
  assert.equal(result.hosted, `the model read: counted 1 in ${pid}`);
  assert.match(result.taken, /^trama runtime error: Error: The tool "ext_tool" cannot be the call's own: the extension .*ext\.ts has a tool of that name\.$/);
  assert.equal(result.pis, `trama runtime error: Error: The tool "read" cannot be the call's own: pi has a tool of that name.`);
  // The tool was called with a number each time the model called it — and not with what the extension sent.
  assert.deepEqual(result.got, [1, 1]);
  assert.ok(it.seen().some(([, what]) => what.startsWith("ext: a session begins")));

  const dir = join(projectDir, "logs", "journal");
  const records = readdirSync(dir).flatMap((file) => readFileSync(join(dir, file), "utf-8").trim().split("\n").map((line) => JSON.parse(line)));
  assert.deepEqual(records.filter((record) => record.kind === "tool-call" && record.name === "count").map(({ seq, name, args }) => [seq, name, args]), [[1, "count", { n: 1 }], [2, "count", { n: 1 }]]);
  assert.deepEqual(records.filter((record) => record.kind === "tool-result" && record.seq <= 2).map(({ seq, ok, result: said }) => [seq, ok, said]), [[1, true, `counted 1 in ${pid}`], [2, true, `counted 1 in ${pid}`]]);
  assert.deepEqual(records.filter((record) => record.kind === "tool-result").at(-1).images, [{ mimeType: "image/png", bytes: 70 }]);
});

test("a process that serves a call and ends with a tool of the caller's running fails that call, and the tool is told", async (t) => {
  const it = await user(t, scripted([["deaf", { n: 1 }]]));
  // An extension that brings its process down a moment after a tool is called.
  it.put(it.agentDir, "extensions/ext.ts", EXTENSION("ext", `pi.on("tool_call", () => { setTimeout(() => process.exit(3), 150); });`));
  const heard = [];
  const deaf = { name: "deaf", description: "Never answers", parameters: PARAMETERS, run: (_args, _id, signal) => new Promise(() => {
    heard.push("began");
    signal.addEventListener("abort", () => heard.push("told to stop"));
  }) };
  await assert.rejects(() => it.ask("p", { extensions: true, ownTools: [deaf] }), /exit|ended|code 3/);
  await waitFor(() => heard.length === 2, "the tool to hear that its call is over");
  assert.deepEqual(heard, ["began", "told to stop"]);
});

test("a tool that ends the agent's work has what it said be the call's answer: the model is not asked again — unless the tool failed, or another was called beside it that ends nothing", async (t) => {
  const asked = [];
  let tries = 0;
  const verdict = own(asked, "verdict", { ends: true });
  // The agent works, and then hands its answer over.
  const it = await user(t, scripted([["look", { n: 1 }]], [["verdict", { n: 7 }]]));
  assert.equal(await it.ask("p", { ownTools: [own(asked, "look"), verdict] }), "verdict says 7");
  assert.equal(it.requests.length, 2);
  assert.deepEqual(asked.map(([name]) => name), ["look", "verdict"]);

  // One that fails has ended nothing: the model reads why, and calls it again.
  const failing = await user(t, scripted([["verdict", { n: 1 }]], [["verdict", { n: 2 }]]));
  const picky = own(asked, "verdict", { ends: true, run: async ({ n }) => ((tries += 1) === 1 ? { text: "not yet", failed: true } : { text: `accepted ${n}` }) });
  assert.equal(await failing.ask("p", { ownTools: [picky] }), "accepted 2");
  assert.deepEqual(toolResults(failing.requests[1]), ["not yet"]);
  assert.equal(failing.requests.length, 2);

  // Called beside a tool that ends nothing, it has not ended the agent's work either: the model is asked again, and its reply is the answer.
  const beside = await user(t, scripted([["verdict", { n: 1 }], ["look", { n: 2 }]]));
  assert.equal(await beside.ask("p", { ownTools: [own(asked, "look"), verdict] }), "the answer");
  assert.deepEqual(toolResults(beside.requests[1]), ["verdict says 1", "look says 2"]);
  // ...and two that end it, in one reply, have: the answer is what the last of them said.
  const twice = await user(t, scripted([["verdict", { n: 1 }], ["verdict", { n: 2 }]]));
  assert.equal(await twice.ask("p", { ownTools: [verdict] }), "verdict says 2");
  assert.equal(twice.requests.length, 1);
});

test("an image a tool answers with is shown to a model that takes images, and a model that takes none is told there was one", async (t) => {
  const it = await user(t, (request, stream) => (toolResults(request).length > 0 ? saying(stream, "the answer") : calling(stream, ["draw", { n: 1 }])));
  it.put(it.agentDir, "models.json", JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${it.port}/v1`, api: "openai-completions", apiKey: "none", models: [
    { id: "plain", cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } },
    { id: "sees", input: ["text", "image"], cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } },
  ] } } }));
  const draws = (answer) => ({ name: "draw", description: "Draws", parameters: PARAMETERS, run: async () => answer });
  const image = { mimeType: "image/png", data: PNG };
  const tail = (request) => request.messages.slice(-2).map((message) => [message.role, message.content]);

  await it.ask("p", { model: "fake/sees", ownTools: [draws({ text: "the chart", images: [image] })] });
  assert.deepEqual(tail(it.requests.at(-1)), [
    ["tool", "the chart"],
    ["user", [{ type: "text", text: "Attached image(s) from tool result:" }, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }]],
  ]);
  // An image and no words: pi says for itself that there is something to see.
  await it.ask("p", { model: "fake/sees", ownTools: [draws({ text: "", images: [image, image] })] });
  assert.equal(tail(it.requests.at(-1))[0][1], "(see attached image)");
  assert.equal(tail(it.requests.at(-1))[1][1].length, 3);
  // A model that takes no images is told by pi that there was one.
  await it.ask("p", { model: "fake/plain", ownTools: [draws({ text: "the chart", images: [image] })] });
  assert.deepEqual(tail(it.requests.at(-1))[1], ["tool", "the chart\n(tool image omitted: model does not support images)"]);
});

test("a run that another's tool ended has no answer of the call's own tool: only what its own tool said is its answer", async (t) => {
  // An extension with a tool that ends the agent's run, as pi lets a tool do.
  const it = await user(t, scripted([["quits", {}]]));
  it.put(it.agentDir, "extensions/ext.ts", EXTENSION("ext", `pi.registerTool({ name: "quits", label: "quits", description: "Ends the run", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "the extension's last word" }], details: undefined, terminate: true }; } });`));
  const asked = [];
  await assert.rejects(() => it.ask("p", { extensions: true, ownTools: [own(asked, "verdict", { ends: true })] }), { message: "Empty response from LLM" });
  assert.deepEqual(asked, []);
});
