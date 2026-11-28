// A stand-in for the LLM, for tests that run the real runner.
//
// The runtime reaches the LLM through one call — backend.ask(prompt, call) —
// and a repair is just one more prompt. Tests want to answer the two kinds of
// request separately, so importing this routes every call to `llm.repair` when
// trama is asking for a fix and to `llm.ask` otherwise. Assign the one a test
// needs, and put the old value back after. A call a test did not provide for
// fails: no test reaches a real model through here.
//
// A stub is called as (prompt, call) and returns the LLM's reply as text; the
// runtime treats it exactly as it would a real reply.
//
// One request to the model, as a program that is its own harness makes them,
// goes to `llm.complete`: called as (request, call), it returns the reply as
// the model's library would make it.

import { PiAdapter } from "../packages/runtime/dist/pi-adapter.js";

// What the runtime's own fixer (packages/runtime/programs/program-fixer) tells the agent it asks for a fix: how a
// request for a fix is told from any other, by a test that has the fixer as it came.
const ASKED_FOR_A_FIX = "You are a TypeScript repair tool.";

const unexpected = (what) => async () => { throw new Error(`the test did not expect ${what}`); };

export const llm = { ask: unexpected("a call to the LLM"), repair: unexpected("a request for a fix"), complete: unexpected("a request to the model") };

PiAdapter.prototype.ask = async function ask(prompt, call) {
  return (call.system === ASKED_FOR_A_FIX ? llm.repair : llm.ask).call(this, prompt, call);
};

PiAdapter.prototype.complete = async function complete(request, call) {
  return llm.complete.call(this, request, call);
};
