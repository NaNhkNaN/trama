import { spawn, type ChildProcess } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname, sep } from "path";
import type { Tools, ShellResult } from "./types.js";

export interface ToolsWithCleanup extends Tools {
  /** Kill all in-flight shell processes. Called by runner on timeout/error. */
  killActiveShells(): void;
}

export function createTools(projectDir: string): ToolsWithCleanup {
  const normalizedProjectDir = resolve(projectDir);
  const activeShells = new Set<ChildProcess>();

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
        proc.kill("SIGKILL");
      }
      activeShells.clear();
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
        });
        activeShells.add(child);

        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let exited = false;

        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; });
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });

        child.on("error", (err) => {
          activeShells.delete(child);
          resolve({ exitCode: 1, stdout, stderr: err.message });
        });

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!exited) child.kill("SIGKILL");
          }, 5000);
        }, timeout);

        child.on("close", (code) => {
          exited = true;
          activeShells.delete(child);
          clearTimeout(timer);
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
      });

      const body = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => { headers[k] = v; });

      return { status: response.status, body, headers };
    }
  };
}
