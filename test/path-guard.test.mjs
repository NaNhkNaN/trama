import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { destinationOf, guardPath, guardWriteTarget, isInside } from "../packages/runtime/dist/path-guard.js";
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

  // Should not throw — symlink target is inside the project
  const resolved = guardPath(projectDir, "state.json");
  assert.ok(resolved.endsWith("state.json"));
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
  const resolved = guardPath(projectDir, "state.json");
  assert.ok(resolved.endsWith("state.json"));
});

// --- chains of links ---

test("a link to a link that points outside is refused, though neither destination exists", async (t) => {
  const projectDir = makeTempDir("trama-guard-");
  const outside = makeTempDir("trama-guard-outside-");
  t.after(() => { cleanupTempDir(projectDir); cleanupTempDir(outside); });
  symlinkSync(join(outside, "escaped.txt"), join(projectDir, "second")); // dangling, and outside
  symlinkSync(join(projectDir, "second"), join(projectDir, "first"));   // points at the dangling link

  assert.throws(() => guardPath(projectDir, "first"), /Path escapes project directory via symlink/);
  assert.throws(() => guardWriteTarget(projectDir, "first"), /Path escapes project directory via symlink/);
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

  assert.equal(guardPath(workspaceDir, "first"), join(workspaceDir, "first"));
  assert.equal(guardWriteTarget(workspaceDir, "first"), join(realpathSync(workspaceDir), "deep", "target.txt"));

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

  assert.equal(guardPath(root, "file.txt"), join(root, "file.txt"));
  assert.throws(() => guardPath(root, "../../../../etc/passwd"), /Path escapes project directory/);
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

  assert.equal(guardWriteTarget(root, "back"), join(realpathSync(root), "file.txt"));
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
    assert.throws(() => guardWriteTarget(root, path), { code: "ENOTDIR" });
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
  assert.equal(guardWriteTarget(root, join("to-dir", "file.txt")), join(realpathSync(root), "dir", "file.txt"));
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

function walkAgainstTheSystem(start) {
  let seed = start;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const pick = (list) => list[Math.floor(random() * list.length)];
  const names = ["a", "b", "c", "d", "e"];
  const count = { same: 0, landed: 0, refused: 0 };

  for (let round = 0; round < 100; round++) {
    const base = realpathSync(makeTempDir("trama-walk-"));
    try {
      const root = join(base, "root");
      mkdirSync(root);
      // What a link may say: names, ways up and round, sometimes from the top, sometimes ending in a slash.
      const target = () => {
        const steps = Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick([...names, ...names, "..", "..", ".", "."]));
        return (random() < 0.15 ? pick([root, base]) + "/" : "") + steps.join("/") + (random() < 0.2 ? "/" : "");
      };
      const dirs = [root];
      for (let i = 0; i < 16; i++) {
        const path = join(pick(dirs), pick(names));
        try { lstatSync(path); continue; } catch { /* free */ }
        const kind = random();
        if (kind < 0.35) { mkdirSync(path); dirs.push(path); }
        else if (kind < 0.55) writeFileSync(path, "a file");
        else symlinkSync(target(), path);
      }

      for (let q = 0; q < 120; q++) {
        const query = join(root, ...Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick(names)));
        let ours, refused, system, systemCode;
        try { ours = destinationOf(query); } catch (err) { refused = err; }
        // What the system makes of the path is what it does when asked to use it. (Its realpath is not
        // asked first: on macOS that is worked out by a library, which lets ".." follow a file.)
        try { statSync(query); system = realpathSync.native(query); } catch (err) { systemCode = err.code; }

        if (system !== undefined) {
          // Above the tree made here the names are not this test's: on a filesystem that
          // ignores case, "c" is found where the directory is called "C".
          if (!isInside(system, base)) continue;
          assert.equal(ours, system, `[${start}/${round}] ${query}: the guard says ${ours ?? refused}, the system ${system}`);
          count.same += 1;
        } else if (systemCode === "ENOTDIR" || systemCode === "ELOOP") {
          assert.ok(refused, `[${start}/${round}] ${query}: the system refuses it (${systemCode}), the guard says ${ours}`);
          count.refused += 1;
        } else if (systemCode === "ENOENT" && ours !== undefined && isInside(ours, base)) {
          // Nothing is there yet. Where the guard says a write would land is where it must land:
          // make the directories on the way, as a write does, and write through the path as given.
          mkdirSync(dirname(ours), { recursive: true });
          try {
            writeFileSync(query, "written");
          } catch (err) {
            assert.fail(`[${start}/${round}] ${query}: the guard says a write lands at ${ours}, the system will not write it (${err.code})`);
          }
          assert.equal(realpathSync.native(query), ours, `[${start}/${round}] ${query}: written at ${realpathSync.native(query)}, the guard said ${ours}`);
          count.landed += 1;
        }
      }
    } finally {
      cleanupTempDir(base);
    }
  }
  // It has to have been a test of something.
  assert.ok(count.same > 500 && count.landed > 100 && count.refused > 100, JSON.stringify(count));
}
