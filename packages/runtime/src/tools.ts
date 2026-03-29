import { spawn, spawnSync, type ChildProcess } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname, sep } from "path";
import type { Tools, ShellResult } from "./types.js";

export interface ToolsWithCleanup extends Tools {
  /** Kill all in-flight shell processes. Called by runner on timeout/error. */
  killActiveShells(): void;
}

export function createTools(projectDir: string, signal?: AbortSignal): ToolsWithCleanup {
  const normalizedProjectDir = resolve(projectDir);
  const activeShells = new Set<ChildProcess>();
  const activeSessions = new Set<number>();
  const sessionReapers = new Map<number, ReturnType<typeof setTimeout>>();

  const stopReapingSession = (sessionId: number): void => {
    const timer = sessionReapers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      sessionReapers.delete(sessionId);
    }
  };

  const listSessionPids = (sessionId: number): number[] => {
    const result = spawnSync("ps", ["-o", "pid=", "-s", String(sessionId)], {
      encoding: "utf-8",
    });
    if (result.error) return [];
    return result.stdout
      .split("\n")
      .map(line => parseInt(line.trim(), 10))
      .filter(pid => Number.isInteger(pid) && pid > 0);
  };

  const killSession = (sessionId: number, signal: NodeJS.Signals): void => {
    const pids = listSessionPids(sessionId);
    if (pids.length > 0) {
      for (const pid of pids) {
        try { process.kill(pid, signal); } catch { /* already exited */ }
      }
      return;
    }
    try {
      process.kill(-sessionId, signal);
    } catch { /* already exited */ }
  };

  const reapSessionWhenGone = (sessionId: number): void => {
    stopReapingSession(sessionId);
    const timer = setTimeout(() => {
      if (!activeSessions.has(sessionId)) return;
      if (listSessionPids(sessionId).length === 0) {
        activeSessions.delete(sessionId);
        sessionReapers.delete(sessionId);
        return;
      }
      reapSessionWhenGone(sessionId);
    }, 250);
    timer.unref?.();
    sessionReapers.set(sessionId, timer);
  };

  /**
   * Path traversal guard. Not a security sandbox — just a footgun guard.
   * Uses normalizedProjectDir + sep to prevent /tmp/foo-bar matching /tmp/foo.
   */
  const resolvePath = (p: string): string => {
    const resolved = resolve(normalizedProjectDir, p);
    if (resolved !== normalizedProjectDir && !resolved.startsWith(normalizedProjectDir + sep)) {
      throw new Error(`Path escapes project directory: ${p}`);
    }
    return resolved;
  };

  return {
    killActiveShells() {
      for (const proc of activeShells) {
        if (proc.pid) {
          try { process.kill(-proc.pid, "SIGKILL"); } catch { /* already exited */ }
        }
      }
      for (const sessionId of activeSessions) {
        killSession(sessionId, "SIGKILL");
        stopReapingSession(sessionId);
      }
      activeShells.clear();
      activeSessions.clear();
    },

    async read(path) {
      return readFileSync(resolvePath(path), "utf-8");
    },

    async write(path, content) {
      const target = resolvePath(path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    },

    async shell(command, options = {}) {
      const timeout = options.timeout ?? 30_000;
      const cwd = options.cwd ? resolvePath(options.cwd) : normalizedProjectDir;

      return new Promise<ShellResult>((resolve) => {
        const child = spawn("sh", ["-c", command], {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        });
        activeShells.add(child);
        if (child.pid) activeSessions.add(child.pid);

        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let exited = false;

        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; });
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });

        const timer = setTimeout(() => {
          timedOut = true;
          if (child.pid) {
            killSession(child.pid, "SIGTERM");
          }
          setTimeout(() => {
            if (!exited && child.pid) {
              killSession(child.pid, "SIGKILL");
            }
          }, 5000);
        }, timeout);

        child.on("error", (err) => {
          clearTimeout(timer);
          activeShells.delete(child);
          if (child.pid) {
            activeSessions.delete(child.pid);
            stopReapingSession(child.pid);
          }
          resolve({ exitCode: 1, stdout, stderr: err.message });
        });

        child.on("close", (code) => {
          exited = true;
          activeShells.delete(child);
          clearTimeout(timer);
          if (child.pid) reapSessionWhenGone(child.pid);
          resolve({
            exitCode: timedOut ? 1 : (code ?? 1),
            stdout,
            stderr: timedOut ? stderr + "\ntimeout" : stderr,
          });
        });
      });
    },

    async fetch(url, options = {}) {
      const response = await globalThis.fetch(url, {
        method: options.method ?? "GET",
        headers: options.headers,
        body: options.body,
        signal,
      });

      const body = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => { headers[k] = v; });

      return { status: response.status, body, headers };
    }
  };
}
