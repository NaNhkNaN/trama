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
import { basename, dirname, isAbsolute, join, relative, sep } from "path";
import { identityIn, identityOf, linksOf, linkText, realRootOf, utf8Text } from "./path-guard.js";
import { stagedNameFor } from "./replace-file.js";
import { messageOf } from "./errors.js";

/**
 * What is at one path. `id` says which file, directory or link it is: it
 * stays the same through being written to, renamed, or given other
 * permissions, and nothing else has it. (It is the system's numbers for it —
 * its device's, and its own on that — and a file system may give a number
 * again once what had it is gone: what was removed can so be taken for what
 * was made after it.)
 */
export type Entry =
  /** `stamp` is different after any change to the file — to what it holds or to what it allows — and cannot be set by a program. */
  | { kind: "file"; mode: number; size: number; stamp: string; id: string }
  | { kind: "dir"; mode: number; id: string }
  | { kind: "link"; text: string; id: string }
  /** A pipe, a socket, a device, a link that says nothing a path can be made of: one end of something else, not content. */
  | { kind: "other" };

/**
 * What a directory is and holds: the directory itself, as ".", and every path
 * under it ("/" between the names) — a directory before what is in it.
 */
export type Tree = Map<string, Entry>;

/** The path of the directory a tree is of. It is in no directory of the tree, and every other path is under it. */
const ITSELF = ".";
/** The order in which a path comes before every path under it. (As text "." comes after "-x", which is under it.) */
const inOrder = (a: string, b: string) => (a === b ? 0 : a === ITSELF || (b !== ITSELF && a < b) ? -1 : 1);

const NOT_CONTENT: Entry = { kind: "other" };

/** What is at a path — the path itself, not what a link there leads to. Undefined if nothing is. */
export function entryAt(path: string): Entry | undefined {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!stat) return undefined;
  const mode = Number(stat.mode & 0o7777n);
  const id = identityIn(stat);
  if (stat.isFile()) {
    // The time of the last change is the system's own: it moves when the file is written, replaced, or
    // has its permissions changed, and no program can put it back. (The time of the last write can be.)
    return { kind: "file", mode, size: Number(stat.size), stamp: `${id}:${stat.ctimeNs}:${stat.size}`, id };
  }
  if (stat.isDirectory()) return { kind: "dir", mode, id };
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

/** Which file, directory or link an entry is — undefined of what is none. */
const idOf = (entry: Entry | undefined) => (entry === undefined || entry.kind === "other" ? undefined : entry.id);

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
    const name = utf8Text(raw);
    if (name === undefined) throw new Error(`${dir} holds a name that is not readable as text`);
    return name;
  });
}

const gone = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";
/** Whether a refusal says that there is no such place: nothing is there, or the system takes no such name. */
const noSuchPlace = (err: unknown) => ["ENOENT", "ENOTDIR", "ENAMETOOLONG"].includes((err as NodeJS.ErrnoException).code ?? "");

/**
 * Go through a directory and everything under it, a directory before what it
 * holds. `visit` is given each path, what is there, and where that is; if it
 * returns false the entry is left out, and not gone into.
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
  const itself = entryAt(root);
  if (itself && visit(ITSELF, itself, root) === false) return;
  into(root, "", namesIn(root)); // (which says so, if no directory is there)
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

/** What a directory is and holds. The directory must be there, and all of it readable. */
export function readTree(dir: string): Tree {
  const tree: Tree = new Map();
  walk(realRootOf(dir), (path, entry) => { tree.set(path, entry); });
  return tree;
}

/**
 * Make `toDir` — an empty directory — what `fromDir` is: allowing what it
 * allows and holding what it holds. Returns what that was: the directory, and
 * each entry as it was when it was copied. `leaveOut` names
 * what is no part of it; those entries are neither copied nor returned.
 *
 * What a directory holds is its files, its directories with what they allow,
 * and its links. What is not content is not carried over, though the tree
 * returned says it is there. The directory itself is one of its directories
 * in this: the copy is left allowing what it allows — to its owner, and to
 * everybody else. (So a copy that is to be nobody else's is made in a
 * directory that is nobody else's.)
 *
 * A link is made to name, in the copy, what it names here: the same place in
 * the copy if that is under `fromDir`, and the same place outside it if not.
 * Most links do that as they are written, and are kept so — but for the
 * letters of a name the copy does not have as it is written, where its file
 * system tells apart what this one takes for one name. Not one whose
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
  /** What was copied, by what it is: the paths the copy has it under. (A file may have several names.) */
  const copiedAs = new Map<string, string[]>();
  const copiedIs = (id: string, path: string) => { copiedAs.set(id, [...(copiedAs.get(id) ?? []), path]); };
  /** The links whose words name things of the directory, to be read again when all of the copy is there. */
  const written: Array<{ copied: string; says: string; before: string; dir: string; words: string }> = [];

  const read = linksOf(from);
  /**
   * What a link must say in the copy — undefined if what it names cannot be
   * told — and, of that, the `words` that name things of the directory: said
   * from `dir`, after what stands `before` them.
   */
  const inCopy = (link: string, text: string): { says: string; own?: { before: string; dir: string; words: string } } | undefined => {
    try {
      try {
        statSync(link);
      } catch (err) {
        if (!gone(err)) throw err; // (that nothing is there yet is no refusal to go there)
      }
      const lead = read.names(dirname(link), text);
      // (Words from the top that never come to the directory name nothing of it: they need no second reading,
      // which for such words is a long one.)
      if (!lead.strays) return { says: text, own: isAbsolute(text) ? undefined : { before: "", dir: dirname(link), words: text } };
      // A way that strays and does not come home ends outside the directory: the place is itself, from anywhere.
      if (lead.home === undefined) return { says: lead.to };
      return { says: to + lead.home, own: lead.home === "" ? undefined : { before: to + sep, dir: from, words: lead.home.slice(sep.length) } };
    } catch {
      return undefined;
    }
  };
  /**
   * Words of a link, each name in the letters the copy knows it by. A file
   * system may take "data" for the name of what its directory lists as
   * "Data", and the copy's need not: there the words would lead nowhere. So a
   * name the copy does not have as it is written, and has under the name its
   * directory lists here — the one that reads the same — is written as that. Where each name is looked up is
   * asked of the words before it; which directory of the copy that is, and
   * what the copy calls the thing, is known from the copying: a name of
   * something that is not in the copy is left as it is.
   */
  const spelled = (dir: string, words: string): string => {
    const steps = words.split(sep);
    return steps.map((step, i) => {
      if (step === "" || step === "." || step === "..") return step;
      try {
        const at = i === 0 ? dir : read.names(dir, steps.slice(0, i).join(sep) + sep).to;
        const [inDir] = copiedAs.get(identityOf(at) ?? "") ?? [];
        if (inDir === undefined || identityOf(join(to, inDir, step)) !== undefined) return step;
        const names = (copiedAs.get(identityOf(join(at, step)) ?? "") ?? []).filter((path) => dirname(path) === inDir).map((path) => basename(path));
        return names.find((other) => reads(other) === reads(step)) ?? step;
      } catch {
        return step;
      }
    }).join(sep);
  };

  walk(from, (path, entry, source) => {
    if (leaveOut(source, entry)) return false;
    const copied = join(to, path);
    tree.set(path, entry);
    if (entry.kind === "dir") {
      if (path !== ITSELF) mkdirSync(copied); // (the copy itself is there: it is what was given)
      dirs.push({ copied, mode: entry.mode });
      copiedIs(entry.id, path);
    } else if (entry.kind === "file") {
      try {
        // The copy is empty where this goes: a name that is there already is two names of the directory taken for one.
        copyFileSync(source, copied, constants.COPYFILE_EXCL);
        copiedIs(entry.id, path);
      } catch (err) {
        if (!gone(err) || lstatSync(source, { throwIfNoEntry: false })) throw err;
        tree.delete(path); // gone since it was looked at
      }
    } else if (entry.kind === "link") {
      const said = inCopy(source, entry.text);
      try {
        if (said === undefined) tree.set(path, NOT_CONTENT);
        else {
          symlinkSync(said.says, copied);
          copiedIs(entry.id, path);
          if (said.own) written.push({ copied, says: said.says, ...said.own });
        }
      } catch (err) {
        // Words made for the copy that are too long for a link: they cannot be said here at all.
        if (said?.says === entry.text || (err as NodeJS.ErrnoException).code !== "ENAMETOOLONG") throw err;
        tree.set(path, NOT_CONTENT);
      }
    }
  });
  // The letters of each link's words, now that the copy can be asked what it has.
  for (const { copied, says, before, dir, words } of written) {
    const spelt = before + spelled(dir, words);
    if (spelt === says) continue;
    unlinkSync(copied);
    try {
      symlinkSync(spelt, copied);
    } catch (err) {
      symlinkSync(says, copied);
      if ((err as NodeJS.ErrnoException).code !== "ENAMETOOLONG") throw err;
    }
  }
  // Last, and the deepest first: a directory that may not be written to has to be filled before it is closed.
  for (const { copied, mode } of dirs.reverse()) chmodSync(copied, mode);
  return tree;
}

/** A name as it reads, whatever its letters: what tells one name of a file from another, where a file system takes several for one. */
const reads = (name: string) => name.normalize("NFD").toLowerCase();

/**
 * The name a directory lists for what it knows as `name` — which need not be
 * the letters given: a file system may take "Program.ts" and "program.ts"
 * for one name. Undefined if nothing is there.
 *
 * Found by what is there. A file may have more names than one in a directory,
 * and then the one meant is the one that reads the same as the name given.
 */
function nameListed(dir: string, name: string): string | undefined {
  const what = identityOf(join(dir, name));
  if (what === undefined) return undefined;
  const names = namesIn(dir);
  if (names.includes(name)) return name;
  const its = names.filter((other) => identityOf(join(dir, other)) === what);
  return its.find((other) => reads(other) === reads(name)) ?? its[0];
}

/**
 * The path a reading of `dir` has for a place: each step by the name its
 * directory lists for it, and "." for the directory itself. Undefined if
 * nothing is there, or the place is not in `dir`. The place is named without
 * links.
 */
export function pathAsListed(dir: string, place: string): string | undefined {
  const root = realRootOf(dir);
  const steps = relative(root, place).split(sep);
  if (steps[0] === "") return identityOf(root) === undefined ? undefined : ITSELF;
  if (steps[0] === "..") return undefined; // (outside: its first step up is there to be found, whatever the directory is)
  let at = root;
  for (const [i, step] of steps.entries()) {
    const name = nameListed(at, step);
    if (name === undefined) return undefined;
    at = join(at, steps[i] = name);
  }
  return steps.join("/");
}

/** Something a run did in a copy that did not reach the real directory, and why. */
export interface Unmerged { path: string; why: string }


/**
 * Carry what a run did to a copy back into the directory it is a copy of.
 *
 * @param stagedDir - the copy, as the run left it
 * @param realDir - the directory it was copied from
 * @param before - the copy as it was before the run (readTree)
 * @param seed - the real directory as it was when the copy was made (copyTree)
 * @param together - things that are one thing to the caller: each list the
 *   `id`s (see Entry) of the files, links and directories that are one
 *
 * What the run did is where the copy differs from what it was: a file, a
 * directory or a link made, removed, changed, or put where something of
 * another kind was; permissions changed — those of the directory itself
 * among them, which is a directory like any in it: only that it is neither
 * made nor removed. Each difference is carried over on
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
 * directory stays whole. What the run moved — a file, a link, a directory —
 * goes from where it was only if it arrives where the run moved it: what it
 * holds is not to be in neither place. (What was moved is known by its `id`,
 * see Entry. What the run copied and then removed is a new file, and is not
 * known to be the old one's.) And what the caller says is one thing — a
 * link, say, with the file that makes it lead somewhere: the things in one
 * list of `together`, each known by what it is, at every path where the copy
 * had it before the run or has it now — arrives together or not at all: if
 * one of those paths is left alone, nothing is done at any of them. A part
 * the run left as it was has nothing to arrive, but the rest leans on it: if
 * it is not, in the project, as it was when the copy was made, that is told
 * of it, and the rest does not arrive. (So that all this holds where the
 * system refuses in the doing, what is done at such a path is only what can
 * be taken back: a file there is not written into but has the new one put in
 * its place, and what is to go from there is moved aside first, as what is
 * taken the place of is. A directory among them that stays a directory is
 * not left alone with the rest — what else the run did in it could not be
 * taken for undone with it — but what it was to be left allowing does not
 * arrive either, and that is told of it. And a part the run left as it was,
 * and that is not so in the project, is told of besides, as that: nothing
 * under it is left alone for it — and nothing is told of it where nothing is
 * held back for it.) So what is returned as not arrived is as it
 * was, at that path and under it. That holds where the system refuses, in
 * the doing, what had been found possible — see how it is done, below — as
 * long as it does not also refuse to put back what was moved aside; then
 * the report says where that is.
 *
 * Some things are told of besides, which are not that. What was moved aside
 * to go, or made ready and not needed, and which the system will not have
 * removed, is told of at the name it is left under — a path that is none of
 * the run's. A directory the run removed which the system will not remove,
 * or not with all that was in it, holds what is left, as it would had the
 * run removed it there, and is told of so. A directory or a file that could
 * not be given, at the end, what it is to allow is told of for that: what
 * it holds has arrived, unless that is told of itself. A file that could not
 * be written into, and had a new one put in its place, is told of for that.
 * (If the system will not have the new one put there either, the file did
 * not arrive, and the report says that what it held may be damaged, and
 * where what it was to hold is.)
 *
 * Finding out is looking, and a directory that is closed cannot be looked
 * into. One of the real directory's — or the directory itself — is opened
 * for it, as it is for what is then done in it, and one of the copy's is
 * opened to be read: both are this merge's to open. Each is left, at the end,
 * allowing what the run left it allowing — or, if that did not arrive, what
 * it allowed. (One that somebody else gave other permissions since the copy
 * was made is theirs, and is not opened: nothing is made or removed in it.)
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
 * are therefore left, where one would have done.) If what is there is a
 * directory, nothing is done in it either: a path through it is a path
 * through the other, and what the run left under the two names is in one
 * place. And two names the run made where nothing was, which the directory
 * turns out to take for one when the second is put there: neither is put.
 * (That can only be seen in the putting. If the first was not put, for a
 * reason of its own, the second is — and what is told of the first is then
 * true of the name as the run spelled it, not as the directory takes it.)
 * The same is asked of the way to a path: a directory on it that the real
 * one no longer lists as the tree spells it — somebody spelled it anew — is
 * not the tree's directory any more, and nothing is done in it.
 *
 * What is to be done is done so that nothing is lost by its being done in
 * part. A file or a link that is to be where something is, is made beside
 * the place first. Then what the run made is made, a directory before what
 * goes in it. What is in the place of it is not removed but moved aside,
 * under a name of its own beside the place, and what was made beside the
 * place is moved in. (Only a directory that stays a directory, and a file
 * the run wrote into that can be written into, stay and are changed where
 * they are. A file that is written into has what it is to hold made beside
 * it first all the same: if the system will not have the writing — which it
 * may have begun — that takes its place.) Where the system will not have a thing done, that
 * thing is left alone like what was found impossible beforehand, with what
 * follows from it — and what follows may be that something already done is
 * not to stand: what the run moved from there did not arrive where it went.
 * Then what was put there is removed again, and what was moved aside comes
 * back. Only when all that is settled does what was moved aside go for good,
 * and what the run removed, where it is. (A runner that is stopped in the
 * middle leaves what it had moved aside, or made ready, where it is: under
 * names that begin with .trama-tmp-.) It is where the run ended that is
 * carried over, not the steps by which it got there.
 *
 * A file the run wrote into is written into, if it may be, and stays the
 * file it is — as does one that holds what the run left already, and has
 * only what it allows changed. Where the run put another file in the place,
 * or the file may not be written into, or the system will not have it
 * written into after all, a new one is put in its place — and then a second
 * name of the old file is none of the new one, and holds whatever the
 * writing left. A link is written as the run wrote it
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
 * off as one whose work did. Under a path that did not arrive, what was not
 * looked at for that reason is not listed: it is as it was, with the path.
 */
export function mergeTree(stagedDir: string, realDir: string, before: Tree, seed: Tree, together: string[][] = []): Unmerged[] {
  let copy: string;
  let real: string;
  const after: Tree = new Map();
  try {
    real = realRootOf(realDir);
    // The directory is the one that was copied — which the seed knows by what it is. Where it is gone, or another
    // is at its path by now, there is nothing here that the run's work is the work on.
    const itself = entryAt(real), copied = seed.get(ITSELF);
    if (itself?.kind !== "dir") return [{ path: ITSELF, why: "the project is no longer there; nothing was merged into it" }];
    if (copied?.kind === "dir" && copied.id !== itself.id) {
      return [{ path: ITSELF, why: "another directory is at the project's path than the one that was copied; nothing was merged into it" }];
    }
  } catch (err) {
    return [{ path: ITSELF, why: `the project could not be come to (${messageOf(err)}); nothing was merged into it` }];
  }
  try {
    copy = realRootOf(stagedDir);
    walk(copy, (path, entry, at) => {
      after.set(path, entry); // as the run left it
      if (entry.kind === "dir" && (entry.mode & 0o500) !== 0o500) chmodSync(at, entry.mode | 0o500);
    });
  } catch (err) {
    // What the run left cannot be told. Nothing is merged — least of all as a removal of what cannot be seen.
    return [{ path: ITSELF, why: `what the run left could not be read (${messageOf(err)}); none of it was merged` }];
  }
  /**
   * Whether what is at a path, though it looks the same, is something the run
   * moved there from another place. (Something new that looks the same is no
   * change: nothing depends on its being there.)
   */
  const wasSomewhere = new Set([...before.values()].map(idOf));
  const movedHere = (path: string) => {
    const id = idOf(after.get(path));
    return id !== undefined && id !== idOf(before.get(path)) && wasSomewhere.has(id);
  };
  // Sorted, a path comes before every path under it.
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => !same(before.get(path), after.get(path)) || movedHere(path))
    .sort(inOrder);
  const isChanged = new Set(changed);
  /**
   * What is one thing to the caller (see `together`), as paths: by each path
   * where the copy has a part of such a thing — had it before the run, or has
   * it now — the things it is a part of, each as all its paths.
   */
  const partOf = new Map<string, string[][]>();
  if (together.length > 0) {
    const where = new Map<string, Set<string>>();
    for (const tree of [before, after]) {
      for (const [path, entry] of tree) {
        const id = idOf(entry);
        if (id === undefined) continue;
        const those = where.get(id);
        if (those) those.add(path);
        else where.set(id, new Set([path]));
      }
    }
    for (const ids of together) {
      const paths = [...new Set(ids.flatMap((id) => [...(where.get(id) ?? [])]))];
      for (const part of paths) {
        const those = partOf.get(part);
        if (those) those.push(paths);
        else partOf.set(part, [paths]);
      }
    }
  }
  const parts = [...partOf.keys()].sort();

  /** What did not arrive, and why: found out beforehand, or — once things are being done — told by the system. */
  const refused = new Map<string, string>();
  /** Whether a path is under one of some paths. */
  const underOne = (path: string, of: { has(path: string): boolean }): boolean => {
    for (let end = path.lastIndexOf("/"); end !== -1; end = path.lastIndexOf("/", end - 1)) {
      if (of.has(path.slice(0, end))) return true;
    }
    return path !== ITSELF && of.has(ITSELF);
  };
  /** Whether a path is one of those that did not arrive, or under one. */
  const leftAlone = (path: string): boolean => refused.has(path) || underOne(path, refused);

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
  const sameAlready = new Map<string, boolean>();
  const holdsBytes = (there: Entry, place: string, want: Entry & { kind: "file" }, path: string): boolean => {
    if (there.kind !== "file" || there.size !== want.size) return false;
    let known = sameAlready.get(path);
    if (known === undefined) {
      try {
        known = sameBytes(stagedFile(path), place);
      } catch {
        known = false;
      }
      sameAlready.set(path, known);
    }
    return known;
  };
  /** Whether a place already holds what is wanted at a path. */
  const holds = (there: Entry | undefined, place: string, want: Entry, path: string): boolean => {
    if (want.kind === "file") return there?.kind === "file" && there.mode === want.mode && holdsBytes(there, place, want, path);
    if (want.kind === "dir") return there?.kind === "dir" && there.mode === want.mode;
    return want.kind === "link" && there?.kind === "link" && there.text === want.text;
  };

  /**
   * Directories of the real one opened to be looked into or changed, and
   * those this merge makes: what each is to be left allowing — what it
   * allowed, until what the run left it allowing arrives.
   */
  const opened = new Set<string>();
  /**
   * Each with which directory it is, what it is to be left allowing, and what
   * this merge has it allowing for now (-1: not known — it was made, and
   * could not then be given what it was to allow while it is filled).
   */
  const toClose = new Map<string, { id: string | undefined; mode: number; has: number }>();
  const open = (dir: string): void => {
    if (opened.has(dir)) return;
    const place = join(real, dir);
    const there = entryAt(place);
    if (there?.kind === "dir") {
      const closing = { id: identityOf(place), mode: there.mode, has: there.mode };
      toClose.set(dir, closing);
      if ((there.mode | 0o700) !== there.mode) {
        chmodSync(place, there.mode | 0o700);
        closing.has = there.mode | 0o700;
      }
    } // (if it is no directory, what is done in it will say so)
    opened.add(dir); // only now: if it could not be opened, the next to need it open is told so too
  };

  // --- What is to be done, found out before anything is ---

  /** One thing to do: at a place holding `there`, to have `want` (nothing, for what the run removed). */
  interface Deed { path: string; place: string; want: Entry | undefined; there: Entry | undefined }
  /** Whether a deed is at a directory that is to be a directory: what it allows is all that changes there. */
  const staysADirectory = ({ want, there }: Pick<Deed, "want" | "there">) => want?.kind === "dir" && there?.kind === "dir";
  /** Whether a deed is at a directory that is to go — removed, or with something else in its place. */
  const goesAsADirectory = ({ want, there }: Pick<Deed, "want" | "there">) => there?.kind === "dir" && want?.kind !== "dir";

  /** Directories the run made that are to be made here: they are not in the real directory yet. */
  const toMake = new Set<string>();
  /**
   * Whether the way to a directory of the tree is the real directory's own:
   * every step of it a directory, none a link put there since. (Asked as far
   * as the way exists: a directory still to be made is made by this merge.)
   */
  const own = new Map<string, boolean>();
  const ownWay = (dir: string): boolean => {
    if (dir === ITSELF) return true;
    if (toMake.has(dir)) return ownWay(dirname(dir));
    let known = own.get(dir);
    if (known === undefined) {
      known = ownWay(dirname(dir)) && entryAt(join(real, dir))?.kind === "dir" && spells(dirname(dir), basename(dir));
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
  const listed = new Map<string, Set<string>>();
  const spells = (dir: string, name: string): boolean => {
    let names = listed.get(dir);
    if (!names) listed.set(dir, names = new Set(namesIn(join(real, dir))));
    return names.has(name);
  };
  /** What is in the real directory under a name that is not the directory's own for it: by what it is, the tree's path. */
  const otherwise = new Map<string, string>();

  /**
   * What is to be done at a path — nothing, if the place is as the run left
   * it already. Throws if it cannot be done: with why, which is all that is
   * done about it. It looks, and opens a directory to look; no more. (So
   * every directory in which something is then done is open by then.)
   */
  const decide = (path: string): Deed | undefined => {
    const was = before.get(path);
    const is = after.get(path);
    const place = join(real, path);
    const dir = dirname(path);
    let there: Entry | undefined;
    /** That somebody changed the directory it is in — which is said only once it is known that something needs doing there. */
    let notInIt: Error | undefined;
    if (path === ITSELF) {
      // The directory itself is in no directory of the tree: it is where it is, by the name it was given.
      there = entryAt(place);
    } else if (!toMake.has(dir)) {
      // (In a directory still to be made there is nothing — whatever is, for now, at the place of that directory.)
      if (!ownWay(dir)) {
        // No way that is the directory's own leads there any more. What the run removed is, then, not there —
        // unless something is, by the way as it is now: under another spelling of a directory, or through a
        // link put in its place. That is somebody's, and is left; but it is not gone, and that is said.
        if (!is) {
          let found: Entry | undefined;
          try {
            found = entryAt(place);
          } catch (err) {
            if (!noSuchPlace(err)) throw err;
          }
          if (!found) return undefined;
        }
        throw new Error("the directory it is in is no longer there in the project, by that name");
      }
      // The directory it is in. One the run changed has its own turn, before this; any other must be as it was.
      if (!isChanged.has(dir) && !unchanged(dir)) {
        notInIt = new Error(dir === ITSELF ? "what the project's own directory allows was changed meanwhile" : `what ${dir} allows was changed in the project meanwhile`);
      }
      let byItsName: boolean;
      try {
        // It is looked into as it will be changed: opened, if it is closed — unless that it is closed is somebody
        // else's doing. (What the run left as it was is only looked at, which a directory that held it allows.)
        if (!notInIt && isChanged.has(path)) open(dir);
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
    // What the run left as it was, and is as it was in the project, needs nothing done. (It is looked at because
    // it is part of what is one thing: see the loop below.)
    if (!isChanged.has(path) && same(there, seed.get(path))) return undefined;
    const want = is && wanted(path, is);
    // A place that holds what the run left needs nothing done — whoever made it so, and whatever became of its
    // directory, as long as it can still be looked into: one that somebody closed is not opened to find out.
    if (want && holds(there, place, want, path)) return undefined;
    if (notInIt) throw notInIt;

    if (!was && there) throw new Error("something else is at that place in the project");
    if (was && !same(there, seed.get(path))) {
      throw new Error(want ? "it was changed or removed in the project meanwhile" : "the run removed it, but it was changed in the project meanwhile");
    }
    if (goesAsADirectory({ want, there })) {
      // It is to go — and can, if it holds nothing but what this merge removes from it.
      const goes = (child: string) => before.has(child) && !after.has(child);
      const kept = namesIn(place).find((name) => !goes(`${path}/${name}`));
      if (kept !== undefined) throw new Error(`the run removed it, but it holds something in the project that is not removed with it (${kept})`);
    }
    if (want?.kind === "dir" && there?.kind !== "dir") toMake.add(path);
    return { path, place, want, there };
  };

  const deeds: Deed[] = [];
  /** Parts of things that the run left as they were, and that are not so in the project: by the path, why. */
  const amiss = new Map<string, string>();
  // What the run changed — and the parts of what is one thing that it did not: nothing is to be done there, but
  // the rest of the thing leans on their being there as they were.
  for (const path of [...new Set([...changed, ...parts])].sort(inOrder)) {
    if (leftAlone(path)) continue;
    try {
      const deed = decide(path);
      if (deed) deeds.push(deed);
    } catch (err) {
      // (A part the run left as it was did not fail to arrive: nothing under it is left alone for its sake.)
      (isChanged.has(path) ? refused : amiss).set(path, messageOf(err));
    }
  }
  // What the real directory takes for one name is one thing there: nothing is done to it under any name — nor,
  // if it is a directory, in it: a path through it is a path through the other.
  if (otherwise.size > 0) {
    /** The path the run left that is taken for a name of a directory, or of one it is in — if any is. */
    const takenFor = new Map<string, string | undefined>();
    const through = (dir: string): string | undefined => {
      if (dir === ITSELF) return undefined;
      if (!takenFor.has(dir)) takenFor.set(dir, otherwise.get(identityOf(join(real, dir)) ?? "") ?? through(dirname(dir)));
      return takenFor.get(dir);
    };
    for (const { path, place, there } of deeds) {
      if (path === ITSELF || leftAlone(path)) continue;
      try {
        const other = there && otherwise.get(identityOf(place) ?? "");
        const above = other === undefined ? through(dirname(path)) : undefined;
        if (other !== undefined) {
          refused.set(path, `the run left ${other}, which the project's file system takes for a name of this, or of what is one file with it: it is left as it was`);
        } else if (above !== undefined) {
          refused.set(path, `the run left ${above}, which the project's file system takes for a name of a directory this is in: it is left as it was`);
        }
      } catch (err) {
        refused.set(path, messageOf(err));
      }
    }
  }
  /** Where each file, directory and link is, as the run left things. */
  const nowAt = new Map<string, string[]>();
  for (const [path, is] of after) {
    const id = idOf(is);
    if (id === undefined) continue;
    const those = nowAt.get(id);
    if (those) those.push(path);
    else nowAt.set(id, [path]);
  }
  /**
   * Where the run has what is at a deed's place, if that is to go from there
   * or be taken the place of. (If it is there still, among other places, it
   * has not been moved from there. A directory that stays a directory is not
   * one that goes, whichever directory the run has there: what it holds is
   * seen to path by path.)
   */
  const wentTo = (deed: Deed): string[] => {
    const id = staysADirectory(deed) ? undefined : idOf(before.get(deed.path));
    return (id === undefined ? undefined : nowAt.get(id)) ?? [];
  };
  const deedAt = new Map(deeds.map((deed) => [deed.path, deed]));
  /** By each place the run moved something to, the deeds at the places it moved it from. */
  const cameFrom = new Map<string, Deed[]>();
  /** Of each deed at a place the run moved something from, how many of the places it moved it to may yet arrive. */
  const mayArriveAt = new Map<Deed, number>();
  for (const deed of deeds) {
    const all = wentTo(deed);
    if (all.length > 0) mayArriveAt.set(deed, all.length);
    for (const to of all) {
      let those = cameFrom.get(to);
      if (!those) cameFrom.set(to, those = []);
      those.push(deed);
    }
  }
  /** The places the run moved something to, in order. */
  const arrivals = [...cameFrom.keys()].sort();
  /**
   * What follows from what did not arrive, for what was to go from where it
   * was — until nothing more follows. What the run moved goes from where it
   * was only if it arrives where it went: what it holds is not to be in
   * neither place. And a directory goes only if all that is in it goes. Each
   * can bring the other about: what stays in a directory keeps the directory,
   * and a directory that stays is in the way of what was moved to its place.
   * (Each path that did not arrive is followed up once, and each place
   * something was moved to is counted out once.)
   */
  const followedUp = new Set<string>();
  const countedOut = new Set<string>();
  /** Of the things that are one (see `partOf`), those of which a part has not arrived, or is not as it was. */
  const broken = new Set<string[]>();
  /**
   * The directories that stay directories, of such things: by the path, what
   * the thing did not arrive for. A directory like that is not left alone
   * with the rest — what else was done in it could not be taken for undone
   * with it — but what it was to be left allowing does not arrive.
   */
  const heldBack = new Map<string, string>();
  /** Of paths in order, those that are a given path or under it. */
  const atOrUnder = (sorted: string[], path: string): string[] => {
    const under = `${path}/`;
    const found = sorted[firstNotBefore(sorted, path)] === path ? [path] : [];
    for (let at = firstNotBefore(sorted, under); at < sorted.length && sorted[at].startsWith(under); at++) found.push(sorted[at]);
    return found;
  };
  const settle = () => {
    const toFollowUp = [...refused.keys()].filter((path) => !followedUp.has(path));
    const refuse = (path: string, why: () => string) => {
      if (leftAlone(path)) return;
      refused.set(path, why());
      toFollowUp.push(path);
    };
    /**
     * The things a path is part of do not arrive: it did not, or is not as it
     * was. Says whether anything is held back for that. (What follows from a
     * directory's being held back is followed up in turn, not gone into: a
     * chain of things may be as long as the caller makes it.)
     */
    const without = (first: string, how: string): boolean => {
      let any = false;
      const toDo: Array<[string, string]> = [[first, how]];
      for (let next; (next = toDo.pop()) !== undefined;) {
        const [part, which] = next;
        // All the paths of the things it is part of, in order: a path under one that is left alone is left alone
        // with it.
        const others = new Set<string>();
        for (const paths of partOf.get(part) ?? []) {
          if (broken.has(paths)) continue;
          broken.add(paths);
          for (const other of paths) others.add(other);
        }
        for (const other of [...others].sort(inOrder)) {
          const deed = deedAt.get(other);
          if (!deed || leftAlone(other)) continue;
          any = true;
          if (!staysADirectory(deed)) {
            refuse(other, () => `it is one thing with ${part}, ${which}: it is left as it was`);
          } else if (!heldBack.has(other)) {
            heldBack.set(other, `${part}, ${which}`);
            // (And what else it is one thing with does not arrive without what it was to allow.)
            toDo.push([other, "which is not given what it was to allow"]);
          }
        }
      }
      return any;
    };
    // A part the run left as it was, and that is not so in the project. (It is told of only if something is
    // held back for it: where the rest is in place already, nothing was left undone.)
    for (const [part, why] of amiss) {
      if (without(part, "which is not as it was in the project")) tell(part, `the run left it as it was, but ${why}: what it is one thing with did not arrive`);
    }
    amiss.clear();
    for (let path; (path = toFollowUp.pop()) !== undefined;) {
      followedUp.add(path);
      const stays = path;
      // The directories it is in, which were to go.
      for (let end = path.lastIndexOf("/"); end !== -1; end = path.lastIndexOf("/", end - 1)) {
        const above = deedAt.get(path.slice(0, end));
        if (above && goesAsADirectory(above)) refuse(above.path, () => `the run removed it, but not all that is in it can go (${stays})`);
      }
      // What was moved to it, or to somewhere under it, has not arrived there.
      for (const to of atOrUnder(arrivals, path)) {
        if (countedOut.has(to)) continue;
        countedOut.add(to);
        for (const from of cameFrom.get(to)!) {
          const left = mayArriveAt.get(from)! - 1;
          mayArriveAt.set(from, left);
          if (left === 0) refuse(from.path, () => `the run moved what was here to ${wentTo(from).join(", ")}, which did not arrive: it is left as it was`);
        }
      }
      // What it, or something under it, is one thing with does not arrive without it.
      for (const part of atOrUnder(parts, path)) without(part, part === path ? "which did not arrive" : `which is under ${path}, which did not arrive`);
    }
  };

  // --- Doing it ---

  /** The deeds, by the directory each is in. */
  const inDir = new Map<string, Deed[]>();
  for (const deed of deeds) {
    const dir = dirname(deed.path);
    let those = inDir.get(dir);
    if (!those) inDir.set(dir, those = []);
    those.push(deed);
  }
  /** What there is to say besides what did not arrive (see above): by the path, what. */
  const besides = new Map<string, string>();
  const tell = (path: string, what: string) => besides.set(path, besides.has(path) ? `${besides.get(path)} — and ${what}` : what);
  /** A place of the real directory, as a path of it. */
  const pathOf = (place: string) => relative(real, place).split(sep).join("/") || ITSELF;
  const leftover = (path: string, failed: unknown) => `what was at ${path}, and was to go, is here: the system would not have it all removed (${messageOf(failed)})`;
  /** Remove what was made beside a place and is not going to be moved in. What will not go is told of. Throws nothing. */
  const discard = (made: string, madeFor: string) => {
    try {
      rmSync(made, { force: true });
    } catch (err) {
      // It is told of if it is there — or cannot be known not to be.
      let there = true;
      try {
        there = lstatSync(made, { throwIfNoEntry: false }) !== undefined;
      } catch (cannot) {
        there = !noSuchPlace(cannot);
      }
      if (there) tell(pathOf(made), `it was made ready for ${madeFor}, and the system would not have it removed (${messageOf(err)})`);
    }
  };
  /** Make a file or a link the run left beside its place, under a name of its own, ready to be moved in. */
  const beside = (path: string, want: Entry, place: string): string => {
    const made = stagedNameFor(place);
    try {
      if (want.kind === "link") {
        symlinkSync(want.text, made);
      } else if (want.kind === "file") {
        copyFileSync(stagedFile(path), made, constants.COPYFILE_EXCL);
        if (modeAt(made) !== want.mode) chmodSync(made, want.mode);
      }
    } catch (err) {
      discard(made, path);
      throw err;
    }
    return made;
  };
  /** What has been made beside its place and is yet to be moved in. */
  const ready = new Map<string, string>();
  /**
   * What was at a place and has been moved aside, under a name of its own
   * beside it, for what the run left to take the place: by the path, where
   * it is now. It is kept until all that follows from its going is known to
   * have arrived, and comes back if not.
   */
  const aside = new Map<string, string>();
  /** The places where this merge has put something in the place of what was there, or of nothing. */
  const put = new Set<string>();
  /** What this merge has put where nothing was: by what it is, the path. */
  const putAnew = new Map<string, string>();
  /** The directories that are not, now, where their path says: by the path, where they are — or were last, if they have gone since. */
  const elsewhere = new Map<string, string>();
  const setAside = ({ path, place, there }: Deed): string => {
    const kept = stagedNameFor(place);
    renameSync(place, kept);
    if (there?.kind === "dir") elsewhere.set(path, kept);
    return kept;
  };
  /**
   * Remove from a directory what the run removed from it — all it held when
   * that was looked at; more than that is not removed — and say what the
   * system would not have removed, if anything. What will go, goes, whatever
   * would not go before it.
   */
  const emptied = (dir: string, at: string): unknown => {
    let failed: unknown;
    for (const inIt of inDir.get(dir) ?? []) {
      if (!inIt.there || aside.has(inIt.path)) continue; // (what was moved aside to go has gone, or is told of where it is)
      const its = join(at, basename(inIt.path));
      try {
        if (inIt.there.kind === "dir") {
          const inThat = emptied(inIt.path, its);
          failed ??= inThat;
          rmdirSync(its);
        } else {
          unlinkSync(its);
        }
      } catch (err) {
        failed ??= err;
      }
    }
    return failed;
  };
  /** The directories that were to go and have been seen to as one, with all that was under them. */
  const seenTo = new Set<string>();
  /** Remove what the run removed from a directory, and the directory, where it is. Says what the system would not have removed, if anything. */
  const removed = (deed: Deed, at: string): unknown => {
    seenTo.add(deed.path);
    let failed = emptied(deed.path, at);
    try {
      rmdirSync(at);
    } catch (err) {
      failed ??= err;
    }
    return failed;
  };

  /**
   * The places where what is there stays and takes what the run left into
   * itself: a directory that is to be a directory; or a file the run wrote
   * into — the same file, afterwards, not another put in its place — which
   * may be written into, or holds what the run left already. Anything else
   * that is there is taken the place of. So is a file that is one thing with
   * other paths: what is written into cannot be taken back, should the rest
   * of the thing not arrive, and what is put in a place can.
   */
  const takes = new Set<string>();
  for (const { path, place, want, there } of deeds) {
    if (!want || !there || leftAlone(path)) continue;
    const itself = !partOf.has(path) && want.kind === "file" && there.kind === "file" && idOf(before.get(path)) === idOf(after.get(path))
      && (mayBeWrittenTo(place) || holdsBytes(there, place, want, path));
    if (itself || staysADirectory({ want, there })) takes.add(path);
  }

  /** Do one step of each deed that still stands. What the system will not have done is left alone. */
  const each = (list: Deed[], step: (deed: Deed) => void) => {
    for (const deed of list) {
      if (leftAlone(deed.path)) continue;
      try {
        step(deed);
      } catch (err) {
        refused.set(deed.path, messageOf(err));
      }
    }
  };

  settle();
  // What is to be put where something is, is made first, beside the place: if the system will not have it made,
  // nothing has been touched for its sake. (Also what a file is to take into itself: see below.)
  each(deeds, ({ path, place, want, there }) => {
    if (!there || !want || want.kind === "dir") return;
    if (takes.has(path) && want.kind === "file" && holdsBytes(there, place, want, path)) return;
    ready.set(path, beside(path, want, place));
  });
  settle(); // (so that what follows from what could not be made ready is not first done, and then undone)

  // What the run made, or changed — a directory before what goes in it. What is in the place of it is moved aside.
  each(deeds, (deed) => {
    const { path, place, want, there } = deed;
    if (!want) {
      // What is to go, and is one thing with other paths, is moved aside like what is taken the place of: it
      // comes back if the rest of the thing does not arrive. (Unless it has gone aside already, in its directory.)
      if (there && partOf.has(path) && !underOne(path, elsewhere)) aside.set(path, setAside(deed));
      return;
    }
    const made = ready.get(path);
    if (takes.has(path)) {
      if (want.kind === "dir") {
        // What it allows is what changed: it is opened like any other, and closed to that. (Not one whose thing
        // does not arrive: nothing is done to that for its own sake.)
        if (heldBack.has(path)) return;
        open(path);
        const closing = toClose.get(path);
        if (!closing) throw new Error("it is no longer a directory in the project");
        // Of what is one thing, whether the system will have it changed is to be known now, while the rest can
        // still be taken back — not at the end, when it is closed. (It is changed now as far as leaves it open.)
        if (partOf.has(path)) {
          chmodSync(place, want.mode | 0o700);
          closing.has = want.mode | 0o700;
        }
        closing.mode = want.mode;
        return;
      }
      if (want.kind !== "file") return;
      if (made !== undefined) {
        // It is written into, and stays the file it is. Should the system not have that — and it may have begun,
        // and what the file held be gone — the new file, which is whole beside it, takes its place, and that is
        // told of: it is another file then, and what was another name of the old one is none of this one.
        try {
          copyFileSync(stagedFile(path), place);
        } catch (err) {
          try {
            renameSync(made, place);
          } catch (again) {
            ready.delete(path); // (it is not removed: it is the only whole one there is)
            throw new Error(`${messageOf(err)} — and a new file could not be put in its place either (${messageOf(again)}): what it held may be damaged, and what it was to hold is beside it, as ${basename(made)}`);
          }
          ready.delete(path);
          tell(path, `it could not be written into (${messageOf(err)}): a new file, holding what the run left, was put in its place`);
        }
        if (ready.delete(path)) discard(made, path);
      }
      try {
        if (modeAt(place) !== want.mode) chmodSync(place, want.mode);
      } catch (err) {
        tell(path, `what it is to allow (${want.mode.toString(8)}) could not be set (${messageOf(err)}); what it holds arrived`);
      }
      return;
    }
    if (there) aside.set(path, setAside(deed));
    try {
      if (want.kind === "dir") {
        mkdirSync(place);
        put.add(path);
        const closing = { id: identityOf(place), mode: want.mode, has: -1 };
        toClose.set(path, closing);
        chmodSync(place, want.mode | 0o700);
        closing.has = want.mode | 0o700;
      } else if (made !== undefined) {
        renameSync(made, place);
        ready.delete(path);
        put.add(path);
      } else if (want.kind === "link") {
        symlinkSync(want.text, place);
        put.add(path);
      } else if (want.kind === "file") {
        copyFileSync(stagedFile(path), place, constants.COPYFILE_EXCL);
        put.add(path);
        if (modeAt(place) !== want.mode) chmodSync(place, want.mode);
      }
    } catch (err) {
      // Where nothing was, and something is in the way now that this merge put there itself, under another path:
      // the real directory takes the two names for one. That could not be seen while neither was there. Neither
      // is put there — the other is taken back, with what follows from that.
      if (!there && !put.has(path)) {
        let other: string | undefined;
        try {
          other = putAnew.get(identityOf(place) ?? "");
        } catch {
          // (what cannot be looked at is not known to be that)
        }
        if (other !== undefined) {
          refused.set(other, `the run left ${path} too, which the project's file system takes for the same name: neither is put there`);
          throw new Error(`the run left ${other} too, which the project's file system takes for the same name: neither is put there`);
        }
      }
      throw err;
    }
    if (!there) {
      const what = identityOf(place);
      if (what !== undefined) putAnew.set(what, path);
    }
  });
  settle();

  // What was moved aside: where what took its place stands, it goes; where that did not stand after all — the
  // system would not have it put there, or what was moved from there did not arrive where the run moved it — what
  // was put there goes, and it comes back. The deepest first.
  for (const deed of [...deeds].reverse()) {
    const { path, place, want, there } = deed;
    const kept = aside.get(path);
    if (!leftAlone(path)) {
      if (kept === undefined) continue;
      let failed: unknown;
      try {
        if (there?.kind === "dir") failed = removed(deed, kept);
        else unlinkSync(kept);
      } catch (err) {
        failed = err;
      }
      if (failed !== undefined) tell(pathOf(kept), leftover(path, failed));
    } else if (kept !== undefined || put.has(path)) {
      try {
        // Only what this merge put there goes — of a directory, the directory, once what was put in it has gone.
        if (put.has(path)) {
          if (want?.kind === "dir") {
            rmdirSync(place);
            toClose.delete(path); // (it is gone: there is nothing of it to close)
          } else {
            unlinkSync(place);
          }
        }
        if (kept !== undefined) {
          renameSync(kept, place);
          elsewhere.delete(path);
        }
      } catch (err) {
        const where = kept === undefined ? "" : `: what was there is beside it, as ${basename(kept)}`;
        refused.set(path, `${refused.get(path) ?? "it is in what did not arrive"} — and it could not be put back as it was (${messageOf(err)})${where}`);
      }
    }
  }

  // And what the run removed, where it is: nothing waits for it any more, and nothing is to take its place. Of a
  // directory the system will not have removed, or not with all that was in it, what is left is there — as it
  // would be had the run removed it there.
  each(deeds, (deed) => {
    const { path, place, want, there } = deed;
    if (want || !there || aside.has(path) || underOne(path, seenTo)) return;
    if (there.kind !== "dir") return void unlinkSync(place);
    const failed = removed(deed, place);
    if (failed !== undefined) tell(path, `the run removed it, and the system would not have it removed, or not all that was in it (${messageOf(failed)}): what is left is there`);
  });

  // What was made ready and never moved in is not left lying there.
  for (const [path, made] of ready) discard(made, path);
  // What a directory was to be left allowing, of a thing that did not arrive, does not arrive: it is closed to
  // what it allowed.
  for (const [path, what] of heldBack) {
    const { want, there } = deedAt.get(path)!;
    if (leftAlone(path) || want?.kind !== "dir" || there?.kind !== "dir") continue;
    const closing = toClose.get(path);
    if (closing) closing.mode = there.mode;
    tell(path, `what it was to allow (${want.mode.toString(8)}) is one thing with ${what}: it is left allowing what it allowed`);
  }
  // The directories that this merge has allowing something else than they are to be left allowing are closed — the
  // deepest first, each where it is now, and only if it is that directory: at the place of one that is gone there
  // may be something else by now.
  const placeNow = (path: string): string => {
    for (let end = path.length; end !== -1; end = path.lastIndexOf("/", end - 1)) {
      const moved = elsewhere.get(path.slice(0, end));
      if (moved !== undefined) return moved + path.slice(end);
    }
    return join(real, path);
  };
  for (const [path, { id, mode, has }] of [...toClose].sort(([a], [b]) => inOrder(b, a))) {
    if (has === mode) continue;
    const place = placeNow(path);
    try {
      if (id === undefined || identityOf(place) !== id) continue;
    } catch (err) {
      // Where there is no such place there is nothing to close. Where it cannot be come to, it may be there, open.
      if (!gone(err) && (err as NodeJS.ErrnoException).code !== "ENOTDIR") {
        tell(pathOf(place), `it was opened, and cannot be come to to be given back what it is to allow (${mode.toString(8)}): ${messageOf(err)}`);
      }
      continue;
    }
    try {
      if (modeAt(place) !== mode) chmodSync(place, mode);
    } catch (err) {
      // What it was to be left allowing did not arrive, or could not be put back. What is in it is another matter.
      const why = `what it is to allow (${mode.toString(8)}) could not be set (${messageOf(err)})`;
      const at = pathOf(place);
      if (refused.has(at)) refused.set(at, `${refused.get(at)} — and ${why}`);
      else tell(at, `${why}; what is in it is told of by itself, if it did not arrive`);
    }
  }
  // What is told: what did not arrive, and what there is to say besides. (Every path that was left alone by
  // itself, with its reason: where two of them are a directory and a path in it, each is the other's reason
  // as often as not, and neither is left out for the other.)
  return [...refused, ...besides].map(([path, why]) => ({ path, why }));
}

/** Where, in a list in order, the first entry is that does not come before a given one. */
function firstNotBefore(list: string[], given: string): number {
  let low = 0;
  for (let high = list.length; low < high;) {
    const middle = (low + high) >> 1;
    if (list[middle] < given) low = middle + 1;
    else high = middle;
  }
  return low;
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
