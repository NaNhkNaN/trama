// The runner side of the IPC bridge. A running program.ts reaches ctx, agent,
// tools and workspace by POSTing JSON to this local HTTP server (see
// bridge-client.ts for the other end, and client.ts for what is made of it).

import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { timingSafeEqual } from "crypto";
import type { Tools, Workspace } from "./types.js";
import type { RunnerAgent } from "./agent.js";
import type { RunContext } from "./context.js";
import type { MakeRequest, ProgramResult, RunRequest } from "./runner-types.js";
import { OFF_THE_RECORD, type Journal, type RecordedCall } from "./journal.js";
import type { OwnTool } from "./agent-backend.js";
import { createToolAsks, imagesOf, toolsOf } from "./own-tools.js";
import { describeJson, isJsonObject } from "./serializable.js";
import { checkedEnv, variableName } from "./child-process.js";
import { checkedBudget, type Budget } from "./budget.js";
import { checkedRepairAttempts, checkedTimeout } from "./project.js";
import { messageOf } from "./errors.js";

const MAX_IPC_BODY = 50 * 1024 * 1024; // 50 MB
const MAX_STOPPED_AHEAD = 1024;

/** A request the program got wrong — answered with 400 rather than 500. */
class BadRequest extends Error {}

/** The kinds of value a call's field may hold, and what each is to the code that carries the call out. */
interface FieldKinds {
  string: string;
  number: number;
  boolean: boolean;
  object: Record<string, unknown>;
  /** A list of tools: each by its name, or — one of the program's own — as an object that declares it. */
  "strings or tools": unknown[];
  /** All or none of something, or some of it by name. */
  "boolean or strings": boolean | string[];
  /** All or none of something, or which of it in a word. */
  "boolean or string": boolean | string;
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

/** Fields that are the client's own way of carrying a call, and nothing a program says: not among what a call is said to take. */
const CARRIES = new Set(["toolsId"]);

interface Route {
  /**
   * It is no call of the program's, but part of how one is carried — the
   * program's client waiting to be asked for a tool, or saying what one
   * answered: what it carries is on record with the call it is for.
   */
  offTheRecord?: boolean;
  /**
   * Carry a call out, given the body of its request. `connectionClosed`
   * resolves when the caller's connection ends, answered or not. `call` is
   * the call as it is on record: its position among the run's calls, and
   * where what it used is written down.
   */
  handle(body: unknown, connectionClosed: Promise<void>, call: RecordedCall): unknown;
}

const isStrings = (value: unknown): boolean => Array.isArray(value) && value.every(item => typeof item === "string");

const isOfKind = (value: unknown, kind: Kind): boolean =>
  kind === "any" ? value !== undefined
    : kind === "object" ? isJsonObject(value)
    : kind === "strings or tools" ? Array.isArray(value) && value.every(item => typeof item === "string" || isJsonObject(item))
    : kind === "boolean or strings" ? typeof value === "boolean" || isStrings(value)
    : kind === "boolean or string" ? typeof value === "boolean" || typeof value === "string"
    : typeof value === kind;

/** Read a call's declared fields out of a request body — refusing a body that does not hold them as declared, or holds any other. */
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
  // What a call does not declare it cannot do anything with: to pass it over would be to let its sender think it had.
  const unknown = Object.keys(body).find(name => !Object.hasOwn(fields, name));
  if (unknown !== undefined) {
    throw new BadRequest(`Unknown field: ${unknown} (this call takes: ${Object.keys(fields).filter(name => !CARRIES.has(name)).join(", ")})`);
  }
  return args as Args<F>;
}

/**
 * A call: every field it takes, and what is done with them. The declaration
 * is the whole of what a request may hold — a field that is not declared
 * is refused, and one that is arrives as the kind it says.
 * (What is inside an object is the business of whoever it is handed to.)
 */
function route<F extends Fields>(
  fields: F,
  handle: (args: Args<F>, connectionClosed: Promise<void>, call: RecordedCall) => unknown,
  how: Pick<Route, "offTheRecord"> = {},
): Route {
  return { ...how, handle: (body, connectionClosed, call) => handle(read(body, fields), connectionClosed, call) };
}

/**
 * Read what a request gave by whoever knows what it is to be: what that
 * finds wrong with it is the request's fault, said in its words (`as` has
 * them say which field it was).
 */
function asGiven<T>(read: () => T, as: (why: string) => string = why => why): T {
  try {
    return read();
  } catch (err) {
    throw new BadRequest(as(messageOf(err)));
  }
}

/** A field that names itself in what is wrong with it. */
const ofAField = (why: string) => `Invalid field: ${why}`;

/** The variables a call gives, held to what variables are (see checkedEnv). */
const envOf = (env: Record<string, unknown> | undefined): Record<string, string> | undefined =>
  env === undefined ? undefined : asGiven(() => checkedEnv(env), ofAField);

/** The budget a call gives a run, held to what a budget is (see checkedBudget). */
const budgetOf = (budget: Record<string, unknown> | undefined): Budget | undefined =>
  budget === undefined ? undefined : asGiven(() => checkedBudget(budget), ofAField);

/** A run's time and its count of attempts, where a call gives them: held to what each is before the run is looked for. */
const timeoutOf = (timeout: number | undefined): number | undefined => (timeout === undefined ? undefined : asGiven(() => checkedTimeout(timeout)));
const attemptsOf = (attempts: number | undefined): number | undefined => (attempts === undefined ? undefined : asGiven(() => checkedRepairAttempts(attempts)));

/** The headers a request is to go with: names and their text. */
function headersOf(headers: Record<string, unknown> | undefined): Record<string, string> | undefined {
  const [name, value] = Object.entries(headers ?? {}).find(([, value]) => typeof value !== "string") ?? [];
  if (name !== undefined) throw new BadRequest(`Invalid field: headers (${name}: expected string, got ${describeJson(value)})`);
  return headers as Record<string, string> | undefined;
}

/** The id a program gives to what it may want stopped: a name, so not an empty one. */
function namedBy(id: string): string {
  if (id === "") throw new BadRequest("Invalid field: id (expected a non-empty string)");
  return id;
}

/**
 * A request as it is written down: all of it, but for what it gives as
 * variables — a journal is no place for a key. Of variables the names are
 * kept; of what is given in their place and is none, what kind of thing it is.
 */
const asRecorded = (body: unknown): unknown =>
  !isJsonObject(body) || body.env == null ? body
    : { ...body, env: isJsonObject(body.env) ? Object.keys(body.env).map(variableName) : `(${describeJson(body.env)})` };

/**
 * What an agent call may say about how it is served (see AgentOptions). (A
 * prompt of `instruct` may be read as a template besides: a typed answer's is
 * not, for what says how to answer follows it.)
 */
const HOW_SERVED = {
  system: "optional string", model: "optional string", thinking: "optional string", tools: "optional strings or tools",
  skills: "optional boolean or strings", extensions: "optional boolean or string", cutOff: "optional string",
  // Where the program waits to be asked for the tools of its own that the call has (see own-tools.ts).
  toolsId: "optional string",
} as const satisfies Fields;

export interface IpcBackends {
  /**
   * The secret only this run's program knows. Every request must present it:
   * the server listens on a loopback port that any local process — or a web
   * page the user happens to have open — could otherwise send commands to.
   */
  token: string;
  ctx: RunContext;
  agent: RunnerAgent;
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
  /** Make a project, or change one, on the program's behalf — until it is done or `stop` says to stop. */
  make(request: MakeRequest, stop: AbortSignal, seq: number): Promise<void>;
  /** Where every call, and how it ended, is written down. */
  journal: Journal;
  /**
   * Whether the program has ended. What comes back for a call after that is
   * no answer — though its connection may not have been seen to close yet.
   */
  programOver(): boolean;
}

/** Whether a request carries `Authorization: Bearer <token>`, compared in constant time. */
function isAuthorized(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function buildRoutes({ ctx, agent, tools, workspace, workspaceAt, run, make }: IpcBackends): Record<string, Route> {
  /** What the program has asked for that lasts — a run, a project made — and has not ended, by the id it gave each. */
  const runsAskedFor = new Map<string, AbortController>();
  /** Ids the program asked to stop before what bears them was seen here: such a thing starts stopped. */
  const stoppedAhead = new Set<string>();

  /**
   * Carry out what a call asks for and that lasts as long as the call does,
   * until it ends or is to stop: the program says so by the id it gave it,
   * or is gone — its process died, or it gave up — and no longer wants it.
   */
  const lasting = async <T>(id: string | undefined, connectionClosed: Promise<void>, work: (stop: AbortSignal) => Promise<T>): Promise<T> => {
    if (id !== undefined && runsAskedFor.has(namedBy(id))) throw new BadRequest(`Duplicate run id: ${id}`);
    const stop = new AbortController();
    void connectionClosed.then(() => stop.abort());
    if (id !== undefined) {
      if (stoppedAhead.delete(id)) stop.abort();
      runsAskedFor.set(id, stop);
    }
    try {
      return await work(stop.signal);
    } finally {
      if (id !== undefined) runsAskedFor.delete(id);
    }
  };

  /** The tools of the program's own that its agent calls have, and how the program is asked for each. */
  const asks = createToolAsks();

  /**
   * Have an agent call served with the tools it named: the agent's by name,
   * and the program's own — each made a way to ask the program, open for as
   * long as the call lasts. (A list of names and nothing else is the
   * backend's to read, as it always was.)
   */
  const withTools = async <T>(
    tools: unknown[] | undefined,
    toolsId: string | undefined,
    call: RecordedCall,
    serve: (names: string[] | undefined, own: OwnTool[] | undefined) => Promise<T>,
  ): Promise<T> => {
    const ofTheProgram = tools?.some(tool => typeof tool !== "string") ?? false;
    if (!ofTheProgram) {
      if (toolsId !== undefined) throw new BadRequest("Invalid field: toolsId (the call has no tools of the program's own)");
      return serve(tools as string[] | undefined, undefined);
    }
    if (toolsId === undefined) throw new BadRequest("Missing field: toolsId (expected string, for a call with tools of the program's own)");
    // (What is wrong with a tool as it was written, or with where its program waits, is the request's fault: found before anything is asked.)
    const read = asGiven(() => toolsOf(tools!), why => `Invalid field: tools (${why})`);
    const way = asGiven(() => asks.open(toolsId, read.declared, call.tool));
    try {
      return await serve(read.names, way.tools);
    } finally {
      way.close();
    }
  };

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
      { prompt: "string", ...HOW_SERVED, templates: "optional boolean or strings" },
      ({ prompt, tools, toolsId, ...options }, _closed, call) => withTools(tools, toolsId, call, (names, own) =>
        agent.instruct(prompt, { ...options, tools: names } as Parameters<RunnerAgent["instruct"]>[1], call.used, own)),
    ),
    "/agent/generate": route(
      { prompt: "string", schema: "object", ...HOW_SERVED },
      ({ tools, toolsId, ...input }, _closed, call) => withTools(tools, toolsId, call, (names, own) =>
        agent.generate({ ...input, tools: names } as Parameters<RunnerAgent["generate"]>[0], call.used, own)),
    ),
    // How a program's own tools are asked (see own-tools.ts): its client waits here to be told that one is
    // called, or is to stop — held until there is something to tell, or the agent call is over — and says
    // here what one answered.
    "/agent/tool/asked": route({ of: "string" }, (b, closed) => asks.next(b.of, closed), { offTheRecord: true }),
    "/agent/tool/answered": route(
      { of: "string", key: "string", text: "optional string", images: "optional any", error: "optional string" },
      (b) => {
        if ((b.text === undefined) === (b.error === undefined)) throw new BadRequest("A tool's answer is its text, or the error it failed with: one of the two");
        const images = asGiven(() => imagesOf(b.images));
        if (images && b.error !== undefined) throw new BadRequest("Invalid field: images (a tool that failed has its error, and no images)");
        asks.answered(b.of, b.key, b.error !== undefined ? { text: b.error, failed: true } : { text: b.text!, ...(images && { images }) });
      },
      { offTheRecord: true },
    ),

    "/tools/read": route({ path: "string" }, b => tools.read(b.path)),
    "/tools/write": route({ path: "string", content: "string" }, b => tools.write(b.path, b.content)),
    "/tools/shell": route(
      { command: "string", cwd: "optional string", timeout: "optional number", env: "optional object" },
      b => tools.shell(b.command, { cwd: b.cwd, timeout: b.timeout, env: envOf(b.env) }),
    ),
    "/tools/fetch": route(
      { url: "string", method: "optional string", headers: "optional object", body: "optional string" },
      b => tools.fetch(b.url, { method: b.method, headers: headersOf(b.headers), body: b.body }),
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
        id: "optional string", label: "optional string", workspaceDir: "optional string", env: "optional object",
        budget: "optional object",
      },
      async ({ id, env, budget, timeout, maxRepairAttempts, ...asked }, connectionClosed, { seq }) => {
        const request: RunRequest = { ...asked, timeout: timeoutOf(timeout), maxRepairAttempts: attemptsOf(maxRepairAttempts), env: envOf(env), budget: budgetOf(budget) };
        return lasting(id, connectionClosed, stop => run(request, stop, seq));
      },
    ),
    // Nor does a program make a project, or change one: its runner does, as it runs one — under the
    // run's budget, on its record, and stopped with it.
    "/project/create": route(
      { name: "string", prompt: "string", model: "optional string", args: "optional object", id: "optional string" },
      ({ id, ...asked }, connectionClosed, { seq }) => lasting(id, connectionClosed, stop => make({ kind: "create", ...asked }, stop, seq)),
    ),
    "/project/update": route(
      { name: "string", prompt: "string", id: "optional string" },
      ({ id, ...asked }, connectionClosed, { seq }) => lasting(id, connectionClosed, stop => make({ kind: "update", ...asked }, stop, seq)),
    ),
    // Stop a run asked for above, or a project being made. The call that asked
    // for it still gets its answer — a failed run, an error — once it is over.
    "/run/stop": route({ id: "string" }, b => {
      const asked = runsAskedFor.get(namedBy(b.id));
      if (asked) asked.abort();
      else {
        if (stoppedAhead.size >= MAX_STOPPED_AHEAD && !stoppedAhead.has(b.id)) {
          stoppedAhead.delete(stoppedAhead.values().next().value!);
        }
        stoppedAhead.add(b.id);
      }
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
    const answerable = () => !backends.programOver() && !res.writableEnded && !res.destroyed;
    const reply = (status: number, body: string, json = false) => {
      if (!answerable()) return;
      res.writeHead(status, json ? { "Content-Type": "application/json" } : undefined);
      res.end(body);
    };

    if (req.method !== "POST") {
      req.resume(); // discard the body
      return reply(405, "Method not allowed");
    }
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
      let call: RecordedCall | undefined;
      try {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        } catch {
          return reply(400, "The request body is not valid JSON");
        }
        const route = req.url && Object.hasOwn(routes, req.url) ? routes[req.url] : undefined;
        if (!route) return reply(404, "Not found");
        call = route.offTheRecord ? OFF_THE_RECORD : backends.journal.call(req.url!, asRecorded(body));
        const result = (await route.handle(body, connectionClosed, call)) ?? null;
        const payload = JSON.stringify({ result });
        if (answerable()) call.end({ ok: true, result });
        reply(200, payload, true);
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
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/** Stop listening, and wait until it has. (The one thing a server can say against it is that it was not listening.) */
export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => { server.close(() => resolve()); });
}
