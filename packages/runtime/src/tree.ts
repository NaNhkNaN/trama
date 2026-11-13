// What a directory holds — and the two things done with it: a copy is made
// somewhere else, and what a run did to the copy is carried back.
//
// Both rest on one reading of a tree. It says what is at every path under a
// directory — a file, a directory, a link, or something that is not content —
// or it throws. There is no entry it passes over: what a reading leaves out is
// taken, by whoever compares two readings, to have been removed.

import {
  accessSync, chmodSync, closeSync, constants, copyFileSync, lstatSync, mkdirSync, openSync,
  readdirSync, readSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync,
} from "fs";
import { basename, dirname, isAbsolute, join, relative } from "path";
import { linksOf, linkText, realRootOf, type Lead } from "./path-guard.js";
import { stagedNameFor } from "./replace-file.js";

/** What is at one path. */
export type Entry =
  /** `stamp` is different after any change to the file — to what it holds or to what it allows — and cannot be set by a program. */
  | { kind: "file"; mode: number; size: number; stamp: string }
  | { kind: "dir"; mode: number }
  | { kind: "link"; text: string }
  /** A pipe, a socket, a device, a link that says nothing a path can be made of: one end of something else, not content. */
  | { kind: "other" };

/** What a directory holds: every path under it ("/" between the names), a directory before what is in it. */
export type Tree = Map<string, Entry>;

const NOT_CONTENT: Entry = { kind: "other" };

/** What is at a path — the path itself, not what a link there leads to. Undefined if nothing is. */
function entryAt(path: string): Entry | undefined {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!stat) return undefined;
  const mode = Number(stat.mode & 0o7777n);
  if (stat.isFile()) {
    // The time of the last change is the system's own: it moves when the file is written, replaced, or
    // has its permissions changed, and no program can put it back. (The time of the last write can be.)
    return { kind: "file", mode, size: Number(stat.size), stamp: `${stat.ino}:${stat.ctimeNs}:${stat.size}` };
  }
  if (stat.isDirectory()) return { kind: "dir", mode };
  if (stat.isSymbolicLink()) {
    const text = linkText(path);
    return text === undefined ? NOT_CONTENT : { kind: "link", text };
  }
  return NOT_CONTENT;
}

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
 * be done to the original. Such a link is rewritten to name the place itself.
 * A link that names its target from the top of the file system, by way of
 * the directory, says the same by way of the copy: only the part of it that
 * comes to the directory is replaced. A link whose way cannot be followed
 * here names nothing that can be told, and is not carried over.
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
  /** The place itself: in the copy, if it is in the directory. */
  const there = (lead: Lead) => (lead.inRoot !== undefined ? join(to, relative(from, lead.inRoot)) : lead.to);
  /** What a link that is in `dir` must say in the copy — undefined if what it names cannot be told. */
  const inCopy = (text: string, dir: string): string | undefined => {
    try {
      // By full path, by way of the directory: what is said of the directory is said of the copy.
      const rest = isAbsolute(text) ? read.beyond(text) : undefined;
      const lead = rest === undefined ? read.names(dir, text) : read.names(from, rest.replace(/^\/+/, ""));
      return lead.strays ? there(lead) : rest === undefined ? text : to + rest;
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
      const text = inCopy(entry.text, dirname(source));
      if (text === undefined) tree.set(path, NOT_CONTENT);
      else symlinkSync(text, copied);
    }
  });
  // Last, and the deepest first: a directory that may not be written to has to be filled before it is closed.
  for (const { copied, mode } of dirs.reverse()) chmodSync(copied, mode);
  return tree;
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
 * @param except - a path that is no part of this: somebody else puts it in place
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
 * All of that is found out before anything is done. What cannot arrive is
 * then left alone, with everything under it; and a directory the run removed,
 * or put something else in the place of, goes only if all that is in it goes
 * — if anything in it stays, or it holds something the run never saw, the
 * directory stays whole. So what is returned as not arrived is as it was, at
 * that path and under it. (Unless the system itself fails part-way through
 * what had been found possible: then the reason given is the system's.)
 *
 * What is to be done is done in this order. A file or a link that takes the
 * place of something of another kind is made beside the place; what the run
 * removed is removed, the deepest first; what it made is made, a directory
 * before what goes in it, and what was made beside its place is moved in in
 * one step. A directory that does not allow its contents to be changed is
 * opened for as long as that takes, and left allowing what the run left it
 * allowing: it is where the run ended that is carried over, not the steps by
 * which it got there.
 *
 * A file is written into if it may be, and otherwise replaced by a new one.
 * A link is written as the run wrote it — the run took its copy for the
 * directory itself — except that in one that names its target from the top
 * of the file system by way of the copy, the part that comes to the copy is
 * replaced by the real directory. So a link the copy was given in other
 * words than the directory's own (see copyTree), if the run moved it, is
 * merged in those words: it names what the run found it to name, which is
 * not always what the directory's own words would name from the new place.
 * And a link the run made that climbs out of its directory with ".." says
 * the same in the real directory, and names from there what it names from
 * there.
 *
 * Nothing is thrown. What could not be carried over is returned, each path
 * with the reason, so that a run whose work did not all arrive is not passed
 * off as one whose work did. What lies under a path that did not arrive is
 * not listed again.
 */
export function mergeTree(stagedDir: string, realDir: string, before: Tree, seed: Tree, except?: string): Unmerged[] {
  let after: Tree;
  try {
    after = readTree(stagedDir);
  } catch (err) {
    // What the run left cannot be told. Nothing is merged — least of all as a removal of what cannot be seen.
    return [{ path: ".", why: `what the run left could not be read (${reason(err)}); none of it was merged` }];
  }
  const copy = realRootOf(stagedDir);
  const real = realRootOf(realDir);
  // Sorted, a path comes before every path under it.
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => path !== except && !same(before.get(path), after.get(path)))
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
  /** What a link the run wrote says in the real directory. */
  const inReal = (text: string): string => {
    const rest = isAbsolute(text) ? said.beyond(text) : undefined;
    return rest === undefined ? text : real + rest;
  };

  /** What the run left at a path, as it is to be in the real directory — refused if it is nothing that can be put there. */
  const wanted = (is: Entry): Entry => {
    if (is.kind === "other") throw new Error("the run left a pipe, a socket or a device there, which is not carried into the project");
    return is.kind === "link" ? { kind: "link", text: inReal(is.text) } : is;
  };

  /** The file the run left at a path. The copy is this merge's to open: one the run left unreadable is read all the same. */
  const stagedFile = (path: string, want: Entry & { kind: "file" }): string => {
    const staged = join(copy, path);
    if ((want.mode & 0o400) === 0) chmodSync(staged, want.mode | 0o400);
    return staged;
  };

  /** Whether a place already holds what is wanted at a path. */
  const holds = (there: Entry | undefined, place: string, want: Entry, path: string): boolean => {
    if (want.kind === "file") {
      return there?.kind === "file" && there.size === want.size && there.mode === want.mode
        && sameBytes(stagedFile(path, want), place);
    }
    if (want.kind === "dir") return there?.kind === "dir" && there.mode === want.mode;
    return want.kind === "link" && there?.kind === "link" && there.text === want.text;
  };

  // --- What is to be done, found out before anything is ---

  /** One thing to do: at a place holding `there`, to have `want` (nothing, for what the run removed). */
  interface Deed { path: string; place: string; want: Entry | undefined; there: Entry | undefined }

  /**
   * A path as the real directory spells it — the names it has for each step,
   * which need not be the path's letters: a file system may take "Notes.txt"
   * and "notes.txt" for one name. Undefined if nothing is there.
   */
  const namesOf = new Map<string, string[]>();
  const spelled = (path: string): string | undefined => {
    const steps: string[] = [];
    let at = real;
    for (const step of path.split("/")) {
      const stat = lstatSync(join(at, step), { bigint: true, throwIfNoEntry: false });
      if (!stat) return undefined;
      const names = namesOf.get(at) ?? namesIn(at);
      namesOf.set(at, names);
      const name = names.includes(step) ? step : names.find((other) => {
        const its = lstatSync(join(at, other), { bigint: true, throwIfNoEntry: false });
        return its !== undefined && its.dev === stat.dev && its.ino === stat.ino;
      });
      if (name === undefined) return undefined;
      steps.push(name);
      at = join(at, name);
    }
    return steps.join("/");
  };
  /**
   * Names the run spelled otherwise, where the real directory takes the two
   * spellings for one name: each path as it was, with the path it is now. To
   * a tree, which knows paths by their letters, that is one entry removed and
   * another made. In the real directory the two are one place — removing the
   * one would remove the other — and neither is touched: the pair is told of
   * as not arrived.
   */
  const spelledAnew = new Map<string, string>();
  for (const path of changed) {
    if (before.has(path) || !after.has(path)) continue;
    let was;
    try {
      was = spelled(path);
    } catch {
      continue; // nothing can be made of the place: it will say so in its turn
    }
    if (was !== undefined && was !== path && before.has(was) && !after.has(was)) spelledAnew.set(was, path);
  }
  const oneName = (was: string, now: string) =>
    new Error(`the run spelled ${was} as ${now}, and the project's file system takes the two for one name: it is left as it was`);

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

  /**
   * What is to be done at a path — nothing, if the place is as the run left
   * it already. Throws if it cannot be done: with why, which is all that is
   * done about it. Only looks.
   */
  const decide = (path: string): Deed | undefined => {
    const now = spelledAnew.get(path);
    if (now !== undefined) throw oneName(path, now);
    const was = before.get(path);
    const is = after.get(path);
    const want = is && wanted(is);
    const place = join(real, path);
    const dir = dirname(path);
    // In a directory still to be made there is nothing — whatever is, for now, at the place of that directory.
    const inNew = toMake.has(dir);
    if (!inNew && !ownWay(dir)) {
      // No way that is the directory's own leads there any more. What the run removed is, then, not there.
      if (!want) return undefined;
      throw new Error("the directory it is in is no longer there in the project");
    }
    const there = inNew ? undefined : entryAt(place);
    if (!want && !there) return undefined;
    // The directory it is in. One the run changed has its own turn, before this; any other must be as it was.
    if (dir !== "." && !isChanged.has(dir) && !same(entryAt(join(real, dir)), seed.get(dir))) {
      throw new Error(`what ${dir} allows was changed in the project meanwhile`);
    }

    if (want?.kind === "dir" && was?.kind === "dir") {
      // What it allows is what changed.
      if (there?.kind !== "dir") throw new Error("it was changed or removed in the project meanwhile");
      if (there.mode === want.mode) return undefined;
      if (!same(there, seed.get(path))) throw new Error("what it allows was changed in the project meanwhile");
      return { path, place, want, there };
    }
    if (!was && there) {
      // The place of a new path holds something: the path under another spelling of its name, or somebody else's.
      const as = spelled(path);
      if (as !== undefined && as !== path) throw oneName(as, path);
    }
    if (want && holds(there, place, want, path)) return undefined;
    if (!was && there) throw new Error("something else is at that place in the project");
    if (was && !same(there, seed.get(path))) {
      throw new Error(want ? "it was changed or removed in the project meanwhile" : "the run removed it, but it was changed in the project meanwhile");
    }
    if (there?.kind === "dir") {
      // It is to go — and can, if it holds nothing but what this merge removes from it.
      const goes = (child: string) => before.has(child) && !after.has(child) && child !== except;
      const kept = namesIn(place).find((name) => !goes(`${path}/${name}`));
      if (kept !== undefined) throw new Error(`the run removed it, but it holds something in the project that is not removed with it (${kept})`);
    }
    if (want?.kind === "dir") toMake.add(path);
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
  // A directory goes only if all that is in it goes. The deepest first, so that what stays keeps everything above it.
  for (const { path, want, there } of [...deeds].reverse()) {
    if (there?.kind !== "dir" || want?.kind === "dir") continue;
    const stays = [...refused.keys()].find((other) => other.startsWith(`${path}/`));
    if (stays !== undefined) refused.set(path, `the run removed it, but not all that is in it can go (${stays})`);
  }

  // --- Doing it ---

  /** Directories opened for what they hold to be changed, and what each is to be left allowing. */
  const opened = new Set<string>();
  const toClose = new Map<string, { place: string; mode: number }>();
  const open = (dir: string): void => {
    if (dir === "." || opened.has(dir)) return;
    const place = join(real, dir);
    const there = entryAt(place);
    if (there?.kind === "dir") {
      const left = after.get(dir);
      const final = left?.kind === "dir" ? left.mode : there.mode;
      const ready = there.mode | 0o700;
      if (ready !== there.mode) chmodSync(place, ready);
      if (ready !== final) toClose.set(dir, { place, mode: final });
    } // (if it is no directory, what is done in it will say so)
    opened.add(dir); // only now: if it could not be opened, the next to need it open is told so too
  };

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
      copyFileSync(stagedFile(path, want), made, constants.COPYFILE_EXCL);
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

  // What takes the place of something of another kind is made first, beside the place: if the system will not
  // have it made, nothing has been removed for its sake.
  each(deeds, ({ path, place, want, there }) => {
    if (!there || !want || want.kind === "dir" || want.kind === there.kind) return;
    open(dirname(path));
    ready.set(path, beside(path, want, place));
  });

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
    if (want.kind === "dir" && there?.kind === "dir") return open(path); // what it allows: seen to when it is closed
    open(dirname(path));
    const made = ready.get(path);
    if (want.kind === "dir") {
      mkdirSync(place);
      const allowing = want.mode | 0o700;
      chmodSync(place, allowing);
      opened.add(path);
      if (allowing !== want.mode) toClose.set(path, { place, mode: want.mode });
    } else if (made) {
      ready.delete(path);
      moveIn(made, place);
    } else if (want.kind === "link") {
      if (there) moveIn(beside(path, want, place), place);
      else symlinkSync(want.text, place);
    } else if (want.kind === "file") {
      const staged = stagedFile(path, want);
      if (!there) {
        copyFileSync(staged, place, constants.COPYFILE_EXCL);
      } else if (mayBeWrittenTo(place)) {
        if (there.kind !== "file" || there.size !== want.size || !sameBytes(staged, place)) copyFileSync(staged, place);
      } else {
        moveIn(beside(path, want, place), place);
      }
      if (modeAt(place) !== want.mode) chmodSync(place, want.mode);
    }
  });

  // What was made ready and never moved in — the system refused something on the way — is not left lying there.
  for (const [path, made] of ready) {
    const left = discard(made);
    if (left) refused.set(path, (refused.get(path) ?? "") + left);
  }
  // The directories that were opened, or made open, are left as the run left them — the deepest first.
  for (const [path, { place, mode }] of [...toClose].sort(([a], [b]) => (a < b ? 1 : -1))) {
    try {
      chmodSync(place, mode);
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
