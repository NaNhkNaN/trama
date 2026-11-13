// What a directory holds — and the two things done with it: a copy is made
// somewhere else, and what a run did to the copy is carried back.
//
// Both rest on one reading of a tree. It says what is at every path under a
// directory — a file, a directory, a link, or something that is not content —
// or it throws. There is no entry it passes over: what a reading leaves out is
// taken, by whoever compares two readings, to have been removed.

import {
  accessSync, chmodSync, closeSync, constants, copyFileSync, lstatSync, mkdirSync, openSync,
  readdirSync, readSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync,
} from "fs";
import { basename, dirname, join, relative, sep } from "path";
import { identityOf, linksOf, linkText, realRootOf } from "./path-guard.js";
import { stagedNameFor } from "./replace-file.js";

/**
 * What is at one path. Of a file or a link, `id` says which one it is: it
 * stays the same through being written to, renamed, or given other
 * permissions, and no other file or link of the same directory tree has it.
 * (It is the system's number for the file with the time the file was made — a
 * file system may give the number again once a file is gone. One that keeps
 * no such time tells a file that was moved from a new one in its place less
 * well, or not at all.)
 */
export type Entry =
  /** `stamp` is different after any change to the file — to what it holds or to what it allows — and cannot be set by a program. */
  | { kind: "file"; mode: number; size: number; stamp: string; id: string }
  | { kind: "dir"; mode: number }
  | { kind: "link"; text: string; id: string }
  /** A pipe, a socket, a device, a link that says nothing a path can be made of: one end of something else, not content. */
  | { kind: "other" };

/** What a directory holds: every path under it ("/" between the names), a directory before what is in it. */
export type Tree = Map<string, Entry>;

const NOT_CONTENT: Entry = { kind: "other" };

/** What is at a path — the path itself, not what a link there leads to. Undefined if nothing is. */
export function entryAt(path: string): Entry | undefined {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!stat) return undefined;
  const mode = Number(stat.mode & 0o7777n);
  const id = `${stat.ino}:${stat.birthtimeNs}`;
  if (stat.isFile()) {
    // The time of the last change is the system's own: it moves when the file is written, replaced, or
    // has its permissions changed, and no program can put it back. (The time of the last write can be.)
    return { kind: "file", mode, size: Number(stat.size), stamp: `${stat.ino}:${stat.ctimeNs}:${stat.size}`, id };
  }
  if (stat.isDirectory()) return { kind: "dir", mode };
  if (stat.isSymbolicLink()) {
    let text;
    try {
      text = linkText(path);
    } catch (err) {
      // No link is there any more: the place changed between the two questions, and is asked again.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EINVAL") return entryAt(path);
      throw err;
    }
    return text === undefined ? NOT_CONTENT : { kind: "link", text, id };
  }
  return NOT_CONTENT;
}

/** Which file or link an entry is — undefined of what is neither. */
const idOf = (entry: Entry | undefined) => (entry?.kind === "file" || entry?.kind === "link" ? entry.id : undefined);

/**
 * Whether two entries are the same thing, unchanged. Nothing is the same as
 * nothing. A directory is the same if it allows the same — what it holds is
 * other paths. What is not content is never taken for the same: nothing is
 * known of it that could be compared.
 */
function same(a: Entry | undefined, b: Entry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind === "file" && b.kind === "file") return a.stamp === b.stamp;
  if (a.kind === "dir" && b.kind === "dir") return a.mode === b.mode;
  if (a.kind === "link" && b.kind === "link") return a.text === b.text;
  return false;
}

/** The names in a directory. One that is not text cannot be told from another, or looked up again: it throws. */
function namesIn(dir: string): string[] {
  return readdirSync(dir, "buffer").map((raw) => {
    const name = raw.toString("utf-8");
    if (!Buffer.from(name, "utf-8").equals(raw)) throw new Error(`${dir} holds a name that is not readable as text`);
    return name;
  });
}

const gone = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";

/**
 * Go through everything under a directory, a directory before what it holds.
 * `visit` is given each path, what is there, and where that is; if it returns
 * false the entry is left out, and not gone into.
 *
 * Whatever goes wrong, the walk throws — with one exception, which is not
 * something going wrong: a directory may be in use while it is read, and what
 * has gone by the time it is come to is not there. (A directory that goes
 * after it was looked at is one with nothing in it.)
 */
function walk(root: string, visit: (path: string, entry: Entry, at: string) => boolean | void): void {
  const into = (dir: string, prefix: string, names: string[]) => {
    for (const name of names) {
      const at = join(dir, name);
      const entry = entryAt(at);
      if (!entry) continue;
      const path = prefix + name;
      if (visit(path, entry, at) === false || entry.kind !== "dir") continue;
      let inside;
      try {
        inside = namesIn(at);
      } catch (err) {
        if (gone(err)) continue;
        throw err;
      }
      into(at, `${path}/`, inside);
    }
  };
  into(root, "", namesIn(root));
}

/** Whether two files hold the same bytes. Read a piece at a time: a file may be larger than can be held at once. */
function sameBytes(one: string, other: string): boolean {
  const fill = (fd: number, into: Buffer): number => {
    let have = 0;
    for (let got; have < into.length && (got = readSync(fd, into, have, into.length - have, null)) > 0;) have += got;
    return have;
  };
  const a = openSync(one, "r");
  try {
    const b = openSync(other, "r");
    try {
      const mine = Buffer.allocUnsafe(1 << 16);
      const theirs = Buffer.allocUnsafe(1 << 16);
      for (;;) {
        const have = fill(a, mine);
        if (fill(b, theirs) !== have || mine.compare(theirs, 0, have, 0, have) !== 0) return false;
        if (have < mine.length) return true;
      }
    } finally {
      closeSync(b);
    }
  } finally {
    closeSync(a);
  }
}

/** What a directory holds. The directory must be there, and all of it readable. */
export function readTree(dir: string): Tree {
  const tree: Tree = new Map();
  walk(dir, (path, entry) => { tree.set(path, entry); });
  return tree;
}

/**
 * Make `toDir` — an empty directory — hold what `fromDir` holds, and return
 * what that was: each entry as it was when it was copied. `leaveOut` names
 * what is no part of it; those entries are neither copied nor returned.
 *
 * What a directory holds is its files, its directories with what they allow,
 * and its links. What is not content is not carried over, though the tree
 * returned says it is there.
 *
 * A link is made to name, in the copy, what it names here: the same place in
 * the copy if that is under `fromDir`, and the same place outside it if not.
 * Most links do that as they are written, and are kept so. Not one whose
 * way steps out of the directory over its top with "..", or into it from
 * outside: from the copy's place those words lead somewhere else — or back
 * into the original, where what was done through the link in the copy would
 * be done to the original. Such a link is rewritten. If its way comes to the
 * directory from outside and stays in it, what it says from there on is said
 * of the directory, and is kept, said of the copy: only the part that comes
 * to the directory is replaced, and a link of the directory on the rest of
 * the way is still passed through in the copy, wherever it then leads. If
 * not — the way ends outside — the link is made to name the place itself.
 * A link whose way cannot be followed here names nothing that can be told,
 * and is not carried over. Whether it can be is asked of this reading, and of
 * the system: a link the system will not follow — too many links on its way,
 * a name too long — is not carried either, whatever it says, since a copy of
 * it could come to be followed where a link on its way is rewritten shorter.
 * Nor is one whose rewritten words the system will not have for a link.
 *
 * The tree returned is read in the same pass that copies, each entry before
 * it is copied. So the copy never holds what the tree does not know of; and
 * an entry that changes while it is copied is in the tree as it was before,
 * which is the side to err on — it will not be taken for untouched later.
 */
export function copyTree(
  fromDir: string,
  toDir: string,
  leaveOut: (at: string, entry: Entry) => boolean = () => false,
): Tree {
  const from = realRootOf(fromDir);
  const to = realRootOf(toDir);
  const tree: Tree = new Map();
  const dirs: Array<{ copied: string; mode: number }> = [];

  const read = linksOf(from);
  /** What a link must say in the copy — undefined if what it names cannot be told. */
  const inCopy = (link: string, text: string): string | undefined => {
    try {
      try {
        statSync(link);
      } catch (err) {
        if (!gone(err)) throw err; // (that nothing is there yet is no refusal to go there)
      }
      const lead = read.names(dirname(link), text);
      // A way that strays and does not come home ends outside the directory: the place is itself, from anywhere.
      return !lead.strays ? text : lead.home !== undefined ? to + lead.home : lead.to;
    } catch {
      return undefined;
    }
  };

  walk(from, (path, entry, source) => {
    if (leaveOut(source, entry)) return false;
    const copied = join(to, path);
    tree.set(path, entry);
    if (entry.kind === "dir") {
      mkdirSync(copied);
      dirs.push({ copied, mode: entry.mode });
    } else if (entry.kind === "file") {
      try {
        // The copy is empty where this goes: a name that is there already is two names of the directory taken for one.
        copyFileSync(source, copied, constants.COPYFILE_EXCL);
      } catch (err) {
        if (!gone(err) || lstatSync(source, { throwIfNoEntry: false })) throw err;
        tree.delete(path); // gone since it was looked at
      }
    } else if (entry.kind === "link") {
      const text = inCopy(source, entry.text);
      try {
        if (text === undefined) tree.set(path, NOT_CONTENT);
        else symlinkSync(text, copied);
      } catch (err) {
        // Words made for the copy that are too long for a link: they cannot be said here at all.
        if (text === entry.text || (err as NodeJS.ErrnoException).code !== "ENAMETOOLONG") throw err;
        tree.set(path, NOT_CONTENT);
      }
    }
  });
  // Last, and the deepest first: a directory that may not be written to has to be filled before it is closed.
  for (const { copied, mode } of dirs.reverse()) chmodSync(copied, mode);
  return tree;
}

/**
 * The path a reading of `dir` has for a place under it: each step by the
 * name its directory lists for it, which need not be the letters the place
 * is known by (a file system may take "Program.ts" and "program.ts" for one
 * name). Undefined if nothing is there. The place is named without links.
 *
 * The name is found by what is there, so this is to be asked where no file
 * has two names in one directory: of a copy, which has every file once.
 */
export function pathAsListed(dir: string, place: string): string | undefined {
  const steps: string[] = [];
  let at = realRootOf(dir);
  for (const step of relative(at, place).split(sep)) {
    const what = identityOf(join(at, step));
    if (what === undefined) return undefined;
    const names = namesIn(at);
    const name = names.includes(step) ? step : names.find((other) => identityOf(join(at, other)) === what);
    if (name === undefined) return undefined;
    steps.push(name);
    at = join(at, name);
  }
  return steps.join("/");
}

/** Something a run did in a copy that did not reach the real directory, and why. */
export interface Unmerged { path: string; why: string }

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Carry what a run did to a copy back into the directory it is a copy of.
 *
 * @param stagedDir - the copy, as the run left it
 * @param realDir - the directory it was copied from
 * @param before - the copy as it was before the run (readTree)
 * @param seed - the real directory as it was when the copy was made (copyTree)
 *
 * What the run did is where the copy differs from what it was: a file, a
 * directory or a link made, removed, changed, or put where something of
 * another kind was; permissions changed. Each difference is carried over on
 * one condition: the place in the real directory is still as it was when the
 * copy was made — and so is the directory it is in. If not, somebody else —
 * the user, another run of the same project — has been there since, and
 * theirs is kept. A place that already holds what the run left needs nothing
 * done, whoever made it so.
 *
 * There is no path this leaves out. Where the caller has itself put
 * something into the real directory since the copy was made, it says so in
 * `seed`: the place is then as the seed has it, and what the run did there is
 * carried over like anything else.
 *
 * All of that is found out before anything is done. What cannot arrive is
 * then left alone, with everything under it; and a directory the run removed,
 * or put something else in the place of, goes only if all that is in it goes
 * — if anything in it stays, or it holds something the run never saw, the
 * directory stays whole. A file or a link the run moved goes from where it
 * was only if it arrives where the run moved it: what it holds is not to be
 * in neither place. (What was moved is known by its `id`, see Entry. What
 * the run copied and then removed is a new file, and is not known to be the
 * old one's.) So what is returned as not arrived is as it was, at that path
 * and under it. (Unless the system itself fails part-way through
 * what had been found possible: then the reason given is the system's.)
 *
 * Finding out is looking, and a directory that is closed cannot be looked
 * into. One of the real directory's is opened for it, as it is for what is
 * then done in it, and one of the copy's is opened to be read: both are this
 * merge's to open. Each of the real directory's is left, at the end, allowing
 * what the run left it allowing — or, if that did not arrive, what it allowed.
 *
 * A path is a name, and the real directory has the last word on its names:
 * its file system may take "Notes.txt" and "notes.txt" for one. A path of
 * the tree whose place holds something, though the directory does not list
 * the name as the tree spells it, is such a second spelling — the run
 * spelled a name anew, or made one beside another on a file system that
 * tells them apart. To a tree that is one entry removed and another made; in
 * the real directory the two are one place, and removing the one would
 * remove the other. Neither is touched: nothing is done to what is there
 * under any name the run changed, and each is told of as not arrived. (What
 * is there is known by what it is. All the names of a file that has several
 * are therefore left, where one would have done.)
 *
 * What is to be done is done in this order. A file or a link that takes the
 * place of something — unless that is a file it can be written into — is
 * made beside the place, and what could not be made there is, with what
 * follows from that, left alone like the rest; what the run removed is
 * removed, the deepest first; what it made is made, a directory before what
 * goes in it, and what was made beside its place is moved in in one step. It is where the run ended that is carried over, not the steps by
 * which it got there.
 *
 * A file that already holds what the run left has only what it allows
 * changed, and stays the file it is; any other is written into if it may be,
 * and otherwise has a new one put in its place. A link is written as the run wrote it
 * — the run took its copy for the directory itself — unless its way comes to
 * the copy from outside: by the copy's full path, or out of the copy and
 * back in by its name. What such a link says from there on is said of the
 * real directory, wherever that leads from there. So a link the copy
 * was given in other words than the directory's own (see copyTree), if the
 * run moved it, is merged in those words: it names what the run found it to
 * name, which is not always what the directory's own words would name from
 * the new place. And a link the run made that climbs out of its directory
 * with ".." and does not come back says the same in the real directory, and
 * names from there what it names from there.
 *
 * Nothing is thrown. What could not be carried over is returned, each path
 * with the reason, so that a run whose work did not all arrive is not passed
 * off as one whose work did. What lies under a path that did not arrive is
 * not listed again.
 */
export function mergeTree(stagedDir: string, realDir: string, before: Tree, seed: Tree): Unmerged[] {
  let copy: string;
  let real: string;
  const after: Tree = new Map();
  try {
    real = realRootOf(realDir);
  } catch (err) {
    return [{ path: ".", why: `the project could not be come to (${reason(err)}); nothing was merged into it` }];
  }
  try {
    copy = realRootOf(stagedDir);
    walk(copy, (path, entry, at) => {
      after.set(path, entry); // as the run left it
      if (entry.kind === "dir" && (entry.mode & 0o500) !== 0o500) chmodSync(at, entry.mode | 0o500);
    });
  } catch (err) {
    // What the run left cannot be told. Nothing is merged — least of all as a removal of what cannot be seen.
    return [{ path: ".", why: `what the run left could not be read (${reason(err)}); none of it was merged` }];
  }
  // Sorted, a path comes before every path under it.
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => !same(before.get(path), after.get(path)))
    .sort();
  const isChanged = new Set(changed);

  /** What did not arrive, and why: found out beforehand, or — once things are being done — told by the system. */
  const refused = new Map<string, string>();
  /** Whether a path is one of those, or under one. */
  const leftAlone = (path: string): boolean => {
    for (let end = path.length; end !== -1; end = path.lastIndexOf("/", end - 1)) {
      if (refused.has(path.slice(0, end))) return true;
    }
    return false;
  };

  const said = linksOf(copy);
  /** What a link the run left at a path says in the real directory. */
  const inReal = (path: string, text: string): string => {
    const rest = said.sinceRoot(join(copy, dirname(path)), text);
    return rest === undefined ? text : real + rest;
  };

  /** The file the run left at a path. One it left unreadable is read all the same. */
  const stagedFile = (path: string): string => {
    const staged = join(copy, path);
    const left = after.get(path);
    if (left?.kind === "file" && (left.mode & 0o400) === 0) chmodSync(staged, left.mode | 0o400);
    return staged;
  };

  /** What the run left at a path, as it is to be in the real directory — refused if it is nothing that can be put there. */
  const wanted = (path: string, is: Entry): Entry => {
    if (is.kind === "other") {
      throw new Error("the run left there what is not content — a pipe, a socket, a device, a link whose words are not text — and it is not carried into the project");
    }
    return is.kind === "link" ? { ...is, text: inReal(path, is.text) } : is;
  };

  /** Whether a file of the real directory holds what the file the run left at a path holds. One that may not be read is not known to. */
  const holdsBytes = (there: Entry, place: string, want: Entry & { kind: "file" }, path: string): boolean => {
    if (there.kind !== "file" || there.size !== want.size) return false;
    try {
      return sameBytes(stagedFile(path), place);
    } catch {
      return false;
    }
  };
  /** Whether a place already holds what is wanted at a path. */
  const holds = (there: Entry | undefined, place: string, want: Entry, path: string): boolean => {
    if (want.kind === "file") return there?.kind === "file" && there.mode === want.mode && holdsBytes(there, place, want, path);
    if (want.kind === "dir") return there?.kind === "dir" && there.mode === want.mode;
    return want.kind === "link" && there?.kind === "link" && there.text === want.text;
  };

  /**
   * Directories of the real one opened to be looked into or changed, and
   * what each is to be left allowing: what it allowed, until what the run
   * left it allowing arrives.
   */
  const opened = new Set<string>();
  const toClose = new Map<string, { place: string; mode: number }>();
  const open = (dir: string): void => {
    if (dir === "." || opened.has(dir)) return;
    const place = join(real, dir);
    const there = entryAt(place);
    if (there?.kind === "dir") {
      toClose.set(dir, { place, mode: there.mode });
      if ((there.mode | 0o700) !== there.mode) chmodSync(place, there.mode | 0o700);
    } // (if it is no directory, what is done in it will say so)
    opened.add(dir); // only now: if it could not be opened, the next to need it open is told so too
  };

  // --- What is to be done, found out before anything is ---

  /** One thing to do: at a place holding `there`, to have `want` (nothing, for what the run removed). */
  interface Deed { path: string; place: string; want: Entry | undefined; there: Entry | undefined }

  /** Directories the run made that are to be made here: they are not in the real directory yet. */
  const toMake = new Set<string>();
  /**
   * Whether the way to a directory of the tree is the real directory's own:
   * every step of it a directory, none a link put there since. (Asked as far
   * as the way exists: a directory still to be made is made by this merge.)
   */
  const own = new Map<string, boolean>();
  const ownWay = (dir: string): boolean => {
    if (dir === ".") return true;
    if (toMake.has(dir)) return ownWay(dirname(dir));
    let known = own.get(dir);
    if (known === undefined) {
      known = ownWay(dirname(dir)) && entryAt(join(real, dir))?.kind === "dir";
      own.set(dir, known);
    }
    return known;
  };
  /** Whether a directory the run did not change is as it was when the copy was made. Asked once, before it is opened. */
  const asItWas = new Map<string, boolean>();
  const unchanged = (dir: string): boolean => {
    let known = asItWas.get(dir);
    if (known === undefined) asItWas.set(dir, known = same(entryAt(join(real, dir)), seed.get(dir)));
    return known;
  };
  /** Whether a directory lists a name as it is spelled. */
  const listed = new Map<string, string[]>();
  const spells = (dir: string, name: string): boolean => {
    let names = listed.get(dir);
    if (!names) listed.set(dir, names = namesIn(join(real, dir)));
    return names.includes(name);
  };
  /** What is in the real directory under a name that is not the directory's own for it: by what it is, the tree's path. */
  const otherwise = new Map<string, string>();

  /**
   * What is to be done at a path — nothing, if the place is as the run left
   * it already. Throws if it cannot be done: with why, which is all that is
   * done about it. It looks, and opens a directory to look; no more.
   */
  const decide = (path: string): Deed | undefined => {
    const was = before.get(path);
    const is = after.get(path);
    const place = join(real, path);
    const dir = dirname(path);
    let there: Entry | undefined;
    /** That somebody changed the directory it is in — which is said only once it is known that something needs doing there. */
    let notInIt: Error | undefined;
    // In a directory still to be made there is nothing — whatever is, for now, at the place of that directory.
    if (!toMake.has(dir)) {
      if (!ownWay(dir)) {
        // No way that is the directory's own leads there any more. What the run removed is, then, not there.
        if (!is) return undefined;
        throw new Error("the directory it is in is no longer there in the project");
      }
      // The directory it is in. One the run changed has its own turn, before this; any other must be as it was.
      if (dir !== "." && !isChanged.has(dir) && !unchanged(dir)) notInIt = new Error(`what ${dir} allows was changed in the project meanwhile`);
      let byItsName: boolean;
      try {
        // It is looked into as it will be changed: opened, if it is closed — unless that it is closed is somebody else's doing.
        if (!notInIt) open(dir);
        there = entryAt(place);
        byItsName = !there || spells(dir, basename(path));
      } catch (err) {
        throw notInIt ?? err;
      }
      if (!byItsName) {
        const what = identityOf(place);
        if (what) otherwise.set(what, path);
        throw new Error("the project's file system takes that name for one that is there already, spelled otherwise: what is there is left as it was");
      }
    }
    if (!is && !there) return undefined;
    const want = is && wanted(path, is);
    // A place that holds what the run left needs nothing done — whoever made it so, and whatever became of its directory.
    if (want && holds(there, place, want, path)) return undefined;
    if (notInIt) throw notInIt;

    if (!was && there) throw new Error("something else is at that place in the project");
    if (was && !same(there, seed.get(path))) {
      throw new Error(want ? "it was changed or removed in the project meanwhile" : "the run removed it, but it was changed in the project meanwhile");
    }
    if (there?.kind === "dir" && want?.kind !== "dir") {
      // It is to go — and can, if it holds nothing but what this merge removes from it.
      const goes = (child: string) => before.has(child) && !after.has(child);
      const kept = namesIn(place).find((name) => !goes(`${path}/${name}`));
      if (kept !== undefined) throw new Error(`the run removed it, but it holds something in the project that is not removed with it (${kept})`);
    }
    if (want?.kind === "dir" && there?.kind !== "dir") toMake.add(path);
    return { path, place, want, there };
  };

  const deeds: Deed[] = [];
  for (const path of changed) {
    if (leftAlone(path)) continue;
    try {
      const deed = decide(path);
      if (deed) deeds.push(deed);
    } catch (err) {
      refused.set(path, reason(err));
    }
  }
  // What the real directory takes for one name is one thing there: nothing is done to it under any name.
  if (otherwise.size > 0) {
    for (const { path, place, there } of deeds) {
      if (!there || leftAlone(path)) continue;
      try {
        const other = otherwise.get(identityOf(place) ?? "");
        if (other !== undefined) {
          refused.set(path, `the run left ${other}, which the project's file system takes for a name of this, or of what is one file with it: it is left as it was`);
        }
      } catch (err) {
        refused.set(path, reason(err));
      }
    }
  }
  /**
   * What follows from what did not arrive, for what was to go — until nothing
   * more follows. A file or a link the run moved goes from where it was only
   * if it arrives where it went: what it holds is not to be in neither place.
   * And a directory goes only if all that is in it goes. (The deepest first,
   * so that what stays keeps everything above it.) Each can bring the other
   * about: what stays in a directory keeps the directory, and a directory
   * that stays is in the way of what was moved to its place.
   */
  /** Where each file and link is, as the run left things. */
  const nowAt = new Map<string, string[]>();
  for (const [path, is] of after) {
    const id = idOf(is);
    if (id !== undefined) nowAt.set(id, [...(nowAt.get(id) ?? []), path]);
  }
  const settle = () => {
    for (let found = true; found;) {
      found = false;
      for (const { path, want, there } of [...deeds].reverse()) {
        if (leftAlone(path)) continue;
        // Where the run has what was here. (If that is here still, among other places, it has not been moved from here.)
        const id = idOf(before.get(path));
        const to = id !== undefined ? nowAt.get(id) : undefined;
        const stays = there?.kind === "dir" && want?.kind !== "dir" ? [...refused.keys()].find((other) => other.startsWith(`${path}/`)) : undefined;
        if (to?.every(leftAlone)) refused.set(path, `the run moved what was here to ${to.join(", ")}, which did not arrive: it is left as it was`);
        else if (stays !== undefined) refused.set(path, `the run removed it, but not all that is in it can go (${stays})`);
        else continue;
        found = true;
      }
    }
  };
  settle();

  // --- Doing it ---

  /** Remove what was made beside a place and is not going to be moved in. Says so if it cannot be. */
  const discard = (made: string): string => {
    try {
      rmSync(made, { force: true });
      return "";
    } catch {
      return ` — and ${basename(made)}, made ready beside it, could not be removed`;
    }
  };
  /**
   * Make a file or a link the run left beside its place, under a name of its
   * own, ready to be moved in. What is put in place this way takes the place
   * in one move: the place holds what it held, or what the run left, and at
   * no moment neither.
   */
  const beside = (path: string, want: Entry, place: string): string => {
    const made = stagedNameFor(place);
    if (want.kind === "link") {
      symlinkSync(want.text, made);
    } else if (want.kind === "file") {
      copyFileSync(stagedFile(path), made, constants.COPYFILE_EXCL);
      if (modeAt(made) !== want.mode) chmodSync(made, want.mode);
    }
    return made;
  };
  const moveIn = (made: string, place: string) => {
    try {
      renameSync(made, place);
    } catch (err) {
      throw new Error(reason(err) + discard(made));
    }
  };
  /** What has been made beside its place and is yet to be moved in. */
  const ready = new Map<string, string>();

  const each = (list: Deed[], step: (deed: Deed) => void) => {
    for (const deed of list) {
      if (leftAlone(deed.path)) continue;
      try {
        step(deed);
      } catch (err) {
        refused.set(deed.path, reason(err));
      }
    }
  };

  // What is put where something is, is put there in one move, and is made first, beside the place: if the system
  // will not have it made, nothing has been removed for its sake — not what is there, nor what was moved from
  // somewhere else to be there. (All but a file that takes what the run left into itself: one that may be
  // written to, or that holds it already.)
  each(deeds, ({ path, place, want, there }) => {
    if (!there || !want || want.kind === "dir") return;
    if (want.kind === "file" && there.kind === "file" && (mayBeWrittenTo(place) || holdsBytes(there, place, want, path))) return;
    open(dirname(path));
    ready.set(path, beside(path, want, place));
  });
  settle();

  // What the run removed — and what is in the way of what it made.
  each([...deeds].reverse(), ({ path, place, want, there }) => {
    if (!there || there.kind === want?.kind) return;
    open(dirname(path));
    if (there.kind === "dir") {
      rmdirSync(place);
      toClose.delete(path);
    } else if (!ready.has(path)) {
      unlinkSync(place); // (a file or a link that something is ready to take the place of stays until that is moved in)
    }
  });

  // What the run made, or changed.
  each(deeds, ({ path, place, want, there }) => {
    if (!want) return;
    if (want.kind === "dir" && there?.kind === "dir") {
      // What it allows is what changed: it is opened like any other, and closed to that.
      open(path);
      const closing = toClose.get(path);
      if (!closing) throw new Error("it is no longer a directory in the project");
      closing.mode = want.mode;
      return;
    }
    open(dirname(path));
    const made = ready.get(path);
    if (want.kind === "dir") {
      mkdirSync(place);
      chmodSync(place, want.mode | 0o700);
      opened.add(path);
      toClose.set(path, { place, mode: want.mode });
    } else if (made) {
      ready.delete(path);
      moveIn(made, place);
    } else if (want.kind === "link") {
      symlinkSync(want.text, place);
    } else if (want.kind === "file") {
      // Nothing is there — or a file that takes this into itself, and stays the file it is.
      if (!there) copyFileSync(stagedFile(path), place, constants.COPYFILE_EXCL);
      else if (!holdsBytes(there, place, want, path)) copyFileSync(stagedFile(path), place);
      if (modeAt(place) !== want.mode) chmodSync(place, want.mode);
    }
  });

  // What was made ready and never moved in — the system refused something on the way — is not left lying there.
  for (const [path, made] of ready) {
    const left = discard(made);
    if (left) refused.set(path, (refused.get(path) ?? "") + left);
  }
  // The directories that were opened, or made open, are closed — the deepest first.
  for (const [path, { place, mode }] of [...toClose].sort(([a], [b]) => (a < b ? 1 : -1))) {
    try {
      if (modeAt(place) !== mode) chmodSync(place, mode);
    } catch (err) {
      if (!leftAlone(path)) refused.set(path, reason(err));
    }
  }
  return [...refused].map(([path, why]) => ({ path, why }));
}

const mayBeWrittenTo = (path: string) => {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

const modeAt = (path: string) => lstatSync(path).mode & 0o7777;
