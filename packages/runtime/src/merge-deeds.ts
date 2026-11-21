// What a merge is to do, found out before anything is done (see merge.ts).
//
// It is apart because it only looks. Of the real directory it asks what is
// there, and opens a directory to ask; it makes nothing, moves nothing and
// removes nothing. What it comes to is the deeds — each a place, what is
// there, and what is to be there — and, for what cannot be done, why: which
// is told, and is all that is done about it. What it has to remember while it
// looks — the directories still to be made, the ways and the names asked
// after — is its own, and is gone when it is done.

import { basename, dirname, join } from "path";
import { identityOf } from "./path-guard.js";
import { messageOf } from "./errors.js";
import { ITSELF, entryAt, inOrder, namesIn, noSuchPlace, same, type Entry } from "./tree.js";
import type { Changes, Given, Left, Opened, Told } from "./merge-shared.js";

/** One thing to do: at a place holding `there`, to have `want` (nothing, for what the run removed). */
export interface Deed { path: string; place: string; want: Entry | undefined; there: Entry | undefined }
/** Whether a deed is at a directory that is to be a directory: what it allows is all that changes there. */
export const staysADirectory = ({ want, there }: Pick<Deed, "want" | "there">) => want?.kind === "dir" && there?.kind === "dir";
/** Whether a deed is at a directory that is to go — removed, or with something else in its place. */
export const goesAsADirectory = ({ want, there }: Pick<Deed, "want" | "there">) => there?.kind === "dir" && want?.kind !== "dir";

/**
 * The deeds of a merge, a path before every path under it — and, of the parts
 * of things the run left as they were, those that are not so in the project
 * (`amiss`: by the path, why). What cannot be done is told as refused.
 */
export function deedsOf(
  { real, before, after, seed }: Pick<Given, "real" | "before" | "after" | "seed">,
  { changed, isChanged, parts }: Pick<Changes, "changed" | "isChanged" | "parts">,
  { refused, leftAlone }: Pick<Told, "refused" | "leftAlone">,
  { wanted, holds }: Pick<Left, "wanted" | "holds">,
  { open }: Pick<Opened, "open">,
): { deeds: Deed[]; amiss: Map<string, string> } {
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
  return { deeds, amiss };
}
