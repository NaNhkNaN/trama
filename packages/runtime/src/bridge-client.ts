// The program's end of the IPC bridge: how code running inside a program
// reaches the runner that started it (ipc-server.ts is the other end).

import { readFileSync } from "fs";
import { request } from "http";

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

  // A call lasts as long as the work behind it — an agent run, or a wait for
  // another program — so this uses node:http, which sets no deadline for the
  // response. (fetch gives up after five minutes without response headers.)
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
