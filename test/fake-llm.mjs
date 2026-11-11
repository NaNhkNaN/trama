// A stand-in for the LLM, for tests that run the real runner.
//
// The runtime reaches the LLM through one call — backend.ask(prompt, call) —
// and a repair is just one more prompt. Tests want to answer the two kinds of
// request separately, so importing this routes every call to `llm.repair` when
// trama is asking for a fix and to `llm.ask` otherwise. Both start out as the
// real thing: assign the one a test needs, and put the old value back after.
//
// A stub is called as (prompt, call) and returns the LLM's reply as text; the
// runtime treats it exactly as it would a real reply.

import { PiAdapter } from "../packages/runtime/dist/pi-adapter.js";

const real = PiAdapter.prototype.ask;

export const llm = { ask: real, repair: real };

const isRepairRequest = (prompt) => prompt.startsWith("Fix this program so it runs.");

PiAdapter.prototype.ask = async function ask(prompt, call) {
  return (isRepairRequest(prompt) ? llm.repair : llm.ask).call(this, prompt, call);
};
