import { lstatSync, readlinkSync, statSync, type BigIntStats } from "fs";
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

/** What a link says, as text — refused if the text is not what the link holds (a name that is not valid UTF-8). */
function readLink(link: string): string {
  const raw = readlinkSync(link, "buffer");
  const text = raw.toString("utf-8");
  if (!Buffer.from(text, "utf-8").equals(raw)) {
    throw new Error(`Path cannot be followed: ${link} (what it links to is not readable as text)`);
  }
  // macOS lets a link to nothing be made, and then refuses every use of it.
  if (text === "") throw new Error(`Path cannot be followed: ${link} (it links to nothing)`);
  return text;
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
 */
function follow(path: string, from: Place): Place {
  const fromTop = isAbsolute(path);
  let { at, links, missing } = fromTop ? topOf(path) : from;
  let steps = stepsOf(fromTop ? path.slice(at.length) : path);
  while (steps.length > 0) {
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
    if (++links > MAX_LINKS) throw new Error(`Too many levels of symbolic links: ${path}`);
    const target = readLink(next);
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

const identityIn = (stat: BigIntStats) => `${stat.dev}:${stat.ino}`;

/**
 * What tells one file or directory from every other — undefined if nothing is
 * there to be told apart. Two paths with one identity are one place, however
 * each is spelled; a link is itself, not what it points at.
 *
 * This is how the runtime asks whether two paths are the same. Their text
 * cannot say: a file system that takes "Data" and "data" for one name has
 * many names for every directory.
 */
export function identityOf(path: string): string | undefined {
  try {
    const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    return stat && identityIn(stat);
  } catch {
    return undefined;
  }
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
