import { spawn } from "child_process";
import { accessSync, constants, readFileSync, statSync, writeFileSync } from "fs";
import { delimiter, resolve, dirname } from "path";
import type { Tools, ShellResult } from "./types.js";
import { guardPath, makeDirsIn, projectAt, realRootOf } from "./path-guard.js";
import { checkedEnv, superviseChild } from "./child-process.js";
import { messageOf } from "./errors.js";
import { signalGroup, stopGroups, stopWithThisProcess } from "./stopping.js";

const MAX_FETCH_BODY = 10 * 1024 * 1024; // 10 MB
const DEFAULT_SHELL_TIMEOUT = 30_000;
const GROUP_SWEEP_MS = 250;

/**
 * The shell a command is run by: the `sh` that `path` — the runner's own
 * PATH — leads to from where the command runs. Not the one a PATH given for
 * the command would lead to: that PATH is for what the command runs, and one
 * without a shell on it, or with something else of the name, is the
 * command's affair. (Where none is found, the system is left to say so. A
 * runner that has no PATH at all has the system's own, as it would have for
 * anything it started.)
 */
function shellOn(path: string | undefined, cwd: string): string {
  if (process.platform === "win32") return "sh";
  for (const dir of (path ?? "/usr/bin:/bin").split(delimiter)) {
    const at = resolve(cwd, dir, "sh");
    try {
      accessSync(at, constants.X_OK);
      if (statSync(at).isFile()) return at;
    } catch { /* not there, or not to be run: the next */ }
  }
  return "sh";
}

export interface ToolsWithCleanup extends Tools {
  /** Stop every shell command still running, and anything they left in the background. Resolves when they are gone. */
  stopActiveShells(): Promise<void>;
}

/** `env` is the variables the run was started with, over the runner's own: every shell command has them. */
export function createTools(projectDir: string, signal?: AbortSignal, env?: Record<string, string>): ToolsWithCleanup {
  const normalizedProjectDir = resolve(projectDir);

  // Each shell command leads its own process group, so background processes it
  // starts stay killable after the shell itself exits. A group is tracked from
  // spawn until it has no members left. `shellExited` marks groups whose shell
  // has exited — only those are probed, since a group that is still starting
  // up may not be visible yet. `forget` tells the watchdog the
  // group no longer needs killing if this process dies.
  const groups = new Map<number, { shellExited: boolean; forget: () => void }>();
  let sweeper: ReturnType<typeof setInterval> | null = null;

  const untrack = (pgid: number) => {
    groups.get(pgid)?.forget();
    groups.delete(pgid);
  };

  // Shell commands run here do not get the bridge's address or the init file
  // (which holds its secret). A runner normally has neither in its
  // environment; it does when it is working inside a program — which create
  // and update still do when a program calls them. (This covers tools.shell
  // only: what the agent backend runs on its own takes its environment from
  // this process.)
  const { TRAMA_PORT: _port, TRAMA_INIT: _init, ...runnersOwn } = process.env;
  const shellEnv = { ...runnersOwn, ...env };

  const stopSweeping = () => {
    if (sweeper) clearInterval(sweeper);
    sweeper = null;
  };

  /** Forget groups that have fully exited, so a recycled pid is never signalled. */
  const sweep = () => {
    let pending = false;
    for (const [pgid, group] of groups) {
      if (!group.shellExited) continue;
      if (signalGroup(pgid, 0)) pending = true;
      else untrack(pgid);
    }
    if (!pending) stopSweeping();
  };

  const markShellExited = (pgid: number) => {
    const group = groups.get(pgid);
    if (!group) return; // already stopped by stopActiveShells
    group.shellExited = true;
    if (!sweeper) {
      sweeper = setInterval(sweep, GROUP_SWEEP_MS);
      sweeper.unref();
    }
  };

  return {
    async stopActiveShells() {
      const pgids = [...groups.keys()];
      await stopGroups(pgids);
      for (const pgid of pgids) untrack(pgid);
      stopSweeping();
    },

    async read(path) {
      const target = guardPath(normalizedProjectDir, path);
      try {
        return readFileSync(target, "utf-8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`File not found: ${path}`);
        throw e;
      }
    },

    async write(path, content) {
      const target = guardPath(normalizedProjectDir, path); // before mkdir — no side effects outside the project
      // (Asked to write the project itself, the system refuses a directory. Where the project is gone it is refused
      // either way, as any write is: this only says of the project what is otherwise said of "the directory".)
      if (target === realRootOf(normalizedProjectDir)) projectAt(normalizedProjectDir);
      makeDirsIn(normalizedProjectDir, dirname(target));
      writeFileSync(target, content);
    },

    async shell(command, options = {}): Promise<ShellResult> {
      const cwd = options.cwd ? guardPath(normalizedProjectDir, options.cwd) : normalizedProjectDir;
      const env = options.env == null ? shellEnv : { ...shellEnv, ...checkedEnv(options.env) };
      // The shell is started from where the runner finds it, and is `sh` to itself and to whoever it tells of
      // itself, as it was when the system did the finding: in "$0", in what it says of a command it cannot find,
      // and in what is said of a shell that could not be started.
      const shell = shellOn(runnersOwn.PATH, cwd);
      const notStarted = (why: unknown): ShellResult => ({ exitCode: 1, stdout: "", stderr: messageOf(why).replace(`spawn ${shell} `, "spawn sh ") });
      let child;
      try {
        child = spawn(shell, ["-c", command], {
          cwd,
          env,
          argv0: "sh",
          // Nothing is ever sent to a command: one that reads its input finds it at an end, rather than waiting.
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
      } catch (spawnError) {
        // Refused by the system outright (more than it will hand a process, say) — a result, like any failure to start.
        return notStarted(spawnError);
      }
      const pgid = child.pid;
      if (pgid) {
        groups.set(pgid, { shellExited: false, forget: stopWithThisProcess(pgid) });
      }

      try {
        const exit = await superviseChild(child, { timeout: options.timeout ?? DEFAULT_SHELL_TIMEOUT });
        if (pgid) markShellExited(pgid);
        return {
          exitCode: exit.timedOut ? 1 : (exit.code ?? 1),
          stdout: exit.stdout,
          stderr: exit.timedOut ? exit.stderr + "\ntimeout" : exit.stderr,
        };
      } catch (spawnError) {
        // Failed to start (e.g. cwd does not exist) — a result, not an exception.
        return notStarted(spawnError);
      }
    },

    async fetch(url, options = {}) {
      const response = await globalThis.fetch(url, {
        method: options.method ?? "GET",
        headers: options.headers,
        body: options.body,
        signal,
      });

      let body: string;
      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let text = "";
        let truncated = false;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
            if (text.length > MAX_FETCH_BODY) {
              truncated = true;
              await reader.cancel();
              break;
            }
          }
          if (!truncated) text += decoder.decode();
        } finally {
          reader.releaseLock();
        }
        body = truncated
          ? text.slice(0, MAX_FETCH_BODY) + "\n[trama] response body truncated at 10MB"
          : text;
      } else {
        body = ""; // (an answer that has no body: to a HEAD, say)
      }

      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => { headers[k] = v; });

      return { status: response.status, body, headers };
    }
  };
}
