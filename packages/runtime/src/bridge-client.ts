// The program's end of the IPC bridge: how code running inside a program
// reaches the runner that started it (ipc-server.ts is the other end).

import { readFileSync } from "fs";
import { request } from "http";
import type { Workspace } from "./types.js";

export interface Bridge {
  /** What the runner handed the program when it started it — the bridge secret among it. */
  init: Record<string, any>;
  /** POST one call to the runner and return its result. */
  call(endpoint: string, body: unknown): Promise<any>;
}

/**
 * @param port - the runner's loopback port (TRAMA_PORT)
 * @param initPath - the file the runner wrote for this program (TRAMA_INIT)
 */
export function openBridge(port: string, initPath: string): Bridge {
  const init = JSON.parse(readFileSync(initPath, "utf-8"));

  // A call lasts as long as the work behind it — an agent run, or the whole
  // run of another program — so this uses node:http, which sets no deadline
  // for the response. (fetch gives up after five minutes without response headers.)
  const call = (endpoint: string, body: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = request({
        host: "127.0.0.1",
        port,
        path: endpoint,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "Authorization": `Bearer ${init.token}`,
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          if (res.statusCode !== 200) reject(new Error(`trama runtime error: ${text}`));
          else resolve(JSON.parse(text).result);
        });
      });
      req.on("error", reject);
      req.end(payload);
    });

  return { init, call };
}

let parent: Bridge | null | undefined;

/**
 * The bridge to the runner that started this process as a program — or null
 * when this process is not a program, and so is itself where runs happen.
 */
export function parentBridge(): Bridge | null {
  if (parent === undefined) {
    const { TRAMA_PORT: port, TRAMA_INIT: initPath } = process.env;
    try {
      parent = port && initPath ? openBridge(port, initPath) : null;
    } catch {
      parent = null; // a stale environment: there is no runner to ask
    }
  }
  return parent;
}

/**
 * A workspace reached over a bridge: the directory `dir`, or — without one —
 * the workspace of the session the calling program is running in.
 */
export function remoteWorkspace(call: Bridge["call"], dir?: string): Workspace {
  return {
    read: (path) => call("/workspace/read", { dir, path }),
    write: (path, content) => call("/workspace/write", { dir, path, content }),
    list: (pattern) => call("/workspace/list", { dir, pattern }),
    observe: (pattern, options) => call("/workspace/observe", { dir, pattern, ...options }),
  };
}
