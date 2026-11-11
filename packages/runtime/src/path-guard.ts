import { existsSync, realpathSync, lstatSync, readlinkSync } from "fs";
import { resolve, dirname, sep } from "path";

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

function verifyRealPath(realPath: string, realRoot: string, originalPath: string): void {
  if (!isInside(realPath, realRoot)) {
    throw new Error(`Path escapes project directory via symlink: ${originalPath}`);
  }
}

/**
 * Walk up from `resolved` to find the deepest existing ancestor,
 * then verify its real path is inside the root.
 * This catches symlink escapes BEFORE any mkdir side effects.
 */
function verifyNearestAncestor(resolved: string, realRoot: string, originalPath: string): void {
  let cur = resolved;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return; // reached filesystem root — nothing to verify
    cur = parent;
  }
  verifyRealPath(realpathSync(cur), realRoot, originalPath);
}

/**
 * Verify that an existing symlink's target resolves inside the root.
 * For dangling symlinks, falls back to verifyNearestAncestor on the link target.
 */
function verifySymlink(target: string, realRoot: string, originalPath: string): void {
  try {
    verifyRealPath(realpathSync(target), realRoot, originalPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    // Dangling symlink — resolve what we can via nearest existing ancestor
    const linkDest = resolve(dirname(target), readlinkSync(target));
    verifyNearestAncestor(linkDest, realRoot, originalPath);
  }
}

/** The real (symlink-resolved) location of a root directory, or its normalized path if it doesn't exist yet. */
export function realRootOf(rootDir: string): string {
  const normalizedDir = resolve(rootDir);
  try { return realpathSync(normalizedDir); } catch { return normalizedDir; }
}

/**
 * The guard for reading or writing a path under a bounded root.
 * Checks both the logical path (".." segments) and symlink resolution,
 * and returns the resolved absolute path.
 *
 * For paths that don't exist yet, checks the nearest existing ancestor —
 * so a caller can safely mkdir and write afterwards.
 */
export function guardPath(rootDir: string, relativePath: string): string {
  const realRoot = realRootOf(rootDir);
  const resolved = resolveBounded(rootDir, relativePath);

  // Use lstatSync (not existsSync) to detect dangling symlinks.
  // existsSync returns false for dangling symlinks, which would skip the
  // symlink check and allow writes to follow the link to an external target.
  let stat;
  try { stat = lstatSync(resolved); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    // Path truly doesn't exist (not even as a dangling symlink)
    // — verify nearest ancestor is inside the root
    verifyNearestAncestor(resolved, realRoot, relativePath);
    return resolved;
  }

  if (stat.isSymbolicLink()) {
    verifySymlink(resolved, realRoot, relativePath);
  } else {
    verifyRealPath(realpathSync(resolved), realRoot, relativePath);
  }

  return resolved;
}
