import { readFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { resolve, relative, sep } from "path";
import type { Workspace } from "./types.js";
import { createTools, type ToolsWithCleanup } from "./tools.js";
import { onAbort } from "./abort.js";
import { guardPath, realRootOf } from "./path-guard.js";
import { isStagedName, stageFile } from "./replace-file.js";

const OBSERVE_POLL_MS = 250;

/**
 * Read a simple glob pattern for matching relative paths: `*` is any run of
 * characters within a segment, `?` one of them, `**` any run of characters
 * at all, and `**` with its slash any number of whole segments, none included
 * (so `**` + `/*.md` matches at the root too). Every other character is itself.
 *
 * The pattern is taken apart at its operators, and each piece between them
 * is itself, character for character — there is no text a pattern could
 * hold that is mistaken for an operator.
 *
 * A path is held against it step by step, and no step is taken twice: where
 * the pattern is at a given place and the path at a given place, whether the
 * rest matches is found once. (A pattern handed to the system's own matcher
 * of expressions is tried every way round instead, and one that says "any
 * segments" a dozen times is not done with a path of some depth in any time
 * a caller would wait — which, here, is everyone the runner serves.)
 */
export function compileGlob(pattern: string): { test(path: string): boolean } {
  type Step = { one: string } | "one of a segment" | "some of a segment" | "anything" | "whole segments";
  const steps: Step[] = [];
  pattern.split("**/").forEach((part, whole) => {
    if (whole > 0) steps.push("whole segments");
    part.split("**").forEach((within, any) => {
      if (any > 0) steps.push("anything");
      within.split("?").forEach((run, one) => {
        if (one > 0) steps.push("one of a segment");
        run.split("*").forEach((text, some) => {
          if (some > 0) steps.push("some of a segment");
          // (Unit by unit, as text is counted: one `?` is one of them, as it was to the matcher before this.)
          for (let at = 0; at < text.length; at += 1) steps.push({ one: text[at] });
        });
      });
    });
  });
  return {
    test(characters) {
      /** Whether the rest matches, from a step of the pattern and a place in the path: found once. */
      const found = new Map<number, boolean>();
      const rest = (step: number, at: number): boolean => {
        if (step === steps.length) return at === characters.length;
        const key = step * (characters.length + 1) + at;
        const known = found.get(key);
        if (known !== undefined) return known;
        const is = steps[step];
        let matches = false;
        if (typeof is === "object") matches = characters[at] === is.one && rest(step + 1, at + 1);
        else if (is === "one of a segment") matches = at < characters.length && characters[at] !== "/" && rest(step + 1, at + 1);
        else if (is === "some of a segment") {
          for (let to = at; !matches; to += 1) {
            matches = rest(step + 1, to);
            if (to >= characters.length || characters[to] === "/") break;
          }
        } else if (is === "anything") {
          for (let to = at; to <= characters.length && !matches; to += 1) matches = rest(step + 1, to);
        } else {
          // None — or what ends in a slash and has something before it.
          matches = rest(step + 1, at);
          for (let to = at + 2; to <= characters.length && !matches; to += 1) matches = characters[to - 1] === "/" && rest(step + 1, to);
        }
        found.set(key, matches);
        return matches;
      };
      return rest(0, 0);
    },
  };
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
 * though it can be read: what lies beyond a second link to a directory. (A
 * link to a file costs nothing to list, wherever it is come upon.)
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

const observeAborted = () => new Error("workspace.observe() aborted");

/** Resolve after `ms`, or reject as soon as `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      offAbort();
      resolve();
    }, ms);
    const offAbort = onAbort(signal, () => {
      clearTimeout(timer);
      reject(observeAborted());
    });
  });
}

/**
 * Make sure a workspace directory exists where `workspaceDir` leads, and
 * return its resolved path. Unlike a project, a workspace is nothing but its
 * path and is made as needed — also when `workspaceDir` is a link whose target
 * is not there yet.
 */
export function ensureWorkspaceDir(workspaceDir: string): string {
  const root = resolve(workspaceDir);
  mkdirSync(realRootOf(root), { recursive: true });
  return root;
}

/**
 * The workspace in a directory. `shellIn`: the shell its commands are run by
 * — a run's own, so that they are the run's to stop, and have its variables.
 * Without it the workspace has a shell of its own: commands it started end
 * with this process.
 */
export function createWorkspace(workspaceDir: string, signal?: AbortSignal, shellIn?: ToolsWithCleanup["shellIn"]): Workspace {
  const root = ensureWorkspaceDir(workspaceDir);
  let ownShell: ToolsWithCleanup | undefined;

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

    async shell(command, options) {
      return (shellIn ?? (ownShell ??= createTools(root, signal)).shellIn)(root, command, options);
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
      const exact = isExactPath(pattern);
      // One exact path, one artifact wanted → the caller gets its content as a string.
      const single = exact && needed === 1;
      // A path that will never be read is refused now, rather than waited for: one that leads out of the
      // workspace, or cannot be followed as things stand, whatever is asked of it. (What comes to be in its way
      // later, while it waits — a link, a file where a directory is to be — is waited out like anything that is
      // not there yet.)
      if (exact) guardPath(root, pattern);
      // And one path, wanted as one text, is none while a directory is there: that is said as soon as it is seen.
      const isDirectory = () => {
        try { return statSync(guardPath(root, pattern)).isDirectory(); } catch { return false; }
      };

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
        if (signal?.aborted) throw observeAborted();
        if (single && isDirectory()) {
          throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${pattern}'`), { code: "EISDIR" });
        }

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
