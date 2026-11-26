// An agent that speaks the Agent Client Protocol on its stdio, version 1, by lines of JSON — and does as a test
// tells it to (FAKE_ACP, as JSON: see `told` below). It stands in for the agents on the market, each of which does
// some of this. What it was sent it writes down, a line each, where it is told to (`log`): a test reads what a
// client said from there.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const told = JSON.parse(process.env.FAKE_ACP ?? "{}");
// told.log        a file: every message received, and what the process was started with
// told.sessions   a file: the conversations there have been, by id — so that a new process can go on with one
// told.protocol   the version it answers by (1)
// told.takes      { system, resume, load }: what it says it can
// told.login      true: a session wants a login first
// told.models     { current, options }: a choice of model offered with a session
// told.asks       the kinds of answer it offers when it asks permission, before it replies: ["allow_once", …]
// told.wants      a method of the client's it asks for, before it replies: "fs/read_text_file"
// told.tools      how many calls of tools it reports
// told.writes     files it writes where it works, before it replies: { "made.txt": "what is in it" }
// told.says       what it says, in pieces (["It is ", "done."]); "{…}" in a piece is filled in (see `filled`)
// told.ids        which message each piece is of, by an id (["a", "a", "b"]): without it, none is said
// told.between    true: it reports a call of a tool after the first piece of what it says
// told.usage      false: says none. { cost }: says a cost with how full it is — what a turn costs, said as the
//                 protocol has it: what the conversation has cost so far, this turn with those before it
// told.stop       why the turn stopped ("end_turn")
// told.fails      the error it answers a prompt with: { code, message }
// told.hangs      true: never answers a prompt — "obeys": until it is cancelled
// told.dies       "start": before it answers anything. "turn": in the middle of one
// told.chatters   true: writes what is no message, on both of its outputs
// told.leaves     a file: it starts a process that outlives it, and writes that one's pid there

const note = (what) => { if (told.log) appendFileSync(told.log, `${JSON.stringify(what)}\n`); };
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const sessions = () => (told.sessions && existsSync(told.sessions) ? JSON.parse(readFileSync(told.sessions, "utf8")) : {});
const keep = (id, turn) => { if (told.sessions) writeFileSync(told.sessions, JSON.stringify({ ...sessions(), [id]: [...(sessions()[id] ?? []), turn] })); };

note({ started: { argv: process.argv.slice(2), cwd: process.cwd(), env: Object.fromEntries(["WHOSE", "OF_THE_RUN", "TRAMA_PORT", "TRAMA_INIT"].map((name) => [name, process.env[name] ?? null])) } });
if (told.chatters) { console.log("warming up… (this line is no message)"); console.error("a word on stderr"); }
if (told.dies === "start") { console.error("fake-agent: no such thing as was asked for"); process.exit(3); }
if (told.leaves) {
  const left = spawn("sleep", ["300"], { stdio: "ignore" });
  writeFileSync(told.leaves, String(left.pid));
}

// What the client answered to a request of this agent's, by the request's id.
const answers = new Map();
let asked = 0;
const ask = (method, params) => new Promise((resolve) => {
  const id = `agent-${++asked}`;
  answers.set(id, resolve);
  send({ id, method, params });
});
const update = (sessionId, update) => send({ method: "session/update", params: { sessionId, update } });
const says = (sessionId, text, messageId) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text }, ...(messageId !== undefined && { messageId }) });

const options = () => (told.models ? [{ id: "model", name: "Model", category: "model", type: "select", currentValue: told.models.current ?? null, options: told.models.options.map((value) => ({ value, name: value })) }] : undefined);
let model = told.models?.current ?? null, cancelled;

async function turn(id, { sessionId, prompt }) {
  const said = prompt.map((block) => block.text ?? `[${block.type}]`).join("");
  const before = sessions()[sessionId] ?? [];
  const filled = (piece) => piece.replace("{prompt}", said).replace("{before}", before.join(" | ") || "nothing").replace("{model}", String(model)).replace("{cwd}", process.cwd());
  let granted = "";
  for (let n = 1; n <= (told.tools ?? 0); n += 1) {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: `t${n}`, title: `Reading file ${n}`, kind: "read", status: "pending" });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: `t${n}`, status: "completed" });
  }
  if (told.asks) {
    const answer = await ask("session/request_permission", {
      sessionId, toolCall: { toolCallId: "t-run", title: "Run `make`", kind: "execute" },
      options: told.asks.map((kind) => ({ optionId: `opt-${kind}`, name: kind, kind })),
    });
    granted = ` [permission: ${answer.result?.outcome?.outcome} ${answer.result?.outcome?.optionId ?? ""}]`;
  }
  if (told.wants) {
    const answer = await ask(told.wants, { sessionId, path: "/etc/hosts" });
    granted += ` [${told.wants}: ${answer.error?.code ?? "answered"}]`;
  }
  for (const [path, text] of Object.entries(told.writes ?? {})) writeFileSync(path, text);
  const pieces = (told.says ?? ["It is done: {prompt}"]).map(filled);
  says(sessionId, pieces[0], told.ids?.[0]);
  if (told.between) {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t-between", title: "Looking", kind: "read", status: "pending" });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t-between", status: "completed" });
  }
  if (told.dies === "turn") { console.error("fake-agent: out of memory, or some such"); process.exit(7); }
  if (told.hangs) {
    if (told.hangs !== "obeys") return;
    await new Promise((resolve) => { cancelled = resolve; });
    return send({ id, result: { stopReason: "cancelled" } });
  }
  for (const [at, piece] of pieces.slice(1).entries()) says(sessionId, piece, told.ids?.[at + 1]);
  if (granted) says(sessionId, granted);
  if (told.usage?.cost !== undefined) update(sessionId, { sessionUpdate: "usage_update", used: 53000, size: 200000, cost: { amount: told.usage.cost * (before.length + 1), currency: "USD" } });
  keep(sessionId, said);
  if (told.fails) return send({ id, error: told.fails });
  send({ id, result: {
    stopReason: told.stop ?? "end_turn",
    ...(told.usage !== false && { usage: { inputTokens: 1200, outputTokens: 34, totalTokens: 1234, cachedReadTokens: 1000 } }),
  } });
}

const NEEDS_LOGIN = { code: -32000, message: "Authentication required: run `fake-agent login` first" };
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  note(message);
  const { id, method, params } = message;
  if (method === undefined) return void answers.get(id)?.(message);
  switch (method) {
    case "initialize":
      return send({ id, result: {
        protocolVersion: told.protocol ?? 1,
        agentInfo: { name: "fake-agent", version: "0.0.1" },
        agentCapabilities: {
          loadSession: told.takes?.load ?? false,
          promptCapabilities: { image: false },
          sessionCapabilities: { ...(told.takes?.resume && { resume: {} }), ...(told.takes?.system && { systemPrompt: { mode: { override: {} } } }) },
        },
      } });
    case "session/new":
      if (told.login) return send({ id, error: NEEDS_LOGIN });
      return send({ id, result: { sessionId: `s-${process.pid}`, configOptions: options() } });
    case "session/resume":
    case "session/load": {
      const before = sessions()[params.sessionId];
      if (!before) return send({ id, error: { code: -32002, message: `Resource not found: session ${params.sessionId}` } });
      // (To load is to be told the old conversation over again, before the answer: none of it is this turn's.)
      if (method === "session/load") for (const said of before) says(params.sessionId, `(as it was said before: ${said})`);
      return send({ id, result: { configOptions: options() } });
    }
    case "session/set_config_option":
      model = params.value;
      return send({ id, result: { configOptions: options() } });
    case "session/prompt":
      return void turn(id, params);
    case "session/cancel":
      return void cancelled?.();
    default:
      return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
