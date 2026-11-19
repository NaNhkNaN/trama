import assert from "node:assert/strict";
import test from "node:test";
import { ChildProcess, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { PiAdapter } from "../packages/runtime/dist/pi-adapter.js";
import { CutOff } from "../packages/runtime/dist/agent-backend.js";
import { createMeter } from "../packages/runtime/dist/budget.js";
import { createBackend, runProgram } from "../packages/runtime/dist/runner.js";
import { groupsUnder, processesOnFile } from "../packages/runtime/dist/stopping.js";
import { EXTENSION, hostsHere, user } from "./pi-user.mjs";
import { REPO_ROOT, captureConsole, cleanupTempDir, createProjectFixture, isAlive, makeTempDir, waitFor, withEnv } from "./helpers.mjs";

// A call that has extensions is served by pi in a process of its own. Here that process is real, and so
// is pi; the model is a server in this process, and the user is a directory of the test's. What an
// extension does it does in the host, where this process cannot see it: so it writes it down, with the
// process it did it in.

test("a call that has extensions is served by pi in a process of its own, and one without in this one", async (t) => {
  const it = await user(t, (request, stream, hit) => {
    // The model has the agent use the extension's tool where it has one, then answers.
    const tools = (request.tools ?? []).map((tool) => tool.function.name);
    if (tools.includes("mine_tool") && !request.messages.some((message) => message.role === "tool")) stream.calls("mine_tool");
    else { stream.says({ role: "assistant", content: `answer ${hit}` }); stream.says({}, "stop"); }
    stream.done();
  });
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine"));

  // Without extensions: here. No other process is there, and none was started.
  assert.equal(await it.ask("say hello"), "answer 1");
  assert.deepEqual(it.seen(), []);
  assert.equal(hostsHere(), 0);

  // With them: elsewhere — and what the call used so far, and in the end, is told here as it would be.
  const said = [];
  const total = (usage) => usage.input + usage.output;
  assert.equal(await it.ask("say hello", { extensions: true, sofar: (usage) => said.push(["sofar", total(usage)]), used: (usage) => said.push(["used", total(usage), usage.model]) }), "answer 3");
  assert.deepEqual(said, [["sofar", 1200], ["used", 2400, "fake/plain"]]);
  const [[host, first], [, second]] = it.seen();
  assert.notEqual(host, process.pid);
  assert.deepEqual([first, second], ["mine: a session begins, the project trusted: false", "mine: its tool is used"]);
  assert.match(JSON.stringify(it.requests.at(-1).messages), /the mine tool answers/);

  // The host is kept, and serves the calls that follow one another; calls made together have one each.
  await it.ask("say hello", { extensions: true });
  assert.deepEqual(it.pids(), [host], "one process served both");
  await Promise.all([it.ask("say hello", { extensions: true }), it.ask("say hello", { extensions: true })]);
  const hosts = it.pids();
  assert.equal(hosts.length, 2, `two calls at once were served by two processes: ${hosts}`);
  assert.ok(hosts.every(isAlive));

  // What a call cannot have as it asked comes back as it is — its model not having been asked — and the host that said so serves on.
  const asked = it.requests.length;
  await assert.rejects(() => it.ask("p", { extensions: true, tools: ["nope"] }), { message: 'The agent cannot be given the tools ["nope"]: pi would give it [].' });
  await assert.rejects(() => it.ask("p", { extensions: "all" }), { message: 'extensions is true, false or "project", not "all"' });
  assert.equal(it.requests.length, asked);
  assert.ok(hosts.every(isAlive));
  assert.equal(hostsHere(), 2);

  // When the adapter is done with, so are its hosts: they are gone when it says it is.
  await it.adapter.close();
  assert.deepEqual(hosts.filter(isAlive), []);
  // ...and it can be asked again: it starts one anew.
  assert.match(await it.ask("say hello", { extensions: true }), /^answer/);
  assert.equal(it.pids().length, 3);
});

test("an answer that was cut off comes back from a host as one that was cut off, with what there was of it", async (t) => {
  const it = await user(t, (_request, stream) => {
    stream.says({ role: "assistant", content: "The answer, which is cut at the li" });
    stream.says({}, "length");
    stream.done();
  });
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine"));
  await assert.rejects(() => it.ask("p", { extensions: true }), (err) => err instanceof CutOff && err.text === "The answer, which is cut at the li");
});

test("a host that an extension holds for good is put an end to, and it is one call's failure: this process goes on, and the next call has a host", async (t) => {
  const it = await user(t);
  // A command that goes round for ever, whatever it is told; and a tool the model is never to have answered.
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `pi.registerCommand("spin", { description: "never comes back", handler: async (_args, ctx) => { note("spinning"); for (;;) { try { await ctx.waitForIdle(); } catch {} } } });`));

  let beats = 0;
  const heart = setInterval(() => { beats += 1; }, 50);
  t.after(() => clearInterval(heart));
  const stop = new AbortController();
  const call = it.ask("/spin", { extensions: true, signal: stop.signal });
  call.catch(() => {});
  await waitFor(() => it.seen().some(([, what]) => what === "spinning"), "the command to begin");
  const [host] = it.pids();
  const before = beats, started = Date.now();
  stop.abort();
  await assert.rejects(call, /Aborted/);
  const waited = Date.now() - started;
  assert.ok(waited >= 4_500 && waited < 9_000, `the host was given the time anything asked to stop is given: ${waited}ms`);
  assert.ok(beats - before > 40, `this process went on meanwhile: ${beats - before} beats`);
  await waitFor(() => !isAlive(host), "the host to be gone");

  assert.equal(await it.ask("say hello", { extensions: true }), "hello from the fake");
  assert.notEqual(it.pids().at(-1), host);
});

test("a host that ends by itself fails the call it was serving, and no more: what an extension left behind ends its own process", async (t) => {
  const it = await user(t, (request, stream) => {
    const tools = (request.tools ?? []).map((tool) => tool.function.name);
    if (JSON.stringify(request.messages.at(-1)).includes("use the die tool") && tools.includes("die")) stream.calls("die");
    else { stream.says({ role: "assistant", content: "hello from the fake" }); stream.says({}, "stop"); }
    stream.done();
  });
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `
  pi.registerTool({ name: "die", label: "die", description: "Ends the process it is in", parameters: { type: "object", properties: {} }, async execute() { process.exit(3); } });
  pi.registerCommand("leave-work", { description: "starts what it does not wait for", handler: async () => { note("left work behind"); setTimeout(() => { throw new Error("thrown where nobody catches it"); }, 150); } });`));

  // In the middle of a call: the call fails, saying how.
  await assert.rejects(() => it.ask("use the die tool", { extensions: true }), { message: "The agent's process ended before it had answered (exit code 3): the call was not finished." });
  const [first] = it.pids();
  await waitFor(() => !isAlive(first), "the first host to be gone");

  // After a call: the call was answered (here, that its command took the prompt), and the process that was kept for the next ends alone.
  const { messages } = await captureConsole("warn", async () => {
    await assert.rejects(() => it.ask("/leave-work", { extensions: true }), /The prompt was taken by an extension/);
    const second = it.pids().at(-1);
    assert.notEqual(second, first);
    await waitFor(() => !isAlive(second), "the host an extension's leftover work ended to be gone");
    // The next call finds no host, and starts one.
    assert.equal(await it.ask("say hello", { extensions: true }), "hello from the fake");
    assert.equal(it.pids().length, 3);
  });
  assert.deepEqual(messages, [], "nothing of it is this process's to say");
});

test("the project's own extensions are a call's where it says so: then the project is one to be trusted, and its code runs in the host", async (t) => {
  const it = await user(t);
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine"));
  it.put(it.cwd, ".pi/extensions/theirs.ts", EXTENSION("theirs", `pi.registerCommand("theirs", { description: "a command of the project's", handler: async () => { note("theirs: its command is run"); } });`));

  await it.ask("say hello", { extensions: true });
  assert.deepEqual(it.toolsOf(it.requests.at(-1)), ["read", "bash", "edit", "write", "mine_tool"]);
  assert.deepEqual(it.seen().map(([, what]) => what), ["mine: a session begins, the project trusted: false"]);

  await it.ask("say hello", { extensions: "project" });
  assert.deepEqual(it.toolsOf(it.requests.at(-1)).sort(), ["bash", "edit", "mine_tool", "read", "theirs_tool", "write"]);
  assert.deepEqual(it.seen().slice(1).map(([, what]) => what).sort(), ["mine: a session begins, the project trusted: true", "theirs: a session begins, the project trusted: true"]);
  assert.ok(it.seen().every(([pid]) => pid !== process.pid), "none of it ran in this process");

  // Without extensions, and with the user's alone, the project's are not loaded — nor is anything of them in this process.
  await it.ask("say hello");
  assert.deepEqual(it.toolsOf(it.requests.at(-1)), ["read", "bash", "edit", "write"]);
  assert.equal(it.seen().length, 3);

  // A prompt can begin with a command of the project's, as with one of the user's.
  const before = it.requests.length;
  await assert.rejects(() => it.ask("/theirs", { extensions: "project" }), /The prompt was taken by an extension/);
  assert.equal(it.seen().at(-1)[1], "theirs: its command is run");
  // (Its model never asked, the call is not looked at for the tools it named: they are an agent's, and none was run.)
  await assert.rejects(() => it.ask("/theirs", { extensions: "project", tools: ["nope"] }), /The prompt was taken by an extension/);
  assert.equal(it.requests.length, before);
});

test("a call that has extensions has pi's own among them: an MCP server of the user's is started, its tool is the agent's and can be named, and it ends with its call", async (t) => {
  const it = await user(t, (request, stream) => {
    const tool = (request.tools ?? []).map((entry) => entry.function.name).find((name) => name.startsWith("mcp__"));
    if (tool && !request.messages.some((message) => message.role === "tool")) stream.calls(tool, { text: "are you there" });
    else { stream.says({ role: "assistant", content: "hello from the fake" }); stream.says({}, "stop"); }
    stream.done();
  });
  // The least an MCP server can be, over stdio: one tool. It writes down that it is there.
  it.put(it.agentDir, "mini-server.mjs", `import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
appendFileSync(process.env.TRAMA_TEST_SEEN, process.pid + " the MCP server is started\\n");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const { id, method, params } = request;
  if (method === "initialize") return send({ id, result: { protocolVersion: params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "mini", version: "0.0.1" } } });
  if (method === "tools/list") return send({ id, result: { tools: [{ name: "echo", description: "Says back what it is given.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } });
  if (method === "tools/call") return send({ id, result: { content: [{ type: "text", text: "the mini server heard: " + params?.arguments?.text }] } });
  if (id !== undefined) send({ id, result: {} });
});
`);
  it.put(it.agentDir, "mcp.json", JSON.stringify({ mcpServers: { mini: { command: process.execPath, args: [join(it.agentDir, "mini-server.mjs")], exposure: "direct" } } }));

  // Without extensions nothing of it is there; with them the server's tool is among the agent's, and is used.
  await it.ask("say hello");
  assert.deepEqual(it.toolsOf(it.requests.at(-1)), ["read", "bash", "edit", "write"]);
  assert.deepEqual(it.seen(), []);
  assert.equal(await it.ask("say hello", { extensions: true }), "hello from the fake");
  assert.deepEqual(it.toolsOf(it.requests.at(-1)), ["read", "bash", "edit", "write", "mcp__mini__echo"]);
  assert.match(JSON.stringify(it.requests.at(-1).messages), /the mini server heard: are you there/);
  const started = () => it.seen().filter(([, what]) => what === "the MCP server is started").map(([pid]) => pid);
  assert.equal(started().length, 1);

  // A call can name the server's tool among those its agent is to have: it is the agent's by the time its model is asked.
  assert.equal(await it.ask("say hello", { extensions: true, tools: ["read", "mcp__mini__echo"] }), "hello from the fake");
  assert.deepEqual(it.toolsOf(it.requests.at(-1)), ["read", "mcp__mini__echo"]);
  // ...and one that names a tool nobody has fails as any does, its model not asked.
  const asked = it.requests.length;
  await assert.rejects(() => it.ask("say hello", { extensions: true, tools: ["read", "mcp__mini__nope"] }), { message: 'The agent cannot be given the tools ["read","mcp__mini__nope"]: pi would give it ["read"].' });
  assert.equal(it.requests.length, asked);

  // The server is its session's: pi starts it for a call that has it, and it is gone when the call is over.
  assert.equal(started().length, 3);
  await waitFor(() => !started().some(isAlive), "the MCP servers to be gone");
});

test("a run's calls with extensions are served by hosts of the run's, held to its budget, and gone when it is over", async (t) => {
  const it = await user(t, (request, stream) => {
    // A model that has the agent read a file, twice, before it answers.
    const read = request.messages.filter((message) => message.role === "tool").length;
    if (read < 2 && (request.tools ?? []).some((tool) => tool.function.name === "read")) stream.calls("read", { path: "a.txt" });
    else { stream.says({ role: "assistant", content: "hello from the fake" }); stream.says({}, "stop"); }
    stream.done();
  });
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine"));
  const projectDir = makeTempDir("trama-host-project-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    metaInput: { prompt: "p", args: {} },
    programSource: `import { ctx, agent } from "@trama-dev/runtime";
const told = (err: any) => String(err.message);
const first = await agent.instruct("read a.txt, twice", { extensions: true }).catch(told);
const second = await agent.instruct("say hello", { extensions: true, tools: [] }).catch(told);
const odd = await agent.instruct("say hello", { extensions: "all" } as any).catch(told);
await ctx.done({ first, second, odd });
`,
  });
  // (The project names its model as the user's pi knows it.)
  const meta = JSON.parse(readFileSync(join(projectDir, "meta.json"), "utf-8"));
  writeFileSync(join(projectDir, "meta.json"), JSON.stringify({ ...meta, provider: "fake", model: "plain" }));
  writeFileSync(join(projectDir, "a.txt"), "what the file says");

  const run = (budget) => withEnv(it.env, () => captureConsole("warn", () => runProgram({ projectDir, budget, maxRepairAttempts: 0, timeout: 60_000 })));
  const free = await run(undefined);
  assert.deepEqual(free.result.result, {
    first: "hello from the fake",
    second: "hello from the fake",
    odd: 'trama runtime error: Error: extensions is true, false or "project", not "all"',
  });
  const hosts = it.pids();
  assert.ok(hosts.length >= 1 && hosts.every((pid) => pid !== process.pid));
  await waitFor(() => !hosts.some(isAlive), "the run's hosts to be gone, the run being over");

  // Under a budget the call is stopped where its agent would ask the model again — in its host, and by word from here.
  const before = it.requests.length;
  const held = await run({ tokens: 2000 });
  assert.equal(held.result.result.first, "trama runtime error: Error: The budget is spent: 2400 tokens used of 2000.");
  assert.equal(it.requests.length, before + 2, "the third request was not made");
  assert.deepEqual(held.messages, ["[trama] The budget is spent: 2400 tokens used of 2000."]);
});

test("the hosts of a runner that dies do not outlive it — nor does what they had started, whether or not they can hear that it is gone", async (t) => {
  // A host that waits hears that its runner is gone, and takes what it started with it; one that cannot hear anything
  // is ended all the same — and what it started with it, by whoever watches for the runner.
  const starts = `const { spawn } = await import("node:child_process"); note("started " + spawn("sleep", ["300"], { detached: true, stdio: "ignore" }).pid);`;
  const stays = {
    waiting: `${starts} await new Promise(() => {});`,
    frozen: `${starts} for (;;) {}`,
  };
  for (const [how, body] of Object.entries(stays)) {
    const it = await user(t);
    it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `pi.registerCommand("stay", { description: "never comes back", handler: async () => { ${body} } });`));
    const script = `import { PiAdapter } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, "packages", "runtime", "dist", "pi-adapter.js")).href)};
await new PiAdapter({ provider: "fake", model: "plain" }).ask("/stay", { cwd: ${JSON.stringify(it.cwd)}, extensions: true });
`;
    const runner = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, ...it.env }, stdio: "ignore" });
    await waitFor(() => it.seen().length > 1, `${how}: the host to be serving`, 30_000);
    const [host] = it.pids();
    const started = it.seen().flatMap(([, what]) => (what.startsWith("started ") ? [Number(what.slice(8))] : []));
    assert.ok(isAlive(host) && started.every(isAlive), how);
    assert.equal(started.length, 1);
    runner.kill("SIGKILL");
    await waitFor(() => !isAlive(host), `${how}: the host of a runner that was killed to be gone`, 15_000);
    await waitFor(() => !started.some(isAlive), `${how}: what the host started to be gone`);
    assert.equal(existsSync(it.cwd), true);
  }
});

test("a backend that is closed ends its hosts, and one that never had a call with extensions has none to end", async (t) => {
  const it = await user(t);
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine"));
  await withEnv(it.env, async () => {
    const backend = createBackend({ provider: "fake", model: "plain" }, createMeter({ calls: 3 }));
    assert.equal(await backend.ask("say hello", { cwd: it.cwd }), "hello from the fake");
    await backend.close();
    assert.deepEqual(it.pids(), []);
    assert.equal(await backend.ask("say hello", { cwd: it.cwd, extensions: true }), "hello from the fake");
    const [host] = it.pids();
    assert.ok(isAlive(host));
    await backend.close();
    await waitFor(() => !isAlive(host), "the backend's host to be gone");
    // (A call counts in the budget whichever process serves it.)
    assert.equal(await backend.ask("say hello", { cwd: it.cwd, extensions: true }), "hello from the fake");
    await assert.rejects(() => backend.ask("say hello", { cwd: it.cwd, extensions: true }), /The budget is spent: 3 of 3 calls/);
    await backend.close();
  });
});

test("what is written on a host's channel that is no word of a host's is passed over", async (t) => {
  const it = await user(t);
  // An extension that says things to whatever started its process — as many a library does, and as one may that means to.
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `pi.on("session_start", async () => {
    for (const word of ["ready", 7, true, [], { sofar: "much" }, { used: 12 }, { answer: 5 }, { error: null }, { nothing: "of the kind" }]) process.send?.(word);
    try { process.send?.(null); } catch {}
    note("said its piece");
  });`));
  const said = [];
  assert.equal(await it.ask("say hello", { extensions: true, sofar: (usage) => said.push(["sofar", usage]), used: (usage) => said.push(["used", usage.input + usage.output]) }), "hello from the fake");
  assert.equal(it.seen().at(-1)[1], "said its piece");
  assert.deepEqual(said, [["used", 1200]]);
  const [host] = it.pids();
  assert.equal(await it.ask("say hello", { extensions: true }), "hello from the fake");
  assert.deepEqual(it.pids(), [host], "and its host serves on");
});

test("a call that is cancelled lets go of its host, which serves the next; and one whose host is done with under it has failed", async (t) => {
  let hold = true;
  const waiting = [];
  const it = await user(t, (request, stream) => {
    // (Asked to read first, the model has the agent read a file before it answers; asked to wait first, run a command that takes long.)
    const asked = JSON.stringify(request.messages), first = !request.messages.some((message) => message.role === "tool");
    if (first && asked.includes("read first")) {
      stream.calls("read", { path: "a.txt" });
      return stream.done();
    }
    if (first && asked.includes("wait first")) {
      stream.calls("bash", { command: "sleep 30" });
      return stream.done();
    }
    const answer = () => { stream.says({ role: "assistant", content: "hello from the fake" }); stream.says({}, "stop"); stream.done(); };
    if (hold) waiting.push(answer); else answer();
  });
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `pi.on("tool_execution_start", async (event) => { note("begins to use " + event.toolName); });`));

  // Cancelled while whoever hears what it has used so far has yet to say it may go on: the host does not wait for that word any more.
  {
    const stop = new AbortController();
    let heard;
    const told = new Promise((resolve) => { heard = resolve; });
    const call = it.ask("read first, then say hello", { extensions: true, signal: stop.signal, sofar: () => { heard(); return new Promise(() => {}); } });
    call.catch(() => {});
    await told;
    const started = Date.now();
    stop.abort();
    await assert.rejects(call, /Aborted/);
    assert.ok(Date.now() - started < 2_000, `it was let go of at once: ${Date.now() - started}ms`);
    assert.equal(it.requests.length, 1, "and its model was not asked again");
  }

  // Cancelled while its model is answering: the host is told, pi lets go of the request, and the host is free.
  const stop = new AbortController();
  const cancelled = it.ask("say hello", { extensions: true, signal: stop.signal });
  cancelled.catch(() => {});
  await waitFor(() => waiting.length === 1, "the model to be asked");
  const started = Date.now();
  stop.abort();
  await assert.rejects(cancelled, /Aborted/);
  assert.ok(Date.now() - started < 2_500, `it did not take the time a host is given before it is ended: ${Date.now() - started}ms`);
  const [host] = it.pids();
  assert.equal(it.pids().length, 1, "one process served both calls so far");
  hold = false;
  assert.equal(await it.ask("say hello", { extensions: true }), "hello from the fake");
  assert.deepEqual(it.pids(), [host], "the same process served the next call");

  // Done with while a call is in it: the call fails, saying how its process ended, and the process is gone when the adapter says it is done.
  hold = true;
  const lost = it.ask("say hello", { extensions: true });
  lost.catch(() => {});
  await waitFor(() => waiting.length === 2, "the model to be asked again");
  await it.adapter.close();
  assert.equal(isAlive(host), false);
  await assert.rejects(lost, { message: "The agent's process ended before it had answered (SIGTERM): the call was not finished." });

  // ...and so has one whose agent was running a command: the command is ended with the process, and the call does not go on
  // from there — its model is not asked what to make of that, and it does not answer.
  hold = false;
  const said = [], before = it.requests.length;
  const working = it.ask("wait first, then say hello", { extensions: true, used: (usage) => said.push(usage.input + usage.output) });
  working.catch(() => {});
  await waitFor(() => it.seen().some(([, what]) => what === "begins to use bash"), "the command to be running");
  await it.adapter.close();
  await assert.rejects(working, { message: "The agent's process ended before it had answered (SIGTERM): the call was not finished." });
  assert.deepEqual(said, [1200]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(it.requests.length, before + 1, "the model was asked the once");

  // A host that somebody else has asked to end, while it was free, serves nothing more: a call handed to it
  // as it goes fails as one whose process ended, and the next has another. (Where the system is asked what
  // is under a process by `ps`, the host is given one slow to answer, so that it is a while in going and the
  // call is surely handed to it; where the system says it in files, the host is gone in a moment, and the call
  // may find it gone already: it is then served by another, which is as it should be.)
  const bin = makeTempDir("trama-host-bin-");
  t.after(() => cleanupTempDir(bin));
  writeFileSync(join(bin, "ps"), "#!/bin/sh\nexec /bin/sleep 1\n");
  chmodSync(join(bin, "ps"), 0o755);
  const lingers = processesOnFile(fs, process.pid, process.ppid).length === 0;
  const ended = "The agent's process ended before it had answered (SIGTERM): the call was not finished.";
  assert.equal(await withEnv({ PATH: `${bin}:${process.env.PATH}` }, () => it.ask("say hello", { extensions: true })), "hello from the fake");
  const going = it.pids().at(-1), asked = it.requests.length;
  process.kill(going, "SIGTERM");
  if (lingers) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(isAlive(going), "it is still going");
  }
  const handed = await it.ask("say hello", { extensions: true }).then(() => "served", (err) => err.message);
  if (lingers) assert.equal(handed, ended);
  // Whichever way it went: the host that was going asked no model, and a call that was served was served by another.
  if (handed === "served") assert.deepEqual([it.requests.length, it.pids().at(-1) !== going], [asked + 1, true]);
  else assert.deepEqual([handed, it.requests.length], [ended, asked]);
  assert.equal(await it.ask("say hello", { extensions: true }), "hello from the fake");
  assert.notEqual(it.pids().at(-1), going);
});

test("what a call had used is counted where its host has to be ended, or gives the call up itself", async (t) => {
  const it = await user(t, (request, stream) => {
    const tools = (request.tools ?? []).map((tool) => tool.function.name);
    if (JSON.stringify(request.messages.at(-1)).includes("use the freeze tool") && tools.includes("freeze")) stream.calls("freeze");
    else { stream.says({ role: "assistant", content: "hello from the fake" }); stream.says({}, "stop"); }
    stream.done();
  });
  // A tool that stops its whole process, having started something that would outlive it; and a session whose end
  // is not heard out — or stops the process — as the test says at the time.
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `
  pi.registerTool({ name: "freeze", label: "freeze", description: "Stops the process it is in", parameters: { type: "object", properties: {} }, async execute() {
    const { spawn } = await import("node:child_process");
    note("started " + spawn("sleep", ["300"], { detached: true, stdio: "ignore" }).pid);
    for (;;) {}
  } });
  const told = () => { try { return readFileSync(process.env.TRAMA_TEST_SEEN + ".mode", "utf-8"); } catch { return ""; } };
  pi.on("message_end", (event) => { if (told() === "freeze" && event.message.role === "assistant") { note("frozen"); for (;;) {} } });
  pi.on("agent_end", () => { if (told().startsWith("hold")) { note("held"); return new Promise(() => {}); } });
  pi.on("session_shutdown", () => (told() === "hold, and its end too" ? new Promise(() => {}) : undefined));`));
  const total = (usage) => usage.input + usage.output;
  const tell = (how) => writeFileSync(join(it.agentDir, "seen.log.mode"), how);
  /** A call that is cancelled once the extension has written `mark` down: what it said it used, how long it took to fail, and the process it was in. */
  const cancelledAt = async (prompt, mark) => {
    const said = [], stop = new AbortController(), before = it.seen().length;
    const call = it.ask(prompt, { extensions: true, signal: stop.signal, used: (usage) => said.push(total(usage)) });
    call.catch(() => {});
    await waitFor(() => it.seen().slice(before).some(([, what]) => what.startsWith(mark)), `"${mark}" to be written down`);
    const [host, what] = it.seen().at(-1);
    const started = Date.now();
    stop.abort();
    await assert.rejects(call, /Aborted/);
    return { said, waited: Date.now() - started, host, what };
  };

  // The process stopped: nothing in it can say anything any more. It is ended when the time is up, with what it
  // started — and the call is taken to have used what it had last said it had: its model's one reply.
  {
    const { said, waited, host, what } = await cancelledAt("use the freeze tool", "started ");
    const sleeper = Number(what.slice(8));
    assert.ok(waited >= 4_500, `the host was given its time: ${waited}ms`);
    assert.deepEqual(said, [1200]);
    await waitFor(() => !isAlive(host) && !isAlive(sleeper), "the host, and what it started in a group of its own, to be gone");
  }

  // ...as it is where an extension stopped the process as it heard of the reply: before pi had put the reply on record.
  {
    tell("freeze");
    const { said, waited, host } = await cancelledAt("say hello", "frozen");
    assert.ok(waited >= 4_500, `the host was given its time: ${waited}ms`);
    assert.deepEqual(said, [1200]);
    await waitFor(() => !isAlive(host), "the host to be gone");
  }

  // The call held, its process well: the host gives the call up before its runner would end it, says what the
  // call used, and serves on.
  {
    tell("hold");
    const { said, waited, host } = await cancelledAt("say hello", "held");
    assert.ok(waited >= 2_500 && waited < 4_500, `the host gave it up itself: ${waited}ms`);
    assert.deepEqual(said, [1200]);
    assert.ok(isAlive(host));
    tell("");
    assert.equal(await it.ask("say hello", { extensions: true }), "hello from the fake");
    assert.equal(it.pids().at(-1), host, "the same process served the next call");
  }

  // The call held, and the session's end after it: the host has said what the call used by the time it is ended, and that is said once.
  {
    tell("hold, and its end too");
    const { said, waited, host } = await cancelledAt("say hello", "held");
    assert.ok(waited >= 4_500, `the host was given its time: ${waited}ms`);
    assert.deepEqual(said, [1200]);
    await waitFor(() => !isAlive(host), "the host to be gone");
    tell("");
  }
});

test("what a process has under it in groups of their own is found by asking the system — which does not hold whoever asks", async (t) => {
  const kept = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  t.after(() => kept.kill("SIGKILL"));
  const beside = spawn("sleep", ["300"], { stdio: "ignore" });
  t.after(() => beside.kill("SIGKILL"));
  // What leads a group of its own is found; what is in this process's group is not another's to stop, nor is this process.
  const found = await groupsUnder(process.pid);
  assert.ok(found.includes(kept.pid), `${found} has ${kept.pid}`);
  const mine = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf-8" }));
  assert.ok(!found.includes(beside.pid) && !found.includes(process.pid) && !found.includes(mine), `${found} has not ${mine}`);
  assert.deepEqual(await groupsUnder(kept.pid), [], "nothing is under what has started nothing");

  const bin = makeTempDir("trama-host-bin-");
  t.after(() => cleanupTempDir(bin));
  writeFileSync(join(bin, "ps"), "#!/bin/sh\nexec /bin/sleep 30\n");
  chmodSync(join(bin, "ps"), 0o755);
  if (processesOnFile(fs, process.pid, process.ppid).length > 0) {
    // Where the system says it in files, nothing is started to learn it: a `ps` that does not answer, or none at all, is all one.
    const started = Date.now();
    assert.ok((await withEnv({ PATH: bin }, () => groupsUnder(process.pid))).includes(kept.pid));
    assert.ok((await withEnv({ PATH: join(bin, "none") }, () => groupsUnder(process.pid))).includes(kept.pid));
    assert.ok(Date.now() - started < 1_500, `nothing was waited for: ${Date.now() - started}ms`);
    return;
  }
  // Where it has to be asked: a system that does not answer is not waited for long, and nothing else waits for it at all.
  let beats = 0;
  const heart = setInterval(() => { beats += 1; }, 50);
  t.after(() => clearInterval(heart));
  const started = Date.now();
  assert.deepEqual(await withEnv({ PATH: bin }, () => groupsUnder(process.pid)), []);
  const waited = Date.now() - started;
  assert.ok(waited >= 1_500 && waited < 4_000, `it was given a while, and no more: ${waited}ms`);
  assert.ok(beats > 20, `this process went on meanwhile: ${beats} beats`);
  // ...and one that cannot be asked says nothing.
  assert.deepEqual(await withEnv({ PATH: join(bin, "none") }, () => groupsUnder(process.pid)), []);
});

test("what the system says of its processes in files is read as it is written, whatever a process is called", () => {
  const files = {
    "/proc/1/stat": "1 (init) S 0 1 1 0 -1 4194560 1 2 3",
    // A name is the program's to choose: spaces, brackets, and what looks like the rest of the line.
    "/proc/42/stat": "42 (a) name (S 7 7) R 1 40 40 0 -1 4194304",
    "/proc/43/stat": "43 (sleep) S 42 43 40 0 -1",
    "/proc/88/stat": "88 (odd) S not numbers",
  };
  const said = {
    readdirSync: (dir) => { assert.equal(dir, "/proc"); return ["1", "42", "43", "77", "88", "self", "sys", "4x"]; },
    // (77 was there when the directory was listed, and is gone.)
    readFileSync: (path) => { if (!(path in files)) throw new Error("ENOENT"); return files[path]; },
  };
  assert.deepEqual(processesOnFile(said, 43, 42), [[1, 0, 1], [42, 1, 40], [43, 42, 43]]);
  assert.deepEqual(processesOnFile({ readdirSync: () => { throw new Error("ENOENT"); }, readFileSync: () => "" }, 43, 42), [], "where there are no such files");
  // Files that do not say of whoever asks what it knows of itself are another's: nothing in them is taken.
  assert.deepEqual(processesOnFile(said, 43, 1), [], "whose child it is");
  assert.deepEqual(processesOnFile(said, 44, 42), [], "that it is there");
});

test("a call that cannot have the tools it named fails with that, whatever an extension does to set its session going again or to hold it", async (t) => {
  const it = await user(t);
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `pi.on("agent_end", async () => { note("puts another question"); pi.sendUserMessage("go on"); });`));
  await assert.rejects(() => it.ask("say hello", { extensions: true, tools: ["read", "nope"] }), { message: 'The agent cannot be given the tools ["read","nope"]: pi would give it ["read"].' });
  assert.ok(it.seen().some(([, what]) => what === "puts another question"), "the extension did set it going again");
  assert.equal(it.requests.length, 0, "and the model was not asked");
  // ...or to keep it from ending: what holds it is not waited for long, and the call fails with what was wrong with it.
  {
    const held = await user(t);
    held.put(held.agentDir, "extensions/mine.ts", EXTENSION("mine", `pi.on("agent_end", () => { note("holds the end"); return new Promise(() => {}); });`));
    await assert.rejects(() => held.ask("say hello", { extensions: true, tools: ["read", "nope"] }), { message: 'The agent cannot be given the tools ["read","nope"]: pi would give it ["read"].' });
    assert.ok(held.seen().some(([, what]) => what === "holds the end"));
    assert.equal(held.requests.length, 0);
  }

  // The host that refused it serves on. (Elsewhere: an extension is read once for where a call works, whatever is written there after.)
  const [host] = it.pids(), elsewhere = makeTempDir("trama-host-other-");
  t.after(() => cleanupTempDir(elsewhere));
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine"));
  assert.equal(await it.ask("say hello", { extensions: true, cwd: elsewhere }), "hello from the fake");
  assert.deepEqual(it.pids(), [host]);
});

test("the calls of a run that was given variables are served with them, in a process of their own — and are otherwise what they would be", async (t) => {
  const it = await user(t, (request, stream) => {
    // Asked what it was given, the model has the agent say so with a command; asked to read first, read a file, twice.
    const asked = JSON.stringify(request.messages), results = request.messages.filter((message) => message.role === "tool").length;
    if (asked.includes("what were you given") && results === 0) stream.calls("bash", { command: 'echo "given: [$TRAMA_TEST_GIVEN]"' });
    else if (asked.includes("read first") && results < 2) stream.calls("read", { path: "a.txt" });
    else { stream.says({ role: "assistant", content: "hello from the fake" }); stream.says({}, "stop"); }
    stream.done();
  });
  const config = { provider: "fake", model: "plain" }, given = { TRAMA_TEST_GIVEN: "a run's own" };
  const theirs = new PiAdapter(config, given), none = new PiAdapter(config, {});
  t.after(() => Promise.all([theirs.close(), none.close()]));
  const told = () => JSON.stringify(it.requests.at(-1).messages.filter((message) => message.role === "tool"));

  await withEnv(it.env, async () => {
    // Without variables — or with an object of none — a call is served here, and its agent's commands have this process's.
    assert.equal(await it.ask("what were you given"), "hello from the fake");
    assert.match(told(), /given: \[\]/);
    assert.equal(await none.ask("what were you given", { cwd: it.cwd }), "hello from the fake");
    assert.match(told(), /given: \[\]/);
    assert.equal(hostsHere(), 0);

    // With them: in a process that was started with them — the agent's commands have them — and this process has not.
    const said = [];
    assert.equal(await theirs.ask("what were you given", { cwd: it.cwd, used: (usage) => said.push(usage.input + usage.output) }), "hello from the fake");
    assert.match(told(), /given: \[a run's own\]/);
    assert.deepEqual(said, [2400]);
    assert.equal(hostsHere(), 1);
    assert.equal(process.env.TRAMA_TEST_GIVEN, undefined);

    // What the model is sent is what it is sent where the call is served here: the process is all that differs.
    // (The user has an extension and an MCP server by now: a call that asks for no extensions has neither, wherever it is served.)
    it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine", `pi.on("session_start", async () => { note("given " + process.env.TRAMA_TEST_GIVEN); });`));
    it.put(it.agentDir, "mcp.json", JSON.stringify({ mcpServers: { quiet: { command: process.execPath, args: ["-e", "setInterval(() => {}, 1e9)"] } } }));
    await it.ask("say hello", { system: "Be brief." });
    const here = it.requests.at(-1);
    await theirs.ask("say hello", { cwd: it.cwd, system: "Be brief." });
    assert.deepEqual(it.requests.at(-1), here);
    assert.equal(hostsHere(), 1, "the one process served both");
    assert.deepEqual(it.seen(), [], "and no extension was told of either");

    // A call that cannot be had as it was asked fails as it does here, and so does one with extensions — which has the variables too.
    await assert.rejects(() => theirs.ask("p", { cwd: it.cwd, tools: ["nope"] }), { message: 'The agent cannot be given the tools ["nope"]: pi would give it [].' });
    await theirs.ask("say hello", { cwd: it.cwd, extensions: true });
    assert.equal(it.seen().at(-1)[1], "given a run's own");
    assert.ok(it.toolsOf(it.requests.at(-1)).includes("mine_tool"));

    // Variables no process can be started with are the call's failure, said as any failure to start is.
    const tooMuch = new PiAdapter(config, { TRAMA_TEST_GIVEN: "x".repeat(8 * 1024 * 1024) });
    t.after(() => tooMuch.close());
    await assert.rejects(() => tooMuch.ask("say hello", { cwd: it.cwd }), /^Error: The agent's process could not be started: /);

    // And a budget holds such a call where it holds any: its agent is stopped where it would ask its model again.
    const backend = createBackend(config, createMeter({ tokens: 2000 }), () => {}, given);
    t.after(() => backend.close());
    const before = it.requests.length;
    await assert.rejects(() => backend.ask("read first, then say hello", { cwd: it.cwd }), /The budget is spent: 2400 tokens used of 2000/);
    assert.equal(it.requests.length, before + 2, "the third request was not made");

    // ...because the model is not asked again before whoever counts has heard what the call used, however long that takes them.
    const stop = new AbortController(), asked = it.requests.length;
    const slow = theirs.ask("read first, then say hello", {
      cwd: it.cwd, signal: stop.signal,
      sofar: () => new Promise((resolve) => setTimeout(resolve, 400)).then(() => stop.abort()),
    });
    await assert.rejects(slow, /Aborted/);
    assert.equal(it.requests.length, asked + 1, "the model was asked the once");
  });
});

test("a run's variables are its agents': a program's call is served with what its run was given", async (t) => {
  const it = await user(t, (request, stream) => {
    if (!request.messages.some((message) => message.role === "tool")) stream.calls("bash", { command: 'echo "given: [$TRAMA_TEST_GIVEN]"' });
    else { stream.says({ role: "assistant", content: "hello from the fake" }); stream.says({}, "stop"); }
    stream.done();
  });
  const projectDir = makeTempDir("trama-host-project-");
  t.after(() => cleanupTempDir(projectDir));
  createProjectFixture(projectDir, {
    metaInput: { prompt: "p", args: {} },
    programSource: `import { ctx, agent } from "@trama-dev/runtime";
await ctx.done({ answer: await agent.instruct("what were you given") });
`,
  });
  const meta = JSON.parse(readFileSync(join(projectDir, "meta.json"), "utf-8"));
  writeFileSync(join(projectDir, "meta.json"), JSON.stringify({ ...meta, provider: "fake", model: "plain" }));
  const told = () => JSON.stringify(it.requests.at(-1).messages.filter((message) => message.role === "tool"));

  const run = (env) => withEnv(it.env, () => captureConsole("warn", () => runProgram({ projectDir, env, maxRepairAttempts: 0, timeout: 60_000 })));
  assert.deepEqual((await run(undefined)).result.result, { answer: "hello from the fake" });
  assert.match(told(), /given: \[\]/);
  assert.deepEqual((await run({ TRAMA_TEST_GIVEN: "the run's" })).result.result, { answer: "hello from the fake" });
  assert.match(told(), /given: \[the run's\]/);
  assert.equal(hostsHere(), 0, "the run being over, its process is gone");
});

test("a process that waits for its hosts to be gone is held until they are: what comes after the wait comes", async (t) => {
  // A host that is free keeps nobody waiting. One that is being ended is waited for — and whoever waits may have
  // nothing else to wait for: the trama command at the end of a run. A process that nothing holds ends, well and
  // without a word, though something in it is waited for; and of a host that is ending, the system says for a
  // moment that it is not there before it says that it has ended. In that moment the wait is all that is left.
  const it = await user(t);
  it.put(it.agentDir, "extensions/mine.ts", EXTENSION("mine"));

  // So: a host is held from when it is to be ended, whatever it was before.
  const held = [];
  const { ref, unref } = ChildProcess.prototype;
  ChildProcess.prototype.ref = function () { held.push([this.pid, "held"]); return ref.call(this); };
  ChildProcess.prototype.unref = function () { held.push([this.pid, "let go"]); return unref.call(this); };
  t.after(() => Object.assign(ChildProcess.prototype, { ref, unref }));
  assert.equal(await it.ask("say hello", { extensions: true }), "hello from the fake");
  const [host] = it.pids();
  const of = () => held.filter(([pid]) => pid === host).map(([, what]) => what);
  assert.equal(of().at(-1), "let go");
  await it.adapter.close();
  assert.equal(of().at(-1), "held");
  assert.equal(isAlive(host), false);

  // And a process of its own, with nothing but that wait, comes to what is after it. (Where the moment is one the
  // system has, it is not every time that it is come upon: this says that it goes well, the lines above why.)
  const script = `import { PiAdapter } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, "packages", "runtime", "dist", "pi-adapter.js")).href)};
const adapter = new PiAdapter({ provider: "fake", model: "plain" });
console.log(await adapter.ask("say hello", { cwd: ${JSON.stringify(it.cwd)}, extensions: true }));
await adapter.close();
console.log("closed");
process.exitCode = 7;
`;
  for (let round = 0; round < 3; round += 1) {
    const runner = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, ...it.env }, stdio: ["ignore", "pipe", "inherit"] });
    let said = "";
    runner.stdout.on("data", (chunk) => { said += chunk; });
    const code = await new Promise((resolve) => runner.once("close", resolve));
    assert.equal(said, "hello from the fake\nclosed\n");
    assert.equal(code, 7);
  }
});
