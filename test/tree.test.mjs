// What a directory holds: read, copied, and merged back (packages/runtime/src/tree.ts).
//
// The merge is held against the thing it stands in for. A run that works in a
// copy, and has its work merged back, must leave the directory as the same
// run would have left it working there directly — so the tests below do both,
// with trees and runs made at random, and compare. Nothing here says what the
// merge should do case by case; the system does.

import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";
import { copyTree, mergeTree, readTree } from "../packages/runtime/dist/tree.js";
import { identityOf } from "../packages/runtime/dist/path-guard.js";

const asRoot = process.getuid?.() === 0; // root may do what permissions forbid: nothing below would be refused

/** Remove a directory whatever it allows. */
function wipe(dir) {
  const open = (at) => {
    const stat = lstatSync(at, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) return;
    chmodSync(at, 0o700);
    for (const name of readdirSync(at)) open(join(at, name));
  };
  open(dir);
  rmSync(dir, { recursive: true, force: true });
}

function scratch(t, prefix = "trama-tree-") {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => wipe(dir));
  return dir;
}

/**
 * A directory as anyone can see it, by the system's own calls and none of the
 * runtime's: every path with what is there. A link is given by where its
 * words lead, read as words (no link on the way is followed), with the
 * directory's own location taken out — two trees in two places are the same
 * if what they say is, and a copy may say the same thing in other words.
 * What a link says to the letter is looked at where it matters, further down.
 */
function describe(root, original = root) {
  const seen = {};
  // What is beside the directory is beside the original: a copy stands for it, wherever the copy is.
  const outer = dirname(original);
  const place = (path) => {
    if (path === root || path.startsWith(root + "/")) return "<root>" + path.slice(root.length);
    if (path === outer || path.startsWith(outer + "/")) return "<beside>" + path.slice(outer.length);
    return path;
  };
  const into = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const at = join(dir, name);
      const stat = lstatSync(at);
      const mode = (stat.mode & 0o7777).toString(8);
      if (stat.isSymbolicLink()) seen[prefix + name] = `link to ${place(resolve(dir, readlinkSync(at)))}`;
      else if (stat.isDirectory()) { seen[prefix + name] = `dir ${mode}`; into(at, `${prefix}${name}/`); }
      else if (stat.isFile()) seen[prefix + name] = `file ${mode} ${stat.mode & 0o400 ? JSON.stringify(readFileSync(at, "utf-8")) : `of ${stat.size} bytes nobody may read`}`;
      else seen[prefix + name] = "other";
    }
  };
  into(root, "");
  return seen;
}

// --- Runs made at random ---

function random(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (list) => list[Math.floor(next() * list.length)];
  return { next, pick };
}

const NAMES = ["a", "b", "c", "d.txt", "e.txt"];
const TEXTS = ["", "AAAA", "BBBB", "a longer piece of text\n", "CC"];
const DIR_MODES = [0o755, 0o755, 0o750, 0o555, 0o500];
const FILE_MODES = [0o644, 0o644, 0o600, 0o444, 0o755, 0o400];
/** What a run may leave a file allowing — and a directory it is copied from may not hold: a file nobody may read cannot be copied. */
const FILE_MODES_OF_A_RUN = [...FILE_MODES, 0o200, 0o000];

/** A path to do something at: more often than not one where something is, or a new name in a directory that is there. */
function somePath(rng, root) {
  const there = describe(root);
  const paths = Object.keys(there);
  if (paths.length > 0 && rng.next() < 0.5) return rng.pick(paths);
  const dir = rng.pick(["", "", ...paths.filter((path) => there[path].startsWith("dir ")).map((path) => `${path}/`)]);
  return dir + rng.pick(NAMES);
}

/**
 * One thing a program might do to its directory, as it stands in `root`.
 * `links` says which kinds of link it may make.
 */
function step(rng, root, links, fileModes = FILE_MODES, inACopy = false) {
  let kind = rng.pick(["write", "write", "write", "append", "remove", "mkdir", "mkdir", "rmdir", "chmod", "chmod", "link", "relink", "rename", "rewrite", "respell"]);
  const p = somePath(rng, root);
  // The one thing a run in a copy does not do as it would directly: move a link that says "..". Where such a
  // link leaves the directory, the copy has it by full path, and it leads from its new place where it led
  // from the old — not where the same words lead from there. (Tested by itself, further down.)
  if (inACopy && kind === "rename" && lstatSync(join(root, p), { throwIfNoEntry: false })?.isSymbolicLink() && readlinkSync(join(root, p)).startsWith("../")) kind = "append";
  return {
    kind, p, q: somePath(rng, root),
    text: rng.pick(TEXTS), dirMode: rng.pick(DIR_MODES), fileMode: rng.pick(fileModes), link: rng.pick(links), name: rng.pick(NAMES),
  };
}

/** Remove what is at a path, in an order that does not depend on the directory's own. Stops at what it may not remove. */
function remove(at) {
  const stat = lstatSync(at);
  if (stat.isDirectory()) {
    for (const name of readdirSync(at).sort()) remove(join(at, name));
    rmdirSync(at);
  } else {
    unlinkSync(at);
  }
}

/** Do one step in a directory, as a program whose directory it is would. What the system refuses is not done. */
function carryOut(root, outside, it) {
  const at = (path) => join(root, path);
  try {
    switch (it.kind) {
      case "write": writeFileSync(at(it.p), it.text); break;
      case "append": appendFileSync(at(it.p), it.text || "+"); break;
      case "remove": remove(at(it.p)); break;
      case "mkdir": mkdirSync(at(it.p)); break;
      case "rmdir": rmdirSync(at(it.p)); break;
      case "rename": renameSync(at(it.p), at(it.q)); break;
      case "respell": { // the same name in other letters: on some file systems the same name, on others another
        const name = basename(it.p);
        const other = join(dirname(at(it.p)), name === name.toLowerCase() ? name.toUpperCase() : name.toLowerCase());
        // Where the file system takes the two for one name, a merge does not carry this (tested by itself, further down).
        if (!lstatSync(other, { throwIfNoEntry: false })) renameSync(at(it.p), other);
        break;
      }
      case "chmod": {
        const stat = lstatSync(at(it.p));
        if (!stat.isSymbolicLink()) chmodSync(at(it.p), stat.isDirectory() ? it.dirMode : it.fileMode);
        break;
      }
      case "rewrite": {
        // Other content of the same length, with the file's times put back: nothing a look at size and time would notice.
        const stat = lstatSync(at(it.p));
        if (!stat.isFile()) break;
        const now = readFileSync(at(it.p), "utf-8");
        writeFileSync(at(it.p), now.replace(/./g, (c) => (c === "z" ? "y" : "z")));
        utimesSync(at(it.p), stat.atime, stat.mtime);
        break;
      }
      case "relink": // a link made to say something else
        if (!lstatSync(at(it.p)).isSymbolicLink()) break;
        unlinkSync(at(it.p));
        // falls through
      case "link": {
        const target = {
          near: basename(it.q),                       // a name beside the link
          up: `../${basename(it.q)}`,                 // one directory up — out of the tree, for a link at the top of it
          full: join(root, it.q),                     // a place in the tree, named from the top of the file system
          away: join(outside, "kept.txt"),            // a place that is not in the tree at all
          round: `../${basename(root)}/${it.q}`,      // out of the tree and back in by its name
          through: `${basename(it.q)}/${it.name}`,    // by way of what is beside the link: a directory, or another link
          fullThrough: join(root, it.q, it.name),     // the same, named from the top of the file system
        }[it.link];
        symlinkSync(target, at(it.p));
        break;
      }
    }
  } catch { /* refused: the same in any copy of this directory */ }
}

/** Whether a path is one that a report covers: the reported path, something under it, or something it is under. */
const covered = (path, unmerged) => unmerged.some((it) => path === it.path || path.startsWith(`${it.path}/`) || it.path.startsWith(`${path}/`));

/**
 * A trial: the same tree made twice, each in a directory of its own — one to
 * be worked in directly, the other to be copied, worked on in the copy, and
 * merged into.
 */
function trial(t, rng) {
  const base = scratch(t);
  const outside = join(base, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "kept.txt"), "KEPT");
  chmodSync(join(outside, "kept.txt"), 0o444);
  chmodSync(outside, 0o555);
  const direct = join(base, "direct", "project");
  const real = join(base, "merged", "project");
  const copy = join(base, "elsewhere", "copy");
  for (const dir of [direct, real, copy]) mkdirSync(dir, { recursive: true });

  for (let n = 0; n < 18; n++) {
    const it = step(rng, direct, ["near", "near", "up", "full", "away", "round", "through", "through", "fullThrough"]);
    for (const root of [direct, real]) carryOut(root, outside, it);
  }
  // A link that cannot be followed is not carried into a copy (see below, where that is tested by itself): a run
  // would not find it there. Such links are taken out of both trees, so that the two runs start from the same.
  const probe = join(base, "probe");
  mkdirSync(probe);
  for (const [path, entry] of copyTree(real, probe)) {
    if (entry.kind !== "other") continue;
    for (const root of [direct, real]) {
      const dir = dirname(join(root, path));
      const { mode } = lstatSync(dir);
      chmodSync(dir, 0o700); // it may be in a directory that is closed
      unlinkSync(join(root, path));
      chmodSync(dir, mode);
    }
  }
  wipe(probe);
  assert.deepEqual(describe(real), describe(direct), "the two trees start the same");
  return { base, outside, direct, real, copy };
}

// More runs than these: TRAMA_TREE_SEEDS=11,12,13 node --test test/tree.test.mjs
const SEEDS = process.env.TRAMA_TREE_SEEDS?.split(",").map(Number) ?? [20261112, 1, 7, 1234567];

for (const seed of SEEDS) {
  test(`a run in a copy, merged back, leaves what the same run leaves working directly (seed ${seed})`, { skip: asRoot }, (t) => {
    const rng = random(seed);
    for (let round = 0; round < 120; round++) {
      const { outside, direct, real, copy } = trial(t, rng);
      const asItWas = describe(real);

      const held = copyTree(real, copy);
      assert.deepEqual(describe(copy, real), asItWas, `round ${round}: the copy holds what the directory holds`);
      const before = readTree(copy);

      // A run does not know it is in a copy, and cannot name it: it makes no link by way of its directory's name.
      const run = [];
      for (let n = 0; n < 14; n++) {
        const it = step(rng, direct, ["near", "up", "full", "away", "through", "fullThrough"], FILE_MODES_OF_A_RUN, true);
        for (const root of [direct, copy]) carryOut(root, outside, it);
        run.push(it);
      }
      assert.deepEqual(describe(real), asItWas, `round ${round}: nothing done in the copy is done to the directory`);

      const unmerged = mergeTree(copy, real, before, held);
      const told = `round ${round}, the run: ${JSON.stringify(run.map(({ kind, p, q, link }) => (kind === "link" ? `${kind}:${link} ${p} -> ${q}` : kind === "rename" ? `${kind} ${p} ${q}` : `${kind} ${p}`)))}`;
      assert.deepEqual(unmerged, [], told);
      const now = describe(real), wanted = describe(direct);
      assert.deepEqual(now, wanted, told);
    }
  });

  test(`what somebody else did to the directory meanwhile is kept, and what could not be merged for it is told (seed ${seed})`, { skip: asRoot }, (t) => {
    const rng = random(seed ^ 0x5eed);
    for (let round = 0; round < 120; round++) {
      const { outside, direct, real, copy } = trial(t, rng);
      const held = copyTree(real, copy);
      const before = readTree(copy);
      const asItWas = describe(real);

      const run = [];
      for (let n = 0; n < 12; n++) {
        const it = step(rng, direct, ["near", "up", "full", "away", "through", "fullThrough"], FILE_MODES_OF_A_RUN, true);
        for (const root of [direct, copy]) carryOut(root, outside, it);
        run.push(it);
      }
      // Meanwhile, in the directory itself.
      const theirs = [];
      for (let n = 1 + Math.floor(rng.next() * 4); n > 0; n--) {
        const it = { ...step(rng, real, ["near"]), kind: rng.pick(["write", "write", "remove", "mkdir", "chmod", "rewrite", "append"]) };
        carryOut(real, outside, it);
        theirs.push(it);
      }
      const asTheyLeftIt = describe(real);
      const touched = new Set([...Object.keys(asItWas), ...Object.keys(asTheyLeftIt)].filter((path) => asItWas[path] !== asTheyLeftIt[path]));

      const unmerged = mergeTree(copy, real, before, held);
      const now = describe(real);
      const wanted = describe(direct);
      const told = `round ${round}\n the run: ${JSON.stringify(run.map(({ kind, p, q }) => `${kind} ${p} ${q}`))}\n theirs: ${JSON.stringify(theirs.map(({ kind, p }) => `${kind} ${p}`))}\n unmerged: ${JSON.stringify(unmerged)}`;
      // What is told not to have arrived is as they left it, there and under it: nothing half done.
      for (const { path } of unmerged) {
        for (const other of new Set([...Object.keys(now), ...Object.keys(asTheyLeftIt)])) {
          if (other !== path && !other.startsWith(`${path}/`)) continue;
          if (now[other] !== asTheyLeftIt[other]) assert.fail(`${path} did not arrive, yet ${other} was ${asTheyLeftIt[other]} and is now ${now[other]}\n${told}`);
        }
      }
      // Theirs stands, whatever the run did at the same place.
      for (const path of touched) {
        if (now[path] !== asTheyLeftIt[path]) assert.fail(`${path} was theirs (${asTheyLeftIt[path]}), and is now ${now[path]}\n${told}`);
      }
      for (const path of new Set([...Object.keys(now), ...Object.keys(wanted)])) {
        if (now[path] === wanted[path]) continue;
        const explained = covered(path, unmerged) || [...touched].some((theirPath) => path === theirPath || path.startsWith(`${theirPath}/`) || theirPath.startsWith(`${path}/`));
        if (!explained) assert.fail(`${path} is ${now[path]}, not ${wanted[path]} as the run left it, and nothing says why\n${told}`);
      }
    }
  });
}

// --- What the random runs do not reach ---

test("a tree is read whole, or not at all: what cannot be looked at is not passed over", { skip: asRoot }, (t) => {
  for (const mode of [0o400, 0o300, 0o000]) {
    const dir = scratch(t);
    mkdirSync(join(dir, "data", "deep"), { recursive: true });
    writeFileSync(join(dir, "data", "a.csv"), "rows");
    assert.equal(readTree(dir).get("data/a.csv").kind, "file");
    chmodSync(join(dir, "data"), mode);
    assert.throws(() => readTree(dir), { code: "EACCES" }, `mode ${mode.toString(8)}`);
  }
});

test("a directory of the copy that cannot be read is not taken for an empty one: nothing is merged, and nothing removed", { skip: asRoot }, (t) => {
  // 0o400 lists its names and will not have them looked at; 0o300 will not list them.
  for (const mode of [0o400, 0o300]) {
    const real = scratch(t), copy = scratch(t);
    mkdirSync(join(real, "data", "deep"), { recursive: true });
    writeFileSync(join(real, "data", "a.csv"), "rows");
    writeFileSync(join(real, "data", "deep", "b.csv"), "more rows");
    const held = copyTree(real, copy);
    const before = readTree(copy);

    // All the run did was close a directory. Its files are still in it.
    chmodSync(join(copy, "data"), mode);
    writeFileSync(join(copy, "elsewhere.txt"), "BY THE RUN");

    const unmerged = mergeTree(copy, real, before, held);
    assert.equal(readFileSync(join(real, "data", "a.csv"), "utf-8"), "rows");
    assert.equal(readFileSync(join(real, "data", "deep", "b.csv"), "utf-8"), "more rows");
    assert.equal(unmerged.length, 1);
    assert.equal(unmerged[0].path, ".");
    assert.match(unmerged[0].why, /could not be read .*none of it was merged/);
    assert.equal(existsSync(join(real, "elsewhere.txt")), false);
  }
});

test("merging returns what did not arrive, and why — and nothing that did", { skip: asRoot }, (t) => {
  const real = scratch(t), copy = scratch(t);
  const names = ["arrives", "changed-meanwhile", "same-meanwhile", "removed", "removed-and-gone", "removed-but-changed"];
  for (const name of names) writeFileSync(join(real, `${name}.txt`), "AS IT WAS");
  mkdirSync(join(real, "sealed"));
  writeFileSync(join(real, "sealed", "inside.txt"), "AS IT WAS");
  const held = copyTree(real, copy);
  const before = readTree(copy);

  // What the run did, in its copy.
  for (const name of ["arrives", "changed-meanwhile", "same-meanwhile"]) writeFileSync(join(copy, `${name}.txt`), "BY THE RUN");
  for (const name of ["removed", "removed-and-gone", "removed-but-changed"]) rmSync(join(copy, `${name}.txt`));
  for (const name of ["new.txt", "new-here-too.txt", "new-same-here.txt", "sealed/new.txt"]) writeFileSync(join(copy, name), "BY THE RUN");

  // What happened in the directory meanwhile. The first is as long as what the run wrote, to the letter.
  writeFileSync(join(real, "changed-meanwhile.txt"), "BY ANOTHER");
  writeFileSync(join(real, "same-meanwhile.txt"), "BY THE RUN");
  rmSync(join(real, "removed-and-gone.txt"));
  writeFileSync(join(real, "removed-but-changed.txt"), "CHANGED BY ANOTHER");
  writeFileSync(join(real, "new-here-too.txt"), "BY ANOTHER");
  writeFileSync(join(real, "new-same-here.txt"), "BY THE RUN");
  chmodSync(join(real, "sealed"), 0o555); // somebody closed it: nothing is to be created here

  const why = Object.fromEntries(mergeTree(copy, real, before, held).map((it) => [it.path, it.why]));
  assert.deepEqual(Object.keys(why).sort(), ["changed-meanwhile.txt", "new-here-too.txt", "removed-but-changed.txt", "sealed/new.txt"]);
  assert.match(why["changed-meanwhile.txt"], /changed or removed in the project meanwhile/);
  assert.match(why["new-here-too.txt"], /something else is at that place/);
  assert.match(why["removed-but-changed.txt"], /the run removed it, but it was changed in the project meanwhile/);
  assert.match(why["sealed/new.txt"], /what sealed allows was changed in the project meanwhile/);

  const now = (name) => (existsSync(join(real, name)) ? readFileSync(join(real, name), "utf-8") : null);
  assert.equal(now("arrives.txt"), "BY THE RUN");
  assert.equal(now("new.txt"), "BY THE RUN");
  assert.equal(now("removed.txt"), null);
  // Another's work is never written over, or removed — and a directory another closed stays closed.
  assert.equal(now("changed-meanwhile.txt"), "BY ANOTHER");
  assert.equal(now("new-here-too.txt"), "BY ANOTHER");
  assert.equal(now("removed-but-changed.txt"), "CHANGED BY ANOTHER");
  assert.equal(now("sealed/new.txt"), null);
  assert.equal(lstatSync(join(real, "sealed")).mode & 0o777, 0o555);
});

test("a directory the run opened, changed and closed again is left closed, with the change in it", { skip: asRoot }, (t) => {
  const real = scratch(t), copy = scratch(t);
  mkdirSync(join(real, "sealed", "deep"), { recursive: true });
  for (const name of ["old.txt", "kept.txt", "deep/old.txt"]) writeFileSync(join(real, "sealed", name), "AS IT WAS", { mode: 0o444 });
  chmodSync(join(real, "sealed", "deep"), 0o555);
  chmodSync(join(real, "sealed"), 0o555);
  const held = copyTree(real, copy);
  const before = readTree(copy);

  // It is where the run ended that is carried over, not the steps by which it got there.
  chmodSync(join(copy, "sealed"), 0o755);
  chmodSync(join(copy, "sealed", "deep"), 0o755);
  rmSync(join(copy, "sealed", "old.txt"));
  rmSync(join(copy, "sealed", "deep"), { recursive: true });
  rmSync(join(copy, "sealed", "kept.txt"));
  writeFileSync(join(copy, "sealed", "kept.txt"), "BY THE RUN", { mode: 0o444 });
  writeFileSync(join(copy, "sealed", "new.txt"), "BY THE RUN");
  chmodSync(join(copy, "sealed"), 0o555);

  assert.deepEqual(mergeTree(copy, real, before, held), []);
  assert.deepEqual(describe(real), describe(copy));
  assert.equal(lstatSync(join(real, "sealed")).mode & 0o777, 0o555);
  assert.deepEqual(readdirSync(join(real, "sealed")).sort(), ["kept.txt", "new.txt"]);
});

test("nothing is removed to make room for what cannot be put there — not under it either", (t) => {
  const real = scratch(t), copy = scratch(t);
  writeFileSync(join(real, "becomes-a-pipe.txt"), "PRECIOUS");
  mkdirSync(join(real, "cache", "deep"), { recursive: true });
  for (const name of ["a.db", "deep/b.db"]) writeFileSync(join(real, "cache", name), "PRECIOUS");
  const held = copyTree(real, copy);
  const before = readTree(copy);
  rmSync(join(copy, "becomes-a-pipe.txt"));
  execFileSync("mkfifo", [join(copy, "becomes-a-pipe.txt")]);
  rmSync(join(copy, "cache"), { recursive: true });
  execFileSync("mkfifo", [join(copy, "cache")]);
  const asItWas = describe(real);

  const why = Object.fromEntries(mergeTree(copy, real, before, held).map((it) => [it.path, it.why]));
  assert.deepEqual(Object.keys(why).sort(), ["becomes-a-pipe.txt", "cache"]);
  for (const path of Object.keys(why)) assert.match(why[path], /a pipe, a socket or a device/);
  assert.deepEqual(describe(real), asItWas);
});

test("a link the run made by a full path that goes round in a circle is the same circle in the directory", (t) => {
  const real = scratch(t), copy = scratch(t);
  writeFileSync(join(real, "becomes-a-loop.txt"), "as it was");
  const held = copyTree(real, copy);
  const before = readTree(copy);
  rmSync(join(copy, "becomes-a-loop.txt"));
  symlinkSync(join(copy, "becomes-a-loop.txt", "on"), join(copy, "becomes-a-loop.txt")); // the way to what it names goes through itself
  assert.deepEqual(mergeTree(copy, real, before, held), []);
  assert.equal(readlinkSync(join(real, "becomes-a-loop.txt")), join(real, "becomes-a-loop.txt", "on"));
});

test("a link the run made to say something else says it in the directory too", (t) => {
  const real = scratch(t), copy = scratch(t);
  for (const name of ["one.txt", "two.txt"]) writeFileSync(join(real, name), name);
  symlinkSync("one.txt", join(real, "current"));
  const held = copyTree(real, copy);
  const before = readTree(copy);
  rmSync(join(copy, "current"));
  symlinkSync("two.txt", join(copy, "current"));
  assert.deepEqual(mergeTree(copy, real, before, held), []);
  assert.equal(readlinkSync(join(real, "current")), "two.txt");
});

test("what a copy is told to leave out is neither copied nor known of", (t) => {
  const real = scratch(t), copy = scratch(t);
  mkdirSync(join(real, "logs", "journal"), { recursive: true });
  writeFileSync(join(real, "logs", "journal", "run.jsonl"), "{}");
  writeFileSync(join(real, "logs", "latest.jsonl"), "{}");
  const journal = identityOf(join(real, "logs", "journal"));
  const held = copyTree(real, copy, (at) => identityOf(at) === journal);
  assert.deepEqual([...held.keys()].sort(), ["logs", "logs/latest.jsonl"]);
  assert.deepEqual(readdirSync(join(copy, "logs")), ["latest.jsonl"]);
});

test("a merge keeps to the directory when a directory above the place was made a link meanwhile", (t) => {
  const real = scratch(t), copy = scratch(t), outside = scratch(t);
  mkdirSync(join(real, "a", "b"), { recursive: true });
  writeFileSync(join(real, "a", "b", "old.txt"), "AS IT WAS");
  const held = copyTree(real, copy);
  const before = readTree(copy);
  writeFileSync(join(copy, "a", "b", "new.txt"), "from the run");
  writeFileSync(join(copy, "a", "b", "old.txt"), "from the run");

  // Meanwhile "a" is moved out and a link put where it was: outside there is the same "b", with the same file in it.
  renameSync(join(real, "a"), join(outside, "a"));
  symlinkSync(join(outside, "a"), join(real, "a"));

  const unmerged = mergeTree(copy, real, before, held);
  assert.deepEqual(unmerged.map((it) => it.path).sort(), ["a/b/new.txt", "a/b/old.txt"]);
  assert.deepEqual(readdirSync(join(outside, "a", "b")), ["old.txt"]);
  assert.equal(readFileSync(join(outside, "a", "b", "old.txt"), "utf-8"), "AS IT WAS");
});

test("what cannot arrive is found out before anything is done: nothing under a directory somebody else changed is touched", (t) => {
  const real = scratch(t), copy = scratch(t);
  mkdirSync(join(real, "g", "p", "dir-to-file", "deep"), { recursive: true });
  mkdirSync(join(real, "g", "p", "dir-to-link"));
  mkdirSync(join(real, "cache", "deep", "deeper"), { recursive: true });
  for (const file of ["g/p/dir-to-file/deep/b.db", "g/p/dir-to-link/a.db", "g/p/file-to-dir", "g/p/file-to-link", "g/p/removed", "cache/a.db", "cache/deep/b.db", "cache/deep/deeper/c.db"]) writeFileSync(join(real, file), "PRECIOUS");
  symlinkSync("file-to-link", join(real, "g", "p", "link-to-dir"));
  const held = copyTree(real, copy);
  const before = readTree(copy);

  const at = (path) => join(copy, path);
  chmodSync(at("g"), 0o700);
  rmSync(at("g/p/dir-to-file"), { recursive: true }); writeFileSync(at("g/p/dir-to-file"), "a file now");
  rmSync(at("g/p/dir-to-link"), { recursive: true }); symlinkSync("removed", at("g/p/dir-to-link"));
  rmSync(at("g/p/file-to-dir")); mkdirSync(at("g/p/file-to-dir"));
  rmSync(at("g/p/link-to-dir")); mkdirSync(at("g/p/link-to-dir"));
  rmSync(at("g/p/file-to-link")); symlinkSync("removed", at("g/p/file-to-link"));
  rmSync(at("g/p/removed"));
  chmodSync(at("g/p"), 0o750);
  rmSync(at("cache"), { recursive: true }); writeFileSync(at("cache"), "a file now");

  // Meanwhile somebody else changes what two directories allow — the two the run changed, or replaced.
  chmodSync(join(real, "g"), 0o750);
  chmodSync(join(real, "cache"), 0o700);
  // (And something under one of them, which would not have arrived by itself either: it is not told twice.)
  writeFileSync(join(real, "g", "p", "removed"), "CHANGED BY ANOTHER");
  const asTheyLeftIt = describe(real);

  const unmerged = mergeTree(copy, real, before, held);
  assert.deepEqual(unmerged.map((it) => it.path).sort(), ["cache", "g"]);
  assert.deepEqual(describe(real), asTheyLeftIt);
});

test("a directory the run removed goes whole or stays whole", (t) => {
  const real = scratch(t), copy = scratch(t);
  for (const dir of ["theirs-changed", "theirs-added", "goes"]) {
    mkdirSync(join(real, dir, "deep"), { recursive: true });
    for (const file of ["a.txt", "deep/b.txt"]) writeFileSync(join(real, dir, file), "as it was");
  }
  const held = copyTree(real, copy);
  const before = readTree(copy);
  for (const dir of ["theirs-changed", "theirs-added", "goes"]) rmSync(join(copy, dir), { recursive: true });
  writeFileSync(join(real, "theirs-changed", "deep", "b.txt"), "CHANGED BY ANOTHER");
  writeFileSync(join(real, "theirs-added", "deep", "new.txt"), "ADDED BY ANOTHER");
  const asTheyLeftIt = describe(real);

  const why = Object.fromEntries(mergeTree(copy, real, before, held).map((it) => [it.path, it.why]));
  assert.deepEqual(Object.keys(why).sort(), ["theirs-added", "theirs-added/deep", "theirs-changed", "theirs-changed/deep", "theirs-changed/deep/b.txt"]);
  assert.match(why["theirs-changed/deep/b.txt"], /the run removed it, but it was changed in the project meanwhile/);
  assert.match(why["theirs-changed"], /not all that is in it can go \(theirs-changed\/deep/);
  assert.match(why["theirs-added/deep"], /holds something in the project that is not removed with it \(new\.txt\)/);
  const now = describe(real);
  assert.equal(now.goes, undefined);
  for (const path of Object.keys(asTheyLeftIt)) if (!path.startsWith("goes")) assert.equal(now[path], asTheyLeftIt[path], path);
});

test("a name the run spelled in other letters, where the file system takes the two for one name, is left as it was — and told", (t) => {
  const make = (dir) => {
    writeFileSync(join(dir, "notes.txt"), "PRECIOUS");
    writeFileSync(join(dir, "draft.txt"), "PRECIOUS");
    mkdirSync(join(dir, "d")); writeFileSync(join(dir, "d", "x"), "PRECIOUS");
    mkdirSync(join(dir, "Dir", "Sub"), { recursive: true }); writeFileSync(join(dir, "Dir", "Sub", "x"), "PRECIOUS");
    writeFileSync(join(dir, "other.txt"), "as it was");
  };
  const run = (dir) => {
    renameSync(join(dir, "notes.txt"), join(dir, "Notes.txt"));
    renameSync(join(dir, "draft.txt"), join(dir, "Draft.txt")); writeFileSync(join(dir, "Draft.txt"), "rewritten");
    rmSync(join(dir, "d"), { recursive: true }); writeFileSync(join(dir, "D"), "a file now");
    renameSync(join(dir, "Dir"), join(dir, "dir")); writeFileSync(join(dir, "dir", "Sub", "new"), "new");
    writeFileSync(join(dir, "other.txt"), "by the run");
  };
  const direct = scratch(t), real = scratch(t), copy = scratch(t);
  make(direct); make(real);
  const asItWas = describe(real);
  const oneName = existsSync(join(real, "NOTES.TXT"));
  run(direct);
  const held = copyTree(real, copy);
  const before = readTree(copy);
  run(copy);
  const unmerged = mergeTree(copy, real, before, held);
  const now = describe(real);
  assert.equal(now["other.txt"], 'file 644 "by the run"');
  if (!oneName) {
    // A file system that tells the spellings apart: they are other names, and this was any renaming.
    assert.deepEqual(unmerged, []);
    return assert.deepEqual(now, describe(direct));
  }
  // To a tree these are an entry removed and an entry made. Here they are one place: removing the one removes the other.
  assert.deepEqual(unmerged.map((it) => it.path).sort(), ["D", "Dir", "Draft.txt", "Notes.txt", "d", "dir", "draft.txt", "notes.txt"]);
  for (const it of unmerged) assert.match(it.why, /takes the two for one name: it is left as it was|not all that is in it can go/, it.path);
  delete now["other.txt"]; delete asItWas["other.txt"];
  assert.deepEqual(now, asItWas);
});

test("a directory the run removed that holds the path somebody else puts in place stays whole", (t) => {
  const real = scratch(t), copy = scratch(t);
  mkdirSync(join(real, "d", "sub"), { recursive: true });
  for (const file of ["d/sub/program.ts", "d/sub/a", "d/b"]) writeFileSync(join(real, file), "as it was");
  const held = copyTree(real, copy);
  const before = readTree(copy);
  rmSync(join(copy, "d"), { recursive: true });
  const asItWas = describe(real);
  const unmerged = mergeTree(copy, real, before, held, "d/sub/program.ts");
  assert.deepEqual(unmerged.map((it) => it.path).sort(), ["d", "d/sub"]);
  assert.match(unmerged.find((it) => it.path === "d/sub").why, /holds something in the project that is not removed with it \(program\.ts\)/);
  assert.deepEqual(describe(real), asItWas);
});

test("where the real directory came to be as the run left it by another road, nothing is reported", (t) => {
  // In each of these somebody else did what the run did — or enough of it that nothing of the run's is left to do.
  const cases = {
    "both put the same file where a directory was": [(dir) => { mkdirSync(join(dir, "d")); writeFileSync(join(dir, "d", "x"), "x"); },
      (dir) => { rmSync(join(dir, "d"), { recursive: true }); writeFileSync(join(dir, "d"), "a file now"); }, null],
    "both put the same link where a directory was": [(dir) => { mkdirSync(join(dir, "d")); writeFileSync(join(dir, "d", "x"), "x"); },
      (dir) => { rmSync(join(dir, "d"), { recursive: true }); symlinkSync("elsewhere", join(dir, "d")); }, null],
    "the run removed a file, they removed the directory it was in": [(dir) => { mkdirSync(join(dir, "c", "sub"), { recursive: true }); writeFileSync(join(dir, "c", "sub", "x"), "x"); },
      (dir) => rmSync(join(dir, "c", "sub", "x")), (dir) => rmSync(join(dir, "c", "sub"), { recursive: true })],
    "both made the same directory with the same file": [() => {},
      (dir) => { mkdirSync(join(dir, "n")); writeFileSync(join(dir, "n", "x"), "x"); }, null],
  };
  for (const [name, [make, run, theirs]] of Object.entries(cases)) {
    const real = scratch(t), copy = scratch(t);
    make(real);
    const held = copyTree(real, copy);
    const before = readTree(copy);
    run(copy);
    (theirs ?? run)(real);
    const asTheyLeftIt = describe(real);
    assert.deepEqual(mergeTree(copy, real, before, held), [], name);
    assert.deepEqual(describe(real), asTheyLeftIt, name);
  }
});

test("into a directory both made, what the run made besides goes in beside theirs", (t) => {
  const real = scratch(t), copy = scratch(t);
  const held = copyTree(real, copy);
  const before = readTree(copy);
  for (const dir of [copy, real]) mkdirSync(join(dir, "n", "sub"), { recursive: true });
  writeFileSync(join(copy, "n", "one"), "from the run");
  writeFileSync(join(copy, "n", "sub", "two"), "from the run");
  writeFileSync(join(real, "n", "sub", "theirs"), "THEIRS");
  writeFileSync(join(real, "n", "one"), "THEIRS");
  const unmerged = mergeTree(copy, real, before, held);
  assert.deepEqual(unmerged.map((it) => it.path), ["n/one"]);
  assert.match(unmerged[0].why, /something else is at that place/);
  assert.equal(readFileSync(join(real, "n", "one"), "utf-8"), "THEIRS");
  assert.deepEqual(readdirSync(join(real, "n", "sub")).sort(), ["theirs", "two"]);
});

test("a directory the system will not let be opened is told of itself, not only of what is in it", { skip: asRoot || process.platform !== "darwin" }, (t) => {
  const real = scratch(t), copy = scratch(t);
  mkdirSync(join(real, "d")); writeFileSync(join(real, "d", "x"), "x");
  chmodSync(join(real, "d"), 0o555);
  const held = copyTree(real, copy);
  const before = readTree(copy);
  chmodSync(join(copy, "d"), 0o755); rmSync(join(copy, "d", "x")); chmodSync(join(copy, "d"), 0o500);
  execFileSync("chflags", ["uchg", join(real, "d")]); // not to be changed, by anyone
  let unmerged;
  try {
    unmerged = mergeTree(copy, real, before, held);
  } finally {
    execFileSync("chflags", ["nouchg", join(real, "d")]);
  }
  assert.deepEqual(unmerged.map((it) => it.path).sort(), ["d", "d/x"]);
  assert.equal(lstatSync(join(real, "d")).mode & 0o777, 0o555);
});

test("the directory is known as it was when it was copied: what appears in it during the copy is not taken for the run's own", (t) => {
  const real = scratch(t), copy = scratch(t);
  writeFileSync(join(real, "old.txt"), "o");
  // Somebody makes a file while the copy is being made: here, the moment the walk comes to old.txt.
  const held = copyTree(real, copy, (at) => {
    if (at.endsWith("old.txt")) writeFileSync(join(real, "late.txt"), "V1");
    return false;
  });
  const before = readTree(copy);
  assert.equal(before.has("late.txt"), held.has("late.txt"), "what the copy holds is what is known of the directory");

  writeFileSync(join(real, "late.txt"), "V2 - theirs");
  writeFileSync(join(copy, "late.txt"), "what the run wrote");
  const unmerged = mergeTree(copy, real, before, held);
  assert.equal(readFileSync(join(real, "late.txt"), "utf-8"), "V2 - theirs");
  assert.deepEqual(unmerged.map((it) => it.path), ["late.txt"]);
});

test("a path that somebody else puts in place is no part of the merge, whatever the run did to it", (t) => {
  const real = scratch(t), copy = scratch(t);
  writeFileSync(join(real, "program.ts"), "AAAA");
  writeFileSync(join(real, "data.txt"), "d");
  const held = copyTree(real, copy);
  writeFileSync(join(copy, "program.ts"), "BBBB");
  const before = readTree(copy);
  rmSync(join(copy, "program.ts")); // the run removes its own program
  writeFileSync(join(real, "program.ts"), "BBBB"); // …which has meanwhile been installed in the directory
  assert.deepEqual(mergeTree(copy, real, before, held, "program.ts"), []);
  assert.equal(readFileSync(join(real, "program.ts"), "utf-8"), "BBBB");
});

test("what is not content is not carried into a copy, and nothing is merged over it", (t) => {
  const real = scratch(t), copy = scratch(t);
  execFileSync("mkfifo", [join(real, "pipe")]);
  symlinkSync("loop/on", join(real, "loop")); // the way to what it names goes through itself
  symlinkSync(join(real, "not-yet") + "/", join(real, "to-come")); // cannot be followed while not-yet is not there
  symlinkSync("itself", join(real, "itself")); // names a place all the same — its own — and is a link like any other
  writeFileSync(join(real, "file.txt"), "f");
  const held = copyTree(real, copy);
  assert.deepEqual(readdirSync(copy).sort(), ["file.txt", "itself"]);
  for (const name of ["pipe", "loop", "to-come"]) assert.equal(held.get(name).kind, "other", name);

  const before = readTree(copy);
  for (const name of ["pipe", "loop", "to-come"]) writeFileSync(join(copy, name), "BY THE RUN");
  const unmerged = mergeTree(copy, real, before, held);
  assert.deepEqual(unmerged.map((it) => it.path).sort(), ["loop", "pipe", "to-come"]);
  for (const it of unmerged) assert.match(it.why, /something else is at that place/);
  assert.equal(lstatSync(join(real, "pipe")).isFIFO(), true);
  assert.equal(readlinkSync(join(real, "loop")), "loop/on");
});

test("no link in a copy leads back into the directory it is a copy of", (t) => {
  const base = scratch(t);
  const real = join(base, "project"), copy = join(base, "copy");
  mkdirSync(join(real, "data"), { recursive: true });
  mkdirSync(copy);
  writeFileSync(join(real, "data", "x.txt"), "X");
  writeFileSync(join(base, "beside.txt"), "BESIDE");
  symlinkSync(join(real, "data"), join(real, "by-full-path"));
  symlinkSync(join(real, "data") + "/", join(real, "by-full-path-slash"));
  symlinkSync("../project/data", join(real, "out-and-back"));
  symlinkSync("../../project/data/x.txt", join(real, "data", "deeper-out-and-back"));
  symlinkSync("data", join(real, "plain"));
  symlinkSync("../beside.txt", join(real, "outward"));
  symlinkSync(join(real, "not-there-yet"), join(real, "to-nothing"));
  copyTree(real, copy);

  // Kept as written where that leads to the same place; rewritten where it does not.
  assert.equal(readlinkSync(join(copy, "plain")), "data");
  assert.equal(readFileSync(join(copy, "outward"), "utf-8"), "BESIDE");
  for (const name of ["by-full-path", "by-full-path-slash", "out-and-back", "plain"]) {
    assert.equal(realpathSync(join(copy, name)), join(copy, "data"), name);
    writeFileSync(join(copy, name, "written.txt"), "IN THE COPY");
    rmSync(join(copy, "data", "written.txt"));
  }
  assert.equal(realpathSync(join(copy, "data", "deeper-out-and-back")), join(copy, "data", "x.txt"));
  writeFileSync(join(copy, "to-nothing"), "IN THE COPY");
  assert.equal(existsSync(join(real, "not-there-yet")), false);
  assert.deepEqual(readdirSync(join(real, "data")).sort(), ["deeper-out-and-back", "x.txt"]);
});

test("a link to a link is copied as that: the chain is not cut short", (t) => {
  const base = scratch(t);
  const real = join(base, "project"), copy = join(base, "copy");
  mkdirSync(real); mkdirSync(copy);
  for (const name of ["one.txt", "two.txt"]) writeFileSync(join(real, name), name);
  symlinkSync("one.txt", join(real, "current"));
  symlinkSync(join(real, "current"), join(real, "by-full-path")); // a link to the link
  const held = copyTree(real, copy);
  assert.equal(readlinkSync(join(copy, "by-full-path")), join(copy, "current"));
  // So that when the run points the one somewhere else, the other follows — in the copy as in the directory.
  const before = readTree(copy);
  rmSync(join(copy, "current"));
  symlinkSync("two.txt", join(copy, "current"));
  assert.equal(readFileSync(join(copy, "by-full-path"), "utf-8"), "two.txt");
  assert.deepEqual(mergeTree(copy, real, before, held), []);
  assert.equal(readFileSync(join(real, "by-full-path"), "utf-8"), "two.txt");
  assert.equal(readlinkSync(join(real, "by-full-path")), join(real, "current"));
});

test("a link by way of another link stays by way of it: when the run points the one elsewhere, the other follows", (t) => {
  const make = (dir) => {
    for (const version of ["v1", "v2"]) {
      mkdirSync(join(dir, "releases", version), { recursive: true });
      writeFileSync(join(dir, "releases", version, "status"), `${version}: as it was`);
    }
    symlinkSync(join(dir, "releases", "v1"), join(dir, "current")); // by full path, as `ln -s "$PWD/releases/v1" current` makes it
    symlinkSync("current/status", join(dir, "status"));              // by way of it
    symlinkSync(join(dir, "current", "status"), join(dir, "status-by-full-path")); // by way of it too
  };
  const run = (dir) => {
    unlinkSync(join(dir, "current"));
    symlinkSync("releases/v2", join(dir, "current"));
    writeFileSync(join(dir, "status"), "live");
  };
  const direct = scratch(t), real = scratch(t), copy = scratch(t);
  make(direct); make(real);
  run(direct);
  const held = copyTree(real, copy);
  assert.equal(readlinkSync(join(copy, "status")), "current/status");
  assert.equal(readlinkSync(join(copy, "current")), join(copy, "releases", "v1"));
  assert.equal(readlinkSync(join(copy, "status-by-full-path")), join(copy, "current", "status"), "only the part that is the directory is replaced");
  const before = readTree(copy);
  run(copy);
  assert.equal(readFileSync(join(copy, "status-by-full-path"), "utf-8"), "live");
  assert.deepEqual(mergeTree(copy, real, before, held), []);
  assert.deepEqual(describe(real), describe(direct));
});

test("a link that leaves the directory and is led back into it by a link outside leads, in a copy, into the copy", (t) => {
  const base = scratch(t);
  const real = join(base, "project"), copy = join(base, "elsewhere", "copy");
  mkdirSync(join(real, "data"), { recursive: true });
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(real, "data", "x.txt"), "X");
  symlinkSync(real, join(base, "alias"));                       // outside: the directory by another name
  symlinkSync(join(real, "data"), join(base, "current-data"));  // outside: a place in the directory
  symlinkSync(join(base, "alias"), join(real, "self"));
  symlinkSync("../current-data", join(real, "cur"));
  symlinkSync(join(base, "current-data", "x.txt"), join(real, "x-by-the-way"));
  // Out by a link of the directory's own — which is no step out over its top — and back in by the directory's name.
  mkdirSync(join(base, "sub"));
  symlinkSync(join(base, "sub"), join(real, "out"));
  symlinkSync("out/../project/data", join(real, "round-about"));
  // And by full path, by way of the directory, out over its top: that is a place beside the directory, not beside the copy.
  writeFileSync(join(base, "beside.txt"), "BESIDE");
  symlinkSync(`${real}/../beside.txt`, join(real, "beside-by-full-path"));
  const asItWas = describe(real);
  copyTree(real, copy);
  assert.equal(realpathSync(join(copy, "self")), copy);
  assert.equal(realpathSync(join(copy, "cur")), join(copy, "data"));
  assert.equal(realpathSync(join(copy, "x-by-the-way")), join(copy, "data", "x.txt"));
  assert.equal(realpathSync(join(copy, "round-about")), join(copy, "data"));
  assert.equal(realpathSync(join(copy, "out")), join(base, "sub"), "a link out of the directory leads where it led");
  assert.equal(readFileSync(join(copy, "beside-by-full-path"), "utf-8"), "BESIDE");
  for (const path of ["self/data/leak1.txt", "cur/leak2.txt", "x-by-the-way", "round-about/leak3.txt"]) writeFileSync(join(copy, path), "IN THE COPY");
  assert.deepEqual(describe(real), asItWas);
});

test("a link the run made by its directory's full path keeps what it says beyond the directory, whatever is on the way", (t) => {
  const base = scratch(t);
  const real = join(base, "project"), copy = join(base, "copy"), datasets = join(base, "datasets");
  for (const dir of [real, copy, datasets]) mkdirSync(dir);
  symlinkSync(datasets, join(real, "data")); // a link out of the directory
  const held = copyTree(real, copy);
  const before = readTree(copy);
  symlinkSync(join(copy, "data", "current.csv"), join(copy, "latest")); // = symlink(path.resolve("data/current.csv"), "latest")
  assert.deepEqual(mergeTree(copy, real, before, held), []);
  assert.equal(readlinkSync(join(real, "latest")), join(real, "data", "current.csv"));
});

test("a file with two names in the directory that differ only as the copy's file system does not tell apart is not copied as one", { skip: asRoot }, (t) => {
  const real = scratch(t), copy = scratch(t);
  writeFileSync(join(real, "Makefile"), "A");
  writeFileSync(join(real, "makefile"), "B");
  if (readdirSync(real).length === 1) return t.skip("this file system takes the two names for one itself");
  // Not reachable here without a second volume: a directory that tells the names apart, copied to one that does not.
  copyTree(real, copy);
  assert.deepEqual(readdirSync(copy).sort(), ["Makefile", "makefile"]);
});

test("a directory somebody else made where the run made one is theirs: one that allows something else is not taken for the run's", (t) => {
  const real = scratch(t), copy = scratch(t);
  const held = copyTree(real, copy);
  const before = readTree(copy);
  for (const name of ["same", "other"]) { mkdirSync(join(copy, name), { mode: 0o755 }); chmodSync(join(copy, name), 0o755); writeFileSync(join(copy, name, "f.txt"), "from the run"); }
  mkdirSync(join(real, "same")); chmodSync(join(real, "same"), 0o755);
  mkdirSync(join(real, "other")); chmodSync(join(real, "other"), 0o700);
  const unmerged = mergeTree(copy, real, before, held);
  assert.deepEqual(unmerged.map((it) => it.path), ["other"]);
  assert.equal(readFileSync(join(real, "same", "f.txt"), "utf-8"), "from the run");
  assert.deepEqual(readdirSync(join(real, "other")), []);
  assert.equal(lstatSync(join(real, "other")).mode & 0o777, 0o700);
});

test("a file that may be written into is written into: it stays the file it was", (t) => {
  const real = scratch(t), copy = scratch(t);
  writeFileSync(join(real, "kept.txt"), "as it was");
  writeFileSync(join(real, "sealed.txt"), "as it was", { mode: 0o444 });
  const was = lstatSync(join(real, "kept.txt")).ino;
  const held = copyTree(real, copy);
  const before = readTree(copy);
  writeFileSync(join(copy, "kept.txt"), "by the run");
  rmSync(join(copy, "sealed.txt")); writeFileSync(join(copy, "sealed.txt"), "by the run", { mode: 0o444 });
  assert.deepEqual(mergeTree(copy, real, before, held), []);
  assert.equal(lstatSync(join(real, "kept.txt")).ino, was, "a second name for the file, if it has one, still names it");
  assert.equal(readFileSync(join(real, "kept.txt"), "utf-8"), "by the run");
  assert.equal(readFileSync(join(real, "sealed.txt"), "utf-8"), "by the run");
});

test("what goes from a directory while it is being copied is not in the copy, and is not an error", (t) => {
  const real = scratch(t), copy = scratch(t);
  for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(real, name), name);
  mkdirSync(join(real, "d"));
  writeFileSync(join(real, "d", "inside.txt"), "i");
  let done = false;
  const held = copyTree(real, copy, () => {
    // The moment the copy starts: two files and a directory go.
    if (!done) { done = true; for (const name of ["a.txt", "b.txt", "c.txt"].slice(0, 2)) rmSync(join(real, name)); rmSync(join(real, "d"), { recursive: true }); }
    return false;
  });
  assert.deepEqual(describe(copy), describe(real));
  assert.deepEqual([...held.keys()].filter((path) => !existsSync(join(copy, path))), []);
});

test("where the real directory already is as the run left it, nothing is done and nothing reported — whoever made it so", (t) => {
  const real = scratch(t), copy = scratch(t);
  writeFileSync(join(real, "was-a-file"), "f");
  mkdirSync(join(real, "closed"));
  const held = copyTree(real, copy);
  const before = readTree(copy);
  const run = (dir) => { rmSync(join(dir, "was-a-file")); mkdirSync(join(dir, "was-a-file")); chmodSync(join(dir, "was-a-file"), 0o750); chmodSync(join(dir, "closed"), 0o500); };
  writeFileSync(join(copy, "closed", "new.txt"), "from the run");
  run(copy);
  run(real); // somebody did the very same, meanwhile
  assert.deepEqual(mergeTree(copy, real, before, held), []);
  assert.equal(lstatSync(join(real, "was-a-file")).isDirectory(), true);
  assert.equal(lstatSync(join(real, "closed")).mode & 0o777, 0o500);
  assert.equal(readFileSync(join(real, "closed", "new.txt"), "utf-8"), "from the run");
});

// --- Links, held against the system ---
//
// What a link in a copy must say is worked out by the runtime's own reading of
// links. Whether it worked it out right is asked of the system: where the
// system takes a link of the directory, it must take the copy's link to the
// same place — in the copy, if that place is in the directory — and nothing
// written through any link of the copy may land in the directory.

/** What tells the thing at a path from every other — by the system's word, not the runtime's. */
function placeAt(path) {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  return stat && `${stat.dev}:${stat.ino}`;
}

/** What a path says after the directory it is in, if it is in it — whatever name it knows the directory by. */
function within(path, dir) {
  const is = placeAt(dir);
  for (let at = path; ; at = dirname(at)) {
    if (placeAt(at) === is) return path.slice(at.length);
    if (at === dirname(at)) return undefined;
  }
}

for (const seed of SEEDS) {
  test(`links in a copy lead where the directory's lead, and never into the directory (seed ${seed})`, { skip: asRoot }, (t) => {
    const rng = random(seed ^ 0x11c5);
    for (let round = 0; round < 150; round++) {
      const base = scratch(t);
      const real = join(base, "proj"), copy = join(base, "elsewhere", "copy"), out = join(base, "out");
      for (const dir of [join(real, "d0"), join(real, "d1", "d2"), copy, join(out, "sub")]) mkdirSync(dir, { recursive: true });
      for (const file of [join(real, "f.txt"), join(real, "d0", "g.txt"), join(real, "d1", "d2", "h.txt"), join(out, "o.txt")]) writeFileSync(file, "as it was");
      symlinkSync(real, join(base, "alias")); // outside: the directory by another name
      const otherLetters = existsSync(join(base, "PROJ")) ? ["PROJ"] : []; // a file system that takes the two for one name
      const otherWays = ["/System/Volumes/Data"].map((volume) => volume + real).filter((path) => existsSync(path)); // macOS: the same place by another way down

      const names = ["d0", "d1", "d2", "f.txt", "g.txt", "sub", "..", "..", ".", "proj", "out", "alias", "l0", "l1", "l2", "l3", "l4", "l5", "o0", "o1", ...otherLetters];
      const words = () => {
        const steps = Array.from({ length: 1 + Math.floor(rng.next() * 4) }, () => rng.pick(names));
        const said = steps.join(rng.next() < 0.1 ? "//" : "/") + (rng.next() < 0.1 ? "/" : "");
        const from = rng.pick(["", "", "", real, real, join(base, "alias"), out, ...otherLetters.map((name) => join(base, name)), ...otherWays]);
        return from ? `${from}/${said}` : said;
      };
      const links = [];
      for (let n = 0; n < 6; n++) {
        const path = join(rng.pick(["", "", "d0", "d1", "d1/d2"]), `l${n}`);
        symlinkSync(words(), join(real, path));
        links.push(path);
      }
      for (const name of ["o0", "o1"]) symlinkSync(words(), join(out, name));

      const asItWas = describe(real);
      const held = copyTree(real, copy);
      const allCarried = [...held.values()].every((entry) => entry.kind !== "other");
      const told = () => `round ${round}: ${JSON.stringify(Object.fromEntries([...links.map((path) => [path, readlinkSync(join(real, path))]), ...["o0", "o1"].map((name) => [`<out>/${name}`, readlinkSync(join(out, name))])]))}`;

      for (const path of links) {
        let leads;
        try { leads = realpathSync.native(join(real, path)); } catch { continue; } // to nothing, or nowhere the system will go
        if (!allCarried) continue; // a link on its way may be one that could not be carried
        // The place, not its name: the system may know one place by several (the directory in other letters, or by another way down).
        const inside = within(leads, real);
        const wanted = inside === undefined ? leads : copy + inside;
        let found;
        try { found = realpathSync.native(join(copy, path)); } catch (err) { found = err.code; }
        assert.equal(placeAt(found), placeAt(wanted), `${path} leads to ${found}, not ${wanted}\n${told()}`);
      }
      // Written through, wherever that lands — as long as it lands in this test's own directory: a link may
      // lead anywhere above it, and what is found out here is only whether it leads into the directory copied.
      const lands = (path) => {
        try { return realpathSync.native(path); } catch { /* nothing there yet */ }
        try {
          const to = resolve(dirname(path), readlinkSync(path));
          return lstatSync(to, { throwIfNoEntry: false }) ? undefined : join(realpathSync.native(dirname(to)), basename(to));
        } catch { return undefined; }
      };
      for (const path of links) {
        const at = join(copy, path);
        if (!lstatSync(at, { throwIfNoEntry: false })) continue;
        const to = lands(at);
        for (const [through, place] of [[at, to], [join(at, "written.txt"), to && join(to, "written.txt")]]) {
          if (place === undefined || !place.startsWith(base + "/")) continue;
          try { writeFileSync(through, "WRITTEN IN THE COPY"); } catch { /* a directory, or nothing there to write through */ }
        }
      }
      assert.deepEqual(describe(real), asItWas, `something written through a link of the copy is in the directory\n${told()}`);
    }
  });
}

test("a way back into the directory under another of its names is a way back into it", (t) => {
  const base = scratch(t);
  const real = join(base, "proj"), copy = join(base, "elsewhere", "copy");
  mkdirSync(join(real, "sub"), { recursive: true });
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(real, "sub", "f.txt"), "original");
  symlinkSync(real, join(base, "alias"));
  symlinkSync("..", join(real, "up"));
  const links = { "by-a-link-outside": "up/alias/sub", "by-full-path-twice": `${real}/../alias/sub`, "slashes": `${real}//sub`, "slashes-by-a-link": `${base}/alias//sub/` };
  if (existsSync(join(base, "PROJ"))) Object.assign(links, { "in-other-letters": "up/PROJ/sub", "in-other-letters-by-full-path": `${base}/PROJ/sub` });
  for (const [name, text] of Object.entries(links)) symlinkSync(text, join(real, name));
  copyTree(real, copy);
  for (const name of Object.keys(links)) {
    assert.equal(realpathSync(join(copy, name)), join(copy, "sub"), name);
    writeFileSync(join(copy, name, "f.txt"), "WRITTEN IN THE COPY");
  }
  assert.equal(readFileSync(join(real, "sub", "f.txt"), "utf-8"), "original");
  assert.equal(readlinkSync(join(copy, "slashes")), `${copy}/sub`, "what is said beyond the directory is kept");
});

test("a link by full path that goes through the directory on its way to a place outside does not go through it from a copy", (t) => {
  const base = scratch(t);
  const real = join(base, "proj"), copy = join(base, "elsewhere", "copy"), out = join(base, "out");
  for (const dir of [join(real, "d0"), copy, out]) mkdirSync(dir, { recursive: true });
  symlinkSync(out, join(real, "m"));
  symlinkSync(`${real}/m/`, join(out, "o")); // outside, and back by way of the directory's link
  symlinkSync(join(out, "o"), join(real, "k"));
  copyTree(real, copy);
  assert.equal(realpathSync(join(copy, "k")), out);
  // Were the copy's link to go by the directory's "m", it would follow that wherever it is pointed next.
  unlinkSync(join(real, "m"));
  symlinkSync("d0", join(real, "m"));
  assert.equal(realpathSync(join(copy, "k")), out);
});

test("words the system will not follow are not made into words it will", (t) => {
  const base = scratch(t);
  const real = join(base, "proj"), copy = join(base, "elsewhere", "copy");
  mkdirSync(real); mkdirSync(copy, { recursive: true });
  writeFileSync(join(real, "f.txt"), "f");
  symlinkSync("f.txt", join(real, "m"));
  symlinkSync("../proj/m/", join(real, "k")); // "m/" says a file is a directory
  assert.throws(() => statSync(join(real, "k")), { code: "ENOTDIR" });
  copyTree(real, copy);
  assert.throws(() => statSync(join(copy, "k")));
});

test("a link the runtime cannot follow is not carried into a copy, wherever it fails; one the run makes is merged as the run wrote it", { skip: asRoot }, (t) => {
  const base = scratch(t);
  const real = join(base, "proj"), copy = join(base, "elsewhere", "copy"), closed = join(base, "closed");
  mkdirSync(real); mkdirSync(copy, { recursive: true }); mkdirSync(closed);
  chmodSync(closed, 0o000);
  symlinkSync(join(closed, "x"), join(real, "into-closed"));
  const held = copyTree(real, copy);
  // Where it leads cannot be told — not even that it stays outside. (The system may follow what this reading cannot.)
  assert.equal(held.get("into-closed").kind, "other");
  assert.equal(existsSync(join(copy, "into-closed")), false);
  const before = readTree(copy);
  symlinkSync(join(closed, "y"), join(copy, "made-by-the-run"));
  assert.deepEqual(mergeTree(copy, real, before, held), []);
  assert.equal(readlinkSync(join(real, "made-by-the-run")), join(closed, "y"));
});

test("what a run's link by full path says beyond its directory is kept; where it comes back to the directory, from there", (t) => {
  const base = scratch(t);
  const real = join(base, "proj"), copy = join(base, "elsewhere", "copy");
  mkdirSync(join(real, "sub"), { recursive: true });
  mkdirSync(copy, { recursive: true });
  const held = copyTree(real, copy);
  const before = readTree(copy);
  const made = { "the-directory": `${copy}/`, "slashes": `${copy}//sub/`, "round-about": `${copy}/../copy/sub`, "deeper-round-about": `${copy}/sub/../../copy/sub` };
  for (const [name, text] of Object.entries(made)) symlinkSync(text, join(copy, name));
  assert.deepEqual(mergeTree(copy, real, before, held), []);
  assert.equal(readlinkSync(join(real, "the-directory")), `${real}/`);
  assert.equal(readlinkSync(join(real, "slashes")), `${real}/sub/`);
  assert.equal(readlinkSync(join(real, "round-about")), `${real}/sub`);
  assert.equal(readlinkSync(join(real, "deeper-round-about")), `${real}/sub`);
});

test("what takes the place of something of another kind is made before that is removed: if it cannot be, nothing is", (t) => {
  // A directory whose own name is long, so that a link by full path that fits where the copy is does not fit here.
  const base = scratch(t);
  let real = base;
  for (let n = 0; n < 3; n++) real = join(real, "p".repeat(200));
  const copy = join(base, "copy");
  mkdirSync(join(real, "dir"), { recursive: true });
  mkdirSync(copy);
  writeFileSync(join(real, "keep.txt"), "PRECIOUS");
  writeFileSync(join(real, "dir", "inner.txt"), "PRECIOUS");
  writeFileSync(join(real, "swapped.txt"), "as it was");
  mkdirSync(join(real, "was-a-dir"));
  const held = copyTree(real, copy);
  const before = readTree(copy);
  const far = ["x", "y", "z"].map((letter) => letter.repeat(250)).join("/");
  rmSync(join(copy, "keep.txt")); symlinkSync(join(copy, far), join(copy, "keep.txt"));
  rmSync(join(copy, "dir"), { recursive: true }); symlinkSync(join(copy, far), join(copy, "dir"));
  // And where it can be made, it takes the place: a file where a link was, a link where a directory was.
  rmSync(join(copy, "swapped.txt")); symlinkSync("keep.txt", join(copy, "swapped.txt"));
  rmdirSync(join(copy, "was-a-dir")); writeFileSync(join(copy, "was-a-dir"), "a file now");
  const asItWas = describe(real);

  const unmerged = mergeTree(copy, real, before, held);
  const now = describe(real);
  assert.equal(now["swapped.txt"], "link to <root>/keep.txt");
  assert.equal(now["was-a-dir"], 'file 644 "a file now"');
  assert.deepEqual(Object.keys(now).filter((path) => path.includes(".trama-tmp-")), [], "nothing made ready is left lying");
  if (unmerged.length === 0) return assert.equal(lstatSync(join(real, "keep.txt")).isSymbolicLink(), true, "this system lets a link say that much");
  assert.deepEqual(unmerged.map((it) => it.path).sort(), ["dir", "keep.txt"]);
  for (const path of ["keep.txt", "dir", "dir/inner.txt"]) assert.equal(now[path], asItWas[path], path);
});

test("a link out of the directory, moved by the run, still leads where the run found it to lead", (t) => {
  const base = scratch(t);
  const real = join(base, "project"), copy = join(base, "elsewhere", "copy");
  mkdirSync(join(real, "sub"), { recursive: true });
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(base, "shared.txt"), "SHARED");
  symlinkSync("../shared.txt", join(real, "outward"));
  const held = copyTree(real, copy);
  assert.equal(readFileSync(join(copy, "outward"), "utf-8"), "SHARED", "it leads where it led");
  const before = readTree(copy);
  renameSync(join(copy, "outward"), join(copy, "sub", "moved"));
  assert.equal(readFileSync(join(copy, "sub", "moved"), "utf-8"), "SHARED");
  assert.deepEqual(mergeTree(copy, real, before, held), []);
  // Not what moving it in the directory itself would give ("../shared.txt" from sub/ is a place in the
  // directory). It is what the run saw — and the one way a merge and the same run done directly part.
  assert.equal(readFileSync(join(real, "sub", "moved"), "utf-8"), "SHARED");
  assert.equal(existsSync(join(real, "outward")), false);
});

test("a link the run made by its directory's full path names the same place in the directory it is merged into", (t) => {
  const real = scratch(t), copy = scratch(t);
  mkdirSync(join(real, "data"));
  const held = copyTree(real, copy);
  const before = readTree(copy);
  symlinkSync(join(copy, "data"), join(copy, "current")); // as a program does with its working directory
  symlinkSync("data", join(copy, "relative"));
  symlinkSync("/somewhere/else", join(copy, "elsewhere"));
  assert.deepEqual(mergeTree(copy, real, before, held), []);
  assert.equal(readlinkSync(join(real, "current")), join(real, "data"));
  assert.equal(readlinkSync(join(real, "relative")), "data");
  assert.equal(readlinkSync(join(real, "elsewhere")), "/somewhere/else");
});

test("a change that keeps a file's size and its times is still a change", (t) => {
  const real = scratch(t), copy = scratch(t);
  writeFileSync(join(real, "count.txt"), "1");
  const held = copyTree(real, copy);
  const before = readTree(copy);
  const { atime, mtime } = statSync(join(copy, "count.txt"));
  writeFileSync(join(copy, "count.txt"), "2");
  utimesSync(join(copy, "count.txt"), atime, mtime);
  assert.deepEqual(mergeTree(copy, real, before, held), []);
  assert.equal(readFileSync(join(real, "count.txt"), "utf-8"), "2");
});

test("whether two paths are the same place is not answered by failing to look", { skip: asRoot }, (t) => {
  const dir = scratch(t);
  mkdirSync(join(dir, "closed", "inner"), { recursive: true });
  assert.equal(identityOf(join(dir, "nothing-here")), undefined);
  chmodSync(join(dir, "closed"), 0o444);
  assert.throws(() => identityOf(join(dir, "closed", "inner")), { code: "EACCES" });
});

test("a merge keeps to the directory: a link put in the way meanwhile is not followed out of it", (t) => {
  const real = scratch(t), copy = scratch(t), outside = scratch(t);
  writeFileSync(join(outside, "target.txt"), "external-original");
  const held = copyTree(real, copy);
  const before = readTree(copy);
  writeFileSync(join(copy, "escape.txt"), "from the run");
  mkdirSync(join(copy, "reports"));
  writeFileSync(join(copy, "reports", "data.txt"), "from the run");
  mkdirSync(join(copy, "nested"));
  writeFileSync(join(copy, "nested", "out.txt"), "from the run");

  // Meanwhile: a link to a file outside, a link to a directory outside, and a file where the run made a directory.
  symlinkSync(join(outside, "target.txt"), join(real, "escape.txt"));
  symlinkSync(outside, join(real, "reports"));
  writeFileSync(join(real, "nested"), "i am a file");

  const unmerged = mergeTree(copy, real, before, held);
  assert.deepEqual(unmerged.map((it) => it.path).sort(), ["escape.txt", "nested", "reports"]);
  assert.equal(readFileSync(join(outside, "target.txt"), "utf-8"), "external-original");
  assert.deepEqual(readdirSync(outside), ["target.txt"]);
  assert.equal(readFileSync(join(real, "nested"), "utf-8"), "i am a file");
});
