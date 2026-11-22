// What a directory holds: read, copied, and merged back (packages/runtime/src/tree.ts).
//
// The merge is held against the thing it stands in for. A run that works in a
// copy, and has its work merged back, must leave the directory as the same
// run would have left it working there directly — so the tests below do both,
// with trees and runs made at random, and compare. Nothing here says what the
// merge should do case by case; the system does.

import test from "node:test";
import assert from "node:assert/strict";
import fs, {
  appendFileSync, chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from "fs";
import { syncBuiltinESMExports } from "module";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";
import * as tree from "../packages/runtime/dist/tree.js";
import { mergeTree } from "../packages/runtime/dist/merge.js";
import { identityOf } from "../packages/runtime/dist/path-guard.js";

const asRoot = process.getuid?.() === 0; // root may do what permissions forbid: nothing below would be refused

const { entryAt } = tree;
/**
 * A change is told from none by the time the system records for it, and that
 * is as fine as the system's clock for it: Linux before 6.13 moves it once a
 * tick, a few milliseconds. A run starts later after its copy was made than
 * that — a process has to start — and a test does not: it goes on at once. So
 * here a reading is over only when that clock has moved on, which on a system
 * with a fine one is at once.
 */
const clock = join(realpathSync(mkdtempSync(join(tmpdir(), "trama-clock-"))), "clock");
writeFileSync(clock, "");
process.on("exit", () => rmSync(dirname(clock), { recursive: true, force: true }));
const onceTheClockHasMoved = (read) => (...args) => {
  const result = read(...args);
  const changed = () => lstatSync(clock, { bigint: true }).ctimeNs;
  chmodSync(clock, 0o600);
  for (const then = changed(); changed() === then;) chmodSync(clock, lstatSync(clock).mode & 0o044 ? 0o600 : 0o644);
  return result;
};
const copyTree = onceTheClockHasMoved(tree.copyTree), readTree = onceTheClockHasMoved(tree.readTree);

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

/**
 * Do something with the system refusing some of what is asked of it — as it
 * does where a file is locked, a name does not fit, a disk is full: what a
 * merge cannot find out beforehand, and is told in the middle of its work.
 * `refuses(call, place, from)` says what: the call, the place it would change
 * (of a move or a copy, where the thing would be put), and of a move, where
 * the thing is.
 */
const CHANGES = { mkdirSync: 0, symlinkSync: 1, renameSync: 1, copyFileSync: 1, unlinkSync: 0, rmdirSync: 0, rmSync: 0, chmodSync: 0 };
function withTheSystemRefusing(refuses, what) {
  const itsOwn = {};
  for (const [call, place] of Object.entries(CHANGES)) {
    itsOwn[call] = fs[call];
    fs[call] = (...args) => {
      if (refuses(call, String(args[place]), String(args[0]))) {
        throw Object.assign(new Error(`EACCES: permission denied, ${call} '${args[place]}'`), { code: "EACCES" });
      }
      return itsOwn[call](...args);
    };
  }
  syncBuiltinESMExports();
  try {
    return what();
  } finally {
    Object.assign(fs, itsOwn);
    syncBuiltinESMExports();
  }
}
/**
 * What the system refuses in a directory that may not be written to: making
 * anything in it, removing anything from it, moving anything into or out of
 * it. (Not writing into a file that is there, nor changing what one allows.)
 */
const nothingMadeOrRemovedIn = (dir) => (call, place, from) =>
  call !== "chmodSync" && (dirname(place) === dir || (call === "renameSync" && dirname(from) === dir))
  && !(call === "copyFileSync" && lstatSync(place, { throwIfNoEntry: false }));

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
 * (A directory that is closed is opened for the look, and closed again: this
 * is the test's look at it, not a program's.)
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
    const allows = lstatSync(dir).mode & 0o7777;
    if ((allows & 0o500) !== 0o500) chmodSync(dir, 0o700);
    try {
      for (const name of readdirSync(dir).sort()) {
        const at = join(dir, name);
        const stat = lstatSync(at);
        const mode = (stat.mode & 0o7777).toString(8);
        if (stat.isSymbolicLink()) seen[prefix + name] = `link to ${place(resolve(dir, readlinkSync(at)))}`;
        else if (stat.isDirectory()) { seen[prefix + name] = `dir ${mode}`; into(at, `${prefix}${name}/`); }
        else if (stat.isFile()) seen[prefix + name] = `file ${mode} ${stat.mode & 0o400 ? JSON.stringify(readFileSync(at, "utf-8")) : `of ${stat.size} bytes nobody may read`}`;
        else seen[prefix + name] = "other";
      }
    } finally {
      if ((allows & 0o500) !== 0o500) chmodSync(dir, allows);
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
/** What the directory itself may allow, which a tree is made in: mostly all its owner could want. */
const MODES_OF_THE_DIRECTORY = [0o755, 0o755, 0o755, 0o755, 0o755, 0o700, 0o750, 0o555, 0o555, 0o500];
/** What a directory allows. */
const allowedBy = (dir) => lstatSync(dir).mode & 0o7777;
const FILE_MODES = [0o644, 0o644, 0o600, 0o444, 0o755, 0o400];
/** What a run may leave a file allowing — and a directory it is copied from may not hold: a file nobody may read cannot be copied. */
const FILE_MODES_OF_A_RUN = [...FILE_MODES, 0o200, 0o000];
/** The same of a directory: one that may not be looked into cannot be copied with what is in it, and a run may leave one. */
const DIR_MODES_ALSO_CLOSED = [...DIR_MODES, 0o700, 0o400, 0o600, 0o300, 0o000];

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
 * `links` says which kinds of link it may make. With `itself`, what it
 * changes the permissions of is now and then the directory itself.
 */
function step(rng, root, links, { fileModes = FILE_MODES, dirModes = DIR_MODES, inACopy = false, itself = false } = {}) {
  let kind = rng.pick(["write", "write", "write", "append", "remove", "mkdir", "mkdir", "rmdir", "chmod", "chmod", "link", "relink", "rename", "rewrite", "respell"]);
  const p = itself && kind === "chmod" && rng.next() < 0.25 ? "." : somePath(rng, root);
  // The one thing a run in a copy does not do as it would directly: move a link that says "..". Where such a
  // link leaves the directory, the copy has it by full path, and it leads from its new place where it led
  // from the old — not where the same words lead from there. (Tested by itself, further down.)
  const saysUp = () => {
    try { return readlinkSync(join(root, p)).startsWith("../"); } catch { return false; } // no link, or in a directory that is closed
  };
  if (inACopy && kind === "rename" && saysUp()) kind = "append";
  return {
    kind, p, q: somePath(rng, root),
    text: rng.pick(TEXTS), dirMode: rng.pick(dirModes), fileMode: rng.pick(fileModes), link: rng.pick(links), name: rng.pick(NAMES),
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
        // Where the file system takes the two for one name, a merge does not carry this: only a run that is
        // held to less than leaving what a direct run leaves does it there (`whateverTheFileSystem`).
        if (it.whateverTheFileSystem || !lstatSync(other, { throwIfNoEntry: false })) renameSync(at(it.p), other);
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
          back: `../${basename(root)}/${it.q}/${it.name}`, // the same, and on by way of what is there: a directory, or another link
          through: `${basename(it.q)}/${it.name}`,    // by way of what is beside the link: a directory, or another link
          fullThrough: join(root, it.q, it.name),     // the same, named from the top of the file system
        }[it.link];
        symlinkSync(target, at(it.p));
        break;
      }
    }
  } catch { /* refused: the same in any copy of this directory */ }
}

/** Whether a path is another or under it. Every path is under the directory itself. */
const atOrUnder = (path, other) => path === other || other === "." || path.startsWith(`${other}/`);
/** Whether a path is one that a report covers: the reported path, something under it, or something it is under. */
const covered = (path, unmerged) => unmerged.some((it) => atOrUnder(path, it.path) || atOrUnder(it.path, path));

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
    const it = step(rng, direct, ["near", "near", "up", "full", "away", "round", "back", "through", "through", "fullThrough"]);
    for (const root of [direct, real]) carryOut(root, outside, it);
  }
  // A directory nobody may look into can be copied if nothing is in it, and a run may open it.
  if (rng.next() < 0.5 && !existsSync(join(direct, "shut"))) {
    const mode = rng.pick([0o400, 0o600]);
    for (const root of [direct, real]) { mkdirSync(join(root, "shut")); chmodSync(join(root, "shut"), mode); }
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
  // What the directory itself allows — last, since one that may not be written to cannot be filled.
  const itself = rng.pick(MODES_OF_THE_DIRECTORY);
  for (const root of [direct, real]) chmodSync(root, itself);
  assert.deepEqual(describe(real), describe(direct), "the two trees start the same");
  return { base, outside, direct, real, copy };
}

const A_RUN = { fileModes: FILE_MODES_OF_A_RUN, dirModes: DIR_MODES_ALSO_CLOSED, inACopy: true };

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
      assert.equal(allowedBy(copy), allowedBy(real), `round ${round}: the copy allows what the directory allows`);
      const before = readTree(copy);

      // A run does not know it is in a copy, and cannot name it: it makes no link by way of its directory's name.
      const run = [];
      for (let n = 0; n < 14; n++) {
        const it = step(rng, direct, ["near", "up", "full", "away", "through", "fullThrough"], { ...A_RUN, itself: true });
        for (const root of [direct, copy]) carryOut(root, outside, it);
        run.push(it);
      }
      assert.deepEqual(describe(real), asItWas, `round ${round}: nothing done in the copy is done to the directory`);

      const unmerged = mergeTree(copy, real, before, held);
      const told = `round ${round}, the run: ${JSON.stringify(run.map(({ kind, p, q, link }) => (kind === "link" ? `${kind}:${link} ${p} -> ${q}` : kind === "rename" ? `${kind} ${p} ${q}` : `${kind} ${p}`)))}`;
      assert.deepEqual(unmerged, [], told);
      const now = describe(real), wanted = describe(direct);
      assert.deepEqual(now, wanted, told);
      assert.equal(allowedBy(real), allowedBy(direct), `the directory itself, ${told}`);
    }
  });

  test(`what somebody else did to the directory meanwhile is kept, and what could not be merged for it is told (seed ${seed})`, { skip: asRoot }, (t) => {
    const rng = random(seed ^ 0x5eed);
    for (let round = 0; round < 120; round++) {
      const { outside, direct, real, copy } = trial(t, rng);
      const held = copyTree(real, copy);
      const before = readTree(copy);
      const asItWas = describe(real), allowed = allowedBy(real);

      const run = [];
      for (let n = 0; n < 12; n++) {
        const it = step(rng, direct, ["near", "up", "full", "away", "through", "fullThrough"], { ...A_RUN, itself: true });
        for (const root of [direct, copy]) carryOut(root, outside, it);
        run.push(it);
      }
      // Meanwhile, in the directory itself — and now and then to it.
      const theirs = [];
      for (let n = 1 + Math.floor(rng.next() * 4); n > 0; n--) {
        const it = { ...step(rng, real, ["near"], { dirModes: DIR_MODES_ALSO_CLOSED }), kind: rng.pick(["write", "write", "remove", "mkdir", "chmod", "rewrite", "append"]) };
        if (it.kind === "chmod" && rng.next() < 0.15) it.p = ".";
        carryOut(real, outside, it);
        theirs.push(it);
      }
      const asTheyLeftIt = describe(real), allowedByThem = allowedBy(real);
      const touched = new Set([...Object.keys(asItWas), ...Object.keys(asTheyLeftIt)].filter((path) => asItWas[path] !== asTheyLeftIt[path]));

      const unmerged = mergeTree(copy, real, before, held);
      const now = describe(real);
      const wanted = describe(direct);
      const told = `round ${round}\n the run: ${JSON.stringify(run.map(({ kind, p, q }) => `${kind} ${p} ${q}`))}\n theirs: ${JSON.stringify(theirs.map(({ kind, p }) => `${kind} ${p}`))}\n unmerged: ${JSON.stringify(unmerged)}`;
      // What is told not to have arrived is as they left it, there and under it: nothing half done.
      for (const { path } of unmerged) {
        for (const other of new Set([...Object.keys(now), ...Object.keys(asTheyLeftIt)])) {
          if (!atOrUnder(other, path)) continue;
          if (now[other] !== asTheyLeftIt[other]) assert.fail(`${path} did not arrive, yet ${other} was ${asTheyLeftIt[other]} and is now ${now[other]}\n${told}`);
        }
      }
      // The directory itself: as they left it, if they changed what it allows or it is told not to have arrived; as the run left it, if not.
      const itselfLeftAlone = allowedByThem !== allowed || unmerged.some((it) => it.path === ".");
      assert.equal(allowedBy(real), itselfLeftAlone ? allowedByThem : allowedBy(direct), `the directory itself\n${told}`);
      // Theirs stands, whatever the run did at the same place.
      for (const path of touched) {
        if (now[path] !== asTheyLeftIt[path]) assert.fail(`${path} was theirs (${asTheyLeftIt[path]}), and is now ${now[path]}\n${told}`);
      }
      for (const path of new Set([...Object.keys(now), ...Object.keys(wanted)])) {
        if (now[path] === wanted[path]) continue;
        const explained = covered(path, unmerged) || [...touched].some((theirPath) => atOrUnder(path, theirPath) || atOrUnder(theirPath, path));
        if (!explained) assert.fail(`${path} is ${now[path]}, not ${wanted[path]} as the run left it, and nothing says why\n${told}`);
      }
    }
  });

  test(`a name spelled anew, a file with two names: nothing goes that the run still has, and what did not arrive is told (seed ${seed})`, { skip: asRoot }, (t) => {
    const rng = random(seed ^ 0xca5e);
    /** Whether a path is there by the file system's own reckoning of names, every step on the way a directory. */
    const has = (root, path) => {
      try {
        const steps = path.split("/");
        return steps.every((_, n) => {
          const stat = lstatSync(join(root, ...steps.slice(0, n + 1)), { throwIfNoEntry: false });
          return stat !== undefined && (n === steps.length - 1 || stat.isDirectory());
        });
      } catch { return false; } // not to be looked at: then nothing was done there either
    };
    for (let round = 0; round < 80; round++) {
      const { outside, direct, real, copy } = trial(t, rng);
      // In every other round some files have a second name. A copy has those as two files, so in these rounds
      // the run is not held to leave what it would leave working directly — only to lose nothing.
      const twoNames = round % 2 === 1;
      for (let n = 0; twoNames && n < 3; n++) {
        const from = somePath(rng, direct), to = somePath(rng, direct);
        if (!describe(direct)[from]?.startsWith("file ")) continue; // (a link's second name may be one of what it leads to)
        for (const root of [direct, real]) try { linkSync(join(root, from), join(root, to)); } catch { /* the name is taken */ }
      }
      const held = copyTree(real, copy);
      const before = readTree(copy);
      const asItWas = describe(real);
      // Written to under one name, such a file is another under the other: of these, "as it was" is not said.
      const oneOfTwo = new Set(Object.keys(asItWas).filter((path) => asItWas[path].startsWith("file ") && lstatSync(join(real, path)).nlink > 1));

      const run = [];
      for (let n = 0; n < 12; n++) {
        const it = { ...step(rng, direct, ["near", "full", "through"], A_RUN), whateverTheFileSystem: true };
        if (rng.next() < 0.3) it.kind = "respell";
        for (const root of [direct, copy]) carryOut(root, outside, it);
        run.push(it);
      }
      const unmerged = mergeTree(copy, real, before, held);
      const now = describe(real), wanted = describe(direct);
      const told = `round ${round}\n the run: ${JSON.stringify(run.map(({ kind, p, q }) => `${kind} ${p} ${q}`))}\n unmerged: ${JSON.stringify(unmerged)}`;
      for (const { path } of unmerged) {
        for (const other of new Set([...Object.keys(now), ...Object.keys(asItWas)])) {
          if (!atOrUnder(other, path)) continue;
          if (now[other] !== asItWas[other] && !(other in now && oneOfTwo.has(other))) assert.fail(`${path} did not arrive, yet ${other} was ${asItWas[other]} and is now ${now[other]}\n${told}`);
        }
      }
      // What a tree takes for removed — a name that is no longer among the names — may be there all the same, under
      // another spelling. The copy's own file system says whether the run still has it.
      for (const path of Object.keys(asItWas)) {
        if (!(path in now) && has(copy, path)) assert.fail(`${path} is gone from the directory, and the run still has it\n${told}`);
      }
      if (twoNames) continue;
      for (const path of new Set([...Object.keys(now), ...Object.keys(wanted)])) {
        if (now[path] !== wanted[path] && !covered(path, unmerged)) assert.fail(`${path} is ${now[path]}, not ${wanted[path]} as the run left it, and nothing says why\n${told}`);
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

test("a directory the run left closed is read all the same: what is in it is not taken for removed, and it is left closed", { skip: asRoot }, (t) => {
  // 0o400 lists its names and will not have them looked at; 0o300 will not list them; 0o000 neither.
  for (const mode of [0o400, 0o300, 0o000]) {
    const real = scratch(t), copy = scratch(t);
    mkdirSync(join(real, "data", "deep"), { recursive: true });
    writeFileSync(join(real, "data", "a.csv"), "rows");
    writeFileSync(join(real, "data", "deep", "b.csv"), "more rows");
    const held = copyTree(real, copy);
    const before = readTree(copy);

    writeFileSync(join(copy, "data", "new.csv"), "BY THE RUN");
    rmSync(join(copy, "data", "deep", "b.csv"));
    chmodSync(join(copy, "data", "deep"), mode);
    chmodSync(join(copy, "data"), mode);
    writeFileSync(join(copy, "elsewhere.txt"), "BY THE RUN");

    assert.deepEqual(mergeTree(copy, real, before, held), [], `mode ${mode.toString(8)}`);
    const shut = mode.toString(8);
    assert.deepEqual(describe(real), {
      "data": `dir ${shut}`, "data/a.csv": 'file 644 "rows"', "data/deep": `dir ${shut}`, "data/new.csv": 'file 644 "BY THE RUN"',
      "elsewhere.txt": 'file 644 "BY THE RUN"',
    });
  }
});

test("what the run left that cannot be read at all is not taken for removed: nothing is merged, and nothing removed", { skip: asRoot }, (t) => {
  const real = scratch(t), copy = scratch(t);
  mkdirSync(join(real, "data"));
  writeFileSync(join(real, "data", "a.csv"), "rows");
  const held = copyTree(real, copy);
  const before = readTree(copy);
  writeFileSync(join(copy, "elsewhere.txt"), "BY THE RUN");
  // Something no opening of a directory makes readable: a rule beside its permissions, or a name that is not text.
  if (process.platform === "darwin") execFileSync("chmod", ["+a", "everyone deny list,search", join(copy, "data")]);
  else writeFileSync(Buffer.concat([Buffer.from(join(copy, "data") + "/"), Buffer.from([0xff, 0xfe])]), "x");
  try {
    const unmerged = mergeTree(copy, real, before, held);
    assert.equal(unmerged.length, 1);
    assert.equal(unmerged[0].path, ".");
    assert.match(unmerged[0].why, /could not be read .*none of it was merged/);
    assert.deepEqual(describe(real), { "data": "dir 755", "data/a.csv": 'file 644 "rows"' });
  } finally {
    if (process.platform === "darwin") execFileSync("chmod", ["-N", join(copy, "data")]);
  }
});

test("a directory nobody may look into is opened to be looked into, as it is to be changed", { skip: asRoot }, (t) => {
  for (const mode of [0o400, 0o600]) {
    for (const closesItAgain of [false, true]) {
      const direct = scratch(t), real = scratch(t), copy = scratch(t);
      for (const dir of [direct, real]) { mkdirSync(join(dir, "locked")); chmodSync(join(dir, "locked"), mode); }
      const run = (dir) => {
        chmodSync(join(dir, "locked"), 0o755);
        writeFileSync(join(dir, "locked", "out.txt"), "OUT");
        mkdirSync(join(dir, "locked", "sub")); writeFileSync(join(dir, "locked", "sub", "f"), "F");
        if (closesItAgain) chmodSync(join(dir, "locked"), mode);
      };
      const held = copyTree(real, copy);
      const before = readTree(copy);
      run(direct); run(copy);
      assert.deepEqual(mergeTree(copy, real, before, held), []);
      assert.deepEqual(describe(real), describe(direct));
      assert.equal(describe(real)["locked/sub/f"], 'file 644 "F"');
    }
  }
});

test("a place that already holds what the run left is not told of, though somebody changed what its directory allows", (t) => {
  const real = scratch(t), copy = scratch(t);
  mkdirSync(join(real, "d"));
  writeFileSync(join(real, "d", "f"), "as it was");
  symlinkSync("f", join(real, "d", "l"));
  const held = copyTree(real, copy);
  const before = readTree(copy);
  const both = (dir) => { writeFileSync(join(dir, "d", "f"), "the same from both"); unlinkSync(join(dir, "d", "l")); symlinkSync("elsewhere", join(dir, "d", "l")); mkdirSync(join(dir, "d", "new")); };
  both(copy);
  both(real); chmodSync(join(real, "d"), 0o700); // meanwhile
  assert.deepEqual(mergeTree(copy, real, before, held), []);
});

test("a file the run moved stays where it was if it does not arrive where the run moved it", (t) => {
  const real = scratch(t), copy = scratch(t);
  mkdirSync(join(real, "d"));
  for (const file of ["a.txt", "c.txt", "d/x.txt", "gone.txt", "m.txt", "z.txt"]) writeFileSync(join(real, file), `what ${file} held`);
  const held = copyTree(real, copy);
  const before = readTree(copy);
  renameSync(join(copy, "a.txt"), join(copy, "b.txt"));        // to a name somebody else takes meanwhile
  renameSync(join(copy, "c.txt"), join(copy, "a.txt"));        // into the place the first one is then still in
  renameSync(join(copy, "d"), join(copy, "e"));                // a directory, to a name somebody else takes
  renameSync(join(copy, "z.txt"), join(copy, "y.txt"));        // the same again, in the other order of their names:
  renameSync(join(copy, "m.txt"), join(copy, "z.txt"));        // what stays is found out after what was to take its place
  rmSync(join(copy, "gone.txt"));                              // (and a file that is simply removed)
  writeFileSync(join(real, "b.txt"), "theirs"); mkdirSync(join(real, "e")); writeFileSync(join(real, "e", "x.txt"), "theirs");
  writeFileSync(join(real, "y.txt"), "theirs");
  const unmerged = mergeTree(copy, real, before, held);
  assert.deepEqual(unmerged.map((it) => it.path).sort(), ["a.txt", "b.txt", "c.txt", "d", "d/x.txt", "e/x.txt", "m.txt", "y.txt", "z.txt"]);
  assert.match(unmerged.find((it) => it.path === "a.txt").why, /the run moved what was here to b\.txt, which did not arrive/);
  assert.match(unmerged.find((it) => it.path === "c.txt").why, /the run moved what was here to a\.txt, which did not arrive/);
  assert.deepEqual(describe(real), {
    "a.txt": 'file 644 "what a.txt held"', "b.txt": 'file 644 "theirs"', "c.txt": 'file 644 "what c.txt held"',
    "d": "dir 755", "d/x.txt": 'file 644 "what d/x.txt held"', "e": "dir 755", "e/x.txt": 'file 644 "theirs"',
    "m.txt": 'file 644 "what m.txt held"', "y.txt": 'file 644 "theirs"', "z.txt": 'file 644 "what z.txt held"',
  });
});

test("a file the run moved stays where it was if the directory in whose place it was put stays", (t) => {
  // Each of these has the place the file went to refused only once something else is known not to go.
  const cases = {
    "somebody changed what the directory holds": {
      make: ["d/keep.txt", "z.txt"],
      run: (dir) => { rmSync(join(dir, "d"), { recursive: true }); renameSync(join(dir, "z.txt"), join(dir, "d")); },
      theirs: (dir) => writeFileSync(join(dir, "d", "keep.txt"), "theirs"),
      stays: ["z.txt", "d/keep.txt"],
    },
    "a file moved out of the directory did not arrive": {
      make: ["d/y.txt", "z.txt"],
      run: (dir) => { renameSync(join(dir, "d", "y.txt"), join(dir, "w.txt")); rmSync(join(dir, "d"), { recursive: true }); renameSync(join(dir, "z.txt"), join(dir, "d")); },
      theirs: (dir) => writeFileSync(join(dir, "w.txt"), "theirs"),
      stays: ["z.txt", "d/y.txt", "w.txt"],
    },
    "and another file was moved to where the first one was, and a third to where that one was": {
      make: ["d/keep.txt", "q.txt", "r.txt", "z.txt"],
      run: (dir) => {
        rmSync(join(dir, "d"), { recursive: true }); renameSync(join(dir, "z.txt"), join(dir, "d"));
        renameSync(join(dir, "q.txt"), join(dir, "z.txt")); renameSync(join(dir, "r.txt"), join(dir, "q.txt"));
      },
      theirs: (dir) => writeFileSync(join(dir, "d", "keep.txt"), "theirs"),
      stays: ["z.txt", "q.txt", "r.txt", "d/keep.txt"],
    },
  };
  for (const [what, { make, run, theirs, stays }] of Object.entries(cases)) {
    const real = scratch(t), copy = scratch(t);
    mkdirSync(join(real, "d"));
    for (const file of make) writeFileSync(join(real, file), `what ${file} held`);
    const held = copyTree(real, copy);
    const before = readTree(copy);
    run(copy);
    theirs(real);
    const asTheyLeftIt = describe(real);
    const unmerged = mergeTree(copy, real, before, held);
    assert.deepEqual(describe(real), asTheyLeftIt, what);
    for (const path of stays) assert.ok(covered(path, unmerged), `${what}: ${path} stays, and nothing says so`);
  }
});

test("what is at a place is moved from it only by the run: a second name given to a file, or a link, is no move", (t) => {
  const real = scratch(t), copy = scratch(t);
  writeFileSync(join(real, "a.txt"), "A"); writeFileSync(join(real, "moved.txt"), "M"); symlinkSync("a.txt", join(real, "l"));
  const held = copyTree(real, copy);
  const before = readTree(copy);
  writeFileSync(join(copy, "a.txt"), "A, written by the run"); linkSync(join(copy, "a.txt"), join(copy, "b.txt")); // a second name, somebody has taken
  renameSync(join(copy, "l"), join(copy, "m"));                                                               // a link moved to a name somebody has taken
  symlinkSync("a.txt", join(copy, "another"));                                                                // (and another link, which arrives: it is not that one)
  renameSync(join(copy, "moved.txt"), join(copy, "copied.txt")); writeFileSync(join(copy, "moved.txt"), "new"); // moved, and a new file where it was
  for (const taken of ["b.txt", "m", "copied.txt"]) writeFileSync(join(real, taken), "theirs");
  const unmerged = mergeTree(copy, real, before, held);
  assert.deepEqual(unmerged.map((it) => it.path).sort(), ["b.txt", "copied.txt", "l", "m", "moved.txt"]);
  assert.deepEqual(describe(real), {
    "a.txt": 'file 644 "A, written by the run"', "b.txt": 'file 644 "theirs"', "copied.txt": 'file 644 "theirs"',
    "another": "link to <root>/a.txt", "l": "link to <root>/a.txt", "m": 'file 644 "theirs"', "moved.txt": 'file 644 "M"',
  });
});

test("what is made beside a place has a name of its own: one as long as a name may be can still be taken the place of", (t) => {
  const real = scratch(t), copy = scratch(t);
  const long = "n".repeat(250);
  symlinkSync("somewhere", join(real, long)); writeFileSync(join(real, "z.txt"), "Z");
  writeFileSync(join(real, long + ".txt"), "read-only"); chmodSync(join(real, long + ".txt"), 0o444);
  const held = copyTree(real, copy);
  const before = readTree(copy);
  unlinkSync(join(copy, long)); renameSync(join(copy, "z.txt"), join(copy, long));
  unlinkSync(join(copy, long + ".txt")); writeFileSync(join(copy, long + ".txt"), "replaced"); chmodSync(join(copy, long + ".txt"), 0o444);
  assert.deepEqual(mergeTree(copy, real, before, held), []);
  assert.deepEqual(describe(real), { [long]: 'file 644 "Z"', [long + ".txt"]: 'file 444 "replaced"' });
});

test("what the run moved stays where it was if the system will not have it made where it went", { skip: asRoot }, (t) => {
  // Nothing may be made in the directory itself: that is found out only by trying, and nothing has gone by then.
  const cases = {
    "a file, out of a directory": (dir) => renameSync(join(dir, "sub", "a.txt"), join(dir, "a.txt")),
    "a directory": (dir) => renameSync(join(dir, "sub"), join(dir, "sub2")),
    "a file, into a directory that is made for it": (dir) => { mkdirSync(join(dir, "new")); renameSync(join(dir, "sub", "a.txt"), join(dir, "new", "a.txt")); },
    "a link": (dir) => renameSync(join(dir, "sub", "l"), join(dir, "l")),
    "a directory with nothing but directories in it": (dir) => renameSync(join(dir, "sub", "empty"), join(dir, "elsewhere")),
    // (The new file's turn comes, by its name, before that of the place the old one went to.)
    "a file moved aside, and a new one written where it was": (dir) => { renameSync(join(dir, "kept.txt"), join(dir, "z.bak")); writeFileSync(join(dir, "kept.txt"), "new"); },
    // What took the old one's place is there by the time the old one turns out not to have arrived: it goes again.
    "a file moved out of a directory, and another put where it was": (dir) => { renameSync(join(dir, "sub", "a.txt"), join(dir, "z.bak")); writeFileSync(join(dir, "sub", "a.txt"), "new"); },
    "the same, with a directory put where it was, and things in that": (dir) => {
      renameSync(join(dir, "sub", "a.txt"), join(dir, "z.bak")); mkdirSync(join(dir, "sub", "a.txt")); writeFileSync(join(dir, "sub", "a.txt", "inside"), "new");
    },
    "a directory that is in the way of a file, with a file in it that was moved": (dir) => {
      renameSync(join(dir, "sub", "a.txt"), join(dir, "z.bak")); rmSync(join(dir, "sub"), { recursive: true }); writeFileSync(join(dir, "sub"), "a file now");
    },
  };
  for (const [what, run] of Object.entries(cases)) {
    const real = scratch(t), copy = scratch(t);
    mkdirSync(join(real, "sub", "empty", "deeper"), { recursive: true });
    writeFileSync(join(real, "sub", "a.txt"), "PRECIOUS"); symlinkSync("a.txt", join(real, "sub", "l"));
    writeFileSync(join(real, "kept.txt"), "PRECIOUS TOO");
    const held = copyTree(real, copy);
    const before = readTree(copy);
    run(copy);
    const asItWas = describe(real);
    const unmerged = withTheSystemRefusing(nothingMadeOrRemovedIn(real), () => mergeTree(copy, real, before, held));
    assert.deepEqual(describe(real), asItWas, what);
    assert.ok(unmerged.length > 0, what);
  }
});

test("for what is known beforehand not to arrive, nothing is made ready: the directory is not touched at all", (t) => {
  const real = scratch(t), copy = scratch(t);
  writeFileSync(join(real, "a"), "A");
  const held = copyTree(real, copy);
  const before = readTree(copy);
  renameSync(join(copy, "a"), join(copy, "b")); writeFileSync(join(copy, "a"), "another, in its place"); // moved aside, and replaced
  writeFileSync(join(real, "b"), "theirs"); // …to a name somebody has taken: neither arrives
  const touched = () => { const { mtimeNs, ctimeNs } = lstatSync(real, { bigint: true }); return `${mtimeNs} ${ctimeNs}`; };
  const was = touched();
  const unmerged = mergeTree(copy, real, before, held);
  assert.deepEqual(unmerged.map((it) => it.path).sort(), ["a", "b"]);
  assert.equal(touched(), was, "no name was made in the directory, not for a moment");
});

test("what the run moved stays where it was if somebody has taken the place it was moved to — whatever it is, and whatever times it was given", (t) => {
  const real = scratch(t), copy = scratch(t);
  mkdirSync(join(real, "queue", "incoming"), { recursive: true }); mkdirSync(join(real, "queue", "done")); chmodSync(join(real, "queue", "done"), 0o700);
  writeFileSync(join(real, "a"), "A");
  const held = copyTree(real, copy);
  const before = readTree(copy);
  renameSync(join(copy, "queue"), join(copy, "spool"));                                            // nothing in it but directories
  renameSync(join(copy, "a"), join(copy, "n")); utimesSync(join(copy, "n"), new Date(2001, 0), new Date(2001, 0)); // and its times set back
  for (const taken of ["spool", "n"]) writeFileSync(join(real, taken), "theirs");
  const asTheyLeftIt = describe(real);
  const unmerged = mergeTree(copy, real, before, held);
  assert.deepEqual(unmerged.map((it) => it.path).sort(), ["a", "n", "queue", "spool"]);
  assert.deepEqual(describe(real), asTheyLeftIt);
});

test("a file the run moved stays where it was if the system will not have it made where it went, though nothing says so beforehand", { skip: asRoot || process.platform !== "darwin" }, (t) => {
  for (const to of ["l", "new.txt"]) { // where a link is, and where nothing is
    const real = scratch(t), copy = scratch(t);
    mkdirSync(join(real, "kept")); symlinkSync("../z.txt", join(real, "kept", "l")); writeFileSync(join(real, "z.txt"), "Z");
    const held = copyTree(real, copy);
    const before = readTree(copy);
    unlinkSync(join(copy, "kept", "l")); renameSync(join(copy, "z.txt"), join(copy, "kept", to));
    const asItWas = describe(real);
    execFileSync("chflags", ["uchg", join(real, "kept")]); // nothing may be made in it, whatever its permissions say
    try {
      const unmerged = mergeTree(copy, real, before, held);
      assert.match(unmerged.find((it) => it.path === "z.txt").why, new RegExp(`the run moved what was here to kept/${to.replace(".", "\\.")}, which did not arrive`));
    } finally {
      execFileSync("chflags", ["nouchg", join(real, "kept")]);
    }
    assert.deepEqual(describe(real), asItWas, to);
  }
});

test("a directory that was moved aside for a file, and came back, is closed where it is again — with what was opened in it", { skip: asRoot }, (t) => {
  const real = scratch(t), copy = scratch(t);
  mkdirSync(join(real, "sub", "d", "shut"), { recursive: true });
  writeFileSync(join(real, "sub", "d", "shut", "x"), "PRECIOUS");
  chmodSync(join(real, "sub", "d", "shut"), 0o555);
  const held = copyTree(real, copy);
  const before = readTree(copy);
  // What is in the closed directory is moved to the top; the directory above it goes, and a file takes its place.
  chmodSync(join(copy, "sub", "d", "shut"), 0o755);
  renameSync(join(copy, "sub", "d", "shut", "x"), join(copy, "moved"));
  rmSync(join(copy, "sub", "d"), { recursive: true }); writeFileSync(join(copy, "sub", "d"), "a file now");
  const asItWas = describe(real);
  // Nothing may be made at the top: what was moved there does not arrive, and the rest is undone.
  const unmerged = withTheSystemRefusing(nothingMadeOrRemovedIn(real), () => mergeTree(copy, real, before, held));
  assert.ok(unmerged.some((it) => it.path === "sub/d"), JSON.stringify(unmerged));
  assert.deepEqual(describe(real), asItWas);
});

test("a directory left under the merge's own name, because the system would not remove all of it, is closed there", { skip: asRoot || process.platform !== "darwin" }, (t) => {
  const real = scratch(t), copy = scratch(t);
  mkdirSync(join(real, "d", "shut"), { recursive: true });
  writeFileSync(join(real, "d", "shut", "stuck"), "as it was");
  execFileSync("chflags", ["uchg", join(real, "d", "shut", "stuck")]);
  chmodSync(join(real, "d", "shut"), 0o555);
  const held = copyTree(real, copy);
  execFileSync("chflags", ["-R", "nouchg", copy]);
  const before = readTree(copy);
  chmodSync(join(copy, "d", "shut"), 0o755); rmSync(join(copy, "d"), { recursive: true }); writeFileSync(join(copy, "d"), "a file now");
  const unmerged = mergeTree(copy, real, before, held);
  const left = readdirSync(real).find((name) => name.startsWith(".trama-tmp-"));
  const shut = left && lstatSync(join(real, left, "shut")).mode & 0o777;
  if (left) { chmodSync(join(real, left, "shut"), 0o755); execFileSync("chflags", ["nouchg", join(real, left, "shut", "stuck")]); }
  assert.deepEqual(unmerged.map((it) => it.path), [left]);
  assert.equal(readFileSync(join(real, "d"), "utf-8"), "a file now");
  assert.equal(shut, 0o555, "the directory in what is left allows what it allowed");
});

test("a directory the run removed, from which the system will not remove everything, is left holding that — and is told of", { skip: asRoot || process.platform !== "darwin" }, (t) => {
  const real = scratch(t), copy = scratch(t);
  mkdirSync(join(real, "old", "deep"), { recursive: true });
  for (const file of ["old/0-stuck", "old/a", "old/deep/b", "old/deep/stuck", "old/z", "stays"]) writeFileSync(join(real, file), "as it was");
  // They may be moved with what they are in, and not removed. (One comes, by its name, before the directory beside it.)
  for (const stuck of ["old/0-stuck", "old/deep/stuck"]) execFileSync("chflags", ["uchg", join(real, stuck)]);
  const held = copyTree(real, copy);
  execFileSync("chflags", ["-R", "nouchg", copy]); // (the run is not held to that: this is about what the system does to the merge)
  const before = readTree(copy);
  rmSync(join(copy, "old"), { recursive: true });
  const unmerged = mergeTree(copy, real, before, held);
  for (const stuck of ["old/0-stuck", "old/deep/stuck"]) execFileSync("chflags", ["nouchg", join(real, stuck)]);
  // As removing it where it is would have left it: all that could go has gone, and nothing lies about under another name.
  assert.deepEqual(describe(real), {
    "old": "dir 755", "old/0-stuck": 'file 644 "as it was"', "old/deep": "dir 755", "old/deep/stuck": 'file 644 "as it was"', "stays": 'file 644 "as it was"',
  });
  assert.deepEqual(unmerged.map((it) => it.path), ["old"]);
  assert.match(unmerged[0].why, /the run removed it, and the system would not have it removed, or not all that was in it \(EPERM.*\): what is left is there/);
});

test("a file the run wrote into is written into, and one it put another in the place of has another put in its place", (t) => {
  // What tells the two apart afterwards is a second name of the file: it follows what is written, not what is replaced.
  const make = (dir) => {
    for (const name of ["written", "replaced"]) { writeFileSync(join(dir, name), "old"); linkSync(join(dir, name), join(dir, `${name}-too`)); }
  };
  const run = (dir) => {
    writeFileSync(join(dir, "written"), "new");
    writeFileSync(join(dir, "fresh"), "new"); renameSync(join(dir, "fresh"), join(dir, "replaced"));
  };
  const direct = scratch(t), real = scratch(t), copy = scratch(t);
  make(direct); make(real);
  const held = copyTree(real, copy);
  // (A copy has every name as a file of its own: the second names are put right in it, as the run would find them.)
  for (const name of ["written", "replaced"]) { unlinkSync(join(copy, `${name}-too`)); linkSync(join(copy, name), join(copy, `${name}-too`)); }
  const before = readTree(copy);
  run(direct); run(copy);
  assert.deepEqual(mergeTree(copy, real, before, held), []);
  assert.deepEqual(describe(real), describe(direct));
  assert.equal(describe(real)["written-too"], 'file 644 "new"');
  assert.equal(describe(real)["replaced-too"], 'file 644 "old"');
});

test("a directory made where a link was, and unmade because the link did not arrive where the run moved it, is not closed through the link put back", { skip: asRoot }, (t) => {
  // Whether or not what the link leads to may be looked into: nothing is done there, and nothing is said of it.
  for (const closed of [false, true]) {
    const base = scratch(t);
    const real = join(base, "deep", "project"), copy = join(base, "elsewhere", "copy"), outside = join(base, "outside");
    for (const dir of [join(real, "sub"), copy, join(outside, "s")]) mkdirSync(dir, { recursive: true });
    chmodSync(join(outside, "s"), 0o775);
    symlinkSync(outside, join(real, "sub", "p"));
    const held = copyTree(real, copy);
    const before = readTree(copy);
    // The link goes to the top of the directory; where it was, a directory of that name with a closed one in it.
    renameSync(join(copy, "sub", "p"), join(copy, "moved"));
    mkdirSync(join(copy, "sub", "p", "s"), { recursive: true }); chmodSync(join(copy, "sub", "p", "s"), 0o500);
    if (closed) chmodSync(outside, 0o000);
    // Nothing may be made at the top: the link does not arrive.
    const unmerged = withTheSystemRefusing(nothingMadeOrRemovedIn(real), () => mergeTree(copy, real, before, held));
    if (closed) chmodSync(outside, 0o755);
    assert.deepEqual(unmerged.map((it) => it.path).sort(), ["moved", "sub/p"]);
    assert.equal(readlinkSync(join(real, "sub", "p")), outside);
    assert.equal(statSync(join(outside, "s")).mode & 0o777, 0o775, "what is outside the directory allows what it allowed");
  }
});

test("a file the run wrote into and left unreadable is written into all the same: it stays the file it was", (t) => {
  for (const mode of [0o200, 0o000, 0o244]) {
    const base = scratch(t);
    const real = join(base, "project"), copy = join(base, "copy");
    mkdirSync(real); mkdirSync(copy);
    writeFileSync(join(real, "f"), "old");
    linkSync(join(real, "f"), join(base, "its-second-name")); // beside the directory: it tells whether f is still that file
    const held = copyTree(real, copy);
    const before = readTree(copy);
    writeFileSync(join(copy, "f"), "new, and longer"); chmodSync(join(copy, "f"), mode);
    assert.deepEqual(mergeTree(copy, real, before, held), []);
    assert.equal(identityOf(join(real, "f")), identityOf(join(base, "its-second-name")), mode.toString(8));
    chmodSync(join(real, "f"), 0o600);
    assert.equal(readFileSync(join(base, "its-second-name"), "utf-8"), "new, and longer");
  }
});

test("something the run made anew that looks as what was there is no change: a link the copy has in other words stays as the directory has it", (t) => {
  const base = scratch(t);
  const real = join(base, "project"), copy = join(base, "elsewhere", "copy");
  mkdirSync(join(real, "links"), { recursive: true }); mkdirSync(join(real, "sub")); mkdirSync(copy, { recursive: true });
  writeFileSync(join(real, "sub", "x"), "X");
  symlinkSync("../../project/sub/x", join(real, "links", "l")); // out of the directory and back: the copy says it by full path
  const held = copyTree(real, copy);
  const before = readTree(copy);
  const itsWords = readlinkSync(join(copy, "links", "l"));
  unlinkSync(join(copy, "links", "l")); symlinkSync(itsWords, join(copy, "links", "l")); // made again, saying what it said
  assert.deepEqual(mergeTree(copy, real, before, held), []);
  assert.equal(readlinkSync(join(real, "links", "l")), "../../project/sub/x");
});

test("a file the run wrote into is left as it was where nothing can be made beside it: what it held is not staked on the writing", { skip: asRoot }, (t) => {
  const real = scratch(t), copy = scratch(t);
  writeFileSync(join(real, "journal.log"), "what it held");
  const held = copyTree(real, copy);
  const before = readTree(copy);
  appendFileSync(join(copy, "journal.log"), ", and more");
  const was = identityOf(join(real, "journal.log"));
  const unmerged = withTheSystemRefusing(nothingMadeOrRemovedIn(real), () => mergeTree(copy, real, before, held));
  assert.deepEqual(unmerged.map((it) => it.path), ["journal.log"]);
  assert.deepEqual(describe(real), { "journal.log": 'file 644 "what it held"' });
  assert.equal(identityOf(join(real, "journal.log")), was);
});

test("a directory that cannot be given what the run left it allowing is told of for that, and what is in it has arrived", { skip: asRoot || process.platform !== "darwin" }, (t) => {
  const real = scratch(t), copy = scratch(t);
  mkdirSync(join(real, "conf")); writeFileSync(join(real, "conf", "settings"), "old");
  execFileSync("chflags", ["uchg", join(real, "conf")]); // it may not be changed itself; the file in it may
  const held = copyTree(real, copy);
  execFileSync("chflags", ["nouchg", join(copy, "conf")]);
  const before = readTree(copy);
  chmodSync(join(copy, "conf"), 0o700); mkdirSync(join(copy, "other")); writeFileSync(join(copy, "other", "f"), "new");
  const unmerged = mergeTree(copy, real, before, held);
  execFileSync("chflags", ["nouchg", join(real, "conf")]);
  assert.deepEqual(unmerged.map((it) => it.path), ["conf"]);
  assert.match(unmerged[0].why, /what it is to allow \(700\) could not be set \(EPERM/);
  assert.deepEqual(describe(real), { "conf": "dir 755", "conf/settings": 'file 644 "old"', "other": "dir 755", "other/f": 'file 644 "new"' });
});

test("something the run moved to the name of another like it is still moved: it stays where it was if that name is gone", (t) => {
  // An empty directory in the place of an empty directory, a link in the place of one that says the same: to look
  // at, nothing changed there. It is another thing all the same, and the one it was moved from goes only if it is there.
  const real = scratch(t), copy = scratch(t);
  for (const name of ["d", "e"]) mkdirSync(join(real, name));
  for (const name of ["p", "q"]) symlinkSync("somewhere", join(real, name));
  const held = copyTree(real, copy);
  const before = readTree(copy);
  rmdirSync(join(copy, "d")); renameSync(join(copy, "e"), join(copy, "d"));
  unlinkSync(join(copy, "q")); renameSync(join(copy, "p"), join(copy, "q"));
  rmdirSync(join(real, "d")); unlinkSync(join(real, "q")); // meanwhile
  const unmerged = mergeTree(copy, real, before, held);
  assert.deepEqual(unmerged.map((it) => it.path).sort(), ["d", "e", "p", "q"]);
  assert.deepEqual(describe(real), { "e": "dir 755", "p": "link to <root>/somewhere" });
});

test("a directory the run moved away, with another made in its place: what was in it stays if it did not arrive, and the new one's work arrives", { skip: asRoot }, (t) => {
  const real = scratch(t), copy = scratch(t);
  mkdirSync(join(real, "d")); writeFileSync(join(real, "d", "x"), "X");
  const held = copyTree(real, copy);
  const before = readTree(copy);
  renameSync(join(copy, "d"), join(copy, "moved")); mkdirSync(join(copy, "d")); chmodSync(join(copy, "d"), 0o700); writeFileSync(join(copy, "d", "fresh"), "F");
  // Nothing may be made in the directory itself: "moved" does not arrive.
  const unmerged = withTheSystemRefusing(nothingMadeOrRemovedIn(real), () => mergeTree(copy, real, before, held));
  assert.deepEqual(unmerged.map((it) => it.path).sort(), ["d/x", "moved"]);
  assert.deepEqual(describe(real), { "d": "dir 700", "d/fresh": 'file 644 "F"', "d/x": 'file 644 "X"' });
});

test("a file that only allows something else afterwards is the file it was, also where it may not be written to", (t) => {
  for (const [from, to] of [[0o444, 0o644], [0o444, 0o400], [0o644, 0o600]]) {
    const real = scratch(t), copy = scratch(t);
    writeFileSync(join(real, "f"), "the same"); chmodSync(join(real, "f"), from);
    linkSync(join(real, "f"), join(real, "its-second-name"));
    const held = copyTree(real, copy);
    const before = readTree(copy);
    chmodSync(join(copy, "f"), to); chmodSync(join(copy, "its-second-name"), to);
    const was = identityOf(join(real, "f"));
    assert.deepEqual(mergeTree(copy, real, before, held), []);
    assert.equal(identityOf(join(real, "f")), was);
    assert.equal(identityOf(join(real, "its-second-name")), was);
    assert.equal(lstatSync(join(real, "f")).mode & 0o777, to);
  }
});

test("a merge into a directory that cannot be come to says so, and throws nothing", { skip: asRoot }, (t) => {
  const base = scratch(t);
  const real = join(base, "above", "project"), copy = join(base, "copy");
  mkdirSync(real, { recursive: true }); mkdirSync(copy);
  const held = copyTree(real, copy);
  const before = readTree(copy);
  writeFileSync(join(copy, "f"), "f");
  chmodSync(join(base, "above"), 0o000);
  const unmerged = mergeTree(copy, real, before, held);
  chmodSync(join(base, "above"), 0o755);
  assert.deepEqual(unmerged.map((it) => it.path), ["."]);
  assert.match(unmerged[0].why, /the project could not be come to .*nothing was merged into it/);
  assert.deepEqual(readdirSync(real), []);
});

test("what the run removed and somebody else removed too is not told of, though they changed what its directory allows", (t) => {
  const real = scratch(t), copy = scratch(t);
  mkdirSync(join(real, "d"));
  for (const file of ["d/goes.txt", "d/stays.txt"]) writeFileSync(join(real, file), "as it was");
  const held = copyTree(real, copy);
  const before = readTree(copy);
  rmSync(join(copy, "d", "goes.txt"));
  rmSync(join(real, "d", "goes.txt")); chmodSync(join(real, "d"), 0o700); // meanwhile
  assert.deepEqual(mergeTree(copy, real, before, held), []);
  assert.deepEqual(describe(real), { "d": "dir 700", "d/stays.txt": 'file 644 "as it was"' });
});

test("a directory somebody closed meanwhile is told of as changed, and is left as they left it", { skip: asRoot }, (t) => {
  for (const mode of [0o000, 0o400, 0o300]) {
    const real = scratch(t), copy = scratch(t);
    mkdirSync(join(real, "d", "e"), { recursive: true });
    for (const file of ["d/goes.txt", "d/stays.txt", "d/e/deep.txt"]) writeFileSync(join(real, file), "as it was");
    const held = copyTree(real, copy);
    const before = readTree(copy);
    writeFileSync(join(copy, "d", "a-new.txt"), "BY THE RUN"); // (its turn comes before that of what is deeper)
    writeFileSync(join(copy, "d", "new.txt"), "BY THE RUN");
    rmSync(join(copy, "d", "goes.txt"));
    writeFileSync(join(copy, "d", "e", "deep.txt"), "BY THE RUN");
    chmodSync(join(real, "d"), mode); // meanwhile
    const asTheyLeftIt = describe(real);
    const unmerged = mergeTree(copy, real, before, held);
    // What is in d is in a directory that was changed. What is deeper is in one that was not — but the way to it
    // is through d, and a directory somebody closed is not opened to come to it, or to be asked its names: where
    // d still lets a path through and will not list what it holds (0o300), whether it still has "e" by that name
    // cannot be asked, and nothing is done there either.
    assert.deepEqual(unmerged.map((it) => it.path).sort(), ["d/a-new.txt", "d/e/deep.txt", "d/goes.txt", "d/new.txt"], mode.toString(8));
    for (const path of ["d/a-new.txt", "d/goes.txt", "d/new.txt"]) assert.match(unmerged.find((it) => it.path === path).why, /what d allows was changed in the project meanwhile/);
    assert.deepEqual(describe(real), asTheyLeftIt);
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
  for (const path of Object.keys(why)) assert.match(why[path], /what is not content — a pipe, a socket, a device, a link whose words are not text/);
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
  assert.deepEqual([...held.keys()].sort(), [".", "logs", "logs/latest.jsonl"]);
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
  for (const it of unmerged) assert.match(it.why, /takes that name for one that is there already|takes for a name of this|not all that is in it can go/, it.path);
  delete now["other.txt"]; delete asItWas["other.txt"];
  assert.deepEqual(now, asItWas);
});

test("a file with two names, one of which the run spelled anew: neither name goes, and it is told", (t) => {
  const real = scratch(t), copy = scratch(t);
  writeFileSync(join(real, "a.txt"), "shared");
  linkSync(join(real, "a.txt"), join(real, "z.txt")); // one file: what tells it from others does not tell its names apart
  mkdirSync(join(real, "sub"));
  linkSync(join(real, "a.txt"), join(real, "sub", "third.txt"));
  writeFileSync(join(real, "b.txt"), "shared too");
  linkSync(join(real, "b.txt"), join(real, "y.txt"));
  const oneName = existsSync(join(real, "A.TXT"));
  const held = copyTree(real, copy);
  const before = readTree(copy);
  renameSync(join(copy, "z.txt"), join(copy, "Z.txt")); writeFileSync(join(copy, "Z.txt"), "NEW");
  writeFileSync(join(copy, "sub", "third.txt"), "written under its third name");
  renameSync(join(copy, "y.txt"), join(copy, "Y.txt")); rmSync(join(copy, "b.txt"));
  const unmerged = mergeTree(copy, real, before, held);
  if (!oneName) {
    assert.deepEqual(unmerged, []);
    return assert.deepEqual(readdirSync(real).sort(), ["Y.txt", "Z.txt", "a.txt", "sub"]);
  }
  // Every other name of each file is as much what "Z.txt" and "Y.txt" could be: all that the run changed are left —
  // also the one in another directory, through which what "z.txt" holds would be written all the same.
  assert.deepEqual(unmerged.map((it) => it.path).sort(), ["Y.txt", "Z.txt", "b.txt", "sub/third.txt", "y.txt", "z.txt"]);
  assert.deepEqual(readdirSync(real).sort(), ["a.txt", "b.txt", "sub", "y.txt", "z.txt"]);
  for (const name of ["a.txt", "z.txt", "sub/third.txt"]) assert.equal(readFileSync(join(real, name), "utf-8"), "shared");
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

test("what the caller put into the directory since the copy was made, and says so in the seed, is what the run's work is merged over", (t) => {
  // As a repair does it: the program goes in first, a new file in the old one's place; then what its run did is merged.
  const install = (real, held, text) => {
    writeFileSync(join(real, "program.new"), text);
    chmodSync(join(real, "program.new"), 0o600);
    renameSync(join(real, "program.new"), join(real, "program.ts"));
    held?.set("program.ts", entryAt(join(real, "program.ts")));
  };
  const cases = {
    "nothing":           { run: () => {}, left: "FIX", is: "file 600 \"FIX\"" },
    "rewrote itself":    { run: (dir) => writeFileSync(join(dir, "program.ts"), "SELF"), left: "SELF", is: "file 600 \"SELF\"" },
    "allowed more":      { run: (dir) => chmodSync(join(dir, "program.ts"), 0o755), left: "FIX", is: "file 755 \"FIX\"" },
    "took its place":    { run: (dir) => { writeFileSync(join(dir, "p"), "SELF"); renameSync(join(dir, "p"), join(dir, "program.ts")); }, left: "SELF", is: "file 644 \"SELF\"" },
    "made itself a link": { run: (dir) => { renameSync(join(dir, "program.ts"), join(dir, "main.ts")); symlinkSync("main.ts", join(dir, "program.ts")); }, left: "FIX", is: "link to <root>/main.ts" },
  };
  for (const [what, { run, left, is }] of Object.entries(cases)) {
    for (const told of [true, false]) {
      const real = scratch(t), copy = scratch(t);
      writeFileSync(join(real, "program.ts"), "OLD"); chmodSync(join(real, "program.ts"), 0o600);
      const held = copyTree(real, copy);
      writeFileSync(join(copy, "program.ts"), "FIX");
      const before = readTree(copy);
      run(copy);
      install(real, told ? held : undefined, left);
      const unmerged = mergeTree(copy, real, before, held);
      if (told || what === "nothing" || what === "rewrote itself") {
        assert.deepEqual(unmerged, [], what);
        assert.equal(describe(real)["program.ts"], is, what);
        if (what === "made itself a link") assert.equal(describe(real)["main.ts"], "file 600 \"FIX\"");
      } else {
        // The seed not told, what is at the program's place is somebody else's: it is not the file the copy was made of.
        assert.deepEqual(unmerged.map((it) => it.path), ["program.ts"], what);
        assert.equal(describe(real)["program.ts"], `file 600 ${JSON.stringify(left)}`, what);
      }
    }
  }
});

test("what is not content is not carried into a copy, and nothing is merged over it", (t) => {
  const real = scratch(t), copy = scratch(t);
  execFileSync("mkfifo", [join(real, "pipe")]);
  symlinkSync("loop/on", join(real, "loop")); // the way to what it names goes through itself
  symlinkSync(join(real, "not-yet") + "/", join(real, "to-come")); // cannot be followed while not-yet is not there
  symlinkSync("itself", join(real, "itself")); // names a place — its own — and the system will not go there
  writeFileSync(join(real, "file.txt"), "f");
  const held = copyTree(real, copy);
  assert.deepEqual(readdirSync(copy).sort(), ["file.txt"]);
  for (const name of ["pipe", "loop", "to-come", "itself"]) assert.equal(held.get(name).kind, "other", name);

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
        try {
          leads = realpathSync.native(join(real, path));
        } catch (err) {
          // To nothing — or nowhere the system will go, and then it will not go there from the copy either.
          if (err.code !== "ENOENT") assert.throws(() => statSync(join(copy, path)), `${path} is refused in the directory (${err.code}), and followed in the copy\n${told()}`);
          continue;
        }
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

test("a link by full path to a place outside the directory says in a copy what it said: its words, not where they were found to lead", (t) => {
  const base = scratch(t);
  const real = join(base, "proj"), copy = join(base, "elsewhere", "copy"), out = join(base, "out");
  for (const dir of [join(real, "d0"), copy, join(out, "first"), join(out, "second")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(out, "first", "x.txt"), "FIRST");
  writeFileSync(join(out, "second", "x.txt"), "SECOND");
  symlinkSync("first", join(out, "now")); // outside, and a link of nobody's copy
  symlinkSync(join(out, "now", "x.txt"), join(real, "k"));
  symlinkSync(join(out, "now", "x.txt"), join(real, "d0", "deeper"));
  symlinkSync(`${out}/./first/../now/`, join(real, "roundabout"));
  copyTree(real, copy);
  // The way never comes to the directory: the same words name the same place from anywhere, and are kept.
  assert.equal(readlinkSync(join(copy, "k")), join(out, "now", "x.txt"));
  assert.equal(readlinkSync(join(copy, "d0", "deeper")), join(out, "now", "x.txt"));
  assert.equal(readlinkSync(join(copy, "roundabout")), `${out}/./first/../now/`);
  assert.equal(readFileSync(join(copy, "k"), "utf-8"), "FIRST");
  // Were the copy's link to say where the words led when it was made, it would not go where the directory's goes
  // once the link outside is pointed elsewhere.
  unlinkSync(join(out, "now"));
  symlinkSync("second", join(out, "now"));
  for (const dir of [real, copy]) {
    assert.equal(readFileSync(join(dir, "k"), "utf-8"), "SECOND", dir);
    assert.equal(readFileSync(join(dir, "d0", "deeper"), "utf-8"), "SECOND", dir);
    assert.equal(realpathSync(join(dir, "roundabout")), join(out, "second"), dir);
  }
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

test("a link that leaves the directory and comes back still goes by the links of the directory on its way", (t) => {
  // A release is pointed at by "current"; "status" is reached through it, by words that leave the directory first.
  const make = (base) => {
    const root = join(base, "proj");
    mkdirSync(join(root, "releases", "v1"), { recursive: true }); mkdirSync(join(root, "releases", "v2"));
    symlinkSync("releases/v1", join(root, "current"));
    symlinkSync("../proj/current/status", join(root, "by-name"));
    symlinkSync(`${root}/current/status`, join(root, "by-full-path"));
    return root;
  };
  const direct = make(scratch(t)), real = make(scratch(t)), copy = scratch(t);
  const run = (dir) => {
    unlinkSync(join(dir, "current")); symlinkSync("releases/v2", join(dir, "current"));
    writeFileSync(join(dir, "by-name"), "written through the link");
  };
  const held = copyTree(real, copy);
  for (const name of ["by-name", "by-full-path"]) assert.equal(readlinkSync(join(copy, name)), `${copy}/current/status`, name);
  const before = readTree(copy);
  run(direct); run(copy);
  assert.deepEqual(mergeTree(copy, real, before, held), []);
  assert.deepEqual(describe(real), describe(direct));
  assert.equal(describe(real)["releases/v2/status"], 'file 644 "written through the link"');
});

test("a link whose way goes by another that is rewritten shorter is not followed in the copy where the system does not follow it here", (t) => {
  const base = scratch(t);
  const real = join(base, "proj"), copy = join(base, "elsewhere", "copy"), out = join(base, "out");
  mkdirSync(join(real, "dir"), { recursive: true }); mkdirSync(copy, { recursive: true }); mkdirSync(out);
  writeFileSync(join(real, "dir", "f"), "F");
  // Outside, a long way round that ends in the directory: the copy's "b" has no use for it, and says where it ends.
  for (const links of [29, 30, 31, 32, 33, 39, 40, 41]) {
    for (let n = 0; n < links; n++) symlinkSync(n === links - 1 ? join(real, "dir") : join(out, `${links}-${n + 1}`), join(out, `${links}-${n}`));
    symlinkSync(join(out, `${links}-0`), join(real, `b${links}`));
    symlinkSync(`b${links}/f`, join(real, `a${links}`)); // kept as it is written — by way of "b"
  }
  copyTree(real, copy);
  for (const name of readdirSync(real)) {
    let refused;
    try { statSync(join(real, name)); } catch (err) { refused = err.code; }
    if (refused) assert.throws(() => statSync(join(copy, name)), `${name}: refused in the directory (${refused}), followed in the copy`);
  }
  assert.equal(readFileSync(join(copy, "a29"), "utf-8"), "F");
});

test("a link whose words would be too long, said of the copy, is not carried — and the rest is", (t) => {
  const base = scratch(t);
  const real = join(base, "proj"), copy = join(base, "elsewhere", "a-copy-with-a-longer-name-than-the-directory-it-is-a-copy-of");
  mkdirSync(real); mkdirSync(copy, { recursive: true });
  writeFileSync(join(real, "f.txt"), "f");
  // Out of the directory and back in, and then as many steps in place as a link can hold: a link says as much
  // as a path may be long, less one — 1024 on macOS, 4096 on Linux.
  const most = (process.platform === "darwin" ? 1024 : 4096) - 1;
  const text = "../proj/" + "./".repeat((most - "../proj/f.txt".length) >> 1) + "f.txt";
  symlinkSync(text, join(real, "long"));
  assert.equal(readFileSync(join(real, "long"), "utf-8"), "f");
  const held = copyTree(real, copy);
  assert.equal(held.get("long").kind, "other");
  assert.deepEqual(readdirSync(copy), ["f.txt"]);
});

test("a link the system will not follow for the many links on its way is not made into one it will", (t) => {
  // How many links a system follows on one way is the system's to say (macOS: 32, Linux: 40), so it is asked — for
  // ways of every length around both. None of them goes round.
  for (let links = 28; links <= 44; links++) {
    const base = scratch(t);
    const real = join(base, "proj"), copy = join(base, "elsewhere", "copy");
    mkdirSync(join(real, "data"), { recursive: true }); mkdirSync(copy, { recursive: true });
    writeFileSync(join(real, "data", "x.txt"), "X");
    for (let n = 0; n < links; n++) symlinkSync(n === links - 1 ? "data" : `l${n + 1}`, join(real, `l${n}`));
    symlinkSync(real, join(base, "alias")); // a link outside: one the copy's link has no use for, and so one fewer to follow
    const made = { "out-and-back": "../proj/l0/x.txt", "by-full-path": `${real}/l0/x.txt`, "as-written": "l0/x.txt", "by-a-link-outside": "../alias/l0/x.txt" };
    for (const [name, text] of Object.entries(made)) symlinkSync(text, join(real, name));
    copyTree(real, copy);
    for (const name of Object.keys(made)) {
      let refused;
      try { statSync(join(real, name)); } catch (err) { refused = err.code; }
      if (refused) assert.throws(() => statSync(join(copy, name)), `${links} links, ${name}: refused in the directory (${refused}), followed in the copy`);
      else if (existsSync(join(copy, name))) assert.equal(readFileSync(join(copy, name), "utf-8"), "X");
    }
  }
  // A few links on the way are followed, and still gone by in the copy.
  const base = scratch(t);
  const real = join(base, "proj"), copy = join(base, "elsewhere", "copy");
  mkdirSync(join(real, "data"), { recursive: true }); mkdirSync(copy, { recursive: true });
  writeFileSync(join(real, "data", "x.txt"), "X");
  symlinkSync("l1", join(real, "l0")); symlinkSync("data", join(real, "l1"));
  symlinkSync("../proj/l0/x.txt", join(real, "out-and-back"));
  copyTree(real, copy);
  assert.equal(readlinkSync(join(copy, "out-and-back")), `${copy}/l0/x.txt`);
  assert.equal(readFileSync(join(copy, "out-and-back"), "utf-8"), "X");
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
  const made = {
    "the-directory": `${copy}/`, "slashes": `${copy}//sub/`, "round-about": `${copy}/../copy/sub`, "deeper-round-about": `${copy}/sub/../../copy/sub`,
    "beside-it": `${copy}/../beside.txt`, "back-by-its-name": "../copy/sub", "sub/back-from-deeper": "../../copy/sub/x", "up-and-out": "../beside.txt",
  };
  for (const [name, text] of Object.entries(made)) symlinkSync(text, join(copy, name));
  assert.deepEqual(mergeTree(copy, real, before, held), []);
  // Through the copy and out of it again: to the run that was beside its directory, and is said so of the real one.
  assert.equal(readlinkSync(join(real, "beside-it")), `${real}/../beside.txt`);
  // Out of the copy and back in by its name is the copy all the same — a name the real directory does not have.
  assert.equal(readlinkSync(join(real, "back-by-its-name")), `${real}/sub`);
  assert.equal(readlinkSync(join(real, "sub", "back-from-deeper")), `${real}/sub/x`);
  assert.equal(readlinkSync(join(real, "up-and-out")), "../beside.txt");
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

// --- The directory itself ---

test("the stand-in for a directory that may not be written to refuses what the system refuses there", { skip: asRoot }, (t) => {
  const asked = {
    "make a directory": (dir) => mkdirSync(join(dir, "new")),
    "make a link": (dir) => symlinkSync("f", join(dir, "new")),
    "copy to a new name": (dir) => copyFileSync(join(dir, "f"), join(dir, "new")),
    "copy into a file that is there": (dir, beside) => copyFileSync(join(beside, "theirs"), join(dir, "f")),
    "move something in": (dir, beside) => renameSync(join(beside, "theirs"), join(dir, "new")),
    "move something out": (dir, beside) => renameSync(join(dir, "f"), join(beside, "f")),
    "give something another name": (dir) => renameSync(join(dir, "f"), join(dir, "g")),
    "remove a file": (dir) => unlinkSync(join(dir, "f")),
    "remove a directory": (dir) => rmdirSync(join(dir, "empty")),
    "remove, whatever it is": (dir) => rmSync(join(dir, "f"), { force: true }),
    "change what a file allows": (dir) => chmodSync(join(dir, "f"), 0o600),
    "make something in a directory in it": (dir) => mkdirSync(join(dir, "empty", "new")),
  };
  for (const [what, ask] of Object.entries(asked)) {
    const outcome = (closed) => {
      const base = scratch(t), dir = join(base, "dir"), beside = join(base, "beside");
      mkdirSync(join(dir, "empty"), { recursive: true }); mkdirSync(beside);
      writeFileSync(join(dir, "f"), "F"); writeFileSync(join(beside, "theirs"), "T");
      try {
        closed(dir, () => ask(dir, beside));
        return "done";
      } catch (err) {
        return err.code;
      } finally {
        chmodSync(dir, 0o755);
      }
    };
    const bySystem = outcome((dir, it) => { chmodSync(dir, 0o555); it(); });
    const byStandIn = outcome((dir, it) => withTheSystemRefusing(nothingMadeOrRemovedIn(dir), it));
    assert.equal(byStandIn, bySystem, what);
  }
});

test("a copy allows what the directory allows, and a tree says what that is", { skip: asRoot }, (t) => {
  for (const mode of [0o755, 0o700, 0o555, 0o500, 0o2755 & ~0o2000 | 0o1000]) {
    const real = scratch(t), copy = scratch(t);
    writeFileSync(join(real, "f"), "F");
    chmodSync(real, mode);
    const held = copyTree(real, copy);
    assert.equal(allowedBy(copy), mode);
    assert.deepEqual({ ...held.get("."), id: undefined }, { kind: "dir", mode, id: undefined });
    assert.equal(readTree(copy).get(".").mode, mode);
    assert.equal(readFileSync(join(copy, "f"), "utf-8"), "F");
  }
});

test("a directory that may not be written to is opened to be merged into — the directory itself like any in it — and left allowing what it allowed", { skip: asRoot }, (t) => {
  for (const where of [".", "sub", "sub/deeper"]) {
    const real = scratch(t), copy = scratch(t), direct = scratch(t);
    for (const dir of [real, direct]) {
      mkdirSync(join(dir, where), { recursive: true });
      writeFileSync(join(dir, where, "notes.txt"), "OLD");
      writeFileSync(join(dir, where, "goes.txt"), "G");
      chmodSync(join(dir, where), 0o555);
    }
    const held = copyTree(real, copy);
    const before = readTree(copy);
    const run = (dir) => {
      // Into a file that is there: that asks nothing of its directory.
      writeFileSync(join(dir, where, "notes.txt"), "WRITTEN BY THE RUN");
      // What the directory forbids, it forbids in a copy of it too.
      assert.throws(() => writeFileSync(join(dir, where, "new.txt"), "N"), { code: "EACCES" }, where);
      chmodSync(join(dir, where), 0o755);
      writeFileSync(join(dir, where, "new.txt"), "N"); rmSync(join(dir, where, "goes.txt"));
      chmodSync(join(dir, where), 0o555);
    };
    run(copy); run(direct);
    const was = identityOf(join(real, where, "notes.txt"));
    assert.deepEqual(mergeTree(copy, real, before, held), [], where);
    assert.deepEqual(describe(real), describe(direct), where);
    assert.equal(allowedBy(join(real, where)), 0o555, where);
    assert.equal(identityOf(join(real, where, "notes.txt")), was, `${where}: written into, not replaced`);
  }
});

test("what the run left the directory itself allowing is what it is left allowing", { skip: asRoot }, (t) => {
  for (const [from, to] of [[0o755, 0o700], [0o555, 0o755], [0o755, 0o555], [0o700, 0o500], [0o755, 0o000]]) {
    const real = scratch(t), copy = scratch(t);
    writeFileSync(join(real, "-first-by-its-letters"), "A"); // (a name that comes before "." as text: the directory is still seen to first)
    chmodSync(real, from);
    const held = copyTree(real, copy);
    const before = readTree(copy);
    chmodSync(copy, 0o755);
    writeFileSync(join(copy, "-first-by-its-letters"), "B"); writeFileSync(join(copy, "made.txt"), "M");
    chmodSync(copy, to);
    assert.deepEqual(mergeTree(copy, real, before, held), [], `${from.toString(8)} to ${to.toString(8)}`);
    assert.equal(allowedBy(real), to);
    assert.deepEqual(describe(real), { "-first-by-its-letters": 'file 644 "B"', "made.txt": 'file 644 "M"' });
  }
});

test("the directory itself is closed last: one in it that was opened is closed while it can still be come to", { skip: asRoot }, (t) => {
  const real = scratch(t), copy = scratch(t);
  // (A name that comes before "." as text, which is how the directory itself is written.)
  mkdirSync(join(real, "-d")); writeFileSync(join(real, "-d", "f"), "OLD"); chmodSync(join(real, "-d"), 0o555);
  const held = copyTree(real, copy);
  const before = readTree(copy);
  writeFileSync(join(copy, "-d", "f"), "NEW");
  chmodSync(copy, 0o000); // the run leaves its own directory closed to everything
  assert.deepEqual(mergeTree(copy, real, before, held), []);
  assert.equal(allowedBy(real), 0o000);
  assert.deepEqual(describe(real), { "-d": "dir 555", "-d/f": 'file 644 "NEW"' });
});

test("the directory itself, if it cannot be given back what it is to allow, is told of as that", { skip: asRoot }, (t) => {
  const real = scratch(t), copy = scratch(t);
  writeFileSync(join(real, "f"), "OLD");
  chmodSync(real, 0o555);
  const held = copyTree(real, copy);
  const before = readTree(copy);
  writeFileSync(join(copy, "f"), "NEW");
  // The system lets it be opened, and then will not have it closed again.
  let asked = 0;
  const unmerged = withTheSystemRefusing((call, place) => call === "chmodSync" && place === real && ++asked > 1, () => mergeTree(copy, real, before, held));
  assert.deepEqual(unmerged.map((it) => it.path), ["."]);
  assert.match(unmerged[0].why, /what it is to allow \(555\) could not be set/);
  assert.deepEqual(describe(real), { "f": 'file 644 "NEW"' });
});

test("a directory somebody gave other permissions meanwhile is theirs — the directory itself too: nothing is made or removed in it, and that is told", { skip: asRoot }, (t) => {
  for (const theirs of [0o555, 0o777, 0o700]) {
    for (const runChangesItToo of [false, true]) {
      const real = scratch(t), copy = scratch(t);
      mkdirSync(join(real, "sub"));
      writeFileSync(join(real, "a.txt"), "A"); writeFileSync(join(real, "goes.txt"), "G"); writeFileSync(join(real, "sub", "b.txt"), "B");
      writeFileSync(join(real, "same.txt"), "S");
      chmodSync(real, 0o755);
      const held = copyTree(real, copy);
      const before = readTree(copy);
      appendFileSync(join(copy, "a.txt"), " and more"); rmSync(join(copy, "goes.txt")); writeFileSync(join(copy, "new.txt"), "N");
      writeFileSync(join(copy, "sub", "b.txt"), "B2"); writeFileSync(join(copy, "same.txt"), "S2");
      if (runChangesItToo) chmodSync(copy, 0o750);
      // Meanwhile. (They also made one file what the run made it: that needs nothing done, whoever closed the door.)
      writeFileSync(join(real, "same.txt"), "S2");
      chmodSync(real, theirs);
      const asTheyLeftIt = describe(real);
      const unmerged = mergeTree(copy, real, before, held);
      const told = `theirs ${theirs.toString(8)}, the run ${runChangesItToo ? "changed it too" : "left it"}: ${JSON.stringify(unmerged)}`;
      assert.equal(allowedBy(real), theirs, told);
      if (runChangesItToo) {
        // What the directory allows is one of the things the run changed, and that did not arrive: nothing under it is looked at.
        assert.deepEqual(unmerged.map((it) => it.path), ["."], told);
        assert.match(unmerged[0].why, /changed or removed in the project meanwhile/);
        assert.deepEqual(describe(real), asTheyLeftIt, told);
      } else {
        assert.deepEqual(unmerged.map((it) => it.path).sort(), ["a.txt", "goes.txt", "new.txt"], told);
        for (const { why } of unmerged) assert.match(why, /what the project's own directory allows was changed meanwhile/);
        // A directory in it is as it was, and what the run did there arrives.
        assert.deepEqual(describe(real), { ...asTheyLeftIt, "sub/b.txt": 'file 644 "B2"' }, told);
      }
    }
  }
});

// --- Things that are one thing ---

/**
 * How a caller of the merge says which things are one: each by what it is.
 * Asked of the copy at some paths — once before the run, of what is there
 * then, and again when what is returned is called, of what is there now.
 */
const oneThing = (copy, paths) => {
  const whatIs = () => paths.flatMap((path) => identityOf(join(copy, path)) ?? []);
  const was = whatIs();
  return () => [[...was, ...whatIs()]];
};

test("paths that are one thing to whoever asks arrive together, or not at all: a link is not left without what it leads to", (t) => {
  for (const asOne of [true, false]) {
    const real = scratch(t), copy = scratch(t);
    writeFileSync(join(real, "main.ts"), "AS IT RAN"); writeFileSync(join(real, "as-it-was.ts"), "NOTHING IS DONE HERE");
    const held = copyTree(real, copy);
    const before = readTree(copy);
    const asOneThing = oneThing(copy, ["main.ts", "lib/main.ts", "as-it-was.ts"]);
    mkdirSync(join(copy, "lib")); writeFileSync(join(copy, "lib", "main.ts"), "WHAT IT MADE OF ITSELF");
    unlinkSync(join(copy, "main.ts")); symlinkSync("lib/main.ts", join(copy, "main.ts"));
    writeFileSync(join(copy, "other.txt"), "O");
    writeFileSync(join(real, "lib"), "THEIRS"); // meanwhile: what the link leads to cannot arrive
    const unmerged = mergeTree(copy, real, before, held, asOne ? asOneThing() : []);
    if (asOne) {
      // (A path of the one thing where nothing was to be done is not told of: nothing was to arrive there.)
      assert.deepEqual(unmerged.map((it) => it.path).sort(), ["lib", "main.ts"]);
      assert.match(unmerged.find((it) => it.path === "main.ts").why, /one thing with lib\/main\.ts, which is under lib, which did not arrive/);
      assert.deepEqual(describe(real), { "as-it-was.ts": 'file 644 "NOTHING IS DONE HERE"', "lib": 'file 644 "THEIRS"', "main.ts": 'file 644 "AS IT RAN"', "other.txt": 'file 644 "O"' });
    } else {
      // (To a merge that is not told, they are two paths: the link arrives, and leads nowhere.)
      assert.deepEqual(unmerged.map((it) => it.path), ["lib"]);
      assert.equal(readlinkSync(join(real, "main.ts")), "lib/main.ts");
    }
  }
});

test("a part of one thing that the run left as it was is leaned on by the rest: if it is not as it was in the project, the rest does not arrive", (t) => {
  const cases = {
    "it is as it was": { meanwhile: () => {}, told: [], link: "./src/app.ts" },
    "somebody removed it": { meanwhile: (real) => unlinkSync(join(real, "src", "app.ts")), told: ["main.ts", "src/app.ts"], link: "src/app.ts" },
    "somebody put something else there": {
      meanwhile: (real) => { unlinkSync(join(real, "src", "app.ts")); mkdirSync(join(real, "src", "app.ts")); }, told: ["main.ts", "src/app.ts"], link: "src/app.ts",
    },
    "somebody wrote the same into it again: it holds what it held": { meanwhile: (real) => writeFileSync(join(real, "src", "app.ts"), "AS IT RAN"), told: [], link: "./src/app.ts" },
    "the directory it is in is somebody's now, and is not looked into": { meanwhile: (real) => chmodSync(join(real, "src"), 0o300), told: ["main.ts", "src/app.ts"], link: "src/app.ts" },
  };
  for (const [what, { meanwhile, told, link }] of Object.entries(cases)) {
    const real = scratch(t), copy = scratch(t);
    mkdirSync(join(real, "src")); writeFileSync(join(real, "src", "app.ts"), "AS IT RAN"); symlinkSync("src/app.ts", join(real, "main.ts"));
    chmodSync(join(real, "src"), 0o755);
    const held = copyTree(real, copy);
    const before = readTree(copy);
    const asOneThing = oneThing(copy, ["main.ts", "src/app.ts"]);
    // The run words its link otherwise, and leaves what it leads to as it was.
    unlinkSync(join(copy, "main.ts")); symlinkSync("./src/app.ts", join(copy, "main.ts"));
    meanwhile(real);
    const unmerged = mergeTree(copy, real, before, held, asOneThing());
    assert.deepEqual(unmerged.map((it) => it.path).sort(), told, `${what}: ${JSON.stringify(unmerged)}`);
    assert.equal(readlinkSync(join(real, "main.ts")), link, what);
  }
});

test("a part of one thing that the run left as it was is left as it is — also a link the copy has in other words", (t) => {
  const base = scratch(t), real = join(base, "project"), copy = join(base, "elsewhere", "copy");
  mkdirSync(real); mkdirSync(copy, { recursive: true });
  writeFileSync(join(real, "app.ts"), "AS IT RAN"); symlinkSync("../project/app.ts", join(real, "main.ts")); // out of the directory, and back in by its name
  const held = copyTree(real, copy);
  const before = readTree(copy);
  assert.notEqual(readlinkSync(join(copy, "main.ts")), "../project/app.ts", "(the copy says it in words of its own)");
  const asOneThing = oneThing(copy, ["main.ts", "app.ts", "other.ts"]);
  writeFileSync(join(copy, "other.ts"), "MADE BY THE RUN");
  const was = identityOf(join(real, "main.ts"));
  assert.deepEqual(mergeTree(copy, real, before, held, asOneThing()), []);
  assert.equal(readlinkSync(join(real, "main.ts")), "../project/app.ts");
  assert.equal(identityOf(join(real, "main.ts")), was);
  assert.equal(readFileSync(join(real, "other.ts"), "utf-8"), "MADE BY THE RUN");
});

test("of paths that are one thing, what was removed stays if what was to be there instead does not arrive", (t) => {
  const real = scratch(t), copy = scratch(t);
  mkdirSync(join(real, "src")); writeFileSync(join(real, "src", "app.ts"), "AS IT RAN"); symlinkSync("src/app.ts", join(real, "main.ts"));
  const held = copyTree(real, copy);
  const before = readTree(copy);
  const asOneThing = oneThing(copy, ["main.ts", "src/app.ts"]);
  // The run removes what the link led to, and puts a file where the link was.
  unlinkSync(join(copy, "src", "app.ts")); unlinkSync(join(copy, "main.ts")); writeFileSync(join(copy, "main.ts"), "AS IT RAN");
  // Meanwhile somebody words the link otherwise: it is theirs now, and the file does not take its place.
  unlinkSync(join(real, "main.ts")); symlinkSync("./src/app.ts", join(real, "main.ts"));
  const unmerged = mergeTree(copy, real, before, held, asOneThing());
  assert.deepEqual(unmerged.map((it) => it.path).sort(), ["main.ts", "src/app.ts"]);
  assert.equal(readFileSync(join(real, "main.ts"), "utf-8"), "AS IT RAN", "the link still leads to what it led to");
  assert.equal(readlinkSync(join(real, "main.ts")), "./src/app.ts");
});

test("of paths that are one thing, what was already put is taken back when the system will not have the rest", { skip: asRoot }, (t) => {
  const real = scratch(t), copy = scratch(t);
  writeFileSync(join(real, "a"), "AS IT RAN");
  const held = copyTree(real, copy);
  const before = readTree(copy);
  const asOneThing = oneThing(copy, ["a", "z/b"]);
  mkdirSync(join(copy, "z")); writeFileSync(join(copy, "z", "b"), "WHAT IT MADE OF ITSELF"); writeFileSync(join(copy, "z", "beside"), "NOTHING TO THE LINK");
  unlinkSync(join(copy, "a")); symlinkSync("z/b", join(copy, "a"));
  const was = identityOf(join(real, "a"));
  // The link is put first, by the order of the names; then the system will not have the file made that it leads to.
  const unmerged = withTheSystemRefusing((call, place) => call === "copyFileSync" && place === join(real, "z", "b"),
    () => mergeTree(copy, real, before, held, asOneThing()));
  assert.deepEqual(unmerged.map((it) => it.path).sort(), ["a", "z/b"]);
  assert.equal(identityOf(join(real, "a")), was, "the file that was there is there again");
  // (The directory the file was to be in is nothing to the link: it arrives, with what else the run made in it.)
  assert.deepEqual(describe(real), { "a": 'file 644 "AS IT RAN"', "z": "dir 755", "z/beside": 'file 644 "NOTHING TO THE LINK"' });
});

test("a file that is one thing with other paths is not written into: what the run left is put in its place, and what was there comes back if the rest does not arrive", { skip: asRoot }, (t) => {
  for (const arrives of [true, false]) {
    const real = scratch(t), copy = scratch(t);
    writeFileSync(join(real, "a.ts"), "AS IT RAN"); symlinkSync("a.ts", join(real, "program.ts")); mkdirSync(join(real, "lib"));
    mkdirSync(join(real, "dir")); writeFileSync(join(real, "dir", "f.ts"), "F"); chmodSync(join(real, "dir"), 0o755);
    writeFileSync(join(real, "dir", "none-of-it.txt"), "OLD");
    linkSync(join(real, "a.ts"), join(real, "its-second-name"));
    const held = copyTree(real, copy);
    const before = readTree(copy);
    const asOneThing = oneThing(copy, ["program.ts", "a.ts", "lib/b.ts", "dir", "dir/f.ts"]);
    // The run writes into the file, changes what a file and a directory allow, and makes the link lead to a new file.
    writeFileSync(join(copy, "a.ts"), "NO PROGRAM ANY MORE"); writeFileSync(join(copy, "lib", "b.ts"), "WHAT IT MADE OF ITSELF");
    unlinkSync(join(copy, "program.ts")); symlinkSync("lib/b.ts", join(copy, "program.ts"));
    writeFileSync(join(copy, "dir", "none-of-it.txt"), "NEW"); // (in a directory that is part of the thing, and none of it itself)
    chmodSync(join(copy, "dir", "f.ts"), 0o600); chmodSync(join(copy, "dir"), 0o700);
    const asItWas = describe(real), was = identityOf(join(real, "a.ts"));
    const unmerged = withTheSystemRefusing((call, place) => !arrives && call === "copyFileSync" && place === join(real, "lib", "b.ts"),
      () => mergeTree(copy, real, before, held, asOneThing()));
    if (arrives) {
      assert.deepEqual(unmerged, []);
      assert.deepEqual(describe(real), {
        "a.ts": 'file 644 "NO PROGRAM ANY MORE"', "dir": "dir 700", "dir/f.ts": 'file 600 "F"', "dir/none-of-it.txt": 'file 644 "NEW"', "its-second-name": 'file 644 "AS IT RAN"',
        "lib": "dir 755", "lib/b.ts": 'file 644 "WHAT IT MADE OF ITSELF"', "program.ts": "link to <root>/lib/b.ts",
      });
    } else {
      assert.deepEqual(unmerged.map((it) => it.path).sort(), ["a.ts", "dir", "dir/f.ts", "lib/b.ts", "program.ts"]);
      assert.match(unmerged.find((it) => it.path === "dir").why, /what it was to allow \(700\) is one thing with lib\/b\.ts, which did not arrive: it is left allowing what it allowed/);
      // Nothing of it is done: not what was written, nor what a file or a directory allows. What else the run did in
      // the directory is none of it, and arrives: the directory is not left alone, only left allowing what it allowed.
      assert.deepEqual(describe(real), { ...asItWas, "dir/none-of-it.txt": 'file 644 "NEW"' });
      assert.equal(identityOf(join(real, "a.ts")), was, "and the file that was there is there again");
    }
  }
});

test("what is to go, of paths that are one thing, is moved aside first: it stays if the system will not let it go, and with it the rest", { skip: asRoot }, (t) => {
  for (const refused of ["to move it aside", "to remove it for good"]) {
    const real = scratch(t), copy = scratch(t);
    writeFileSync(join(real, "old.ts"), "AS IT RAN"); symlinkSync("old.ts", join(real, "program.ts"));
    const held = copyTree(real, copy);
    const before = readTree(copy);
    const asOneThing = oneThing(copy, ["program.ts", "old.ts"]);
    unlinkSync(join(copy, "old.ts")); unlinkSync(join(copy, "program.ts")); writeFileSync(join(copy, "program.ts"), "WHAT IT MADE OF ITSELF");
    const asItWas = describe(real);
    const refuses = refused === "to move it aside"
      ? (call, place, from) => call === "renameSync" && from === join(real, "old.ts")
      : (call, place) => call === "unlinkSync" && basename(place).startsWith(".trama-tmp-") && lstatSync(place).isFile() && readFileSync(place, "utf-8") === "AS IT RAN";
    const unmerged = withTheSystemRefusing(refuses, () => mergeTree(copy, real, before, held, asOneThing()));
    if (refused === "to move it aside") {
      assert.deepEqual(unmerged.map((it) => it.path).sort(), ["old.ts", "program.ts"]);
      assert.deepEqual(describe(real), asItWas);
    } else {
      // By then the rest has arrived, and it is gone from its place: what is left of it is told of where it is.
      assert.equal(unmerged.length, 1);
      assert.match(unmerged[0].path, /^\.trama-tmp-[0-9a-f]{12}$/);
      assert.match(unmerged[0].why, /what was at old\.ts, and was to go, is here/);
      assert.deepEqual(describe(real), { [unmerged[0].path]: 'file 644 "AS IT RAN"', "program.ts": 'file 644 "WHAT IT MADE OF ITSELF"' });
    }
  }
});

test("what goes of one thing, in a directory that goes whole and is none of it, is not removed a second time", (t) => {
  const real = scratch(t), copy = scratch(t);
  mkdirSync(join(real, "old", "deep"), { recursive: true }); writeFileSync(join(real, "old", "app.ts"), "AS IT RAN"); writeFileSync(join(real, "old", "other"), "O");
  const held = copyTree(real, copy);
  const before = readTree(copy);
  const asOneThing = oneThing(copy, ["program.ts", "old/app.ts", "old/deep"]);
  rmSync(join(copy, "old"), { recursive: true }); writeFileSync(join(copy, "program.ts"), "WHAT IT MADE OF ITSELF");
  assert.deepEqual(mergeTree(copy, real, before, held, asOneThing()), []);
  assert.deepEqual(describe(real), { "program.ts": 'file 644 "WHAT IT MADE OF ITSELF"' });
});

test("a directory that goes, of paths that are one thing, goes with what is in it — or comes back with it", { skip: asRoot }, (t) => {
  for (const arrives of [true, false]) {
    const real = scratch(t), copy = scratch(t);
    mkdirSync(join(real, "src", "deep"), { recursive: true });
    writeFileSync(join(real, "src", "app.ts"), "AS IT RAN"); writeFileSync(join(real, "src", "deep", "x"), "X"); symlinkSync("src/app.ts", join(real, "program.ts"));
    const held = copyTree(real, copy);
    const before = readTree(copy);
    const asOneThing = oneThing(copy, ["program.ts", "src", "src/app.ts"]);
    rmSync(join(copy, "src"), { recursive: true }); unlinkSync(join(copy, "program.ts")); writeFileSync(join(copy, "program.ts"), "WHAT IT MADE OF ITSELF");
    const asItWas = describe(real);
    // (The system will not have the file moved in where the link was — once: the link is let back.)
    let asked = 0;
    const unmerged = withTheSystemRefusing((call, place) => !arrives && call === "renameSync" && place === join(real, "program.ts") && ++asked === 1,
      () => mergeTree(copy, real, before, held, asOneThing()));
    if (arrives) {
      assert.deepEqual(unmerged, []);
      assert.deepEqual(describe(real), { "program.ts": 'file 644 "WHAT IT MADE OF ITSELF"' });
    } else {
      assert.deepEqual(unmerged.map((it) => it.path).sort(), ["program.ts", "src"]);
      assert.deepEqual(describe(real), asItWas);
    }
  }
});

test("whether the system will have a directory of one thing changed is known while the rest can be taken back", { skip: asRoot }, (t) => {
  const real = scratch(t), copy = scratch(t);
  mkdirSync(join(real, "dir")); chmodSync(join(real, "dir"), 0o755); writeFileSync(join(real, "g"), "OLD");
  const held = copyTree(real, copy);
  const before = readTree(copy);
  const asOneThing = oneThing(copy, ["dir", "g", "h"]);
  chmodSync(join(copy, "dir"), 0o555); writeFileSync(join(copy, "g"), "NEW"); writeFileSync(join(copy, "h"), "NEW");
  const asItWas = describe(real);
  // The system will not have what the directory allows changed — which, left to the end, would be found out too late.
  const unmerged = withTheSystemRefusing((call, place) => call === "chmodSync" && place === join(real, "dir"), () => mergeTree(copy, real, before, held, asOneThing()));
  assert.deepEqual(unmerged.map((it) => it.path).sort(), ["dir", "g", "h"]);
  assert.deepEqual(describe(real), asItWas);
});

test("a part of one thing that the run left as it was is looked at, and no more: its directory is not opened for it", { skip: asRoot }, (t) => {
  const real = scratch(t), copy = scratch(t);
  mkdirSync(join(real, "d")); writeFileSync(join(real, "d", "u"), "U"); writeFileSync(join(real, "v"), "OLD"); chmodSync(join(real, "d"), 0o555);
  const held = copyTree(real, copy);
  const before = readTree(copy);
  const asOneThing = oneThing(copy, ["d/u", "v"]);
  writeFileSync(join(copy, "v"), "NEW");
  // (The system would not have it opened, or closed again: nothing asks it to.)
  const unmerged = withTheSystemRefusing((call, place) => call === "chmodSync" && place === join(real, "d"), () => mergeTree(copy, real, before, held, asOneThing()));
  assert.deepEqual(unmerged, []);
  assert.equal(readFileSync(join(real, "v"), "utf-8"), "NEW");
  assert.equal(allowedBy(join(real, "d")), 0o555);
});

test("of a thing the run left wholly as it was nothing is told, whatever somebody did to it: nothing was to arrive", (t) => {
  const real = scratch(t), copy = scratch(t);
  writeFileSync(join(real, "app.ts"), "AS IT RAN"); symlinkSync("app.ts", join(real, "main.ts"));
  const held = copyTree(real, copy);
  const before = readTree(copy);
  const asOneThing = oneThing(copy, ["main.ts", "app.ts"]);
  writeFileSync(join(copy, "state.txt"), "BY THE RUN");
  unlinkSync(join(real, "app.ts")); // meanwhile
  assert.deepEqual(mergeTree(copy, real, before, held, asOneThing()), []);
  assert.deepEqual(describe(real), { "main.ts": "link to <root>/app.ts", "state.txt": 'file 644 "BY THE RUN"' });
});

test("a directory that is part of one thing, and that somebody changed, keeps the thing from arriving — and nothing else that is in it", { skip: asRoot }, (t) => {
  const real = scratch(t), copy = scratch(t);
  mkdirSync(join(real, "s", "deep"), { recursive: true }); chmodSync(join(real, "s"), 0o755);
  writeFileSync(join(real, "s", "main"), "AS IT RAN"); writeFileSync(join(real, "s", "deep", "y"), "OLD"); symlinkSync("s/main", join(real, "prog"));
  const held = copyTree(real, copy);
  const before = readTree(copy);
  const asOneThing = oneThing(copy, ["prog", "s", "s/main"]);
  // The run words its link otherwise, and writes a file further down that is none of the thing.
  unlinkSync(join(copy, "prog")); symlinkSync("./s/main", join(copy, "prog")); writeFileSync(join(copy, "s", "deep", "y"), "NEW");
  chmodSync(join(real, "s"), 0o750); // meanwhile
  const unmerged = mergeTree(copy, real, before, held, asOneThing());
  assert.deepEqual(unmerged.map((it) => it.path).sort(), ["prog", "s"]);
  assert.match(unmerged.find((it) => it.path === "s").why, /the run left it as it was, but it was changed or removed in the project meanwhile/);
  assert.match(unmerged.find((it) => it.path === "prog").why, /it is one thing with s, which is not as it was in the project/);
  assert.equal(readlinkSync(join(real, "prog")), "s/main");
  assert.equal(readFileSync(join(real, "s", "deep", "y"), "utf-8"), "NEW", "what is under it, in a directory of its own that is as it was, arrives");
});

test("a directory that is part of two things, and is held back with the one, holds back the other", { skip: asRoot }, (t) => {
  const real = scratch(t), copy = scratch(t);
  mkdirSync(join(real, "d")); writeFileSync(join(real, "x"), "OLD"); writeFileSync(join(real, "y"), "OLD"); chmodSync(join(real, "d"), 0o500);
  const held = copyTree(real, copy);
  const before = readTree(copy);
  const one = oneThing(copy, ["d", "x"]), other = oneThing(copy, ["d", "y", "d/prog"]);
  chmodSync(join(copy, "d"), 0o755); writeFileSync(join(copy, "d", "prog"), "NEW"); writeFileSync(join(copy, "x"), "NEW"); writeFileSync(join(copy, "y"), "NEW");
  writeFileSync(join(real, "x"), "THEIRS"); // meanwhile
  const asTheyLeftIt = describe(real);
  const unmerged = mergeTree(copy, real, before, held, [...one(), ...other()]);
  assert.deepEqual(unmerged.map((it) => it.path).sort(), ["d", "d/prog", "x", "y"]);
  assert.match(unmerged.find((it) => it.path === "y").why, /it is one thing with d, which is not given what it was to allow/);
  assert.deepEqual(describe(real), asTheyLeftIt);
});

test("a chain of things, each one thing with the next through a directory, is followed to its end however long it is", { skip: asRoot }, (t) => {
  const real = scratch(t), copy = scratch(t), links = 6000;
  writeFileSync(join(real, "x"), "OLD");
  for (let n = 0; n < links; n++) mkdirSync(join(real, `d${n}`));
  for (let n = 0; n < links; n++) chmodSync(join(real, `d${n}`), 0o755);
  const held = tree.copyTree(real, copy);
  const before = tree.readTree(copy);
  const what = (path) => identityOf(join(copy, path));
  const things = [[what("x"), what("d0")]];
  for (let n = 1; n < links; n++) things.push([what(`d${n - 1}`), what(`d${n}`)]);
  writeFileSync(join(copy, "x"), "NEW");
  for (let n = 0; n < links; n++) chmodSync(join(copy, `d${n}`), 0o700);
  writeFileSync(join(real, "x"), "THEIRS"); // meanwhile: the first thing does not arrive, and so none does
  const unmerged = mergeTree(copy, real, before, held, things);
  assert.equal(unmerged.length, links + 1);
  assert.equal(allowedBy(join(real, `d${links - 1}`)), 0o755);
  assert.match(unmerged.find((it) => it.path === `d${links - 1}`).why, new RegExp(`is one thing with d${links - 2}, which is not given what it was to allow`));
});

test("a path left alone for its thing is told of under a directory that is told of for its sake: it is the reason", (t) => {
  const real = scratch(t), copy = scratch(t);
  mkdirSync(join(real, "q")); writeFileSync(join(real, "q", "b"), "B"); writeFileSync(join(real, "y"), "OLD");
  const held = copyTree(real, copy);
  const before = readTree(copy);
  const asOneThing = oneThing(copy, ["y", "q/b"]);
  rmSync(join(copy, "q"), { recursive: true }); writeFileSync(join(copy, "y"), "NEW");
  writeFileSync(join(real, "y"), "THEIRS"); // meanwhile
  const unmerged = mergeTree(copy, real, before, held, asOneThing());
  assert.deepEqual(unmerged.map((it) => it.path).sort(), ["q", "q/b", "y"]);
  assert.match(unmerged.find((it) => it.path === "q").why, /not all that is in it can go \(q\/b\)/);
  assert.match(unmerged.find((it) => it.path === "q/b").why, /it is one thing with y, which did not arrive/);
  assert.deepEqual(describe(real), { "q": "dir 755", "q/b": 'file 644 "B"', "y": 'file 644 "THEIRS"' });
});

test("a path under one that is told of is told of all the same where there is more to say of it: that it could not be put back", { skip: asRoot }, (t) => {
  const real = scratch(t), copy = scratch(t);
  const held = copyTree(real, copy);
  const before = readTree(copy);
  mkdirSync(join(copy, "b")); writeFileSync(join(copy, "b", "a"), "NEW"); writeFileSync(join(copy, "z"), "NEW");
  const what = (path) => identityOf(join(copy, path));
  // The system will not have the last part made — nor, then, the file that was put before it taken away again.
  const unmerged = withTheSystemRefusing(
    (call, place) => (call === "copyFileSync" && place === join(real, "z")) || (call === "unlinkSync" && place === join(real, "b", "a")),
    () => mergeTree(copy, real, before, held, [[what("b"), what("b/a"), what("z")]]));
  assert.deepEqual(unmerged.map((it) => it.path).sort(), ["b", "b/a", "z"]);
  assert.match(unmerged.find((it) => it.path === "b/a").why, /it could not be put back as it was/);
  assert.deepEqual(describe(real), { "b": "dir 755", "b/a": 'file 644 "NEW"' });
});

test("where things that did not arrive for different reasons have a path and its directory between them, the project is as it was and each thing is accounted for", (t) => {
  const real = scratch(t), copy = scratch(t);
  writeFileSync(join(real, "x"), "OLD"); writeFileSync(join(real, "y"), "OLD");
  const held = copyTree(real, copy);
  const before = readTree(copy);
  mkdirSync(join(copy, "b")); writeFileSync(join(copy, "b", "a"), "NEW"); writeFileSync(join(copy, "x"), "NEW"); writeFileSync(join(copy, "y"), "NEW");
  const what = (path) => identityOf(join(copy, path));
  // The file is one thing with x, its directory with y: each thing does not arrive for a part of its own.
  const things = [[what("x"), what("b/a")], [what("y"), what("b")]];
  writeFileSync(join(real, "x"), "THEIRS"); writeFileSync(join(real, "y"), "THEIRS");
  const unmerged = mergeTree(copy, real, before, held, things);
  // (The directory is left alone for its thing; the file in it is then left alone with the directory, whatever
  // order the two things are followed up in — and is told of besides only where it was left alone first.)
  const told = unmerged.map((it) => it.path).sort();
  assert.ok(["b", "x", "y"].every((path) => told.includes(path)) && told.every((path) => ["b", "b/a", "x", "y"].includes(path)), JSON.stringify(unmerged));
  assert.match(unmerged.find((it) => it.path === "b").why, /it is one thing with y, which did not arrive/);
  assert.deepEqual(describe(real), { "x": 'file 644 "THEIRS"', "y": 'file 644 "THEIRS"' });
});

test("where two things that did not arrive have a path and its directory between them, the path is not told of besides the directory", (t) => {
  for (const order of [0, 1]) {
    const real = scratch(t), copy = scratch(t);
    writeFileSync(join(real, "x"), "OLD");
    const held = copyTree(real, copy);
    const before = readTree(copy);
    mkdirSync(join(copy, "b")); writeFileSync(join(copy, "b", "a"), "NEW"); writeFileSync(join(copy, "x"), "NEW");
    const what = (path) => identityOf(join(copy, path));
    const things = [[what("x"), what("b/a")], [what("x"), what("b"), what("b/a")]];
    writeFileSync(join(real, "x"), "THEIRS");
    const unmerged = mergeTree(copy, real, before, held, order ? things.reverse() : things);
    assert.deepEqual(unmerged.map((it) => it.path).sort(), ["b", "x"]);
  }
});

test("a directory whose thing does not arrive, and in which nothing else is to be done, is not touched", { skip: asRoot }, (t) => {
  const real = scratch(t), copy = scratch(t);
  mkdirSync(join(real, "d")); writeFileSync(join(real, "x"), "OLD"); chmodSync(join(real, "d"), 0o555);
  const held = copyTree(real, copy);
  const before = readTree(copy);
  const asOneThing = oneThing(copy, ["d", "x"]);
  chmodSync(join(copy, "d"), 0o500); writeFileSync(join(copy, "x"), "NEW");
  writeFileSync(join(real, "x"), "THEIRS"); // meanwhile
  // (The system would refuse to have it opened or closed: it is not asked.)
  const unmerged = withTheSystemRefusing((call, place) => call === "chmodSync" && place === join(real, "d"), () => mergeTree(copy, real, before, held, asOneThing()));
  assert.deepEqual(unmerged.map((it) => it.path).sort(), ["d", "x"]);
  assert.match(unmerged.find((it) => it.path === "d").why, /^what it was to allow \(500\) is one thing with x, which did not arrive: it is left allowing what it allowed$/);
  assert.equal(allowedBy(join(real, "d")), 0o555);
});

test("what is told of a thing that did not arrive is true of each part: one that was not as it was, one under what did not arrive, and nothing where nothing was left undone", { skip: asRoot }, (t) => {
  // A directory held back for a part that is amiss: it is not said of that part that it did not arrive.
  {
    const real = scratch(t), copy = scratch(t);
    mkdirSync(join(real, "e")); chmodSync(join(real, "e"), 0o755); writeFileSync(join(real, "u"), "U");
    const held = copyTree(real, copy);
    const before = readTree(copy);
    const asOneThing = oneThing(copy, ["e", "u"]);
    chmodSync(join(copy, "e"), 0o700);
    writeFileSync(join(real, "u"), "THEIRS");
    const unmerged = mergeTree(copy, real, before, held, asOneThing());
    assert.deepEqual(unmerged.map((it) => it.path).sort(), ["e", "u"]);
    assert.match(unmerged.find((it) => it.path === "e").why, /is one thing with u, which is not as it was in the project: it is left allowing what it allowed/);
    assert.match(unmerged.find((it) => it.path === "u").why, /^the run left it as it was, but it was changed or removed in the project meanwhile/);
  }
  // A part the run left as it was, under a directory that did not arrive: what is said is that, not that the part did not.
  {
    const real = scratch(t), copy = scratch(t);
    mkdirSync(join(real, "d")); chmodSync(join(real, "d"), 0o755); writeFileSync(join(real, "d", "u"), "U"); writeFileSync(join(real, "v"), "OLD");
    const held = copyTree(real, copy);
    const before = readTree(copy);
    const asOneThing = oneThing(copy, ["d/u", "v"]);
    chmodSync(join(copy, "d"), 0o700); writeFileSync(join(copy, "v"), "NEW");
    chmodSync(join(real, "d"), 0o750);
    const unmerged = mergeTree(copy, real, before, held, asOneThing());
    assert.deepEqual(unmerged.map((it) => it.path).sort(), ["d", "v"]);
    assert.match(unmerged.find((it) => it.path === "v").why, /it is one thing with d\/u, which is under d, which did not arrive/);
  }
  // A part that is not as it was, where the rest is in place already — somebody made it so: nothing was left undone, and nothing is told.
  {
    const real = scratch(t), copy = scratch(t);
    writeFileSync(join(real, "u"), "U"); writeFileSync(join(real, "v"), "OLD");
    const held = copyTree(real, copy);
    const before = readTree(copy);
    const asOneThing = oneThing(copy, ["u", "v"]);
    writeFileSync(join(copy, "v"), "NEW");
    writeFileSync(join(real, "u"), "THEIRS"); writeFileSync(join(real, "v"), "NEW");
    assert.deepEqual(mergeTree(copy, real, before, held, asOneThing()), []);
  }
});

test("what a file, a directory or a link is known by is the system's numbers for it — its device's and its own", (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, "f"), "F"); mkdirSync(join(dir, "d")); symlinkSync("f", join(dir, "l"));
  for (const name of ["f", "d", "l", "."]) assert.equal(entryAt(join(dir, name)).id, identityOf(join(dir, name)), name);
  assert.match(entryAt(join(dir, "f")).id, /^\d+:\d+$/);
});

test("the directory merged into is the one that was copied: where it is gone, or another is at its path, that is said once and nothing is done", (t) => {
  for (const what of ["gone", "another directory", "a file"]) {
    const base = scratch(t), real = join(base, "project"), copy = join(base, "elsewhere", "copy");
    mkdirSync(real); mkdirSync(copy, { recursive: true });
    writeFileSync(join(real, "f"), "OLD");
    const held = copyTree(real, copy);
    const before = readTree(copy);
    writeFileSync(join(copy, "f"), "NEW"); writeFileSync(join(copy, "made.txt"), "M");
    // Meanwhile somebody moves the directory away — and, in two of the cases, puts something else at its path.
    renameSync(real, join(base, "moved"));
    if (what === "another directory") { mkdirSync(real); writeFileSync(join(real, "f"), "THEIRS"); }
    if (what === "a file") writeFileSync(real, "THEIRS");
    const unmerged = mergeTree(copy, real, before, held);
    assert.deepEqual(unmerged.map((it) => it.path), ["."], what);
    assert.match(unmerged[0].why, what === "another directory" ? /another directory is at the project's path than the one that was copied; nothing was merged into it/ : /the project is no longer there; nothing was merged into it/);
    assert.deepEqual(describe(join(base, "moved")), { "f": 'file 644 "OLD"' }, what);
    if (what === "another directory") assert.deepEqual(describe(real), { "f": 'file 644 "THEIRS"' });
    if (what === "gone") assert.equal(existsSync(real), false);
  }
});

test("of one thing that did not arrive, a path is told of once: not again under a directory of the thing that is told of", (t) => {
  const real = scratch(t), copy = scratch(t);
  writeFileSync(join(real, "program.ts"), "AS IT RAN");
  const held = copyTree(real, copy);
  const before = readTree(copy);
  const asOneThing = oneThing(copy, ["program.ts", "sub/main.ts", "sub"]);
  mkdirSync(join(copy, "sub")); renameSync(join(copy, "program.ts"), join(copy, "sub", "main.ts")); symlinkSync("sub/main.ts", join(copy, "program.ts"));
  // Somebody wrote the program meanwhile: it is theirs, and none of the thing arrives.
  writeFileSync(join(real, "program.ts"), "THEIRS");
  const unmerged = mergeTree(copy, real, before, held, asOneThing());
  assert.deepEqual(unmerged.map((it) => it.path).sort(), ["program.ts", "sub"]);
  assert.deepEqual(describe(real), { "program.ts": 'file 644 "THEIRS"' });
});

const namesFoldHere = existsSync(import.meta.filename.toUpperCase()) && existsSync(import.meta.filename.toLowerCase());
test("what the run removed from a directory somebody spelled anew meanwhile is still there, to the project — and that is told", { skip: !namesFoldHere }, (t) => {
  const cases = {
    "removed": { run: (copy) => unlinkSync(join(copy, "d", "f")), now: { "D": "dir 755", "D/f": 'file 644 "F"', "D/keep": 'file 644 "K"' } },
    "moved out": {
      run: (copy) => renameSync(join(copy, "d", "f"), join(copy, "h")),
      now: { "D": "dir 755", "D/f": 'file 644 "F"', "D/keep": 'file 644 "K"', "h": 'file 644 "F"' },
    },
  };
  for (const [what, { run, now }] of Object.entries(cases)) {
    const real = scratch(t), copy = scratch(t);
    mkdirSync(join(real, "d")); chmodSync(join(real, "d"), 0o755); writeFileSync(join(real, "d", "f"), "F"); writeFileSync(join(real, "d", "keep"), "K");
    const held = copyTree(real, copy);
    const before = readTree(copy);
    run(copy);
    renameSync(join(real, "d"), join(real, "D")); // meanwhile: the same directory, in other letters
    const unmerged = mergeTree(copy, real, before, held);
    assert.deepEqual(unmerged.map((it) => it.path), ["d/f"], what);
    assert.match(unmerged[0].why, /the directory it is in is no longer there in the project, by that name/);
    assert.deepEqual(describe(real), now, what);
  }
  // (Where the directory is gone altogether, what the run removed from it is gone with it, and there is nothing to tell.)
  const real = scratch(t), copy = scratch(t);
  mkdirSync(join(real, "d")); writeFileSync(join(real, "d", "f"), "F");
  const held = copyTree(real, copy);
  const before = readTree(copy);
  unlinkSync(join(copy, "d", "f"));
  rmSync(join(real, "d"), { recursive: true });
  assert.deepEqual(mergeTree(copy, real, before, held), []);
});

// --- A copy on a file system that tells names apart by their letters, of a directory on one that does not ---

const foldsNames = namesFoldHere;
/**
 * A directory on such a file system — where the tests themselves run on one
 * that takes "Sub" and "sub" for one name. macOS can make one, as a disk
 * image. Null where none is to be had.
 */
let toldApart;
function whereNamesAreToldApart() {
  if (toldApart !== undefined) return toldApart;
  toldApart = null;
  if (process.platform !== "darwin" || !foldsNames) return null;
  const home = realpathSync(mkdtempSync(join(tmpdir(), "trama-apart-")));
  const image = join(home, "volume.dmg"), volume = join(home, "volume");
  try {
    execFileSync("hdiutil", ["create", "-size", "64m", "-fs", "Case-sensitive APFS", "-volname", "trama-test", "-quiet", image], { stdio: "ignore" });
    mkdirSync(volume);
    execFileSync("hdiutil", ["attach", image, "-mountpoint", volume, "-nobrowse", "-quiet"], { stdio: "ignore" });
    process.on("exit", () => {
      try { execFileSync("hdiutil", ["detach", volume, "-force", "-quiet"], { stdio: "ignore" }); } catch { /* it is left to the system */ }
      rmSync(home, { recursive: true, force: true });
    });
    toldApart = volume;
  } catch {
    rmSync(home, { recursive: true, force: true });
  }
  return toldApart;
}
const NONE_TO_BE_HAD = "no file system that tells names apart, beside one that does not, is to be had here";

test("what is in a directory the real one takes for another is in the same place: nothing is done there under either name", { skip: asRoot }, (t) => {
  const apart = whereNamesAreToldApart();
  if (!apart) return t.skip(NONE_TO_BE_HAD);
  const cases = {
    "removes Sub/a.txt, makes sub/a.txt": {
      setUp: (dir) => { mkdirSync(join(dir, "Sub")); writeFileSync(join(dir, "Sub", "a.txt"), "OLD"); writeFileSync(join(dir, "Sub", "kept.txt"), "KEPT"); },
      run: (dir) => { unlinkSync(join(dir, "Sub", "a.txt")); mkdirSync(join(dir, "sub")); writeFileSync(join(dir, "sub", "a.txt"), "NEW"); },
      told: ["Sub/a.txt", "sub"],
    },
    "writes into Sub/a.txt, makes Sub/new.txt and sub/b.txt": {
      setUp: (dir) => { mkdirSync(join(dir, "Sub")); writeFileSync(join(dir, "Sub", "a.txt"), "OLD"); },
      run: (dir) => { writeFileSync(join(dir, "Sub", "a.txt"), "CHANGED"); writeFileSync(join(dir, "Sub", "new.txt"), "N"); mkdirSync(join(dir, "sub")); writeFileSync(join(dir, "sub", "b.txt"), "B"); },
      told: ["Sub/a.txt", "Sub/new.txt", "sub"],
    },
    "the same a directory further down, and in a directory under the one that is taken for another": {
      setUp: (dir) => { mkdirSync(join(dir, "Top", "Sub", "deep"), { recursive: true }); writeFileSync(join(dir, "Top", "Sub", "deep", "a.txt"), "OLD"); },
      run: (dir) => { unlinkSync(join(dir, "Top", "Sub", "deep", "a.txt")); mkdirSync(join(dir, "Top", "sub", "deep"), { recursive: true }); writeFileSync(join(dir, "Top", "sub", "deep", "a.txt"), "NEW"); },
      told: ["Top/Sub/deep/a.txt", "Top/sub"],
    },
    "two files the run made, where nothing was, under names taken for one: neither is put there": {
      setUp: (dir) => { writeFileSync(join(dir, "kept.txt"), "KEPT"); },
      run: (dir) => { writeFileSync(join(dir, "Notes.txt"), "ONE"); writeFileSync(join(dir, "notes.txt"), "THE OTHER"); writeFileSync(join(dir, "third.txt"), "T"); },
      told: ["Notes.txt", "notes.txt"], arrives: { "third.txt": 'file 644 "T"' },
    },
    "two directories the run made under names taken for one: neither is made, nor anything in them": {
      setUp: (dir) => { writeFileSync(join(dir, "kept.txt"), "KEPT"); },
      run: (dir) => { mkdirSync(join(dir, "New")); writeFileSync(join(dir, "New", "x"), "X"); mkdirSync(join(dir, "new")); writeFileSync(join(dir, "new", "y"), "Y"); },
      told: ["New", "new"],
    },
    "a directory beside it is not in it: what is done there arrives": {
      setUp: (dir) => { mkdirSync(join(dir, "Sub")); mkdirSync(join(dir, "Other")); writeFileSync(join(dir, "Sub", "a.txt"), "OLD"); writeFileSync(join(dir, "Other", "o.txt"), "OLD"); },
      run: (dir) => { mkdirSync(join(dir, "sub")); writeFileSync(join(dir, "Other", "o.txt"), "NEW"); unlinkSync(join(dir, "Sub", "a.txt")); },
      told: ["Sub/a.txt", "sub"], arrives: { "Other/o.txt": 'file 644 "NEW"' },
    },
  };
  for (const [what, { setUp, run, told, arrives = {} }] of Object.entries(cases)) {
    const real = scratch(t), copy = mkdtempSync(join(apart, "copy-"));
    t.after(() => wipe(copy));
    setUp(real);
    const held = copyTree(real, copy);
    const before = readTree(copy);
    run(copy);
    const asItWas = describe(real);
    const unmerged = mergeTree(copy, real, before, held);
    assert.deepEqual(unmerged.map((it) => it.path).sort(), told, `${what}: ${JSON.stringify(unmerged)}`);
    assert.deepEqual(describe(real), { ...asItWas, ...arrives }, what);
  }
});

test("a directory somebody spelled anew meanwhile is not the tree's any more: what the run moved out of it is not removed from it", { skip: asRoot }, (t) => {
  const apart = whereNamesAreToldApart();
  if (!apart) return t.skip(NONE_TO_BE_HAD);
  const real = scratch(t), copy = mkdtempSync(join(apart, "copy-"));
  t.after(() => wipe(copy));
  mkdirSync(join(real, "b")); writeFileSync(join(real, "b", "A"), "PRECIOUS"); writeFileSync(join(real, "b", "other"), "o");
  const held = copyTree(real, copy);
  const before = readTree(copy);
  // The run makes "B" beside "b", and moves a file from the one into the other.
  mkdirSync(join(copy, "B")); renameSync(join(copy, "b", "A"), join(copy, "B", "A")); writeFileSync(join(copy, "b", "other"), "changed");
  // Meanwhile somebody spells the directory "B": to the project, where the run moved the file is where it was.
  renameSync(join(real, "b"), join(real, "B"));
  const unmerged = mergeTree(copy, real, before, held);
  assert.deepEqual(describe(real), { "B": "dir 755", "B/A": 'file 644 "PRECIOUS"', "B/other": 'file 644 "o"' });
  // (Both what it changed there and what it took from there are told of: to the project, each is still where it was.)
  assert.deepEqual(unmerged.map((it) => it.path).sort(), ["b/A", "b/other"]);
  for (const { why } of unmerged) assert.match(why, /the directory it is in is no longer there in the project, by that name/);
});

for (const seed of SEEDS) {
  test(`a copy that tells names apart, of a directory that does not: what is told not to have arrived is as it was by the directory's own reckoning of names, and the rest is as the run left it (seed ${seed})`, { skip: asRoot }, (t) => {
    const apart = whereNamesAreToldApart();
    if (!apart) return t.skip(NONE_TO_BE_HAD);
    const rng = random(seed ^ 0xa9a7);
    const folded = (path) => path.toLowerCase();
    for (let round = 0; round < 60; round++) {
      const { outside, real } = trial(t, rng);
      const copy = mkdtempSync(join(apart, "copy-"));
      try {
        const held = copyTree(real, copy);
        const before = readTree(copy);
        const asItWas = describe(real);
        const run = [];
        for (let n = 0; n < 12; n++) {
          const it = { ...step(rng, copy, ["near", "full", "through"], A_RUN), whateverTheFileSystem: true };
          if (rng.next() < 0.3) it.kind = "respell";
          carryOut(copy, outside, it);
          run.push(it);
        }
        const left = describe(copy, real);
        const unmerged = mergeTree(copy, real, before, held);
        const now = describe(real);
        const told = `round ${round}\n the run: ${JSON.stringify(run.map(({ kind, p, q }) => `${kind} ${p} ${q}`))}\n unmerged: ${JSON.stringify(unmerged)}`;
        const toldOf = (path) => unmerged.some((it) => atOrUnder(folded(path), folded(it.path)) || atOrUnder(folded(it.path), folded(path)));
        for (const { path } of unmerged) {
          for (const other of new Set([...Object.keys(now), ...Object.keys(asItWas)])) {
            if (!atOrUnder(folded(other), folded(path))) continue;
            if (now[other] !== asItWas[other]) assert.fail(`${path} did not arrive, yet ${other} was ${asItWas[other]} and is now ${now[other]}\n${told}`);
          }
        }
        for (const path of new Set([...Object.keys(left), ...Object.keys(asItWas), ...Object.keys(now)])) {
          if (now[path] !== left[path] && !toldOf(path)) assert.fail(`${path} is ${now[path]}, not ${left[path]} as the run left it, and nothing says why\n${told}`);
        }
      } finally {
        wipe(copy);
      }
    }
  });
}

test("copyTree onto a case-sensitive volume leaves external absolute symlinks unchanged and respells multi-hop internal link chains", { skip: asRoot }, (t) => {
  const apart = whereNamesAreToldApart();
  if (!apart) return t.skip(NONE_TO_BE_HAD);
  const real = scratch(t), copy = mkdtempSync(join(apart, "copy-"));
  t.after(() => wipe(copy));

  // Source has "ETC" so walking "/etc/hosts" relative to dirname(source) or source would collide if mis-rooted.
  mkdirSync(join(real, "ETC"));
  symlinkSync("/etc/hosts", join(real, "ext-hosts"));

  // Multi-hop symlink chain: hop1 -> hop2 -> RealDir, and a link whose path traverses hop1/file.txt in wrong case.
  mkdirSync(join(real, "RealDir"));
  writeFileSync(join(real, "RealDir", "TargetFile.txt"), "payload");
  symlinkSync("RealDir", join(real, "hop2"));
  symlinkSync("hop2", join(real, "hop1"));
  symlinkSync("hop1/targetfile.txt", join(real, "via-chain"));

  copyTree(real, copy);
  assert.equal(readlinkSync(join(copy, "ext-hosts")), "/etc/hosts");
  assert.equal(readlinkSync(join(copy, "via-chain")), "hop1/TargetFile.txt");
  assert.equal(readFileSync(join(copy, "via-chain"), "utf-8"), "payload");
});

// --- The names a directory lists, and the letters a link is written in ---

test("a place is known by the names its directories list for it; the directory itself is \".\", and what is not in it has no name there", (t) => {
  const dir = scratch(t);
  mkdirSync(join(dir, "Sub"));
  writeFileSync(join(dir, "Sub", "Report.txt"), "the report");
  symlinkSync("Sub", join(dir, "by-link"));

  assert.equal(tree.pathAsListed(dir, dir), ".");
  assert.equal(tree.pathAsListed(dir, join(dir, "Sub", "Report.txt")), "Sub/Report.txt");
  assert.equal(tree.pathAsListed(dir, join(dir, "by-link")), "by-link", "a link is named, not followed");
  symlinkSync("nowhere", join(dir, "to-nothing"));
  for (const elsewhere of [dirname(dir), join(dirname(dir), "beside"), join(dir, "Sub", "missing.txt"), join(dir, "missing", "Report.txt"), join(dir, "to-nothing", "Report.txt")]) {
    assert.equal(tree.pathAsListed(dir, elsewhere), undefined, elsewhere);
  }
  // What is outside has no name in it either where the directory itself is gone.
  assert.equal(tree.pathAsListed(join(dir, "gone"), dir), undefined);
  if (!foldsNames) return;
  // In other letters, where the file system takes them for the same: the listed ones are the answer.
  assert.equal(tree.pathAsListed(dir, join(dir, "sub", "REPORT.TXT")), "Sub/Report.txt");
  // And of a file's several names in one directory, the one that was meant — whichever the directory lists first.
  for (const other of ["a-second-name", "Z-third-name", "report.bak", "1"]) linkSync(join(dir, "Sub", "Report.txt"), join(dir, "Sub", other));
  assert.equal(tree.pathAsListed(dir, join(dir, "SUB", "report.txt")), "Sub/Report.txt");
  assert.equal(tree.pathAsListed(dir, join(dir, "sub", "REPORT.BAK")), "Sub/report.bak");
});

test("a copy beside the original keeps every link to the letter, in whatever letters it is written", { skip: !foldsNames }, (t) => {
  const real = scratch(t), copy = scratch(t), outside = scratch(t);
  mkdirSync(join(real, "Dir"));
  writeFileSync(join(real, "Dir", "Inner.txt"), "inner");
  writeFileSync(join(real, "Dir", "Left-Out.txt"), "no part of the copy");
  writeFileSync(join(outside, "Shared.txt"), "shared");
  const links = {
    "as-listed": "Dir/Inner.txt", "in-other-letters": "dir/INNER.txt", "to-nothing": "DIR/missing.txt",
    // Through a link that comes after it, to what is left out of the copy, and out of the directory by a link of it.
    "by-way-of-later": "ZLINK/inner.TXT", "to-what-is-left-out": "DIR/left-out.TXT", "out-by-a-link": "ZOUT/SHARED.txt",
    "zlink": "dir", "zout": outside,
  };
  for (const [name, text] of Object.entries(links)) symlinkSync(text, join(real, name));

  // (And a file of two names, of which the copy is given one: the other is not turned into it.)
  linkSync(join(real, "Dir", "Inner.txt"), join(real, "Dir", "Left-Out-too.txt"));
  symlinkSync("Dir/Left-Out-too.txt", join(real, "to-a-name-left-out"));
  links["to-a-name-left-out"] = "Dir/Left-Out-too.txt";
  tree.copyTree(real, copy, (at) => /Left-Out(-too)?\.txt$/.test(at));
  for (const [name, text] of Object.entries(links)) assert.equal(readlinkSync(join(copy, name)), text, name);
  assert.equal(readFileSync(join(copy, "by-way-of-later"), "utf-8"), "inner");
  assert.equal(readFileSync(join(copy, "out-by-a-link"), "utf-8"), "shared");
});

test("a copy on a file system that tells letters apart has each link lead where it led, by the names the copy has", { skip: asRoot }, (t) => {
  const apart = whereNamesAreToldApart();
  if (!apart) return t.skip(NONE_TO_BE_HAD);
  const real = scratch(t), copy = mkdtempSync(join(apart, "copy-")), outside = scratch(t);
  t.after(() => wipe(copy));
  mkdirSync(join(real, "Dir", "Deep"), { recursive: true });
  writeFileSync(join(real, "Dir", "Inner.txt"), "inner");
  writeFileSync(join(real, "Dir", "Left-Out.txt"), "no part of the copy");
  writeFileSync(join(outside, "Shared.txt"), "shared");
  symlinkSync("Dir/Deep", join(real, "zdeep"));
  symlinkSync(outside, join(real, "zout"));
  writeFileSync(join(real, "Dir", "Deep", "Far.txt"), "far");
  linkSync(join(real, "Dir", "Inner.txt"), join(real, "Dir", "a-second-name"));
  linkSync(join(real, "Dir", "Inner.txt"), join(real, "Dir", "Z-third-name"));
  // (And a name of the same file in another directory, which is no name of it in this one.)
  mkdirSync(join(real, "Other"));
  linkSync(join(real, "Dir", "Inner.txt"), join(real, "Other", "INNER.TXT"));
  symlinkSync("dir", join(real, "zlink"));
  const said = {
    "as-listed": ["Dir/Inner.txt", "Dir/Inner.txt"],
    "in-other-letters": ["dir/INNER.txt", "Dir/Inner.txt"],
    "up-and-down": ["DIR/deep/../inner.TXT", "Dir/Deep/../Inner.txt"],
    "by-way-of-later": ["ZLINK/DEEP/far.txt", "zlink/Deep/Far.txt"],
    // Said from the top of the file system, of the directory in other letters: what follows is said of the copy.
    "from-the-top": [join(real, "DIR", "DEEP", "FAR.TXT"), join(copy, "Dir", "Deep", "Far.txt")],
    // What is not there is written as it was, on from the names that are — and so is what the copy was not given.
    "to-nothing": ["dir/Missing.txt", "Dir/Missing.txt"],
    "to-what-is-left-out": ["DIR/left-out.TXT", "Dir/left-out.TXT"],
    // Up from where a link led is up from there: the name after it is one of Dir's, not of the directory the link is in.
    "up-from-a-link": ["ZDEEP/../INNER.txt", "zdeep/../Inner.txt"],
    // A file that has a name in another directory too is named, there, by the name it has there.
    "by-its-other-name": ["other/inner.txt", "Other/INNER.TXT"],
    // A name outside is no name of the copy's, though a link of the directory leads to it.
    "out-by-a-link": ["ZOUT/SHARED.txt", "zout/SHARED.txt"],
    // And what never comes to the directory is none of its names.
    "outside": ["/ETC/hosts", "/ETC/hosts"],
  };
  for (const [name, [text]] of Object.entries(said)) symlinkSync(text, join(real, name));
  mkdirSync(join(real, "nested"));
  symlinkSync("../DIR/deep/FAR.txt", join(real, "nested", "from-below"));

  tree.copyTree(real, copy, (at) => at.endsWith("Left-Out.txt"));
  for (const [name, [, expected]] of Object.entries(said)) assert.equal(readlinkSync(join(copy, name)), expected, name);
  assert.equal(readFileSync(join(copy, "up-from-a-link"), "utf-8"), "inner");
  assert.equal(readlinkSync(join(copy, "nested", "from-below")), "../Dir/Deep/Far.txt");
  for (const [name, content] of [["in-other-letters", "inner"], ["up-and-down", "inner"], ["by-way-of-later", "far"], ["from-the-top", "far"], ["nested/from-below", "far"]]) {
    assert.equal(readFileSync(join(copy, name), "utf-8"), content, name);
  }
});
