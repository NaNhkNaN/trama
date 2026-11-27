// What a directory holds — and the two things done with it: a copy is made
// somewhere else, and what a run did to the copy is carried back.
//
// Both rest on one reading of a tree. It says what is at every path under a
// directory — a file, a directory, a link, or something that is not content —
// or it throws. There is no entry it passes over: what a reading leaves out is
// taken, by whoever compares two readings, to have been removed.
//
// The reading and the copying are here. The carrying back is in merge.ts, and
// is done with what this exports for it.

import {
  chmodSync, closeSync, constants, copyFileSync, lstatSync, mkdirSync, openSync,
  readdirSync, readSync, statSync, symlinkSync, unlinkSync,
} from "fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "path";
import { identityIn, identityOf, linksOf, linkText, realRootOf, utf8Text } from "./path-guard.js";

/**
 * What is at one path. `id` says which file, directory or link it is: it
 * stays the same through being written to, renamed, or given other
 * permissions, and nothing else has it while the thing is there. (It is the
 * system's numbers for it — its device's, and its own on that — and a file
 * system may give a number again once what had it is gone. Two readings of
 * a directory tell such things apart by when each was born: see `toldApart`.)
 * `born` is when the system says the thing came to be — 0 where it does not
 * say — and `changed` when it was last changed, in what it holds or in what
 * it allows.
 */
export type Entry =
  /** `stamp` is different after any change to the file — to what it holds or to what it allows — and cannot be set by a program. */
  | { kind: "file"; mode: number; size: number; stamp: string; id: string; born: bigint; changed: bigint }
  | { kind: "dir"; mode: number; id: string; born: bigint; changed: bigint }
  | { kind: "link"; text: string; id: string; born: bigint; changed: bigint }
  /** A pipe, a socket, a device, a link that says nothing a path can be made of: one end of something else, not content. */
  | { kind: "other" };

/**
 * What a directory is and holds: the directory itself, as ".", and every path
 * under it ("/" between the names) — a directory before what is in it.
 */
export type Tree = Map<string, Entry>;

/** The path of the directory a tree is of. It is in no directory of the tree, and every other path is under it. */
export const ITSELF = ".";
/** The order in which a path comes before every path under it. (As text "." comes after "-x", which is under it.) */
export const inOrder = (a: string, b: string) => (a === b ? 0 : a === ITSELF || (b !== ITSELF && a < b) ? -1 : 1);

const NOT_CONTENT: Entry = { kind: "other" };

/** How often a place that changes while it is looked at is looked at again, before that is what is said of it. */
const LOOKS = 16;

/** What is at a path — the path itself, not what a link there leads to. Undefined if nothing is. */
export function entryAt(path: string): Entry | undefined {
  for (let looked = 1; ; looked += 1) {
    const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!stat) return undefined;
    const mode = Number(stat.mode & 0o7777n);
    const id = identityIn(stat), born = stat.birthtimeNs, changed = stat.ctimeNs;
    if (stat.isFile()) {
      // The time of the last change is the system's own: it moves when the file is written, replaced, or
      // has its permissions changed, and no program can put it back. (The time of the last write can be.)
      return { kind: "file", mode, size: Number(stat.size), stamp: `${id}:${changed}:${stat.size}`, id, born, changed };
    }
    if (stat.isDirectory()) return { kind: "dir", mode, id, born, changed };
    if (!stat.isSymbolicLink()) return NOT_CONTENT;
    let text;
    try {
      text = linkText(path);
    } catch (err) {
      // No link is there any more: the place changed between the two questions, and is asked again — though
      // not for ever, of a place that is a link and none by turns for as long as anybody asks.
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === "ENOENT" || code === "EINVAL") && looked < LOOKS) continue;
      throw err;
    }
    return text === undefined ? NOT_CONTENT : { kind: "link", text, id, born, changed };
  }
}

/** Put one more thing under a key that may have several. */
export function addTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const those = map.get(key);
  if (those) those.push(value);
  else map.set(key, [value]);
}

/** Which file, directory or link an entry is — undefined of what is none. */
export const idOf = (entry: Entry | undefined) => (entry === undefined || entry.kind === "other" ? undefined : entry.id);

/**
 * Whether two entries are the same thing, unchanged. Nothing is the same as
 * nothing. A directory is the same if it allows the same — what it holds is
 * other paths. What is not content is never taken for the same: nothing is
 * known of it that could be compared.
 */
export function same(a: Entry | undefined, b: Entry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind === "file" && b.kind === "file") return a.stamp === b.stamp;
  if (a.kind === "dir" && b.kind === "dir") return a.mode === b.mode;
  if (a.kind === "link" && b.kind === "link") return a.text === b.text;
  return false;
}

/**
 * Which thing something is, as whoever names it to the reader of a directory
 * says it — of a look of their own at it, between two readings: its number,
 * and when it was born (see `toldApart`).
 */
export interface Thing { id: string; born: bigint }

/** An entry as the thing it is — undefined of what is none. */
export const thingOf = (entry: Entry | undefined): Thing | undefined => (entry === undefined || entry.kind === "other" ? undefined : { id: entry.id, born: entry.born });

/**
 * The second of two readings of one directory, with what has a number of
 * the first's and is another thing than had it there told apart from that:
 * under an id of its own.
 *
 * A file system may give a number again as soon as what had it is gone
 * (ext4 does: to what is made next). By its number, what a run made after
 * it removed something is then the thing it removed — moved, to whoever
 * compares the readings, and a part of whatever that was a part of. It is
 * not that thing if it was born after it: a thing is born once.
 *
 * Only a later birth says so. An earlier one does not: there are systems
 * where a thing's birth is moved back (macOS, where its time of writing is
 * set to before it), and none was found where it moves on. And a birth is
 * gone by only where the readings show that the system tells a birth from a
 * change: where something in them was changed at another time than it was
 * born. Where nothing was, it may be the time of the last change that is
 * given for a birth (as Node gives it on Linux where the call that says
 * births is refused) — by which all that a run wrote to would be another
 * thing than it was. And where a run removed something, the directory that
 * was in was changed after it was born: a system that tells the two shows
 * it there. Without that, the reading is as it was read, by numbers. (So
 * it is where the system says nothing of births: each is 0, and none later
 * than another.)
 *
 * `idOf` is the id, in the two readings, of a thing as somebody names it
 * who looked at it in between (see Thing): of what the first reading had,
 * of what the second has — or undefined, of what is in neither: it came
 * and went between them, its number given on.
 */
export function toldApart(before: Tree, after: Tree): { after: Tree; idOf(thing: Thing): string | undefined } {
  const births = [...before.values(), ...after.values()].some((entry) => entry.kind !== "other" && entry.born !== entry.changed);
  /** When what has each number in a reading was born. (A file with several names is one thing, born once.) */
  const bornIn = (tree: Tree) => {
    const born = new Map<string, bigint>();
    for (const entry of tree.values()) if (entry.kind !== "other") born.set(entry.id, entry.born);
    return born;
  };
  const was = bornIn(before), is = bornIn(after);
  const another = (id: string) => {
    const then = was.get(id), now = is.get(id);
    return births && then !== undefined && now !== undefined && now > then;
  };
  const anew = (id: string) => `${id}, born ${is.get(id)}`;
  const apart: Tree = new Map();
  for (const [path, entry] of after) apart.set(path, entry.kind !== "other" && another(entry.id) ? { ...entry, id: anew(entry.id) } : entry);
  return {
    after: apart,
    idOf: ({ id, born }) => {
      const then = was.get(id), now = is.get(id);
      if (!births || (then !== undefined && born <= then)) return id;
      if (now !== undefined && now <= born) return another(id) ? anew(id) : id;
      return undefined;
    },
  };
}

/** The paths at which two readings of a directory differ, a path before every path under it. */
export function differences(before: Tree, after: Tree): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter((path) => !same(before.get(path), after.get(path))).sort(inOrder);
}

/** The names in a directory. One that is not text cannot be told from another, or looked up again: it throws. */
export function namesIn(dir: string): string[] {
  return readdirSync(dir, "buffer").map((raw) => {
    const name = utf8Text(raw);
    if (name === undefined) throw new Error(`${dir} holds a name that is not readable as text`);
    return name;
  });
}

export const gone = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";
/** Whether a refusal says that there is no such place: nothing is there, or the system takes no such name. */
export const noSuchPlace = (err: unknown) => ["ENOENT", "ENOTDIR", "ENAMETOOLONG"].includes((err as NodeJS.ErrnoException).code ?? "");

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
export function walk(root: string, visit: (path: string, entry: Entry, at: string) => boolean | void): void {
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
export function sameBytes(one: string, other: string): boolean {
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

/**
 * What a directory is and holds. The directory must be there, and all of it
 * readable — or, with `opening`, to be made so: a directory that may not be
 * looked into is opened for the reading, and left allowing what it allowed.
 * (That is for a directory that is the reader's own to open: a copy.)
 */
export function readTree(dir: string, opening = false): Tree {
  const tree: Tree = new Map();
  const opened: Array<{ at: string; mode: number }> = [];
  try {
    walk(realRootOf(dir), (path, entry, at) => {
      tree.set(path, entry);
      if (opening && entry.kind === "dir" && (entry.mode & 0o500) !== 0o500) {
        chmodSync(at, entry.mode | 0o500);
        opened.push({ at, mode: entry.mode });
      }
    });
  } finally {
    for (const { at, mode } of opened.reverse()) chmodSync(at, mode);
  }
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
  const copiedIs = (id: string, path: string) => addTo(copiedAs, id, path);
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
