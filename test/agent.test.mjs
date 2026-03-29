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
