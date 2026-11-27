// What a run did to a copy of a directory, carried back into the directory.
//
// It is apart from the reading and the copying (tree.ts) because it is long,
// and it is in parts because it is done in parts, each of which can be read
// without the others. What a merge is given, and what its parts have between
// them, is merge-shared.ts: what the run changed, what is told of it, what
// the run left, and the directories opened. With those, what is to be done is
// found out before anything is (merge-deeds.ts: it looks, and opens a
// directory to look; no more); what follows from what does not arrive is
// followed up (merge-settle.ts: it touches nothing); and it is done
// (merge-doing.ts: all that is made, moved or removed in the real directory
// is there). Here is what all of it comes to, and the order of it.

import { chmodSync } from "fs";
import { realRootOf } from "./path-guard.js";
import { messageOf } from "./errors.js";
import { ITSELF, entryAt, toldApart, walk, type Thing, type Tree } from "./tree.js";
import { changesOf, leftBy, opening, telling, type Given } from "./merge-shared.js";
import { deedsOf } from "./merge-deeds.js";
import { followingUp } from "./merge-settle.js";
import { carryOut } from "./merge-doing.js";

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
 *   files, links and directories (each as what it is: see Thing) that are one
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
 * see Entry — and what the run made is not taken for what it removed, where
 * the file system gave it that one's number: see `toldApart`. What the run
 * copied and then removed is a new file, and is not known to be the old
 * one's.) And what the caller says is one thing — a
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
export function mergeTree(stagedDir: string, realDir: string, before: Tree, seed: Tree, together: Thing[][] = []): Unmerged[] {
  let copy: string;
  let real: string;
  const read: Tree = new Map();
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
      read.set(path, entry); // as the run left it
      if (entry.kind === "dir" && (entry.mode & 0o500) !== 0o500) chmodSync(at, entry.mode | 0o500);
    });
  } catch (err) {
    // What the run left cannot be told. Nothing is merged — least of all as a removal of what cannot be seen.
    return [{ path: ITSELF, why: `what the run left could not be read (${messageOf(err)}); none of it was merged` }];
  }
  // What the run left, with what it made told from what it removed where the two have one number — in the
  // reading, and in what the caller names: everything below goes by the ids of that.
  const { after, idOf } = toldApart(before, read);
  const given: Given = { copy, real, before, after, seed };
  const changes = changesOf(before, after, together.map((things) => things.flatMap((thing) => idOf(thing) ?? [])));
  const told = telling();
  const left = leftBy(given);
  const doors = opening(real);

  // --- What is to be done, found out before anything is ---

  const { deeds, amiss } = deedsOf(given, changes, told, left, doors);
  const settling = followingUp(deeds, amiss, given, changes, told);

  // --- Doing it ---

  carryOut(deeds, given, changes, told, left, doors, settling);
  const { refused, besides } = told;
  // What is told: what did not arrive, and what there is to say besides. (Every path that was left alone by
  // itself, with its reason: where two of them are a directory and a path in it, each is the other's reason
  // as often as not, and neither is left out for the other.)
  return [...refused, ...besides].map(([path, why]) => ({ path, why }));
}
