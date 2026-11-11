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

import { PiAdapter } from "../packages/runtime/dist/pi-adapter.js";
import { REPAIR_SYSTEM_PROMPT } from "../packages/runtime/dist/runner.js";

const unexpected = (what) => async () => { throw new Error(`the test did not expect ${what}`); };

export const llm = { ask: unexpected("a call to the LLM"), repair: unexpected("a request for a fix") };

PiAdapter.prototype.ask = async function ask(prompt, call) {
  return (call.system === REPAIR_SYSTEM_PROMPT ? llm.repair : llm.ask).call(this, prompt, call);
};
