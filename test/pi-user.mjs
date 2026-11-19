// A user with a pi of their own, for tests that have calls served by the real pi — in this process, and in
// processes of their own. The model is a server in the test's process; the user is a directory of the test's.
// What an extension does it may do where the test cannot see it: so it writes it down, with the process it
// did it in.

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PiAdapter } from "../packages/runtime/dist/pi-adapter.js";
import { cleanupTempDir, makeTempDir, withEnv } from "./helpers.mjs";

/**
 * A user with a pi of their own — one extension in it, and whatever else a test puts there — a project,
 * and a model. `reply(request, respond, hit)` answers each request; without it every request is answered
 * with a few words.
 */
export async function user(t, reply) {
  const requests = [], headers = [], paths = [];
  // How many requests whoever asked let go of before they were answered.
  let dropped = 0;
  const sse = (res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (choices, usage) => res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "fake", choices, ...(usage && { usage }) })}\n\n`);
    return {
      says: (delta, finish = null) => send([{ index: 0, delta, finish_reason: finish }]),
      calls: (name, args = {}) => {
        send([{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }]);
        send([{ index: 0, delta: {}, finish_reason: "tool_calls" }]);
      },
      done: (usage = { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 }) => { send([], usage); res.end("data: [DONE]\n\n"); },
      /** Says what the reply has used so far, and goes on (or does not). */
      uses: (usage) => send([], usage),
    };
  };
  // What is asked for all at once, and not as the events of a reply — images, what a classifier makes of a state — is answered so.
  const atOnce = (res) => ({ whole: (body) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); } });
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const request = JSON.parse(body);
      requests.push(request);
      headers.push(req.headers);
      paths.push(req.url);
      res.on("close", () => { if (!res.writableEnded) dropped += 1; });
      if (reply) return reply(request, request.stream === false || !req.url.endsWith("/chat/completions") ? atOnce(res) : sse(res), requests.length, req.url);
      const stream = sse(res);
      stream.says({ role: "assistant", content: "hello from the fake" });
      stream.says({}, "stop");
      stream.done();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const agentDir = makeTempDir("trama-host-agent-"), cwd = makeTempDir("trama-host-cwd-");
  const log = join(agentDir, "seen.log");
  const put = (dir, path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  put(agentDir, "models.json", JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "none", models: [{ id: "plain", cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } }] } } }));
  put(agentDir, "seen.log", "");
  put(cwd, "a.txt", "what the file says");
  const adapter = new PiAdapter({ provider: "fake", model: "plain" });
  const env = { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", HOME: agentDir, TRAMA_TEST_SEEN: log };
  t.after(async () => {
    await adapter.close();
    server.closeAllConnections();
    server.close();
    cleanupTempDir(agentDir);
    cleanupTempDir(cwd);
  });
  return {
    agentDir, cwd, requests, headers, paths, adapter, env, put, port: server.address().port, dropped: () => dropped,
    ask: (prompt, call = {}) => withEnv(env, () => adapter.ask(prompt, { cwd, ...call })),
    toolsOf: (request) => (request.tools ?? []).map((tool) => tool.function.name),
    /** What extensions wrote down, each line as [the process it was in, what happened]. */
    seen: () => readFileSync(log, "utf-8").split("\n").filter(Boolean).map((line) => [Number(line.slice(0, line.indexOf(" "))), line.slice(line.indexOf(" ") + 1)]),
    pids: () => [...new Set(readFileSync(log, "utf-8").split("\n").filter(Boolean).map((line) => Number(line.slice(0, line.indexOf(" ")))))],
  };
}

/** How many hosts this process has at the moment. */
export const hostsHere = () => execFileSync("ps", ["-Ao", "pid=,ppid=,command="], { encoding: "utf-8" }).split("\n")
  .filter((line) => line.includes("agent-host.js") && Number(line.trim().split(/\s+/)[1]) === process.pid).length;

/** An extension that writes down, with the process it is in, that a session began — and has a tool, and whatever more `body` gives it. */
export const EXTENSION = (name, body = "") => `import { appendFileSync, readFileSync } from "node:fs";
export default function (pi) {
  const note = (what) => appendFileSync(process.env.TRAMA_TEST_SEEN, process.pid + " " + what + "\\n");
  pi.on("session_start", async (_event, ctx) => { note("${name}: a session begins, the project trusted: " + ctx.isProjectTrusted()); });
  pi.registerTool({ name: "${name}_tool", label: "${name}", description: "A tool of an extension", parameters: { type: "object", properties: {} }, async execute() { note("${name}: its tool is used"); return { content: [{ type: "text", text: "the ${name} tool answers" }] }; } });
  ${body}
}
`;
