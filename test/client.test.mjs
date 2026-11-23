import assert from "node:assert/strict";
import test from "node:test";
import { join } from "path";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { pathToFileURL } from "url";
import { REPO_ROOT, runNodeCommand } from "./helpers.mjs";

const CLIENT_MODULE_URL = pathToFileURL(join(REPO_ROOT, "packages", "runtime", "dist", "client.js")).href;

// The directories made for the tests below, removed when the tests are over.
const initDirs = [];
process.on("exit", () => { for (const dir of initDirs) rmSync(dir, { recursive: true, force: true }); });

function runtimeEnv() {
  const initDir = mkdtempSync(join(tmpdir(), "trama-client-test-"));
  initDirs.push(initDir);
  const initFile = initDir + "/init.json";
  writeFileSync(initFile, JSON.stringify({
    input: { prompt: "test prompt", args: {} },
    state: {},
    iteration: 0,
    maxIterations: 100,
  }));
  return {
    env: {
      ...process.env,
      TRAMA_PORT: "1",
      TRAMA_INIT: initFile,
    },
    initFile,
  };
}

test("client.ts throws a clear error when run directly without trama", async () => {
  const result = await runNodeCommand(
    ["-e", `import "@trama-dev/runtime";`],
    { cwd: REPO_ROOT, env: { ...process.env, TRAMA_PORT: undefined } },
  );

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /TRAMA_PORT/);
});

test("client.ts throws a clear error when TRAMA_INIT is missing", async () => {
  const result = await runNodeCommand(
    ["-e", `import "@trama-dev/runtime";`],
    { cwd: REPO_ROOT, env: { ...process.env, TRAMA_PORT: "12345", TRAMA_INIT: undefined } },
  );

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /TRAMA_INIT/);
});

test("client.ts checkpoint rejects non-serializable state before attempting IPC", async () => {
  const { env, initFile } = runtimeEnv();
  try {
    const result = await runNodeCommand(
      [
        "--input-type=module",
        "-e",
        `const { ctx } = await import(${JSON.stringify(CLIENT_MODULE_URL)});
ctx.state.bad = new Date();
await ctx.checkpoint();`,
      ],
      { cwd: REPO_ROOT, env },
    );

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /ctx\.state\.bad is not a plain object \(Date\)/);
    assert.doesNotMatch(result.stderr, /ECONNREFUSED|fetch failed/i);
  } finally {
    try { rmSync(initFile); } catch {}
  }
});

test("client.ts done rejects non-serializable results before attempting IPC", async () => {
  const { env, initFile } = runtimeEnv();
  try {
    const result = await runNodeCommand(
      [
        "--input-type=module",
        "-e",
        `const { ctx } = await import(${JSON.stringify(CLIENT_MODULE_URL)});
await ctx.done(new Map());`,
      ],
      { cwd: REPO_ROOT, env },
    );

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /ctx\.done\(result\) is not a plain object \(Map\)/);
    assert.doesNotMatch(result.stderr, /ECONNREFUSED|fetch failed/i);
  } finally {
    try { rmSync(initFile); } catch {}
  }
});

test("client.ts ready forwards each call to /ctx/ready (the runner makes it idempotent)", async () => {
  const result = await runNodeCommand(
    [
      "--input-type=module",
      "-e",
      `import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const events = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    events.push({ url: req.url, body: JSON.parse(body || "{}") });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result: null }));
  });
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const addr = server.address();
const initDir = mkdtempSync(join(tmpdir(), "trama-client-ready-"));
const initFile = join(initDir, "init.json");
writeFileSync(initFile, JSON.stringify({
  input: { prompt: "test prompt", args: {} },
  state: {},
  iteration: 0,
  maxIterations: 100,
}));

process.env.TRAMA_PORT = String(addr.port);
process.env.TRAMA_INIT = initFile;

try {
  const { ctx } = await import(${JSON.stringify(CLIENT_MODULE_URL)});
  await ctx.ready({ url: "http://127.0.0.1:3000" });
  await ctx.ready({ url: "ignored" });
  console.log(JSON.stringify(events));
} finally {
  await new Promise(resolve => server.close(resolve));
  rmSync(initDir, { recursive: true, force: true });
}`,
    ],
    { cwd: REPO_ROOT, env: { ...process.env } },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  const events = JSON.parse(result.stdout.trim());
  assert.deepEqual(events, [
    { url: "/ctx/ready", body: { data: { url: "http://127.0.0.1:3000" } } },
    { url: "/ctx/ready", body: { data: { url: "ignored" } } },
  ]);
});

test("the types of the program-facing API can be imported from where the API is", async () => {
  const { readFileSync } = await import("fs");
  const declarations = readFileSync(join(REPO_ROOT, "packages", "runtime", "dist", "client.d.ts"), "utf-8");
  const exported = /export type \{([^}]*)\}/.exec(declarations)?.[1].split(",").map(name => name.trim()).sort();
  assert.deepEqual(exported, [
    "Agent", "AgentOptions", "AgentResult", "AgentTool", "Ctx", "ImagePart", "ModelMessage", "ModelReply", "ModelRequest", "ObserveResult", "OutsideAgent",
    "Schema", "SchemaField", "ShellResult", "TextPart", "Thinking", "ThinkingPart", "ToolCallPart", "Tools", "Workspace",
  ]);
});

test("a schema and the options of a call type-check as a program would write them — inline, or held in a variable first", async (t) => {
  const { execFileSync } = await import("child_process");
  const { mkdtempSync, rmSync, writeFileSync } = await import("fs");
  const { tmpdir } = await import("os");
  const dir = mkdtempSync(join(tmpdir(), "trama-types-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const types = join(REPO_ROOT, "packages", "runtime", "dist", "types.js");
  // (A module: a program awaits at its top.)
  writeFileSync(join(dir, "program.mts"), `import type { Agent, AgentOptions, Schema } from ${JSON.stringify(types)};
declare const agent: Agent;
export const inline = await agent.generate<{ tags: string[] }>({ prompt: "p", schema: { tags: ["string"], failures: [{ test: "string", line: "number" }], meta: { grid: [["number"]] } } });
const held = { tags: ["string"], failures: [{ test: "string", line: "number" }], meta: { ok: "boolean" } };
export const fromHeld = await agent.generate({ prompt: "p", schema: held });
const fixed = { tags: ["string"], meta: { ok: "boolean" } } as const;
export const fromFixed = await agent.generate({ prompt: "p", schema: fixed });
const flat = { a: "string", n: "number: how many" };
export const fromFlat = await agent.generate({ prompt: "p", schema: flat });
const old: Record<string, string> = { a: "string" };
export const fromOld = await agent.generate({ prompt: "p", schema: old });
const named: Schema = { a: ["string"] };
export const fromNamed = await agent.generate({ prompt: "p", schema: named, cutOff: "keep", tools: [] });
const options: AgentOptions = { cutOff: "keep", thinking: "low" };
export const kept = await agent.instruct("p", options);
export const furnished = await agent.instruct("/review p", { skills: true, templates: ["review"], extensions: true });
export const theirs = await agent.instruct("p", { extensions: "project" });
// @ts-expect-error — whose extensions is the user's, or the project's with them: no other word
export const whose = await agent.instruct("p", { extensions: "user" });
export const some = await agent.generate({ prompt: "p", schema: flat, skills: ["pdf", "tables"], extensions: false });
// @ts-expect-error — a typed answer's prompt is not read as a template
export const typedTemplate = await agent.generate({ prompt: "/review p", schema: flat, templates: true });
// @ts-expect-error — extensions have no names: all of the user's, or none
export const byName = await agent.instruct("p", { extensions: ["mcp"] });
// @ts-expect-error — skills are all, none, or named
export const oneSkill = await agent.instruct("p", { skills: "pdf" });
// @ts-expect-error — a field is said in words, or as what it holds
export const notAWord = await agent.generate({ prompt: "p", schema: { a: 7 } });
// @ts-expect-error — a reply that was cut off is kept, or the call fails
export const neither = await agent.instruct("p", { cutOff: "sometimes" });
`);
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { noEmit: true, strict: true, target: "es2022", module: "nodenext", moduleResolution: "nodenext", skipLibCheck: true, types: [] },
    files: ["program.mts"],
  }));
  const tsc = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
  try {
    execFileSync(process.execPath, [tsc, "-p", dir], { encoding: "utf-8", stdio: "pipe" });
  } catch (err) {
    assert.fail(`the program does not type-check:\n${err.stdout}${err.stderr}`);
  }
});
