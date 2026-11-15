import { lstatSync, mkdirSync, readlinkSync, statSync, type BigIntStats } from "fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "path";

/**
 * Keep file access inside a bounded root directory (a project directory or a
 * session workspace) — rejecting escapes via ".." segments or symlinks.
 *
 * A path is read the way the system reads it: one step at a time, each link
 * followed where it stands, ".." taken from where the walk has got to. It is
 * never tidied up as text first — "dir/../file" is "file" only if "dir" is a
 * directory that is not a link, and the text cannot know.
 *
 * Not a security sandbox — just a footgun guard against malicious shared
 * projects where files like state.json or .gitignore are symlinks pointing
 * outside the project directory.
 */

/**
 * The most links followed on the way to one path. More than this is a loop —
 * to the strictest of the systems this runs on (macOS stops at 32, Linux at 40).
 */
const MAX_LINKS = 32;
const tooManyLinks = (path: string) => new Error(`Too many levels of symbolic links: ${path}`);

/**
 * A step that is not a name: what the walk has come to must be a directory.
 * A path says so by ending in a slash. (It is not the same as a last step of
 * ".", which is looked up in the directory and so needs leave to search it.)
 */
const A_DIRECTORY = sep;

/** The steps of a path, one name at a time. */
function stepsOf(path: string): string[] {
  const steps = path.split(sep).filter(Boolean);
  if (steps.length > 0 && path.endsWith(sep)) steps.push(A_DIRECTORY);
  return steps;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * A byte buffer as UTF-8 text — undefined if its bytes are not valid UTF-8.
 * Leading BOM bytes are preserved as text rather than stripped.
 */
export function utf8Text(raw: Buffer): string | undefined {
  try {
    return UTF8.decode(raw);
  } catch {
    return undefined;
  }
}

/**
 * What a link says, as text — undefined if it says nothing a path can be made
 * of: a name that is not valid UTF-8, or nothing at all (macOS lets a link to
 * nothing be made, and then refuses every use of it).
 */
export function linkText(link: string): string | undefined {
  const text = utf8Text(readlinkSync(link, "buffer"));
  return text !== "" ? text : undefined;
}

/** How far a walk has got: where it is, how many links it has followed, and whether anything is there. */
interface Place {
  /** Always free of links. */
  at: string;
  links: number;
  /** Nothing is there from here on — so nothing is a link either. */
  missing: boolean;
}

/** The top of the file system an absolute path starts from: where every walk begins. */
const topOf = (path: string): Place => ({ at: parse(path).root, links: 0, missing: false });

/** What a walk lets its caller see and say on the way: see `follow`. */
interface Watch {
  passing?(at: string, ahead: readonly string[]): string | undefined;
  link?(link: string, last: boolean): Place | undefined;
}

/**
 * Where a path leads once every symlink on the way is followed. The path is
 * taken as it is written, and may say "..", "." or end in a slash. One that
 * starts at the top of the file system is walked from there; any other, on
 * from `from` — so a path with no steps at all leads to where it started.
 *
 * Like realpath, but through what does not exist yet: a link whose
 * destination is missing is still followed to where it points — and from
 * there on, if that is a link too — and once nothing is there, the rest is
 * taken as it is named. This is where a write to the path lands, and where a
 * mkdir on the way to it creates directories.
 *
 * `passing` is told each place the walk comes to, the first and the last
 * among them, with the steps still to be taken from there, and may give the
 * place another name to go on by. `link` is asked about each link the walk
 * comes to — where it is, and whether the path ends there — and may say where
 * the walk is to be instead of following it. (A link so taken counts as one
 * followed, however many it stands for: the count is then only what stops a
 * walk that goes round. Whoever has links taken so, and needs to know whether
 * the system would follow the words, asks the system.)
 */
function follow(path: string, from: Place, watch: Watch = {}): Place {
  const fromTop = isAbsolute(path);
  let { at, links, missing } = fromTop ? topOf(path) : from;
  let steps = stepsOf(fromTop ? path.slice(at.length) : path);
  for (;;) {
    at = watch.passing?.(at, steps) ?? at;
    if (steps.length === 0) break;
    const step = steps.shift()!;
    if (step === "." || step === ".." || step === A_DIRECTORY) {
      // "Here", "up" and "this is a directory" are said of a directory. Of
      // something that is not there they lead nowhere the system would go —
      // it cannot be created as a file and be a directory too. (Of a file
      // they are refused further down, where the file is come to.)
      if (missing) {
        throw new Error(`Path cannot be followed: ${path} (it leads on from what does not exist)`);
      }
      if (step === A_DIRECTORY) continue;
      // Asked of the system rather than assumed: it takes a directory, and leave to search it.
      lstatSync(at + sep + step);
      if (step === "..") at = dirname(at);
      continue;
    }
    const next = join(at, step);
    if (missing) {
      at = next;
      continue;
    }
    let stat;
    try {
      stat = lstatSync(next);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      missing = true;
      at = next;
      continue;
    }
    if (!stat.isSymbolicLink()) {
      // Nothing lies beyond a file — not a name, and not "." or ".." either.
      // The system refuses to go on, and so does this.
      if (!stat.isDirectory() && steps.length > 0) {
        throw Object.assign(new Error(`ENOTDIR: not a directory, ${next} (on the way to ${path})`), { code: "ENOTDIR" });
      }
      at = next;
      continue;
    }
    const instead = watch.link?.(next, steps.length === 0);
    if (instead) {
      if (++links > MAX_LINKS) throw tooManyLinks(path);
      ({ at, missing } = instead);
      // As where a file is come to by a step: nothing lies beyond one.
      if (steps.length > 0 && !missing && !lstatSync(at).isDirectory()) {
        throw Object.assign(new Error(`ENOTDIR: not a directory, ${at} (on the way to ${path})`), { code: "ENOTDIR" });
      }
      continue;
    }
    if (++links > MAX_LINKS) throw tooManyLinks(path);
    const target = linkText(next);
    if (target === undefined) {
      throw new Error(`Path cannot be followed: ${next} (it links to nothing, or to what is not readable as text)`);
    }
    if (isAbsolute(target)) at = parse(target).root;
    steps = [...stepsOf(target), ...steps];
  }
  return { at, links, missing };
}

/**
 * The real (symlink-resolved) location of a root directory, whether or not it
 * exists yet. A root is named by whoever runs the program, not by the
 * program, and is read as the rest of Node reads a directory it is given.
 */
export function realRootOf(rootDir: string): string {
  const root = resolve(rootDir);
  return follow(root, topOf(root)).at;
}

/** Whether one normalized path is another or lies under it — as text, which is all this can say. */
const within = (path: string, root: string) =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

export const identityIn = (stat: BigIntStats) => `${stat.dev}:${stat.ino}`;

/**
 * What tells one file or directory from every other — undefined if nothing is
 * there to be told apart. Two paths with one identity are one place, however
 * each is spelled; a link is itself, not what it points at.
 *
 * This is how the runtime asks whether two paths are the same. Their text
 * cannot say: a file system that takes "Data" and "data" for one name has
 * many names for every directory.
 *
 * Undefined says that nothing is there, and only that. What is there and may
 * not be looked at is not nothing: it throws.
 */
export function identityOf(path: string): string | undefined {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  return stat && identityIn(stat);
}

/**
 * A destination by the root's own name for it, if it is the root or lies
 * under it — undefined if it does not.
 *
 * Under it by name, or by being there: a file system that takes "Data" and
 * "data" for one name has many names for every directory, and a link may use
 * any of them. So where the names do not say, each directory above the
 * destination is asked whether it is the root.
 */
function underRoot(destination: string, realRoot: string): string | undefined {
  if (within(destination, realRoot)) return destination;
  const root = identityOf(realRoot);
  if (!root) return undefined;
  for (let at = destination; ; at = dirname(at)) {
    if (identityOf(at) === root) return join(realRoot, destination.slice(at.length));
    if (at === dirname(at)) return undefined;
  }
}

/** What the words of a link come to, read by one who means to keep a copy of the root they are in. */
export interface Lead {
  /** The place they name. A link of the root that they end at is the place: what it names in turn is its own affair. */
  to: string;
  /**
   * Whether the way there is in the root at one point and out of it at
   * another: it steps out over the root's top, or into it from outside. If it
   * does neither, the same words name the same place in any copy of the
   * root, wherever the copy is.
   */
  strays: boolean;
  /**
   * What the words go on to say once they have come to the root from outside
   * it (see `sinceRoot`) — provided they have not stepped out of it over its
   * top again since. That much is said of the root, and says the same of a
   * copy of it, wherever its links lead. Undefined if they never come to the
   * root so, or step out of it afterwards: such a way, if it strays, ends
   * outside the root.
   */
  home: string | undefined;
}

/**
 * A reader of the links in `root` (named without links), for one who means
 * to keep a copy of the root.
 *
 * It reads as a copy of the root would have to be read. A link of the root
 * that a way passes through is not followed step by step but taken for the
 * place it names: a copy has that link too, saying whatever it must to name
 * the same place there, and how it says so is no part of the way. A link
 * outside the root is nobody's copy, and is followed like any other step —
 * to the end, also where the words end at it: what matters of it is where it
 * leads.
 *
 * Whether a place is in the root is asked of the place (see underRoot), not
 * read off its name: a way that has left the root may come back to it by any
 * of the names the file system has for it.
 */
export function linksOf(root: string): {
  /**
   * Where words lead, for a link that is in `dir`. Throws if the way cannot
   * be followed: then what they name cannot be told, which is not the same
   * as its being outside.
   */
  names(dir: string, text: string): Lead;
  /**
   * What the same words go on to say once they have come to the root from
   * outside it — a slash first, if any more is said — or undefined if they
   * never do. Where they come to it more than once, it is the last time that
   * counts. (Coming to it is a step into it from outside. A link of the root
   * that names the root is a step within it.) Whatever they say from there
   * on, and wherever that leads, it is said of the root: to one who takes a
   * copy for the root itself, it is the copy's name that the words before it
   * come to. Told as far as the way can be followed: one that cannot be
   * followed to its end has still come as far as it has.
   */
  sinceRoot(dir: string, text: string): string | undefined;
} {
  /** What each link of the root that a way has passed through names — null while that is being worked out. */
  const named = new Map<string, Place | null>();
  let depth = 0;
  const nameOf = (link: string): Place => {
    const known = named.get(link);
    if (known) return known;
    // (A link that is being worked out leads back to itself. And one link's words may lead through another's, and
    // those through a third: the system follows so many in one way and no more, and neither is this to go deeper.)
    if (known === null || depth >= MAX_LINKS) throw tooManyLinks(link);
    named.set(link, null);
    depth += 1;
    try {
      const text = linkText(link);
      if (text === undefined) throw new Error(`Path cannot be followed: ${link} (it links to nothing, or to what is not readable as text)`);
      const { place } = lead(dirname(link), text);
      named.set(link, place);
      return place;
    } catch (err) {
      named.delete(link);
      throw err;
    } finally {
      depth -= 1;
    }
  };
  const isLink = (place: Place) => !place.missing && lstatSync(place.at, { throwIfNoEntry: false })?.isSymbolicLink() === true;

  /** What a way has been seen to do, kept up to date as it is walked: it says how far the way came, also of one that then fails. */
  interface Seen { sinceRoot?: string; stayed?: boolean }
  const lead = (dir: string, text: string, seen: Seen = {}): { place: Place; strays: boolean } => {
    let inside = !isAbsolute(text) && underRoot(dir, root) !== undefined;
    let strays = false;
    const place = follow(text, { at: dir, links: 0, missing: false }, {
      passing(at, ahead) {
        const own = underRoot(at, root);
        if ((own !== undefined) !== inside) {
          strays = true;
          // A step into the root arrives at its top, with the rest still to be said.
          seen.stayed = own === root;
          if (own === root) seen.sinceRoot = ahead.length === 0 ? "" : sep + ahead.map((step) => (step === A_DIRECTORY ? "" : step)).join(sep);
        }
        inside = own !== undefined;
        return own;
      },
      link(link, last) {
        if (!within(link, root)) return undefined;
        if (last) return { at: link, links: 0, missing: false };
        let place = nameOf(link);
        for (let hops = 1; within(place.at, root) && isLink(place); hops++) {
          if (hops === MAX_LINKS) throw tooManyLinks(link);
          place = nameOf(place.at);
        }
        inside = within(place.at, root); // arrived by a link of the root, not by a step of this way
        return place;
      },
    });
    return { place, strays };
  };

  return {
    names(dir, text) {
      const seen: Seen = {};
      const { place, strays } = lead(dir, text, seen);
      return { to: place.at, strays, home: seen.stayed ? seen.sinceRoot : undefined };
    },
    sinceRoot(dir, text) {
      const seen: Seen = {};
      try {
        lead(dir, text, seen);
      } catch {
        // The way cannot be followed to its end. How far it came is known all the same, and is all that is asked.
      }
      return seen.sinceRoot;
    },
  };
}

/**
 * The places under a root that make a path lead where it does: every place
 * the way comes to there — each name it steps to, each link it follows, each
 * directory it goes through (also one it leaves again with ".."), and the
 * place it ends at. With any of them another thing, or gone, the path leads
 * somewhere else, or nowhere. Told as far as the way can be followed, each
 * as the way names it — which need not be how its directory lists it.
 */
export function wayTo(rootDir: string, path: string): string[] {
  const root = realRootOf(rootDir);
  const places = new Set<string>();
  const cameTo = (at: string) => {
    const own = underRoot(at, root);
    if (own !== undefined && own !== root) places.add(own);
  };
  try {
    follow(path, { at: root, links: 0, missing: false }, {
      passing(at) { cameTo(at); return undefined; },
      link(link) { cameTo(link); return undefined; },
    });
  } catch {
    // The way cannot be followed to its end. How far it came is all that is known of it.
  }
  return [...places];
}

/**
 * Where a project is — which is a directory that is there. Nothing in the
 * runtime makes one for a project that is gone: what it makes for a project,
 * it makes in it. (Making the directories on the way to a file would make a
 * project of that file, at the path of one that somebody has moved away.)
 */
export function projectAt(projectDir: string): string {
  const project = realRootOf(projectDir);
  if (!statSync(project, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`There is no project at ${project}.`);
  return project;
}

/**
 * A question to ask later: whether what is at a project's path is still the
 * directory that is there now. A project is known by what it is, and what is
 * done over some time — generate a program, ask for a fix, try it, install it,
 * write it down — is done to the project it was started on: not to another
 * directory that somebody has put at the path meanwhile. (Gone is not another:
 * what is to be done where no project is, each step says for itself.)
 */
export function sameProjectAs(projectDir: string): () => void {
  const start = lstatSync(realRootOf(projectDir), { bigint: true, throwIfNoEntry: false });
  const wasId = start?.isDirectory() ? identityIn(start) : undefined;
  return () => {
    const root = realRootOf(projectDir);
    const now = lstatSync(root, { bigint: true, throwIfNoEntry: false });
    if (wasId !== undefined && now && !(now.isDirectory() && identityIn(now) === wasId)) {
      throw new Error(`What is at ${root} is not the project this was started on: nothing more is done there.`);
    }
  };
}

/**
 * Make a directory under a root, with those on the way to it — in the root,
 * which must be there: no root is made for the sake of what goes into it.
 * This is for a root that is something in itself — a project, which
 * somebody may have moved away since it was named: making the directory
 * anew at its path would make another, and put into it what was meant for
 * the first. (A workspace is nothing but its path, and is made as needed,
 * with the way to it.)
 * `dir` is a place the guard has passed.
 */
export function makeDirsIn(rootDir: string, dir: string): void {
  const root = realRootOf(rootDir);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw Object.assign(new Error(`There is no directory at ${root}.`), { code: "ENOENT" });
  }
  mkdirSync(dir, { recursive: true });
}

/**
 * The guard for reading or writing a path under a bounded root: where the
 * path leads, every link on the way followed — refused unless that is inside
 * the root, and a file, a directory, or nothing yet. What comes back has no
 * link left in it, so using it goes where this looked.
 *
 * A path that does not exist yet is followed as far as it does, so a caller
 * can safely mkdir and write afterwards: a write lands on what a link points
 * at, not on a link on the way.
 */
export function guardPath(rootDir: string, path: string): string {
  const root = resolve(rootDir);
  // The root is walked first, and the path on from where that arrives: the
  // way the system reads the two written one after the other.
  const realRoot = follow(root, topOf(root));
  const destination = underRoot(follow(path, realRoot).at, realRoot.at);
  // The same, as the system is asked about it below.
  const given = isAbsolute(path) ? path : root + sep + path;
  if (destination === undefined) {
    // Said for whoever reads the refusal: if the text alone stays inside, it is the links that lead out.
    throw new Error(`Path escapes project directory${within(resolve(given), root) ? " via symlink" : ""}: ${path}`);
  }

  // The walk above is this guard's own reading of the path. The system has
  // the last word on it: where it can follow the path, it must arrive where
  // the walk did, and where it cannot, that must be because nothing is there
  // yet — not because it will not go (too many links, a name too long, no
  // leave to pass), which the walk may not have noticed. A path the two read
  // differently is one a write would put somewhere a read does not look.
  let found: BigIntStats | undefined;
  try {
    found = statSync(given, { bigint: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const there = lstatSync(destination, { bigint: true, throwIfNoEntry: false });
  if (found ? !(there && identityIn(there) === identityIn(found)) : there !== undefined) {
    throw new Error(`Path cannot be followed: ${path} (the system does not take it where its links say)`);
  }
  // What is there is content, or a place for it. A pipe, a socket or a device
  // is the end of something else: reading one, or writing to one, can wait
  // for ever on whoever is at the other end — and with it this whole process.
  if (there && !there.isFile() && !there.isDirectory()) {
    throw new Error(`Not a file or a directory: ${path}`);
  }
  return destination;
}
