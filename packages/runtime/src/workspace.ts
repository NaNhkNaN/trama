import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, readlinkSync,
  realpathSync, lstatSync, statSync, existsSync, renameSync, fdatasyncSync,
  openSync, closeSync,
} from "fs";
import { resolve, dirname, relative, sep } from "path";
import { tmpdir } from "os";
import type { Workspace, ObserveResult } from "./types.js";
import { resolveBounded, verifyRealPath, verifyNearestAncestor, verifySymlink } from "./path-guard.js";

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
 * Recursively list all files under a directory, returning paths relative to root.
 * Includes symlinks to files and follows symlinked directories, but only if
 * they resolve inside the bounded root (prevents symlink escapes).
 *
 * Cycle detection: only symlinked directories are tracked in the `visited` set
 * (by their resolved realpath). Regular directories cannot create cycles on their
 * own, so they are traversed unconditionally. This allows legitimate directory
 * aliases (symlink pointing to another dir in the workspace) to produce their
 * own workspace-relative paths alongside the original directory's paths.
 */
function listFilesRecursive(dir: string, root: string, realRoot: string, visited?: Set<string>): string[] {
  const seen = visited ?? new Set<string>();

  const results: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) {
      // Verify symlink target is inside workspace root
      let real: string;
      try { real = realpathSync(full); } catch { continue; /* dangling symlink */ }
      if (!real.startsWith(realRoot + sep) && real !== realRoot) continue; // escapes workspace
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          // Cycle detection: only for symlinked directories
          if (seen.has(real)) continue;
          seen.add(real);
          results.push(...listFilesRecursive(full, root, realRoot, seen));
        } else if (stat.isFile()) {
          results.push(relative(root, full));
        }
      } catch { /* stat failed */ }
    } else if (entry.isDirectory()) {
      // Regular directories can't cause cycles — traverse unconditionally
      results.push(...listFilesRecursive(full, root, realRoot, seen));
    } else if (entry.isFile()) {
      results.push(relative(root, full));
    }
  }
  return results;
}

/**
 * Check if a pattern is a simple exact path (no glob characters).
 */
function isExactPath(pattern: string): boolean {
  // Only check for glob chars that matchGlob actually supports: * and ?
  // Characters like [ ] { } are not glob operators in our implementation
  // and should be treated as literal filename characters.
  return !/[*?]/.test(pattern);
}

export function createWorkspace(workspaceDir: string, signal?: AbortSignal): Workspace {
  const normalizedDir = resolve(workspaceDir);

  // Ensure workspace directory exists before resolving realpath
  mkdirSync(normalizedDir, { recursive: true });

  let realDir: string;
  try { realDir = realpathSync(normalizedDir); } catch { realDir = normalizedDir; }

  const resolvePath = (p: string): string => resolveBounded(normalizedDir, p);

  const checkRealPath = (real: string, original: string): void =>
    verifyRealPath(real, realDir, original);

  const checkNearestAncestor = (resolved: string, original: string): void =>
    verifyNearestAncestor(resolved, realDir, original);

  return {
    async read(path) {
      const target = resolvePath(path);
      let real: string;
      try { real = realpathSync(target); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`Workspace artifact not found: ${path}`);
        }
        throw e;
      }
      checkRealPath(real, path);
      return readFileSync(target, "utf-8");
    },

    async write(path, content) {
      const target = resolvePath(path);
      checkNearestAncestor(target, path);
      mkdirSync(dirname(target), { recursive: true });

      // If target is a symlink, resolve to real path and write through it
      // (matches tools.write behavior — write to the target, don't replace the link)
      let writePath = target;
      try {
        if (lstatSync(target).isSymbolicLink()) {
          verifySymlink(target, realDir, path);
          try {
            writePath = realpathSync(target);
          } catch (realErr) {
            if ((realErr as NodeJS.ErrnoException).code !== "ENOENT") throw realErr;
            // Dangling symlink — resolve the link destination manually
            writePath = resolve(dirname(target), readlinkSync(target));
            mkdirSync(dirname(writePath), { recursive: true });
          }
        }
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }

      // Atomic write: write to temp file in same directory, fsync, rename
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
      const allFiles = listFilesRecursive(normalizedDir, normalizedDir, realDir);
      // Normalize to forward slashes for matching
      return allFiles
        .map(f => f.split(sep).join("/"))
        .filter(f => matchGlob(pattern, f))
        .sort();
    },

    async observe(pattern, options = {}) {
      const { expect, timeout } = options;
      if (expect !== undefined && (!Number.isInteger(expect) || expect < 1)) {
        throw new Error(`workspace.observe(): expect must be a positive integer (got ${expect})`);
      }
      if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)) {
        throw new Error(`workspace.observe(): timeout must be a non-negative number (got ${timeout})`);
      }
      const isExact = isExactPath(pattern) && (expect === undefined || expect <= 1);
      const startTime = Date.now();

      const collectMatches = (): Array<{ path: string; content: string }> => {
        if (isExact) {
          const target = resolvePath(pattern);
          if (existsSync(target)) {
            try {
              const real = realpathSync(target);
              checkRealPath(real, pattern);
              return [{ path: pattern, content: readFileSync(target, "utf-8") }];
            } catch {
              return [];
            }
          }
          return [];
        }

        const allFiles = listFilesRecursive(normalizedDir, normalizedDir, realDir);
        const matches: Array<{ path: string; content: string }> = [];
        for (const f of allFiles) {
          const normalized = f.split(sep).join("/");
          if (matchGlob(pattern, normalized)) {
            const target = resolve(normalizedDir, f);
            try {
              const real = realpathSync(target);
              checkRealPath(real, normalized);
              matches.push({ path: normalized, content: readFileSync(target, "utf-8") });
            } catch {
              // Skip files we can't read
            }
          }
        }
        return matches.sort((a, b) => a.path.localeCompare(b.path));
      };

      const neededCount = expect ?? 1;

      // Poll until condition is met
      while (true) {
        if (signal?.aborted) {
          throw new Error("workspace.observe() aborted");
        }

        const matches = collectMatches();
        if (matches.length >= neededCount) {
          // Return single string for exact single-file, array otherwise
          if (isExact && neededCount <= 1) {
            return matches[0].content;
          }
          return matches;
        }

        if (timeout !== undefined && (Date.now() - startTime) >= timeout) {
          throw new Error(
            `workspace.observe("${pattern}") timed out after ${timeout}ms. ` +
            `Found ${matches.length}/${neededCount} matching artifacts.`
          );
        }

        // Wait before polling again
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const onTimer = () => {
            if (settled) return;
            settled = true;
            if (signal) signal.removeEventListener("abort", onAbort);
            resolve();
          };
          const onAbort = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error("workspace.observe() aborted"));
          };
          const timer = setTimeout(onTimer, OBSERVE_POLL_MS);
          if (signal) {
            signal.addEventListener("abort", onAbort, { once: true });
          }
        });
      }
    },
  };
}
