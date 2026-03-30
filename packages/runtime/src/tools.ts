import { spawn, spawnSync, type ChildProcess } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, realpathSync, readlinkSync, lstatSync, existsSync } from "fs";
import { resolve, dirname, sep } from "path";
import type { Tools, ShellResult } from "./types.js";

const MAX_OUTPUT = 10 * 1024 * 1024; // 10 MB

export function cappedBuffer() {
  let buf = "";
  let capped = false;
  return {
    append(text: string) {
      if (capped) return;
      buf += text;
      if (buf.length > MAX_OUTPUT) {
        buf = buf.slice(0, MAX_OUTPUT) + "\n[trama] output truncated at 10MB";
        capped = true;
      }
    },
    get value() { return buf; },
  };
}

export interface ToolsWithCleanup extends Tools {
  /** Kill all in-flight shell processes. Called by runner on timeout/error. */
  killActiveShells(): void;
}

export function createTools(projectDir: string, signal?: AbortSignal): ToolsWithCleanup {
  const normalizedProjectDir = resolve(projectDir);
  let realProjectDir: string;
  try { realProjectDir = realpathSync(normalizedProjectDir); } catch { realProjectDir = normalizedProjectDir; }
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
   * Path traversal guard. Checks both logical path (.. segments) and
   * real path (symlinks) to prevent escaping the project directory.
   * Not a security sandbox — just a footgun guard.
   */
  const resolvePath = (p: string): string => {
    const resolved = resolve(normalizedProjectDir, p);
    if (resolved !== normalizedProjectDir && !resolved.startsWith(normalizedProjectDir + sep)) {
      throw new Error(`Path escapes project directory: ${p}`);
    }
    return resolved;
  };

  /** Verify that an existing path's real location is inside the project dir. */
  const verifyRealPath = (real: string, original: string): void => {
    if (real !== realProjectDir && !real.startsWith(realProjectDir + sep)) {
      throw new Error(`Path escapes project directory via symlink: ${original}`);
    }
  };

  /**
   * Walk up from `resolved` to find the deepest existing ancestor,
   * then verify its real path is inside the project dir.
   * This catches symlink escapes BEFORE any mkdir side effects.
   */
  const verifyNearestAncestor = (resolved: string, original: string): void => {
    let cur = resolved;
    while (!existsSync(cur)) {
      const parent = dirname(cur);
      if (parent === cur) return; // reached filesystem root — nothing to verify
      cur = parent;
    }
    verifyRealPath(realpathSync(cur), original);
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
      const target = resolvePath(path);
      verifyRealPath(realpathSync(target), path);
      return readFileSync(target, "utf-8");
    },

    async write(path, content) {
      const target = resolvePath(path);
      verifyNearestAncestor(target, path);       // before mkdir — prevents side effects outside project
      mkdirSync(dirname(target), { recursive: true });
      try {
        if (lstatSync(target).isSymbolicLink()) {
          try { verifyRealPath(realpathSync(target), path); }
          catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
            // Dangling symlink — resolve what we can via nearest existing ancestor
            verifyNearestAncestor(resolve(dirname(target), readlinkSync(target)), path);
          }
        }
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      writeFileSync(target, content);
    },

    async shell(command, options = {}) {
      const timeout = options.timeout ?? 30_000;
      const cwd = options.cwd ? resolvePath(options.cwd) : normalizedProjectDir;
      try {
        if (options.cwd) verifyRealPath(realpathSync(cwd), options.cwd);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        // cwd doesn't exist — spawn will fail with ENOENT on its own
      }

      return new Promise<ShellResult>((resolve) => {
        const child = spawn("sh", ["-c", command], {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        });
        activeShells.add(child);
        if (child.pid) activeSessions.add(child.pid);

        const out = cappedBuffer();
        const err = cappedBuffer();
        let timedOut = false;
        let exited = false;
        let killFallbackTimer: ReturnType<typeof setTimeout> | null = null;

        child.stdout.on("data", (chunk: Buffer) => { out.append(String(chunk)); });
        child.stderr.on("data", (chunk: Buffer) => { err.append(String(chunk)); });

        const timer = setTimeout(() => {
          timedOut = true;
          if (child.pid) {
            killSession(child.pid, "SIGTERM");
          }
          killFallbackTimer = setTimeout(() => {
            if (!exited && child.pid) {
              killSession(child.pid, "SIGKILL");
            }
          }, 5000);
          killFallbackTimer.unref?.();
        }, timeout);

        child.on("error", (spawnError) => {
          clearTimeout(timer);
          if (killFallbackTimer) clearTimeout(killFallbackTimer);
          activeShells.delete(child);
          if (child.pid) {
            activeSessions.delete(child.pid);
            stopReapingSession(child.pid);
          }
          resolve({ exitCode: 1, stdout: out.value, stderr: spawnError.message });
        });

        child.on("close", (code) => {
          exited = true;
          activeShells.delete(child);
          clearTimeout(timer);
          if (killFallbackTimer) clearTimeout(killFallbackTimer);
          if (child.pid) reapSessionWhenGone(child.pid);
          resolve({
            exitCode: timedOut ? 1 : (code ?? 1),
            stdout: out.value,
            stderr: timedOut ? err.value + "\ntimeout" : err.value,
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

      const raw = await response.text();
      const body = raw.length > MAX_OUTPUT
        ? raw.slice(0, MAX_OUTPUT) + "\n[trama] response body truncated at 10MB"
        : raw;

      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => { headers[k] = v; });

      return { status: response.status, body, headers };
    }
  };
}
