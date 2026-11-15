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

  await withEnv({ PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }, async () => {
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
  for (const type of [["string"], { type: "string" }, 7, null]) {
    await assert.rejects(() => agent.generate({ prompt: "p", schema: { a: type } }), /unsupported schema type/, JSON.stringify(type));
  }
  assert.deepEqual(await agent.generate({ prompt: "p", schema: { a: "string: any text" } }), { a: "x" });
});
