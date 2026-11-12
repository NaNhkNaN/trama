// Putting a file in place in one move.
//
// The content is written to a temp file beside where it is going, and the
// temp file is then renamed over the destination. Whoever reads the path sees
// the old content or the new, never part of either — and between the two
// steps there is a moment to do something that must not be left half-done
// (see installValidatedProgram), or to call the whole thing off.

import { chmodSync, closeSync, fdatasyncSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { dirname } from "path";
import { guardWriteTarget, realRootOf } from "./path-guard.js";

/** Whether a file name is that of a temp file made here — not content, though it sits among it for a moment. */
export const isStagedName = (name: string) => /\.trama-tmp-[0-9a-f]{12}$/.test(name);

export interface StagedFile {
  /** Where the content will be: the path given, with every link on the way followed. */
  destination: string;
  /** Move the content into place. If that cannot be done, nothing is left behind. */
  commit(): void;
  /** Call it off: the destination stays as it is. */
  discard(): void;
}

/**
 * Write `content` beside where `relativePath` under `rootDir` leads, ready to
 * take its place.
 *
 * The destination is where the links on the way point, so a link is written
 * through, not replaced. It must be a file's place: the root itself is
 * refused, since "beside" it is outside it. Directories on the way are
 * created. The temp file is created, never opened: a name that is already
 * there — a link somebody planted, say — is not written through. A file that
 * is being replaced hands on its permissions, as it would if it were written
 * into; it is a new file all the same, so a second hard link to the old one,
 * or its owner, are not carried over.
 */
export function stageFile(rootDir: string, relativePath: string, content: string | Buffer): StagedFile {
  const destination = guardWriteTarget(rootDir, relativePath);
  if (destination === realRootOf(rootDir)) {
    throw new Error(`Not a file path: "${relativePath}" is the directory itself`);
  }
  mkdirSync(dirname(destination), { recursive: true });

  const staged = `${destination}.trama-tmp-${randomBytes(6).toString("hex")}`;
  const discard = () => { try { rmSync(staged, { force: true }); } catch { /* best-effort */ } };

  const fd = openSync(staged, "wx");
  try {
    try {
      writeFileSync(fd, content);
      fdatasyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const replaced = statSync(destination, { throwIfNoEntry: false });
    if (replaced) chmodSync(staged, replaced.mode & 0o777);
  } catch (err) {
    discard();
    throw err;
  }

  return {
    destination,
    discard,
    commit() {
      try {
        renameSync(staged, destination);
      } catch (err) {
        discard();
        throw err;
      }
    },
  };
}
