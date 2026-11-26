import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import {
  REPO_ROOT, cleanupTempDir, createProjectFixture, isAlive, makeTempDir, pidIn, runNodeCommand, waitFor, writeJson,
  writeText,
} from "./helpers.mjs";

const CLI_ENTRY = join(REPO_ROOT, "packages", "cli", "dist", "index.js");

test("CLI list reports an empty workspace cleanly", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const result = await runNodeCommand([CLI_ENTRY, "list"], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: fakeHome },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /No projects found\./);
});

test("CLI run rejects invalid --timeout values", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-");
  t.after(() => cleanupTempDir(fakeHome));

  for (const bad of ["nope", "0", "-5", "", "10ms"]) {
    const result = await runNodeCommand(
      [CLI_ENTRY, "run", "demo", "--timeout", bad],
      { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome } },
    );
    assert.equal(result.exitCode, 1, `should reject --timeout ${JSON.stringify(bad)}`);
    assert.match(result.stderr, /--timeout must be a positive number/);
  }
});

test("CLI run surfaces missing-project errors with exit code 1", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const result = await runNodeCommand([CLI_ENTRY, "run", "missing", "--timeout", "10"], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: fakeHome },
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /not found/);
});

test("CLI run rejects path-like project names", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const result = await runNodeCommand([CLI_ENTRY, "run", "../escaped", "--timeout", "10"], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: fakeHome },
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Invalid project name/);
});

test("CLI create honors the configured default model when --model is omitted", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-");
  t.after(() => cleanupTempDir(fakeHome));

  writeJson(join(fakeHome, ".trama", "config.json"), {
    provider: "anthropic",
    model: "configured-model",
    maxRepairAttempts: 3,
    defaultTimeout: 300000,
    defaultMaxIterations: 100,
  });

  const observedModelPath = join(fakeHome, "observed-model.txt");
  const preloadPath = join(fakeHome, "mock-create.mjs");
  writeText(preloadPath, `import { writeFileSync } from "node:fs";
import { PiAdapter } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, "packages", "runtime", "dist", "pi-adapter.js")).href)};

PiAdapter.prototype.ask = async function ask(prompt) {
  if (!prompt.startsWith("write something")) throw new Error("only the program should be asked for");
  writeFileSync(${JSON.stringify(observedModelPath)}, this.config.model, "utf-8");
  return 'import { ctx } from "@trama-dev/runtime";\\nawait ctx.done();\\n';
};
`);

  const result = await runNodeCommand(
    ["--import", preloadPath, CLI_ENTRY, "create", "alpha", "write something"],
    { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome } },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(readFileSync(observedModelPath, "utf-8"), "configured-model");
});

test("CLI create rejects malformed --arg values", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const result = await runNodeCommand(
    [CLI_ENTRY, "create", "demo", "make something", "--arg", "noequals"],
    { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome } },
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Invalid --arg format/);
});

test("CLI update surfaces missing-project errors with exit code 1", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const result = await runNodeCommand(
    [CLI_ENTRY, "update", "missing", "new requirements"],
    { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome } },
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /not found/);
});

test("CLI logs surfaces missing-project errors with exit code 1", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const result = await runNodeCommand(
    [CLI_ENTRY, "logs", "missing"],
    { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome } },
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /not found/);
});

test("CLI run without --timeout uses config.defaultTimeout instead of a hardcoded default", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-");
  t.after(() => cleanupTempDir(fakeHome));

  // Omitting --timeout should not error — it should fall through to config.defaultTimeout
  const result = await runNodeCommand([CLI_ENTRY, "run", "missing"], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: fakeHome },
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /not found/);
  assert.doesNotMatch(result.stderr, /timeout must be a positive integer/i);
});

test("the trama command started by a program is a runner of its own", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const projects = join(fakeHome, ".trama", "projects");
  createProjectFixture(join(projects, "inner"), {
    scaffold: false,
    programSource: `import { ctx } from "@trama-dev/runtime";
console.log("printed by the inner program");
await ctx.done();`,
  });
  // The outer program starts the command itself, as it might any other tool,
  // and reads what it prints. It inherits the outer program's bridge; it must
  // not hand its run to that bridge's runner, which would print it elsewhere.
  createProjectFixture(join(projects, "outer"), {
    scaffold: false,
    programSource: `import { ctx, tools } from "@trama-dev/runtime";
import { execFileSync } from "child_process";
const printed = execFileSync(process.execPath, [${JSON.stringify(CLI_ENTRY)}, "run", "inner"], { encoding: "utf-8" });
await tools.write("printed.txt", printed);
await ctx.done();`,
  });

  const result = await runNodeCommand([CLI_ENTRY, "run", "outer"], {
    cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome },
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(
    readFileSync(join(projects, "outer", "printed.txt"), "utf-8"), /printed by the inner program/,
    "the command's output should have reached the program that ran it",
  );
});

test("a signal stops `trama run` politely: the program is asked, waited for, and the command dies of the signal", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-");
  const signalDir = makeTempDir("trama-cli-signal-");
  t.after(() => { cleanupTempDir(fakeHome); cleanupTempDir(signalDir); });

  createProjectFixture(join(fakeHome, ".trama", "projects", "patient"), {
    scaffold: false,
    programSource: `import { writeFileSync } from "fs";
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(join(signalDir, "closed-properly"))}, "");
  process.exit(0);
});
writeFileSync(${JSON.stringify(join(signalDir, "program.pid"))}, String(process.pid));
setInterval(() => {}, 1000);
await new Promise(() => {});`,
  });

  const cli = spawn(process.execPath, [CLI_ENTRY, "run", "patient"], {
    cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome }, stdio: "ignore",
  });
  const exited = new Promise(resolve => cli.on("close", (code, signal) => resolve({ code, signal })));
  await waitFor(() => pidIn(join(signalDir, "program.pid")), "the program to start");
  const programPid = pidIn(join(signalDir, "program.pid"));

  cli.kill("SIGINT");
  const { signal } = await exited;

  assert.equal(signal, "SIGINT", "the command should end as the signal would have ended it");
  assert.equal(existsSync(join(signalDir, "closed-properly")), true, "the program should have been asked to stop");
  assert.equal(isAlive(programPid), false, "and gone before the command returned");
});

test("a signal stops `trama create` while generation is in flight and cleans up the half-made project", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-");
  const signalDir = makeTempDir("trama-cli-create-signal-");
  t.after(() => { cleanupTempDir(fakeHome); cleanupTempDir(signalDir); });

  const askedMarker = join(signalDir, "asked");
  const preloadPath = join(fakeHome, "mock-slow-create.mjs");
  writeText(preloadPath, `import { writeFileSync } from "node:fs";
import { PiAdapter } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, "packages", "runtime", "dist", "pi-adapter.js")).href)};

PiAdapter.prototype.ask = async function ask(_prompt, options) {
  const keepAlive = setInterval(() => {}, 1000);
  writeFileSync(${JSON.stringify(askedMarker)}, "1", "utf-8");
  return await new Promise((_resolve, reject) => {
    const onAbort = () => { clearInterval(keepAlive); reject(new Error("Aborted")); };
    if (options?.signal?.aborted) { onAbort(); return; }
    options?.signal?.addEventListener("abort", onAbort, { once: true });
  });
};
`);

  const cli = spawn(
    process.execPath,
    ["--import", preloadPath, CLI_ENTRY, "create", "half-made", "build something"],
    { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome }, stdio: "ignore" },
  );
  const exited = new Promise(resolve => cli.on("close", (code, signal) => resolve({ code, signal })));
  await waitFor(() => existsSync(askedMarker), "create ask() to start");

  cli.kill("SIGINT");
  const { signal } = await exited;
  assert.equal(signal, "SIGINT");
  assert.equal(existsSync(join(fakeHome, ".trama", "projects", "half-made")), false);
});


test("CLI --arg is a name and what it is given: a name that is none, or given twice, is refused — and any name reaches the program as it was written", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-");
  t.after(() => cleanupTempDir(fakeHome));
  const projectDir = join(fakeHome, ".trama", "projects", "says");
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { ctx, tools } from "@trama-dev/runtime";
await tools.write("args.json", JSON.stringify(Object.entries(ctx.input.args)));
await ctx.done();`,
  });
  const run = (...args) => runNodeCommand([CLI_ENTRY, "run", "says", ...args], { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome } });

  for (const [args, said] of [
    [["--arg", "=nameless"], /Invalid --arg format: "=nameless"\. Expected key=value\./],
    [["--arg", "mode=fast", "--arg", "mode=slow"], /--arg mode is given twice\./],
  ]) {
    const refused = await run(...args);
    assert.equal(refused.exitCode, 1, args.join(" "));
    assert.match(refused.stderr, said);
    assert.equal(existsSync(join(projectDir, "args.json")), false, "and nothing was run");
  }

  // (A name every object has from birth is a name like any other.)
  const ran = await run("--arg", "__proto__=x", "--arg", "mode=fast", "--arg", "note=a=b");
  assert.equal(ran.exitCode, 0, ran.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(projectDir, "args.json"), "utf-8")), [["__proto__", "x"], ["mode", "fast"], ["note", "a=b"]]);
});

test("CLI run says once that a program failed, whatever the reason says of itself", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-");
  t.after(() => cleanupTempDir(fakeHome));
  writeJson(join(fakeHome, ".trama", "config.json"), { maxRepairAttempts: 0 });
  createProjectFixture(join(fakeHome, ".trama", "projects", "fails"), { scaffold: false, programSource: `throw new Error("it breaks");` });
  const result = await runNodeCommand([CLI_ENTRY, "run", "fails"], { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome } });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Program failed \(repair disabled\)/);
  assert.equal(result.stderr.match(/Program failed/g).length, 1, result.stderr);
});

test("trama run --json hands its caller what the run came to — status, result, check — and nothing else on standard output: what the program and its runner say as it goes is on standard error; and trama history --json is the project's history", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-");
  t.after(() => cleanupTempDir(fakeHome));
  writeJson(join(fakeHome, ".trama", "config.json"), { maxRepairAttempts: 0 });
  const at = (name) => join(fakeHome, ".trama", "projects", name);
  createProjectFixture(at("sum"), { programSource: `import { ctx } from "@trama-dev/runtime";
const { a = 0, b = 0 } = ctx.input.args as { a?: number; b?: number };
await ctx.log("adding");
console.log("the program's own word");
if (a < 0) await ctx.done();
else await ctx.done({ sum: a + b });
` });
  writeJson(join(at("sum"), "meta.json"), { description: "Adds two numbers.", parameters: { "a?": "number", "b?": "number" }, input: { prompt: "p", args: {} } });
  createProjectFixture(at("fails"), { programSource: `throw new Error("it breaks");` });
  createProjectFixture(at("judge"), { programSource: `import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ ok: false, notes: "never good enough" });\n` });
  const trama = (...args) => runNodeCommand([CLI_ENTRY, ...args], { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome } });

  // Without it: what is said as the run goes — and then what the run gave, for whoever is looking on. (A run that gave nothing shows nothing more.)
  const plain = await trama("run", "sum", "--arg", "a=2", "--arg", "b=3");
  assert.deepEqual([plain.exitCode, /\[trama\] adding\n[^]*\[trama\] done\n\{\n  "sum": 5\n\}\n$/.test(plain.stdout), plain.stderr], [0, true, ""]);
  assert.match((await trama("run", "sum", "--arg", "a=-1")).stdout, /\[trama\] done\n$/);

  const ran = await trama("run", "sum", "--arg", "a=2", "--arg", "b=3", "--json");
  assert.equal(ran.exitCode, 0, ran.stderr);
  assert.deepEqual(JSON.parse(ran.stdout), { status: "done", result: { sum: 5 } });
  assert.deepEqual([/adding|the program's own word|\[trama\]/.test(ran.stdout), /\[trama\] adding/.test(ran.stderr), /the program's own word/.test(ran.stderr), ran.stdout.endsWith("}\n")], [false, true, true, true]);
  // A run that gave nothing says so by having no result.
  assert.deepEqual(JSON.parse((await trama("run", "sum", "--arg", "a=-1", "--json")).stdout), { status: "done" });

  // A run that failed: the same document, with why — and the command fails as it does without it.
  const failed = await trama("run", "fails", "--json");
  const said = JSON.parse(failed.stdout);
  assert.deepEqual([failed.exitCode, said.status, /it breaks/.test(said.reason), /^Error: /m.test(failed.stderr)], [1, "failed", true, true]);
  // A run whose check says the work is not good: the verdict is in the document, and the command fails.
  const checked = await trama("run", "sum", "--arg", "a=1", "--check", "judge", "--json");
  const verdict = JSON.parse(checked.stdout);
  assert.deepEqual([checked.exitCode, verdict.status, verdict.result, verdict.check.ok, verdict.check.notes], [1, "done", { sum: 1 }, false, "never good enough"]);
  // A run that was not begun has no document: why is on standard error.
  const unfit = await trama("run", "sum", "--arg", "a=two", "--json");
  assert.deepEqual([unfit.exitCode, unfit.stdout, /The arguments do not fit/.test(unfit.stderr)], [1, "", true]);

  // The history, for a reader that is a program: the versions, the runs, and which version is the program.
  const history = await trama("history", "sum", "--json");
  assert.equal(history.exitCode, 0, history.stderr);
  const { versions, runs, current } = JSON.parse(history.stdout);
  assert.deepEqual([versions.map((version) => [version.version, version.reason]), runs.map((run) => run.status), current, runs.at(-1).check.ok], [[[1, "found"]], ["done", "done", "done", "done", "done"], 1, false]);
});

test("the command line says what a program is, for whoever writes one themselves: trama api — where a project is, how what it takes and gives is written, the runtime's API, programs to go by — and the help of create says how a contract is written and what a project is validated with", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-");
  t.after(() => cleanupTempDir(fakeHome));
  const trama = (...args) => runNodeCommand([CLI_ENTRY, ...args], { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome } });
  const api = await trama("api");
  assert.equal(api.exitCode, 0, api.stderr);
  // Where a project is, and what is in it; what a program has, takes and gives.
  assert.ok(api.stdout.includes(`A project is a directory — ${join(fakeHome, ".trama", "projects")}/<name> — with its program (program.ts) and what it says of itself (meta.json).`), api.stdout.slice(0, 400));
  assert.match(api.stdout, /imports from "@trama-dev\/runtime"[^\n]*ctx\.input\.args[^\n]*ctx\.done\(result\)/);
  // How what a project takes and gives is written: in words, and once as it looks.
  assert.match(api.stdout, /"string", "number", "boolean", "json" for any value[^\n]*a "\?" at the end of its name/);
  assert.match(api.stdout, /\{ "description": "[^"]+", "parameters": \{ "text": "string: [^"]+", "loud\?": "boolean" \}, "returns": \{ "words": "number"/);
  // The API as a writer is shown it, and programs to go by.
  assert.match(api.stdout, /\nThe runtime's API:\n[^]*interface Ctx[^]*export declare const workspace: Workspace;[^]*\nPrograms, for what one looks like:\n\/\/ Example A: /);
  // It is in the list of commands; and the help of create points to it, and says what a required parameter asks of --arg.
  assert.match((await trama("--help")).stdout, /\n  api +Show what a program is/);
  const create = (await trama("create", "--help")).stdout.replace(/\s+/g, " ");
  assert.match(create, /--contract <file> What the project is to take and give: a file of JSON — \{"description": "…", "parameters": \{"text": "string: what it is", "n\?": "number"\}, "returns": \{"words": "number"\}\} — written as `trama api` says/);
  assert.match(create, /--arg <key=value> An argument of the project's own \(repeatable\): what a run of it has where the run gives none — and what the new program is validated with, so a parameter the project requires is to be given here/);
  assert.match((await trama("add-version", "--help")).stdout.replace(/\s+/g, " "), /it is validated, and not installed — and its number is said/);
});
