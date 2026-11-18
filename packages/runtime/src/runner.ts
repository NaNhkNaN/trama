import { spawn } from "child_process";
import {
  readFileSync, writeFileSync, appendFileSync,
  readdirSync, mkdirSync, existsSync, statSync,
  symlinkSync, rmSync, lstatSync, readlinkSync,
  mkdtempSync, openSync, closeSync, chmodSync,
  accessSync, constants, truncateSync,
} from "fs";
import { basename, join, dirname, relative } from "path";
import { homedir, tmpdir } from "os";
import { fileURLToPath } from "url";
import { createHash, randomBytes } from "crypto";
import type { ShellResult, Workspace } from "./types.js";
import type { RunOptions, TramaConfig, ProgramResult } from "./runner-types.js";
import { onAbort, rejectOnAbort } from "./abort.js";
import type { AgentBackend, AgentUsage } from "./agent-backend.js";
import { checkedBudget, createMeter, type Budget, type Meter } from "./budget.js";
import { PiAdapter } from "./pi-adapter.js";
import { LATEST_LOG_PATH, appendLogEntry, createContext } from "./context.js";
import { createAgent, stripCodeFences } from "./agent.js";
import { createTools } from "./tools.js";
import { createWorkspace } from "./workspace.js";
import { guardPath, identityOf, projectAt, realRootOf, sameProjectAs, wayTo } from "./path-guard.js";
import { copyTree, differences, entryAt, mergeTree, pathAsListed, readTree, type Tree, type Unmerged } from "./tree.js";
import { stageFile, type StagedFile } from "./replace-file.js";
import { readProjectMeta } from "./meta.js";
import { describeJson, isJsonObject } from "./serializable.js";
import { checkedEnv, createAllowance, superviseChild, type ChildExit } from "./child-process.js";
import { KILL_GRACE_MS, removeTempDir, removeWithThisProcess, requireWatchdog, stopGroups, stopWithThisProcess } from "./stopping.js";
import { createIPCServer, listen, closeServer } from "./ipc-server.js";
import { journalEntriesOf, openJournal, type Journal } from "./journal.js";
import { messageOf } from "./errors.js";

// --- Locating the runtime itself ---

/** The installed @trama-dev/runtime package — this file lives in its dist/. */
const RUNTIME_PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * tsx lets node run program.ts. Resolved through the module system, so any
 * install layout works. It is loaded into the program's own node process
 * rather than run as the `tsx` command, which puts a process of its own in
 * front of the program: one that kills the program some 60 ms after a SIGTERM
 * it has not acted on, and reports its death by signal as an exit code.
 */
const TSX_LOADER = import.meta.resolve("tsx");

/**
 * The @trama-dev packages a program.ts can import, and where they are installed.
 * The runtime always; the session layer when it is installed alongside (as it
 * is with the CLI). The runtime never imports the session layer itself — it
 * only makes it reachable from projects.
 */
const IMPORTABLE_PACKAGES: Record<string, string> = { runtime: RUNTIME_PACKAGE_DIR };
try {
  // Resolves to <package>/dist/index.js
  IMPORTABLE_PACKAGES.session = dirname(dirname(fileURLToPath(import.meta.resolve("@trama-dev/session"))));
} catch { /* not installed — programs simply cannot import it */ }

// --- Project scaffolding ---

/**
 * Point the project's node_modules/@trama-dev/<name> at an installed package,
 * so program.ts can import it. Replaces any existing symlink whose target
 * differs (including user-managed ones). Only refuses to touch a real
 * directory/file to avoid destroying user content.
 *
 * The link points outside the project, and is meant to. Where it is put is
 * inside it, like everything else the runtime writes: a project whose
 * node_modules leads somewhere else is refused, not followed there.
 */
function linkPackage(projectDir: string, name: string, target: string): void {
  const linkDir = guardPath(projectDir, join("node_modules", "@trama-dev"));
  // Not through the guard: it is the link itself that is looked at and replaced, not what it points at.
  const linkPath = join(linkDir, name);

  try {
    if (!lstatSync(linkPath).isSymbolicLink()) {
      throw new Error(
        `${linkPath} exists and is not a symlink. ` +
        `trama needs this path for module resolution. ` +
        `Remove it manually or rename it to proceed.`
      );
    }
    if (readlinkSync(linkPath) === target) return;
    rmSync(linkPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  mkdirSync(linkDir, { recursive: true });
  symlinkSync(target, linkPath, "dir");
}

/** Make sure package.json exists and declares an ES module (program.ts uses top-level await). */
function ensureModulePackageJson(projectDir: string): void {
  const pkgPath = guardPath(projectDir, "package.json");
  if (!existsSync(pkgPath)) {
    writeFileSync(pkgPath, JSON.stringify({ type: "module" }, null, 2));
    return;
  }
  const advice = "trama will not overwrite it automatically; fix or remove it and try again.";
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `Malformed package.json at ${pkgPath}. ${advice}\n` +
      `Parse error: ${messageOf(err)}`
    );
  }
  if (!isJsonObject(pkg)) {
    throw new Error(`Malformed package.json at ${pkgPath} — expected a JSON object but got ${describeJson(pkg)}. ${advice}`);
  }
  if (pkg.type !== "module") {
    pkg.type = "module";
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  }
}

/** Make sure .gitignore excludes what trama generates, without disturbing existing entries. */
function ensureGitignore(projectDir: string): void {
  const giPath = guardPath(projectDir, ".gitignore");
  const required = ["node_modules/", "state.json", "logs/", "history/"];
  const existing = existsSync(giPath) ? readFileSync(giPath, "utf-8") : "";
  const present = new Set(existing.split("\n").map(line => line.trim()));
  const missing = required.filter(entry => !present.has(entry));
  if (missing.length === 0) return;
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  writeFileSync(giPath, existing + separator + missing.join("\n") + "\n");
}

/**
 * Everything a project directory needs around program.ts before it can run:
 * history/ and logs/, an ESM package.json, .gitignore entries, and links to the
 * @trama-dev packages it can import.
 * Idempotent — called before every run, so a freshly cloned project just works.
 */
export function ensureProjectScaffold(projectDir: string): void {
  projectAt(projectDir);
  mkdirSync(guardPath(projectDir, "history"), { recursive: true });
  mkdirSync(guardPath(projectDir, "logs"), { recursive: true });
  ensureModulePackageJson(projectDir);
  ensureGitignore(projectDir);
  for (const [name, target] of Object.entries(IMPORTABLE_PACKAGES)) linkPackage(projectDir, name, target);
}

// --- The API reference shown to the LLM ---

/**
 * The program-facing API, as shown to the LLM when it writes or repairs a
 * program. This is the declaration file generated from types.ts, so the prompt
 * cannot drift from the real API — doc comments included.
 */
export const RUNTIME_TYPES = [
  "// @trama-dev/runtime - Complete API",
  readFileSync(new URL("./types.d.ts", import.meta.url), "utf-8").trim(),
  [
    "export declare const ctx: Ctx;",
    "export declare const agent: Agent;",
    "export declare const tools: Tools;",
    "export declare const workspace: Workspace;",
  ].join("\n"),
].join("\n\n");

// --- Config & state loaders ---

export function loadConfig(): TramaConfig {
  const configPath = join(homedir(), ".trama", "config.json");
  const defaults: TramaConfig = {
    provider: "anthropic",
    model: "claude-opus-5-5",
    maxRepairAttempts: 3,
    defaultTimeout: 300_000,
    defaultMaxIterations: 100,
    journalRuns: 20,
    agentChanges: "keep",
  };
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaults;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Malformed config at ${configPath} — fix or delete it.\n` +
      `Parse error: ${messageOf(err)}`
    );
  }
  if (!isJsonObject(parsed)) {
    throw new Error(
      `Malformed config at ${configPath} — expected a JSON object but got ${describeJson(parsed)}. Fix or delete it to proceed.`
    );
  }
  // null is how JSON says a field is not there.
  const given = Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== null));
  return checkedConfig({ ...defaults, ...given }, "config");
}

/** A config that holds what the runtime can work with — or an error naming what does not, and where it came from. */
function checkedConfig(merged: TramaConfig, source: string): TramaConfig {
  const s = (v: unknown) => typeof v === "string" && v.length > 0;
  const pint = (v: unknown) => Number.isInteger(v) && (v as number) > 0;
  const checks: Array<[boolean, string]> = [
    [s(merged.provider), `"provider" must be a non-empty string (got ${JSON.stringify(merged.provider)})`],
    [s(merged.model), `"model" must be a non-empty string (got ${JSON.stringify(merged.model)})`],
    [Number.isInteger(merged.maxRepairAttempts) && merged.maxRepairAttempts >= 0, `"maxRepairAttempts" must be a non-negative integer (got ${merged.maxRepairAttempts})`],
    [Number.isFinite(merged.defaultTimeout) && merged.defaultTimeout > 0, `"defaultTimeout" must be a positive number (got ${merged.defaultTimeout})`],
    [pint(merged.defaultMaxIterations), `"defaultMaxIterations" must be a positive integer (got ${merged.defaultMaxIterations})`],
    [Number.isInteger(merged.journalRuns) && merged.journalRuns >= 0, `"journalRuns" must be a non-negative integer (got ${merged.journalRuns})`],
    [merged.agentChanges === "keep" || merged.agentChanges === "discard", `"agentChanges" must be "keep" or "discard" (got ${JSON.stringify(merged.agentChanges)})`],
  ];
  for (const [ok, msg] of checks) {
    if (!ok) throw new Error(`Invalid ${source}: ${msg}`);
  }
  if (merged.budget === undefined) return merged;
  try {
    return { ...merged, budget: checkedBudget(merged.budget, `"budget"`) };
  } catch (err) {
    throw new Error(`Invalid ${source}: ${messageOf(err)}`);
  }
}

/** The global config, with the model/provider a project was created with taking precedence. */
export function loadProjectConfig(projectDir: string, meta = readProjectMeta(projectDir)): TramaConfig {
  const config = loadConfig();
  // null is how JSON says a field is not there. Anything else a project says
  // is taken, and held to what the global config is held to — an empty or
  // mistyped name is an error here, not a quiet return to another model.
  if (meta.model != null) config.model = meta.model;
  if (meta.provider != null) config.provider = meta.provider;
  return checkedConfig(config, `meta.json in ${projectDir}`);
}

/**
 * What does the LLM work for a project. The only place that picks a backend:
 * everything else is handed one and does not know which it is.
 *
 * It is also where what is asked of a model is counted, and held to a
 * budget (`meter`): every call passes here, whoever makes it. A call that
 * comes when the budget is spent is refused; one under way is stopped where
 * its agent would ask the model again — what the model was asked before
 * that is used, and what it was answering is let finish. `spent` is told
 * why, the first time either happens.
 */
export function createBackend(config: TramaConfig, meter: Meter = createMeter(), spent: (why: string) => void = () => {}): Backend {
  const backend = new PiAdapter(config);
  // The calls that were cancelled.
  const cutOff = new Set<Promise<unknown>>();
  // Why a call was first refused, or stopped, for the budget.
  let refused: string | undefined;
  const overBudget = (why: string): Error => {
    if (refused === undefined) spent(why);
    refused ??= why;
    return new Error(why);
  };
  return {
    spent: () => meter.spent(),
    refused: () => refused,
    counts: () => meter.capped(),
    // The interface promises that a cancelled call rejects, and a run's end
    // waits on that. Every backend is held to it here, rather than trusted with it.
    async ask(prompt, call) {
      let account: ReturnType<Meter["admit"]>;
      try {
        account = meter.admit();
      } catch (err) {
        throw overBudget(messageOf(err));
      }
      // Stops the call where the budget is reached while it is under way.
      const over = new AbortController();
      let why: string | undefined;
      const signal = call.signal ? AbortSignal.any([call.signal, over.signal]) : over.signal;
      const work = backend.ask(prompt, {
        ...call,
        signal,
        sofar(usage) {
          // (Once it is to stop, it is to stop — whatever is said of it after.)
          const reached = account.sofar(usage);
          why ??= reached;
          if (why !== undefined) over.abort();
          call.sofar?.(usage);
        },
        used(usage) {
          account.sofar(usage);
          call.used?.(usage);
        },
      });
      const off = onAbort(signal, () => { cutOff.add(work); });
      // What the call used is counted as its own until the backend has let go of it — which
      // is when it has said the last of it — however long ago whoever asked was answered.
      const settled = () => {
        off();
        account.close();
      };
      work.then(settled, settled);
      try {
        return await rejectOnAbort(work, signal);
      } catch (err) {
        // (Stopped by whoever asked, it was stopped by them, whatever the budget had come to.)
        throw why !== undefined && !call.signal?.aborted ? overBudget(why) : err;
      }
    },
    async letGo() {
      let giveUp: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(cutOff),
        new Promise(resolve => { giveUp = setTimeout(resolve, KILL_GRACE_MS); }),
      ]);
      clearTimeout(giveUp);
    },
  };
}

/** The budgets of which it has been said that they are spent. */
const saidSpent = new WeakSet<Meter>();

/**
 * Say that a budget is spent, once for the budget — whoever comes up against
 * it first: the run's own backend, or the backend of a project being made
 * for the run's program, of which there may be many.
 */
export const saysOnce = (meter: Meter, say: (why: string) => void) => (why: string): void => {
  if (saidSpent.has(meter)) return;
  saidSpent.add(meter);
  say(why);
};

/** A backend as the runner holds it: one whose cancelled calls are answered at once, and can be waited for apart. */
export interface Backend extends AgentBackend {
  /** Why nothing more may be asked of it — the budget it counts in is spent — or nothing, while something may. */
  spent?(): string | undefined;
  /** Why a call of it was first refused or stopped for the budget, if one was — whatever the count has come to since. */
  refused?(): string | undefined;
  /** Whether what its calls use is held to anything: then what a call it cut off used is to be waited for, recorded or not. */
  counts?(): boolean;
  /**
   * Resolves when the backend has let go of the calls that were cancelled so
   * far: whoever cancelled one went on at once, and the backend still had to
   * stop what it was doing, and to say what the call had used. They are
   * waited for no longer than anything asked to stop is.
   */
  letGo(): Promise<void>;
}

export function loadState(projectDir: string): Record<string, unknown> {
  const statePath = guardPath(projectDir, "state.json");
  let raw: string;
  try {
    raw = readFileSync(statePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  function fail(reason: string): never {
    throw new Error(
      `Corrupt state.json in ${projectDir} — cannot safely continue.\n${reason}\n` +
      `Back up or delete state.json to reset state.`
    );
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (err) {
    fail(`Parse error: ${messageOf(err)}`);
  }
  if (!isJsonObject(parsed)) {
    fail(`Expected a JSON object but got ${describeJson(parsed)}.`);
  }
  return parsed;
}

// --- History management ---

/** The index.jsonl field that carries the detail for each kind of versioned change. */
const HISTORY_DETAIL_FIELD: Record<string, string> = { create: "prompt", update: "prompt", repair: "error" };

/**
 * Add a version to a project's history: its text as history/NNNN.ts, and a
 * line in index.jsonl saying why (after `notes`, lines that belong with it).
 * Either all of it is written or none of it. Returns how to take it back, for
 * a caller whose own next step may still fail.
 */
function recordVersion(
  projectDir: string,
  source: string | Buffer,
  reason: string,
  detail?: string,
  notes: Array<Record<string, unknown>> = [],
): () => void {
  const historyDir = guardPath(projectDir, "history");
  const indexPath = guardPath(projectDir, join("history", "index.jsonl"));
  const versions = readdirSync(historyDir)
    .filter(f => /^\d+\.ts$/.test(f))
    .map(f => parseInt(f, 10))
    .filter(n => Number.isSafeInteger(n) && n < Number.MAX_SAFE_INTEGER);
  const version = versions.reduce((a, b) => Math.max(a, b), 0) + 1;
  const snapshot = guardPath(projectDir, join("history", `${String(version).padStart(4, "0")}.ts`));

  const entry: Record<string, unknown> = { version, reason, timestamp: new Date().toISOString() };
  const detailField = HISTORY_DETAIL_FIELD[reason];
  if (detailField && detail) entry[detailField] = detail;

  const lines = Buffer.from([...notes, entry].map(line => JSON.stringify(line) + "\n").join(""));
  const sizeBefore = statSync(indexPath, { throwIfNoEntry: false })?.size;
  let wroteSnapshot = false;
  let appended = false;

  // Takes back what was written here and nothing else. Another run of the
  // project may be recording a version of its own at the same moment: if the
  // index no longer ends with these lines alone, they are left in it, and the
  // version file with them — a version on record that was never installed,
  // rather than someone else's record cut out of the history.
  const undo = () => {
    try {
      const index = readFileSync(indexPath);
      const start = sizeBefore ?? 0;
      const sinceThen = index.subarray(Math.min(start, index.length));
      // What was appended is the end of the index — whole, or as far as a failed write got.
      const cutTo = index.subarray(-lines.length).equals(lines) ? index.length - lines.length
        : lines.subarray(0, sinceThen.length).equals(sinceThen) ? start
        : null;
      if (cutTo === null) return;
      if (cutTo === 0 && sizeBefore === undefined) rmSync(indexPath, { force: true });
      else if (cutTo < index.length) truncateSync(indexPath, cutTo);
    } catch (err) {
      // The index cannot be looked at. If the lines went into it, they stay,
      // and the version file with them; if they never did, there is only the file.
      if (appended && (err as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    if (wroteSnapshot) try { rmSync(snapshot, { force: true }); } catch { /* best-effort */ }
  };
  try {
    // Never over a version file that is already there: that one is someone else's.
    const fd = openSync(snapshot, "wx");
    wroteSnapshot = true;
    try { writeFileSync(fd, source); } finally { closeSync(fd); }
    appendFileSync(indexPath, lines);
    appended = true;
  } catch (err) {
    undo();
    throw err;
  }
  return undo;
}

/** Save the current program.ts as the next version of the project, and record why. */
export function copyToHistory(projectDir: string, reason: string, detail?: string): void {
  recordVersion(projectDir, readFileSync(guardPath(projectDir, "program.ts")), reason, detail);
}

// --- Staging: run against a copy, merge back what worked (see tree.ts) ---

/** Run fn in a temp directory, clean up afterwards regardless of outcome — including this process being stopped. */
export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const settled = removeWithThisProcess(dir);
  try {
    return await fn(dir);
  } finally {
    removeTempDir(dir);
    settled();
  }
}

/**
 * Do something in a directory of a copy that may be closed to it: a copy is
 * the runner's to open. The directory is left allowing what it allowed.
 */
function inDirOfCopy<T>(dir: string, what: () => T): T {
  const allows = statSync(dir).mode;
  if ((allows & 0o700) === 0o700) return what();
  chmodSync(dir, (allows & 0o7777) | 0o700);
  try {
    return what();
  } finally {
    chmodSync(dir, allows & 0o7777);
  }
}

/** The directory a file at `place` is made in — or, if that is still to be made, the one it is made in. */
function whereMade(place: string): string {
  let dir = dirname(place);
  while (!existsSync(dir)) dir = dirname(dir);
  return dir;
}

/**
 * Put a program where a copy of a project has its program.ts — whatever the
 * directory it goes in allows: a copy is where programs are tried and
 * replaced. The new file allows what `mode` says or, where that is not said,
 * what the one it takes the place of allows — and its owner to replace it.
 * Throws where a directory is in the place of the program: `root` is the
 * project the copy is of, for saying so.
 */
function putProgram(copyDir: string, root: string, program: string, mode?: number): void {
  const place = guardPath(copyDir, "program.ts");
  const had = statSync(place, { throwIfNoEntry: false });
  if (had?.isDirectory()) throw new Error(`No program can be tried in a copy of ${root}: its program.ts is a directory.`);
  inDirOfCopy(whereMade(place), () => stageFile(copyDir, "program.ts", program, mode ?? (had && (had.mode | 0o200))).commit());
}

/**
 * All that makes a directory's program.ts lead to its program, as the
 * directory stands: the name, each link and each directory on the way, the
 * file — each by what it is (see Entry), which is asked of the place,
 * whatever its directory lists or allows.
 */
const programParts = (dir: string): string[] => wayTo(dir, "program.ts").flatMap((place) => {
  const entry = entryAt(place);
  return entry && entry.kind !== "other" ? [entry.id] : [];
});

/**
 * Have what is beside a project be beside a copy of it: for each name in the
 * directory the project is in, a link of that name, to it, in the directory
 * the copy is in. So ".." leads from the copy to what it leads to from the
 * project — a file beside it that its program reads, a module it imports
 * from there, a project beside it that it runs.
 *
 * What is come to that way is the real thing, not a copy: what is done to it
 * is done. (So is what it comes to in turn — and from a directory beside the
 * project, ".." is the directory the project is in: by its name from there,
 * the project itself, and not the copy.) One step up is all there is: what
 * the directory the project is in is itself beside is not beside the copy.
 * And it is as much as can be found out: a directory that may not be listed
 * has nothing told of it, and a name the copy's own directory will not have
 * beside the copy is left out — the project's own, which is the copy's
 * there, before any.
 *
 * Returns the names put there, and the directory they are names in. A name
 * is not the thing: one that is made beside the copy, or taken away there,
 * is made or taken away in a directory that goes with the copy, and not
 * beside the project (see strandedBeside).
 */
interface Beside { among: string; names: string[] }
function standAmong(root: string, privateDir: string): Beside {
  const among = dirname(root);
  let names: string[];
  try {
    names = readdirSync(among);
  } catch {
    return { among, names: [] };
  }
  const put = names.filter((name) => {
    const beside = join(among, name);
    // (Not the directory all this is made in, where that is beside the project: it would stand beside itself.)
    if (beside === privateDir) return false;
    try {
      symlinkSync(beside, join(privateDir, name));
      return true;
    } catch {
      return false;
    }
  });
  return { among, names: put };
}

/**
 * What was done beside a copy that is not thereby done beside its project:
 * each name made there, and each of those put there (see standAmong) that is
 * gone, or is something else now — another link among them. Told as what did
 * not arrive is told: the path — from the project — and why.
 */
function strandedBeside(copy: string, beside: Beside): Unmerged[] {
  const dir = dirname(realRootOf(copy));
  const put = new Set(beside.names);
  const stranded: Unmerged[] = [];
  /** Whether a name put there is still the link that was put there. */
  const asPut = (name: string): boolean => {
    try {
      return readlinkSync(join(dir, name)) === join(beside.among, name);
    } catch {
      return false;
    }
  };
  try {
    for (const name of readdirSync(dir)) {
      if (name === basename(copy) || put.has(name)) continue;
      stranded.push({ path: `../${name}`, why: "it was made beside the copy that was worked in, and goes with it: beside the project there is no such thing" });
    }
    for (const name of beside.names) {
      if (asPut(name)) continue;
      stranded.push({ path: `../${name}`, why: "it was removed, or something else put there, beside the copy that was worked in: beside the project it is as it was" });
    }
  } catch { /* what cannot be looked at has nothing told of it */ }
  return stranded.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Make, in `privateDir`, a copy of a project — to try a program in, or for an
 * agent to look at and work in: what the project is and holds (see copyTree),
 * with `program` as its program.ts where one is given. Returns where the
 * copy is, what the project was when it was copied, and the names put beside
 * the copy for what is beside the project.
 *
 * The copy allows what the project allows, to everybody: so it is made in a
 * directory that is this runner's alone, and is nobody else's to come to. It
 * has the project's name there, and what is beside the project beside it (see
 * standAmong) — nothing else is to be in that directory. Where what is
 * copied is itself a copy of a project — as where a candidate is validated
 * in the project as an agent prepared it — `among` names the project: what
 * is beside the copy is what is beside that, and nothing an agent made
 * beside its own.
 *
 * The project's journals are not carried over: they are the record of its
 * runs, not part of what a run works on, and a copy is where a run is tried.
 *
 * In everything else the copy is as the project is, so that what a program
 * can do in the one it can do in the other: what a run did in a copy is
 * merged back into the project, and must not have been possible only there.
 * The one exception is the program: the one to be tried, in the place of
 * the project's. It allows what the project's allows — and its owner to
 * replace it — and is put there whatever the directory it goes in allows:
 * a copy is where programs are tried and replaced, and whether the project's
 * own may be is said of the project, where one is to take its place (see
 * whyNotReplaceable). A project with a directory where its program should be
 * has no place for one, and is not copied to try one in.
 */
export function copyProjectWith(projectDir: string, privateDir: string, program?: string, among = projectDir): { copy: string; held: Tree; beside: Beside } {
  const root = projectAt(projectDir);
  const itsOwn = realRootOf(privateDir);
  const copyDir = join(itsOwn, basename(root) || "project");
  mkdirSync(copyDir);
  const beside = standAmong(projectAt(among), itsOwn);
  const journals = journalEntriesOf(root);
  const theCopy = identityOf(copyDir);
  const held = copyTree(root, copyDir, (at, entry) => {
    if (entry.kind === "other") return false;
    if (entry.id === theCopy) {
      throw new Error(`A copy of ${root} cannot be made inside it, at ${at}. (Is the temp directory in the project?)`);
    }
    return journals.has(entry.id);
  });
  if (program !== undefined) putProgram(copyDir, root, program);
  return { copy: copyDir, held, beside };
}

// --- Single program execution ---

interface RunOnceOptions {
  /** The project to run. It is also where the program's agent calls work. */
  projectDir: string;
  backend: Backend;
  timeout: number;
  maxIterations: number;
  argsOverride?: Record<string, unknown>;
  /**
   * The run is a validation: it only has to show that the program works, and
   * goes no further than the program's own work. The program is stopped
   *  - once it has called ctx.ready() and stayed up for readyGraceMs (a
   *    program that runs until it is stopped). It passes if it then shuts
   *    down properly: stopping cleanly is part of what such a program is for.
   *  - the moment it asks for another program to be run. That run is not
   *    started — what happens between programs is not what is being
   *    validated, and would be a real run with real effects — and the program
   *    has passed there and then. How it goes down, cut off in mid-flow, says
   *    nothing about it.
   */
  validating?: { readyGraceMs: number };
  /** Shared workspace directory. When set, the workspace.* API is enabled. */
  workspaceDir?: string;
  /** How many runs deep this one is: 0 for a run nobody's program asked for. */
  depth: number;
  /** Shown in front of each line of the program's output. */
  label?: string;
  /** Variables the run was started with, over the runner's own (see RunOptions). */
  env?: Record<string, string>;
  /** The count of what the run uses of a model: what the runs it asks for use is counted there too. */
  meter?: Meter;
  /** How a project is made or changed where the run's program asks for that (see Making). Without it, nothing is. */
  making?: Making;
  /** Stops the run. */
  signal?: AbortSignal;
  /** Where the run is written down. One journal covers every attempt of a run. */
  journal: Journal;
  /** Which attempt of the run this is: 0 for the program as it was, 1 and up for fixes. */
  attempt?: number;
}

interface RunOnceResult {
  /** How the run ended, or null if it failed (non-zero exit with no terminal signal). */
  outcome: ProgramResult | null;
  /** A description of the failure, for the repair prompt and for the user. */
  failure: string;
}

/** The end of a long output — where the error is — with a note of how much was dropped. */
function tail(text: string, max = 20_000): string {
  return text.length <= max ? text : `[… ${text.length - max} earlier characters omitted]\n${text.slice(-max)}`;
}

/** A line as it is shown for a run: under the run's name, if it has one. */
export const tagged = (label: string | undefined, line: string) => label ? `[${label}] ${line}` : line;

/** The longest stretch of output held back while waiting for its line to end. */
const MAX_HELD_LINE = 64 * 1024;

/** Put a label in front of each line written to a stream. `flush` writes out a last line that had no newline. */
function labelled(label: string, write: (text: string) => void) {
  let held = "";
  const flush = () => {
    if (held) write(tagged(label, held) + "\n");
    held = "";
  };
  return {
    sink(chunk: string) {
      const end = chunk.lastIndexOf("\n");
      if (end === -1) {
        held += chunk;
        if (held.length > MAX_HELD_LINE) flush(); // a line with no end in sight is shown in pieces
        return;
      }
      const lines = (held + chunk.slice(0, end)).split("\n");
      held = chunk.slice(end + 1);
      write(lines.map(line => tagged(label, line) + "\n").join(""));
    },
    flush,
  };
}

/** How much of each of a program's output streams goes into the journal. */
const MAX_JOURNALLED_OUTPUT = 64 * 1024;

/** What identifies a program text without quoting it. */
function fingerprint(programPath: string): { sha256: string; bytes: number } | null {
  try {
    const source = readFileSync(programPath);
    return { sha256: createHash("sha256").update(source).digest("hex"), bytes: source.length };
  } catch {
    return null; // no program to speak of; the attempt will say so itself
  }
}

const describeFailure = (r: ShellResult) =>
  `program.ts exited with code ${r.exitCode}\nstdout: ${tail(r.stdout)}\nstderr: ${tail(r.stderr)}`;

/**
 * Hand the program its starting state through a private temp file rather than
 * env vars — no OS size limit, and mode 0600 in an unpredictable directory
 * keeps it (and the bridge secret in it) from other local users.
 */
function writeInitFile(dir: string, payload: unknown): string {
  const file = join(dir, "init.json");
  const fd = openSync(file, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(payload));
  } finally {
    closeSync(fd);
  }
  return file;
}

function toChildResult(exit: ChildExit): ShellResult {
  const { stdout, stderr } = exit;
  if (exit.timedOut) return { exitCode: 1, stdout, stderr: stderr + "\n[trama] program killed: timeout" };
  // Stopped by us at the end of a validation — going down on SIGTERM is the expected outcome.
  if (exit.stopped && (exit.code === 0 || exit.signal === "SIGTERM")) return { exitCode: 0, stdout, stderr };
  return { exitCode: exit.code ?? 1, stdout, stderr };
}

/**
 * Decide how a finished run ended. A terminal signal the program completed
 * takes precedence over its exit code: a program that called ctx.done() and
 * then crashed is done. Returns null for a failure (non-zero exit, no signal).
 */
function settle(projectDir: string, child: ShellResult, ended: ProgramResult | null): ProgramResult | null {
  // Read state first: if the program left state.json corrupt, say so now
  // rather than report an outcome (or start a repair) on top of it.
  const state = loadState(projectDir);
  if (ended) return ended;
  if (child.exitCode !== 0) return null;

  // Natural success without done() or yield(): if this run was the resumption
  // of an earlier yield, that yield is now over — don't let its marker make
  // the next run look resumed.
  if (state.__trama_yield != null) {
    delete state.__trama_yield;
    writeFileSync(guardPath(projectDir, "state.json"), JSON.stringify(state, null, 2));
  }
  return { status: "done" };
}

/**
 * Run program.ts once in the given directory: scaffold, start the IPC server,
 * spawn the program, wait for it, tear everything down, and say how it ended.
 * The program's output is echoed as it runs. A program that fails is a result,
 * not an exception — this throws only when the run could not happen at all
 * (bad project, server or spawn failure) or left state.json unreadable.
 */
async function runProgramOnce(options: RunOnceOptions): Promise<RunOnceResult> {
  const { projectDir, backend, timeout, maxIterations, argsOverride, validating, workspaceDir, label, signal, journal } = options;
  const attempt = options.attempt ?? 0;

  requireWatchdog();
  ensureProjectScaffold(projectDir);

  // Cancels in-flight LLM calls, fetches and observes once the run is over.
  const runEnded = new AbortController();
  // Ends a validation: the program has shown what it had to, and is asked to stop.
  const validated = new AbortController();
  let readyTimer: ReturnType<typeof setTimeout> | null = null;

  // The state the program starts from. From here on it is the program's: the
  // runner sees it again only as the program hands it over to be persisted.
  const state = loadState(projectDir);
  const ctx = createContext(projectDir, state, {
    maxIterations,
    argsOverride,
    onReady: validating && (() => {
      readyTimer ??= setTimeout(() => validated.abort(), validating.readyGraceMs).unref();
    }),
    print: line => console.log(tagged(label, line)),
  });
  journal.note("attempt", {
    attempt,
    // Where it runs — a copy of the project, when a fix is being tried or a candidate validated.
    dir: projectDir,
    program: fingerprint(guardPath(projectDir, "program.ts")),
    iteration: ctx.iteration,
    resumed: ctx.resumed,
  });
  // Truncate logs only after preflight succeeds — preserves the prior run's
  // diagnostics if scaffolding, state loading, or context creation fails.
  writeFileSync(guardPath(projectDir, LATEST_LOG_PATH), "");

  // The program's own time. It stops while a run the program asked for is in flight.
  const allowance = createAllowance(timeout);
  // Set when a validation ended because the program asked for another to be run, or for a project to be made or changed.
  let handedOff: false | "starts another program" | "has a project made or changed" = false;
  // Runs the program has asked for and that are still going. They belong to this run.
  const nestedRuns = new Set<Promise<unknown>>();
  const workspaces = new Map<string, Workspace>();
  const workspaceAt = (dir: string): Workspace => {
    let workspace = workspaces.get(dir);
    if (!workspace) workspaces.set(dir, workspace = createWorkspace(dir, runEnded.signal));
    return workspace;
  };
  // The workspace of the session this run is part of, if it is part of one.
  const sessionWorkspace = workspaceDir ? workspaceAt(workspaceDir) : null;
  const tools = createTools(projectDir, runEnded.signal, options.env);
  // As far as a validation goes: the program asks its runner for what would be real — a run, a project
  // made. The call is left unanswered — an answer would only send the program on to do more — until
  // the program, which is being stopped, lets go of it.
  const handOff = (what: Exclude<typeof handedOff, false>, stop: AbortSignal): Promise<never> => {
    handedOff = what;
    validated.abort();
    return rejectOnAbort(new Promise<never>(() => {}), stop);
  };
  // Known only to this run's program, through its init file.
  const token = randomBytes(32).toString("hex");
  // Whether the program's process has ended. (Nothing is an answer to it after that, and it is no longer there to stop.)
  let programOver = false;
  const server = createIPCServer({
    token,
    ctx,
    agent: createAgent(backend, projectDir, runEnded.signal),
    tools,
    workspace: sessionWorkspace,
    workspaceAt,
    journal,
    programOver: () => programOver,
    make: (request, stop, seq) => {
      if (validating) return handOff("has a project made or changed", stop);
      if (!options.making) {
        throw new Error("This runner was not given a way to make projects: createProject and updateProject are carried out where a run is started by way of @trama-dev/runtime/runner.");
      }
      // The run's own, as a run it asks for is: under its budget, with its variables, stopped when it
      // ends or when the program no longer wants it, and not over before this is. (But the program's
      // clock goes on: what it has made is its own work, with no timeout but the program's.)
      const made = options.making(request, {
        signal: AbortSignal.any([runEnded.signal, stop]),
        above: options.meter,
        label,
        env: options.env,
        parent: { run: journal.run, journal: journal.path, seq },
        // (What it starts is a validation: of the program the project is made with.)
        started: (run, path) => { if (run) journal.note("child", { seq, run, journal: path, purpose: "validate" }); },
      }).finally(() => { nestedRuns.delete(made); });
      nestedRuns.add(made);
      return made;
    },
    run: (request, stop, seq) => {
      if (validating) return handOff("starts another program", stop);
      // The program is waiting, not working: its clock stops for as long as
      // the run it asked for lasts, which has a timeout of its own. That run
      // is stopped when this one ends, or when the program no longer wants it.
      const release = allowance.hold();
      // What this run was started with, the run it asks for has too — and what it is given besides.
      const env = options.env || request.env ? { ...options.env, ...request.env } : undefined;
      const nested = runProgram({ ...request, env, signal: AbortSignal.any([runEnded.signal, stop]) }, {
        depth: options.depth + 1,
        // The two journals point at each other: this one says which run the call started…
        started: (run, path) => { if (run) journal.note("child", { seq, run, journal: path }); },
        // …and that run's journal says which call started it.
        parent: { run: journal.run, journal: journal.path, seq },
        above: options.meter,
      }, options.making).finally(() => {
        release();
        nestedRuns.delete(nested);
      });
      nestedRuns.add(nested);
      return nested;
    },
  });

  // A participant's output is shown under its name. It is not its parent's
  // output: the runner writes it out itself, wherever in the tree it runs.
  const out = label ? labelled(label, text => process.stdout.write(text)) : null;
  const err = label ? labelled(label, text => process.stderr.write(text)) : null;

  // The program leads a process group of its own, so that everything it starts is in it.
  let programGroup: number | undefined;
  // If this process ends while the program is running, the watchdog stops the program.
  let programSettled = () => {};
  // Asked to stop while its program had not ended. Everything it has in flight
  // goes at once — the runs it asked for among them, so that a tree of runs is
  // stopped together rather than one level after another.
  let stopped = false;
  const stopProgram = () => {
    if (programOver) return;
    stopped = true;
    runEnded.abort();
    if (programGroup) void stopGroups([programGroup]);
  };
  const offStop = onAbort(signal, stopProgram);
  try {
    const { child, exited } = await withTempDir("trama-init-", async (initDir) => {
      const port = await listen(server);
      const initFile = writeInitFile(initDir, {
        token,
        input: ctx.input,
        state,
        iteration: ctx.iteration,
        maxIterations: ctx.maxIterations,
        inSession: sessionWorkspace !== null,
        resumed: ctx.resumed,
        yieldReason: ctx.yieldReason,
      });

      const program = spawn(process.execPath, ["--import", TSX_LOADER, guardPath(projectDir, "program.ts")], {
        cwd: projectDir,
        env: { ...process.env, ...options.env, TRAMA_PORT: String(port), TRAMA_INIT: initFile },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      programGroup = program.pid;
      if (programGroup) programSettled = stopWithThisProcess(programGroup);
      if (signal?.aborted) stopProgram(); // asked to stop while the program was being started

      const exit = await superviseChild(program, {
        timeout: allowance,
        stopSignal: validating ? validated.signal : undefined,
        sinks: {
          stdout: out ? out.sink : chunk => { process.stdout.write(chunk); },
          stderr: err ? err.sink : chunk => { process.stderr.write(chunk); },
        },
      });
      programOver = true;
      // A validation that reached a hand-off in time was decided there: how the
      // program goes down, cut off in mid-flow, says nothing about it.
      const passedAtHandOff = handedOff && !exit.timedOut;
      if (passedAtHandOff) console.log(tagged(label, `[trama] validated up to where it ${handedOff}`));
      return {
        child: passedAtHandOff ? { exitCode: 0, stdout: exit.stdout, stderr: exit.stderr } : toChildResult(exit),
        // How the program's process ended, for the record.
        exited: {
          code: exit.code,
          signal: exit.signal,
          ...(exit.timedOut ? { timedOut: true } : {}),
          // Stopped by the runner at the end of a validation: at a hand-off, or once it had been ready a while.
          ...(exit.stopped ? { validated: handedOff ? "hand-off" : "ready" } : {}),
        },
      };
    });
    // How the attempt ended goes on record whatever comes of it — also when
    // what the program left behind cannot be made sense of.
    const noteExit = (verdict: Record<string, unknown>) => journal.note("exit", {
      attempt,
      ...exited,
      ...(stopped ? { stopped: true } : {}),
      // What the program printed is part of what it did. The end of it, where a failure shows.
      stdout: tail(child.stdout, MAX_JOURNALLED_OUTPUT),
      stderr: tail(child.stderr, MAX_JOURNALLED_OUTPUT),
      ...verdict,
    });
    let outcome: ProgramResult | null;
    try {
      // A program that was stopped did not finish, whatever its exit code
      // says — unless it had already said it was done.
      outcome = stopped && !ctx.ended ? null : settle(projectDir, child, ctx.ended);
    } catch (err) {
      noteExit({ error: messageOf(err) });
      throw err;
    }
    noteExit({ outcome });
    return { outcome, failure: describeFailure(child) };
  } finally {
    // The program is gone (or never started). Nothing it started outlives its
    // run: cancel the calls it left in flight — the runs it asked for among
    // them — and stop what is left of its process group and of its shell
    // commands. Only once they are gone is the run over: whoever called will
    // merge or delete what they were writing to.
    offStop();
    out?.flush();
    err?.flush();
    if (readyTimer) clearTimeout(readyTimer);
    runEnded.abort();
    await Promise.all([
      stopGroups(programGroup ? [programGroup] : []),
      tools.stopActiveShells(),
      Promise.allSettled([...nestedRuns]),
    ]);
    programSettled();
    server.closeAllConnections();
    await closeServer(server);
  }
}

// --- Execution with repair ---

interface ExecuteOptions extends RunOnceOptions {
  maxRepairAttempts: number;
  /** Whether what the agent asked for a fix changes beside the program is tried, and kept, with the fix (see TramaConfig). Kept, unless said otherwise. */
  agentChanges?: "keep" | "discard";
}

interface Execution {
  result: ProgramResult;
  /** Set when the program only worked after a repair: which attempt it was (1 for the first fix), and the failure it fixed. */
  repair?: { attempt: number; error: string };
}

/** The instructions a request for a fix is made under. (Exported so the tests' stand-in LLM can tell one from any other call.) */
export const REPAIR_SYSTEM_PROMPT = "You are a TypeScript repair tool.";

const repairPrompt = (input: { programSource: string; error: string; journal: string; kept: boolean }) =>
  `Fix this program so it runs.\n\n` +
  `You are working in a copy of the project's directory, where the program is program.ts. ` +
  (input.kept
    ? `If what is wrong is in the project and not in the program — a package that is not installed, a file the program needs that is missing or wrong — put it right here: ` +
      `what you change in this directory is kept, with the program you answer with, if that program then runs. If it does not, none of it is.\n`
    : `Nothing you change in this directory is kept: the program you answer with is all that is taken from you.\n`) +
  (input.journal ? `The record of the run that failed — each call the program made, and what came back — is at ${input.journal}, a line of JSON for each.\n` : "") +
  `\nRuntime types:\n${RUNTIME_TYPES}\n\n` +
  `Broken program:\n${input.programSource}\n\n` +
  `Error:\n${input.error}\n\n` +
  `Output ONLY the fixed program${input.kept ? ": the whole of it, also where it is the project that needed fixing" : ""}. No explanation.`;

/**
 * A question to ask of a copy an agent has worked in: whether what is at its
 * path is still the directory that was read (`was`). An agent can move its
 * copy away and leave a link there, or nothing: what is done next is done in
 * the copy, not in what a link leads to, nor in a directory made anew.
 */
const sameCopyAs = (copy: string, was: Tree) => (): void => {
  const there = entryAt(copy), itself = was.get(".");
  if (!(there?.kind === "dir" && itself?.kind === "dir" && there.id === itself.id)) {
    throw new Error("the copy that was worked in is no longer where it was made: it was moved away, or something else put in its place");
  }
};

/** A copy of a project that a fix is asked for in, and then tried in. */
interface Staged {
  /** Where the copy is. */
  copy: string;
  /** What the project held when it was copied: what its places are compared with when what was done in the copy is merged in. */
  held: Tree;
  /** The names put beside the copy, for what is beside the project (see standAmong). */
  beside: Beside;
  /** Throws if what is at the copy's path is no longer the copy: moved away, say, with a link left in its place. */
  intact(): void;
  /** The copy as it was before anything was done in it. What differs from this afterwards is what was done: by the agent, and by the run of its fix. */
  before: Tree;
  /**
   * The program as the copy had it then: all that made program.ts lead to it
   * (see programParts), the place it led to — which is the place of the
   * project's program in the project — as it is and as the copy listed it,
   * and what the file allowed.
   */
  program: { parts: string[]; place: string; listed: string | undefined; allowed: number };
  /** The program that is to be tried, as the copy has it when the trial begins (see fixIn). */
  fix: FixInPlace;
  /** The paths, beside the program's own place, at which the copy is other than it was once the agent has worked in it and its fix is in place. */
  changed?: string[];
}

/**
 * A program in the copy it is to be tried in: where the copy really is, the
 * name its directory lists for program.ts, what the file allows, and all
 * that makes program.ts lead to it (see programParts).
 */
interface FixInPlace { root: string; name: string; allowed: number; parts: string[] }
function fixIn(copy: string): FixInPlace {
  const root = realRootOf(copy);
  return {
    root,
    name: pathAsListed(copy, join(root, "program.ts")) ?? "program.ts",
    allowed: statSync(guardPath(copy, "program.ts")).mode,
    parts: programParts(copy),
  };
}

/** Make a copy of a project to ask for a fix in, or to try one in: with `program` as its program. */
function stageProject(projectDir: string, privateDir: string, program: string): Staged {
  const { copy, held, beside } = copyProjectWith(projectDir, privateDir, program);
  const place = guardPath(copy, "program.ts");
  const before = readTree(copy);
  const fix = fixIn(copy);
  return {
    copy, held, beside, before, intact: sameCopyAs(copy, before), fix,
    program: { parts: fix.parts, place, listed: pathAsListed(copy, place), allowed: fix.allowed },
  };
}

/** How many of the paths an agent changed are written down, or shown. */
const MAX_PATHS_NOTED = 200;
const MAX_PATHS_SHOWN = 10;
export const shownPaths = (paths: string[]): string => paths.slice(0, MAX_PATHS_SHOWN).join(", ") + (paths.length > MAX_PATHS_SHOWN ? ", …" : "");

/**
 * Ask the LLM for a fix. The agent has tools, so it works in a copy of the
 * project that holds the program it is asked to fix. What it reads there is
 * as the project has it. Bounded by its own timeout.
 *
 * What it changes there is part of the fix — the copy is the one the fix is
 * then tried in, and what was done in it reaches the project with the fix or
 * not at all (see tryFix) — unless that is not to be (`agentChanges`), or
 * the run is a validation: of a validation nothing is kept but the program,
 * so a fix that leaned on what its agent did beside it would be installed
 * without it. There the fix is the program alone, and the agent is told so.
 *
 * The program is the text it returns, whatever it did to program.ts: where
 * its work is kept, that text is put where program.ts leads as it left it,
 * allowing what the program allowed.
 *
 * Returns the fixed program — with the copy it is to be tried in, where that
 * is this one; or with why it cannot be tried in this one, where the agent
 * left it with no place for a program, not to be read, or moved it away: the
 * fix is then the program alone, as where nothing else is kept — or why no
 * usable fix came back.
 */
async function requestRepair(
  options: ExecuteOptions,
  input: { programSource: string; error: string },
  privateDir: string,
): Promise<{ fixed: string; staged?: Staged; unusable?: string } | { error: string }> {
  options.journal.note("fix-request", { error: input.error });
  const timedOut = new AbortController();
  const limit = createAllowance(options.timeout);
  const signal = options.signal ? AbortSignal.any([timedOut.signal, options.signal]) : timedOut.signal;
  try {
    const kept = options.agentChanges !== "discard" && !options.validating;
    const staged = stageProject(options.projectDir, privateDir, input.programSource);
    limit.start(() => timedOut.abort());
    const fixed = stripCodeFences(await options.backend.ask(repairPrompt({ ...input, journal: options.journal.path, kept }), {
      cwd: staged.copy, system: REPAIR_SYSTEM_PROMPT, signal,
      used: (usage) => options.journal.used("fix", usage),
    }));
    if (fixed.trim() === "") throw new Error("The repair returned an empty program.");
    if (!kept) {
      if (fixed === input.programSource) throw new Error("The repair returned the program unchanged.");
      options.journal.note("fix", { ok: true, source: fixed });
      return { fixed };
    }
    let changed: string[] = [], unusable: string | undefined;
    try {
      staged.intact();
      putProgram(staged.copy, options.projectDir, fixed, staged.program.allowed);
      staged.fix = fixIn(staged.copy);
      staged.changed = changed = differences(staged.before, readTree(staged.copy, true)).filter((path) => path !== staged.program.listed);
    } catch (err) {
      unusable = messageOf(err);
    }
    // A fix is the program, or the project, or both. One that is neither is the failure over again.
    if (fixed === input.programSource && changed.length === 0) {
      throw new Error(`The repair returned the program unchanged${unusable === undefined ? ", and changed nothing else in the project" : ""}.`);
    }
    options.journal.note("fix", {
      ok: true,
      ...(changed.length > 0 ? { changed: changed.slice(0, MAX_PATHS_NOTED) } : {}),
      ...(changed.length > MAX_PATHS_NOTED ? { changedInAll: changed.length } : {}),
      alone: unusable,
      source: fixed,
    });
    return unusable === undefined ? { fixed, staged } : { fixed, unusable };
  } catch (err) {
    const error = messageOf(err);
    options.journal.note("fix", { ok: false, error });
    return { error };
  } finally {
    limit.cancel();
  }
}

/**
 * Try a proposed fix, in a copy of the project that has it for its program.
 *
 * The project is the program's own, so the fix runs on a private copy of it:
 * the one the agent worked in when it was asked for the fix, with what the
 * agent did there — or one made for the trial, where what the agent did is
 * not kept. Only if it works does anything reach the real one — the
 * fix becomes program.ts, and what was done in the copy is merged back: by
 * the agent, and by the run. A fix that fails, or a runner that is stopped
 * while one is tried, leaves the project exactly as it was, because it was
 * never touched: its state is only ever written by code that is, or
 * becomes, its program — and its other files, besides, by an agent whose fix
 * then ran.
 *
 * The shared workspace is not copied. It is how the participants of a session
 * talk to each other, and a program that is being fixed still has to be heard
 * and answered — a fix that wrote its requests where nobody could see them
 * would wait for replies forever. So what a fix writes there is written,
 * whether or not the fix works: like anything a run wrote before it failed.
 */
async function tryFix(options: ExecuteOptions, staged: Staged, fixed: string, attempt: number): Promise<RunOnceResult> {
  const { projectDir } = options;
  const { copy: stagedProject, held, before } = staged;
  const itsPlace = staged.program.listed;
  // The fix in the copy, as the copy has it: under which name, what it allows there, and all that makes program.ts lead to it.
  const { root: copyRoot, name: itsName, allowed, parts: was } = staged.fix;
  const programIs = () => programParts(stagedProject);
  // If the copy cannot be run at all, or is left unusable, this fix did not work either.
  const trial = await runProgramOnce({ ...options, projectDir: stagedProject, attempt }).catch((err): RunOnceResult => ({
    outcome: null,
    failure: `The repaired program could not be run: ${messageOf(err)}`,
  }));
  if (trial.outcome === null) return trial;

  // The fix worked, and becomes the project's program — as it ran, first,
  // and in one move; only then is what its run did merged in. What the run
  // did to its own file is among that: a program may rewrite itself, give
  // itself other permissions, make program.ts lead elsewhere, and here as
  // in any run what it made of itself is what it is. (So a runner stopped
  // between the two leaves the fix beside the state it started from: the
  // program that would do the same again, not the one it turns into.)
  //
  // The project is to have a program afterwards. One that removed itself —
  // the system finds nothing at program.ts, however a link left there words
  // the way to it — is still the fix that ran: a file of its name is put
  // back where the run ended (the name itself, not what the link leads to).
  // A run that left something there that cannot be read as a program has
  // not left a project that has one, and was no fix.
  let is: string[];
  try {
    if (statSync(join(copyRoot, itsName), { throwIfNoEntry: false })) {
      programIn(stagedProject);
    } else {
      inDirOfCopy(copyRoot, () => {
        rmSync(join(copyRoot, itsName), { force: true });
        stageFile(stagedProject, itsName, fixed, allowed).commit();
      });
    }
    is = programIs();
  } catch (err) {
    return {
      outcome: null,
      failure: `The repaired program ran, but left no program.ts that can be read: ${messageOf(err)}`,
    };
  }
  // If it cannot be put in place, that is an error, and it is thrown from
  // here with nothing of the run in the project: a state the old program
  // did not write, beside the old program, is worse than either. Nor is it
  // put into another directory that is at the project's path by now: the
  // project is the directory that was copied, which the copy knows by what
  // it is.
  const projectRoot = realRootOf(projectDir);
  const copied = held.get("."), there = entryAt(projectRoot);
  if (there && copied?.kind === "dir" && !(there.kind === "dir" && there.id === copied.id)) {
    throw new Error(`The program cannot be replaced: what is at ${projectRoot} is not the project the fix was tried on.`);
  }
  const program = stageProgram(projectDir, fixed);
  program.commit();
  // The project now holds, where its program was, what the copy held there before the run — and the merge is
  // told so: that is what the place is taken to have held when the copy was made. (If that is still the
  // place program.ts leads to: where somebody has pointed it elsewhere meanwhile, the seed knows nothing new.)
  const installed = entryAt(program.destination);
  const samePlace = relative(projectRoot, program.destination) === relative(copyRoot, staged.program.place);
  if (itsPlace !== undefined && installed && samePlace) held.set(itsPlace, installed);
  // What the agent and the run made of the program is one thing, with what it was: the name, and what the
  // name leads through and to. If part of that does not arrive — or a part that was left alone is not, in the
  // project, as it was — none of it is carried over: a link without what it leads to, or the file gone from where
  // the project's program.ts still leads, would be a project with no program. The project then keeps the fix as it ran.
  // (What it was before the agent worked is named too: that is the file the reading the merge compares with has
  // at the program's place, and by it that place is known for a part where the run removed what was there.)
  const unmerged = [
    ...mergeTree(stagedProject, projectDir, before, held, [[...new Set([...staged.program.parts, ...was, ...is])]]),
    // (Of a program that is only being validated nothing is told here: the copy it is validated in goes, with all of this.)
    ...(options.validating ? [] : strandedBeside(stagedProject, staged.beside)),
  ];
  // What the agent changed beside the program is said: it is in the project now, but for what is told of below.
  if (staged.changed?.length) {
    console.log(tagged(options.label, `[trama] the agent asked for the fix changed ${staged.changed.length} path(s) beside the program: ${shownPaths(staged.changed)}`));
  }
  if (unmerged.length > 0) {
    // The run is done and its program installed; what was done that is not in the project is said, not passed over.
    options.journal.note("unmerged", { attempt, files: unmerged });
    console.warn(tagged(options.label, `[trama] ${unmerged.length} change(s) the repair made did not reach the project:`));
    for (const { path, why } of unmerged) console.warn(tagged(options.label, `[trama]   ${path} — ${why}`));
  }
  return trial;
}

/**
 * Run a program to an outcome. If it crashes, ask the LLM to repair it and try
 * the fix — up to maxRepairAttempts times.
 */
async function executeProgram(options: ExecuteOptions): Promise<Execution> {
  const { projectDir, maxRepairAttempts } = options;
  const failed = (reason: string): Execution => ({ result: { status: "failed", reason } });

  // A run that is stopped fails without a repair — there is nothing wrong with
  // the program. Checked after each step; a step that had already reached an
  // outcome keeps it.
  const stopped = () => options.signal?.aborted === true;
  const wasStopped = () => failed("The run was stopped before it finished.");
  if (stopped()) return wasStopped();
  const stillTheProject = sameProjectAs(projectDir);

  const firstRun = await runProgramOnce(options);
  if (firstRun.outcome) return { result: firstRun.outcome };
  if (stopped()) return wasStopped();

  let lastError = firstRun.failure;
  if (maxRepairAttempts === 0) return failed(`Program failed (repair disabled): ${lastError}`);
  // What is said and done from here on is said and done of the project the run was started on. (Not what was
  // said just now: where nothing more is to be done, how the program failed is all there is to say.)
  stillTheProject();
  // A fix is worth asking for, and trying, only where it could become the program.
  const refusal = whyNotReplaceable(projectDir);
  if (refusal) return failed(`Program failed, and no repair was tried. ${refusal}\n${lastError}`);

  // Each attempt builds on the previous one's source, though a fix that failed never reached the project.
  let currentSource = programIn(projectDir);
  if (currentSource === null) return failed(`Program failed (there is no program.ts to repair): ${lastError}`);

  // The program as it was is attempt 0; each fix is the next.
  for (let attempt = 1; attempt <= maxRepairAttempts; attempt++) {
    stillTheProject();
    // A fix is asked of a model: where no more may be, none is asked for, and nothing is got ready for one.
    const spent = options.backend.spent?.();
    if (spent !== undefined) {
      return failed(`${attempt === 1 ? "Program failed, and no repair was tried" : `Failed after ${attempt - 1} repair attempt(s), and no further repair was tried`}. ${spent}\n${lastError}`);
    }
    const source: string = currentSource, error = lastError;
    // One copy of the project for the attempt: the fix is asked for in it, and tried in it.
    const tried = await withTempDir("trama-repair-", async (privateDir) => {
      const fix = await requestRepair(options, { programSource: source, error }, privateDir);
      if (stopped()) return null;
      stillTheProject();
      if ("error" in fix) return fix;
      const { fixed, staged, unusable } = fix;
      if (unusable !== undefined) {
        console.warn(tagged(options.label, `[trama] the fix is tried by itself, and nothing else its agent did is kept: the copy the agent worked in cannot be used (${unusable})`));
      }
      // Where what the agent changed is not kept, the fix is tried in a copy the agent was never in.
      const run = staged
        ? await tryFix(options, staged, fixed, attempt)
        : await withTempDir("trama-staged-", (apart) => tryFix(options, stageProject(projectDir, apart, fixed), fixed, attempt));
      return { fixed, run };
    });
    if (tried === null) return wasStopped();
    // Without a fix there is nothing more to try: asking again would be asking the same thing.
    if ("error" in tried) {
      return failed(`Failed after ${attempt} repair attempt(s): ${lastError}\nNo fix came back: ${tried.error}`);
    }
    currentSource = tried.fixed;

    if (tried.run.outcome) return { result: tried.run.outcome, repair: { attempt, error: lastError } };
    if (stopped()) return wasStopped();
    lastError = tried.run.failure;
  }

  return failed(`Failed after ${maxRepairAttempts} repair attempts: ${lastError}`);
}

/**
 * Carry out a run under its journal. However it goes, the journal's last
 * record says so: the run's result, or why it could not be carried out —
 * after the agent calls that were cut off on the way have said what they
 * used. (A run that is not recorded, and whose backend holds what calls use
 * to nothing, has nothing to wait for.) Where the budget the backend counts
 * in is spent by then — or a call was refused or stopped for it on the way —
 * the record before the last says that.
 */
async function journalled<T extends Execution>(journal: Journal, backend: Backend, run: (backend: Backend) => Promise<T>): Promise<T> {
  let end: Record<string, unknown> = {};
  try {
    const execution = await run(backend);
    end = { result: execution.result };
    return execution;
  } catch (err) {
    end = { error: messageOf(err) };
    throw err;
  } finally {
    if (journal.run || backend.counts?.()) await backend.letGo();
    const spent = backend.spent?.() ?? backend.refused?.();
    if (spent !== undefined) journal.note("budget", { spent });
    journal.note("end", end);
    journal.close();
  }
}

// --- Validating a candidate program (used by create and update) ---

const VALIDATION_READY_GRACE_MS = 2_000;

/**
 * Validate a candidate program.ts for a project without touching what the
 * project holds: run it (with repair) in a throwaway copy. The one thing left
 * in the project is the journal of the validation. Returns the program that worked —
 * the candidate itself, or a repaired version of it, with the failure that was
 * repaired. Throws if it cannot be made to run.
 *
 * `as` names a directory that is the project as it is to be once the
 * program is in it — the copy the agent that wrote the program worked in,
 * with what it made there (see Prepared). The copy the program is run in is
 * then a copy of that, which is no more touched than the project is, and it
 * stands among what the project stands among.
 *
 * A repair made here is of the program alone (see requestRepair): the copy a
 * candidate runs in goes whole, with whatever was done in it.
 *
 * Where the agent left its copy so that no copy can be made of it — a file
 * nobody may read, say — the candidate is validated in the project as it is,
 * as it would be were nothing of the agent's kept: and `alone` says why,
 * for then nothing of the agent's is to be kept. (A caller that knows of such
 * a reason beforehand gives it as `alone`, with no `as`.) That is said when
 * it is found, whatever then comes of the candidate.
 *
 * Only the project's own files are shielded. What the program does beyond
 * them — network calls, shell commands, agent calls — is real. A run it asks
 * its runner for is not started: the validation ends where it asks for the
 * first.
 */
export async function validateProgram(
  projectDir: string,
  backend: Backend,
  candidate: string,
  options: {
    timeout: number; maxRepairAttempts: number; maxIterations: number; journalRuns?: number; signal?: AbortSignal;
    as?: string; alone?: string; budget?: Budget; wrote?: AgentUsage[];
    /** Where a run's program asked for the project to be made or changed: the run's name and variables are the validation's, and the two journals point at each other. */
    label?: string; env?: Record<string, string>; askedFor?: Pick<AskedFor, "parent" | "started">;
  },
): Promise<{ source: string; repairedError?: string; alone?: string }> {
  const { journalRuns = 0, signal, as = projectDir, timeout, maxRepairAttempts, maxIterations, label, env, askedFor } = options;
  // (What is written down, and handed on, is what a validation is known to take: nothing else that came with it.)
  const limits = { timeout, maxRepairAttempts, maxIterations };
  // Recorded with the project, though run in a copy of it. `budget` is for the record: the backend is what holds to it.
  const journal = openJournal(projectDir, journalRuns, {
    purpose: "validate", label, parent: askedFor?.parent, ...limits, budget: options.budget, env: env && Object.keys(env),
  });
  askedFor?.started(journal.run, journal.path);
  // What writing the candidate used is on record with its validation: it happened in no run, and has no journal of its own.
  for (const usage of options.wrote ?? []) journal.used("generate", usage);
  let alone: string | undefined;
  const byItself = (why: string) => {
    alone = why;
    console.warn(tagged(label, `[trama] the program is validated by itself, and nothing else its agent did is kept: the copy the agent worked in cannot be used (${why})`));
  };
  if (options.alone !== undefined) byItself(options.alone);
  const validatedIn = (prepared: string) => withTempDir("trama-validate-", async (privateDir) => {
    let trialDir: string;
    try {
      trialDir = copyProjectWith(prepared, privateDir, candidate, projectDir).copy;
    } catch (err) {
      if (prepared === projectDir) throw err;
      byItself(messageOf(err));
      return null;
    }

    const execution = await executeProgram({
      ...limits,
      projectDir: trialDir,
      backend,
      depth: 0,
      validating: { readyGraceMs: VALIDATION_READY_GRACE_MS },
      label,
      env,
      signal,
      journal,
    });
    // Of a run that failed nothing is installed, and why it failed is what there is to say: what it left is not looked at.
    if (execution.result.status === "failed") return { ...execution, left: candidate };
    // The program as its run left it: the candidate, or what a repair or the program itself
    // made of it. (One that removed itself is still the candidate that ran.)
    try {
      return { ...execution, left: programIn(trialDir) ?? candidate };
    } catch (err) {
      const reason = `The program ran, but left no program.ts that can be read: ${messageOf(err)}`;
      return { ...execution, result: { status: "failed" as const, reason }, left: candidate };
    }
  });
  const { result, repair, left } = await journalled(journal, backend, async () => (await validatedIn(as)) ?? (await validatedIn(projectDir))!);
  if (result.status === "failed") throw new Error(`Program failed: ${result.reason}`);
  return { source: left, repairedError: repair?.error, ...(alone === undefined ? {} : { alone }) };
}

/**
 * A copy of a project for the agent that writes its program to work in: to
 * look at what the program is to work with, and to make what the program
 * needs beside it — a package installed, a module, a file. `keep` carries
 * what the agent made there into the project, and returns what did not
 * arrive, with the paths it made or changed: it is for when the program has
 * been found to work in a copy of this one, and is in the project.
 *
 * The program is no part of that: it is what the agent answers with,
 * validated and installed as that, and what the agent left at program.ts —
 * the name, each link it led through, and the file it led to — stays in its
 * copy. So that the answer is validated where it will be installed, `ready`
 * has the name program.ts be, in the copy, what it was before the agent
 * worked: a link the agent put there is taken away, and one it took away is
 * put back. Where the way from the name is then still not what it was — a
 * link further along made to lead elsewhere, a directory on it replaced —
 * the copy is no place to validate the answer in, and `ready` says so.
 */
export interface Prepared {
  /** Where the copy is. */
  copy: string;
  /**
   * Make the copy what a candidate can be validated in a copy of (see above).
   * Throws if it cannot be: what is at the copy's path is no longer the copy
   * (moved away, say, with a link left in its place), or program.ts does not
   * lead there where it led.
   */
  ready(): void;
  keep(): { changed: string[]; unmerged: Unmerged[] };
}

export function prepareProject(projectDir: string, privateDir: string): Prepared {
  const { copy, held, beside } = copyProjectWith(projectDir, privateDir);
  const before = readTree(copy);
  const intact = sameCopyAs(copy, before);
  const root = realRootOf(copy);
  const name = join(root, "program.ts");
  /** The paths of the copy that are its program's, as it stands: the name, and what it leads through and to — but for directories, which hold other things too. */
  const programAt = (): string[] => [name, ...wayTo(copy, "program.ts")]
    .flatMap((place) => (entryAt(place)?.kind === "dir" ? [] : pathAsListed(copy, place) ?? []));
  /**
   * The way from the name to the program, as it stands: each place on it, and
   * what kind of thing is there — but that a file, or nothing yet, is all one:
   * either is a place a program can be put. (What a link says is not asked:
   * where it leads is the places that follow.)
   */
  const way = (): string => [name, ...wayTo(copy, "program.ts")].map((place) => {
    const there = entryAt(place);
    return `${relative(root, place)} ${there === undefined || there.kind === "file" ? "" : there.kind}`;
  }).join("\n");
  // What the name was, the way from it, and the program's places: before the agent worked, and as the agent left them.
  const nameWas = entryAt(name);
  const wayWas = way();
  const places = programAt();
  return {
    copy,
    ready() {
      intact();
      places.push(...programAt());
      const nameIs = entryAt(name);
      const asItWas = nameIs?.kind === "link" ? nameWas?.kind === "link" && nameWas.text === nameIs.text : nameWas?.kind !== "link";
      if (!asItWas) {
        inDirOfCopy(root, () => {
          rmSync(name, { force: true });
          if (nameWas?.kind === "link") symlinkSync(nameWas.text, name);
        });
      }
      if (way() !== wayWas) throw new Error("program.ts does not lead, in the copy that was worked in, where it led before: a program validated there would not be the program where it is installed");
    },
    keep() {
      intact();
      // (With what is closed opened for the reading: a copy was made of this one to validate in, but not of all
      // of it — what is left out of a copy, a directory of journals, was not looked into.)
      const after = readTree(copy, true);
      // At the program's places — where they were, where the agent left them, and where they are now that the
      // name is as it was (which a directory may list in other letters than it did) — the copy is taken to have
      // been as it is: nothing was done there that is to arrive.
      for (const path of [...places, ...programAt()]) {
        const there = after.get(path);
        if (there) before.set(path, there);
        else before.delete(path);
      }
      return { changed: differences(before, after), unmerged: [...mergeTree(copy, projectDir, before, held), ...strandedBeside(copy, beside)] };
    },
  };
}

/** A project's program text — null if it has none. Throws if what is in its place is no file. */
function programIn(projectDir: string): string | null {
  // (What the guard lets through is a file, a directory, or nothing yet: reading it waits on nothing.)
  const place = guardPath(projectDir, "program.ts");
  try {
    return readFileSync(place, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "EISDIR") throw new Error(`${place} is a directory, not a program.`);
    throw err;
  }
}

/**
 * Why a project's program cannot be given a successor — or null if it can.
 *
 * A program is replaced by a new file taking its place, which the system
 * allows whatever the old file's permissions say. So the old file is asked: a
 * program its owner has made read-only is not replaced. A directory in its
 * place is no program, and no file takes the place of one. And the new file
 * has to be made beside it, in a directory that is there or can be made.
 *
 * This is the rule stageProgram enforces. It is also asked before work whose
 * only use is a new program — an update, a repair — is begun.
 */
export function whyNotReplaceable(projectDir: string): string | null {
  // A program is a project's: where no project is, none is put.
  let place: string;
  let there: ReturnType<typeof statSync>;
  try {
    projectAt(projectDir);
    place = guardPath(projectDir, "program.ts");
    there = statSync(place, { throwIfNoEntry: false });
  } catch (err) {
    return `The program cannot be replaced: ${messageOf(err)}`;
  }
  const allows = (path: string, what: number) => {
    try { accessSync(path, what); return true; } catch { return false; }
  };
  if (there?.isDirectory()) return `The program cannot be replaced: ${place} is a directory.`;
  if (there && !allows(place, constants.W_OK)) return `The program cannot be replaced: ${place} is read-only.`;
  const dir = whereMade(place);
  if (!allows(dir, constants.W_OK | constants.X_OK)) return `The program cannot be replaced: nothing can be created in ${dir}.`;
  return null;
}

/**
 * Get a program ready to become a project's program.ts: written beside the
 * one that is there, to take its place in one move — so program.ts is never
 * half a program, whatever happens in the middle of writing it.
 *
 * It is a new file that takes the place: the old one's permissions are carried
 * over, but not a second hard link to it, or its owner.
 */
function stageProgram(projectDir: string, source: string): StagedFile {
  const refusal = whyNotReplaceable(projectDir);
  if (refusal) throw Object.assign(new Error(refusal), { code: "EACCES" });
  return stageFile(projectDir, "program.ts", source);
}

/**
 * Make a validated program the project's program.ts and record it as a new
 * version. A repair made while validating is not a version of its own — it is
 * noted in the history index only.
 */
export function installValidatedProgram(
  projectDir: string,
  validated: { source: string; repairedError?: string },
  reason: "create" | "update",
  prompt: string,
): void {
  // Three steps, ordered so that a failure at any of them leaves the project
  // as it was: the new program is written beside the old one (nothing else is
  // touched if even that cannot be done), the version is recorded, and only
  // then does the new program take the old one's place — in one move, so
  // program.ts is never half-written, and never a program that is not on record.
  const program = stageProgram(projectDir, validated.source);
  let unrecord = () => {};
  try {
    unrecord = recordVersion(projectDir, validated.source, reason, prompt, validated.repairedError
      ? [{ reason: `${reason}-repair`, timestamp: new Date().toISOString(), error: validated.repairedError }]
      : []);
    program.commit();
  } catch (err) {
    unrecord();
    program.discard();
    throw err;
  }
}

// --- Core execution ---

/** How deep programs may run programs, and how many runs one runner carries at a time. */
const MAX_RUN_DEPTH = 16;
const MAX_RUNS_IN_FLIGHT = 128;
let runsInFlight = 0;

/** A project a program asks its runner to make, or to change (see createProject and updateProject). */
export interface MakeRequest {
  kind: "create" | "update";
  name: string;
  prompt: string;
  model?: string;
  args?: Record<string, unknown>;
}

/**
 * What a project is made or changed under where a run's program asked for
 * it: that run's — stopped with it, counted in its budget, shown under its
 * name, validated with its variables, and on record beside its journal.
 */
export interface AskedToMake extends Pick<AskedFor, "parent" | "started" | "above"> {
  signal: AbortSignal;
  label?: string;
  env?: Record<string, string>;
}

/**
 * How a project is made or changed for a program that asks its runner to.
 * The runner is handed it by what starts runs (the runner surface): it is
 * that which knows how a program is written, and it stands on this.
 */
export type Making = (request: MakeRequest, asked: AskedToMake) => Promise<void>;

/** What a run is told when a program asked for it, rather than a person or a host. */
interface AskedFor {
  /** How many runs deep it is: one more than the run that asked. */
  depth: number;
  /** The call that asked for it: which run's, and which of that run's calls. */
  parent: { run: string; journal: string; seq: number };
  /** Called once this run has a journal of its own. */
  started(run: string, journal: string): void;
  /** The count of what the run that asked uses of a model: what this one uses is counted there too, and held to it. */
  above?: Meter;
}


/**
 * Run a project, in this process: this is what a runner does.
 *
 * `askedFor` is set when a program asked for the run (see the "/run/program"
 * call). One runner carries the whole tree of runs, so it is also where the
 * tree is kept from growing without bound.
 */
export async function runProgram(options: RunOptions, askedFor?: AskedFor, making?: Making): Promise<ProgramResult> {
  const depth = askedFor?.depth ?? 0;
  if (depth > MAX_RUN_DEPTH) {
    throw new Error(
      `Not running ${options.projectDir}: programs are running programs more than ${MAX_RUN_DEPTH} deep. ` +
      `A program that runs itself, or two that run each other, never ends.`
    );
  }
  if (runsInFlight >= MAX_RUNS_IN_FLIGHT) {
    throw new Error(`Not running ${options.projectDir}: ${MAX_RUNS_IN_FLIGHT} runs are already in flight.`);
  }
  runsInFlight += 1;
  try {
    return await runProject(options, depth, askedFor, making);
  } finally {
    runsInFlight -= 1;
  }
}

async function runProject(options: RunOptions, depth: number, askedFor?: AskedFor, making?: Making): Promise<ProgramResult> {
  const { projectDir } = options;

  if (!existsSync(join(projectDir, "meta.json"))) {
    throw new Error(
      `Project not found at ${projectDir}. ` +
      `Run \`trama list\` to see available projects.`
    );
  }

  const config = loadProjectConfig(projectDir);
  const maxRepairAttempts = options.maxRepairAttempts ?? config.maxRepairAttempts;
  const timeout = options.timeout ?? config.defaultTimeout;

  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`Invalid timeout: ${timeout}. Must be a positive number.`);
  }
  if (!Number.isInteger(maxRepairAttempts) || maxRepairAttempts < 0) {
    throw new Error(`Invalid maxRepairAttempts: ${maxRepairAttempts}. Must be a non-negative integer.`);
  }
  const env = options.env == null ? undefined : checkedEnv(options.env);
  // Its own budget — the config's, for a run nobody's program asked for and that was given none — under the budgets above it.
  const budget = options.budget != null ? checkedBudget(options.budget) : askedFor ? undefined : config.budget;
  const meter = createMeter(budget, askedFor?.above);

  const journal = openJournal(projectDir, config.journalRuns, {
    purpose: "run",
    label: options.label,
    depth,
    parent: askedFor?.parent,
    workspace: options.workspaceDir,
    timeout,
    maxRepairAttempts,
    budget,
    // (The names: what the variables hold is not for a journal.)
    env: env && Object.keys(env),
    args: options.args, // last: it is the one field of unknown size
  });
  askedFor?.started(journal.run, journal.path);
  const stillTheProject = sameProjectAs(projectDir);

  const outOfBudget = (why: string) => console.warn(tagged(options.label, `[trama] ${why}`));
  const { result, repair } = await journalled(journal, createBackend(config, meter, saysOnce(meter, outOfBudget)), (backend) => executeProgram({
    projectDir,
    backend,
    meter,
    making,
    maxRepairAttempts,
    timeout,
    maxIterations: config.defaultMaxIterations,
    argsOverride: options.args,
    workspaceDir: options.workspaceDir,
    depth,
    label: options.label,
    env,
    agentChanges: config.agentChanges,
    signal: options.signal,
    journal,
  }));

  if (repair) {
    // The program is fixed and has run; failing to write this down must not turn that into an error.
    try {
      stillTheProject();
      const message = `Repair attempt ${repair.attempt}/${maxRepairAttempts}`;
      appendLogEntry(guardPath(projectDir, LATEST_LOG_PATH), message, { error: repair.error });
      console.log(tagged(options.label, `[trama] ${message}`));
      copyToHistory(projectDir, "repair", repair.error);
    } catch (err) {
      console.warn(tagged(options.label, `[trama] repair bookkeeping failed: ${messageOf(err)}`));
    }
  }
  return result;
}
