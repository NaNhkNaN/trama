import { lstatSync, readlinkSync } from "fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "path";

/**
 * Keep file access inside a bounded root directory (a project directory or a
 * session workspace) — rejecting escapes via ".." segments or symlinks.
 *
 * Not a security sandbox — just a footgun guard against malicious shared
 * projects where files like state.json or .gitignore are symlinks pointing
 * outside the project directory.
 */

/** True if `path` is `root` itself or lies underneath it. Both must already be normalized. */
export function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

/**
 * Resolve `relativePath` against `rootDir` and verify the logical path
 * stays within the root. Returns the resolved absolute path.
 * Catches ".." traversal only — use guardPath to also catch symlink escapes.
 */
export function resolveBounded(rootDir: string, relativePath: string): string {
  const normalizedDir = resolve(rootDir);
  const resolved = resolve(normalizedDir, relativePath);
  if (!isInside(resolved, normalizedDir)) {
    throw new Error(`Path escapes project directory: ${relativePath}`);
  }
  return resolved;
}

/** The most links followed on the way to one path. More than this is a loop. */
const MAX_LINKS = 40;

const stepsOf = (path: string) => path.split(sep).filter(Boolean);

/** What a link says, as text — refused if the text is not what the link holds (a name that is not valid UTF-8). */
function readLink(link: string): string {
  const raw = readlinkSync(link, "buffer");
  const text = raw.toString("utf-8");
  if (!Buffer.from(text, "utf-8").equals(raw)) {
    throw new Error(`Path escapes project directory via symlink: ${link} (its target is not readable as text)`);
  }
  return text;
}

/**
 * Where an absolute, normalized path leads once every symlink on the way is
 * followed — step by step, the way the system itself walks a path. So a ".."
 * in what a link says is taken from where the walk has got to, which after
 * another link is not where the text of the path would suggest.
 *
 * Like realpath, but through what does not exist yet: a link whose
 * destination is missing is still followed to where it points — and from
 * there on, if that is a link too — and once nothing is there, the rest is
 * taken as it is named. This is where a write to the path lands, and where a
 * mkdir on the way to it creates directories.
 */
export function destinationOf(path: string): string {
  let at = parse(path).root;     // always free of links
  let steps = stepsOf(path.slice(at.length));
  let links = 0;
  let missing = false;           // nothing is there from here on, so nothing is a link either
  while (steps.length > 0) {
    const step = steps.shift()!;
    if (step === ".") continue;
    if (step === "..") {
      // Up from something that is not there leads nowhere the system would go.
      if (missing) throw new Error(`Path escapes project directory via symlink: ${path} (it leads up from what does not exist)`);
      at = dirname(at);
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
  return at;
}

/** The real (symlink-resolved) location of a root directory, whether or not it exists yet. */
export function realRootOf(rootDir: string): string {
  return destinationOf(resolve(rootDir));
}

/** A path under a root, as it is named and as where it leads — refused if either is outside the root. */
function guarded(rootDir: string, relativePath: string): { resolved: string; destination: string } {
  const resolved = resolveBounded(rootDir, relativePath);
  const destination = destinationOf(resolved);
  if (!isInside(destination, realRootOf(rootDir))) {
    throw new Error(`Path escapes project directory via symlink: ${relativePath}`);
  }
  return { resolved, destination };
}

/**
 * The guard for reading or writing a path under a bounded root.
 * Checks both the logical path (".." segments) and where symlinks lead —
 * every link on the way, whether or not its destination exists — and returns
 * the resolved absolute path.
 *
 * A path that does not exist yet is checked as far as it does, so a caller can
 * safely mkdir and write afterwards.
 */
export function guardPath(rootDir: string, relativePath: string): string {
  return guarded(rootDir, relativePath).resolved;
}

/**
 * Like `guardPath`, but returns where the path leads rather than the path
 * itself — for a write that replaces its target (temp file and rename), which
 * must replace what the links point at, not a link on the way.
 */
export function guardWriteTarget(rootDir: string, relativePath: string): string {
  return guarded(rootDir, relativePath).destination;
}
