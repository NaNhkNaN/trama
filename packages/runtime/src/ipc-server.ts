// The runner side of the IPC bridge. A running program.ts reaches ctx, agent,
// tools and workspace by POSTing JSON to this local HTTP server (see client.ts
// for the other end).

import { createServer, type Server } from "http";
import { timingSafeEqual } from "crypto";
import type { Ctx, Agent, Tools, Workspace } from "./types.js";
import type { ProgramResult } from "./runner-types.js";
import { assertSerializable } from "./serializable.js";

const MAX_IPC_BODY = 50 * 1024 * 1024; // 50 MB

/** A request the program got wrong — answered with 400 rather than 500. */
class BadRequest extends Error {}

type FieldType = "string" | "object" | "optional object";

/** A request body: its fields are validated per route, then handled untyped. */
type Body = Record<string, any>;

interface Route {
  /** Body fields checked before the handler runs. */
  fields: Record<string, FieldType>;
  handle(body: Body): unknown;
}

export interface IpcBackends {
  /**
   * The secret only this run's program knows. Every request must present it:
   * the server listens on a loopback port that any local process — or a web
   * page the user happens to have open — could otherwise send commands to.
   */
  token: string;
  ctx: Ctx;
  agent: Agent;
  tools: Tools;
  /** Null when the program is not running in a session. */
  workspace: Workspace | null;
  /** Called once ctx.done() or ctx.yield() has been persisted for this run. */
  onTerminalSignal(result: ProgramResult): void;
  /** Stop the program's clock until the returned function is called (see Allowance). */
  holdClock(): () => void;
}

const isPlainObject = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);

function validate(body: Body, fields: Record<string, FieldType>): void {
  for (const [name, type] of Object.entries(fields)) {
    const value = body[name];
    if (type === "optional object") {
      if (value !== undefined && !isPlainObject(value)) {
        throw new BadRequest(`Invalid field: ${name} (expected object or undefined)`);
      }
    } else if (type === "object" ? !isPlainObject(value) : typeof value !== type) {
      throw new BadRequest(`Missing or invalid field: ${name} (expected ${type})`);
    }
  }
}

/** Whether a request carries `Authorization: Bearer <token>`, compared in constant time. */
function isAuthorized(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function buildRoutes({ ctx, agent, tools, workspace, onTerminalSignal, holdClock }: IpcBackends): Record<string, Route> {
  /** The program owns ctx.state; each persisting call hands over its current copy. */
  const adoptState = (state: Record<string, unknown>) => {
    assertSerializable(state, "ctx.state");
    ctx.state = state;
  };
  const inSession = (): Workspace => {
    if (!workspace) throw new BadRequest("Workspace is only available when running in a session");
    return workspace;
  };
  /** Runs the program has started and not yet seen end, each holding its clock. */
  const nestedRuns = new Map<string, () => void>();
  let nestedRunCount = 0;

  return {
    "/agent/instruct": {
      fields: { prompt: "string" },
      handle: b => agent.instruct(b.prompt, { system: b.system }),
    },
    "/agent/generate": {
      fields: { prompt: "string", schema: "object" },
      handle: b => agent.generate(b as Parameters<Agent["generate"]>[0]),
    },

    "/tools/read": { fields: { path: "string" }, handle: b => tools.read(b.path) },
    "/tools/write": { fields: { path: "string", content: "string" }, handle: b => tools.write(b.path, b.content) },
    "/tools/shell": {
      fields: { command: "string" },
      handle: b => tools.shell(b.command, { cwd: b.cwd, timeout: b.timeout }),
    },
    "/tools/fetch": {
      fields: { url: "string" },
      handle: b => tools.fetch(b.url, { method: b.method, headers: b.headers, body: b.body }),
    },

    "/ctx/log": { fields: { message: "string" }, handle: b => ctx.log(b.message, b.data) },
    "/ctx/ready": { fields: { data: "optional object" }, handle: b => ctx.ready(b.data) },
    "/ctx/checkpoint": {
      fields: { state: "object" },
      handle: async b => {
        adoptState(b.state);
        await ctx.checkpoint();
        return ctx.iteration;
      },
    },
    "/ctx/done": {
      fields: { state: "object" },
      handle: async b => {
        adoptState(b.state);
        await ctx.done(b.result);
        onTerminalSignal({ status: "done", result: b.result ?? undefined });
        return ctx.iteration;
      },
    },
    "/ctx/yield": {
      fields: { state: "object", reason: "string" },
      handle: async b => {
        adoptState(b.state);
        // Persists the yield marker and returns; the program exits itself once we answer.
        await ctx.yield(b.reason);
        onTerminalSignal({ status: "yielded", reason: b.reason });
      },
    },

    // A run the program starts — a session participant — is under a timeout
    // of its own. The program's clock stops for as long as that run lasts.
    "/nested-run/begin": {
      fields: {},
      handle: () => {
        const id = String(++nestedRunCount);
        nestedRuns.set(id, holdClock());
        return id;
      },
    },
    "/nested-run/end": {
      fields: { id: "string" },
      handle: b => {
        nestedRuns.get(b.id)?.();
        nestedRuns.delete(b.id);
      },
    },

    "/workspace/read": { fields: { path: "string" }, handle: b => inSession().read(b.path) },
    "/workspace/write": {
      fields: { path: "string", content: "string" },
      handle: b => inSession().write(b.path, b.content),
    },
    "/workspace/list": { fields: { pattern: "string" }, handle: b => inSession().list(b.pattern) },
    "/workspace/observe": {
      fields: { pattern: "string" },
      handle: b => inSession().observe(b.pattern, { expect: b.expect, timeout: b.timeout }),
    },
  };
}

export function createIPCServer(backends: IpcBackends): Server {
  const routes = buildRoutes(backends);

  return createServer((req, res) => {
    const reply = (status: number, body: string, json = false) => {
      res.writeHead(status, json ? { "Content-Type": "application/json" } : undefined);
      res.end(body);
    };

    if (req.method !== "POST") return reply(405, "Method not allowed");
    if (!isAuthorized(req.headers.authorization, backends.token)) {
      req.resume(); // discard the body
      return reply(401, "Missing or invalid IPC token");
    }

    const chunks: Buffer[] = [];
    let byteCount = 0;
    let overflow = false;
    req.on("data", (chunk: Buffer) => {
      if (overflow) return;
      chunks.push(chunk);
      byteCount += chunk.length;
      if (byteCount > MAX_IPC_BODY) {
        overflow = true;
        reply(413, "IPC request body exceeds 50MB limit");
        req.destroy();
      }
    });
    req.on("end", async () => {
      if (overflow) return;
      try {
        const body: Body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        const route = req.url ? routes[req.url] : undefined;
        if (!route) return reply(404, "Not found");
        validate(body, route.fields);
        const result = await route.handle(body);
        reply(200, JSON.stringify({ result: result ?? null }), true);
      } catch (err) {
        reply(err instanceof BadRequest ? 400 : 500, err instanceof BadRequest ? err.message : String(err));
      }
    });
  });
}

/** Start listening on an ephemeral loopback port and return it. */
export function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("Failed to get server port"));
    });
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(err => {
      if (!err || (err as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") resolve();
      else reject(err);
    });
  });
}
