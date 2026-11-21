import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { llm } from "./fake-llm.mjs";
import { runProgram } from "../packages/runtime/dist/runner.js";
import { printJournals } from "../packages/runtime/dist/journal-view.js";
import { captureConsole, cleanupTempDir, createProjectFixture, makeTempDir } from "./helpers.mjs";

// A program's own tools: functions of the program's that the agent of one call has, beside the agent's own.
// Here the model is a stand-in that calls them as a backend would have its model call them — what a backend
// makes of them is asked of the real pi elsewhere.

const journalsOf = (projectDir) => {
  const dir = join(projectDir, "logs", "journal");
  return readdirSync(dir).sort().map((file) => readFileSync(join(dir, file), "utf-8").trim().split("\n").map((line) => JSON.parse(line)));
};

/** Stand in for the model while a test runs. */
function standIn(t, ask) {
  const original = llm.ask;
  llm.ask = ask;
  t.after(() => { llm.ask = original; });
}

const project = (t, programSource) => {
  const projectDir = makeTempDir("trama-own-tools-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, { programSource });
  return projectDir;
};
const run = (projectDir, more = {}) => runProgram({ projectDir, maxRepairAttempts: 0, timeout: 20_000, ...more });
const byName = (call) => Object.fromEntries(call.ownTools.map((tool) => [tool.name, tool]));

test("a tool of the program's own is the agent's: the program is asked each time the model calls it, and what it returns is the model's to read", async (t) => {
  const projectDir = project(t, `import { ctx, agent } from "@trama-dev/runtime";
const orders = { "7": { id: "7", total: 12.5 } };
const kept = [];
const answer = await agent.instruct("look up order 7", { tools: ["read", {
  name: "lookup", description: "Find an order by its id", parameters: { id: "string: the order's id", lines: ["number"] },
  run: async ({ id }) => { if (!orders[id]) throw new Error("no order " + id); return orders[id]; },
}, { name: "note", description: "Keep a note", parameters: { text: "string" }, run: ({ text }) => { kept.push(text + " in " + process.pid); } },
  { name: "word", description: "Says a word", run: (args, { signal }) => "a word, " + JSON.stringify(args) + ", " + (signal instanceof AbortSignal) }] });
await ctx.done({ answer: JSON.parse(answer), kept, pid: process.pid });`);
  const seen = {};
  standIn(t, async (_prompt, call) => {
    seen.tools = call.tools;
    seen.own = call.ownTools.map(({ run, ...declared }) => ({ ...declared, run: typeof run }));
    const { lookup, note, word } = byName(call);
    return JSON.stringify([
      await lookup.run({ id: "7", lines: [1] }, "c1", call.signal),
      await lookup.run({ id: "8", lines: [] }, "c2", call.signal),
      await note.run({ text: "kept" }, "c3", call.signal),
      await word.run({}, "c4", call.signal),
    ]);
  });

  const { result, status } = await run(projectDir);
  assert.equal(status, "done");
  // The agent's own tools are named as they were, and the program's are beside them: each as it declared itself, its
  // parameters as JSON Schema says them — every field to be there, and no other.
  assert.deepEqual(seen.tools, ["read"]);
  assert.deepEqual(seen.own, [
    { name: "lookup", description: "Find an order by its id", run: "function", parameters: {
      type: "object", required: ["id", "lines"], additionalProperties: false,
      properties: { id: { type: "string", description: "the order's id" }, lines: { type: "array", items: { type: "number" } } },
    } },
    { name: "note", description: "Keep a note", run: "function", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
    { name: "word", description: "Says a word", run: "function", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } },
  ]);
  // What a tool returns is said as it is, or as JSON says it; what it throws is how it failed; nothing is "Done.".
  assert.deepEqual(result.answer, [
    { text: '{"id":"7","total":12.5}' },
    { text: "no order 8", failed: true },
    { text: "Done." },
    { text: "a word, {}, true" },
  ]);
  // ...and it ran in the program, which is not this process.
  assert.deepEqual(result.kept, [`kept in ${result.pid}`]);
  assert.notEqual(result.pid, process.pid);

  // On record: the call, and under it each use of a tool with what the program answered. How the program came
  // to be asked is no call of its own.
  const [records] = journalsOf(projectDir);
  assert.deepEqual(records.filter((record) => record.kind === "call").map((record) => [record.seq, record.endpoint]), [[1, "/agent/instruct"], [2, "/ctx/done"]]);
  assert.deepEqual(records.find((record) => record.kind === "call").request.tools.map((tool) => tool.name ?? tool), ["read", "lookup", "note", "word"]);
  assert.deepEqual(
    records.filter((record) => record.kind === "tool-call").map(({ seq, tool, id, name, args }) => [seq, tool, id, name, args]),
    [[1, 1, "c1", "lookup", { id: "7", lines: [1] }], [1, 2, "c2", "lookup", { id: "8", lines: [] }], [1, 3, "c3", "note", { text: "kept" }], [1, 4, "c4", "word", {}]],
  );
  assert.deepEqual(
    records.filter((record) => record.kind === "tool-result").map(({ seq, tool, ok, result, error }) => [seq, tool, ok, result ?? error]),
    [[1, 1, true, '{"id":"7","total":12.5}'], [1, 2, false, "no order 8"], [1, 3, true, "Done."], [1, 4, true, "a word, {}, true"]],
  );
  const shown = (await captureConsole("log", async () => printJournals(projectDir, "it", {}))).messages.join("\n");
  assert.match(shown, /#1 {3}agent\/instruct +look up order 7 +ok/);
  assert.match(shown, /#1 {5}tool lookup +\{"id":"7","lines":\[1\]\} +ok +\d+ms/);
  assert.match(shown, /#1 {5}tool lookup +\{"id":"8","lines":\[\]\} +failed +\d+ms +no order 8/);
});

test("what is wrong with a tool as it was written is the call's failure, before anything is asked", async (t) => {
  const projectDir = project(t, `import { ctx, agent } from "@trama-dev/runtime";
const run = () => "x";
const tool = (more) => ({ name: "mine", description: "A tool", run, ...more });
const said = (tools, more) => agent.instruct("p", { tools, ...more }).then((answer) => "answered: " + answer, (err) => err.message);
await ctx.done({
  noRun: await said([{ name: "mine", description: "A tool" }]),
  runNoFunction: await said([tool({ run: "x" })]),
  name: await said([tool({ name: "my tool!" })]),
  long: await said([tool({ name: "x".repeat(65) })]),
  noName: await said([{ description: "A tool", run }]),
  noDescription: await said([{ name: "mine", run }]),
  blank: await said([tool({ description: "  " })]),
  field: await said([tool({ params: { n: "number" } })]),
  parallel: await said([tool({ parallel: "yes" })]),
  ends: await said([tool({ ends: 1 })]),
  parameters: await said([tool({ parameters: "string" })]),
  kind: await said([tool({ parameters: { n: "integer" } })]),
  twice: await said([tool(), tool()]),
  named: await said(["mine", tool()]),
  neither: await said(["read", 7]),
  // A list of names and nothing else is as it always was: the backend's to read.
  names: await said(["read", "read"]),
  none: await said([]),
  // Where the program waits to be asked is the client's to say, and no option of a call.
  toolsId: await said(["read"], { toolsId: "x" }),
  misspelt: await said([tool()], { tool: ["read"] }),
});`);
  let asked = 0;
  standIn(t, async (_prompt, call) => { asked += 1; return JSON.stringify([call.tools, call.ownTools?.length ?? 0]); });
  const { result, status } = await run(projectDir);
  assert.equal(status, "done");
  const refused = (why) => `trama runtime error: Invalid field: tools (${why})`;
  assert.deepEqual(result, {
    noRun: `the tool "mine" has no run: a tool of the program's own is a function of the program's`,
    runNoFunction: `the tool "mine" has no run: a tool of the program's own is a function of the program's`,
    name: refused(`A tool's name is letters, digits, "_" and "-", 64 of them at most: not "my tool!"`),
    long: refused(`A tool's name is letters, digits, "_" and "-", 64 of them at most: not "${"x".repeat(65)}"`),
    noName: refused(`A tool's name is letters, digits, "_" and "-", 64 of them at most: not undefined`),
    noDescription: refused(`The tool "mine" has no description: it is all a model is told of what the tool is for`),
    blank: refused(`The tool "mine" has no description: it is all a model is told of what the tool is for`),
    field: refused(`The tool "mine" has a field a tool does not take: params (a tool takes: name, description, parameters, parallel, ends, run)`),
    parallel: refused(`The tool "mine": parallel is true or false, not string`),
    ends: refused(`The tool "mine": ends is true or false, not number`),
    parameters: refused(`The tool "mine": Schema validation failed: a tool's parameters are an object of the fields it is called with`),
    kind: refused(`The tool "mine": Schema validation failed: unsupported schema type "integer" for key "n" (a list is written as the shape of its items, in brackets: ["string"]; an object as its fields: { name: "string" })`),
    twice: refused(`Two tools are named "mine": a tool is called by its name`),
    named: refused(`Two tools are named "mine": a tool is called by its name`),
    neither: "trama runtime error: Invalid field: tools (expected strings or tools or undefined)",
    names: 'answered: [["read","read"],0]',
    none: "answered: [[],0]",
    toolsId: "trama runtime error: Invalid field: toolsId (the call has no tools of the program's own)",
    misspelt: "trama runtime error: Unknown field: tool (this call takes: prompt, system, model, thinking, tools, skills, extensions, cutOff, templates)",
  });
  assert.equal(asked, 2);
});

test("tools the model calls together are each the program's to answer, and a typed answer's call has them as any call has", async (t) => {
  const projectDir = project(t, `import { ctx, agent } from "@trama-dev/runtime";
const order = [];
const slow = (name, ms) => ({ name, description: "Waits", parameters: { n: "number" }, parallel: true,
  run: async ({ n }) => { order.push("start " + name + n); await new Promise((resolve) => setTimeout(resolve, ms)); order.push("end " + name + n); return name + n; } });
const typed = await agent.generate({ prompt: "p", schema: { got: ["string"] }, tools: [slow("a", 150), slow("b", 20)] });
// Two calls at once, each with a tool of its own by the same name: each is asked of its own.
const both = await Promise.all(["first", "second"].map((which) =>
  agent.instruct(which, { tools: [{ name: "which", description: "Says which call it is of", run: () => which }] })));
await ctx.done({ typed, order, both });`);
  standIn(t, async (prompt, call) => {
    const tools = byName(call);
    if (tools.which) return (await tools.which.run({}, "c", call.signal)).text;
    assert.deepEqual([call.tools, tools.a.parallel, tools.b.parallel], [[], true, true]);
    const answers = await Promise.all([tools.a.run({ n: 1 }, "c1", call.signal), tools.b.run({ n: 2 }, "c2", call.signal), tools.a.run({ n: 3 }, "c3", call.signal)]);
    return JSON.stringify({ got: answers.map((answer) => answer.text) });
  });
  const { result, status } = await run(projectDir);
  assert.equal(status, "done");
  assert.deepEqual(result.typed, { got: ["a1", "b2", "a3"] });
  assert.deepEqual(result.order.slice(0, 3).sort(), ["start a1", "start a3", "start b2"]);
  assert.equal(result.order[3], "end b2");
  assert.deepEqual(result.both, ["first", "second"]);
  const [records] = journalsOf(projectDir);
  assert.deepEqual(records.filter((record) => record.kind === "tool-call" && record.seq === 1).map((record) => [record.tool, record.id, record.name]), [[1, "c1", "a"], [2, "c2", "b"], [3, "c3", "a"]]);
  assert.equal(records.filter((record) => record.kind === "tool-result").length, 5);
});

test("a tool is told when its call is to go no further, and is not waited for: what it says after that is nobody's", async (t) => {
  const projectDir = project(t, `import { ctx, agent } from "@trama-dev/runtime";
const heard = [];
const hears = (name, more = {}) => ({ name, description: "Waits to be told to stop", run: (_args, { signal }) => new Promise((resolve) => {
  heard.push(name + " began");
  signal.addEventListener("abort", () => { heard.push(name + " was told to stop"); resolve("too late"); });
}), ...more });
const first = await agent.instruct("cancelled", { tools: [hears("stopped"), { name: "heard", description: "Says what was heard", run: () => heard }] });
const second = await agent.instruct("over", { tools: [hears("left")] });
// (The program hears of it by a call of its own that the runner answers: a moment for that.)
await new Promise((resolve) => setTimeout(resolve, 300));
await ctx.done({ first, second, heard });`);
  standIn(t, async (prompt, call) => {
    const [tool] = call.ownTools;
    if (prompt === "cancelled") {
      // The backend stops one use of the tool — as it does where its call is cancelled, or the budget is reached.
      const stop = new AbortController();
      const started = Date.now();
      const answering = tool.run({}, "c1", stop.signal);
      await new Promise((resolve) => setTimeout(resolve, 100));
      stop.abort();
      const answer = await answering;
      const waited = Date.now() - started < 1000;
      // ...and one that is asked once the call is to go no further is not asked at all.
      const after = await tool.run({}, "c2", stop.signal);
      // The tool is told to stop there and then, while its call goes on: the program says what it has heard.
      let told;
      for (let tries = 0; tries < 40 && !told?.includes("stopped was told to stop"); tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        told = JSON.parse((await call.ownTools[1].run({}, "c-heard", call.signal)).text);
      }
      return JSON.stringify({ answer, after, waited, told });
    }
    // The call comes to its end while a tool of its is running: nobody waits for that.
    void tool.run({}, "c3", call.signal);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return "over while its tool ran";
  });
  const { result, status } = await run(projectDir);
  assert.equal(status, "done");
  const stopped = { text: "The call was stopped before the tool had answered.", failed: true };
  assert.deepEqual(JSON.parse(result.first), { answer: stopped, after: stopped, waited: true, told: ["stopped began", "stopped was told to stop"] });
  assert.equal(result.second, "over while its tool ran");
  assert.deepEqual(result.heard, ["stopped began", "stopped was told to stop", "left began", "left was told to stop"]);
  // A use that was not waited for has no answer on record; one that was never asked is not on record at all.
  const [records] = journalsOf(projectDir);
  assert.deepEqual(records.filter((record) => record.kind === "tool-call" && record.name !== "heard").map((record) => [record.seq, record.id]), [[1, "c1"], [2, "c3"]]);
  const heardAsked = records.filter((record) => record.kind === "tool-call" && record.name === "heard").map((record) => record.tool);
  assert.deepEqual(records.filter((record) => record.kind === "tool-result").map((record) => record.tool), heardAsked);
  const shown = (await captureConsole("log", async () => printJournals(projectDir, "it", {}))).messages.join("\n");
  assert.match(shown, /tool stopped +\{\} +never answered/);
});

test("a tool can do what its program can: make a call of its own, which is the run's like any", async (t) => {
  const projectDir = project(t, `import { ctx, agent, tools } from "@trama-dev/runtime";
const answer = await agent.instruct("outer", { tools: [{ name: "ask", description: "Asks another agent", parameters: { question: "string" },
  run: async ({ question }) => (await agent.instruct(question)) + " / " + (await tools.shell("echo from a shell")).stdout.trim() }] });
await ctx.done({ answer });`);
  standIn(t, async (prompt, call) => (prompt === "outer" ? (await call.ownTools[0].run({ question: "inner" }, "c1", call.signal)).text : `answer to ${prompt}`));
  const { result } = await run(projectDir, { budget: { calls: 5 } });
  assert.deepEqual(result, { answer: "answer to inner / from a shell" });
  const [records] = journalsOf(projectDir);
  assert.deepEqual(records.filter((record) => record.kind === "call").map((record) => [record.seq, record.endpoint]),
    [[1, "/agent/instruct"], [2, "/agent/instruct"], [3, "/tools/shell"], [4, "/ctx/done"]]);
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("bytes a tool returns are an image for the model to see, told by how they begin — and a tool says where its answer is the call's", async (t) => {
  const projectDir = project(t, `import { ctx, agent } from "@trama-dev/runtime";
const png = Buffer.from(${JSON.stringify(PNG)}, "base64");
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const tool = (name, run, more = {}) => ({ name, description: "Returns " + name, run, ...more });
const answer = await agent.instruct("p", { tools: [
  tool("picture", () => png),
  tool("both", () => ["the chart", png, { n: 1 }, jpeg]),
  tool("words", () => ["only", "words"]),
  tool("bytes", () => Buffer.from("these are no image")),
  tool("last", () => "the last word", { ends: true }),
] });
await ctx.done({ answer: JSON.parse(answer) });`);
  const seen = {};
  standIn(t, async (_prompt, call) => {
    seen.ends = call.ownTools.map((tool) => [tool.name, tool.ends]);
    const answers = [];
    for (const tool of call.ownTools) answers.push(await tool.run({}, `c-${tool.name}`, call.signal));
    return JSON.stringify(answers);
  });
  const { result, status } = await run(projectDir);
  assert.equal(status, "done");
  assert.deepEqual(result.answer, [
    { text: "", images: [{ mimeType: "image/png", data: PNG }] },
    { text: 'the chart\n{"n":1}', images: [{ mimeType: "image/png", data: PNG }, { mimeType: "image/jpeg", data: "/9j/4AAQ" }] },
    // (A list with no bytes in it is a list, as JSON says one.)
    { text: '["only","words"]' },
    { text: "the tool returned bytes that are no image a model is shown: not a PNG, a JPEG, a GIF or a WebP", failed: true },
    { text: "the last word" },
  ]);
  assert.deepEqual(seen.ends, [["picture", undefined], ["both", undefined], ["words", undefined], ["bytes", undefined], ["last", true]]);
  // On record: what kind of image, and how large. Not the image.
  const [records] = journalsOf(projectDir);
  assert.deepEqual(records.filter((record) => record.kind === "tool-result").map(({ tool, ok, result: said, images }) => [tool, ok, said, images]), [
    [1, true, "", [{ mimeType: "image/png", bytes: 70 }]],
    [2, true, 'the chart\n{"n":1}', [{ mimeType: "image/png", bytes: 70 }, { mimeType: "image/jpeg", bytes: 6 }]],
    [3, true, '["only","words"]', undefined],
    [4, false, undefined, undefined],
    [5, true, "the last word", undefined],
  ]);
  assert.ok(!JSON.stringify(records.filter((record) => record.kind.startsWith("tool-"))).includes(PNG));
});

test("what a program says a tool answered is held to what an answer is, whoever says it — and how a tool's use is carried is no call on record", async (t) => {
  const projectDir = project(t, `import { ctx } from "@trama-dev/runtime";
import { readFileSync } from "fs";
const { token } = JSON.parse(readFileSync(process.env.TRAMA_INIT, "utf-8"));
const post = (endpoint, body) => fetch("http://127.0.0.1:" + process.env.TRAMA_PORT + endpoint, {
  method: "POST", headers: { Authorization: "Bearer " + token }, body: JSON.stringify(body),
}).then(async (res) => res.status + " " + (await res.text()));
const image = { mimeType: "image/png", data: ${JSON.stringify(PNG)} };
const answers = [];
for (const body of [
  { text: "words", error: "and an error" },
  {},
  { text: "", images: "one" },
  { text: "", images: [{ ...image, mimeType: "text/html" }] },
  { text: "", images: [{ ...image, data: "<not base64>" }] },
  { text: "", images: [{ ...image, data: "" }] },
  { text: "", images: [{ ...image, more: true }] },
  { text: "", images: [image.data] },
  { error: "it failed", images: [image] },
  { text: "", extra: 1 },
  // What is an answer is taken — and, being of no use of a tool that anybody waits for, said to nobody.
  { text: "words", images: [image] },
  { text: "words", images: [] },
  { error: "it failed" },
]) answers.push(await post("/agent/tool/answered", { of: "no call", key: "1", ...body }));
await ctx.done({ answers });`);
  const { result, status } = await run(projectDir);
  assert.equal(status, "done");
  const images = "400 Invalid field: images (expected a list of images, each its mimeType — image/png, image/jpeg, image/gif, image/webp — and its data, in base64)";
  assert.deepEqual(result.answers, [
    "400 A tool's answer is its text, or the error it failed with: one of the two",
    "400 A tool's answer is its text, or the error it failed with: one of the two",
    images, images, images, images, images, images,
    "400 Invalid field: images (a tool that failed has its error, and no images)",
    "400 Unknown field: extra (this call takes: of, key, text, images, error)",
    '200 {"result":null}', '200 {"result":null}', '200 {"result":null}',
  ]);
  const [records] = journalsOf(projectDir);
  assert.deepEqual(records.filter((record) => record.kind === "call").map((record) => record.endpoint), ["/ctx/done"]);
});
