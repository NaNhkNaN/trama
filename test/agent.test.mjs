import assert from "node:assert/strict";
import test from "node:test";
import { createAgent } from "../packages/runtime/dist/agent.js";

test("createAgent ask delegates prompt and options to the adapter", async () => {
  const calls = [];
  const adapter = {
    async ask(prompt, options) {
      calls.push({ prompt, options });
      return "adapter reply";
    },
  };

  const agent = createAgent(adapter);
  const result = await agent.ask("hello", { system: "sys" });

  assert.equal(result, "adapter reply");
  assert.deepEqual(calls, [{ prompt: "hello", options: { system: "sys" } }]);
});

test("createAgent generate strips fenced JSON and validates the requested shape", async () => {
  const adapter = {
    async ask() {
      return "```json\n{\"reasoning\":\"ok\",\"success\":true}\n```";
    },
  };

  const agent = createAgent(adapter);
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

  const agent = createAgent(adapter);
  const result = await agent.generate({
    prompt: "repair",
    schema: { reasoning: "string: explanation" },
  });

  assert.deepEqual(result, { reasoning: "fixed" });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /failed validation/);
});

test("createAgent ask passes abort signal to adapter", async () => {
  const calls = [];
  const adapter = {
    async ask(prompt, options) {
      calls.push(options);
      return "reply";
    },
  };

  const controller = new AbortController();
  const agent = createAgent(adapter, controller.signal);
  await agent.ask("hello");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal, controller.signal);
});

test("createAgent ask works without a signal", async () => {
  const calls = [];
  const adapter = {
    async ask(prompt, options) {
      calls.push(options);
      return "reply";
    },
  };

  const agent = createAgent(adapter);
  await agent.ask("hello", { system: "sys" });

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

  const agent = createAgent(adapter);

  await assert.rejects(
    async () => agent.generate({
      prompt: "count",
      schema: { count: "number: result count" },
    }),
    /Schema validation failed: count: expected number, got string/,
  );
});

test("createAgent generate rejects unsupported schema types", async () => {
  const adapter = {
    async ask() {
      return '{"items": [1,2,3]}';
    },
  };

  const agent = createAgent(adapter);

  await assert.rejects(
    async () => agent.generate({
      prompt: "list",
      schema: { items: "array: list of numbers" },
    }),
    /unsupported schema type "array"/,
  );
});

// --- PiAdapter abort wiring tests (mock session, no real LLM) ---

test("PiAdapter.ask rejects immediately when signal is already aborted", async () => {
  const { PiAdapter } = await import("../packages/runtime/dist/pi-adapter.js");

  const adapter = new PiAdapter({ provider: "anthropic", model: "test" }, "/tmp");
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    async () => adapter.ask("hello", { signal: controller.signal }),
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
  const adapter = new PiAdapter({ provider: "anthropic", model: "test" }, "/tmp");
  adapter.createSession = async () => fakeSession;

  const controller = new AbortController();
  const promise = adapter.ask("hello", { signal: controller.signal });

  // Abort after a tick — should dispose the session and reject the prompt
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();

  await assert.rejects(async () => promise, /disposed/i);
  assert.ok(disposeCalled > 0, "session.dispose should have been called");
});
