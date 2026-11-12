// The runner side of the IPC bridge. A running program.ts reaches ctx, agent,
// tools and workspace by POSTing JSON to this local HTTP server (see client.ts
// for the other end).

import { createServer, type Server } from "http";
import { timingSafeEqual } from "crypto";
import type { Agent, Tools, Workspace } from "./types.js";
import type { RunContext } from "./context.js";
import type { ProgramResult, RunRequest } from "./runner-types.js";
import type { Journal } from "./journal.js";
import { isJsonObject } from "./serializable.js";

const MAX_IPC_BODY = 50 * 1024 * 1024; // 50 MB

/** A request the program got wrong — answered with 400 rather than 500. */
class BadRequest extends Error {}

/** The kinds of value a call's field may hold, and what each is to the code that carries the call out. */
interface FieldKinds {
  string: string;
  number: number;
  object: Record<string, unknown>;
  /** Anything JSON can say. */
  any: unknown;
}
type Kind = keyof FieldKinds;
type Fields = Record<string, Kind | `optional ${Kind}`>;

/** A call's fields as its handler is given them: the ones it declares and no others, each of the kind declared. */
type Args<F extends Fields> = {
  [K in keyof F]: F[K] extends `optional ${infer T extends Kind}` ? FieldKinds[T] | undefined
    : F[K] extends Kind ? FieldKinds[F[K]] : never;
};

interface Route {
  /**
   * Carry a call out, given the body of its request. `connectionClosed`
   * resolves when the caller's connection ends, answered or not. `seq` is the
   * call's position among the run's calls.
   */
  handle(body: unknown, connectionClosed: Promise<void>, seq: number): unknown;
}

const isOfKind = (value: unknown, kind: Kind): boolean =>
  kind === "any" ? value !== undefined : kind === "object" ? isJsonObject(value) : typeof value === kind;

/** Read a call's declared fields out of a request body — refusing a body that does not hold them as declared. */
function read<F extends Fields>(body: unknown, fields: F): Args<F> {
  if (!isJsonObject(body)) throw new BadRequest("The request body must be a JSON object");
  const args: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields)) {
    const optional = field.startsWith("optional ");
    const kind = (optional ? field.slice("optional ".length) : field) as Kind;
    const value = body[name];
    // null is how JSON says a field is not there: an optional one given as null was left out.
    if (optional && value == null) continue;
    if (!isOfKind(value, kind)) {
      throw new BadRequest(optional
        ? `Invalid field: ${name} (expected ${kind} or undefined)`
        : `Missing or invalid field: ${name} (expected ${kind})`);
    }
    args[name] = value;
  }
  return args as Args<F>;
}

/**
 * A call: every field it takes, and what is done with them. The declaration
 * is the whole of what a handler sees of a request — a field that is not
 * declared does not reach it, and one that is arrives as the kind it says.
 * (What is inside an object is the business of whoever it is handed to.)
 */
function route<F extends Fields>(
  fields: F,
  handle: (args: Args<F>, connectionClosed: Promise<void>, seq: number) => unknown,
): Route {
  return { handle: (body, connectionClosed, seq) => handle(read(body, fields), connectionClosed, seq) };
}

export interface IpcBackends {
  /**
   * The secret only this run's program knows. Every request must present it:
   * the server listens on a loopback port that any local process — or a web
   * page the user happens to have open — could otherwise send commands to.
   */
  token: string;
  ctx: RunContext;
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
}

/** Whether a request carries `Authorization: Bearer <token>`, compared in constant time. */
function isAuthorized(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function buildRoutes({ ctx, agent, tools, workspace, workspaceAt, run }: IpcBackends): Record<string, Route> {
  /** Runs the program has asked for and that have not ended, by the id it gave each. */
  const runsAskedFor = new Map<string, AbortController>();
  /** Ids the program asked to stop before their run was seen here: such a run starts stopped. */
  const stoppedAhead = new Set<string>();

  /** The workspace a call is about: the directory it names, or else the one this run was started with. */
  const workspaceOf = (dir: string | undefined): Workspace => {
    if (dir !== undefined) {
      if (dir === "") throw new BadRequest("Invalid field: dir (expected a directory path)");
      return workspaceAt(dir);
    }
    if (!workspace) throw new BadRequest("Workspace is only available when running in a session");
    return workspace;
  };

  return {
    "/agent/instruct": route(
      { prompt: "string", system: "optional string" },
      b => agent.instruct(b.prompt, { system: b.system }),
    ),
    "/agent/generate": route(
      { prompt: "string", schema: "object", system: "optional string" },
      b => agent.generate({ prompt: b.prompt, schema: b.schema as Record<string, string>, system: b.system }),
    ),

    "/tools/read": route({ path: "string" }, b => tools.read(b.path)),
    "/tools/write": route({ path: "string", content: "string" }, b => tools.write(b.path, b.content)),
    "/tools/shell": route(
      { command: "string", cwd: "optional string", timeout: "optional number" },
      b => tools.shell(b.command, { cwd: b.cwd, timeout: b.timeout }),
    ),
    "/tools/fetch": route(
      { url: "string", method: "optional string", headers: "optional object", body: "optional string" },
      b => tools.fetch(b.url, { method: b.method, headers: b.headers as Record<string, string> | undefined, body: b.body }),
    ),

    "/ctx/log": route({ message: "string", data: "optional any" }, b => ctx.log(b.message, b.data)),
    "/ctx/ready": route({ data: "optional object" }, b => ctx.ready(b.data)),
    // The state is the program's: each call that persists it hands over its current copy.
    "/ctx/checkpoint": route({ state: "object" }, b => ctx.checkpoint(b.state)),
    "/ctx/done": route({ state: "object", result: "optional any" }, b => ctx.done(b.state, b.result)),
    // Persists the yield marker and returns; the program exits itself once it is answered.
    "/ctx/yield": route({ state: "object", reason: "string" }, b => ctx.yield(b.state, b.reason)),

    // A program never runs another program: it asks its runner to. The call
    // lasts as long as the run does, repairs included.
    "/run/program": route(
      {
        projectDir: "string", args: "optional object",
        timeout: "optional number", maxRepairAttempts: "optional number",
        id: "optional string", label: "optional string", workspaceDir: "optional string",
      },
      async ({ id, ...request }, connectionClosed, seq) => {
        const stop = new AbortController();
        // A caller that is gone — its process died, or it gave up — no longer wants the run.
        void connectionClosed.then(() => stop.abort());
        // `id` is the name the program gave the run, to stop it by.
        if (id && stoppedAhead.delete(id)) stop.abort();
        if (id) runsAskedFor.set(id, stop);
        try {
          return await run(request, stop.signal, seq);
        } finally {
          if (id) runsAskedFor.delete(id);
        }
      },
    ),
    // Stop a run asked for above. The call that asked for it still gets its
    // answer — a failed run — once the run is over.
    "/run/stop": route({ id: "string" }, b => {
      const asked = runsAskedFor.get(b.id);
      if (asked) asked.abort();
      else stoppedAhead.add(b.id);
    }),

    "/workspace/read": route({ path: "string", dir: "optional string" }, b => workspaceOf(b.dir).read(b.path)),
    "/workspace/write": route(
      { path: "string", content: "string", dir: "optional string" },
      b => workspaceOf(b.dir).write(b.path, b.content),
    ),
    "/workspace/list": route({ pattern: "string", dir: "optional string" }, b => workspaceOf(b.dir).list(b.pattern)),
    "/workspace/observe": route(
      { pattern: "string", dir: "optional string", expect: "optional number", timeout: "optional number" },
      b => workspaceOf(b.dir).observe(b.pattern, { expect: b.expect, timeout: b.timeout }),
    ),
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
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        } catch {
          return reply(400, "The request body is not valid JSON");
        }
        const route = req.url ? routes[req.url] : undefined;
        if (!route) return reply(404, "Not found");
        call = backends.journal.call(req.url!, body);
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
      server.removeListener("error", reject);
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
