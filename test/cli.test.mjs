import assert from "node:assert/strict";
import test from "node:test";
import { execFile, spawn } from "child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync } from "fs";
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
  // And that a run's arguments are laid over the project's own, so that what the project has one for is never missing.
  assert.match(api.stdout, /What a run is given is laid over the project's own arguments — those it was made with \(trama create --arg; "input"\."args" in its meta\.json\), which it is also validated with: a parameter the project has an argument of its own for is never missing from a run of it, required or not\./);
  // And nothing of what an earlier trama had and this one has not: a count of iterations and a bound on them, a session.
  assert.doesNotMatch(api.stdout, /maxIterations|ctx\.iteration|\biteration: number|in a session|session layer/);
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
  // And the help of update says when a contract is to be said with it, and how its file is laid over what the project says.
  const update = (await trama("update", "--help")).stdout.replace(/\s+/g, " ");
  assert.match(update, /--contract <file> What the project is to take and give from this version on, where that is to change — as it is to for a run to give a field more, or one fewer: what a run gives beside what its project says is left out\./);
  assert.match(update, /A file of JSON as of create: each of "description", "parameters", "returns" that it says takes the place of the project's, whole, and what it does not say is as it is\. The program is validated under it, and the two are the project's together; trama rollback goes back to both/);
});

test("trama run --workspace has the run work in a directory that is not its project: the program's workspace is that directory, as it is, from wherever the command is run — and what is no directory is refused before anything is run", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-"), outside = realpathSync(makeTempDir("trama-cli-work-"));
  t.after(() => { cleanupTempDir(fakeHome); cleanupTempDir(outside); });
  const projectDir = join(fakeHome, ".trama", "projects", "works");
  createProjectFixture(projectDir, {
    scaffold: false,
    programSource: `import { ctx, tools, workspace } from "@trama-dev/runtime";
await tools.write("ran.txt", "ran");
const note = await workspace.read("note.txt");
await workspace.write("made.txt", note.toUpperCase());
const where = await workspace.shell("pwd -P");
await ctx.done({ note, where: where.stdout.trim() });`,
  });
  const work = join(outside, "codebase");
  writeText(join(work, "note.txt"), "low tide");
  writeText(join(outside, "a-file"), "");
  const run = (...args) => runNodeCommand([CLI_ENTRY, "run", "works", ...args], { cwd: outside, env: { ...process.env, HOME: fakeHome } });

  for (const given of ["nowhere", "a-file"]) {
    const refused = await run("--workspace", given);
    assert.equal(refused.exitCode, 1, given);
    assert.ok(refused.stderr.includes(`Error: --workspace takes a directory, and there is none at ${join(outside, given)}`), refused.stderr);
    assert.equal(existsSync(join(projectDir, "ran.txt")), false, "and nothing was run");
  }

  // (As it is given: from where the command is run.)
  const ran = await run("--workspace", "codebase", "--json");
  assert.equal(ran.exitCode, 0, ran.stderr);
  const document = JSON.parse(ran.stdout);
  assert.deepEqual([document.status, document.result], ["done", { note: "low tide", where: work }]);
  assert.equal(readFileSync(join(work, "made.txt"), "utf-8"), "LOW TIDE");
  assert.deepEqual(readdirSync(work).sort(), ["made.txt", "note.txt"], "it is worked in as it is: nothing else is put there");
  assert.equal(existsSync(join(projectDir, "made.txt")), false);

  assert.match((await run("--help")).stdout.replace(/\s+/g, " "), /--workspace <dir> Where the run works, where that is not in its project: a directory the program has as its workspace \(workspace\.read, workspace\.shell and the rest\) — the codebase a harness is to work on, say\. It is worked in as it is: nothing is copied/);
});

test("the programs that come with the command line can be had from it: trama examples lists them by what each says of itself, and trama examples <name> copies one among your projects — under its name or another, and never over a project that is there — where it is run as any project is", async (t) => {
  const fakeHome = makeTempDir("trama-cli-home-"), outside = realpathSync(makeTempDir("trama-cli-work-"));
  t.after(() => { cleanupTempDir(fakeHome); cleanupTempDir(outside); });
  writeJson(join(fakeHome, ".trama", "config.json"), { maxRepairAttempts: 0 });
  const trama = (...args) => runNodeCommand([CLI_ENTRY, ...args], { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome } });
  const EXAMPLES = join(REPO_ROOT, "examples"), at = (name) => join(fakeHome, ".trama", "projects", name);
  const names = readdirSync(EXAMPLES).filter((name) => existsSync(join(EXAMPLES, name, "meta.json"))).sort();
  const saysOf = (name) => JSON.parse(readFileSync(join(EXAMPLES, name, "meta.json"), "utf-8")).description;
  for (const name of ["check-by-command", "coding-harness", "improve-by-check"]) assert.ok(names.includes(name), name);
  // (What each says of how it is had is what the command line has: a copy read among one's projects has no repository beside it.)
  for (const name of names) assert.doesNotMatch(readFileSync(join(EXAMPLES, name, "README.md"), "utf-8"), /cp -R examples\//, name);
  assert.match(readFileSync(join(EXAMPLES, "improve-by-check", "README.md"), "utf-8"), /\ntrama examples improve-by-check --as improve\n/);

  const listed = await trama("examples");
  assert.equal(listed.exitCode, 0, listed.stderr);
  assert.equal(listed.stdout,
    `Programs that come with trama — a harness, the loop, a judge, a fixer, a writer: each a project, to copy among your own, read, run and change.\n\n` +
    names.map((name) => `  ${name} — ${saysOf(name)}\n`).join("") +
    `\nCopy one among your projects: trama examples <name> [--as <project>]\n`);
  assert.equal(existsSync(join(fakeHome, ".trama", "projects")), false, "listing them makes nothing");

  // Under its own name: all that is in it, as it is.
  const took = await trama("examples", "check-by-command");
  assert.equal(took.exitCode, 0, took.stderr);
  assert.deepEqual(readdirSync(at("check-by-command")).sort(), readdirSync(join(EXAMPLES, "check-by-command")).sort());
  for (const file of readdirSync(join(EXAMPLES, "check-by-command"))) {
    assert.equal(readFileSync(join(at("check-by-command"), file), "utf-8"), readFileSync(join(EXAMPLES, "check-by-command", file), "utf-8"), file);
  }
  assert.equal(took.stdout, `check-by-command is among your projects: ${at("check-by-command")}\nIt is yours, to read and change: its README.md says how it is used, and trama describe check-by-command what it takes and gives.\n`);

  // Under another: and it is run as any project is — here by hand, on a directory (the judge runs its command where the work is).
  const named = await trama("examples", "check-by-command", "--as", "judge");
  assert.equal(named.exitCode, 0, named.stderr);
  assert.ok(named.stdout.startsWith(`check-by-command is among your projects as judge: ${at("judge")}\n`), named.stdout);
  assert.ok(named.stdout.includes("trama describe judge "), named.stdout);
  writeText(join(outside, "note.txt"), "low tide");
  const verdict = async (command) => JSON.parse((await trama("run", "judge", "--workspace", outside, "--arg", `command=${command}`, "--json")).stdout);
  assert.deepEqual((await verdict("cat note.txt")).result, { ok: true, notes: "low tide" });
  assert.equal((await verdict("cat no-such.txt")).result.ok, false);
  assert.equal(JSON.parse((await trama("describe", "judge", "--json")).stdout).description, saysOf("check-by-command"));

  // Never over a project that is there — one that came the same way, changed since, or any other.
  writeText(join(at("judge"), "program.ts"), "// mine now\n");
  for (const [args, taken] of [[["check-by-command", "--as", "judge"], "judge"], [["improve-by-check", "--as", "judge"], "judge"], [["check-by-command"], "check-by-command"]]) {
    const refused = await trama("examples", ...args);
    assert.equal(refused.exitCode, 1, args.join(" "));
    assert.equal(refused.stderr, `Error: There is a project named ${JSON.stringify(taken)} already: give the copy another name (--as <project>).\n`);
  }
  assert.equal(readFileSync(join(at("judge"), "program.ts"), "utf-8"), "// mine now\n");

  // What is no example, and what is no name for a project.
  for (const none of ["no-such", "../test", "."]) {
    const refused = await trama("examples", none);
    assert.equal(refused.exitCode, 1, none);
    assert.equal(refused.stderr, `Error: There is no example named ${JSON.stringify(none)}: there are ${names.join(", ")}.\n`);
  }
  const misnamed = await trama("examples", "improve-by-check", "--as", "../out");
  assert.equal(misnamed.exitCode, 1);
  assert.match(misnamed.stderr, /^Error: Invalid project name: "\.\.\/out"\./);
  assert.deepEqual(readdirSync(join(fakeHome, ".trama", "projects")).sort(), ["check-by-command", "judge"]);
  assert.equal(existsSync(join(fakeHome, ".trama", "out")), false);

  // And it is said where one looks: in the help, and in what a program is.
  assert.match((await trama("--help")).stdout.replace(/\s+/g, " "), /examples \[options\] \[name\] List the programs that come with trama — a harness, the loop, a judge, a fixer, a writer — or copy one among your projects, to read, run and change/);
  assert.match((await trama("api")).stdout, /\nWhole programs to start from — a harness, the loop that improves a project, a judge of a run — come with the command line: trama examples\.\n/);
});

test("the examples go where the command line goes: they are in what is packed of it, all of them and nothing of them left behind — and installed, the command line has the ones beside it", async (t) => {
  const apart = realpathSync(makeTempDir("trama-cli-pack-")), fakeHome = makeTempDir("trama-cli-home-");
  t.after(() => { cleanupTempDir(apart); cleanupTempDir(fakeHome); });
  const CLI = join(REPO_ROOT, "packages", "cli"), EXAMPLES = join(REPO_ROOT, "examples");
  const filesOf = (dir, under = "") => readdirSync(join(dir, under), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesOf(dir, join(under, entry.name)) : [join(under, entry.name)]));

  // Packed, in a copy of the repository's shape (the package, and the examples two directories above it): nothing of the repository is touched.
  const packed = join(apart, "repo", "packages", "cli");
  mkdirSync(packed, { recursive: true });
  for (const entry of ["package.json", "README.md", "LICENSE", "dist"]) cpSync(join(CLI, entry), join(packed, entry), { recursive: true });
  cpSync(EXAMPLES, join(apart, "repo", "examples"), { recursive: true });
  const listing = await new Promise((resolve, reject) => execFile("npm", ["pack", "--dry-run", "--json"], { cwd: packed, encoding: "utf-8" }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout))));
  const inIt = JSON.parse(listing)[0].files.map((file) => file.path);
  const expected = filesOf(EXAMPLES).map((file) => join("examples", file)).sort();
  assert.ok(expected.length >= 24, String(expected.length));
  assert.deepEqual(inIt.filter((path) => path.startsWith("examples/")).sort(), expected);
  assert.ok(inIt.includes("dist/index.js"));
  assert.equal(existsSync(join(packed, "examples")), false, "what was copied in to be packed is taken away again");

  // And as a release packs it: by the very line of the workflow that publishes, into the tarball that is then
  // installed. (Packed with the packages' own scripts left out, the examples are not copied in: the command line
  // was published without them, and `trama examples` found none.)
  const packs = readFileSync(join(REPO_ROOT, ".github", "workflows", "publish.yml"), "utf-8").split("\n").map((line) => line.trim()).filter((line) => line.startsWith("npm pack "));
  assert.equal(packs.length, 1, "the workflow packs in one place");
  writeJson(join(apart, "repo", "package.json"), { name: "repo", private: true, workspaces: ["packages/*"] });
  mkdirSync(join(apart, "tarballs"));
  const sh = (command, args, cwd) => new Promise((resolve, reject) => execFile(command, args, { cwd, env: { ...process.env, RUNNER_TEMP: apart }, encoding: "utf-8" }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout))));
  await sh("sh", ["-c", packs[0]], join(apart, "repo"));
  const tarballs = readdirSync(join(apart, "tarballs"));
  assert.equal(tarballs.length, 1, tarballs.join(", "));
  const released = (await sh("tar", ["-tzf", join(apart, "tarballs", tarballs[0])], apart)).trim().split("\n").map((path) => path.replace(/^package\//, ""));
  assert.deepEqual(released.filter((path) => path.startsWith("examples/")).sort(), expected);
  assert.ok(released.includes("dist/index.js"));
  assert.equal(existsSync(join(packed, "examples")), false);

  // Installed: the examples are beside dist, and those are the ones it has — whatever is three directories up.
  const installed = join(apart, "node_modules", "@trama-dev", "cli");
  mkdirSync(installed, { recursive: true });
  for (const entry of ["package.json", "dist"]) cpSync(join(CLI, entry), join(installed, entry), { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules"), join(installed, "node_modules"), "dir");
  writeJson(join(installed, "examples", "only-here", "meta.json"), { description: "The one that came with it." });
  writeText(join(installed, "examples", "only-here", "program.ts"), "// here\n");
  // (Three directories above an installed command line's dist is node_modules: a package named examples is nobody's examples.)
  writeJson(join(apart, "node_modules", "examples", "not-this", "meta.json"), { description: "Somebody else's package." });
  // And among them: what says nothing of what it is for, what is no project at all, and one that cannot be read whole.
  writeJson(join(installed, "examples", "silent", "meta.json"), {});
  writeText(join(installed, "examples", "notes", "read-me.txt"), "no project");
  writeJson(join(installed, "examples", "broken", "meta.json"), { description: "Cannot be copied." });
  writeText(join(installed, "examples", "broken", "sealed.txt"), "kept from being read");
  chmodSync(join(installed, "examples", "broken", "sealed.txt"), 0o000);
  const trama = (...args) => runNodeCommand([join(installed, "dist", "index.js"), ...args], { cwd: apart, env: { ...process.env, HOME: fakeHome } });
  const listed = await trama("examples");
  assert.equal(listed.exitCode, 0, listed.stderr);
  assert.match(listed.stdout, /\n\n  broken — Cannot be copied\.\n  only-here — The one that came with it\.\n  silent — \(it does not say what it is for\)\n\nCopy one/);
  assert.equal((await trama("examples", "only-here")).exitCode, 0);
  assert.equal(readFileSync(join(fakeHome, ".trama", "projects", "only-here", "program.ts"), "utf-8"), "// here\n");
  // A copy that cannot be made whole leaves nothing: the name is free again.
  const half = await trama("examples", "broken");
  assert.equal(half.exitCode, 1, half.stdout);
  assert.match(half.stderr, /^Error: .*EACCES/);
  assert.deepEqual(readdirSync(join(fakeHome, ".trama", "projects")), ["only-here"]);
  assert.equal((await trama("examples", "notes")).exitCode, 1);
});

test("what goes with the command line is the runtime, and nothing else of trama's: there is no session layer — not among the packages, not in what the command line depends on, not in what is built, published, or shown to whoever writes a program", async () => {
  assert.deepEqual(readdirSync(join(REPO_ROOT, "packages")).filter((name) => !name.startsWith(".")).sort(), ["cli", "runtime"]);
  const own = (file) => Object.keys(JSON.parse(readFileSync(join(REPO_ROOT, file), "utf-8")).dependencies ?? {}).filter((name) => name.startsWith("@trama-dev/"));
  assert.deepEqual([own("packages/cli/package.json"), own("packages/runtime/package.json")], [["@trama-dev/runtime"], []]);
  for (const file of ["package.json", "package-lock.json", ".github/workflows/publish.yml", "examples/write-by-harness/example-programs.txt"]) {
    assert.doesNotMatch(readFileSync(join(REPO_ROOT, file), "utf-8"), /@trama-dev\/session|packages\/session|\bsession\b.*\bcli\b|maxIterations|ctx\.iteration/, file);
  }
});
