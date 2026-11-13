import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join, sep } from "path";
import { execFileSync } from "child_process";
import { guardPath } from "../packages/runtime/dist/path-guard.js";
import { createTools } from "../packages/runtime/dist/tools.js";
import { createWorkspace } from "../packages/runtime/dist/workspace.js";
import { loadState, ensureProjectScaffold } from "../packages/runtime/dist/runner.js";
import { createContext } from "../packages/runtime/dist/context.js";
import { makeTempDir, cleanupTempDir, writeJson, writeText, createProjectFixture, REPO_ROOT } from "./helpers.mjs";

// --- guardPath unit tests ---

test("guardPath rejects symlink pointing outside the project", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  const outsideDir = makeTempDir("trama-outside-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(outsideDir); });

  writeFileSync(join(outsideDir, "secret.txt"), "sensitive data");
  symlinkSync(join(outsideDir, "secret.txt"), join(projectDir, "state.json"));

  assert.throws(
    () => guardPath(projectDir, "state.json"),
    /Path escapes project directory via symlink/,
  );
});

test("guardPath rejects directory symlink pointing outside the project", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  const outsideDir = makeTempDir("trama-outside-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(outsideDir); });

  symlinkSync(outsideDir, join(projectDir, "logs"));

  assert.throws(
    () => guardPath(projectDir, join("logs", "latest.jsonl")),
    /Path escapes project directory via symlink/,
  );
});

test("guardPath allows normal paths inside the project", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  t.after(() => cleanupTempDir(projectDir));

  mkdirSync(join(projectDir, "logs"), { recursive: true });
  writeFileSync(join(projectDir, "state.json"), "{}");

  // Should not throw
  const resolved = guardPath(projectDir, "state.json");
  assert.ok(resolved.endsWith("state.json"));

  const logsPath = guardPath(projectDir, join("logs", "latest.jsonl"));
  assert.ok(logsPath.endsWith("latest.jsonl"));
});

test("guardPath rejects .. traversal", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  t.after(() => cleanupTempDir(projectDir));

  assert.throws(
    () => guardPath(projectDir, "../etc/passwd"),
    /Path escapes project directory/,
  );
});

test("guardPath allows symlinks that stay inside the project", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  t.after(() => cleanupTempDir(projectDir));

  mkdirSync(join(projectDir, "data"), { recursive: true });
  writeFileSync(join(projectDir, "data", "real.json"), "{}");
  symlinkSync(join(projectDir, "data", "real.json"), join(projectDir, "state.json"));

  // Should not throw — symlink target is inside the project. What comes back is where the link leads.
  assert.equal(guardPath(projectDir, "state.json"), join(realpathSync(projectDir), "data", "real.json"));
});

// --- Integration tests: runner-level ops reject symlinks ---

test("loadState rejects symlinked state.json pointing outside project", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  const outsideDir = makeTempDir("trama-outside-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(outsideDir); });

  writeFileSync(join(outsideDir, "stolen.json"), '{"secret":"data"}');
  symlinkSync(join(outsideDir, "stolen.json"), join(projectDir, "state.json"));

  assert.throws(
    () => loadState(projectDir),
    /Path escapes project directory via symlink/,
  );
});

test("ensureProjectScaffold rejects symlinked package.json pointing outside project", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  const outsideDir = makeTempDir("trama-outside-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(outsideDir); });

  writeFileSync(join(outsideDir, "target.json"), '{"name":"victim"}');
  symlinkSync(join(outsideDir, "target.json"), join(projectDir, "package.json"));

  assert.throws(
    () => ensureProjectScaffold(projectDir),
    /Path escapes project directory via symlink/,
  );
});

test("ensureProjectScaffold rejects symlinked .gitignore pointing outside project", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  const outsideDir = makeTempDir("trama-outside-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(outsideDir); });

  writeFileSync(join(outsideDir, "target"), "original content");
  symlinkSync(join(outsideDir, "target"), join(projectDir, ".gitignore"));

  assert.throws(
    () => ensureProjectScaffold(projectDir),
    /Path escapes project directory via symlink/,
  );
});

test("createContext rejects symlinked meta.json pointing outside project", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  const outsideDir = makeTempDir("trama-outside-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(outsideDir); });

  mkdirSync(join(projectDir, "logs"), { recursive: true });
  writeFileSync(join(projectDir, "logs", "latest.jsonl"), "");
  writeJson(join(outsideDir, "meta.json"), {
    input: { prompt: "test", args: {} },
    createdAt: "2026-01-01T00:00:00.000Z",
    piVersion: "0.63.1",
  });
  symlinkSync(join(outsideDir, "meta.json"), join(projectDir, "meta.json"));

  assert.throws(
    () => createContext(projectDir, {}),
    /Path escapes project directory via symlink/,
  );
});

test("createContext rejects symlinked logs directory pointing outside project", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  const outsideDir = makeTempDir("trama-outside-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(outsideDir); });

  writeJson(join(projectDir, "meta.json"), {
    input: { prompt: "test", args: {} },
    createdAt: "2026-01-01T00:00:00.000Z",
    piVersion: "0.63.1",
  });
  mkdirSync(join(outsideDir, "logs"), { recursive: true });
  symlinkSync(join(outsideDir, "logs"), join(projectDir, "logs"));

  assert.throws(
    () => createContext(projectDir, {}),
    /Path escapes project directory via symlink/,
  );
});

// --- Dangling symlink tests ---

test("guardPath rejects dangling symlink pointing outside the project", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  t.after(() => cleanupTempDir(projectDir));

  // Symlink to a non-existent file outside the project
  symlinkSync("/tmp/nonexistent-trama-target-12345", join(projectDir, "state.json"));

  assert.throws(
    () => guardPath(projectDir, "state.json"),
    /Path escapes project directory via symlink/,
  );
});

test("guardPath rejects dangling symlink in logs dir pointing outside project", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  t.after(() => cleanupTempDir(projectDir));

  mkdirSync(join(projectDir, "logs"), { recursive: true });
  symlinkSync("/tmp/nonexistent-trama-target-12345", join(projectDir, "logs", "latest.jsonl"));

  assert.throws(
    () => guardPath(projectDir, join("logs", "latest.jsonl")),
    /Path escapes project directory via symlink/,
  );
});

test("loadState rejects dangling symlinked state.json pointing outside project", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  t.after(() => cleanupTempDir(projectDir));

  // Dangling symlink — target doesn't exist
  symlinkSync("/tmp/nonexistent-trama-target-12345", join(projectDir, "state.json"));

  assert.throws(
    () => loadState(projectDir),
    /Path escapes project directory via symlink/,
  );
});

test("guardPath allows dangling symlinks that stay inside the project", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  t.after(() => cleanupTempDir(projectDir));

  // Dangling symlink to a non-existent file INSIDE the project
  symlinkSync(join(projectDir, "not-yet-created.json"), join(projectDir, "state.json"));

  // Should not throw — target is inside project even though it doesn't exist
  assert.equal(guardPath(projectDir, "state.json"), join(realpathSync(projectDir), "not-yet-created.json"));
});

// --- chains of links ---

test("a link to a link that points outside is refused, though neither destination exists", async (t) => {
  const projectDir = makeTempDir("trama-guard-");
  const outside = makeTempDir("trama-guard-outside-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(outside); });
  symlinkSync(join(outside, "escaped.txt"), join(projectDir, "second")); // dangling, and outside
  symlinkSync(join(projectDir, "second"), join(projectDir, "first"));   // points at the dangling link

  assert.throws(() => guardPath(projectDir, "first"), /Path escapes project directory via symlink/);
  assert.throws(() => guardPath(projectDir, "first"), /Path escapes project directory via symlink/);
  // What a write would have done: follow both links and create the file outside.
  await assert.rejects(createTools(projectDir).write("first", "x"), /Path escapes project directory via symlink/);
  await assert.rejects(createWorkspace(projectDir).write("first", "x"), /Path escapes project directory via symlink/);
  assert.equal(existsSync(join(outside, "escaped.txt")), false);
});

test("a path below a directory link that points outside and at nothing is refused", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  const outside = makeTempDir("trama-guard-outside-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(outside); });
  // mkdir -p through this link would create the directory outside.
  symlinkSync(join(outside, "not-there-yet"), join(projectDir, "dir"));

  assert.throws(() => guardPath(projectDir, join("dir", "sub", "file.txt")), /Path escapes project directory via symlink/);
});

test("a chain of links that stays inside is followed to its end, and a write replaces what is there", async (t) => {
  const workspaceDir = makeTempDir("trama-guard-");
  t.after(() => cleanupTempDir(workspaceDir));
  symlinkSync(join(workspaceDir, "deep", "target.txt"), join(workspaceDir, "second")); // nothing there yet
  symlinkSync("second", join(workspaceDir, "first"));                                   // a relative link

  assert.equal(guardPath(workspaceDir, "first"), join(realpathSync(workspaceDir), "deep", "target.txt"));

  await createWorkspace(workspaceDir).write("first", "through both");
  assert.equal(readFileSync(join(workspaceDir, "deep", "target.txt"), "utf-8"), "through both");
  // Neither link was replaced by the file.
  assert.equal(lstatSync(join(workspaceDir, "first")).isSymbolicLink(), true);
  assert.equal(lstatSync(join(workspaceDir, "second")).isSymbolicLink(), true);
});

test("links that lead back to themselves are refused rather than followed for ever", (t) => {
  const projectDir = makeTempDir("trama-guard-");
  t.after(() => cleanupTempDir(projectDir));
  symlinkSync("b", join(projectDir, "a"));
  symlinkSync("a", join(projectDir, "b"));

  assert.throws(() => guardPath(projectDir, "a"), /Too many levels of symbolic links/);
});

test("a root that does not exist yet is guarded like one that does", (t) => {
  // The temp directory is itself reached through a link on some systems (/var on macOS).
  const parent = makeTempDir("trama-guard-");
  t.after(() => cleanupTempDir(parent));
  const root = join(parent, "not", "made", "yet");

  assert.equal(guardPath(root, "file.txt"), join(realpathSync(parent), "not", "made", "yet", "file.txt"));
  // A path with no steps leads to the root, there or not: nothing is said of it that was not written.
  assert.equal(guardPath(root, ""), join(realpathSync(parent), "not", "made", "yet"));
  assert.throws(() => guardPath(root, "."), /leads on from what does not exist/);
  // Up from a directory that is not there leads nowhere; a place of its own outside is outside.
  assert.throws(() => guardPath(root, "../../../../etc/passwd"), /leads on from what does not exist/);
  assert.throws(() => guardPath(root, "/etc/passwd"), /Path escapes project directory/);
});

test('".." in what a link says is taken from where the links before it lead', async (t) => {
  const parent = makeTempDir("trama-guard-");
  t.after(() => cleanupTempDir(parent));
  const root = join(parent, "root");
  mkdirSync(root);
  writeFileSync(join(parent, "secret.txt"), "outside");
  // Every link here points inside the root as text. The system reads "here/.." as the root's parent.
  symlinkSync(".", join(root, "here"));
  symlinkSync("here/../secret.txt", join(root, "a"));
  symlinkSync("here/..", join(root, "p"));
  assert.equal(readFileSync(join(root, "a"), "utf-8"), "outside", "the layout is what it is meant to be");

  assert.throws(() => guardPath(root, "a"), /Path escapes project directory via symlink/);
  assert.throws(() => guardPath(root, join("p", "secret.txt")), /Path escapes project directory via symlink/);
  await assert.rejects(createTools(root).read("a"), /Path escapes project directory via symlink/);
  await assert.rejects(createWorkspace(root).read(join("p", "secret.txt")), /Path escapes project directory via symlink/);
  // Nor is what is out there listed, or waited for.
  assert.deepEqual(await createWorkspace(root).list("**"), []);
  const ran = await createTools(root).shell("pwd", { cwd: "p" }).catch(err => err);
  assert.match(String(ran.message), /Path escapes project directory via symlink/);
});

test('".." that stays inside is followed, and one that leads up from nothing is refused', (t) => {
  const root = makeTempDir("trama-guard-");
  t.after(() => cleanupTempDir(root));
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "file.txt"), "inside");
  symlinkSync("sub/../file.txt", join(root, "back"));
  symlinkSync("not-there/../file.txt", join(root, "through-nothing"));

  assert.equal(guardPath(root, "back"), join(realpathSync(root), "file.txt"));
  // The system could not follow this either: there is no directory to go up from.
  assert.throws(() => guardPath(root, "through-nothing"), /leads on from what does not exist/);
});

test("nothing lies beyond a file: a link that goes on from one is refused, for writing as for reading", async (t) => {
  const root = makeTempDir("trama-guard-");
  t.after(() => cleanupTempDir(root));
  writeFileSync(join(root, "regular.txt"), "a file");
  writeFileSync(join(root, "other.txt"), "ORIGINAL");
  symlinkSync("regular.txt/../other.txt", join(root, "bad"));
  symlinkSync("regular.txt/.", join(root, "dot"));
  assert.throws(() => readFileSync(join(root, "bad")), { code: "ENOTDIR" }, "the system does not follow it");

  // Taken as text, "regular.txt/.." is the root, and the write would land on other.txt.
  for (const path of ["bad", "dot", "regular.txt/child"]) {
    assert.throws(() => guardPath(root, path), { code: "ENOTDIR" });
    await assert.rejects(createTools(root).write(path, "OVERWRITTEN"), { code: "ENOTDIR" });
    await assert.rejects(createWorkspace(root).write(path, "OVERWRITTEN"), { code: "ENOTDIR" });
  }
  assert.equal(readFileSync(join(root, "other.txt"), "utf-8"), "ORIGINAL");
});

test("a path that says a file is a directory, or leads on from nothing, is refused for writing as the system refuses it", async (t) => {
  const root = makeTempDir("trama-guard-");
  t.after(() => cleanupTempDir(root));
  writeFileSync(join(root, "regular.txt"), "ORIGINAL");
  symlinkSync("regular.txt/", join(root, "slash"));   // a slash at the end asks for a directory
  symlinkSync("missing/.", join(root, "dotmissing"));  // "here", of something that is not there
  symlinkSync("missing/", join(root, "slashmissing"));
  assert.throws(() => readFileSync(join(root, "slash")), { code: "ENOTDIR" });
  assert.throws(() => writeFileSync(join(root, "dotmissing"), "x"), { code: "ENOENT" });

  for (const make of [() => createTools(root), () => createWorkspace(root)]) {
    await assert.rejects(make().write("slash", "OVERWRITTEN"), { code: "ENOTDIR" });
    await assert.rejects(make().write("dotmissing", "x"), /leads on from what does not exist/);
    await assert.rejects(make().write("slashmissing", "x"), /leads on from what does not exist/);
  }
  assert.equal(readFileSync(join(root, "regular.txt"), "utf-8"), "ORIGINAL");
  assert.equal(existsSync(join(root, "missing")), false, "nothing was made of the name that is not a directory");

  // A slash after a directory, or after a link to one, is only what it says.
  mkdirSync(join(root, "dir"));
  symlinkSync("dir/", join(root, "to-dir"));
  assert.equal(guardPath(root, join("to-dir", "file.txt")), join(realpathSync(root), "dir", "file.txt"));
});

test("the runtime resolves paths in one place", () => {
  // Node's realpathSync takes ".." in a link's target as text; the system does not. Anything that asks it
  // where a path leads can be told somewhere the guard never checked.
  const src = join(REPO_ROOT, "packages", "runtime", "src");
  const users = readdirSync(src).filter(name => /realpathSync/.test(readFileSync(join(src, name), "utf-8")));
  assert.deepEqual(users, []);
});

test("the guard's walk agrees with the system's, on random trees of directories, files and links", () => {
  // Several starting points, not one: a single run of luck has passed for agreement here before.
  for (const start of [20261112, 1, 7, 1234567]) walkAgainstTheSystem(start);
});

const isInside = (path, root) => path === root || path.startsWith(root + sep);

function walkAgainstTheSystem(start) {
  let seed = start;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const pick = (list) => list[Math.floor(random() * list.length)];
  const names = ["a", "b", "c", "d", "e"];
  const count = { same: 0, landed: 0, refused: 0, escaped: 0 };
  const mayLock = process.getuid?.() !== 0; // nothing is closed to root

  for (let round = 0; round < 100; round++) {
    // As it is given, the temp directory is reached through a link on some systems (/var on macOS).
    const given = makeTempDir("trama-walk-");
    const base = realpathSync(given);
    const root = join(base, "root");
    try {
      mkdirSync(root);
      // What a link may say: names, ways up and round — from here or from the top, by either of the
      // top's names — with slashes doubled or left at the end; the top of everything; a file that is
      // certainly outside; and nothing at all, where a link to nothing can be made.
      const target = () => {
        const kind = random();
        if (kind < 0.03) return "/";
        if (kind < 0.06) return "/etc/hosts";
        if (kind < 0.08) return "";
        const steps = Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick([...names, ...names, "..", "..", ".", "."]));
        const from = random() < 0.2 ? pick([root, base, join(given, "root")]) + "/" : "";
        return from + steps.join(random() < 0.1 ? "//" : "/") + (random() < 0.2 ? "/" : "");
      };
      const dirs = [root];
      for (let i = 0; i < 16; i++) {
        const path = join(pick(dirs), pick(names));
        try { lstatSync(path); continue; } catch { /* free */ }
        const kind = random();
        if (kind < 0.35) { mkdirSync(path); dirs.push(path); }
        else if (kind < 0.55) writeFileSync(path, "a file");
        else try { symlinkSync(target(), path); } catch { /* not a link this system makes */ }
      }
      const asked = [...names];
      // Now and then: a chain of links — as long as every system follows, or longer than any does —
      // and a directory nobody may pass, with a link that goes in and comes back out.
      if (random() < 0.3) {
        const length = pick([28, 30, 32, 41, 43]);
        symlinkSync(pick(names), join(root, "chain1"));
        for (let k = 2; k <= length; k++) symlinkSync(`chain${k - 1}`, join(root, `chain${k}`));
        asked.push(`chain${length}`, `chain${length}`);
      }
      if (mayLock && random() < 0.3) {
        mkdirSync(join(root, "locked"));
        writeFileSync(join(root, "locked", "inside"), "a file");
        chmodSync(join(root, "locked"), 0o000);
        symlinkSync(`locked/../${pick(names)}`, join(root, "via"));
        asked.push("locked", "via", "via");
      }

      // What is asked about is written as freely as what a link says: ways up and round, slashes
      // doubled or left at the end. It is handed over as written — nothing tidies it first.
      const steps = [...asked, ...asked, "..", "."];
      for (let q = 0; q < 120; q++) {
        const asking = "root/" + Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick(steps)).join(random() < 0.1 ? "//" : "/")
          + (random() < 0.15 ? "/" : "");
        const query = base + "/" + asking;
        const where = `[${start}/${round}] ${query}`;
        let ours, refused, system, systemCode;
        try { ours = guardPath(base, asking); } catch (err) { refused = err; }
        // What the system makes of the path is what it does when asked to use it. (Its realpath is not
        // asked first: on macOS that is worked out by a library, which lets ".." follow a file.)
        try { statSync(query); system = realpathSync.native(query); } catch (err) { systemCode = err.code; }

        if (system !== undefined && !isInside(system, base)) {
          assert.ok(refused, `${where}: the system takes it outside, to ${system}; the guard says ${ours}`);
          count.escaped += 1;
        } else if (system !== undefined) {
          // The guard stops at fewer links than some systems do. That refusal is its own to make.
          if (refused && /Too many levels/.test(refused.message)) continue;
          assert.equal(ours, system, `${where}: the guard says ${ours ?? refused}, the system ${system}`);
          count.same += 1;
        } else if (systemCode !== "ENOENT") {
          assert.ok(refused, `${where}: the system refuses it (${systemCode}), the guard says ${ours}`);
          count.refused += 1;
        } else if (ours !== undefined) {
          // Nothing is there yet. Where the guard says a write would land is where it must land:
          // make the directories on the way, as a write does, and write through the path as given.
          mkdirSync(dirname(ours), { recursive: true });
          try {
            writeFileSync(query, "written");
          } catch (err) {
            assert.fail(`${where}: the guard says a write lands at ${ours}, the system will not write it (${err.code})`);
          }
          assert.equal(realpathSync.native(query), ours, `${where}: written at ${realpathSync.native(query)}, the guard said ${ours}`);
          count.landed += 1;
        }
      }
    } finally {
      try { chmodSync(join(root, "locked"), 0o700); } catch { /* there was none */ }
      cleanupTempDir(given);
    }
  }
  // It has to have been a test of something.
  assert.ok(count.same > 500 && count.landed > 100 && count.refused > 100 && count.escaped > 20, JSON.stringify(count));
}

test("as many links are followed as every system follows, and no more", (t) => {
  // By its real name: a link on the way to the root (/var on macOS) counts as one of them.
  const root = realpathSync(makeTempDir("trama-guard-"));
  t.after(() => cleanupTempDir(root));
  writeFileSync(join(root, "end.txt"), "the end");
  symlinkSync("end.txt", join(root, "l1"));
  for (let k = 2; k <= 33; k++) symlinkSync(`l${k - 1}`, join(root, `l${k}`));

  assert.equal(guardPath(root, "l32"), join(root, "end.txt"));
  // One more is a loop to macOS. A write must not go where a read cannot follow.
  assert.throws(() => guardPath(root, "l33"), /Too many levels of symbolic links/);
});

test("a link to nothing is refused where one can be made", async (t) => {
  const root = makeTempDir("trama-guard-");
  t.after(() => cleanupTempDir(root));
  writeFileSync(join(root, "state.json"), "ORIGINAL");
  try { symlinkSync("", join(root, "z")); } catch { return t.skip("this system does not make a link to nothing"); }
  symlinkSync("z/state.json", join(root, "alias"));

  // The system refuses every use of such a link. Read as "here", it would lead a write to state.json.
  for (const path of ["z/state.json", "alias", "z/new.txt"]) {
    await assert.rejects(createTools(root).write(path, "OVERWRITTEN"), /it links to nothing/);
    await assert.rejects(createWorkspace(root).write(path, "OVERWRITTEN"), /it links to nothing/);
  }
  assert.equal(readFileSync(join(root, "state.json"), "utf-8"), "ORIGINAL");
});

test("a way through a directory that may not be passed is refused, though it comes back out", { skip: process.getuid?.() === 0 }, async (t) => {
  const root = makeTempDir("trama-guard-");
  t.after(() => { chmodSync(join(root, "locked"), 0o700); cleanupTempDir(root); });
  mkdirSync(join(root, "locked"));
  writeFileSync(join(root, "f.txt"), "ORIGINAL");
  symlinkSync("locked/../f.txt", join(root, "via"));
  chmodSync(join(root, "locked"), 0o000);
  assert.throws(() => readFileSync(join(root, "via")), { code: "EACCES" });

  await assert.rejects(createWorkspace(root).write("via", "OVERWRITTEN"), { code: "EACCES" });
  await assert.rejects(createTools(root).write("via", "OVERWRITTEN"), { code: "EACCES" });
  assert.equal(readFileSync(join(root, "f.txt"), "utf-8"), "ORIGINAL");
});

test("a path the system will not take is refused before anything is made on the way to it", async (t) => {
  const root = realpathSync(makeTempDir("trama-guard-"));
  t.after(() => cleanupTempDir(root));
  // Each name is one the system takes; the whole is longer than any path it does. Nothing of it
  // exists, so the guard's own walk has nothing to object to: it is the system that says no.
  // (Longer than the longest any of the systems this runs on takes: 1024 on macOS, 4096 on Linux.)
  const tooLong = ("d".repeat(200) + "/").repeat(24) + "file.txt";
  assert.throws(() => statSync(root + "/" + tooLong), { code: "ENAMETOOLONG" }, "the layout is what it is meant to be");

  assert.throws(() => guardPath(root, tooLong), { code: "ENAMETOOLONG" });
  await assert.rejects(createTools(root).write(tooLong, "x"), { code: "ENAMETOOLONG" });
  await assert.rejects(createWorkspace(root).write(tooLong, "x"), { code: "ENAMETOOLONG" });
  assert.deepEqual(readdirSync(root), [], "no directory was made for a file that cannot be written");
});

test("the top of the filesystem can be a root, and everything is inside it", () => {
  assert.equal(guardPath("/", "etc/hosts"), realpathSync("/etc/hosts"));
  // Even there, what a path leads to is a file or a directory: not a device.
  assert.throws(() => guardPath("/", "dev/null"), /Not a file or a directory/);
  assert.equal(guardPath("/", ""), "/");
});

test("the path a program gives is read as the system reads it, not tidied up as text first", async (t) => {
  const root = realpathSync(makeTempDir("trama-guard-"));
  t.after(() => { try { chmodSync(join(root, "locked"), 0o700); } catch { /* none */ } cleanupTempDir(root); });
  const fresh = () => {
    writeFileSync(join(root, "regular.txt"), "REGULAR");
    writeFileSync(join(root, "other.txt"), "OTHER");
  };
  const mayLock = process.getuid?.() !== 0;
  mkdirSync(join(root, "locked"));
  if (mayLock) chmodSync(join(root, "locked"), 0o000);

  // Each of these, tidied up as text, names a file that is there or could be. The system takes none of them.
  const refusedBySystem = ["regular.txt/", "regular.txt/.", "missing/.", "missing/", "regular.txt/../other.txt", "missing/../other.txt"];
  if (mayLock) refusedBySystem.push("locked/../other.txt");
  for (const path of refusedBySystem) {
    fresh();
    assert.throws(() => writeFileSync(root + "/" + path, "x"), `the system writes ${path}`);
    assert.throws(() => guardPath(root, path), `the guard lets ${path} through`);
    for (const make of [() => createTools(root), () => createWorkspace(root)]) {
      await assert.rejects(make().write(path, "OVERWRITTEN"), `a write to ${path} is carried out`);
      await assert.rejects(make().read(path), `a read of ${path} is carried out`);
    }
    assert.equal(readFileSync(join(root, "regular.txt"), "utf-8"), "REGULAR");
    assert.equal(readFileSync(join(root, "other.txt"), "utf-8"), "OTHER");
    assert.equal(existsSync(join(root, "missing")), false);
  }
});

test('".." after a link goes up from where the link leads — the same file the program\'s own fs would reach', async (t) => {
  const parent = realpathSync(makeTempDir("trama-guard-"));
  t.after(() => cleanupTempDir(parent));
  const root = join(parent, "root");
  mkdirSync(join(root, "a", "b"), { recursive: true });
  writeFileSync(join(root, "item.txt"), "at the top");
  writeFileSync(join(root, "a", "item.txt"), "in a");
  symlinkSync("a/b", join(root, "deep"));
  assert.equal(readFileSync(root + "/deep/../item.txt", "utf-8"), "in a", "the layout is what it is meant to be");

  assert.equal(guardPath(root, "deep/../item.txt"), join(root, "a", "item.txt"));
  assert.equal(await createTools(root).read("deep/../item.txt"), "in a");
  assert.equal(await createWorkspace(root).read("deep/../item.txt"), "in a");
  assert.equal((await createTools(root).shell("cat item.txt", { cwd: "deep/.." })).stdout, "in a");
  await createTools(root).write("deep/../item.txt", "written");
  assert.equal(readFileSync(join(root, "a", "item.txt"), "utf-8"), "written");
  assert.equal(readFileSync(join(root, "item.txt"), "utf-8"), "at the top");

  // As text this one leaves the root; followed, it never does. And the other way round.
  assert.equal(guardPath(root, "deep/../../item.txt"), join(root, "item.txt"));
  symlinkSync("..", join(root, "up"));
  writeFileSync(join(parent, "secret.txt"), "outside");
  assert.throws(() => guardPath(root, "up/secret.txt"), /Path escapes project directory via symlink/);
  assert.throws(() => guardPath(root, "a/../../secret.txt"), /Path escapes project directory: /);
});

test("a link that names the root in other letters is still inside, where the file system takes the names for one", async (t) => {
  const root = realpathSync(makeTempDir("trama-guard-Case-"));
  t.after(() => cleanupTempDir(root));
  writeFileSync(join(root, "data.txt"), "data");
  if (!existsSync(join(root.toUpperCase(), "data.txt"))) return t.skip("this file system tells upper case from lower");
  symlinkSync(join(root.toUpperCase(), "data.txt"), join(root, "shouted"));
  symlinkSync(root.toUpperCase(), join(root, "self"));

  // By the root's own name for it, whatever the link called it.
  assert.equal(guardPath(root, "shouted"), join(root, "data.txt"));
  assert.equal(await createTools(root).read("shouted"), "data");
  assert.equal(guardPath(root, "self"), root);
  // The root itself is still not a file's place: nothing is put beside it.
  await assert.rejects(createWorkspace(root).write("self", "x"), /Not a file path/);
  assert.deepEqual(readdirSync(dirname(root)).filter(name => name.includes(".trama-tmp-")), []);
  // And what is outside is outside, however it is spelled.
  symlinkSync(dirname(root).toUpperCase(), join(root, "out"));
  assert.throws(() => guardPath(root, "out/anything"), /Path escapes project directory via symlink/);
});

test("what a path leads to is a file, a directory, or nothing yet — a pipe is refused, not waited on", async (t) => {
  const root = realpathSync(makeTempDir("trama-guard-"));
  t.after(() => cleanupTempDir(root));
  for (const name of ["pipe", "state.json"]) execFileSync("mkfifo", [join(root, name)]);
  symlinkSync("pipe", join(root, "to-pipe"));

  // Asked first, and of the guard alone: opening a pipe nobody is at the other end of never returns,
  // and what waits is the one process that serves every program of a session.
  for (const path of ["pipe", "to-pipe"]) assert.throws(() => guardPath(root, path), /Not a file or a directory/);

  const tools = createTools(root);
  const workspace = createWorkspace(root);
  for (const path of ["pipe", "to-pipe"]) {
    await assert.rejects(tools.read(path), /Not a file or a directory/);
    await assert.rejects(tools.write(path, "x"), /Not a file or a directory/);
    await assert.rejects(workspace.read(path), /Not a file or a directory/);
    await assert.rejects(workspace.write(path, "x"), /Not a file or a directory/);
    await assert.rejects(workspace.observe(path, { timeout: 200 }), /Not a file or a directory/);
  }
  // Nor is it listed as an artifact, by its own name or a link's.
  assert.deepEqual(await workspace.list("**"), []);
  // The runtime's own files are held to the same.
  assert.throws(() => loadState(root), /Not a file or a directory: state\.json/);
});
