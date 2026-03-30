import { existsSync, realpathSync, lstatSync, readlinkSync } from "fs";
import { resolve, dirname, sep } from "path";

/**
 * Resolve a path within a project directory and verify it does not escape
 * the project boundary — either via ".." segments or symlinks.
 *
 * Not a security sandbox — just a footgun guard against malicious shared
 * projects where files like state.json or .gitignore are symlinks pointing
 * outside the project directory.
 */

/**
 * Resolve `relativePath` against `projectDir` and verify the logical path
 * stays within the project boundary. Returns the resolved absolute path.
 */
export function resolveBounded(projectDir: string, relativePath: string): string {
  const normalizedDir = resolve(projectDir);
  const resolved = resolve(normalizedDir, relativePath);
  if (resolved !== normalizedDir && !resolved.startsWith(normalizedDir + sep)) {
    throw new Error(`Path escapes project directory: ${relativePath}`);
  }
  return resolved;
}

/**
 * Verify that `realPath` (the output of realpathSync) is inside `realProjectDir`.
 */
export function verifyRealPath(realPath: string, realProjectDir: string, originalPath: string): void {
  if (realPath !== realProjectDir && !realPath.startsWith(realProjectDir + sep)) {
    throw new Error(`Path escapes project directory via symlink: ${originalPath}`);
  }
}

/**
 * Walk up from `resolved` to find the deepest existing ancestor,
 * then verify its real path is inside the project dir.
 * This catches symlink escapes BEFORE any mkdir side effects.
 */
export function verifyNearestAncestor(resolved: string, realProjectDir: string, originalPath: string): void {
  let cur = resolved;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return; // reached filesystem root — nothing to verify
    cur = parent;
  }
  verifyRealPath(realpathSync(cur), realProjectDir, originalPath);
}

/**
 * Verify that an existing symlink's target resolves inside the project dir.
 * For dangling symlinks, falls back to verifyNearestAncestor on the link target.
 */
export function verifySymlink(target: string, realProjectDir: string, originalPath: string): void {
  try {
    verifyRealPath(realpathSync(target), realProjectDir, originalPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    // Dangling symlink — resolve what we can via nearest existing ancestor
    const linkDest = resolve(dirname(target), readlinkSync(target));
    verifyNearestAncestor(linkDest, realProjectDir, originalPath);
  }
}

/**
 * All-in-one guard for reading/writing a file in a project directory.
 * Checks both logical path (.. segments) and symlink resolution.
 * Returns the resolved absolute path.
 *
 * For writes to paths that don't yet exist, checks the nearest existing
 * ancestor to prevent side effects outside the project.
 */
export function guardPath(projectDir: string, relativePath: string): string {
  const normalizedDir = resolve(projectDir);
  let realDir: string;
  try { realDir = realpathSync(normalizedDir); } catch { realDir = normalizedDir; }

  const resolved = resolveBounded(projectDir, relativePath);

  // Use lstatSync (not existsSync) to detect dangling symlinks.
  // existsSync returns false for dangling symlinks, which would skip the
  // symlink check and allow writes to follow the link to an external target.
  let stat;
  try { stat = lstatSync(resolved); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    // Path truly doesn't exist (not even as a dangling symlink)
    // — verify nearest ancestor is inside project
    verifyNearestAncestor(resolved, realDir, relativePath);
    return resolved;
  }

  if (stat.isSymbolicLink()) {
    verifySymlink(resolved, realDir, relativePath);
  } else {
    verifyRealPath(realpathSync(resolved), realDir, relativePath);
  }

  return resolved;
}
