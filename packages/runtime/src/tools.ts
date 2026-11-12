import { spawn } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import type { Tools, ShellResult } from "./types.js";
import { guardPath } from "./path-guard.js";
import { signalGroup, stopGroups, superviseChild } from "./child-process.js";
import { stopWithThisProcess } from "./watchdog.js";

const MAX_FETCH_BODY = 10 * 1024 * 1024; // 10 MB
const DEFAULT_SHELL_TIMEOUT = 30_000;
const GROUP_SWEEP_MS = 250;

export interface ToolsWithCleanup extends Tools {
  /** Stop every shell command still running, and anything they left in the background. Resolves when they are gone. */
  stopActiveShells(): Promise<void>;
}

export function createTools(projectDir: string, signal?: AbortSignal): ToolsWithCleanup {
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
  const { TRAMA_PORT: _port, TRAMA_INIT: _init, ...shellEnv } = process.env;

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
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    },

    async shell(command, options = {}): Promise<ShellResult> {
      const cwd = options.cwd ? guardPath(normalizedProjectDir, options.cwd) : normalizedProjectDir;
      const child = spawn("sh", ["-c", command], {
        cwd,
        env: shellEnv,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
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
        if (pgid) untrack(pgid);
        return { exitCode: 1, stdout: "", stderr: (spawnError as Error).message };
      }
    },

    async fetch(url, options = {}) {
      const response = await globalThis.fetch(url, {
        method: options.method ?? "GET",
        headers: options.headers,
        body: options.body,
        signal,
      });

      const raw = await response.text();
      const body = raw.length > MAX_FETCH_BODY
        ? raw.slice(0, MAX_FETCH_BODY) + "\n[trama] response body truncated at 10MB"
        : raw;

      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => { headers[k] = v; });

      return { status: response.status, body, headers };
    }
  };
}
