import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { createTools } from "../packages/runtime/dist/tools.js";
import { loadConfig } from "../packages/runtime/dist/project.js";
import { runProgram } from "../packages/runtime/dist/runner.js";
import { printJournals } from "../packages/runtime/dist/journal-view.js";
import { llm } from "./fake-llm.mjs";
import { createProject } from "../packages/runtime/dist/index.js";
import { REPO_ROOT, captureConsole, cleanupTempDir, createProjectFixture, isAlive, makeTempDir, pidIn, waitFor, wholeLines, withEnv, writeJson } from "./helpers.mjs";

// An agent from outside, called as a tool (`tools.agent`): somebody else's harness, whole, started as a process
// and spoken with by the Agent Client Protocol. It is a black box, and is treated as one — a prompt in, and out
// of it what it said and how that went, as a shell command's result is what the command did. Here the agent is a
// stand-in that speaks the protocol and does as it is told (fake-acp-agent.mjs).

const FAKE = join(REPO_ROOT, "test", "fake-acp-agent.mjs");

/** A project, its tools, and a stand-in agent that writes down what it is sent. */
function scene(t, agents) {
  const dir = makeTempDir("trama-outside-"), aside = makeTempDir("trama-outside-aside-");
  mkdirSync(join(dir, "sub"));
  const log = join(aside, "log"), sessions = join(aside, "sessions");
  const stop = new AbortController();
  const tools = createTools(dir, stop.signal, { OF_THE_RUN: "yes", WHOSE: "the run's" }, agents?.({ log, sessions }));
  t.after(async () => { await tools.stopActiveShells(); cleanupTempDir(dir); cleanupTempDir(aside); });
  /** The agent, as a call or the configuration names one by its command: told what to do by a variable of its own. */
  const fake = (told = {}) => ({ command: process.execPath, args: [FAKE, "as-an-agent"], env: { FAKE_ACP: JSON.stringify({ log, sessions, ...told }), WHOSE: "the agent's" } });
  // (Read while the agent may be writing it: see wholeLines.)
  const sent = () => wholeLines(log).map((line) => JSON.parse(line));
  return {
    dir, aside, tools, stop, fake, sent,
    /** What it was sent by a method's name, in order. */
    got: (method) => sent().filter((message) => message.method === method).map((message) => message.params),
    methods: () => sent().filter((message) => message.method).map((message) => message.method),
    ask: (prompt, told, options) => tools.agent(prompt, { agent: fake(told), ...options }),
  };
}
const fakeAgent = (told) => ({ command: process.execPath, args: [FAKE], env: { FAKE_ACP: JSON.stringify(told) } });
const pidOf = (session) => Number(/^s-(\d+)$/.exec(session)[1]);

test("a program has an agent from outside do a piece of work: a prompt in; out, what it said and how it went — and the agent gone when the call is over", async (t) => {
  const it = scene(t), left = join(it.aside, "left.pid");
  const result = await it.ask("Count the files.", { says: ["There are ", "three: {prompt}"], tools: 2, usage: { cost: 0.33 }, chatters: true, leaves: left });
  assert.deepEqual(result, {
    ok: true,
    text: "There are three: Count the files.",
    messages: ["There are three: Count the files."],
    stopReason: "end_turn",
    session: result.session,
    // (As the agent said it: tokens in the answer to the prompt, how full it is and what it cost in what it said on the way.)
    usage: { input: 1200, output: 34, total: 1234, cacheRead: 1000, cost: { amount: 0.33, currency: "USD" }, context: { used: 53000, size: 200000 } },
    toolCalls: [{ title: "Reading file 1", kind: "read", status: "completed" }, { title: "Reading file 2", kind: "read", status: "completed" }],
    given: { system: "none", permissions: { granted: 0, refused: 0 } },
    agent: { name: "fake-agent", version: "0.0.1", resumes: false, takesSystem: false },
  });

  // What the agent was started as, and with: the command and its arguments, in the project, with the variables a
  // shell command of the run's has and its own over them.
  const [{ started }] = it.sent();
  assert.deepEqual(started, { argv: ["as-an-agent"], cwd: realpathSync(it.dir), env: { WHOSE: "the agent's", OF_THE_RUN: "yes", TRAMA_PORT: null, TRAMA_INIT: null } });
  // What it was told, by the protocol, and nothing else: version 1; a client that offers nothing of its own (no
  // file system, no terminal — the agent reads and writes as itself); a session in that directory, with no servers
  // of tools; the prompt.
  assert.deepEqual(it.methods(), ["initialize", "session/new", "session/prompt"]);
  const [hello] = it.got("initialize");
  assert.deepEqual([hello.protocolVersion, hello.clientCapabilities, hello.clientInfo.name], [1, {}, "trama"]);
  assert.deepEqual(it.got("session/new"), [{ cwd: realpathSync(it.dir), mcpServers: [] }]);
  assert.deepEqual(it.got("session/prompt"), [{ sessionId: result.session, prompt: [{ type: "text", text: "Count the files." }] }]);
  // The agent is gone, and what it started with it: a call leaves nothing running.
  assert.equal(isAlive(pidOf(result.session)), false);
  await waitFor(() => !isAlive(pidIn(left)), "what the agent started to be gone");

  // In a directory of the project, where the call says so — and in no other.
  const there = await it.ask("Where are you?", { says: ["{cwd}"] }, { cwd: "sub" });
  assert.equal(there.text, realpathSync(join(it.dir, "sub")));
  assert.equal(it.got("session/new").at(-1).cwd, realpathSync(join(it.dir, "sub")));
  await assert.rejects(it.ask("x", {}, { cwd: ".." }), /escapes/);

  // What it says in several messages is not run together: a message is told from the next by its id, where the
  // agent gives one — and by a tool it called between two things it said. (An agent says what it is about to do,
  // does it, and then answers: the answer is not the end of the sentence before.)
  const several = await it.ask("x", { says: ["I will look", " at it first.", "There are three."], ids: ["a", "a", "b"] });
  assert.equal(several.text, "I will look at it first.\n\nThere are three.");
  // And they are there apart, each whole: the last is the agent's answer, for a program that wants that alone.
  assert.deepEqual(several.messages, ["I will look at it first.", "There are three."]);
  const around = await it.ask("x", { says: ["I will look at it first.", "There are", " three."], between: true });
  assert.deepEqual([around.text, around.toolCalls], ["I will look at it first.\n\nThere are three.", [{ title: "Looking", kind: "read", status: "completed" }]]);
  assert.deepEqual(around.messages, ["I will look at it first.", "There are three."]);
  // (Both at once is one break, not two; and a tool called before anything was said is none.)
  const both = await it.ask("x", { says: ["First.", "Then."], ids: ["a", "b"], between: true, tools: 1 });
  assert.deepEqual([both.text, both.messages], ["First.\n\nThen.", ["First.", "Then."]]);
  // (An empty line the agent itself wrote is its own, within a message: it parts nothing.)
  const own = await it.ask("x", { says: ["One thing.\n\n", "And the rest of it."], ids: ["a", "a"] });
  assert.deepEqual([own.text, own.messages], ["One thing.\n\nAnd the rest of it.", ["One thing.\n\nAnd the rest of it."]]);

  // An agent that says nothing of what it used has no usage: none is made up for it.
  const quiet = await it.ask("x", { usage: false });
  assert.deepEqual([quiet.ok, "usage" in quiet], [true, false]);
});

test("a system prompt goes as the session's where the agent takes one, and at the head of the prompt where it does not: it is not dropped, and the result says which way it went", async (t) => {
  const it = scene(t);
  const taken = await it.ask("Count.", { takes: { system: true } }, { system: "Be brief." });
  assert.deepEqual([taken.given.system, taken.agent.takesSystem], ["as-system", true]);
  assert.deepEqual(it.got("session/new").at(-1).systemPrompt, { mode: "append", content: [{ type: "text", text: "Be brief." }] });
  assert.deepEqual(it.got("session/prompt").at(-1).prompt, [{ type: "text", text: "Count." }]);

  const headed = await it.ask("Count.", {}, { system: "Be brief." });
  assert.deepEqual([headed.given.system, headed.agent.takesSystem], ["in-prompt", false]);
  assert.equal("systemPrompt" in it.got("session/new").at(-1), false);
  assert.deepEqual(it.got("session/prompt").at(-1).prompt, [{
    type: "text",
    text: "[Standing instructions, from whoever asked for this work: they hold for all of it.]\nBe brief.\n\n[The work asked for]\nCount.",
  }]);
});

test("the agent's own model serves: the one a call names is for an agent that has none, where it is on offer — and the result says what the agent has", async (t) => {
  const it = scene(t);
  const set = (calls) => it.got("session/set_config_option").length - calls;
  // It has none, and the one named is on offer: set, by the session's option.
  const none = await it.ask("x", { models: { current: null, options: ["small", "large"] }, says: ["served by {model}"] }, { model: "large" });
  assert.deepEqual([none.text, none.given.model, none.agent.models, none.agent.model], ["served by large", { asked: "large", set: true }, ["small", "large"], "large"]);
  assert.deepEqual(it.got("session/set_config_option"), [{ sessionId: none.session, configId: "model", value: "large" }]);
  // It has one: that serves, whatever the call names.
  const own = await it.ask("x", { models: { current: "small", options: ["small", "large"] }, says: ["served by {model}"] }, { model: "large" });
  assert.deepEqual([own.text, own.given.model, own.agent.model, set(1)], ["served by small", { asked: "large", set: false }, "small", 0]);
  // The one named is not on offer, or nothing is: nothing is set, and it is said.
  const unknown = await it.ask("x", { models: { current: null, options: ["small", "large"] } }, { model: "huge" });
  assert.deepEqual([unknown.ok, unknown.given.model, unknown.agent.models, "model" in unknown.agent, set(1)], [true, { asked: "huge", set: false }, ["small", "large"], false, 0]);
  const offersNone = await it.ask("x", {}, { model: "large" });
  assert.deepEqual([offersNone.ok, offersNone.given.model, "models" in offersNone.agent, set(1)], [true, { asked: "large", set: false }, false, 0]);
  // No model named: nothing is said of one having been asked for, and what the agent has is told all the same.
  const unasked = await it.ask("x", { models: { current: "small", options: ["small", "large"] } });
  assert.deepEqual(["model" in unasked.given, unasked.agent.model, unasked.agent.models], [false, "small", ["small", "large"]]);
});

test("a conversation is gone on with by its id, in a new process: resumed where the agent resumes, loaded where it loads — and refused, as a result, where it does neither", async (t) => {
  const it = scene(t);
  const first = await it.ask("The word is heron.", { takes: { resume: true, load: true } });
  assert.deepEqual([first.ok, first.agent.resumes, "resumed" in first.given], [true, true, false]);

  const again = await it.ask("What was the word?", { takes: { resume: true, load: true }, says: ["Before this: {before}"] }, { session: first.session });
  assert.deepEqual([again.text, again.session, again.given.resumed], ["Before this: The word is heron.", first.session, "resume"]);
  assert.equal(it.sent().filter((message) => message.started).length, 2, "each call is a process of its own");
  assert.deepEqual(it.got("session/resume"), [{ sessionId: first.session, cwd: realpathSync(it.dir), mcpServers: [] }]);
  assert.equal(it.got("session/new").length, 1, "no new session is opened for a conversation gone on with");

  // To load is to be told the old conversation over again: that is no part of what the agent says now.
  const loaded = await it.ask("And again?", { takes: { load: true }, says: ["Before this: {before}"] }, { session: first.session });
  assert.deepEqual([loaded.text, loaded.given.resumed, loaded.agent.resumes], ["Before this: The word is heron. | What was the word?", "load", true]);
  assert.deepEqual(it.got("session/load"), [{ sessionId: first.session, cwd: realpathSync(it.dir), mcpServers: [] }]);

  // An agent that does neither: nothing is asked of it, and the result says why.
  const prompts = it.got("session/prompt").length;
  const neither = await it.ask("And again?", {}, { session: first.session });
  assert.deepEqual([neither.ok, neither.failure.kind, neither.agent.resumes], [false, "refused", false]);
  assert.match(neither.failure.message, /does not go on with a conversation/);
  assert.equal(it.got("session/prompt").length, prompts);
  // And one that will not go on with this one: refused, in its own words.
  const gone = await it.ask("And again?", { takes: { resume: true } }, { session: "s-no-such" });
  assert.deepEqual([gone.ok, gone.failure.kind], [false, "refused"]);
  assert.match(gone.failure.message, /Resource not found: session s-no-such/);
});

test("permission is granted where the agent asks it, for the once: never for always — and what else an agent asks of its client, it is told the client has not", async (t) => {
  const it = scene(t);
  const once = await it.ask("Build it.", { asks: ["allow_always", "allow_once", "reject_once"], says: ["Built."] });
  assert.deepEqual([once.text, once.given.permissions], ["Built. [permission: selected opt-allow_once]", { granted: 1, refused: 0 }]);
  // Where it cannot be granted for the once, it is refused for the once: nothing is written into the user's own settings for the agent.
  const never = await it.ask("Build it.", { asks: ["allow_always", "reject_always", "reject_once"], says: ["Not built."] });
  assert.deepEqual([never.text, never.given.permissions], ["Not built. [permission: selected opt-reject_once]", { granted: 0, refused: 1 }]);
  const neither = await it.ask("Build it.", { asks: ["allow_always"], says: ["Not built."] });
  assert.deepEqual([neither.text, neither.given.permissions], ["Not built. [permission: cancelled ]", { granted: 0, refused: 1 }]);

  const wanting = await it.ask("Read it.", { wants: "fs/read_text_file", says: ["Read."] });
  assert.deepEqual([wanting.ok, wanting.text], [true, "Read. [fs/read_text_file: -32601]"]);
});

test("a call that did not go through is a result, sorted by what stood in its way — with the agent's own words", async (t) => {
  const it = scene(t);
  const failed = async (how, told, options) => {
    const result = await (how === "command" ? it.tools.agent("Do it.", { agent: told, ...options }) : it.ask("Do it.", told, options));
    assert.equal(result.ok, false);
    return result;
  };

  // Not installed: there is no such command — or it ended before it answered anything, as one that could not be fetched does.
  const absent = await failed("command", { command: "no-such-agent-anywhere", args: ["acp"] });
  assert.deepEqual([absent.failure.kind, absent.text, absent.messages, absent.toolCalls], ["not-installed", "", [], []]);
  assert.match(absent.failure.message, /no-such-agent-anywhere/);
  const unfetched = await failed("told", { dies: "start" });
  assert.equal(unfetched.failure.kind, "not-installed");
  assert.match(unfetched.failure.message, /ended before it answered \(exit code 3\)[^]*fake-agent: no such thing as was asked for/);

  // Not logged in: by the protocol's own code for it, wherever it is said.
  const loggedOut = await failed("told", { login: true });
  assert.deepEqual([loggedOut.failure.kind, loggedOut.agent.name], ["not-logged-in", "fake-agent"]);
  assert.match(loggedOut.failure.message, /Authentication required: run `fake-agent login` first/);
  assert.equal((await failed("told", { fails: { code: -32000, message: "Authentication required" } })).failure.kind, "not-logged-in");

  // Refused: the agent's own refusal; and an agent that speaks another version of the protocol.
  const refusal = await failed("told", { stop: "refusal", says: ["I will not."] });
  assert.deepEqual([refusal.failure.kind, refusal.stopReason, refusal.text], ["refused", "refusal", "I will not."]);
  const other = await failed("told", { protocol: 2 });
  assert.equal(other.failure.kind, "refused");
  assert.match(other.failure.message, /version 2 of the protocol/);
  assert.deepEqual(it.methods().slice(-1), ["initialize"], "nothing more is said to it");

  // Failed: it died in the middle (what it had said is kept, and what it wrote as it went down); it answered
  // the prompt with an error; or the turn ended otherwise than a turn does.
  const died = await failed("told", { dies: "turn", says: ["Half of it"] });
  assert.deepEqual([died.failure.kind, died.text, died.messages, typeof died.session], ["failed", "Half of it", ["Half of it"], "string"]);
  assert.match(died.failure.message, /ended in the middle of the work \(exit code 7\)[^]*out of memory, or some such/);
  const errored = await failed("told", { fails: { code: -32603, message: "Internal error: the model is overloaded" } });
  assert.equal(errored.failure.kind, "failed");
  assert.match(errored.failure.message, /Internal error: the model is overloaded/);
  const cut = await failed("told", { stop: "max_tokens", says: ["Most of it"] });
  assert.deepEqual([cut.failure.kind, cut.stopReason, cut.text], ["failed", "max_tokens", "Most of it"]);
  assert.match(cut.failure.message, /max_tokens/);
});

test("a call has the time it is given, and no more: the agent is told to stop, and stopped — with what it had said", async (t) => {
  const it = scene(t);
  // One that stops when told: at once.
  let began = Date.now();
  const obeyed = await it.ask("Do it.", { hangs: "obeys", says: ["So far, so good"] }, { timeout: 600 });
  assert.deepEqual([obeyed.ok, obeyed.failure.kind, obeyed.text, obeyed.stopReason], [false, "timed-out", "So far, so good", "cancelled"]);
  assert.match(obeyed.failure.message, /not done after the 600ms it was given/);
  assert.ok(Date.now() - began < 4000, `took ${Date.now() - began}ms`);
  assert.deepEqual(it.got("session/cancel"), [{ sessionId: obeyed.session }]);
  assert.equal(isAlive(pidOf(obeyed.session)), false);

  // One that does not: given a moment, and then stopped all the same.
  began = Date.now();
  const deaf = await it.ask("Do it.", { hangs: true, says: ["So far"] }, { timeout: 600 });
  assert.deepEqual([deaf.failure.kind, deaf.text, "stopReason" in deaf], ["timed-out", "So far", false]);
  assert.ok(Date.now() - began > 4000 && Date.now() - began < 9000, `took ${Date.now() - began}ms`);
  assert.equal(isAlive(pidOf(deaf.session)), false);
});

test("a run that is stopped stops the agents it is waiting on: the call ends as any does in such a run, and nothing is left", async (t) => {
  const it = scene(t);
  const waiting = it.ask("Do it.", { hangs: true }, { timeout: 60_000 });
  await waitFor(() => it.got("session/prompt").length === 1, "the agent to be at work");
  const pid = it.sent()[0] && Number(it.sent().find((message) => message.method === "session/prompt").params.sessionId.slice(2));
  assert.equal(isAlive(pid), true);
  it.stop.abort();
  await assert.rejects(waiting, /stopped/);
  await waitFor(() => !isAlive(pid), "the agent to be gone");

  // And what stops a run's shell commands stops its agents: they are the run's, as those are.
  const other = scene(t);
  const held = other.ask("Do it.", { hangs: true }, { timeout: 60_000 }).catch((err) => err);
  await waitFor(() => other.got("session/prompt").length === 1, "the agent to be at work");
  const itsPid = Number(other.got("session/prompt")[0].sessionId.slice(2));
  await other.tools.stopActiveShells();
  assert.equal(isAlive(itsPid), false);
  const ended = await held;
  assert.ok(ended instanceof Error || ended.ok === false, "the call does not go on waiting");
});

test("an agent is named in the configuration, or by its command in the call: a call written wrongly is refused before anything is started", async (t) => {
  const it = scene(t, ({ log }) => ({ fake: fakeAgent({ log, says: ["By its name."] }) }));
  assert.equal((await it.tools.agent("x", { agent: "fake" })).text, "By its name.");

  const starts = () => it.sent().filter((message) => message.started).length;
  const before = starts();
  await assert.rejects(it.tools.agent("x", { agent: "claude" }), /No agent is named "claude" in the configuration \("agents"\): it names fake\./);
  await assert.rejects(it.tools.agent("", { agent: "fake" }), /prompt: expected text that is not empty/);
  await assert.rejects(it.tools.agent("x", {}), /agent: expected the name of one in the configuration, or the command that starts one/);
  await assert.rejects(it.tools.agent("x", { agent: { args: ["acp"] } }), /agent: "command" must be a non-empty string/);
  await assert.rejects(it.tools.agent("x", { agent: { command: "a", args: "acp" } }), /agent: "args" must be a list of strings/);
  await assert.rejects(it.tools.agent("x", { agent: { command: "a", env: { A: 1 } } }), /agent: env gives "A" what is not text/);
  await assert.rejects(it.tools.agent("x", { agent: { command: "a", shell: true } }), /agent: "shell" is nothing an agent is started with \(command, args, env\)/);
  for (const timeout of [0, -1, Number.NaN, Infinity]) await assert.rejects(it.tools.agent("x", { agent: "fake", timeout }), /timeout: expected a positive number of milliseconds/);
  assert.equal(starts(), before);

  // The configuration is held to the same, where it is read.
  const home = makeTempDir("trama-outside-home-");
  t.after(() => cleanupTempDir(home));
  const config = (agents) => { writeJson(join(home, ".trama", "config.json"), { agents }); return withEnv({ HOME: home }, async () => loadConfig()); };
  assert.deepEqual((await config({ claude: { command: "npx", args: ["-y", "an-adapter"] } })).agents, { claude: { command: "npx", args: ["-y", "an-adapter"] } });
  await assert.rejects(config({ claude: "npx an-adapter" }), /Invalid config: "agents": claude: expected what starts it — \{ command, args\?, env\? \}/);
  await assert.rejects(config({ claude: { command: "" } }), /Invalid config: "agents": claude: "command" must be a non-empty string/);
  await assert.rejects(config(["claude"]), /Invalid config: "agents" must be an object: each agent by a name, and what starts it/);
});

/** A program that has two agents do something, and says what came of it. */
const ASKS_OUTSIDE = `import { ctx, tools } from "@trama-dev/runtime";
const secret = "s3cret-that-no-journal-keeps";
const done = await tools.agent("Build it.", { agent: "named", system: "Be brief." });
const absent = await tools.agent("Build it.", { agent: { command: "no-such-agent-anywhere", env: { ITS_KEY: secret } }, timeout: 5000 });
let refused = "";
try { await tools.agent("x", { agent: "named", nope: 1 } as any); } catch (err: any) { refused = String(err.message); }
// The first conversation gone on with, and another begun.
const again = await tools.agent("And then?", { agent: "named", session: done.session });
const anew = await tools.agent("Another.", { agent: "named" });
await ctx.done({ done, absent: absent.failure, refused, again, anew });
`;

test("a call to an agent from outside is on record as a tool's is, with what the agent said of itself under it — and what it says it used is not what the run used", async (t) => {
  const projectDir = makeTempDir("trama-outside-run-"), home = makeTempDir("trama-outside-home-"), aside = makeTempDir("trama-outside-aside-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(home); cleanupTempDir(aside); });
  createProjectFixture(projectDir, { programSource: ASKS_OUTSIDE });
  writeJson(join(home, ".trama", "config.json"), { agents: { named: fakeAgent({ log: join(aside, "log"), sessions: join(aside, "sessions"), takes: { resume: true }, tools: 1, asks: ["allow_once"], usage: { cost: 0.33 }, says: ["Built."] }) } });
  const { result } = await withEnv({ HOME: home }, () => captureConsole("warn", () => runProgram({ projectDir, maxRepairAttempts: 0, timeout: 60_000 })));

  assert.equal(result.status, "done", JSON.stringify(result));
  const { done, absent, refused, again, anew } = result.result;
  assert.deepEqual([done.ok, done.text, done.given], [true, "Built. [permission: selected opt-allow_once]", { system: "in-prompt", permissions: { granted: 1, refused: 0 } }]);
  assert.equal(absent.kind, "not-installed");
  assert.match(refused, /Unknown field: nope \(this call takes: prompt, agent, cwd, timeout, system, model, session\)/);

  const dir = join(projectDir, "logs", "journal");
  const text = readFileSync(join(dir, readdirSync(dir).sort().at(-1)), "utf-8"), records = text.trim().split("\n").map((line) => JSON.parse(line));
  const calls = records.filter((record) => record.kind === "call");
  assert.deepEqual(calls.map((call) => call.endpoint), ["/tools/agent", "/tools/agent", "/tools/agent", "/tools/agent", "/tools/agent", "/ctx/done"]);
  assert.deepEqual(calls[0].request, { prompt: "Build it.", agent: "named", system: "Be brief." });
  // (Of the variables an agent is given, the names: a journal is no place for a key.)
  assert.deepEqual(calls[1].request, { prompt: "Build it.", agent: { command: "no-such-agent-anywhere", env: ["ITS_KEY"] }, timeout: 5000 });
  assert.equal(text.includes("s3cret-that-no-journal-keeps"), false);
  const answered = records.filter((record) => record.kind === "result");
  assert.deepEqual([answered[0].ok, answered[0].result.text, answered[1].result.failure.kind, answered[2].ok], [true, done.text, "not-installed", false]);
  // Under the first call, in the order they came: the tool it reported, the permission it was granted, what it said it used.
  const under = records.filter((record) => record.kind.startsWith("outside-"));
  assert.deepEqual(under.filter((record) => record.seq === calls[0].seq).map(({ at: _at, ...record }) => record), [
    { kind: "outside-tool", seq: calls[0].seq, title: "Reading file 1", tool: "read" },
    { kind: "outside-permission", seq: calls[0].seq, for: "Run `make`", answer: "allow_once" },
    { kind: "outside-usage", seq: calls[0].seq, session: done.session, input: 1200, output: 34, total: 1234, cacheRead: 1000, cost: { amount: 0.33, currency: "USD" }, context: { used: 53000, size: 200000 } },
  ]);
  // A cost is said as the protocol has it — what the conversation has cost so far, not the turn: so the record
  // says whose conversation it is, and a conversation gone on with says more each time.
  assert.equal(again.session, done.session);
  assert.notEqual(anew.session, done.session);
  assert.deepEqual(under.filter((record) => record.kind === "outside-usage").map((record) => [record.seq, record.session, record.cost.amount]),
    [[calls[0].seq, done.session, 0.33], [calls[3].seq, done.session, 0.66], [calls[4].seq, anew.session, 0.33]]);
  // Nothing of it is the run's own usage: that is what trama counted, of a model it asked itself.
  assert.equal(records.some((record) => record.kind === "usage"), false);

  const print = () => {
    const shown = [], log = console.log;
    console.log = (line) => shown.push(String(line));
    try { printJournals(projectDir, "outside", {}); } finally { console.log = log; }
    return shown.join("\n");
  };
  const lines = print();
  assert.match(lines, /#1 +tools\/agent +.*Build it\..*ok +\d+ms/);
  assert.match(lines, /#1 +the agent: tool +Reading file 1/);
  assert.match(lines, /#1 +the agent: asked +Run `make` — allow_once/);
  assert.match(lines, /#1 +the agent: it said it used 1234 tokens; its conversation has cost USD 0\.33 so far/);
  assert.match(lines, /#4 +the agent: it said it used 1234 tokens; its conversation has cost USD 0\.66 so far/);
  // In all: the tokens of every turn — and of each conversation what it cost at the last, once. (Two conversations,
  // 66 cents and 33: not the 1.32 that every figure said comes to.)
  assert.match(lines, /end: done +\(outside agents said they used: 3702 tokens, USD 0\.99\)$/m);
  // (A record that does not say whose conversation it is counts by itself: nothing is known to follow it.)
  const path = join(dir, readdirSync(dir).sort().at(-1));
  writeFileSync(path, records.map(({ session: _session, ...record }) => JSON.stringify(record.kind === "outside-usage" ? record : { ...record, ...(_session !== undefined && { session: _session }) })).join("\n") + "\n");
  assert.match(print(), /end: done +\(outside agents said they used: 3702 tokens, USD 1\.32\)$/m);
});

/** A program that cannot do its work without an agent from outside, named in the configuration. */
const NEEDS_OUTSIDE = `import { ctx, tools } from "@trama-dev/runtime";
const done = await tools.agent("Where are you?", { agent: "named" });
if (!done.ok) throw new Error(done.failure!.message);
await ctx.done({ where: done.messages.at(-1) });
`;

test("a program that is being made is validated with its agents from outside called for real, as its shell commands are: in the copy it is tried in, with the configuration's agents", async (t) => {
  const home = makeTempDir("trama-outside-home-"), aside = makeTempDir("trama-outside-aside-");
  t.after(() => { cleanupTempDir(home); cleanupTempDir(aside); });
  const log = join(aside, "log");
  writeJson(join(home, ".trama", "config.json"), { maxRepairAttempts: 0, agents: { named: fakeAgent({ log, says: ["{cwd}"] }) } });
  // (The model that writes the program is a stand-in: it writes this one.)
  const ask = llm.ask;
  llm.ask = async () => NEEDS_OUTSIDE;
  t.after(() => { llm.ask = ask; });
  await withEnv({ HOME: home }, () => captureConsole("log", () => createProject("needs-outside", "Ask an agent where it is.")));

  // It was made: so its validation went through — which it does only with the agent's answer.
  const project = join(home, ".trama", "projects", "needs-outside");
  assert.equal(readFileSync(join(project, "program.ts"), "utf-8").trim(), NEEDS_OUTSIDE.trim());
  // The agent was started, once, and for real — where the program was being tried, which is not the project.
  const started = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((message) => message.started);
  assert.equal(started.length, 1);
  assert.notEqual(started[0].started.cwd, realpathSync(project));
  // And it is on record with the validation, as it is with a run.
  const dir = join(project, "logs", "journal");
  const records = readdirSync(dir).flatMap((file) => readFileSync(join(dir, file), "utf-8").trim().split("\n").map((line) => JSON.parse(line)));
  assert.deepEqual(records.filter((record) => record.kind === "run").map((record) => record.purpose), ["validate"]);
  const call = records.find((record) => record.kind === "call" && record.endpoint === "/tools/agent");
  const answered = records.find((record) => record.kind === "result" && record.seq === call.seq);
  assert.deepEqual([answered.ok, answered.result.ok, answered.result.text], [true, true, started[0].started.cwd]);
  assert.equal(records.filter((record) => record.kind === "outside-usage").length, 1);
});
