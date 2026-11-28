import assert from "node:assert/strict";
import test from "node:test";
import { llm } from "./fake-llm.mjs";
import { runProgram } from "../packages/runtime/dist/index.js";
import { captureConsole, cleanupTempDir, createProjectFixture, makeTempDir } from "./helpers.mjs";

// A call of the runtime that fails says where the program made it: its error has the stack of the call — the
// program's own lines, as an error made there would have — and not that of the handler the answer came to, which no
// line of a program is ever on. (So a program that dies of one says where; and whoever fixes it is told.)

const quietly = (fn) => captureConsole("error", () => captureConsole("warn", () => captureConsole("log", fn))).then(({ result }) => result.result.result);

test("a call that failed has the stack of where the program made it: the program's lines, and none of the runtime's own", async (t) => {
  const projectDir = makeTempDir("trama-call-stack-");
  t.after(() => cleanupTempDir(projectDir));
  const original = { ...llm };
  t.after(() => { Object.assign(llm, original); });
  llm.ask = async () => { throw new Error("the model is away"); };
  createProjectFixture(projectDir, { programSource: `import { ctx, agent, tools } from "@trama-dev/runtime";
async function ask(): Promise<string> {
  return await agent.instruct("a question");
}
let asked = "", read = "";
try { await ask(); } catch (err) { asked = String((err as Error).stack); }
try { await tools.read("no-such-file.txt"); } catch (err) { read = String((err as Error).stack); }
await ctx.done({ asked, read });
` });
  const caught = await quietly(() => runProgram({ projectDir, maxRepairAttempts: 0, timeout: 30_000 }));
  assert.equal(caught.status, "done", caught.reason);
  const { asked, read } = caught.result;
  // What failed, in the words it failed with — and then where: the function of the program's that made the call, and where that was called from.
  assert.match(asked, /^Error: trama runtime error: Error: the model is away\n    at ask \([^\n]*program\.ts:3:\d+\)\n    at [^\n]*program\.ts:6:\d+/);
  const firstFrame = (stack) => stack.split("\n").find((line) => line.startsWith("    at "));
  assert.match(firstFrame(read), /program\.ts:7:\d+/);
  assert.match(read, /^Error: trama runtime error: /);
  for (const stack of [asked, read]) assert.doesNotMatch(stack, /runtime\/dist\/|bridge-client|IncomingMessage/, stack);

  // A program that dies of one says where it made the call: that is what its run failed with.
  createProjectFixture(projectDir, { programSource: `import { agent } from "@trama-dev/runtime";
await agent.instruct("a question");
` });
  const died = await quietly(() => runProgram({ projectDir, maxRepairAttempts: 0, timeout: 30_000 }));
  assert.equal(died.status, "failed");
  assert.match(died.reason, /\nError: trama runtime error: Error: the model is away\n    at [^\n]*program\.ts:2:\d+/);
  assert.doesNotMatch(died.reason, /bridge-client|IncomingMessage/);
});
