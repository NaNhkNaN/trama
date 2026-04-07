import { mkdirSync, existsSync, mkdtempSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import { runProgram } from "@trama-dev/runtime/runner";
import type { ProgramResult } from "@trama-dev/runtime/runner";

export type { ProgramResult };

export interface SessionOptions {
  /** Directory for shared workspace artifacts. Created if it doesn't exist. */
  workspace: string;
}

export interface SpawnOptions {
  /** Path to the trama project directory. */
  projectDir: string;
  /** Arguments passed to the program via ctx.input.args. */
  args?: Record<string, unknown>;
  /** Per-phase timeout in ms. */
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

export class Session {
  /** The shared workspace directory path. */
  readonly workspace: string;

  private constructor(workspace: string) {
    this.workspace = workspace;
  }

  /**
   * Create a new session with a shared workspace directory.
   * The workspace is created if it doesn't exist.
   */
  static async create(options: SessionOptions): Promise<Session> {
    const workspace = resolve(options.workspace);
    mkdirSync(workspace, { recursive: true });
    return new Session(workspace);
  }

  /**
   * Create a new session with a temporary workspace directory.
   * Useful for testing or ephemeral sessions.
   */
  static async createTemp(prefix = "trama-session-"): Promise<Session> {
    if (prefix.includes("/") || prefix.includes("\\")) {
      throw new Error("createTemp prefix must not contain path separators");
    }
    const workspace = mkdtempSync(resolve(tmpdir(), prefix));
    return new Session(workspace);
  }

  /**
   * Spawn a trama program as a session participant.
   * The program gets access to the shared workspace via the workspace API.
   */
  spawn(name: string, options: SpawnOptions): ParticipantHandle {
    const { projectDir, args, timeout, maxRepairAttempts } = options;
    const workspaceDir = this.workspace;

    if (!existsSync(projectDir)) {
      throw new Error(`Project directory not found: ${projectDir}`);
    }

    // Track participant lifecycle state
    let state: "running" | "yielded" | "done" | "failed" = "running";
    let resultPromise: Promise<ProgramResult>;
    // Track the latest effective args so multi-yield resumes accumulate state
    let lastArgs: Record<string, unknown> | undefined = args;

    const startRun = (runArgs?: Record<string, unknown>): Promise<ProgramResult> => {
      state = "running";
      lastArgs = runArgs;
      const promise = runProgram({
        projectDir,
        timeout,
        maxRepairAttempts,
        args: runArgs ?? args,
        workspaceDir,
      });
      // Track state transitions when the run completes
      promise.then(
        (result) => {
          state = result.status === "yielded" ? "yielded"
            : result.status === "done" ? "done"
            : "failed";
        },
        () => {
          // Infrastructure error — treat as failed
          state = "failed";
        },
      );
      return promise;
    };

    // Start the run immediately
    resultPromise = startRun(args);

    const handle: ParticipantHandle = {
      name,

      wait(): Promise<ProgramResult> {
        return resultPromise;
      },

      async resume(newArgs?: Record<string, unknown>): Promise<ParticipantHandle> {
        // Fail-fast: check current state synchronously — don't block on a running participant
        if (state !== "yielded") {
          throw new Error(
            `Cannot resume participant "${name}": expected state "yielded" but got "${state}". ` +
            `resume() is only valid after a program calls ctx.yield().`
          );
        }

        const mergedArgs = newArgs ? { ...(lastArgs ?? {}), ...newArgs } : lastArgs;
        resultPromise = startRun(mergedArgs);
        return handle;
      },
    };

    return handle;
  }
}
