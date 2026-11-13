import { readFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { resolve, relative, sep } from "path";
import type { Workspace } from "./types.js";
import { onAbort } from "./abort.js";
import { guardPath } from "./path-guard.js";
import { isStagedName, stageFile } from "./replace-file.js";

const OBSERVE_POLL_MS = 250;

/**
 * Compile a simple glob pattern for matching relative paths.
 * Supports `*` (any segment chars), `?` (single char), and `**` (any path segments).
 * `** /` matches zero or more directory segments (including root).
 */
function compileGlob(pattern: string): RegExp {
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
  return new RegExp(`^${regex}$`);
}

/**
 * A pattern with no glob operators names exactly one artifact.
 * Only `*` and `?` are operators here — `[ ] { }` are literal filename characters.
 */
function isExactPath(pattern: string): boolean {
  return !/[*?]/.test(pattern);
}

/**
 * List the files under a directory of a workspace, as forward-slash paths
 * relative to `root`, into `found`. Links to files are included, and links
 * to directories followed, but only those the guard lets through: what is
 * listed is what can be read.
 *
 * A link to a directory is an alias: what is in that directory is listed
 * under the link's name too. It is followed where it really is — in a
 * directory reached by no link — and not again where it is come upon by way
 * of another link (`byLink`). So every alias of a shared directory is listed,
 * a loop is gone round once, and the work is bounded by the links there are
 * times what they lead to; following links found through links, it is
 * bounded by nothing but the length of a path. What this leaves unlisted,
 * though it can be read: a path through two links or more.
 */
function listFiles(dir: string, root: string, found: string[], byLink = false): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // A temp file left by a write that was cut off is not an artifact.
  const addFile = (full: string) => { if (!isStagedName(full)) found.push(relative(root, full).split(sep).join("/")); };
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) {
      let stat;
      try {
        guardPath(root, full); // leads out of the workspace, or nowhere: not listed
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isFile()) addFile(full);
      else if (stat.isDirectory() && !byLink) listFiles(full, root, found, true);
    } else if (entry.isDirectory()) {
      listFiles(full, root, found, byLink);
    } else if (entry.isFile()) {
      addFile(full);
    }
  }
}

/** Resolve after `ms`, or reject as soon as `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      offAbort();
      resolve();
    }, ms);
    const offAbort = onAbort(signal, () => {
      clearTimeout(timer);
      reject(new Error("workspace.observe() aborted"));
    });
  });
}

export function createWorkspace(workspaceDir: string, signal?: AbortSignal): Workspace {
  const root = resolve(workspaceDir);
  mkdirSync(root, { recursive: true });

  /** All artifact paths matching a glob, sorted. */
  const listMatching = (pattern: string): string[] => {
    const re = compileGlob(pattern);
    const found: string[] = [];
    listFiles(root, root, found);
    return found.filter(f => re.test(f)).sort();
  };

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
      // One move, so that readers see either the old content or the new, never
      // a partial file. A link is written through rather than replaced.
      stageFile(root, path, content).commit();
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
      if (single) guardPath(root, pattern); // a path that will never be read is refused now, rather than waited for

      const collectMatches = (): Array<{ path: string; content: string }> => {
        const matches: Array<{ path: string; content: string }> = [];
        for (const path of single ? [pattern] : listMatching(pattern)) {
          const content = readIfPresent(path);
          if (content !== null) matches.push({ path, content });
        }
        return matches;
      };

      // Level-triggered: artifacts that already exist count immediately.
      const startTime = performance.now();
      while (true) {
        if (signal?.aborted) throw new Error("workspace.observe() aborted");

        const matches = collectMatches();
        if (matches.length >= needed) return single ? matches[0].content : matches;

        if (timeout !== undefined && (performance.now() - startTime) >= timeout) {
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
