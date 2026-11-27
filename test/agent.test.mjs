import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { createAgent } from "../packages/runtime/dist/agent.js";
import { captureConsole, cleanupTempDir, makeTempDir, withEnv } from "./helpers.mjs";

test("createAgent instruct hands the backend the prompt, where to work, and the options", async () => {
  const calls = [];
  const adapter = {
    async ask(prompt, options) {
      calls.push({ prompt, options });
      return "adapter reply";
    },
  };

  const agent = createAgent(adapter, "/work");
  const result = await agent.instruct("hello", { system: "sys" });

  assert.equal(result, "adapter reply");
  assert.deepEqual(calls, [{ prompt: "hello", options: { cwd: "/work", system: "sys", signal: undefined } }]);
});

test("createAgent generate strips fenced JSON and validates the requested shape", async () => {
  const adapter = {
    async ask() {
      return "```json\n{\"reasoning\":\"ok\",\"success\":true}\n```";
    },
  };

  const agent = createAgent(adapter, "/work");
  const result = await agent.generate({
    prompt: "analyze",
    schema: {
      reasoning: "string: why this works",
      success: "boolean: whether it passed",
    },
    system: "system prompt",
  });

  assert.deepEqual(result, { reasoning: "ok", success: true });
});

test("createAgent generate retries once after a validation failure", async () => {
  const prompts = [];
  let attempt = 0;
  const adapter = {
    async ask(prompt) {
      prompts.push(prompt);
      attempt += 1;
      if (attempt === 1) {
        return "{\"reasoning\":123}";
      }
      return "{\"reasoning\":\"fixed\"}";
    },
  };

  const agent = createAgent(adapter, "/work");
  const result = await agent.generate({
    prompt: "repair",
    schema: { reasoning: "string: explanation" },
  });

  assert.deepEqual(result, { reasoning: "fixed" });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /failed validation/);
});

test("createAgent instruct passes abort signal to adapter", async () => {
  const calls = [];
  const adapter = {
    async ask(prompt, options) {
      calls.push(options);
      return "reply";
    },
  };

  const controller = new AbortController();
  const agent = createAgent(adapter, "/work", controller.signal);
  await agent.instruct("hello");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal, controller.signal);
});

test("createAgent instruct works without a signal", async () => {
  const calls = [];
  const adapter = {
    async ask(prompt, options) {
      calls.push(options);
      return "reply";
    },
  };

  const agent = createAgent(adapter, "/work");
  await agent.instruct("hello", { system: "sys" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].system, "sys");
  assert.equal(calls[0].signal, undefined);
});

test("createAgent generate surfaces the second failure when retries are exhausted", async () => {
  const adapter = {
    async ask() {
      return "{\"count\":\"wrong\"}";
    },
  };

  const agent = createAgent(adapter, "/work");

  await assert.rejects(
    async () => agent.generate({
      prompt: "count",
      schema: { count: "number: result count" },
    }),
    /Schema validation failed: count: expected number, got string/,
  );
});

test("createAgent generate rejects unsupported schema types, before anything is asked", async () => {
  let asked = 0;
  const adapter = {
    async ask() {
      asked += 1;
      return '{"items": [1,2,3]}';
    },
  };

  const agent = createAgent(adapter, "/work");

  await assert.rejects(
    async () => agent.generate({
      prompt: "list",
      schema: { items: "array: list of numbers" },
    }),
    /unsupported schema type "array"/,
  );
  // What is wrong is the program's own schema: no reply could satisfy it, so none is paid for.
  assert.equal(asked, 0);
});

test("createAgent generate does NOT retry on adapter.ask() errors (network/auth)", async () => {
  let askCallCount = 0;
  const adapter = {
    async ask() {
      askCallCount++;
      throw new Error("ECONNREFUSED: network error");
    },
  };

  const agent = createAgent(adapter, "/work");

  await assert.rejects(
    async () => agent.generate({
      prompt: "count",
      schema: { count: "number: result count" },
    }),
    /ECONNREFUSED: network error/,
  );
  assert.equal(askCallCount, 1, "adapter.ask should only be called once for non-parse errors");
});

test("createAgent generate strips extra keys from LLM response", async () => {
  const adapter = {
    async ask() {
      return '{"reasoning":"ok","success":true,"extraField":"surprise","another":42}';
    },
  };

  const agent = createAgent(adapter, "/work");
  const result = await agent.generate({
    prompt: "analyze",
    schema: { reasoning: "string", success: "boolean" },
  });

  assert.deepEqual(result, { reasoning: "ok", success: true });
  assert.equal("extraField" in result, false, "extra keys should be stripped");
  assert.equal("another" in result, false, "extra keys should be stripped");
});

test("createAgent generate retries on parse error from first ask but not adapter failure on retry", async () => {
  let askCallCount = 0;
  const adapter = {
    async ask() {
      askCallCount++;
      if (askCallCount === 1) return "not json at all";
      throw new Error("rate limit exceeded");
    },
  };

  const agent = createAgent(adapter, "/work");

  await assert.rejects(
    async () => agent.generate({
      prompt: "count",
      schema: { count: "number" },
    }),
    /rate limit exceeded/,
  );
  assert.equal(askCallCount, 2, "should have retried once after parse failure");
});

test("createAgent generate parses valid JSON containing fenced code in string values", async () => {
  const adapter = {
    async ask() {
      return '{"summary":"Use this:\\n```json\\n{\\"a\\":1}\\n```","ok":true}';
    },
  };

  const agent = createAgent(adapter, "/work");
  const result = await agent.generate({
    prompt: "summarize",
    schema: { summary: "string: the summary", ok: "boolean: success" },
  });

  assert.equal(result.ok, true);
  assert.match(result.summary, /```json/);
});

test("createAgent generate extracts JSON from fenced response with leading text", async () => {
  const adapter = {
    async ask() {
      return 'Here is the result:\n```json\n{"count":42}\n```\nHope that helps!';
    },
  };

  const agent = createAgent(adapter, "/work");
  const result = await agent.generate({
    prompt: "count",
    schema: { count: "number: the count" },
  });

  assert.deepEqual(result, { count: 42 });
});

// --- PiAdapter abort wiring tests (mock session, no real LLM) ---

test("PiAdapter.ask rejects immediately when signal is already aborted", async () => {
  const { PiAdapter } = await import("../packages/runtime/dist/pi-adapter.js");

  const adapter = new PiAdapter({ provider: "anthropic", model: "test" });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    async () => adapter.ask("hello", { cwd: process.cwd(), signal: controller.signal }),
    /Aborted/,
  );
});

test("PiAdapter.ask calls session.dispose on abort during prompt", async () => {
  const { PiAdapter } = await import("../packages/runtime/dist/pi-adapter.js");

  let disposeCalled = 0;
  let rejectPrompt;
  const fakeSession = {
    state: { messages: [] },
    // Simulate upstream contract: prompt is a pending call that rejects when disposed
    prompt: () => new Promise((_resolve, reject) => { rejectPrompt = reject; }),
    // (A cancelled call has pi abort its run, which settles the prompt; the session is disposed of once it has.)
    abort: async () => { rejectPrompt?.(new Error("Session disposed")); },
    dispose: () => {
      disposeCalled++;
      // Upstream contract: dispose() causes the in-flight prompt() to reject
      rejectPrompt?.(new Error("Session disposed"));
    },
  };

  // Override createSession to return our mock
  const adapter = new PiAdapter({ provider: "anthropic", model: "test" });
  adapter.createSession = async () => fakeSession;

  const controller = new AbortController();
  const promise = adapter.ask("hello", { cwd: process.cwd(), signal: controller.signal });

  // Abort after a tick — should dispose the session and reject the prompt
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();

  await assert.rejects(async () => promise, /disposed/i);
  assert.ok(disposeCalled > 0, "session.dispose should have been called");
});

test("PiAdapter.ask cleans up abort listeners after successful calls", async () => {
  const { PiAdapter } = await import("../packages/runtime/dist/pi-adapter.js");

  const adapter = new PiAdapter({ provider: "openai", model: "gpt-5.4" });

  const controller = new AbortController();

  // Exercise the real createSession() path, which attaches two abort listeners
  // via raceAbort(). They must be cleaned up after each successful call.
  for (let i = 0; i < 5; i++) {
    const session = await adapter.createSession(process.cwd(), undefined, controller.signal);
    assert.equal(
      getEventListeners(controller.signal, "abort").length,
      0,
      `abort listeners should be cleaned up after successful createSession() call ${i + 1}`,
    );
    session.dispose();
  }

  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  // Nor is one left by a call that fails before its session is made: it names a model there is not.
  for (let i = 0; i < 3; i++) {
    await assert.rejects(adapter.ask("to nobody", { cwd: process.cwd(), model: "nope/none", signal: controller.signal }), /Unknown model/);
  }
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  controller.abort();
  await assert.rejects(
    async () => adapter.ask("after abort", { cwd: process.cwd(), signal: controller.signal }),
    /Aborted/,
  );
});

test("PiAdapter warns once when the configured model is not in pi's catalog", async (t) => {
  const { PiAdapter } = await import("../packages/runtime/dist/pi-adapter.js");

  // Isolated pi config dir: the result must not depend on the developer's own ~/.pi/agent.
  const agentDir = makeTempDir("trama-pi-agent-");
  t.after(() => cleanupTempDir(agentDir));
  // Nor on what is in their shell: a provider's key there is a model for pi to fall back to. So none of the
  // variables pi takes for a provider's credentials is set here (their names end so, or begin so), and the home
  // is one with no cloud's credentials in it.
  const noCredentials = Object.fromEntries(Object.keys(process.env)
    .filter((name) => /_(API_KEY|TOKEN|TOKEN_FILE)$|^(ANTHROPIC|AWS|GOOGLE|GCLOUD)_/.test(name))
    .map((name) => [name, undefined]));

  await withEnv({ ...noCredentials, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", HOME: agentDir }, async () => {
    const unknown = new PiAdapter({ provider: "anthropic", model: "no-such-model-typo" });
    const { messages } = await captureConsole("warn", async () => {
      // Two sessions, plus one in another directory — still one warning.
      (await unknown.createSession(process.cwd())).dispose();
      (await unknown.createSession(process.cwd())).dispose();
      (await unknown.createSession(agentDir)).dispose();
    });
    assert.equal(messages.length, 1, `expected exactly one warning, got: ${JSON.stringify(messages)}`);
    assert.match(messages[0], /anthropic\/no-such-model-typo/);
    assert.match(messages[0], /not found/);
    // The isolated config dir has no credentials, so there is nothing to fall back to —
    // pi's placeholder model must not be reported as a fallback.
    assert.match(messages[0], /no fallback model available/);
    assert.doesNotMatch(messages[0], /unknown\/unknown/);

    const known = new PiAdapter({ provider: "openai", model: "gpt-5.4" });
    const { messages: none } = await captureConsole("warn", async () => {
      (await known.createSession(process.cwd())).dispose();
    });
    assert.deepEqual(none, [], "a model that exists in the catalog must not warn");
  });
});

test("stripCodeFences extracts code from responses with leading text", async () => {
  const { stripCodeFences } = await import("../packages/runtime/dist/agent.js");

  const withPrefix = "Here is the fixed program:\n\n```typescript\nconst x = 1;\n```";
  assert.equal(stripCodeFences(withPrefix), "const x = 1;");

  const withMultipleBlocks = "Before:\n```typescript\nold code\n```\n\nAfter:\n```typescript\nnew code\n```";
  assert.equal(stripCodeFences(withMultipleBlocks), "new code", "should extract the last fenced block");

  // Plain unfenced code should pass through unchanged
  const plain = "const y = 2;";
  assert.equal(stripCodeFences(plain), "const y = 2;");

  // ...apart from the whitespace around it
  assert.equal(stripCodeFences("\n  const value = 1;\n\n"), "const value = 1;");
});

test("stripCodeFences preserves unfenced code with inner fences and extracts outer fences around inner fence text", async () => {
  const { stripCodeFences } = await import("../packages/runtime/dist/agent.js");

  const unfencedWithDoc = [
    "/**",
    " * Example:",
    " * ```ts",
    " * const sample = 42;",
    " * ```",
    " */",
    "export const template = `\\n```json\\n{\"ok\":true}\\n```\\n`;",
  ].join("\n");
  assert.equal(stripCodeFences(unfencedWithDoc), unfencedWithDoc);

  const fencedWithInner = `Updated program:\n\n\`\`\`typescript\n${unfencedWithDoc}\n\`\`\``;
  assert.equal(stripCodeFences(fencedWithInner), unfencedWithDoc);
});

test("createAgent generate rejects non-finite numbers in number schema fields and retries", async () => {
  let attempt = 0;
  const adapter = {
    async ask() {
      attempt += 1;
      return attempt === 1 ? '{"score": 1e500}' : '{"score": 99.5}';
    },
  };

  const agent = createAgent(adapter, "/work");
  const result = await agent.generate({
    prompt: "score it",
    schema: { score: "number: finite score" },
  });

  assert.equal(attempt, 2);
  assert.deepEqual(result, { score: 99.5 });
});

// --- A reply's fences, and a program's own ---

test("stripCodeFences takes the block out of a reply, whatever stands around it", async () => {
  const { stripCodeFences } = await import("../packages/runtime/dist/agent.js");
  const F = "```";
  const program = "/** The program. */\nexport default async function run() {}";
  for (const [what, reply, expected = program] of [
    ["words before it that mention a glob", `It now lists \`docs/*.md\`:\n\n${F}ts\n${program}\n${F}`],
    ["words before it that open a comment the program closes at once", `I removed the /* TODO marker.\n\n${F}ts\n${program}\n${F}`],
    ["words before it that open a comment nothing closes", `I removed the /* TODO marker.\n\n${F}ts\nexport default 1;\n${F}`, "export default 1;"],
    ["words before it that open a comment the program closes", `Use /* for comments.\n${F}ts\nexport default 1; // a */ b\n${F}`, "export default 1; // a */ b"],
    ["words before it with an apostrophe and a backtick", `Here's the \` character, and the program:\n${F}ts\n${program}\n${F}`],
    ["words after it", `${F}ts\n${program}\n${F}\n\nThat is all of it.`],
    ["a line of the words before it that begins as a comment would, and never ends", `Notes:\n/* see below\n${F}ts\nexport default 1;\n${F}`, "export default 1;"],
    ["a pattern in the words before it, and one in the words after", `It reads ./*.json:\n\n${F}ts\nexport default 1;\n${F}\n\nOr point it at **/*.json.`, "export default 1;"],
    ["a command before it that names files by a pattern", `${F}bash\ntrama run it --arg files=./*.json\n${F}\n\nThe program:\n\n${F}ts\n${program}\n${F}`],
    ["a line of words before it that begins with a fence and a word", `${F} markers\nare not needed, but here:\n\n${F}ts\n${program}\n${F}`],
    ["one backtick in the words before it, and one after", `Note the \` character:\n\n${F}ts\n${program}\n${F}\n\nThe \` is meant.`],
    ["a line of words before it that ends in a fence and a word", `I wrapped it in ${F} fences\n\n${F}ts\n${program}\n${F}`],
    ["a closing fence with a full stop after it", `${F}ts\n${program}\n${F}.`],
    ["an item of a list, indented by four", `1. The program:\n\n    ${F}ts\n    export default 1;\n    ${F}`, "export default 1;"],
    ["a fence that opens at the end of a line of words", `Sure: ${F}ts\n${program}\n${F}`],
    ["a closing fence with words after it", `${F}ts\n${program}\n${F} done`],
    ["lines that end as Windows ends them", `${F}ts\r\nexport default 1;\r\n${F}\r\n`, "export default 1;"],
    ["a block before it", `Before:\n${F}ts\nold\n${F}\nAfter:\n${F}ts\n${program}\n${F}`],
    ["a longer fence around a shorter one", `${F}\`md\nSee:\n${F}ts\ncode\n${F}\n${F}\``, `See:\n${F}ts\ncode\n${F}`],
    ["a longer fence that only a shorter one closes", `${F}\`ts\nexport default 1;\n${F}`, "export default 1;"],
    ["a block whose comment never ends", `${F}ts\n/* unfinished\nexport default 1;\n${F}`, "/* unfinished\nexport default 1;"],
  ]) assert.equal(stripCodeFences(reply), expected, what);

  // What is no block is left as it is: a fence nothing closes, three backticks among words, no fence at all.
  for (const reply of [`${F}ts\nexport default 1;`, `Wrap it in ${F} and then run it.`, `${F} typescript\n${program}\n${F}`, program]) {
    assert.equal(stripCodeFences(reply), reply);
  }
});

test("stripCodeFences leaves a program the fences it wrote down itself", async () => {
  const { stripCodeFences } = await import("../packages/runtime/dist/agent.js");
  const F = "```";
  for (const [what, program] of [
    ["in a comment that shows how it is used", `/*\nUsage:\n${F}\ntrama run x\n${F}\n*/\nexport default 1;`],
    ["in a comment of one line", `// ${F}ts\nexport default 1;\n// ${F}`],
    ["in a comment of one line, and in one of many", `// As in: ${F}ts\n/*\n${F}\ntrama run x\n${F}\n*/\nexport default 1;`],
    ["in a comment, after an apostrophe that is no string's", `const p = <p>don't</p>;\n/*\n${F}\ntrama run x\n${F}\n*/\nexport default p;`],
    ["in a comment of many lines, each with its star", `/**\n * As in:\n * ${F}ts\n * run();\n * ${F}\n */\nexport default 1;`],
  ]) {
    assert.equal(stripCodeFences(program), program, `${what}, in a reply that is the program`);
    assert.equal(stripCodeFences(`Updated:\n\n${F}ts\n${program}\n${F}\n`), program, `${what}, in a reply that fences the program`);
  }

  // Nothing else of the program is read, so nothing else of it can mislead: a backtick in a pattern, say.
  assert.equal(stripCodeFences(`${F}ts\nconst parts = "a\`b".split(/\`/);\n/*\n${F}ts\nuse(parts);\n${F}\n*/\nexport default parts;\n${F}\n\nRun:\n${F}bash\ntrama run x\n${F}`), "trama run x");
  assert.equal(stripCodeFences(`Before:\n${F}ts\nconst tick = /\`/;\n${F}\n\nAfter:\n${F}ts\nexport default 2;\n${F}`), "export default 2;");
});

test("createAgent generate takes a field's type from words, and nothing else for words", async () => {
  const agent = createAgent({ async ask() { return '{"a": "x"}'; } }, "/work");
  for (const type of [7, null, true, "string[]", "list", "Object", "any", "String", ""]) {
    await assert.rejects(() => agent.generate({ prompt: "p", schema: { a: type } }), /unsupported schema type/, JSON.stringify(type));
  }
  assert.deepEqual(await agent.generate({ prompt: "p", schema: { a: "string: any text" } }), { a: "x" });
  // (A list is no word, nor an object by its fields: each is written as what it holds, and means that.)
  await assert.rejects(() => agent.generate({ prompt: "p", schema: { a: ["string"] } }), /a: expected a list, got string/);
  await assert.rejects(() => agent.generate({ prompt: "p", schema: { a: { type: "string" } } }), /a: expected an object, got string/);
  // (An object whatever its fields is a word — "object" — and an answer is held to it as to any kind: text is none.)
  await assert.rejects(() => agent.generate({ prompt: "p", schema: { a: "object: whatever was found" } }), /a: expected an object, got string/);
  const found = createAgent({ async ask() { return '{"a": {"any": [1, {"deep": null}]}, "b": 1}'; } }, "/work");
  assert.deepEqual(await found.generate({ prompt: "p", schema: { a: "object: whatever was found" } }), { a: { any: [1, { deep: null }] } });
});

// --- What a call asks of its backend, and what it is told the call used ---

test("createAgent hands the backend what a call asks for and nothing it did not, and passes on what it used", async () => {
  const calls = [];
  const usage = { model: "p/m", input: 3, output: 2, cacheRead: 1, cacheWrite: 0, cost: 0.5 };
  const backend = {
    async ask(prompt, call) {
      calls.push(call);
      call.used?.(usage);
      return calls.length === 2 ? "not json" : '{"a":"x"}';
    },
  };
  const agent = createAgent(backend, "/work");
  const heard = [];
  const used = (what) => heard.push(what);

  await agent.instruct("p", { system: "s", model: "p/m", thinking: "high", tools: ["read"] }, used);
  assert.deepEqual(calls[0], { cwd: "/work", system: "s", signal: undefined, model: "p/m", thinking: "high", tools: ["read"], used });
  assert.deepEqual(heard, [usage]);

  // A generate that has to ask again has used both askings — and is asked as it was the first time. It has the same say as an instruct.
  assert.deepEqual(await agent.generate({ prompt: "p", schema: { a: "string" }, model: "p/m", thinking: "off", tools: ["read"] }, used), { a: "x" });
  assert.deepEqual(calls[1], { cwd: "/work", system: undefined, signal: undefined, model: "p/m", thinking: "off", tools: ["read"], used });
  assert.deepEqual(await agent.generate({ prompt: "p", schema: { a: "string" }, tools: [] }), { a: "x" });
  assert.deepEqual(calls.pop(), { cwd: "/work", system: undefined, signal: undefined, tools: [] });
  assert.deepEqual(await agent.generate({ prompt: "p", schema: { a: "string" } }), { a: "x" });
  assert.deepEqual(calls.pop(), { cwd: "/work", system: undefined, signal: undefined });
  assert.deepEqual(calls[2], calls[1]);
  assert.deepEqual(heard, [usage, usage, usage]);

  // A typed answer's prompt is text, whatever it begins with — said to the backend where the call has what a prompt could call up.
  await agent.generate({ prompt: "/skill:x p", schema: { a: "string" }, skills: ["x"] });
  assert.deepEqual(calls.pop(), { cwd: "/work", system: undefined, signal: undefined, skills: ["x"], asText: true });
  await agent.generate({ prompt: "/cmd p", schema: { a: "string" }, extensions: true });
  assert.deepEqual(calls.pop(), { cwd: "/work", system: undefined, signal: undefined, extensions: true, asText: true });
  await agent.instruct("/skill:x p", { skills: ["x"], templates: true, extensions: true });
  assert.deepEqual(calls.pop(), { cwd: "/work", system: undefined, signal: undefined, skills: ["x"], templates: true, extensions: true });

  // No tools is something asked for; nothing asked for is not.
  await agent.instruct("p", { tools: [] });
  assert.deepEqual(calls[3], { cwd: "/work", system: undefined, signal: undefined, tools: [] });
  await agent.instruct("p");
  assert.deepEqual(calls[4], { cwd: "/work", system: undefined, signal: undefined });
});

// The pi adapter itself, served by a model that is a server in this process:
// pi is real, its catalog is a models.json of the test's, and nothing leaves
// the machine.
import { createServer as createModelServer } from "node:http";
import { writeFileSync as writeModelFile } from "node:fs";
import { join as joinPath } from "node:path";

/**
 * A provider `fake` with two models — `plain`, which does not think, and
 * `thinker`, which does — and a pi set up to know no others. `reply(request,
 * respond, hit)` answers each request; without it every request is answered
 * with a few words and a count of what they took.
 */
async function fakeProvider(t, reply, config = "plain") {
  const requests = [];
  const sse = (res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (choices, usage) => res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "fake", choices, ...(usage && { usage }) })}\n\n`);
    return {
      says: (delta, finish = null) => send([{ index: 0, delta, finish_reason: finish }]),
      used: (usage) => send([], usage),
      done: () => res.end("data: [DONE]\n\n"),
    };
  };
  const server = createModelServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const request = JSON.parse(body);
      requests.push(request);
      if (reply) return reply(request, { res, sse: () => sse(res) }, requests.length);
      const stream = sse(res);
      stream.says({ role: "assistant", content: "hello from the fake" });
      stream.says({}, "stop");
      stream.used({ prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, prompt_tokens_details: { cached_tokens: 300 } });
      stream.done();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const at = `http://127.0.0.1:${server.address().port}`;
  const agentDir = makeTempDir("trama-pi-agent-");
  const cwd = makeTempDir("trama-pi-cwd-");
  t.after(() => {
    server.closeAllConnections();
    server.close();
    cleanupTempDir(agentDir);
    cleanupTempDir(cwd);
  });
  writeModelFile(joinPath(agentDir, "models.json"), JSON.stringify({
    providers: {
      fake: {
        baseUrl: `${at}/v1`, api: "openai-completions", apiKey: "none",
        models: [
          { id: "plain", cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } },
          { id: "thinker", reasoning: true, cost: { input: 10, output: 20, cacheRead: 5, cacheWrite: 0 } },
          { id: "org/deep", cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } },
          { id: "terse", maxTokens: 200, cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } },
          { id: "small", contextWindow: 3000, maxTokens: 500, cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } },
        ],
      },
      "fake/two": { baseUrl: `${at}/v1`, api: "openai-completions", apiKey: "none", models: [{ id: "plain" }, { id: "org/deep" }] },
      // One that speaks as Anthropic does: what a request took to read is said when its answer begins.
      early: {
        baseUrl: at, api: "anthropic-messages", apiKey: "none",
        models: [{ id: "bird", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }],
      },
    },
  }));
  const { PiAdapter } = await import("../packages/runtime/dist/pi-adapter.js");
  const adapter = new PiAdapter({ provider: "fake", model: config });
  return {
    cwd,
    agentDir,
    requests,
    toolsOf: (request) => (request.tools ?? []).map((tool) => tool.function.name),
    // (pi looks for a user's skills in their home as well: here, a home that has none.)
    // A call is served in this process, where a test can see what an extension does: which is what a
    // host does with a call that has extensions (see agent-host.test.mjs for the host itself).
    ask: (prompt, call = {}) =>
      withEnv({ PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", HOME: agentDir }, () => adapter.serve(prompt, { cwd, ...call })),
    /** What the model was told at the last request made: by the system, and by the user. */
    told: () => {
      const text = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((part) => part.text).join(""));
      const messages = requests.at(-1).messages;
      return {
        system: messages.filter((message) => message.role === "system" || message.role === "developer").map(text).join("\n"),
        user: text(messages.filter((message) => message.role === "user").at(-1)),
      };
    },
  };
}

test("pi serves a call with the model, the level and the tools it names, and says what that took", async (t) => {
  const fake = await fakeProvider(t);
  const heard = [];
  const used = (usage) => heard.push(usage);

  // Nothing named: the project's model, and pi's own choice of tools.
  assert.equal(await fake.ask("say hello", { used }), "hello from the fake");
  assert.equal(fake.requests[0].model, "plain");
  assert.deepEqual(fake.toolsOf(fake.requests[0]), ["read", "bash", "edit", "write"]);
  assert.equal(heard.length, 1);
  const { cost, ...counted } = heard[0];
  assert.deepEqual(counted, { model: "fake/plain", input: 700, output: 200, cacheRead: 300, cacheWrite: 0 });
  assert.ok(Math.abs(cost - 0.00125) < 1e-9, `a million tokens in cost 1, out 2, from the cache 0.5: ${cost}`);

  // Another model, told how much to think, with one tool and with none.
  await fake.ask("say hello", { model: "fake/thinker", thinking: "high", tools: ["read"], used });
  assert.equal(fake.requests[1].model, "thinker");
  assert.equal(fake.requests[1].reasoning_effort, "high");
  assert.deepEqual(fake.toolsOf(fake.requests[1]), ["read"]);
  assert.equal(heard[1].model, "fake/thinker");
  assert.ok(Math.abs(heard[1].cost - 0.0125) < 1e-9, `the other model's prices: ${heard[1].cost}`);

  await fake.ask("say hello", { model: "fake/thinker", thinking: "off", tools: [] });
  assert.equal(fake.requests[2].reasoning_effort, undefined);
  assert.deepEqual(fake.toolsOf(fake.requests[2]), []);
  // Not thinking is a level every model has; and pi has more tools than it chooses by itself.
  await fake.ask("say hello", { thinking: "off", tools: ["ls", "read", "grep", "find", "read"] });
  assert.deepEqual(fake.toolsOf(fake.requests[3]).sort(), ["find", "grep", "ls", "read"]);
  assert.equal(heard.length, 2, "who does not ask is not told");

  // A provider's name ends at the first stroke; a model's may have more of them — a call's, and a project's.
  // A model is named "provider/model", and either name may have a stroke of its own — a call's, and a project's.
  await fake.ask("say hello", { model: "fake/org/deep", used });
  assert.equal(fake.requests[4].model, "org/deep");
  assert.equal(heard[2].model, "fake/org/deep");
  await fake.ask("say hello", { model: "fake/two/plain", used });
  await fake.ask("say hello", { model: "fake/two/org/deep", used });
  assert.deepEqual(heard.slice(3).map(usage => usage.model), ["fake/two/plain", "fake/two/org/deep"]);
  const deep = await fakeProvider(t, undefined, "org/deep");
  await deep.ask("say hello");
  assert.equal(deep.requests[0].model, "org/deep");
});

test("what pi cannot give a call as it was asked is the call's failure — the model is not asked something else instead", async (t) => {
  const fake = await fakeProvider(t);
  const heard = [];

  for (const model of ["fake/nope", "nope/plain", "plain", "", "/plain", "fake/", "fake/two", "fake/two/nope", "two/plain", "fake/plain/"]) {
    await assert.rejects(() => fake.ask("p", { model, used: (usage) => heard.push(usage) }), /Unknown model ".*"\. A model is named "provider\/model"/, model);
  }
  // pi would have taken each of these and served the call at another level.
  for (const [model, thinking] of [["fake/thinker", "max"], ["fake/thinker", "xhigh"], ["fake/thinker", "bogus"], ["fake/plain", "high"], [undefined, "minimal"]]) {
    await assert.rejects(
      () => fake.ask("p", { ...(model && { model }), thinking }),
      new RegExp(`The model ${model ?? "fake/plain"} does not think at level "${thinking}"\\. Its levels: off`),
      `${model} ${thinking}`,
    );
  }
  // ...and each of these with other tools: a name it has not got left out, a pattern or a change to its own choice taken for one.
  for (const [tools, given] of [
    [["nope"], []], [["read", "nope"], ["read"]], [["re*"], ["read"]], [["READ"], []], [[""], []],
    [["+grep"], ["read", "bash", "edit", "write", "grep"]], [["-bash"], ["read", "edit", "write"]],
  ]) {
    await assert.rejects(
      () => fake.ask("p", { tools }),
      { message: `The agent cannot be given the tools ${JSON.stringify(tools)}: pi would give it ${JSON.stringify(given)}.` },
      JSON.stringify(tools),
    );
  }
  assert.deepEqual(fake.requests, [], "no model was asked anything");
  assert.deepEqual(heard, [], "and nothing was used");
});

test("a provider's refusal is the call's error, in the provider's words", async (t) => {
  const fake = await fakeProvider(t, (_request, { res }) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "the fake will not have it", type: "invalid_request_error" } }));
  });
  const heard = [];
  await assert.rejects(() => fake.ask("p", { used: (usage) => heard.push(usage) }), /The model did not answer: 400.*the fake will not have it/);
  assert.deepEqual(heard, [], "a request that was refused took nothing, and nothing is said of it");
});

test("the answer is the model's last reply as it happened — not an earlier one, where pi took the last out of the conversation", async (t) => {
  // pi takes a reply out of what the model is shown next when the provider refused the request as too long, or the
  // reply was cut off: the last reply left there is the turn before, and that is not the answer.
  let then;
  const fake = await fakeProvider(t, (request, { res, sse }, hit) => {
    const how = hit === 1 && then !== "at once" ? "a tool first" : then === "at once" ? first : then;
    if (how === "too long") {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 190000 tokens.", type: "invalid_request_error", code: "context_length_exceeded" } }));
    }
    const stream = sse();
    if (how === "a tool first") {
      stream.says({ role: "assistant", content: "Let me look at the file first.", tool_calls: [{ index: 0, id: `call-${hit}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: "a.txt" }) } }] });
      stream.says({}, "tool_calls");
    } else {
      stream.says({ role: "assistant", content: how === "cut off" ? "The answer, which is cut at the li" : "the answer" });
      stream.says({}, how === "cut off" ? "length" : "stop");
    }
    stream.used({ prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 });
    stream.done();
  });
  writeModelFile(joinPath(fake.cwd, "a.txt"), "what the file says");
  let first;

  then = "the answer";
  assert.equal(await fake.ask("read a.txt and answer"), "the answer");
  for (const [how, why] of [
    ["too long", /The model did not answer: 400.*maximum context length is 128000 tokens/],
    ["cut off", /The model's answer was cut off at its output limit\./],
  ]) {
    then = how;
    await assert.rejects(() => fake.ask("read a.txt and answer"), why, `${how}, after a turn that went well`);
    then = "at once"; first = how;
    await assert.rejects(() => fake.ask("read a.txt and answer"), why, `${how}, at once`);
    // ...and where the limit it was cut off at is the model's own, which pi does not take for something to recover from.
    await assert.rejects(() => fake.ask("read a.txt and answer", { model: "fake/terse" }), why, `${how}, at the model's own limit`);
  }
});

test("a call that is stopped half-way has used what it had used by then", async (t) => {
  const stop = new AbortController();
  const fake = await fakeProvider(t, (_request, { sse }, hit) => {
    const stream = sse();
    if (hit === 1) {
      // First the model has the agent read a file — a turn that is finished and counted.
      stream.says({ role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "a.txt" }) } }] });
      stream.says({}, "tool_calls");
      stream.used({ prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 });
      return stream.done();
    }
    // Then it starts to answer, and the call is stopped while it does.
    stream.says({ role: "assistant", content: "the file says" });
    stop.abort();
  });
  writeModelFile(joinPath(fake.cwd, "a.txt"), "what the file says");

  const heard = [];
  await assert.rejects(() => fake.ask("read a.txt", { signal: stop.signal, used: (usage) => heard.push(usage) }), /Aborted/);
  assert.equal(fake.requests.length, 2);
  assert.match(JSON.stringify(fake.requests[1].messages), /what the file says/, "the agent did read the file for the model");
  assert.equal(heard.length, 1);
  assert.deepEqual({ ...heard[0], cost: undefined }, { model: "fake/plain", input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: undefined });
  assert.ok(heard[0].cost > 0);
});

test("a call stopped while the model answers has used what that request had taken to read", async (t) => {
  // A provider that says so when its answer begins: fifty thousand tokens were read, whether or not the answer is waited for.
  const stop = new AbortController();
  const fake = await fakeProvider(t, (_request, { res }) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "bird", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50000, output_tokens: 1 } } });
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "The answer begins, and " } });
    setTimeout(() => stop.abort(), 50);
  });

  const heard = [];
  await assert.rejects(() => fake.ask("p", { model: "early/bird", signal: stop.signal, used: (usage) => heard.push(usage) }), /Aborted/);
  assert.equal(heard.length, 1);
  assert.equal(heard[0].model, "early/bird");
  assert.equal(heard[0].input, 50000);
  assert.ok(Math.abs(heard[0].cost - 0.15) < 0.001, `fifty thousand tokens at 3 a million: ${heard[0].cost}`);
});

test("whoever cancels a call is answered at once, whatever its backend still has to do about it", async (t) => {
  const { createBackend } = await import("../packages/runtime/dist/runner-backend.js");
  const { PiAdapter } = await import("../packages/runtime/dist/pi-adapter.js");
  const realAsk = PiAdapter.prototype.ask;
  t.after(() => { PiAdapter.prototype.ask = realAsk; });
  const backend = createBackend({ provider: "fake", model: "plain" });

  // A backend lets go of a cancelled call a little later than the call is answered: it has things to stop first.
  const order = [];
  PiAdapter.prototype.ask = (_prompt, { signal, used }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => setTimeout(() => { used({ input: 1 }); order.push("let go"); reject(new Error("stopped")); }, 30));
  });
  const stop = new AbortController();
  const call = backend.ask("p", { cwd: "/work", signal: stop.signal, used: () => order.push("used") });
  stop.abort();
  await assert.rejects(call, /Aborted/);
  order.push("answered");
  assert.deepEqual(order, ["answered"], "the one who cancelled is answered at once");

  // A call that came to its end by itself leaves nothing listening for a cancellation.
  const later = new AbortController();
  PiAdapter.prototype.ask = async () => "an answer";
  assert.equal(await backend.ask("p", { cwd: "/work", signal: later.signal }), "an answer");
  assert.equal(getEventListeners(later.signal, "abort").length, 0);
});

test("a program's prompt reaches the model as it was written, whatever it begins with", async (t) => {
  // The user's own pi has prompts of its own, called up by a line that begins with their name.
  const fake = await fakeProvider(t);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(joinPath(fake.agentDir, "prompts"));
  writeModelFile(joinPath(fake.agentDir, "prompts", "review.md"), "---\ndescription: review\n---\nSomething else altogether. $ARGUMENTS\n");

  await fake.ask("/review the diff below");
  const said = fake.requests[0].messages.filter((message) => message.role === "user").at(-1).content;
  assert.equal(typeof said === "string" ? said : said.map((part) => part.text).join(""), "/review the diff below");
});

test("a session is disposed of whatever becomes of telling what the call used", async () => {
  const { PiAdapter } = await import("../packages/runtime/dist/pi-adapter.js");
  let disposed = 0;
  const adapter = new PiAdapter({ provider: "fake", model: "plain" });
  adapter.createSession = async () => ({
    prompt: async () => {},
    dispose: () => { disposed += 1; },
    getSessionStats: () => ({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }),
    sessionManager: { getEntries: () => [{ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "an answer" }] } }] },
  });
  await assert.rejects(() => adapter.ask("p", { cwd: process.cwd(), used: () => { throw new Error("nowhere to write it"); } }), /nowhere to write it/);
  assert.equal(disposed, 1);
});

test("generate has the agent find out what it is asked and answer in the shape asked for — or answer from the prompt alone, where it is given no tools", async (t) => {
  // A model that, given a way to read, reads the file it is asked about before it answers; and given none, says what it can.
  const fake = await fakeProvider(t, (request, { sse }) => {
    const stream = sse();
    const canRead = (request.tools ?? []).some((tool) => tool.function.name === "read");
    const hasRead = request.messages.find((message) => message.role === "tool");
    if (canRead && !hasRead) {
      stream.says({ role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "result.txt" }) } }] });
      stream.says({}, "tool_calls");
    } else {
      const passed = hasRead ? /12 passed, 0 failed/.test(JSON.stringify(hasRead.content)) : false;
      stream.says({ role: "assistant", content: JSON.stringify({ passed, looked: Boolean(hasRead) }) });
      stream.says({}, "stop");
    }
    stream.used({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 });
    stream.done();
  });
  writeModelFile(joinPath(fake.cwd, "result.txt"), "12 passed, 0 failed");
  const agent = createAgent({ ask: fake.ask }, fake.cwd);
  const ask = { prompt: "did the tests in result.txt pass?", schema: { passed: "boolean", looked: "boolean" }, system: "be exact" };
  const heard = [];

  // As it is, with the agent's own tools: two requests, the second with what the file says.
  assert.deepEqual(await agent.generate(ask, (usage) => heard.push(usage)), { passed: true, looked: true });
  assert.equal(fake.requests.length, 2);
  assert.deepEqual(fake.toolsOf(fake.requests[0]), ["read", "bash", "edit", "write"]);
  assert.match(JSON.stringify(fake.requests[0].messages), /be exact/);
  assert.deepEqual(heard.map(({ input, output }) => [input, output]), [[200, 20]]);

  // With the tools it names, and no others.
  assert.deepEqual(await agent.generate({ ...ask, tools: ["read", "grep"] }), { passed: true, looked: true });
  assert.deepEqual(fake.toolsOf(fake.requests[2]), ["read", "grep"]);

  // With none: one request, and nothing to look with.
  fake.requests.length = 0;
  assert.deepEqual(await agent.generate({ ...ask, tools: [] }), { passed: false, looked: false });
  assert.equal(fake.requests.length, 1);
  assert.deepEqual(fake.toolsOf(fake.requests[0]), []);
});

// --- The shape of a typed answer: lists, and objects within objects ---

test("generate answers in lists and in objects within objects — every item and field as declared, and no others", async () => {
  const prompts = [];
  let reply;
  const agent = createAgent({ async ask(prompt) { prompts.push(prompt); return JSON.stringify(reply); } }, "/work");
  const schema = {
    summary: "string: one line",
    failures: [{ test: "string", line: "number: 1-based" }],
    tags: ["string"],
    meta: { ok: "boolean", grid: [["number"]], none: {} },
  };

  reply = {
    summary: "two failed", extra: 1,
    failures: [{ test: "a", line: 3, more: "x" }, { test: "b", line: 14 }],
    tags: [],
    meta: { ok: false, grid: [[1, 2], []], none: { anything: 1 }, also: [] },
  };
  assert.deepEqual(await agent.generate({ prompt: "p", schema }), {
    summary: "two failed",
    failures: [{ test: "a", line: 3 }, { test: "b", line: 14 }],
    tags: [],
    meta: { ok: false, grid: [[1, 2], []], none: {} },
  });
  // The model is shown the shape as it was written, and told what a list in it means — where there is one.
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes(JSON.stringify(schema, null, 2)));
  assert.match(prompts[0], /\}\nWhere the shape shows a list, it shows one item: answer with as many as there are, each of that shape\.\nNo markdown\./);
  reply = { a: "x", b: { c: 1 } };
  await agent.generate({ prompt: "p", schema: { a: "string", b: { c: "number" } } });
  assert.match(prompts[1], /\}\nNo markdown\. No explanation\. Just the JSON\.$/);
  await agent.generate({ prompt: "p", schema: { a: "string", b: { c: ["number"] } } }).catch(() => {});
  assert.match(prompts[2], /Where the shape shows a list/);

  // A reply that is not of the shape is told where it is not — and asked again, once.
  const good = () => ({ summary: "s", failures: [{ test: "a", line: 1 }, { test: "b", line: 2 }], tags: ["t"], meta: { ok: true, grid: [[1, 2]], none: {} } });
  for (const [spoil, why] of [
    [(r) => { r.failures = "none"; }, "failures: expected a list, got string"],
    [(r) => { r.failures = { test: "a", line: 1 }; }, "failures: expected a list, got object"],
    [(r) => { r.failures[1].line = "2"; }, "failures[1].line: expected number, got string"],
    [(r) => { r.failures[1] = ["b", 2]; }, "failures[1]: expected an object, got a list"],
    [(r) => { delete r.failures[0].test; }, "missing key: failures[0].test"],
    [(r) => { r.tags = [1]; }, "tags[0]: expected string, got 1"],
    [(r) => { r.tags = ["a", null]; }, "tags[1]: expected string, got null"],
    [(r) => { r.meta = [true]; }, "meta: expected an object, got a list"],
    [(r) => { r.meta = null; }, "meta: expected an object, got null"],
    [(r) => { delete r.meta.ok; }, "missing key: meta.ok"],
    [(r) => { r.meta.grid = [[1, "x"]]; }, "meta.grid[0][1]: expected number, got string"],
    [(r) => { r.meta.grid = [1]; }, "meta.grid[0]: expected a list, got 1"],
    [(r) => { r.meta.none = "x"; }, "meta.none: expected an object, got string"],
  ]) {
    reply = good();
    spoil(reply);
    prompts.length = 0;
    await assert.rejects(() => agent.generate({ prompt: "p", schema }), { message: `Schema validation failed: ${why}` }, why);
    assert.equal(prompts.length, 2, why);
    assert.ok(prompts[1].startsWith(`Your previous response failed validation: Error: Schema validation failed: ${why}.`), why);
  }
  reply = ["not", "an", "object"];
  await assert.rejects(() => agent.generate({ prompt: "p", schema }), { message: "Schema validation failed: response is not an object" });

  // A schema that says nothing a reply could be held to is the program's own mistake, and no model is asked.
  prompts.length = 0;
  for (const [wrong, why] of [
    [{ a: [] }, 'the list at "a" is written with 0 elements — it takes one, the shape of every item'],
    [{ a: ["string", "number"] }, 'the list at "a" is written with 2 elements — it takes one, the shape of every item'],
    [{ a: { b: [[]] } }, 'the list at "a.b[]" is written with 0 elements — it takes one, the shape of every item'],
    [{ a: { b: "array" } }, 'unsupported schema type "array" for key "a.b" (a list is written as the shape of its items, in brackets: ["string"]; an object as its fields: { name: "string" })'],
    [{ a: [7] }, 'unsupported schema type "7" for key "a[]" (a list is written as the shape of its items, in brackets: ["string"]; an object as its fields: { name: "string" })'],
    [{ a: [{ b: [null] }] }, 'unsupported schema type "null" for key "a[].b[]" (a list is written as the shape of its items, in brackets: ["string"]; an object as its fields: { name: "string" })'],
    [["string"], "a schema is an object of the fields the answer is to have"],
    ["string", "a schema is an object of the fields the answer is to have"],
    [null, "a schema is an object of the fields the answer is to have"],
  ]) {
    await assert.rejects(() => agent.generate({ prompt: "p", schema: wrong }), { message: `Schema validation failed: ${why}` }, JSON.stringify(wrong));
  }
  assert.equal(prompts.length, 0);

  // A field named as something every object has by birth is a field like any other: the reply has it, or it is missing.
  reply = { a: "x" };
  await assert.rejects(() => agent.generate({ prompt: "p", schema: { a: "string", b: { __proto__: null, valueOf: "string" } } }), /missing key: b/);
  for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    const named = JSON.parse(`{ "a": "string", "o": { ${JSON.stringify(name)}: {} } }`);
    reply = { a: "x", o: {} };
    await assert.rejects(() => agent.generate({ prompt: "p", schema: named }), { message: `Schema validation failed: missing key: o.${name}` }, name);
    reply = JSON.parse(`{ "a": "x", "o": { ${JSON.stringify(name)}: { "more": 1 } } }`);
    const answer = await agent.generate({ prompt: "p", schema: named });
    assert.deepEqual(Object.getOwnPropertyNames(answer.o), [name]);
    assert.equal(Object.getPrototypeOf(answer.o), Object.prototype, name);
  }
  // ...and one with no name at all is a field too: what is said of it, and under it, is said of it.
  reply = { "": "str" };
  await assert.rejects(() => agent.generate({ prompt: "p", schema: { "": { x: "string" } } }), { message: "Schema validation failed: : expected an object, got string" });
  reply = { "": {} };
  await assert.rejects(() => agent.generate({ prompt: "p", schema: { "": { x: "string" } } }), { message: "Schema validation failed: missing key: .x" });
  await assert.rejects(() => agent.generate({ prompt: "p", schema: { "": { x: "wrong" } } }), /unsupported schema type "wrong" for key "\.x"/);
  reply = JSON.parse('{ "a": "x", "__proto__": { "b": "inherited" } }');
  assert.deepEqual(Object.keys(await agent.generate({ prompt: "p", schema: JSON.parse('{ "__proto__": { "b": "string" } }') })), ["__proto__"]);
});

// --- A reply that was cut off at the output limit ---

test("a reply that was cut off fails the call, unless the call keeps such a reply — then it is what there was of it", async (t) => {
  const { CutOff } = await import("../packages/runtime/dist/agent-backend.js");
  const calls = [];
  let fate;
  const agent = createAgent({ async ask(prompt, call) { calls.push({ prompt, call }); return fate(calls.length); } }, "/work");
  const cut = (text) => () => { throw new CutOff(text); };
  const cutOff = { message: "The model's answer was cut off at its output limit." };

  fate = cut("part of an answ");
  await assert.rejects(() => agent.instruct("p"), cutOff);
  await assert.rejects(() => agent.instruct("p", { cutOff: "fail" }), cutOff);
  await assert.rejects(() => agent.instruct("p", { cutOff: undefined }), cutOff);
  assert.equal(await agent.instruct("p", { cutOff: "keep", system: "s" }), "part of an answ");
  // The backend is asked the same either way: what is made of a reply that was cut off is made of it here.
  assert.deepEqual(calls.map(({ call }) => call), [
    { cwd: "/work", system: undefined, signal: undefined },
    { cwd: "/work", system: undefined, signal: undefined },
    { cwd: "/work", system: undefined, signal: undefined },
    { cwd: "/work", system: "s", signal: undefined },
  ]);

  // There is nothing to keep of a reply cut off before its first word; and any other failure is still one.
  fate = cut("");
  await assert.rejects(() => agent.instruct("p", { cutOff: "keep" }), cutOff);
  fate = () => { throw new Error("the model is away"); };
  await assert.rejects(() => agent.instruct("p", { cutOff: "keep" }), { message: "the model is away" });
  fate = () => { throw Object.assign(new Error("The model's answer was cut off at its output limit."), { text: "looks like one" }); };
  await assert.rejects(() => agent.instruct("p", { cutOff: "keep" }), cutOff);

  // What is neither is not an option, and nothing is asked under it.
  calls.length = 0;
  for (const what of ["yes", "", "Keep", true, null, 0, ["keep"]]) {
    await assert.rejects(() => agent.instruct("p", { cutOff: what }), { message: `cutOff is "fail" or "keep", not ${JSON.stringify(what)}` });
    await assert.rejects(() => agent.generate({ prompt: "p", schema: { a: "string" }, cutOff: what }), { message: `cutOff is "fail" or "keep", not ${JSON.stringify(what)}` });
  }
  assert.equal(calls.length, 0);

  // A typed answer is held to its shape either way. One that was cut off is not asked for again, as it stands...
  fate = cut('{"a":"x"}');
  await assert.rejects(() => agent.generate({ prompt: "p", schema: { a: "string" } }), cutOff);
  assert.equal(calls.length, 1);
  // ...kept, it is the answer where it is whole for all that, and where it is not it is asked for once more.
  assert.deepEqual(await agent.generate({ prompt: "p", schema: { a: "string" }, cutOff: "keep" }), { a: "x" });
  calls.length = 0;
  fate = (nth) => (nth === 1 ? cut('{"a":"x') : cut('{"a":"y"}'))();
  assert.deepEqual(await agent.generate({ prompt: "p", schema: { a: "string" }, cutOff: "keep" }), { a: "y" });
  assert.equal(calls.length, 2);
  assert.match(calls[1].prompt, /^Your previous response failed validation/);
  calls.length = 0;
  fate = (nth) => (nth === 1 ? () => "not json" : cut('{"a":"z"}'))();
  await assert.rejects(() => agent.generate({ prompt: "p", schema: { a: "string" } }), cutOff);
  assert.equal(calls.length, 2);
});

test("pi says of a reply that was cut off what there was of it: the last reply's words, and no earlier one's", async (t) => {
  const { CutOff } = await import("../packages/runtime/dist/agent-backend.js");
  let then;
  const fake = await fakeProvider(t, (_request, { sse }, hit) => {
    const stream = sse();
    if (then === "after a tool" && hit === 1) {
      stream.says({ role: "assistant", content: "Let me look at the file first.", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "a.txt" }) } }] });
      stream.says({}, "tool_calls");
    } else if (then === "in a tool call" && hit === 1) {
      stream.says({ role: "assistant", content: "Now the file.", tool_calls: [{ index: 0, id: "call-2", type: "function", function: { name: "read", arguments: '{"path": "a.t' } }] });
      stream.says({}, "length");
    } else if (then === "in a tool call") {
      stream.says({ role: "assistant", content: "the answer" });
      stream.says({}, "stop");
    } else {
      stream.says({ role: "assistant", content: "The answer, which is cut at the li" });
      stream.says({}, "length");
    }
    stream.used({ prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 });
    stream.done();
  });
  writeModelFile(joinPath(fake.cwd, "a.txt"), "what the file says");
  const agent = createAgent({ ask: fake.ask }, fake.cwd);
  const heard = [];

  for (const [how, model] of [["at once", undefined], ["after a tool", undefined], ["at once", "fake/terse"]]) {
    then = how;
    fake.requests.length = 0;
    const failure = await fake.ask("read a.txt and answer", { ...(model && { model }) }).catch((err) => err);
    assert.ok(failure instanceof CutOff, `${how} ${model}: ${failure}`);
    assert.equal(failure.text, "The answer, which is cut at the li");
    assert.equal(fake.requests.length, how === "after a tool" ? 2 : 1);
    fake.requests.length = 0;
    assert.equal(
      await agent.instruct("read a.txt and answer", { cutOff: "keep", ...(model && { model }) }, (usage) => heard.push(usage.output)),
      "The answer, which is cut at the li", `${how} ${model}`,
    );
  }
  assert.deepEqual(heard, [200, 400, 200], "what a reply that was cut off took is counted like any other");

  // Cut off in the middle of having something done is not this: pi does not do what it was only half told,
  // has the model say it again, and the call goes on to its answer.
  then = "in a tool call";
  fake.requests.length = 0;
  assert.equal(await fake.ask("read a.txt and answer"), "the answer");
  assert.equal(fake.requests.length, 2);
  assert.equal(fake.requests[1].messages.filter((message) => message.role === "tool").length, 1);
});

test("pi leaves nothing where it works but what the agent's tools put there: a directory an agent worked in differs by the agent's work alone", async (t) => {
  const { readdirSync } = await import("node:fs");
  const fake = await fakeProvider(t, (request, { sse }) => {
    const stream = sse();
    if (!request.messages.some((message) => message.role === "tool")) {
      stream.says({ role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "made.txt", content: "by the agent" }) } }] });
      stream.says({}, "tool_calls");
    } else {
      stream.says({ role: "assistant", content: "done" });
      stream.says({}, "stop");
    }
    stream.used({ prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 });
    stream.done();
  });
  writeModelFile(joinPath(fake.cwd, "there-before.txt"), "x");

  assert.equal(await fake.ask("make a file"), "done");
  assert.deepEqual(readdirSync(fake.cwd, { recursive: true }).sort(), ["made.txt", "there-before.txt"]);
});

// --- What a call may have of the user's pi: skills, prompt templates, extensions ---

/** A pi of a user's with skills, templates and an extension of their own — and a project with the same of its own. */
async function furnished(t, reply) {
  const fake = await fakeProvider(t, reply);
  const { mkdirSync } = await import("node:fs");
  const put = (dir, path, text) => {
    mkdirSync(joinPath(dir, path, ".."), { recursive: true });
    writeModelFile(joinPath(dir, path), text);
  };
  put(fake.agentDir, "skills/greet/SKILL.md", "---\nname: greet\ndescription: How to greet somebody properly.\n---\nSay hello, twice.\n");
  put(fake.agentDir, "skills/quiet/SKILL.md", "---\nname: quiet\ndescription: Only ever called by name.\ndisable-model-invocation: true\n---\nBe quiet.\n");
  put(fake.cwd, ".pi/skills/local/SKILL.md", "---\nname: local\ndescription: A skill of the project's own.\n---\nLocal things.\n");
  put(fake.agentDir, "prompts/review.md", "---\ndescription: review\n---\nReview this, please: $ARGUMENTS\n");
  put(fake.cwd, ".pi/prompts/proj.md", "---\ndescription: proj\n---\nThe project's template: $ARGUMENTS\n");
  const extension = (name, tool) => `
export default function (pi) {
  const seen = (globalThis.__tramaExtensions ??= []);
  seen.push("${name} loaded");
  pi.on("session_start", async (_event, ctx) => { seen.push("${name} told of the start"); globalThis.__tramaTrusted = ctx.isProjectTrusted(); });
  pi.registerCommand("ask-and-go", { description: "ask the model, and do not wait for it", handler: async (args) => { pi.sendUserMessage("the command asks: " + args); await new Promise((resolve) => setTimeout(resolve, 40)); } });
  pi.registerCommand("ask-at-once", { description: "ask the model, and leave", handler: async (args) => { pi.sendUserMessage("the command asks: " + args); } });
  pi.registerCommand("ask-until-told", { description: "ask the model again and again", handler: async (args, ctx) => {
    for (;;) { pi.sendUserMessage("again: " + args); await ctx.waitForIdle(); }
  } });
  pi.registerCommand("ask-as-it-ends", { description: "ask the model when the call is over", handler: async () => { globalThis.__tramaAskAsItEnds = true; } });
  pi.on("session_shutdown", async () => { if (globalThis.__tramaAskAsItEnds) { delete globalThis.__tramaAskAsItEnds; pi.sendUserMessage("asked while the call was being ended"); await new Promise((resolve) => setTimeout(resolve, 250)); } });
  pi.registerCommand("ask-twice", { description: "ask the model two things, one after the other", handler: async (args, ctx) => {
    pi.sendUserMessage("first: " + args); await ctx.waitForIdle(); seen.push("the first was answered");
    pi.sendUserMessage("second: " + args); await ctx.waitForIdle(); seen.push("the second was answered");
  } });
  pi.on("input", async (event) => { if (String(event.text).includes("slowly")) await new Promise((resolve) => setTimeout(resolve, 40)); });
  pi.registerCommand("ask", { description: "ask the model", handler: async (args, ctx) => { pi.sendUserMessage("the command asks: " + args); await ctx.waitForIdle(); seen.push("the command's question was answered"); } });
  // (It takes a moment over it: a call is over only once its extensions have heard that it is.)
  pi.on("session_shutdown", async () => { await new Promise((resolve) => setTimeout(resolve, 30)); seen.push("${name} told of the end"); });
  pi.registerTool({ name: "${tool}", label: "${tool}", description: "A tool of an extension", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "hi" }] }; } });
  pi.registerCommand("shout", { description: "shout", handler: async (args) => { seen.push("shout " + args); } });
}
`;
  put(fake.agentDir, "extensions/hello.ts", extension("the user's", "hello_tool"));
  put(fake.cwd, ".pi/extensions/proj.ts", extension("THE PROJECT'S", "proj_tool"));
  const seen = () => globalThis.__tramaExtensions ?? [];
  globalThis.__tramaExtensions = [];
  t.after(() => { delete globalThis.__tramaExtensions; delete globalThis.__tramaTrusted; delete globalThis.__tramaAskAsItEnds; });
  return { ...fake, put, seen };
}

test("a call has the skills it chose, of the user's and the project's — and none it did not choose", async (t) => {
  const fake = await furnished(t);
  const skillsTold = () => [...fake.told().system.matchAll(/<name>(\w+)<\/name>/g)].map((match) => match[1]).sort();

  // None chosen: none told of, and a prompt is the text it is.
  for (const call of [{}, { skills: false }, { skills: [] }]) {
    await fake.ask("/skill:greet somebody", call);
    assert.deepEqual([skillsTold(), fake.told().user], [[], "/skill:greet somebody"], JSON.stringify(call));
    assert.doesNotMatch(fake.told().system, /available_skills/);
  }

  // All of them: the model is told of those that are for it to take up, and one can be called up by name in the prompt.
  await fake.ask("/skill:quiet now", { skills: true });
  assert.deepEqual(skillsTold(), ["greet", "local"]);
  assert.match(fake.told().user, /^<skill name="quiet" location=".*quiet\/SKILL\.md">[^]*Be quiet\.\n<\/skill>\n\nnow$/);
  // ...and a prompt is read for skills, not for the templates the call did not choose.
  await fake.ask("/review the diff", { skills: true });
  assert.equal(fake.told().user, "/review the diff");

  // Some by name: those, and no other — not to be told of, and not to be called up.
  await fake.ask("/skill:greet somebody", { skills: ["local"] });
  assert.deepEqual([skillsTold(), fake.told().user], [["local"], "/skill:greet somebody"]);
  await fake.ask("say hello", { skills: ["greet", "quiet"] });
  assert.deepEqual(skillsTold(), ["greet"]);

  // What pi cannot give as asked is the call's failure, before the model is asked anything.
  const before = fake.requests.length;
  await assert.rejects(() => fake.ask("p", { skills: ["local", "nope"] }), { message: 'pi has no skill "nope". Its skills: local, greet, quiet.' });
  const bare = await fakeProvider(t);
  await assert.rejects(() => bare.ask("p", { skills: ["nope"] }), { message: 'pi has no skill "nope". Its skills: none.' });
  await assert.rejects(() => bare.ask("p", { templates: ["nope"] }), { message: 'pi has no prompt template "nope". Its prompt templates: none.' });
  assert.equal(await bare.ask("/skill:nope p", { skills: true, templates: true, tools: [] }), "hello from the fake", "all of none is none, and nothing to fail for");
  assert.equal(bare.told().user, "/skill:nope p");
  // pi tells a model of its skills only where it can read them: an agent with no way to read has none, whatever was loaded.
  await assert.rejects(
    () => fake.ask("p", { skills: true, tools: [] }),
    { message: 'The agent cannot take up its skills (local, greet) with the tools []: pi tells a model of its skills only where it has "read" or "bash" to read them with.' },
  );
  await assert.rejects(() => fake.ask("p", { skills: ["greet"], tools: ["edit"] }), /cannot take up its skills \(greet\) with the tools \["edit"\]/);
  // (What is looked for is what pi writes of these skills — not a word of it that a program's own instructions happen to hold.)
  await assert.rejects(() => fake.ask("p", { skills: ["greet"], tools: [], system: "Mind the <available_skills> below.\n<name>greet</name>" }), /cannot take up its skills \(greet\)/);
  assert.equal(fake.requests.length, before, "no model was asked anything");
  // (One that is only ever called by name needs no reading by the model; and bash is a way to read.)
  await fake.ask("/skill:quiet now", { skills: ["quiet"], tools: [] });
  assert.match(fake.told().user, /^<skill name="quiet"/);
  await fake.ask("p", { skills: ["greet"], tools: ["bash"] });
  assert.deepEqual(skillsTold(), ["greet"]);
});

test("a call has the prompt templates it chose: a prompt that begins with the name of one is the template, filled in", async (t) => {
  const fake = await furnished(t);

  await fake.ask("/review the diff", { templates: true });
  assert.equal(fake.told().user, "Review this, please: the diff");
  await fake.ask("/proj the diff", { templates: true });
  assert.equal(fake.told().user, "The project's template: the diff");
  // A prompt that begins with no template's name is the text it is — and so is one for a skill, where no skills were chosen.
  for (const prompt of ["/nope the diff", "/skill:greet somebody", "review the diff"]) {
    await fake.ask(prompt, { templates: true });
    assert.equal(fake.told().user, prompt);
  }
  assert.doesNotMatch(fake.told().system, /available_skills/);

  await fake.ask("/proj the diff", { templates: ["proj"] });
  assert.equal(fake.told().user, "The project's template: the diff");
  await fake.ask("/review the diff", { templates: ["proj"] });
  assert.equal(fake.told().user, "/review the diff");
  for (const call of [{ templates: false }, { templates: [] }]) {
    await fake.ask("/review the diff", call);
    assert.equal(fake.told().user, "/review the diff", JSON.stringify(call));
  }

  const before = fake.requests.length;
  await assert.rejects(() => fake.ask("/nope x", { templates: ["nope"] }), { message: 'pi has no prompt template "nope". Its prompt templates: proj, review.' });
  assert.equal(fake.requests.length, before, "no model was asked anything");

  // Both: each kind is chosen by itself.
  await fake.ask("/review the diff", { templates: ["review"], skills: ["local"] });
  assert.equal(fake.told().user, "Review this, please: the diff");
  assert.match(fake.told().system, /<name>local<\/name>/);
  await assert.rejects(() => fake.ask("p", { templates: ["greet"], skills: ["greet"] }), /pi has no prompt template "greet"/);
  await assert.rejects(() => fake.ask("p", { templates: ["review"], skills: ["review"] }), /pi has no skill "review"/);
});

test("a call has the user's extensions where it asks for them — the user's own, and never the project's", async (t) => {
  const fake = await furnished(t);

  // Not asked for: none is loaded — no code but trama's and pi's has run.
  await fake.ask("/shout loudly");
  assert.deepEqual(fake.toolsOf(fake.requests.at(-1)), ["read", "bash", "edit", "write"]);
  assert.equal(fake.told().user, "/shout loudly");
  assert.deepEqual(fake.seen(), []);

  // Asked for: the user's is loaded, told that a session begins and that it is over, and its tool is the agent's.
  await fake.ask("say hello", { extensions: true, used: () => fake.seen().push("the call said what it used") });
  assert.deepEqual(fake.toolsOf(fake.requests.at(-1)), ["read", "bash", "edit", "write", "hello_tool"]);
  // (What the call used is said when its extensions have been told that it is over: one of them may ask a model for
  // itself as it is told, and that is the call's. Whoever counts does not wait for it — they hear as each reply comes.)
  assert.deepEqual(fake.seen(), ["the user's loaded", "the user's told of the start", "the user's told of the end", "the call said what it used"]);
  // To an extension the project is not one to be trusted: what it holds, the program it runs could have written.
  assert.equal(globalThis.__tramaTrusted, false);
  assert.doesNotMatch(fake.told().system, /available_skills/);

  // The rest of what a call has it has as without extensions: its own instructions, the project's, a template —
  // and the project's own settings for pi (here: which tools an agent has where a call names none).
  fake.put(fake.cwd, ".pi/settings.json", JSON.stringify({ defaultTools: ["read", "grep"] }));
  await fake.ask("say hello");
  assert.deepEqual(fake.toolsOf(fake.requests.at(-1)), ["read", "grep"]);
  await fake.ask("say hello", { extensions: true });
  assert.deepEqual(fake.toolsOf(fake.requests.at(-1)), ["read", "grep", "hello_tool"]);
  assert.equal(globalThis.__tramaTrusted, false);
  fake.put(fake.cwd, ".pi/settings.json", "{}");
  fake.put(fake.cwd, "AGENTS.md", "In this project every answer ends with a full stop.\n");
  for (const extensions of [true, false]) {
    await fake.ask("/review the diff", { extensions, templates: true, system: "Answer in French." });
    assert.equal(fake.told().user, "Review this, please: the diff", `extensions: ${extensions}`);
    assert.match(fake.told().system, /Answer in French\./, `extensions: ${extensions}`);
    assert.match(fake.told().system, /every answer ends with a full stop/, `extensions: ${extensions}`);
  }
  globalThis.__tramaExtensions = [];

  // Its tools can be named among a call's, like any other; and what the project holds of skills is still the call's to choose.
  await fake.ask("say hello", { extensions: true, tools: ["hello_tool", "read"], skills: ["local"] });
  assert.deepEqual(fake.toolsOf(fake.requests.at(-1)).sort(), ["hello_tool", "read"]);
  assert.match(fake.told().system, /<name>local<\/name>/);
  await assert.rejects(() => fake.ask("p", { extensions: true, tools: ["proj_tool"] }), /cannot be given the tools \["proj_tool"\]/);
  await assert.rejects(() => fake.ask("p", { tools: ["hello_tool"] }), /cannot be given the tools \["hello_tool"\]/, "nor an extension's tool without the extension");
  assert.equal(fake.seen().some((line) => line.startsWith("THE PROJECT'S")), false, "the project's extension is never run");

  // A prompt that begins with a command of an extension is that command: the model is not asked, and the call says so.
  globalThis.__tramaExtensions = [];
  const before = fake.requests.length;
  await assert.rejects(() => fake.ask("/shout loudly", { extensions: true }), /The prompt was taken by an extension/);
  assert.equal(fake.requests.length, before);
  assert.deepEqual(fake.seen(), ["the user's loaded", "the user's told of the start", "shout loudly", "the user's told of the end"]);
  // A command that asks the model itself, and waits for it, has the model's answer be the call's — and what that took is the call's.
  globalThis.__tramaExtensions = [];
  const heard = [];
  assert.equal(await fake.ask("/ask what is the time", { extensions: true, used: (usage) => heard.push(usage.input) }), "hello from the fake");
  assert.equal(fake.told().user, "the command asks: what is the time");
  assert.deepEqual(fake.seen().slice(2), ["the command's question was answered", "the user's told of the end"]);
  assert.deepEqual(heard, [700]);
  // (...also where the command does not wait for the model itself: what it set going is the call's to wait for.)
  const slow = await furnished(t, (_request, { sse }) => setTimeout(() => {
    const stream = sse();
    stream.says({ role: "assistant", content: "an answer that took a while" });
    stream.says({}, "stop");
    stream.used({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    stream.done();
  }, 150));
  assert.equal(await slow.ask("/ask-and-go what is the time", { extensions: true }), "an answer that took a while");
  // (...nor even stay while pi sets the question going — which pi does in its own time, the longer where an
  // extension looks at what is put to it first: what was put is waited for, not whether the session looks busy.)
  assert.equal(await slow.ask("/ask-at-once what is the time", { extensions: true }), "an answer that took a while");
  assert.equal(await slow.ask("/ask-at-once slowly, what is the time", { extensions: true }), "an answer that took a while");
  assert.equal(slow.told().user, "the command asks: slowly, what is the time");
  // One that asks twice has both answered, and the second answer is the call's.
  globalThis.__tramaExtensions = [];
  const twice = [];
  assert.equal(await slow.ask("/ask-twice now", { extensions: true, used: (usage) => twice.push(usage.input + usage.output) }), "an answer that took a while");
  assert.deepEqual([slow.told().user, twice], ["second: now", [30]]);
  assert.deepEqual(slow.seen().slice(2), ["the first was answered", "the second was answered", "the user's told of the end"]);
  // A call that is cancelled asks no more, though a command of it would: the first question is cut off, the second never put.
  const asked = slow.requests.length;
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 60);
  await assert.rejects(() => slow.ask("/ask-twice now", { extensions: true, signal: stop.signal }), /Aborted/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(slow.requests.length, asked + 1, "the model was not asked the second question");
  // ...nor does a command that asks until it is satisfied go round for ever once its call is cancelled: the
  // runner comes to other things — this test among them — and the command is not let wait again.
  const round = new AbortController();
  setTimeout(() => round.abort(), 60);
  const warned = await captureConsole("warn", () => assert.rejects(() => slow.ask("/ask-until-told now", { extensions: true, signal: round.signal }), /Aborted/));
  const sinceCancel = slow.requests.length;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(slow.requests.length, sinceCancel, "and the model is asked no more");
  assert.deepEqual(warned.messages, [], "and nothing is said of the command: it did not fail, its call was cancelled");
  // What an extension asks while it is being told that the call is over is not put to the model: the call is over.
  const ended = slow.requests.length;
  await assert.rejects(() => slow.ask("/ask-as-it-ends", { extensions: true }), /The prompt was taken by an extension/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(slow.requests.length, ended, "nothing was asked once the call had come to its end");
  // ...unless the call says its prompt is text: then it is, to skills and to commands alike.
  await fake.ask("/shout loudly", { extensions: true, skills: true, asText: true });
  assert.equal(fake.told().user, "/shout loudly");
  await fake.ask("/skill:greet somebody", { skills: true, asText: true });
  assert.equal(fake.told().user, "/skill:greet somebody");
  const answered = fake.requests.length;
  await assert.rejects(() => fake.ask("p", { extensions: false, tools: ["hello_tool"] }), /cannot be given the tools/);

  // An extension that cannot be loaded is the call's failure — where the call asked for extensions, and nowhere else.
  fake.put(fake.agentDir, "extensions/broken.ts", "export default function () { throw new Error('this extension is broken'); }\n");
  globalThis.__tramaExtensions = [];
  await assert.rejects(() => fake.ask("p", { extensions: true }), /^Error: The extension .*broken\.ts is not as pi would have it: .*this extension is broken/);
  assert.equal(fake.requests.length, answered, "no model was asked anything");
  assert.deepEqual(fake.seen(), ["the user's loaded", "the user's told of the start", "the user's told of the end"], "what was loaded beside it is told that it is over, once");
  assert.equal(await fake.ask("say hello"), "hello from the fake");
});

test("an extension that does not answer when it is told its session is over is not waited for beyond a while", async (t) => {
  const fake = await furnished(t);
  fake.put(fake.agentDir, "extensions/hello.ts", 'export default function (pi) { pi.on("session_shutdown", () => new Promise(() => {})); }\n');
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const answer = fake.ask("say hello", { extensions: true });
  let settled = false;
  answer.then(() => { settled = true; }, () => { settled = true; });
  // (Real time passes while pi and the fake model work; the mocked clock is only what the wait for the extension goes by.)
  const { setTimeout: later } = await import("node:timers/promises");
  for (let waited = 0; waited < 200 && fake.requests.length === 0; waited++) await later(25, undefined, { ref: true }).catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(4_999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "it is waited for");
  t.mock.timers.tick(2);
  assert.equal(await answer, "hello from the fake");
});

test("a backend says what a call has used each time its agent is about to ask the model again, and a call cancelled there asks no more", async (t) => {
  // A model that has the agent read a file, twice, before it answers.
  const fake = await fakeProvider(t, (_request, { sse }, hit) => {
    const stream = sse();
    if (hit % 3 !== 0) {
      stream.says({ role: "assistant", tool_calls: [{ index: 0, id: `call-${hit}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: "a.txt" }) } }] });
      stream.says({}, "tool_calls");
    } else {
      stream.says({ role: "assistant", content: "the answer" });
      stream.says({}, "stop");
    }
    stream.used({ prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 });
    stream.done();
  });
  writeModelFile(joinPath(fake.cwd, "a.txt"), "what the file says");
  const total = (usage) => usage.input + usage.output + usage.cacheRead + usage.cacheWrite;

  const sofar = [], used = [];
  assert.equal(await fake.ask("read a.txt, twice", { sofar: (usage) => sofar.push([fake.requests.length, total(usage), usage.model]), used: (usage) => used.push(total(usage)) }), "the answer");
  // Before the second request and before the third: not before the first, when nothing is used, nor after the last.
  assert.deepEqual(sofar, [[1, 1200, "fake/plain"], [2, 2400, "fake/plain"]]);
  assert.deepEqual(used, [3600]);

  // Cancelled when it says what the first request took: the model is not asked a second time.
  const stop = new AbortController();
  const heard = [];
  const before = fake.requests.length;
  await assert.rejects(() => fake.ask("read a.txt, twice", {
    signal: stop.signal,
    sofar: () => stop.abort(),
    used: (usage) => heard.push(total(usage)),
  }), /Aborted/);
  assert.equal(fake.requests.length, before + 1, "the request that would have followed was not made");
  assert.deepEqual(heard, [1200], "and what the call used is what the one request took");
});

test("two of the user's extensions with a tool of one name are not what a call asked for, and it is said for what it is", async (t) => {
  const fake = await furnished(t);
  fake.put(fake.agentDir, "extensions/twin.ts", `export default function (pi) {
  pi.registerTool({ name: "hello_tool", label: "twin", description: "Another of the same name", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "hi" }] }; } });
}
`);
  await assert.rejects(() => fake.ask("p", { extensions: true }), /^Error: The extension .*(twin|hello)\.ts is not as pi would have it: .*hello_tool.*conflicts/);
  assert.equal(fake.requests.length, 0);
  assert.equal(await fake.ask("p"), "hello from the fake");
});

test("a call cancelled while its extensions are being told that it begins lets them hear that out before they hear that it is over", async (t) => {
  const fake = await fakeProvider(t);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(joinPath(fake.agentDir, "extensions"));
  writeModelFile(joinPath(fake.agentDir, "extensions", "slow.ts"), `export default function (pi) {
  const seen = (globalThis.__tramaSlow ??= []);
  pi.on("session_start", async () => { seen.push("setting up"); globalThis.__tramaSlowStarted?.(); await new Promise((resolve) => setTimeout(resolve, 150)); seen.push("set up"); });
  pi.on("session_shutdown", async () => { seen.push("taking down"); });
}
`);
  globalThis.__tramaSlow = [];
  t.after(() => { delete globalThis.__tramaSlow; delete globalThis.__tramaSlowStarted; });

  const stop = new AbortController();
  globalThis.__tramaSlowStarted = () => setTimeout(() => stop.abort(), 20);
  await assert.rejects(() => fake.ask("p", { extensions: true, signal: stop.signal }), /Aborted/);
  assert.deepEqual(globalThis.__tramaSlow, ["setting up", "set up", "taking down"]);
  assert.equal(fake.requests.length, 0);
});

test("a backend says what a call has used before pi has a long conversation summed up, as before it asks for the next turn", async (t) => {
  // A model with little room: after the first turn the conversation is past what pi keeps, and pi asks for a summary of it.
  const kinds = [];
  const fake = await fakeProvider(t, (request, { sse }) => {
    const summary = !request.tools?.length;
    kinds.push(summary ? "a summary" : "a turn");
    const stream = sse();
    if (!summary && kinds.filter((kind) => kind === "a turn").length === 1) {
      stream.says({ role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "a.txt" }) } }] });
      stream.says({}, "tool_calls");
    } else {
      stream.says({ role: "assistant", content: summary ? "what was done so far" : "the answer" });
      stream.says({}, "stop");
    }
    stream.used({ prompt_tokens: 2800, completion_tokens: 200, total_tokens: 3000 });
    stream.done();
  }, "small");
  writeModelFile(joinPath(fake.cwd, "a.txt"), "what the file says. ".repeat(200));
  writeModelFile(joinPath(fake.agentDir, "settings.json"), JSON.stringify({ compaction: { reserveTokens: 500, keepRecentTokens: 100 } }));

  const said = () => kinds.push("said");
  assert.equal(await fake.ask("read a.txt and go on", { sofar: said }), "the answer");
  assert.ok(kinds.includes("a summary"), `pi summed the conversation up: ${kinds}`);
  // Each request after the first — the summary among them — has what was used so far said before it.
  for (let at = 1; at < kinds.length; at++) {
    if (kinds[at] !== "said") assert.equal(kinds[at - 1], "said", `request ${at} (${kinds[at]}) of ${kinds}`);
  }

  // Cancelled where that is said, the summary is not asked for.
  kinds.length = 0;
  const stop = new AbortController();
  await assert.rejects(() => fake.ask("read a.txt and go on", { signal: stop.signal, sofar: () => stop.abort() }), /Aborted/);
  assert.deepEqual(kinds, ["a turn"]);
});

test("a call that is cancelled is not held for good by an extension that does not return — nor one whose beginning an extension never hears out", async (t) => {
  const { mkdirSync } = await import("node:fs");
  const extension = (event) => `export default function (pi) {
  pi.on("${event}", () => { globalThis.__tramaHeld?.(); return new Promise(() => {}); });
  pi.on("session_shutdown", async () => { globalThis.__tramaLeft = (globalThis.__tramaLeft ?? 0) + 1; });
}
`;
  t.after(() => { delete globalThis.__tramaHeld; delete globalThis.__tramaLeft; });
  const { setTimeout: later } = await import("node:timers/promises");
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  // (A call that is held is given up sooner than a process that serves it would be ended: what it used is said then.)
  for (const [event, waited] of [["agent_end", 3_000], ["session_start", 5_000]]) {
    // (A pi of its own for each: an extension is read once where it is, whatever is written there after.)
    const fake = await fakeProvider(t);
    mkdirSync(joinPath(fake.agentDir, "extensions"));
    writeModelFile(joinPath(fake.agentDir, "extensions", "held.ts"), extension(event));
    globalThis.__tramaLeft = 0;
    const held = new Promise((resolve) => { globalThis.__tramaHeld = resolve; });
    const stop = new AbortController();
    const call = fake.ask("say hello", { extensions: true, signal: stop.signal });
    let settled = false;
    call.then(() => { settled = true; }, () => { settled = true; });
    await held;
    await later(50);
    // (The clock the wait goes by is the test's from here: no real time is to pass for it.)
    t.mock.timers.enable({ apis: ["setTimeout"] });
    stop.abort();
    await settle();
    t.mock.timers.tick(waited - 1);
    await settle();
    assert.equal(settled, false, `${event}: it is waited for a while`);
    t.mock.timers.tick(2);
    await assert.rejects(call, /Aborted/, event);
    assert.equal(globalThis.__tramaLeft, 1, `${event}: and its extensions are told that it is over`);
    assert.equal(fake.requests.length, event === "session_start" ? 0 : 1, `${event}: the model was asked only where the call got as far`);
    t.mock.timers.reset();
  }
});

test("an extension that sets its session going again whenever it stops does not hold the runner once the call is cancelled", async (t) => {
  // However it does so: by putting another question when the agent has settled, or by a message of its own that starts a turn.
  const { mkdirSync } = await import("node:fs");
  const { setTimeout: later } = await import("node:timers/promises");
  const again = {
    "a question": `pi.sendUserMessage("go on");`,
    "a message that starts a turn": `pi.sendMessage({ customType: "go-on", content: "go on", display: false }, { triggerTurn: true });`,
  };
  for (const [how, put] of Object.entries(again)) {
    const fake = await fakeProvider(t);
    mkdirSync(joinPath(fake.agentDir, "extensions"));
    writeModelFile(joinPath(fake.agentDir, "extensions", "again.ts"), `export default function (pi) {
  pi.on("agent_settled", async () => { globalThis.__tramaRounds = (globalThis.__tramaRounds ?? 0) + 1; ${put} });
}
`);
    t.after(() => { delete globalThis.__tramaRounds; });
    globalThis.__tramaRounds = 0;
    const stop = new AbortController();
    const call = fake.ask("say hello", { extensions: true, signal: stop.signal });
    call.catch(() => {});
    for (let waited = 0; waited < 400 && fake.requests.length < 3; waited++) await later(10);
    assert.ok(fake.requests.length >= 3, `${how}: the extension keeps the session asking (${fake.requests.length})`);

    // Cancelled: the model is asked no more, and the runner still comes to other things — the clock that gives the call up among them.
    stop.abort();
    await later(100);
    const asked = fake.requests.length;
    const started = Date.now();
    await assert.rejects(call, /Aborted/, how);
    assert.ok(Date.now() - started < 12_000, `${how}: the call was given up, ${Date.now() - started}ms after it was cancelled`);
    assert.equal(fake.requests.length, asked, `${how}: nothing was asked after the cancel`);
    // (What was under way when the session went comes to its end; nothing begins after.)
    await later(300);
    const rounds = globalThis.__tramaRounds;
    await later(200);
    assert.equal(globalThis.__tramaRounds, rounds, `${how}: and the session is not set going again once it is gone`);
  }
});

test("what an extension sets going as its call ends neither reaches the model nor holds the runner", async (t) => {
  const { mkdirSync } = await import("node:fs");
  const { setTimeout: later } = await import("node:timers/promises");
  const extensions = {
    // It puts a question as it is told the call is over, and leaves: the question is still on its way when it has.
    "a question still on its way": `export default function (pi) {
  pi.on("input", async (event) => { if (String(event.text).includes("late")) await new Promise((resolve) => setTimeout(resolve, 150)); });
  pi.on("session_shutdown", async () => { pi.sendUserMessage("a late question"); });
}
`,
    // It sets the session going again each time it stops, from the moment it is told the call is over.
    "a session set going again and again": `export default function (pi) {
  let ended = false;
  pi.on("session_shutdown", async () => { ended = true; pi.sendUserMessage("go on"); });
  pi.on("agent_settled", async () => { if (ended) pi.sendUserMessage("go on"); });
}
`,
  };
  for (const [what, source] of Object.entries(extensions)) {
    const fake = await fakeProvider(t);
    mkdirSync(joinPath(fake.agentDir, "extensions"));
    writeModelFile(joinPath(fake.agentDir, "extensions", "ending.ts"), source);
    const started = Date.now();
    assert.equal(await captureConsole("warn", () => fake.ask("say hello", { extensions: true })).then(({ result }) => result), "hello from the fake", what);
    assert.ok(Date.now() - started < 9_000, `${what}: the call came to its end, ${Date.now() - started}ms after it began`);
    await later(400);
    assert.equal(fake.requests.length, 1, `${what}: the model was asked the call's own question, and no other`);
  }
});

test("a kind is its word: what stands around the word in a schema is not part of it", async () => {
  const { shapeOf, argumentsOf } = await import("../packages/runtime/dist/schema.js");
  // Written with room around the word, and around what describes it: the same kinds.
  const spaced = { title: " string ", count: "number : how many", done: "\tboolean:  whether it is  ", tags: [" string: one tag "] };
  assert.deepEqual(shapeOf(spaced), shapeOf({ title: "string", count: "number", done: "boolean", tags: ["string"] }));
  assert.deepEqual(argumentsOf(spaced).schema.properties, {
    title: { type: "string" }, count: { type: "number", description: "how many" }, done: { type: "boolean", description: "whether it is" },
    tags: { type: "array", items: { type: "string", description: "one tag" } },
  });
  assert.throws(() => shapeOf({ n: "num ber" }), /unsupported schema type "num ber" for key "n"/);
});

test("the names of pi's that trama goes by are the names pi has: a pi that sets its loop up by another is found out here", async () => {
  const { HANDS_IN, HOOKS, LOOPS } = await import("../packages/runtime/dist/pi-adapter.js");
  const { existsSync, readFileSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const pi = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  // (The agent's own package, where pi's would find it: it names no file for a `require` to be answered with.)
  const core = createRequire(join(pi, "index.js")).resolve.paths("@earendil-works/pi-agent-core")
    .map((dir) => join(dir, "@earendil-works", "pi-agent-core", "dist")).find((dir) => existsSync(join(dir, "agent.js")));
  assert.ok(core, "pi's agent is where pi would find it");

  // What pi's agent sets a loop up by, as pi's own source says it: each thing is one trama knows for what it is.
  const agent = readFileSync(join(core, "agent.js"), "utf-8");
  const config = agent.slice(agent.indexOf("createLoopConfig(options = {}) {"), agent.indexOf("async runWithLifecycle("));
  const setUpBy = [...config.matchAll(/^ {12}(\w+):/gm)].map(([, name]) => name);
  // (Data, which goes with a request as any data does; and the key a request is made by, which is its asker's to give
  // and is never left out: a pi that sets one has its agent's requests asked where the call is served.)
  const data = ["model", "reasoning", "sessionId", "transport", "thinkingBudgets", "maxRetryDelayMs", "identity", "toolExecution"];
  const known = [...data, ...HOOKS, ...LOOPS, "getApiKey"];
  assert.ok(setUpBy.length >= known.length, `read from pi's source: ${setUpBy}`);
  assert.deepEqual(setUpBy.filter((name) => !known.includes(name)), [], "pi sets its loop up by something trama does not know");
  assert.deepEqual([...HOOKS, ...LOOPS].filter((name) => !setUpBy.includes(name)), [], "trama goes by a name pi's loop no longer has");

  // And where an extension may have a hand in a request to a provider: the handlers pi asks after there.
  const sdk = readFileSync(join(pi, "core", "sdk.js"), "utf-8");
  const askedAfter = [...new Set([...sdk.matchAll(/hasHandlers\("([a-z_]*provider[a-z_]*)"\)/g)].map(([, event]) => event))];
  assert.deepEqual(askedAfter.sort(), [...HANDS_IN].sort());
});

test("a typed answer that is fenced, and holds fences of its own in what it says, is read whole: the model is not asked again", async () => {
  const F = "```";
  const answers = [
    `${F}json\n${JSON.stringify({ code: `${F}js\nrun();\n${F}`, note: "as asked" })}\n${F}`,
    `Here it is:\n\n${F}\n${JSON.stringify({ code: `before ${F} after`, note: "as asked" }, null, 2)}\n${F}\n`,
  ];
  for (const reply of answers) {
    let asked = 0;
    const agent = createAgent({ async ask() { asked += 1; return reply; } }, "/work");
    const answer = await agent.generate({ prompt: "p", schema: { code: "string", note: "string" } });
    assert.equal(answer.note, "as asked");
    assert.ok(answer.code.includes(F));
    assert.equal(asked, 1, reply);
  }
  // (Two blocks, of which the first is the answer: read as it was.)
  const agent = createAgent({ async ask() { return `${F}json\n{"n": 1}\n${F}\n\nand an example of something else:\n\n${F}\nnot json\n${F}`; } }, "/work");
  assert.deepEqual(await agent.generate({ prompt: "p", schema: { n: "number" } }), { n: 1 });
});
