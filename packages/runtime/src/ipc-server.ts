// The runner side of the IPC bridge. A running program.ts reaches ctx, agent,
// tools and workspace by POSTing JSON to this local HTTP server (see client.ts
// for the other end).

import { createServer, type Server } from "http";
import { timingSafeEqual } from "crypto";
import type { Ctx, Agent, Tools, Workspace } from "./types.js";
import type { ProgramResult, RunRequest } from "./runner-types.js";
import type { Journal } from "./journal.js";
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
  /**
   * `connectionClosed` resolves when the caller's connection ends, answered or
   * not. `seq` is the call's position among the run's calls.
   */
  handle(body: Body, connectionClosed: Promise<void>, seq: number): unknown;
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
  /** The workspace of the session the program is running in — null when it is in none. */
  workspace: Workspace | null;
  /** A workspace by directory, for a program that created a session rather than joined one. */
  workspaceAt(dir: string): Workspace;
  /**
   * Run another project on the program's behalf, until it ends or `stop` says
   * to stop it. `seq` is the position of the call that asked for it.
   */
  run(request: RunRequest, stop: AbortSignal, seq: number): Promise<ProgramResult>;
  /** Where every call, and how it ended, is written down. */
  journal: Journal;
  /** Called once ctx.done() or ctx.yield() has been persisted for this run. */
  onTerminalSignal(result: ProgramResult): void;
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

function buildRoutes({ ctx, agent, tools, workspace, workspaceAt, run, onTerminalSignal }: IpcBackends): Record<string, Route> {
  /** The program owns ctx.state; each persisting call hands over its current copy. */
  const adoptState = (state: Record<string, unknown>) => {
    assertSerializable(state, "ctx.state");
    ctx.state = state;
  };
  /** Runs the program has asked for and that have not ended, by the id it gave each. */
  const runsAskedFor = new Map<string, AbortController>();
  /** Ids the program asked to stop before their run was seen here: such a run starts stopped. */
  const stoppedAhead = new Set<string>();

  /** The workspace a call is about: the directory it names, or else the one this run was started with. */
  const workspaceOf = (body: Body): Workspace => {
    if (body.dir !== undefined) {
      if (typeof body.dir !== "string" || body.dir === "") throw new BadRequest("Invalid field: dir (expected a directory path)");
      return workspaceAt(body.dir);
    }
    if (!workspace) throw new BadRequest("Workspace is only available when running in a session");
    return workspace;
  };

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

    // A program never runs another program: it asks its runner to. The call
    // lasts as long as the run does, repairs included.
    "/run/program": {
      fields: { projectDir: "string", args: "optional object" },
      handle: async (b, connectionClosed, seq) => {
        const stop = new AbortController();
        // A caller that is gone — its process died, or it gave up — no longer wants the run.
        void connectionClosed.then(() => stop.abort());
        const id: string | undefined = typeof b.id === "string" ? b.id : undefined;
        if (id && stoppedAhead.delete(id)) stop.abort();
        if (id) runsAskedFor.set(id, stop);
        try {
          return await run({
            projectDir: b.projectDir,
            args: b.args,
            timeout: b.timeout,
            maxRepairAttempts: b.maxRepairAttempts,
            workspaceDir: b.workspaceDir,
            label: b.label,
          }, stop.signal, seq);
        } finally {
          if (id) runsAskedFor.delete(id);
        }
      },
    },
    // Stop a run asked for above. The call that asked for it still gets its
    // answer — a failed run — once the run is over.
    "/run/stop": {
      fields: { id: "string" },
      handle: b => {
        const asked = runsAskedFor.get(b.id);
        if (asked) asked.abort();
        else stoppedAhead.add(b.id);
      },
    },

    "/workspace/read": { fields: { path: "string" }, handle: b => workspaceOf(b).read(b.path) },
    "/workspace/write": {
      fields: { path: "string", content: "string" },
      handle: b => workspaceOf(b).write(b.path, b.content),
    },
    "/workspace/list": { fields: { pattern: "string" }, handle: b => workspaceOf(b).list(b.pattern) },
    "/workspace/observe": {
      fields: { pattern: "string" },
      handle: b => workspaceOf(b).observe(b.pattern, { expect: b.expect, timeout: b.timeout }),
    },
  };
}

export function createIPCServer(backends: IpcBackends): Server {
  const routes = buildRoutes(backends);

  return createServer((req, res) => {
    const connectionClosed = new Promise<void>(resolve => res.once("close", resolve));
    // An answer can be given once, and only while there is someone to give it to.
    const answerable = () => !res.writableEnded && !res.destroyed;
    const reply = (status: number, body: string, json = false) => {
      if (!answerable()) return;
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
        // Answer now, and let the rest of the body arrive and be discarded.
        // Cutting the connection instead would race the answer: a sender still
        // writing sees a broken connection, not the reason for it.
        overflow = true;
        chunks.length = 0;
        reply(413, "IPC request body exceeds 50MB limit");
      }
    });
    req.on("end", async () => {
      if (overflow) return;
      // Written down as soon as it can be read, and again when it is answered.
      // What comes back for a caller that is gone is not an answer, and is not
      // recorded as one: a call nobody was left to answer has no result.
      let call: ReturnType<Journal["call"]> | undefined;
      try {
        const body: Body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        const route = req.url ? routes[req.url] : undefined;
        if (!route) return reply(404, "Not found");
        call = backends.journal.call(req.url!, body);
        validate(body, route.fields);
        const result = (await route.handle(body, connectionClosed, call.seq)) ?? null;
        if (answerable()) call.end({ ok: true, result });
        reply(200, JSON.stringify({ result }), true);
      } catch (err) {
        const refused = err instanceof BadRequest;
        const error = refused ? err.message : String(err);
        if (answerable()) call?.end({ ok: false, error });
        reply(refused ? 400 : 500, error);
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
