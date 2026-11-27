import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { createWorkspace } from "../packages/runtime/dist/workspace.js";
import { heldTo } from "../packages/runtime/dist/schema.js";
import { runProgram } from "../packages/runtime/dist/runner.js";
import { printJournals } from "../packages/runtime/dist/journal-view.js";
import { captureConsole, cleanupTempDir, createProjectFixture, makeTempDir } from "./helpers.mjs";

// What a program that works in a directory not its own has there: a shell, beside reading and writing — and, for
// a program that runs tools a model calls, a way to hold what the model called them with to what they declared.

test("a workspace has a shell: a command runs in it, or in a directory of it — and in no other", async (t) => {
  const dir = makeTempDir("trama-ws-shell-"), outside = makeTempDir("trama-ws-outside-");
  t.after(() => { cleanupTempDir(dir); cleanupTempDir(outside); });
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "a.txt"), "the heron waits");
  const ws = createWorkspace(dir);

  assert.deepEqual(await ws.shell("pwd"), { exitCode: 0, stdout: `${realpathSync(dir)}\n`, stderr: "" });
  assert.deepEqual(await ws.shell("cat a.txt", { cwd: "sub" }), { exitCode: 0, stdout: "the heron waits", stderr: "" });
  // What a command writes is in the workspace, as what `write` writes is.
  await ws.shell("echo made > made.txt");
  assert.equal(await ws.read("made.txt"), "made\n");
  // A command that fails is a result, as it is of a program's own shell; and so is one that takes too long.
  assert.deepEqual(await ws.shell("echo no >&2; exit 3"), { exitCode: 3, stdout: "", stderr: "no\n" });
  const slow = await ws.shell("sleep 5", { timeout: 200 });
  assert.equal(slow.exitCode, 1);
  assert.match(slow.stderr, /timeout$/);
  // Variables given are the command's.
  assert.equal((await ws.shell("printf %s \"$WHOSE\"", { env: { WHOSE: "the workspace's" } })).stdout, "the workspace's");

  // Where it begins is held to the workspace: no path out of it, by its name or by a link.
  await assert.rejects(ws.shell("pwd", { cwd: ".." }), /escapes/);
  await assert.rejects(ws.shell("pwd", { cwd: outside }), /escapes/);
  symlinkSync(outside, join(dir, "way-out"));
  await assert.rejects(ws.shell("pwd", { cwd: "way-out" }), /escapes/);
});

/** A program that does in its workspace what it is told, and says what came of it. */
const WORKS_THERE = `import { ctx, tools, workspace, heldTo } from "@trama-dev/runtime";
const there = await workspace.shell("pwd && ls && wc -w < data.txt | tr -d ' '");
const sub = await workspace.shell("pwd", { cwd: "sub" });
const own = await tools.shell("pwd");
const whose = await workspace.shell('printf %s "$WHOSE"');
let refused = "";
try { await workspace.shell("pwd", { cwd: "../.." }); } catch (err: any) { refused = String(err.message); }
const held = heldTo({ path: "string: where", lines: ["number"] }, { path: "a.txt", lines: [1, 2] });
let notHeld = "";
try { heldTo({ path: "string" }, { path: 7 }); } catch (err: any) { notHeld = String(err.message); }
await ctx.done({ there: there.stdout, sub: sub.stdout, own: own.stdout, whose: whose.stdout, refused, held, notHeld });
`;

test("a program has a shell in its workspace by the bridge, on record as one — and holds a tool's arguments to what the tool declared", async (t) => {
  const projectDir = makeTempDir("trama-ws-program-"), workspaceDir = makeTempDir("trama-ws-shared-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(workspaceDir); });
  createProjectFixture(projectDir, { programSource: WORKS_THERE });
  mkdirSync(join(workspaceDir, "sub"));
  writeFileSync(join(workspaceDir, "data.txt"), "the heron waits at low tide");

  const result = await runProgram({ projectDir, workspaceDir, maxRepairAttempts: 0, timeout: 30_000, env: { WHOSE: "the run's" } });
  assert.equal(result.status, "done", JSON.stringify(result));
  const { there, sub, own, whose, refused, held, notHeld } = result.result;
  // (The shell there is the run's: a command has the run's variables, as one in the project has.)
  assert.equal(whose, "the run's");
  assert.equal(there, `${realpathSync(workspaceDir)}\ndata.txt\nsub\n6\n`);
  assert.equal(sub, `${join(realpathSync(workspaceDir), "sub")}\n`);
  // (Its own shell is where it always was: in its project.)
  assert.equal(own, `${realpathSync(projectDir)}\n`);
  assert.match(refused, /^trama runtime error: .*escapes/);
  assert.deepEqual(held, { path: "a.txt", lines: [1, 2] });
  assert.match(notHeld, /path/);
  assert.doesNotMatch(notHeld, /trama runtime error/);

  const shown = (await captureConsole("log", async () => printJournals(projectDir, "it", {}))).messages.join("\n");
  assert.match(shown, /#1 +workspace\/shell +pwd && ls && wc -w < data\.txt \| tr -d ' ' +ok/);
  assert.match(shown, /#5 +workspace\/shell +pwd +failed/);

  // Outside a session there is no workspace, and no shell in one: said without a round trip, as of the rest.
  const alone = makeTempDir("trama-ws-alone-");
  t.after(() => cleanupTempDir(alone));
  createProjectFixture(alone, { programSource: `import { ctx, workspace } from "@trama-dev/runtime";
await ctx.done({ said: await workspace.shell("pwd").catch((err) => String(err.message)) });
` });
  assert.deepEqual((await runProgram({ projectDir: alone, maxRepairAttempts: 0, timeout: 30_000 })).result, { said: "This run has no workspace: workspace.* is there where a run is given one (trama run --workspace <dir>, or workspaceDir)" });
});

test("what a model calls a tool with is held to what the tool declared: the declared fields come back, and what is wrong is said in words for the model", () => {
  const parameters = { id: "string: the order's id", count: "number", urgent: "boolean", tags: ["string"], owner: { name: "string" } };
  const given = { id: "7", count: 3, urgent: true, tags: ["cold"], owner: { name: "Ada" } };
  assert.deepEqual(heldTo(parameters, given), given);
  // A tool that declared nothing is called with nothing.
  assert.deepEqual(heldTo(undefined, {}), {});
  // What was not declared is left behind, as the runner leaves it: a tool is called with its own fields.
  assert.deepEqual(heldTo(undefined, { a: 1 }), {});
  assert.throws(() => heldTo(parameters, { ...given, count: "three" }), /count/);
  assert.deepEqual(heldTo(parameters, { ...given, extra: 1 }), given);
  assert.throws(() => heldTo(parameters, { id: "7" }), /count|urgent|tags|owner/);
  assert.throws(() => heldTo(parameters, "7"), /not an object/);
  assert.throws(() => heldTo({ a: 7 }, {}), /Schema/);
});
