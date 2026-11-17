// The program's end of the IPC bridge: how code running inside a program
// reaches the runner that started it (ipc-server.ts is the other end).

import { readFileSync } from "fs";
import { Agent, request } from "http";
import type { Workspace } from "./types.js";
import { messageOf } from "./errors.js";

export interface Bridge {
  /** What the runner handed the program when it started it — the bridge secret among it. */
  init: Record<string, any>;
  /** POST one call to the runner and return its result. */
  call(endpoint: string, body: unknown): Promise<any>;
}

let cached: { port: string; initPath: string; bridge: Bridge | null } | undefined;

/**
 * How calls reach the runner: straight to it. Not by way of a proxy that the
 * program's environment names for its HTTP — which node's own agent would
 * take, and hand the call, with the bridge's secret, to. (Otherwise as node's
 * own agent is.)
 */
const direct = new Agent({ keepAlive: true, scheduling: "lifo", timeout: 5000 });

/**
 * A call's body as it goes over the bridge. JSON has no way to say NaN or
 * Infinity, a function or a symbol: it writes null for them or leaves them
 * out, which the other end reads as a field that was not given. So what it
 * cannot carry is refused here — a call is carried out as it was made, or not
 * at all.
 */
function encode(endpoint: string, body: unknown): string {
  return JSON.stringify(body, function (this: unknown, name: string, value: unknown) {
    const lost = typeof value === "number" && !Number.isFinite(value) ? String(value)
      : typeof value === "function" || typeof value === "symbol" ? `a ${typeof value}`
      : undefined;
    if (lost !== undefined) {
      const where = Array.isArray(this) ? `item ${name} of a list` : name || "what the call is made with";
      throw new TypeError(`${where} is ${lost}, which cannot be sent to the runner (${endpoint})`);
    }
    return value;
  });
}

/**
 * The body of a call that takes options: what the call is made with, and the
 * options beside it. An option that bears the name of one of those is not an
 * option — and would otherwise take its place.
 */
export function withOptions(madeWith: Record<string, unknown>, options?: object | null): Record<string, unknown> {
  const taken = Object.keys(options ?? {}).find(name => Object.hasOwn(madeWith, name));
  if (taken !== undefined) throw new TypeError(`${taken} is what the call is made with, and cannot be given as an option`);
  return { ...madeWith, ...options };
}

/**
 * @param port - the runner's loopback port (TRAMA_PORT)
 * @param initPath - the file the runner wrote for this program (TRAMA_INIT)
 */
export function openBridge(port: string, initPath: string): Bridge {
  if (cached?.bridge && cached.port === port && cached.initPath === initPath) {
    return cached.bridge;
  }
  const init = JSON.parse(readFileSync(initPath, "utf-8"));

  // A call lasts as long as the work behind it — an agent run, or the whole
  // run of another program — so this uses node:http, which sets no deadline
  // for the response. (fetch gives up after five minutes without response headers.)
  const call = (endpoint: string, body: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      const payload = encode(endpoint, body);
      const req = request({
        host: "127.0.0.1",
        port,
        path: endpoint,
        method: "POST",
        agent: direct,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "Authorization": `Bearer ${init.token}`,
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        // (An answer that is cut off is an error of the response, above: it never comes to an end.)
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          if (res.statusCode !== 200) return reject(new Error(`trama runtime error: ${text}`));
          // Whatever is wrong with an answer is the call's to fail with — not thrown at whoever is on the stack.
          try {
            resolve(JSON.parse(text).result);
          } catch (err) {
            reject(new Error(`trama runtime error: the runner's answer to ${endpoint} cannot be read: ${messageOf(err)}`));
          }
        });
      });
      req.on("error", reject);
      req.end(payload);
    });

  const bridge: Bridge = { init, call };
  cached = { port, initPath, bridge };
  return bridge;
}

/**
 * The bridge to the runner that started this process as a program — or null
 * when this process is not a program, and so is itself where runs happen.
 */
export function parentBridge(): Bridge | null {
  const { TRAMA_PORT: port, TRAMA_INIT: initPath } = process.env;
  if (!port || !initPath) return null;
  if (cached && cached.port === port && cached.initPath === initPath) {
    return cached.bridge;
  }
  try {
    return openBridge(port, initPath);
  } catch {
    cached = { port, initPath, bridge: null }; // a stale environment: there is no runner to ask
    return null;
  }
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
    observe: async (pattern, options) => call("/workspace/observe", withOptions({ dir, pattern }, options)),
  };
}
