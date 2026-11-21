// The deeds of a merge, done (see merge.ts).
//
// It is apart because it is the part that writes: whatever a merge makes,
// moves or removes in the real directory is made, moved or removed here, and
// the order in which that is done is here in one piece. What it has to
// remember of what it has done so far — what was made ready, moved aside,
// put, and where a directory is by now — is its own. It decides nothing of
// what is to be done, and follows nothing up: after each round it asks that
// what was refused in it be followed up, and goes by what is then left alone.

import {
  accessSync, chmodSync, constants, copyFileSync, lstatSync, mkdirSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync,
} from "fs";
import { basename, dirname, join, relative, sep } from "path";
import { identityOf } from "./path-guard.js";
import { stagedNameFor } from "./replace-file.js";
import { messageOf } from "./errors.js";
import { ITSELF, addTo, gone, idOf, inOrder, noSuchPlace, type Entry } from "./tree.js";
import type { Changes, Given, Left, Opened, Told } from "./merge-shared.js";
import { staysADirectory, type Deed } from "./merge-deeds.js";
import type { Settling } from "./merge-settle.js";

/**
 * Do the deeds of a merge, as far as the system will have them done. What it
 * will not have done is told as refused, with what follows from that; what
 * there is to say besides is told as that. Throws nothing.
 */
export function carryOut(
  deeds: Deed[],
  { real, before, after }: Pick<Given, "real" | "before" | "after">,
  { partOf }: Pick<Changes, "partOf">,
  { refused, leftAlone, underOne, tell }: Pick<Told, "refused" | "leftAlone" | "underOne" | "tell">,
  { stagedFile, holdsBytes }: Pick<Left, "stagedFile" | "holdsBytes">,
  { open, toClose }: Opened,
  { settle, heldBack, deedAt }: Settling,
): void {
  /** The deeds, by the directory each is in. */
  const inDir = new Map<string, Deed[]>();
  for (const deed of deeds) addTo(inDir, dirname(deed.path), deed);
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
