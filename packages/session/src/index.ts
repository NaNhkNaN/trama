import { mkdtempSync } from "fs";
import { join, resolve } from "path";
import { homedir, tmpdir } from "os";
import { createWorkspace, runProgram } from "@trama-dev/runtime/runner";
import type { ProgramResult, Workspace } from "@trama-dev/runtime/runner";

export type { ProgramResult, Workspace };

export interface SessionOptions {
  /** Directory for shared workspace artifacts. Created if it doesn't exist. A leading `~` is expanded. */
  workspace: string;
}

export interface SpawnOptions {
  /** Path to the trama project directory. A leading `~` is expanded. */
  projectDir: string;
  /** Arguments passed to the program via ctx.input.args. */
  args?: Record<string, unknown>;
  /**
   * Per-phase timeout in ms, for each run and each repair attempt of this
   * participant. While the participant runs, the clock of the program that
   * spawned it is stopped: this timeout is what limits that time.
   */
  timeout?: number;
  /** Max repair attempts. */
  maxRepairAttempts?: number;
}

export interface ParticipantHandle {
  /** The participant name. */
  name: string;

  /** Wait for participant to complete, yield, or fail. */
  wait(): Promise<ProgramResult>;

  /**
   * Resume a yielded participant with optional new args.
   * Throws if the participant is not in a yielded state.
   */
  resume(args?: Record<string, unknown>): Promise<ParticipantHandle>;
}

/** Make a path absolute, expanding a leading `~` to the user's home directory. */
function toAbsolute(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

export class Session {
  /** The shared workspace directory. */
  readonly workspaceDir: string;

  /**
   * The shared workspace itself — the same read / write / list / observe that
   * participants get as `workspace` from "@trama-dev/runtime". This is how the
   * program that creates the session takes part in it.
   */
  readonly workspace: Workspace;

  private constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.workspace = createWorkspace(workspaceDir);
  }

  /**
   * Create a new session with a shared workspace directory.
   * The workspace is created if it doesn't exist.
   */
  static async create(options: SessionOptions): Promise<Session> {
    return new Session(toAbsolute(options.workspace));
  }

  /**
   * Create a new session with a temporary workspace directory.
   * Useful for testing or ephemeral sessions.
   */
  static async createTemp(prefix = "trama-session-"): Promise<Session> {
    if (prefix.includes("/") || prefix.includes("\\")) {
      throw new Error("createTemp prefix must not contain path separators");
    }
    return new Session(mkdtempSync(resolve(tmpdir(), prefix)));
  }

  /**
   * Spawn a trama program as a session participant.
   * The program gets access to the shared workspace via the workspace API.
   */
  spawn(name: string, options: SpawnOptions): ParticipantHandle {
    const { args, timeout, maxRepairAttempts } = options;
    const projectDir = toAbsolute(options.projectDir);
    const workspaceDir = this.workspaceDir;

    // Where the participant is in its lifecycle, and the args of its latest run —
    // a resume merges new args over them, so they accumulate across yields.
    let state: "running" | ProgramResult["status"] = "running";
    let lastArgs = args;

    const startRun = (runArgs?: Record<string, unknown>): Promise<ProgramResult> => {
      state = "running";
      lastArgs = runArgs;
      const run = runProgram({ projectDir, timeout, maxRepairAttempts, args: runArgs, workspaceDir });
      // An infrastructure error (the run could not happen at all) counts as failed.
      run.then(result => { state = result.status; }, () => { state = "failed"; });
      return run;
    };

    let resultPromise = startRun(args);

    const handle: ParticipantHandle = {
      name,

      wait(): Promise<ProgramResult> {
        return resultPromise;
      },

      async resume(newArgs?: Record<string, unknown>): Promise<ParticipantHandle> {
        // Fail fast rather than wait on a participant that is still running.
        if (state !== "yielded") {
          throw new Error(
            `Cannot resume participant "${name}": expected state "yielded" but got "${state}". ` +
            `resume() is only valid after a program calls ctx.yield().`
          );
        }

        resultPromise = startRun(newArgs ? { ...lastArgs, ...newArgs } : lastArgs);
        return handle;
      },
    };

    return handle;
  }
}
