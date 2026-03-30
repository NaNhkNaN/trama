import { spawn, type ChildProcess } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, realpathSync, lstatSync } from "fs";
import { resolve, dirname } from "path";
import { StringDecoder } from "string_decoder";
import type { Tools, ShellResult } from "./types.js";
import { resolveBounded, verifyRealPath, verifyNearestAncestor, verifySymlink } from "./path-guard.js";

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

  const killSession = (sessionId: number, signal: NodeJS.Signals): void => {
    try {
      process.kill(-sessionId, signal);
    } catch { /* already exited */ }
  };

  /** Poll until the process group is gone, then remove from tracking. */
  const reapSessionWhenGone = (sessionId: number): void => {
    stopReapingSession(sessionId);
    const timer = setTimeout(() => {
      if (!activeSessions.has(sessionId)) return;
      try {
        process.kill(-sessionId, 0); // signal 0: check if process group still exists
      } catch {
        // ESRCH — process group gone
        activeSessions.delete(sessionId);
        sessionReapers.delete(sessionId);
        return;
      }
      reapSessionWhenGone(sessionId);
    }, 250);
    timer.unref?.();
    sessionReapers.set(sessionId, timer);
  };

  const resolvePath = (p: string): string => resolveBounded(normalizedProjectDir, p);

  const checkRealPath = (real: string, original: string): void =>
    verifyRealPath(real, realProjectDir, original);

  const checkNearestAncestor = (resolved: string, original: string): void =>
    verifyNearestAncestor(resolved, realProjectDir, original);

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
      let real: string;
      try { real = realpathSync(target); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`File not found: ${path}`);
        }
        throw e;
      }
      checkRealPath(real, path);
      return readFileSync(target, "utf-8");
    },

    async write(path, content) {
      const target = resolvePath(path);
      checkNearestAncestor(target, path);       // before mkdir — prevents side effects outside project
      mkdirSync(dirname(target), { recursive: true });
      try {
        if (lstatSync(target).isSymbolicLink()) {
          verifySymlink(target, realProjectDir, path);
        }
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      writeFileSync(target, content);
    },

    async shell(command, options = {}) {
      const timeout = options.timeout ?? 30_000;
      const cwd = options.cwd ? resolvePath(options.cwd) : normalizedProjectDir;
      try {
        if (options.cwd) checkRealPath(realpathSync(cwd), options.cwd);
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
        const outDecoder = new StringDecoder("utf-8");
        const errDecoder = new StringDecoder("utf-8");
        let timedOut = false;
        let exited = false;
        let killFallbackTimer: ReturnType<typeof setTimeout> | null = null;

        child.stdout.on("data", (chunk: Buffer) => { out.append(outDecoder.write(chunk)); });
        child.stderr.on("data", (chunk: Buffer) => { err.append(errDecoder.write(chunk)); });

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
          const outFlush = outDecoder.end();
          const errFlush = errDecoder.end();
          if (outFlush) out.append(outFlush);
          if (errFlush) err.append(errFlush);
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
