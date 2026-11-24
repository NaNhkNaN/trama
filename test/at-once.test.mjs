import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { guardPath } from "../packages/runtime/dist/path-guard.js";
import { ensureProjectScaffold } from "../packages/runtime/dist/project.js";
import { REPO_ROOT, cleanupTempDir, createProjectFixture, makeTempDir, runNodeCommand, waitFor, writeJson } from "./helpers.mjs";

// A project is not one runner's alone. Runs of it begin together — a session's participants, a loop that starts
// several, two terminals — and each runner makes ready what a run needs and reads what the others write. So what
// is made ready is put in place in one move, never found half there; and a look at a path that another is putting
// something at is not taken for the path's own fault.

const DIST = join(REPO_ROOT, "packages", "runtime", "dist");
const CLI_ENTRY = join(REPO_ROOT, "packages", "cli", "dist", "index.js");
const RUNTIME = join(REPO_ROOT, "packages", "runtime");
const node = (script) => runNodeCommand(["--input-type=module", "-e", script], { cwd: REPO_ROOT });
/** What the scaffold leaves in a directory, without the names it only has for a moment. */
const leftovers = (dir) => readdirSync(dir).filter((name) => /\.trama-tmp-/.test(name));
/** Of what a process said as it failed, the line that says why. */
const whyOf = (stderr) => (stderr.split("\n").find((line) => /Error|EEXIST|cannot|Malformed/.test(line)) ?? stderr.trim().split("\n").at(-1) ?? "").slice(0, 200);
const OWNERS_PACKAGE = { name: "the-owners", scripts: { test: "true" }, pad: "x".repeat(200_000) };
const OWNERS_IGNORE = `${"# the owner's line\n".repeat(10_000)}README.md\n`;

test("a path is guarded while another process puts a file at it, takes it away and puts one in its place: that it changed between two looks is not the path's fault", async (t) => {
  const dir = makeTempDir("trama-at-once-");
  writeFileSync(join(dir, "state.json"), "0");
  // Somebody else's work at the path, as fast as it goes: a new file in the place of the old one, and every
  // fourth time the file gone for a moment before the next is put there.
  const writer = spawn(process.execPath, ["--input-type=module", "-e", `import { renameSync, rmSync, writeFileSync } from "fs";
const file = ${JSON.stringify(join(dir, "state.json"))}, beside = ${JSON.stringify(join(dir, "beside"))};
for (let n = 1; ; n++) { writeFileSync(beside, String(n)); if (n % 4 === 0) rmSync(file, { force: true }); renameSync(beside, file); }`], { stdio: "ignore" });
  t.after(async () => {
    writer.kill("SIGKILL");
    await new Promise((gone) => (writer.exitCode !== null || writer.signalCode !== null ? gone() : writer.once("exit", gone)));
    cleanupTempDir(dir);
  });
  // The number in the file. (The file is gone for a moment every fourth time — that is what this test is of — so a
  // look that finds none is taken again: one look that found none was once read as the number 0, and failed the test.)
  const read = () => {
    for (const until = Date.now() + 5000; ;) {
      try {
        return Number(readFileSync(join(dir, "state.json"), "utf-8"));
      } catch (err) {
        if (err.code !== "ENOENT" || Date.now() > until) throw err;
      }
    }
  };
  await waitFor(() => read() > 50, "the other process to be at it");

  const began = read();
  const refused = {};
  let guarded = 0;
  for (const until = Date.now() + 1500; Date.now() < until; guarded++) {
    try {
      assert.equal(guardPath(dir, "state.json"), join(guardPath(dir, "."), "state.json"));
    } catch (err) {
      refused[err.message] = (refused[err.message] ?? 0) + 1;
    }
  }
  // (It was at it all the while: the file is many files later, and the path was looked at many times.)
  const ended = read();
  assert.ok(ended - began > 1000 && guarded > 1000, `${began} to ${ended}, guarded ${guarded} times`);
  assert.deepEqual(refused, {}, `of ${guarded} times`);
});

test("a project is made ready by several runners at the same moment: each finds all of it there, and what its owner had in it is all there after", async (t) => {
  for (let round = 0; round < 6; round++) {
    const projectDir = makeTempDir("trama-at-once-");
    t.after(() => cleanupTempDir(projectDir));
    writeFileSync(join(projectDir, "meta.json"), "{}");
    // (The owner's files are large, and lack what trama adds: each runner reads them, and writes them anew.)
    writeJson(join(projectDir, "package.json"), OWNERS_PACKAGE);
    writeFileSync(join(projectDir, ".gitignore"), OWNERS_IGNORE);
    // A link to a runtime that is somewhere else: every runner has it to replace.
    if (round % 2 === 1) {
      mkdirSync(join(projectDir, "node_modules", "@trama-dev"), { recursive: true });
      symlinkSync(join(projectDir, "elsewhere"), join(projectDir, "node_modules", "@trama-dev", "runtime"), "dir");
    }
    // Each waits for the same moment, and goes.
    const at = Date.now() + 700;
    const ran = await Promise.all(Array.from({ length: 8 }, () => node(`import { ensureProjectScaffold } from ${JSON.stringify(join(DIST, "project.js"))};
while (Date.now() < ${at}) {}
ensureProjectScaffold(${JSON.stringify(projectDir)});`)));
    assert.deepEqual(ran.map((each) => [each.exitCode, whyOf(each.stderr)]), Array.from({ length: 8 }, () => [0, ""]), `round ${round}`);

    assert.deepEqual(JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8")), { ...OWNERS_PACKAGE, type: "module" });
    assert.equal(readFileSync(join(projectDir, ".gitignore"), "utf-8"), `${OWNERS_IGNORE}node_modules/\nstate.json\nlogs/\nhistory/\n`);
    assert.equal(readlinkSync(join(projectDir, "node_modules", "@trama-dev", "runtime")), RUNTIME);
    assert.deepEqual([leftovers(projectDir), leftovers(join(projectDir, "node_modules", "@trama-dev"))], [[], []]);
  }
});

test("the first run of a project, by several runners at once, is each one's run: none fails for what another was making ready", async (t) => {
  for (let round = 0; round < 3; round++) {
    const fakeHome = makeTempDir("trama-at-once-home-");
    t.after(() => cleanupTempDir(fakeHome));
    const projectDir = join(fakeHome, ".trama", "projects", "demo");
    createProjectFixture(projectDir, { scaffold: false, programSource: `import { ctx } from "@trama-dev/runtime";\nawait ctx.done({ n: (ctx.input.args as any).n });\n` });
    writeJson(join(fakeHome, ".trama", "config.json"), { maxRepairAttempts: 0 });
    assert.equal(existsSync(join(projectDir, "node_modules")), false);
    const ran = await Promise.all(Array.from({ length: 6 }, (_, n) =>
      runNodeCommand([CLI_ENTRY, "run", "demo", "--arg", `n=${n}`], { cwd: REPO_ROOT, env: { ...process.env, HOME: fakeHome } })));
    assert.deepEqual(ran.map((each) => [each.exitCode, each.exitCode === 0 ? "" : whyOf(each.stderr)]), Array.from({ length: 6 }, () => [0, ""]), `round ${round}`);
    // Each run's own record is there, and its line in the project's history.
    assert.equal(readdirSync(join(projectDir, "logs", "journal")).length, 6);
    assert.equal(readFileSync(join(projectDir, "history", "runs.jsonl"), "utf-8").trim().split("\n").length, 6);
  }
});

test("what is made ready is put in place in one move, and is the owner's file still: its permissions, the link it is reached by — and a file its owner has closed to writing is not replaced", (t) => {
  const project = () => {
    const projectDir = makeTempDir("trama-at-once-");
    t.after(() => cleanupTempDir(projectDir));
    writeFileSync(join(projectDir, "meta.json"), "{}");
    return projectDir;
  };
  const modeOf = (file) => statSync(file).mode & 0o777;

  // A project with nothing in it: everything is made, and nothing is left beside it.
  const bare = project();
  ensureProjectScaffold(bare);
  assert.deepEqual(readdirSync(bare).sort(), [".gitignore", "history", "logs", "meta.json", "node_modules", "package.json"]);
  assert.deepEqual(readdirSync(join(bare, "node_modules", "@trama-dev")).filter((name) => name !== "session"), ["runtime"]);
  assert.deepEqual([JSON.parse(readFileSync(join(bare, "package.json"), "utf-8")), readFileSync(join(bare, ".gitignore"), "utf-8")], [{ type: "module" }, "node_modules/\nstate.json\nlogs/\nhistory/\n"]);
  // Made ready again, nothing is written: the files are the files they were.
  const were = [".gitignore", "package.json", join("node_modules", "@trama-dev", "runtime")].map((name) => lstatSync(join(bare, name)).ino);
  ensureProjectScaffold(bare);
  assert.deepEqual([".gitignore", "package.json", join("node_modules", "@trama-dev", "runtime")].map((name) => lstatSync(join(bare, name)).ino), were);

  // The owner's files, added to: with the permissions they had, and through the link they are reached by.
  const owned = project();
  writeJson(join(owned, "package.json"), { name: "the-owners" });
  chmodSync(join(owned, "package.json"), 0o600);
  mkdirSync(join(owned, "config"));
  writeFileSync(join(owned, "config", "ignore"), "README.md");
  chmodSync(join(owned, "config", "ignore"), 0o640);
  symlinkSync(join("config", "ignore"), join(owned, ".gitignore"));
  // (And a link to a runtime that is elsewhere, which is replaced: the link, and nothing it leads to.)
  mkdirSync(join(owned, "elsewhere"));
  writeFileSync(join(owned, "elsewhere", "theirs.txt"), "theirs");
  mkdirSync(join(owned, "node_modules", "@trama-dev"), { recursive: true });
  symlinkSync(join(owned, "elsewhere"), join(owned, "node_modules", "@trama-dev", "runtime"), "dir");
  const old = ["package.json", join("config", "ignore")].map((name) => lstatSync(join(owned, name)).ino);
  ensureProjectScaffold(owned);
  // (Each is a new file in the place of the old one — whole before it was there — and not the old one written into.)
  for (const [n, name] of ["package.json", join("config", "ignore")].entries()) assert.notEqual(lstatSync(join(owned, name)).ino, old[n], name);
  assert.deepEqual([JSON.parse(readFileSync(join(owned, "package.json"), "utf-8")), modeOf(join(owned, "package.json"))], [{ name: "the-owners", type: "module" }, 0o600]);
  assert.deepEqual([lstatSync(join(owned, ".gitignore")).isSymbolicLink(), readFileSync(join(owned, "config", "ignore"), "utf-8"), modeOf(join(owned, "config", "ignore"))],
    [true, "README.md\nnode_modules/\nstate.json\nlogs/\nhistory/\n", 0o640]);
  assert.deepEqual([readlinkSync(join(owned, "node_modules", "@trama-dev", "runtime")), readdirSync(join(owned, "elsewhere"))], [RUNTIME, ["theirs.txt"]]);
  assert.deepEqual([leftovers(owned), leftovers(join(owned, "config")), leftovers(join(owned, "node_modules", "@trama-dev"))], [[], [], []]);

  // A file closed to writing is its owner's word that it stays as it is: it is not written into, and no other takes its place.
  for (const [name, content] of [["package.json", JSON.stringify({ name: "kept" })], [".gitignore", "README.md\n"]]) {
    const closed = project();
    writeFileSync(join(closed, name), content);
    chmodSync(join(closed, name), 0o444);
    const was = lstatSync(join(closed, name)).ino;
    try {
      assert.throws(() => ensureProjectScaffold(closed), (err) => err.code === "EACCES" && err.message.includes(name), name);
    } finally {
      chmodSync(join(closed, name), 0o644);
    }
    assert.deepEqual([readFileSync(join(closed, name), "utf-8"), lstatSync(join(closed, name)).ino, leftovers(closed)], [content, was, []], name);
  }
});
