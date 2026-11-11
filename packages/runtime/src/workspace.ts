import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, readlinkSync,
  realpathSync, lstatSync, statSync, renameSync, fdatasyncSync,
  openSync, closeSync,
} from "fs";
import { resolve, dirname, relative, sep } from "path";
import type { Workspace } from "./types.js";
import { guardPath, isInside, realRootOf, resolveBounded } from "./path-guard.js";

const OBSERVE_POLL_MS = 250;

/**
 * Match a simple glob pattern against a relative path.
 * Supports `*` (any segment chars), `?` (single char), and `**` (any path segments).
 * `** /` matches zero or more directory segments (including root).
 */
function matchGlob(pattern: string, filePath: string): boolean {
  // Replace ** with placeholders before escaping
  let regex = pattern
    .replace(/\*\*\//g, "\x00GLOBSTARSLASH\x00")
    .replace(/\*\*/g, "\x00GLOBSTAR\x00");
  // Escape regex special chars except * and ?
  regex = regex
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  // Restore placeholders
  regex = regex
    .replace(/\x00GLOBSTARSLASH\x00/g, "(?:.+/)?")
    .replace(/\x00GLOBSTAR\x00/g, ".*");
  return new RegExp(`^${regex}$`).test(filePath);
}

/**
 * A pattern with no glob operators names exactly one artifact.
 * Only `*` and `?` are operators here — `[ ] { }` are literal filename characters.
 */
function isExactPath(pattern: string): boolean {
  return !/[*?]/.test(pattern);
}

/**
 * Recursively list all files under a directory, as forward-slash paths relative to root.
 * Includes symlinks to files and follows symlinked directories, but only if
 * they resolve inside the bounded root (prevents symlink escapes).
 *
 * Cycle detection: only symlinked directories are tracked in the `visited` set
 * (by their resolved realpath). Regular directories cannot create cycles on their
 * own, so they are traversed unconditionally. This allows legitimate directory
 * aliases (symlink pointing to another dir in the workspace) to produce their
 * own workspace-relative paths alongside the original directory's paths.
 */
function listFilesRecursive(dir: string, root: string, realRoot: string, visited = new Set<string>()): string[] {
  const results: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  const addFile = (full: string) => results.push(relative(root, full).split(sep).join("/"));
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) {
      let real: string;
      try { real = realpathSync(full); } catch { continue; /* dangling symlink */ }
      if (!isInside(real, realRoot)) continue; // escapes workspace
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          if (visited.has(real)) continue;
          visited.add(real);
          results.push(...listFilesRecursive(full, root, realRoot, visited));
        } else if (stat.isFile()) {
          addFile(full);
        }
      } catch { /* stat failed */ }
    } else if (entry.isDirectory()) {
      results.push(...listFilesRecursive(full, root, realRoot, visited));
    } else if (entry.isFile()) {
      addFile(full);
    }
  }
  return results;
}

/** Resolve after `ms`, or reject as soon as `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("workspace.observe() aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createWorkspace(workspaceDir: string, signal?: AbortSignal): Workspace {
  const root = resolve(workspaceDir);
  mkdirSync(root, { recursive: true });
  const realRoot = realRootOf(root);

  /** All artifact paths matching a glob, sorted. */
  const listMatching = (pattern: string): string[] =>
    listFilesRecursive(root, root, realRoot).filter(f => matchGlob(pattern, f)).sort();

  /** Read an artifact, or null if it is missing, unreadable, or escapes the workspace. */
  const readIfPresent = (path: string): string | null => {
    try {
      return readFileSync(guardPath(root, path), "utf-8");
    } catch {
      return null;
    }
  };

  return {
    async read(path) {
      const target = guardPath(root, path);
      try {
        return readFileSync(target, "utf-8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Workspace artifact not found: ${path}`);
        throw e;
      }
    },

    async write(path, content) {
      const target = guardPath(root, path);
      mkdirSync(dirname(target), { recursive: true });

      // If the target is a symlink, write to what it points at rather than
      // replacing the link (matches tools.write). guardPath has already
      // verified the destination stays inside the workspace.
      let writePath = target;
      try {
        if (lstatSync(target).isSymbolicLink()) {
          try {
            writePath = realpathSync(target);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
            // Dangling symlink — resolve the link destination manually
            writePath = resolve(dirname(target), readlinkSync(target));
            mkdirSync(dirname(writePath), { recursive: true });
          }
        }
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }

      // Atomic write: temp file in the same directory, fsync, rename.
      // Readers see either the old content or the new — never a partial file.
      const tmpFile = writePath + `.trama-tmp-${process.pid}-${Date.now()}`;
      const fd = openSync(tmpFile, "w");
      try {
        writeFileSync(fd, content);
        fdatasyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmpFile, writePath);
    },

    async list(pattern) {
      return listMatching(pattern);
    },

    async observe(pattern, options = {}) {
      const { expect, timeout } = options;
      if (expect !== undefined && (!Number.isInteger(expect) || expect < 1)) {
        throw new Error(`workspace.observe(): expect must be a positive integer (got ${expect})`);
      }
      if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)) {
        throw new Error(`workspace.observe(): timeout must be a non-negative number (got ${timeout})`);
      }
      const needed = expect ?? 1;
      // One exact path, one artifact wanted → the caller gets its content as a string.
      const single = isExactPath(pattern) && needed === 1;
      if (single) resolveBounded(root, pattern); // reject traversal up front rather than polling forever

      const collectMatches = (): Array<{ path: string; content: string }> => {
        const matches: Array<{ path: string; content: string }> = [];
        for (const path of single ? [pattern] : listMatching(pattern)) {
          const content = readIfPresent(path);
          if (content !== null) matches.push({ path, content });
        }
        return matches;
      };

      // Level-triggered: artifacts that already exist count immediately.
      const startTime = Date.now();
      while (true) {
        if (signal?.aborted) throw new Error("workspace.observe() aborted");

        const matches = collectMatches();
        if (matches.length >= needed) return single ? matches[0].content : matches;

        if (timeout !== undefined && (Date.now() - startTime) >= timeout) {
          throw new Error(
            `workspace.observe("${pattern}") timed out after ${timeout}ms. ` +
            `Found ${matches.length}/${needed} matching artifacts.`
          );
        }

        await sleep(OBSERVE_POLL_MS, signal);
      }
    },
  };
}
