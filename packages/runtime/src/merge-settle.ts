// What follows, in a merge, from what does not arrive (see merge.ts).
//
// It is apart because it touches nothing: it asks nothing of either
// directory, and all it does is say of more paths that they are left alone
// (or, of a directory that stays one, that what it was to allow is held
// back). It is asked again whenever the doing has been refused something, and
// goes on from where it was: what it has followed up and counted out is its
// own, and is kept between one asking and the next.

import { addTo, idOf, inOrder } from "./tree.js";
import type { Changes, Given, Told } from "./merge-shared.js";
import { goesAsADirectory, staysADirectory, type Deed } from "./merge-deeds.js";

/**
 * The following up of a merge: `settle`, which is called whenever something
 * may have been refused since it was last; the directories whose thing did
 * not arrive (`heldBack`); and the deeds, by the path.
 */
export interface Settling { settle(): void; heldBack: Map<string, string>; deedAt: Map<string, Deed> }

/** The following up of some deeds. Nothing is followed up until `settle` is called. */
export function followingUp(
  deeds: Deed[],
  amiss: Map<string, string>,
  { before, after }: Pick<Given, "before" | "after">,
  { partOf, parts }: Pick<Changes, "partOf" | "parts">,
  { refused, leftAlone, tell }: Pick<Told, "refused" | "leftAlone" | "tell">,
): Settling {
  /** Where each file, directory and link is, as the run left things. */
  const nowAt = new Map<string, string[]>();
  for (const [path, is] of after) {
    const id = idOf(is);
    if (id !== undefined) addTo(nowAt, id, path);
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
    for (const to of all) addTo(cameFrom, to, deed);
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
  return { settle, heldBack, deedAt };
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
