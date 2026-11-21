// What a merge is given, and what its parts have between them (see merge.ts).
//
// The parts are the finding out, the following up and the doing. Each has
// much that is its own, and that is kept in it. What more than one of them
// needs is here, and it is four things: what the run changed, which is asked
// of the two readings of the copy and of nothing else; what is told of the
// merge, which every part adds to; what the run left, as it is to be in the
// real directory; and the directories of the real one that are opened. Each
// is made once, by mergeTree, and given to the parts that need it.

import { chmodSync } from "fs";
import { dirname, join } from "path";
import { linksOf } from "./path-guard.js";
import { ITSELF, addTo, entryAt, idOf, inOrder, same, sameBytes, type Entry, type Tree } from "./tree.js";

/**
 * What a merge is given: the copy and the real directory, each by its own
 * path; the copy as it was before the run and as the run left it; and the
 * real directory as it was when the copy was made.
 */
export interface Given { copy: string; real: string; before: Tree; after: Tree; seed: Tree }

/**
 * What the run changed: the paths, in order and as a set; and what is one
 * thing to the caller, by each path that is a part of such a thing — with
 * those paths, in order.
 */
export interface Changes { changed: string[]; isChanged: Set<string>; partOf: Map<string, string[][]>; parts: string[] }

/** What the run changed, of the copy as it was and as the run left it. It looks at nothing but the two readings. */
export function changesOf(before: Tree, after: Tree, together: string[][]): Changes {
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
      for (const part of paths) addTo(partOf, part, paths);
    }
  }
  const parts = [...partOf.keys()].sort();
  return { changed, isChanged, partOf, parts };
}

/**
 * What is told of a merge: what did not arrive, and what there is to say
 * besides. What did not arrive is what the parts go by, too: nothing is done
 * at a path that is left alone.
 */
export interface Told {
  refused: Map<string, string>;
  besides: Map<string, string>;
  tell(path: string, what: string): void;
  leftAlone(path: string): boolean;
  underOne(path: string, of: { has(path: string): boolean }): boolean;
}

/** What is told of a merge, with nothing told yet. */
export function telling(): Told {
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
  /** What there is to say besides what did not arrive (see above): by the path, what. */
  const besides = new Map<string, string>();
  const tell = (path: string, what: string) => besides.set(path, besides.has(path) ? `${besides.get(path)} — and ${what}` : what);
  return { refused, besides, tell, leftAlone, underOne };
}

/** What the run left, as the real directory is to have it — and whether a place has it already. */
export interface Left {
  stagedFile(path: string): string;
  wanted(path: string, is: Entry): Entry;
  holdsBytes(there: Entry, place: string, want: Entry & { kind: "file" }, path: string): boolean;
  holds(there: Entry | undefined, place: string, want: Entry, path: string): boolean;
}

/** What the run left in a copy. (A file of the copy that may not be read is made readable when it is asked for.) */
export function leftBy({ copy, real, after }: Pick<Given, "copy" | "real" | "after">): Left {
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
  return { stagedFile, wanted, holdsBytes, holds };
}

/** The directories of the real one that a merge opens, and what each is to be left allowing. */
export interface Opened {
  open(dir: string): void;
  toClose: Map<string, { id: string | undefined; mode: number; has: number }>;
}

/** The directories of a real directory that are opened, with none opened yet. */
export function opening(real: string): Opened {
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
      const closing = { id: there.id, mode: there.mode, has: there.mode };
      toClose.set(dir, closing);
      if ((there.mode | 0o700) !== there.mode) {
        chmodSync(place, there.mode | 0o700);
        closing.has = there.mode | 0o700;
      }
    } // (if it is no directory, what is done in it will say so)
    opened.add(dir); // only now: if it could not be opened, the next to need it open is told so too
  };
  return { open, toClose };
}
