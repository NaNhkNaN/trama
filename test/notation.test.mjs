import assert from "node:assert/strict";
import test from "node:test";
import { createAgent } from "../packages/runtime/dist/agent.js";
import { argumentsOf, conform, hasList, heldTo, shapeOf } from "../packages/runtime/dist/schema.js";

// The notation shapes are written in — a typed answer's, a tool's parameters, what a project takes and gives —
// has three words beside the kinds, the fields and the lists: a field that may be absent, written with a "?" at
// the end of its name; "json", which is any value; and "object", which is an object whatever its fields.

test("a field written with a ? at the end of its name may be absent: held where it is there, left out where it is not — and told as a field that is not required", () => {
  const declared = { task: "string: what is to be done", "model?": "string: provider/model", "turns?": "number", "more?": { "deep?": "boolean", tags: ["string"] } };
  const held = (given) => heldTo(declared, given);
  // There: held to its kind, under its name — which has no "?".
  assert.deepEqual(held({ task: "t", model: "m", turns: 3, more: { deep: true, tags: ["a"] } }), { task: "t", model: "m", turns: 3, more: { deep: true, tags: ["a"] } });
  assert.throws(() => held({ task: "t", turns: "3" }), /Schema validation failed: turns: expected number, got string/);
  assert.throws(() => held({ task: "t", more: { deep: "yes", tags: [] } }), /more\.deep: expected boolean, got string/);
  // Absent: not in what is held — as a key that is not there, not as one that is undefined.
  assert.deepEqual(Object.keys(held({ task: "t" })), ["task"]);
  assert.deepEqual(held({ task: "t", more: { tags: [] } }), { task: "t", more: { tags: [] } });
  // (A null there is an absence: it is how many callers say "none".)
  assert.deepEqual(held({ task: "t", model: null, more: null }), { task: "t" });
  // A field that is not written so is to be there, as it was — inside an object that may be absent too, once the object is there.
  assert.throws(() => held({ model: "m" }), /missing key: task/);
  assert.throws(() => held({ task: "t", more: {} }), /missing key: more\.tags/);
  assert.throws(() => held({ task: null }), /task: expected string, got null/);
  // What is given under the name with its "?" is nothing that was declared.
  assert.deepEqual(held({ task: "t", "model?": "m" }), { task: "t" });

  // As JSON Schema, which is how a model is told: the field by its name, and not among those required.
  assert.deepEqual(argumentsOf(declared).schema, {
    type: "object",
    properties: {
      task: { type: "string", description: "what is to be done" }, model: { type: "string", description: "provider/model" }, turns: { type: "number" },
      more: { type: "object", properties: { deep: { type: "boolean" }, tags: { type: "array", items: { type: "string" } } }, required: ["tags"], additionalProperties: false },
    },
    required: ["task"], additionalProperties: false,
  });
  // A name that is only a "?", and a name written twice — with it and without — say nothing that can be held to.
  assert.throws(() => shapeOf({ "?": "string" }), /Schema validation failed: a field's name is missing before its "\?"/);
  assert.throws(() => shapeOf({ a: "string", "a?": "string" }), /Schema validation failed: the field "a" is written twice, with a "\?" and without/);
  assert.throws(() => shapeOf({ o: { b: "number", "b?": "number" } }), /the field "o\.b" is written twice/);
  // (A field named by nothing is a field, as it was: only the "?" is read off a name.)
  assert.deepEqual(heldTo({ "": "string" }, { "": "x" }), { "": "x" });
});

test("\"json\" is any value: what is there is held as it is — a string, a number, a list, an object, null — and what is not there is missing", () => {
  const declared = { inputs: ["json: the arguments of a run"], state: "json", "note?": "json: anything" };
  for (const value of ["s", 0, false, null, [1, "two", [null]], { a: { b: [] } }]) {
    assert.deepEqual(heldTo(declared, { inputs: [value, { word: "a" }], state: value }), { inputs: [value, { word: "a" }], state: value });
  }
  assert.throws(() => heldTo(declared, { inputs: [] }), /missing key: state/);
  assert.throws(() => heldTo(declared, { inputs: "none", state: 1 }), /inputs: expected a list, got string/);
  // (Optional, and any value: a null there is the absence, as of any optional field.)
  assert.deepEqual(heldTo(declared, { inputs: [], state: 1, note: null }), { inputs: [], state: 1 });
  assert.deepEqual(heldTo(declared, { inputs: [], state: 1, note: { n: null } }), { inputs: [], state: 1, note: { n: null } });
  // As JSON Schema: no kind is said of it — with what describes it, where something does.
  assert.deepEqual(argumentsOf(declared).schema.properties, { inputs: { type: "array", items: { description: "the arguments of a run" } }, state: {}, note: { description: "anything" } });
  assert.equal(hasList(shapeOf({ a: "json" })), false);
  // The kinds are these, still: a word that is none of them is said back.
  assert.throws(() => shapeOf({ a: "any" }), /unsupported schema type "any" for key "a"/);
  assert.deepEqual(conform({ a: 1, b: 2 }, shapeOf({ a: "json" })), { a: 1 });
});

test("\"object\" is an object, whatever its fields: held as it is, all of it — and nothing else is one: not a list, not null, not text — and told as that kind", () => {
  const declared = { args: "object: what a run is given", "more?": "object", each: ["object"] };
  // What is there is held as it is: every field of it, however deep — none is declared, so none is left out.
  const given = { args: { text: "a b", n: 1, deep: { list: [1, null, { x: true }] } }, each: [{}, { a: 1 }] };
  assert.deepEqual(heldTo(declared, given), given);
  assert.deepEqual(heldTo(declared, { args: {}, more: { any: "thing" }, each: [] }), { args: {}, more: { any: "thing" }, each: [] });
  // (May be absent, as any field may: and a null there is its absence.)
  assert.deepEqual(heldTo(declared, { args: {}, more: null, each: [] }), { args: {}, each: [] });
  // Nothing else is an object — least of all the text of one: said in the words any mismatch is said in.
  for (const [value, got] of [['{"text": "a b"}', "string"], [[1], "a list"], [null, "null"], [7, "7"], [true, "boolean"]]) {
    assert.throws(() => heldTo(declared, { args: value, each: [] }), new RegExp(`^Error: Schema validation failed: args: expected an object, got ${got}$`), JSON.stringify(value));
  }
  assert.throws(() => heldTo(declared, { args: {}, each: [{}, "x"] }), /each\[1\]: expected an object, got string/);
  assert.throws(() => heldTo(declared, { each: [] }), /missing key: args/);
  // As JSON Schema, which is how a model is told: the kind is said — an object — and nothing of its fields.
  assert.deepEqual(argumentsOf(declared).schema, {
    type: "object",
    properties: { args: { type: "object", description: "what a run is given" }, more: { type: "object" }, each: { type: "array", items: { type: "object" } } },
    required: ["args", "each"], additionalProperties: false,
  });
  // It is a kind, and no list: and the words there were say what they said.
  assert.deepEqual([shapeOf({ a: "object: of anything" }), hasList(shapeOf({ a: "object" }))], [{ fields: [["a", "object"]], mayBeAbsent: [] }, false]);
  assert.deepEqual(argumentsOf({ a: "json", b: {} }).schema.properties, { a: {}, b: { type: "object", properties: {}, required: [], additionalProperties: false } });
  assert.deepEqual(heldTo({ b: {} }, { b: { dropped: 1 } }), { b: {} });
});

test("a typed answer may leave out a field written with a ?: the model is told so, where there is one — and an answer without it is the answer", async () => {
  const prompts = [];
  let reply;
  const agent = createAgent({ async ask(prompt) { prompts.push(prompt); return JSON.stringify(reply); } }, "/work");
  reply = { passed: true };
  assert.deepEqual(await agent.generate({ prompt: "p", schema: { passed: "boolean", "why?": "string: where it did not pass" } }), { passed: true });
  reply = { passed: false, why: "a test failed", more: 1 };
  assert.deepEqual(await agent.generate({ prompt: "p", schema: { passed: "boolean", "why?": "string" } }), { passed: false, why: "a test failed" });
  assert.match(prompts[0], /\}\nA field whose name ends in "\?" may be left out; where it is given, its name is without the "\?"\.\nNo markdown\./);
  // Told where there is one, anywhere in the shape — and not where there is none.
  reply = { a: [{}] };
  await agent.generate({ prompt: "p", schema: { a: [{ "b?": "number" }] } });
  assert.match(prompts[2], /it shows one item: answer with as many as there are, each of that shape\.\nA field whose name ends in "\?" may be left out/);
  reply = { a: "x" };
  await agent.generate({ prompt: "p", schema: { a: "string" } });
  assert.doesNotMatch(prompts[3], /may be left out/);
});
