import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync } from "fs";
import { join } from "path";
import "./fake-llm.mjs";
import { createWorkspace } from "../packages/runtime/dist/workspace.js";
import { createWorkspace as workspaceOfAHost } from "../packages/runtime/dist/index.js";
import { runProgram } from "../packages/runtime/dist/runner.js";
import { printJournals } from "../packages/runtime/dist/journal-view.js";
import { REPO_ROOT, captureConsole, cleanupTempDir, createProjectFixture, isAlive, makeTempDir, waitFor, wholeLines, withEnv, writeJson } from "./helpers.mjs";

// An agent from outside, at work in a workspace (`workspace.agent`): what `tools.agent` is, begun where
// `workspace.shell` begins — in the directory a program was handed to work in, which is not its own. So that
// somebody else's harness can sit where a harness that is a program sits: at work on a codebase, in the copy a
// writer is handed. The agent is the stand-in of outside-agent.test.mjs.

const FAKE = join(REPO_ROOT, "test", "fake-acp-agent.mjs");
const fakeAgent = (told) => ({ command: process.execPath, args: [FAKE], env: { FAKE_ACP: JSON.stringify(told) } });
const sentTo = (log) => wholeLines(log).map((line) => JSON.parse(line));
const pidOf = (log) => Number(sentTo(log).find((message) => message.method === "session/prompt").params.sessionId.slice(2));

test("a workspace has an agent from outside do a piece of work in it: the agent is started there, or in a directory of it — and in no other", async (t) => {
  const dir = makeTempDir("trama-ws-agent-"), outside = makeTempDir("trama-ws-agent-outside-"), aside = makeTempDir("trama-ws-agent-aside-"), home = makeTempDir("trama-ws-agent-home-");
  t.after(() => { for (const each of [dir, outside, aside, home]) cleanupTempDir(each); });
  mkdirSync(join(dir, "sub"));
  const log = join(aside, "log");
  const stop = new AbortController();
  const ws = createWorkspace(dir, stop.signal);
  const agent = fakeAgent({ log, says: ["{cwd}"], writes: { "made.txt": "by the agent" } });

  const there = await ws.agent("Where are you?", { agent });
  assert.deepEqual([there.ok, there.text, there.failure], [true, realpathSync(dir), undefined]);
  // Where its process is started, and where it is told its conversation is.
  assert.equal(sentTo(log).find((message) => message.started).started.cwd, realpathSync(dir));
  assert.deepEqual(sentTo(log).filter((message) => message.method === "session/new").map((message) => message.params), [{ cwd: realpathSync(dir), mcpServers: [] }]);
  // What it writes there is in the workspace, as what `write` writes is.
  assert.equal(await ws.read("made.txt"), "by the agent");
  assert.equal((await ws.agent("Where are you?", { agent, cwd: "sub" })).text, realpathSync(join(dir, "sub")));
  assert.equal(await ws.read("sub/made.txt"), "by the agent");

  // Where it begins is held to the workspace: no path out of it, by its name or by a link — and nothing is started.
  const begun = sentTo(log).filter((message) => message.started).length;
  await assert.rejects(ws.agent("x", { agent, cwd: ".." }), /escapes/);
  await assert.rejects(ws.agent("x", { agent, cwd: outside }), /escapes/);
  symlinkSync(outside, join(dir, "way-out"));
  await assert.rejects(ws.agent("x", { agent, cwd: "way-out" }), /escapes/);
  // A call written wrongly is refused as `tools.agent` refuses it; one that did not go through is a result, as there.
  await assert.rejects(ws.agent("", { agent }), /prompt: expected text that is not empty/);
  await assert.rejects(ws.agent("x", {}), /agent: expected the name of one in the configuration, or the command that starts one/);
  await assert.rejects(ws.agent("x", { agent: "named" }), /No agent is named "named" in the configuration \("agents"\): it names none\./);
  assert.deepEqual([sentTo(log).filter((message) => message.started).length, existsSync(join(outside, "made.txt"))], [begun, false]);
  assert.equal((await ws.agent("x", { agent: { command: "no-such-agent-anywhere" }, timeout: 5000 })).failure.kind, "not-installed");

  // A workspace a host makes (createWorkspace, of the runner's API) knows the agents the configuration names.
  writeJson(join(home, ".trama", "config.json"), { agents: { named: agent } });
  const named = await withEnv({ HOME: home }, () => workspaceOfAHost(dir).agent("Where are you?", { agent: "named" }));
  assert.deepEqual([named.ok, named.text], [true, realpathSync(dir)]);

  // What stops the workspace stops the agent it is waiting on.
  const hung = join(aside, "hung");
  const waiting = ws.agent("Do it.", { agent: fakeAgent({ log: hung, hangs: true }), timeout: 60_000 });
  await waitFor(() => existsSync(hung) && sentTo(hung).some((message) => message.method === "session/prompt"), "the agent to be at work");
  const pid = pidOf(hung);
  assert.equal(isAlive(pid), true);
  stop.abort();
  await assert.rejects(waiting, /stopped/);
  await waitFor(() => !isAlive(pid), "the agent to be gone");
});

/** A program that has an agent from outside work in its workspace, in a directory of it, in its own project, and in another directory it names — and says where each was. */
const WORKS_THERE = `import { ctx, tools, workspace } from "@trama-dev/runtime";
import { createWorkspace } from "@trama-dev/runtime/runner";
const { other, byCommand } = ctx.input.args as { other: string; byCommand: string };
const where = "Where are you?";
const there = await workspace.agent(where, { agent: "named" });
const sub = await workspace.agent(where, { agent: "named", cwd: "sub" });
const own = await tools.agent(where, { agent: "named" });
const command = JSON.parse(byCommand);
const elsewhere = await createWorkspace(other).agent(where, { agent: { ...command, env: { ...command.env, ITS_KEY: "kept-out-of-every-journal" } } });
let refused = "", out = "";
try { await workspace.agent("x", { agent: "named", nope: 1 } as any); } catch (err: any) { refused = String(err.message); }
try { await workspace.agent("x", { agent: "named", cwd: "../.." }); } catch (err: any) { out = String(err.message); }
// An agent nobody named: asked of the workspace, and of the program's own tools.
const unnamed: string[] = [];
for (const asks of [workspace, tools]) try { await asks.agent("x", { agent: "nobody" }); } catch (err: any) { unnamed.push(String(err.message)); }
await ctx.done({ there, sub: sub.text, own: own.text, elsewhere: elsewhere.text, refused, out, unnamed });
`;
const NO_WORKSPACE = `import { ctx, workspace } from "@trama-dev/runtime";
let said = "";
try { await workspace.agent("x", { agent: "named" }); } catch (err: any) { said = String(err.message); }
await ctx.done({ said });
`;
const WAITS = `import { ctx, workspace } from "@trama-dev/runtime";
await workspace.agent("Do it.", { agent: "hangs", timeout: 60000 });
await ctx.done({});
`;

test("a program has an agent from outside work in its workspace, by the bridge: on record as a call of the workspace's, with what the agent said of itself under it — and the agent is the run's to stop", async (t) => {
  const projectDir = makeTempDir("trama-ws-agent-program-"), workspaceDir = makeTempDir("trama-ws-agent-shared-"), other = makeTempDir("trama-ws-agent-other-");
  const home = makeTempDir("trama-ws-agent-home-"), aside = makeTempDir("trama-ws-agent-aside-");
  t.after(() => { for (const each of [projectDir, workspaceDir, other, home, aside]) cleanupTempDir(each); });
  createProjectFixture(projectDir, { programSource: WORKS_THERE });
  mkdirSync(join(workspaceDir, "sub"));
  const told = { log: join(aside, "log"), says: ["{cwd}"], tools: 1, usage: { cost: 0.33 }, writes: { "made.txt": "by the agent" } };
  writeJson(join(home, ".trama", "config.json"), { agents: { named: fakeAgent(told), hangs: fakeAgent({ log: join(aside, "hung"), hangs: true }) } });
  const run = (options) => withEnv({ HOME: home }, () => captureConsole("warn", () => runProgram({ projectDir, maxRepairAttempts: 0, timeout: 60_000, ...options }))).then(({ result }) => result);

  const result = await run({ workspaceDir, args: { other, byCommand: JSON.stringify(fakeAgent(told)) } });
  assert.equal(result.status, "done", JSON.stringify(result));
  const { there, sub, own, elsewhere, refused, out, unnamed } = result.result;
  // Each where it was asked to be: the workspace, a directory of it, the program's own project, the directory named.
  assert.deepEqual([there.ok, there.text, sub, own, elsewhere], [true, realpathSync(workspaceDir), realpathSync(join(workspaceDir, "sub")), realpathSync(projectDir), realpathSync(other)]);
  assert.deepEqual([workspaceDir, join(workspaceDir, "sub"), projectDir, other].map((dir) => readFileSync(join(dir, "made.txt"), "utf-8")), Array(4).fill("by the agent"));
  assert.match(refused, /Unknown field: nope \(this call takes: prompt, agent, dir, cwd, timeout, system, model, session\)/);
  assert.match(out, /escapes/);
  // A call written wrongly is the request's fault, said in the words `tools.agent` is told it in: the same, to the letter.
  assert.match(unnamed[0], /No agent is named "nobody" in the configuration \("agents"\): it names named, hangs\.$/);
  assert.deepEqual([unnamed.length, unnamed[1], /TypeError/.test(unnamed[0])], [2, unnamed[0], false]);

  const dir = join(projectDir, "logs", "journal");
  const text = readFileSync(join(dir, readdirSync(dir).sort().at(-1)), "utf-8"), records = text.trim().split("\n").map((line) => JSON.parse(line));
  const calls = records.filter((record) => record.kind === "call");
  assert.deepEqual(calls.map((call) => call.endpoint), ["/workspace/agent", "/workspace/agent", "/tools/agent", "/workspace/agent", "/workspace/agent", "/workspace/agent", "/workspace/agent", "/tools/agent", "/ctx/done"]);
  assert.deepEqual([calls[0].request, calls[1].request], [{ prompt: "Where are you?", agent: "named" }, { prompt: "Where are you?", agent: "named", cwd: "sub" }]);
  // (Of the variables an agent is given, the names: a journal is no place for a key.)
  const { dir: named, agent, ...rest } = calls[3].request;
  assert.deepEqual([realpathSync(named), rest, [...agent.env].sort(), text.includes("kept-out-of-every-journal")], [realpathSync(other), { prompt: "Where are you?" }, ["FAKE_ACP", "ITS_KEY"], false]);
  // Under each call that went through: what the agent reported, and what it said it used — which is not what the run used.
  const under = (kind) => records.filter((record) => record.kind === kind).map((record) => record.seq);
  const went = [0, 1, 2, 3].map((at) => calls[at].seq);
  assert.deepEqual([under("outside-tool"), under("outside-usage"), records.some((record) => record.kind === "usage")], [went, went, false]);
  const answered = records.filter((record) => record.kind === "result");
  assert.deepEqual([answered[0].ok, answered[0].result.text, answered[4].ok, answered[5].ok], [true, there.text, false, false]);

  const shown = [], log = console.log;
  console.log = (line) => shown.push(String(line));
  try { printJournals(projectDir, "outside", {}); } finally { console.log = log; }
  const lines = shown.join("\n");
  assert.match(lines, /#1 +workspace\/agent +.*Where are you\?.*ok +\d+ms/);
  assert.match(lines, /#1 +the agent: tool +Reading file 1/);
  assert.match(lines, /end: done +\(outside agents said they used: 4936 tokens, USD 1\.32\)$/m);

  // A run that has no workspace is told so, as it is of the workspace's shell.
  createProjectFixture(projectDir, { programSource: NO_WORKSPACE });
  assert.match((await run({})).result.said, /only available when running in a session/);

  // And a run that is ended ends the agent it was waiting on in its workspace: it is the run's, as a command there is.
  createProjectFixture(projectDir, { programSource: WAITS });
  const ended = await run({ workspaceDir, timeout: 4000 });
  assert.equal(ended.status, "failed", JSON.stringify(ended));
  const pid = pidOf(join(aside, "hung"));
  await waitFor(() => !isAlive(pid), "the agent to be gone");
});
