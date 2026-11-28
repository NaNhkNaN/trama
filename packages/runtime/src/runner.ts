import { spawn } from "child_process";
import {
  readFileSync, writeFileSync,
  readdirSync, mkdirSync, existsSync, statSync,
  symlinkSync, rmSync, readlinkSync,
  mkdtempSync, openSync, closeSync, chmodSync,
  accessSync, constants,
} from "fs";
import { basename, join, dirname, relative, resolve } from "path";
import { tmpdir } from "os";
import { createHash, randomBytes } from "crypto";
import type { OutsideAgent, ShellResult } from "./types.js";
import type { Beyond, Check, MakeRequest, RunOptions, ProgramResult, ReplayAllResult, ReplayOptions, ReplayResult, RolledBack, VersionMade } from "./runner-types.js";
import { readProjectMeta } from "./meta.js";
import { describeProject, describeProjects, fitted, withHeld, type Held } from "./contract.js";
import { createReplay, readRecording, runsToReplay, saysTheSame, type Recording, type Replay } from "./replay.js";
import { onAbort, rejectOnAbort, throwIfAborted } from "./abort.js";
import { checkedBudget, createMeter, type Budget, type Meter } from "./budget.js";
import { LATEST_LOG_PATH, appendLogEntry, createContext } from "./context.js";
import { createAgent } from "./agent.js";
import { createTools } from "./tools.js";
import { createWorkspace, type WorkspaceWithAgents } from "./workspace.js";
import { guardPath, identityOf, projectAt, realRootOf, sameProjectAs, wayTo } from "./path-guard.js";
import { ITSELF, copyTree, differences, entryAt, pathAsListed, readTree, thingOf, type Thing, type Tree } from "./tree.js";
import { mergeTree, type Unmerged } from "./merge.js";
import { stageFile, stageFileInProject, type StagedFile } from "./replace-file.js";
import { checkedEnv, createAllowance, superviseChild, type ChildExit } from "./child-process.js";
import { removeTempDir, removeWithThisProcess, requireWatchdog, stopGroups, stopWithThisProcess } from "./stopping.js";
import { createIPCServer, listen, closeServer } from "./ipc-server.js";
import { journalEntriesOf, openJournal, type Journal } from "./journal.js";
import { messageOf } from "./errors.js";
import { checkedRepairAttempts, checkedTimeout, ensureProjectScaffold, loadProjectConfig, loadState, namesAPath, ownProgram, OWN_FIXER, projectNamed, saveState } from "./project.js";
import { createBackend, saysOnce, type Backend } from "./runner-backend.js";
import { copyToHistory, heldNow, heldOfVersion, noteRun, programHashOf, readHistory, recordAsFound, recordVersion, textIsOf, textOfVersion, versionWith, versionsOf } from "./history.js";

/**
 * tsx lets node run program.ts. Resolved through the module system, so any
 * install layout works. It is loaded into the program's own node process
 * rather than run as the `tsx` command, which puts a process of its own in
 * front of the program: one that kills the program some 60 ms after a SIGTERM
 * it has not acted on, and reports its death by signal as an exit code.
 */
const TSX_LOADER = import.meta.resolve("tsx");

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
    "/** What a model called a tool with, held to the parameters the tool declared (see AgentTool): the declared fields and no others — or it throws what is wrong, in words the model can be handed. */",
    "export declare function heldTo(parameters: Schema | undefined, given: unknown): Record<string, unknown>;",
    "/** The program in a model's reply, where the reply was to be a program and nothing else: what stands in its fences, where it is fenced — else the reply as it is. For a program that asks its agent for one. */",
    "export declare function stripCodeFences(reply: string): string;",
  ].join("\n"),
].join("\n\n");

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

/** What is said where a copy's meta.json had been changed by whoever worked in it (see `metaHeld`). */
export const META_PUT_BACK = "[trama] meta.json was changed in the copy that was worked in: it is put back as it was, and nothing of that is kept — what a project says of itself is not for whoever writes or fixes its program to change.";

/**
 * What a project says of itself — its meta.json: what it is for, what a run
 * of it takes and gives, who checks it — is the project's, and not for
 * whoever writes or fixes its program to change. Such a one works in a copy
 * of the project, with tools; the program it answers with is then tried in
 * that copy, and what it did there is kept with a program that works. So
 * the copy's meta.json is held here as the copy was made: the function
 * returned puts it back as it was — the name, and what is read by it — and
 * says whether it had been changed. Asked before a program is tried in the
 * copy, the program is held to what the project says and not to what its
 * writer made of that; and nothing of it is left to be kept.
 */
function metaHeld(copy: string): { read(): string | null; putBack(): boolean; hold(text: string): void } {
  const root = realRootOf(copy), name = join(root, "meta.json");
  const read = (): Buffer | null => { try { return readFileSync(guardPath(copy, "meta.json")); } catch { return null; } };
  const nameWas = entryAt(name);
  let was = read();
  let allowed: number | undefined;
  try { allowed = statSync(guardPath(copy, "meta.json"), { throwIfNoEntry: false })?.mode; } catch { /* (None that can be asked.) */ }
  const sameName = (): boolean => {
    const nameIs = entryAt(name);
    return nameIs?.kind === nameWas?.kind && (nameIs?.kind !== "link" || (nameWas?.kind === "link" && nameWas.text === nameIs.text));
  };
  /** Have the name be what it was, and what is read by it be `was`. */
  const put = (): void => inDirOfCopy(root, () => {
    if (!sameName()) {
      rmSync(name, { recursive: true, force: true });
      if (nameWas?.kind === "link") symlinkSync(nameWas.text, name);
    }
    if (was === null) return;
    // (A new file in the place of whatever is there: one that is there may allow no writing, and is not written through.)
    const place = guardPath(copy, "meta.json");
    const text = was;
    inDirOfCopy(whereMade(place), () => {
      rmSync(place, { recursive: true, force: true });
      writeFileSync(place, text, { flag: "wx", mode: (allowed ?? 0o644) & 0o7777 });
    });
  });
  return {
    read: () => read()?.toString("utf-8") ?? null,
    putBack() {
      const now = sameName() ? read() : null;
      if (sameName() && (was === null ? now === null : now !== null && now.equals(was))) return false;
      put();
      return true;
    },
    // (The project's own has been made this — at its making, see `Prepared.says` — and the copy's is from here on held as this.)
    hold(text) {
      was = Buffer.from(text);
      put();
    },
  };
}

/**
 * All that makes a directory's program.ts lead to its program, as the
 * directory stands: the name, each link and each directory on the way, the
 * file — each by what it is (see Entry), which is asked of the place,
 * whatever its directory lists or allows.
 */
const programParts = (dir: string): Thing[] => wayTo(dir, "program.ts").flatMap((place) => thingOf(entryAt(place)) ?? []);

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
function copyProjectWith(projectDir: string, privateDir: string, program?: string, among = projectDir): { copy: string; held: Tree; beside: Beside } {
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
  /** The program that is started, from the project: program.ts — or, of a run of another version, that version's file. */
  entry?: string;
  /** What the run is held to, in the place of what the project's meta.json says it takes and gives: of a run of a version made under something else. */
  says?: Held;
  backend: Backend;
  timeout: number;
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
  /** The agents from outside its program may name (the configuration's: see TramaConfig). */
  agents?: Record<string, OutsideAgent>;
  /** The count of what the run uses of a model: what the runs it asks for use is counted there too. */
  meter?: Meter;
  /** How a project is made or changed where the run's program asks for that (see Making). Without it, nothing is. */
  making?: Making;
  /** What no making of the run's reaches (see Beyond). */
  beyond?: Beyond;
  /** Stops the run. */
  signal?: AbortSignal;
  /** Where the run is written down. One journal covers every attempt of a run. */
  journal: Journal;
  /** Which attempt of the run this is: 0 for the program as it was, 1 and up for fixes. */
  attempt?: number;
  /**
   * The run is a replay: the program's calls to the world are answered from
   * a record and none is carried out, and the program is stopped where it
   * leaves the record (see replay.ts). It then has no outcome.
   */
  replaying?: Replay;
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

/**
 * How a run that failed is said to whoever asked for it: as a program's
 * failure — which the reasons that begin so say for themselves, and is not
 * said of them twice.
 */
export const failureOf = (reason: string | undefined): string => (reason?.startsWith("Program failed") ? reason : `Program failed: ${reason}`);

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
    saveState(projectDir, state);
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
  const { projectDir, backend, timeout, argsOverride, validating, workspaceDir, label, signal, journal } = options;
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
    argsOverride,
    onReady: validating && (() => {
      readyTimer ??= setTimeout(() => validated.abort(), validating.readyGraceMs).unref();
    }),
    print: line => console.log(tagged(label, line)),
    ...(options.says && { says: options.says }),
    // What the result had and the project does not say it gives: on the run's record — and aloud where nobody's
    // program asked for the run, as of an argument that is not taken. (There is someone there who asked for the
    // field, or wrote its name wrongly.)
    leftOut: (names, gives) => {
      journal.note("left-out", { result: names });
      if (options.depth === 0) console.warn(tagged(label, `[trama] the result has ${names.map((name) => JSON.stringify(name)).join(", ")}, which the project does not say it gives: left out of what the run gave. It gives: ${gives}.`));
    },
  });
  journal.note("attempt", {
    attempt,
    // Where it runs — a copy of the project, when a fix is being tried or a candidate validated.
    dir: projectDir,
    program: fingerprint(guardPath(projectDir, options.entry ?? "program.ts")),
    resumed: ctx.resumed,
    // What it began from: a replay of the attempt begins there. (Last: it is the one field of no known size.)
    state,
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
  /** What the program asked for is waited for as the run ends: the run is not over before it is. */
  const notOverBefore = <T>(asked: Promise<T>): Promise<T> => {
    const going = asked.finally(() => { nestedRuns.delete(going); });
    nestedRuns.add(going);
    return going;
  };
  /**
   * What a program asks its runner for — a run, a project made — is this
   * run's own: stopped when this run ends, or when the program no longer
   * wants it (`stop`); counted in this run's budget; and on record both
   * ways — this run's journal says what the call `seq` started, and what
   * was started says which call started it.
   */
  const itsOwn = (seq: number, stop: AbortSignal, purpose?: string) => ({
    signal: AbortSignal.any([runEnded.signal, stop]),
    above: options.meter,
    parent: { run: journal.run, journal: journal.path, seq },
    started: (run: string, path: string) => { if (run) journal.note("child", { seq, run, journal: path, ...(purpose && { purpose }) }); },
  });
  const workspaces = new Map<string, WorkspaceWithAgents>();
  const workspaceAt = (dir: string): WorkspaceWithAgents => {
    let workspace = workspaces.get(dir);
    // (Its shell and its agents from outside are this run's: what is started there is stopped with the run, has the
    // run's variables, and an agent named there is one the run's configuration names.)
    if (!workspace) workspaces.set(dir, workspace = createWorkspace(dir, runEnded.signal, () => tools));
    return workspace;
  };
  // The workspace of the session this run is part of, if it is part of one.
  // (In a replay it is not come to: nothing of a workspace is carried out, and none is made where there was none.)
  const sessionWorkspace = workspaceDir && !options.replaying ? workspaceAt(workspaceDir) : null;
  const tools = createTools(projectDir, runEnded.signal, options.env, options.agents);
  // As far as a validation goes: the program asks its runner for what would be real — a run, a project
  // made. The call is left unanswered — an answer would only send the program on to do more — until
  // the program, which is being stopped, lets go of it.
  const handOff = (what: Exclude<typeof handedOff, false>, stop: AbortSignal): Promise<never> => {
    handedOff = what;
    validated.abort();
    return rejectOnAbort(new Promise<never>(() => {}), stop);
  };
  // A replay goes as far as its record: where the program leaves that, it is asked to stop.
  options.replaying?.whenLeft(() => validated.abort());
  // Known only to this run's program, through its init file.
  const token = randomBytes(32).toString("hex");
  // Whether the program's process has ended. (Nothing is an answer to it after that, and it is no longer there to stop.)
  let programOver = false;
  const server = createIPCServer({
    token,
    ctx,
    // (Its agent works in the project — or, where a call says so, in the workspace the run was given.)
    agent: createAgent(backend, projectDir, runEnded.signal, workspaceDir ? resolve(workspaceDir) : undefined),
    tools,
    workspace: sessionWorkspace,
    workspaceAt,
    journal,
    replaying: options.replaying,
    programOver: () => programOver,
    make: (request, stop, seq) => {
      if (validating) return handOff("has a project made or changed", stop);
      if (!options.making) {
        throw new Error("This run has no way to make projects, or change them: it was started without one — as a run that checks, fixes or writes is, and any run whose asker says so (making: false), or whose runner has none to give.");
      }
      // The run's own, as a run it asks for is: under its budget, with its variables, stopped when it
      // ends or when the program no longer wants it, and not over before this is. (But the program's
      // clock goes on: what it has made is its own work, with no timeout but the program's.)
      // (What it starts is a validation: of the program the project is made with.)
      return notOverBefore(options.making(request, {
        ...itsOwn(seq, stop, "validate"), label, env: options.env, depth: options.depth, beyond: options.beyond,
        writing: (run, path) => { if (run) journal.note("child", { seq, run, journal: path, purpose: request.kind === "create" ? "create" : "update" }); },
      }));
    },
    run: (request, stop, seq) => {
      if (validating) return handOff("starts another program", stop);
      // The program is waiting, not working: its clock stops for as long as
      // the run it asked for lasts, which has a timeout of its own. That run
      // is stopped when this one ends, or when the program no longer wants it.
      const release = allowance.hold();
      // What this run was started with, the run it asks for has too — and what it is given besides.
      const env = options.env || request.env ? { ...options.env, ...request.env } : undefined;
      const { signal, ...asked } = itsOwn(seq, stop);
      return notOverBefore(runProgram({ ...request, env, signal }, { depth: options.depth + 1, ...asked, beyond: options.beyond }, options.making).finally(release));
    },
    // What is read of a project's history is read here — in a validation too: it changes nothing.
    history: (dir, runs) => readHistory(dir, runs === undefined ? {} : { runs }),
    mark: inputMarkOf,
    // And what a project says of itself — or every project of the user's: read here, and on the run's record.
    describe: (named) => (named === undefined ? describeProjects() : describeProject(named)),
    // A replay the program asks for is made here, as a run it asks for is — and in a validation too: it
    // carries nothing out and uses nothing, so there is nothing of it to be kept from. It is the run's
    // own: stopped when the run ends or the program no longer wants it, and not over before it is; the
    // program is waiting meanwhile, and its clock stops. (It leaves no journal: nothing points to it.)
    replay: ({ all, ...request }, stop) => {
      const release = allowance.hold();
      const asked = {
        ...request,
        env: options.env || request.env ? { ...options.env, ...request.env } : undefined,
        signal: AbortSignal.any([runEnded.signal, stop]),
      };
      const made: Promise<ReplayResult | ReplayAllResult> = all ? replayAll(asked) : replayProgram(asked);
      return notOverBefore(made.finally(release));
    },
  });

  // The output of a run that has a name is shown under it. It is not its parent's
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
        hasWorkspace: Boolean(workspaceDir),
        resumed: ctx.resumed,
        yieldReason: ctx.yieldReason,
      });

      const program = spawn(process.execPath, ["--import", TSX_LOADER, guardPath(projectDir, options.entry ?? "program.ts")], {
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
        stopSignal: validating || options.replaying ? validated.signal : undefined,
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
    // A replay whose program left the record ended there: the program was stopped in mid-flow, and has no outcome.
    const left = options.replaying?.state.left;
    if (left) {
      noteExit({ left });
      return { outcome: null, failure: `The program left the record at its call ${left.call} (${left.endpoint}): ${left.why}` };
    }
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
  /** The project a fix is asked of: its directory (see RunOptions.repairWith) — without one, the runtime's own fixer (see `ownProgram`). */
  repairWith?: string;
}

interface Execution {
  result: ProgramResult;
  /** Set when the program only worked after a repair: which attempt it was (1 for the first fix), and the failure it fixed. */
  repair?: { attempt: number; error: string };
}

/**
 * There is no fix, by whoever was asked for one: the program cannot be made
 * to run and still be the program it was. Not a fix that failed to come —
 * an answer, and the last: nobody is asked again for what was said not to
 * be had.
 */
class NoFix extends Error {}

/**
 * A question to ask of a copy an agent has worked in: whether what is at its
 * path is still the directory that was read (`was`). An agent can move its
 * copy away and leave a link there, or nothing: what is done next is done in
 * the copy, not in what a link leads to, nor in a directory made anew.
 */
const sameCopyAs = (copy: string, was: Tree) => (): void => {
  const there = entryAt(copy), itself = was.get(ITSELF);
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
  /** Puts the copy's meta.json back as it was when the copy was made, and says whether it had been changed (see `metaHeld`). */
  own(): boolean;
  /** The copy as it was before anything was done in it. What differs from this afterwards is what was done: by the agent, and by the run of its fix. */
  before: Tree;
  /**
   * The program as the copy had it then: all that made program.ts lead to it
   * (see programParts), the place it led to — which is the place of the
   * project's program in the project — as it is and as the copy listed it,
   * and what the file allowed.
   */
  program: { parts: Thing[]; place: string; listed: string | undefined; allowed: number };
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
interface FixInPlace { root: string; name: string; allowed: number; parts: Thing[] }
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
    copy, held, beside, before, intact: sameCopyAs(copy, before), own: metaHeld(copy).putBack, fix,
    program: { parts: fix.parts, place, listed: pathAsListed(copy, place), allowed: fix.allowed },
  };
}

/** How many of the paths an agent changed are written down, or shown. */
const MAX_PATHS_NOTED = 200;
const MAX_PATHS_SHOWN = 10;
export const shownPaths = (paths: string[]): string => paths.slice(0, MAX_PATHS_SHOWN).join(", ") + (paths.length > MAX_PATHS_SHOWN ? ", …" : "");

/**
 * Ask for a fix: of the project that fixes — the one that is named, or the
 * runtime's own (see `fixedBy`, `ownProgram`). It works in a copy of the
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
  // What the project that is asked for the fix uses is on its own record, as any run's is — and is said here too,
  // with the fix: what a fix took is then read where the fix was asked for. Counted as the run's count grew while
  // it was asked.
  let fixer = options.repairWith;
  const before = options.meter?.counted();
  const usedByAProject = (): { by?: string; used?: { calls: number; tokens: number; cost: number } } => {
    const now = before && options.meter?.counted();
    return before && now && fixer !== undefined ? { by: fixer, used: { calls: now.calls - before.calls, tokens: now.tokens - before.tokens, cost: now.cost - before.cost } } : {};
  };
  const timedOut = new AbortController();
  const limit = createAllowance(options.timeout);
  const signal = options.signal ? AbortSignal.any([timedOut.signal, options.signal]) : timedOut.signal;
  try {
    const kept = options.agentChanges !== "discard" && !options.validating;
    const staged = stageProject(options.projectDir, privateDir, input.programSource);
    limit.start(() => timedOut.abort());
    // Who is asked: the project that is named — or, where none is, the runtime's own fixer, a project among the
    // user's (see `ownProgram`). The runtime has no words of its own for a fix: what a model is asked is the fixer's.
    fixer ??= ownProgram(OWN_FIXER, (line) => console.log(tagged(options.label, line)));
    const fixed = await fixedBy(fixer, options, { ...input, kept, copy: staged.copy }, signal);
    if (fixed.trim() === "") throw new Error("The repair returned an empty program.");
    if (!kept) {
      if (fixed === input.programSource) throw new Error("The repair returned the program unchanged.");
      options.journal.note("fix", { ok: true, ...usedByAProject(), source: fixed });
      return { fixed };
    }
    let changed: string[] = [], unusable: string | undefined, metaPutBack = false;
    try {
      staged.intact();
      // What the project says of itself is not the fixer's to change: the fix is tried under what the project says, and none of that is kept with it.
      if (staged.own()) {
        metaPutBack = true;
        console.warn(tagged(options.label, META_PUT_BACK));
      }
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
      ...usedByAProject(),
      ...(changed.length > 0 ? { changed: changed.slice(0, MAX_PATHS_NOTED) } : {}),
      ...(changed.length > MAX_PATHS_NOTED ? { changedInAll: changed.length } : {}),
      ...(metaPutBack && { metaPutBack }),
      alone: unusable,
      source: fixed,
    });
    return unusable === undefined ? { fixed, staged } : { fixed, unusable };
  } catch (err) {
    const error = err instanceof NoFix ? `It was said that there is none to be had: ${err.message}` : messageOf(err);
    options.journal.note("fix", { ok: false, ...(err instanceof NoFix && { none: true }), ...usedByAProject(), error });
    return { error };
  } finally {
    limit.cancel();
  }
}

/**
 * Ask a project for a fix (see RunOptions.repairWith): its program is run
 * with the copy as its workspace, and what it ends with is the answer. It is
 * a run of the failing run's own — under its count, stopped with it, started
 * with its variables, on its record — and a run like any otherwise, with a
 * journal of its own in its own project. Not one that is fixed where it
 * fails: what fixes would then be asked to fix what fixes.
 */
async function fixedBy(
  project: string,
  options: ExecuteOptions,
  asked: { programSource: string; error: string; kept: boolean; copy: string },
  signal: AbortSignal,
): Promise<string> {
  if (realRootOf(project) === realRootOf(options.projectDir)) {
    throw new Error("A project is not asked to fix itself: repairWith names the project that failed.");
  }
  const { journal } = options;
  const result = await runProgram({
    projectDir: project,
    workspaceDir: asked.copy,
    maxRepairAttempts: 0,
    timeout: options.timeout,
    label: options.label ? `${options.label}: fix` : "fix",
    env: options.env,
    signal,
    args: { program: asked.programSource, error: asked.error, journal: journal.path, kept: asked.kept, types: RUNTIME_TYPES },
  }, {
    depth: options.depth + 1,
    parent: { run: journal.run, journal: journal.path },
    started: (run, path) => { if (run) journal.note("child", { run, journal: path, purpose: "fix" }); },
    above: options.meter,
    purpose: "fix",
  });
  if (result.status !== "done") {
    throw new Error(`The project asked for the fix ${result.status === "failed" ? "failed" : "did not end its work"}: ${result.reason ?? result.status}`);
  }
  const { program, unfixable } = (result.result ?? {}) as { program?: unknown; unfixable?: unknown };
  if (typeof unfixable === "string" && program === undefined) throw new NoFix(unfixable.trim() || "no reason was given");
  if (typeof program !== "string") {
    throw new Error("The project asked for the fix answered with no program: its result is to be { program }, the whole of the fixed program — or { unfixable }, why there is no fix.");
  }
  return program;
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
 * The shared workspace is not copied. It is how runs that work together
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
  let is: Thing[];
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
  const copied = held.get(ITSELF), there = entryAt(projectRoot);
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
    ...mergeTree(stagedProject, projectDir, before, held, [[...staged.program.parts, ...was, ...is]]),
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
    const spent = options.backend.spent();
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
    if (journal.run || backend.counts()) await backend.letGo();
    const spent = backend.spent() ?? backend.refused();
    if (spent !== undefined) journal.note("budget", { spent });
    journal.note("end", end);
    journal.close();
    // Nothing a run started outlives it: nor what served its agent calls.
    await backend.close();
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
    timeout: number; maxRepairAttempts: number; journalRuns?: number; signal?: AbortSignal;
    as?: string; alone?: string; budget?: Budget;
    /** Where a run's program asked for the project to be made or changed: the run's name and variables are the validation's, and the two journals point at each other. */
    label?: string; env?: Record<string, string>; askedFor?: Pick<AskedFor, "parent" | "started">;
    /** The agents from outside the program may name (the configuration's). */
    agents?: Record<string, OutsideAgent>;
    /** The project a fix of the candidate is asked of: the one the configuration names — else the runtime's own fixer. With the count it is made under. */
    repairWith?: string; meter?: Meter;
    /** Who wrote the candidate — the project that was asked — and what that took: said on the validation's record, with which run of that project's it was (`what`: a project's first program, or its next). */
    writtenBy?: { by: string; used: { calls: number; tokens: number; cost: number }; run?: string; journal?: string; what?: "create" | "update" };
    /**
     * The project's meta.json as it is to be with the candidate, where
     * whoever asked for it says what the project is to take and give from
     * then on: the candidate is validated under that — the copy it is tried
     * in has this for its meta.json — and not under what the project says yet.
     */
    says?: string;
  },
): Promise<{ source: string; repairedError?: string; alone?: string }> {
  const { journalRuns = 0, signal, as = projectDir, timeout, maxRepairAttempts, label, env, askedFor } = options;
  // (What is written down, and handed on, is what a validation is known to take: nothing else that came with it.)
  const limits = { timeout, maxRepairAttempts };
  // Recorded with the project, though run in a copy of it. `budget` is for the record: the backend is what holds to it.
  const journal = openJournal(projectDir, journalRuns, {
    purpose: "validate", label, parent: askedFor?.parent, ...limits, budget: options.budget, env: env && Object.keys(env),
  });
  askedFor?.started(journal.run, journal.path);
  // Who wrote the candidate, and what that took, is on record with its validation.
  if (options.writtenBy) {
    const { run, journal: its, what, ...written } = options.writtenBy;
    if (run) journal.note("child", { run, journal: its, purpose: what });
    journal.note("written", written);
  }
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
    const { says } = options;
    if (says !== undefined) inDirOfCopy(realRootOf(trialDir), () => stageFile(trialDir, "meta.json", says).commit());

    const execution = await executeProgram({
      ...limits,
      projectDir: trialDir,
      backend,
      depth: 0,
      validating: { readyGraceMs: VALIDATION_READY_GRACE_MS },
      label,
      env,
      agents: options.agents,
      repairWith: options.repairWith,
      meter: options.meter,
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
  if (result.status === "failed") throw new Error(failureOf(result.reason));
  return { source: left, repairedError: repair?.error, ...(alone === undefined ? {} : { alone }) };
}

// --- A check of a run, by a project (see RunOptions.checkWith) ---

/**
 * The project a run is to be checked by: the one the run names, or else the
 * one its project names — or none. Throws where what is named is no
 * project, or is the project that is run.
 */
function checkerOf(options: RunOptions): string | undefined {
  const { projectDir } = options;
  let checker: string;
  if (options.checkWith != null) checker = projectNamed(options.checkWith);
  else {
    const named: unknown = readProjectMeta(projectDir).checkWith;
    if (named == null) return undefined;
    if (typeof named !== "string" || named.trim() === "") {
      throw new Error(`Malformed meta.json in ${projectDir} — "checkWith" is to name a project: by a path, or by its name among the user's projects.`);
    }
    // (A path the project says is said from where the project is: not from wherever its runner happens to be.)
    checker = namesAPath(named) && !named.startsWith("~") ? resolve(projectAt(projectDir), named) : projectNamed(named);
  }
  if (!existsSync(join(checker, "meta.json"))) throw new Error(`checkWith names no project: there is none at ${checker}`);
  if (realRootOf(checker) === realRootOf(projectDir)) throw new Error("A project is not asked to check itself: checkWith names the project that is run.");
  return checker;
}

const NO_VERDICT = "The project asked for the check answered with no verdict: its result is to be { ok, score?, notes? } — whether the work is good (true or false), how good where it says (a number), and why where it says (a text).";
const STOPPED_CHECK = "The run was stopped before its check was made.";

/** What a checker ended with, held to what a verdict is: that, and nothing else it said. */
function verdictOf(ended: unknown): Pick<Check, "ok" | "score" | "notes"> {
  const { ok, score, notes } = (ended !== null && typeof ended === "object" ? ended : {}) as Record<string, unknown>;
  if (typeof ok !== "boolean") throw new Error(NO_VERDICT);
  if (score != null && (typeof score !== "number" || !Number.isFinite(score))) throw new Error(NO_VERDICT);
  if (notes != null && typeof notes !== "string") throw new Error(NO_VERDICT);
  return { ok, ...(score != null && { score }), ...(notes != null && { notes }) };
}

/**
 * Have a run that is done checked by a project: the checker's program is
 * run with a throwaway copy of the project as the run left it for its
 * workspace, and what it ends with is the verdict. It is a run of the
 * checked run's own, as a fix asked of a project is — under its count,
 * stopped with it, started with its variables, on its record — with a
 * journal of its own in the checker's project; it is not fixed where it
 * fails, and not checked in its turn.
 *
 * Whatever comes of it is a check: a verdict, or why there is none. It does
 * not throw, and what it finds changes nothing of the run it checks.
 */
async function checkedBy(
  checker: string,
  result: ProgramResult,
  run: {
    projectDir: string; args?: Record<string, unknown>; timeout: number; depth: number; label?: string;
    env?: Record<string, string>; signal?: AbortSignal; meter: Meter; journal: Journal;
    /** What the run was held to, where that was not what the project says (see RunOnceOptions). */
    says?: Held;
    /** The workspace the run worked in, where it had one. */
    workspaceDir?: string;
  },
): Promise<Check> {
  const { projectDir, journal, signal } = run;
  const began = performance.now(), before = run.meter.counted();
  // Who checks is said by what it is, and not only by where: a checker that was changed is another checker.
  let program: string | undefined;
  try { program = fingerprint(guardPath(checker, "program.ts"))?.sha256; } catch { /* (It has none to be told by: its run will say so.) */ }
  const by = { by: checker, ...(program !== undefined && { program }) };
  let found: Pick<Check, "ok" | "score" | "notes"> | { error: string };
  try {
    if (signal?.aborted) throw new Error(STOPPED_CHECK);
    found = await withTempDir("trama-check-", async (privateDir) => {
      // (A copy, and its own: what the checker does there — tests put in, a build — is thrown away with it.)
      const { copy } = copyProjectWith(projectDir, privateDir);
      const ended = await runProgram({
        projectDir: checker,
        workspaceDir: copy,
        maxRepairAttempts: 0,
        timeout: run.timeout,
        label: run.label ? `${run.label}: check` : "check",
        env: run.env,
        signal,
        // What the run was started with, as its program had it: the project's own arguments under the run's.
        // And where it worked, where that was not its project: a run that had a workspace left its work there, and the
        // copy the checker has is of the project. (The place itself, as the run's record is: a checker that would change
        // something there makes a copy of its own.)
        // And what the run had used of a model when its check began, by the runner's own count — the one a budget is
        // held by: a record may be cut short, or not kept at all, and what the check itself uses is no part of the work.
        args: {
          result: result.result, args: argumentsOf(projectDir, run.args, run.says), journal: journal.path, run: journal.run,
          used: { calls: before.calls, tokens: before.tokens, cost: before.cost },
          ...(run.workspaceDir !== undefined && { workspace: resolve(run.workspaceDir) }),
        },
      }, {
        depth: run.depth + 1,
        parent: { run: journal.run, journal: journal.path },
        started: (started, path) => { if (started) journal.note("child", { run: started, journal: path, purpose: "check" }); },
        above: run.meter,
        purpose: "check",
      });
      if (ended.status !== "done") {
        throw new Error(`The project asked for the check ${ended.status === "failed" ? "failed" : "did not end its work"}: ${ended.reason ?? ended.status}`);
      }
      return verdictOf(ended.result);
    });
  } catch (err) {
    found = { error: signal?.aborted ? STOPPED_CHECK : messageOf(err) };
  }
  // What the checker asked of a model is counted in this run's count, and is on record in the checker's own
  // journal: it is said here too, with the check, as what a project asked for a fix used is said with the fix.
  const now = run.meter.counted();
  const used = { calls: now.calls - before.calls, tokens: now.tokens - before.tokens, cost: now.cost - before.cost };
  journal.note("check", { ...by, ms: Math.round(performance.now() - began), ...(used.calls > 0 && { used }), ...found });
  const inALine = (text: string) => { const line = text.replace(/\s+/g, " ").trim(); return line.length > 200 ? `${line.slice(0, 200)}…` : line; };
  console.log(tagged(run.label, "error" in found
    ? `[trama] not checked by ${checker}: ${inALine(found.error)}`
    : `[trama] checked by ${checker}: ${found.ok ? "ok" : "not ok"}${found.score !== undefined ? ` (score ${found.score})` : ""}${found.notes ? ` — ${inALine(found.notes)}` : ""}`));
  return { ...by, ...found };
}

// --- Replaying a recorded run (see replay.ts) ---

/** A backend for a run in which nothing is asked of a model: whatever is asked of it all the same is refused. */
function noBackend(): Backend {
  const refuse = async (): Promise<never> => { throw new Error("A replay asks nothing of a model."); };
  return { ask: refuse, complete: refuse, spent: () => undefined, refused: () => undefined, counts: () => false, close: async () => {}, letGo: async () => {} };
}

/**
 * Replay a recorded run of a project: run its program — or `program`, in
 * its place — with each call answered from the record and none carried out
 * (see replay.ts). The program runs in a throwaway copy of the project, from
 * the state the recorded attempt began from, with what that run was started
 * with; nothing reaches the project, nothing is asked of a model, and no
 * journal is written: what a replay found is what it returns.
 *
 * Throws where there is nothing to replay, or the record does not say what
 * the run began from. That a program left its record, or failed, is a
 * result.
 */
export async function replayProgram(options: ReplayOptions): Promise<ReplayResult> {
  toBeReplayed(options.projectDir);
  return replayOf(readRecording(options.projectDir, options.run), options);
}

/**
 * Hold a project's program — or `program`, in its place — to every run of
 * the project that is on record and over: each replayed by itself, as
 * `replayProgram` replays one. A run whose record does not say what a
 * replay has to begin from is passed over, and said. It is the check a
 * change that is meant to change nothing can be held to: a record is a test
 * of the way its run went, and of nothing the run did not do.
 *
 * Throws where the project has no run on record.
 */
export async function replayAll(options: Omit<ReplayOptions, "run">): Promise<ReplayAllResult> {
  toBeReplayed(options.projectDir);
  const runs = runsToReplay(options.projectDir);
  if (runs.length === 0) throw new Error("No run of the project is on record: there is nothing to replay.");
  const each: ReplayAllResult["runs"] = [];
  for (const run of runs) {
    if (options.signal?.aborted) throw new Error(STOPPED_REPLAY);
    let recording: Recording;
    try {
      recording = readRecording(options.projectDir, run);
    } catch (err) {
      each.push({ run, notReplayed: messageOf(err) });
      continue;
    }
    each.push({ run, replay: await replayOf(recording, options) });
  }
  const replayed = each.filter(({ replay }) => replay !== undefined).length;
  return { runs: each, replayed, same: replayed > 0 && each.every(({ replay }) => replay === undefined || replay.same) };
}

const STOPPED_REPLAY = "The replay was stopped before it finished.";

/** A replay is of a project that is there. */
function toBeReplayed(projectDir: string): void {
  if (!existsSync(join(projectDir, "meta.json"))) {
    throw new Error(`Project not found at ${projectDir}. Run \`trama list\` to see available projects.`);
  }
}

/** Replay one recording of the project (see `replayProgram`). */
async function replayOf(recording: Recording, options: Omit<ReplayOptions, "run">): Promise<ReplayResult> {
  const { projectDir } = options;
  const config = loadProjectConfig(projectDir);
  const timeout = checkedTimeout(options.timeout ?? config.defaultTimeout);
  const env = options.env == null ? undefined : checkedEnv(options.env);
  // (Where the program is run is settled below; what it asks from there is read as asked from the project's place.)
  const place = { from: "", to: dirname(projectAt(projectDir)) };
  const replay = createReplay(recording, { loose: options.loose, place });

  const { once, sameProgram } = await withTempDir("trama-replay-", async (privateDir) => {
    // A run that was of a version is replayed as that version, where no program is named: its text, as it is on record.
    // (Where it is no longer to be had, the program as it is is replayed — and is said not to be the one recorded.)
    // (And is held to what that version was made under, as the run was — whatever program is replayed.)
    let ofItsVersion: string | undefined, says: Held | undefined;
    if (recording.version !== undefined) {
      if (options.program === undefined) { try { ofItsVersion = textOfVersion(projectDir, recording.version); } catch { /* (Not to be had.) */ } }
      const madeUnder = heldOfVersion(projectDir, recording.version);
      if (madeUnder.held !== undefined && heldNow(projectDir)?.mark !== madeUnder.mark) says = madeUnder.held;
    }
    const { copy } = copyProjectWith(projectDir, privateDir, options.program ?? ofItsVersion);
    place.from = dirname(copy);
    if (programIn(copy) === null) throw new Error(`There is no program.ts in ${projectDir} to replay.`);
    // The state the recorded attempt began from, in the place of what the project's has come to since.
    if (Object.keys(recording.state).length === 0) rmSync(guardPath(copy, "state.json"), { force: true });
    else saveState(copy, recording.state);
    const sameProgram = fingerprint(guardPath(copy, "program.ts"))?.sha256 === recording.program;
    const once = await runProgramOnce({
      projectDir: copy,
      backend: noBackend(),
      timeout,
      argsOverride: recording.args,
      ...(says && { says }),
      workspaceDir: recording.workspace,
      depth: 0,
      // (What the program prints is shown as a replay's: it is not the output of a run, nor of the program that asked for it.)
      label: "replay",
      env,
      signal: options.signal,
      // (No journal: a replay is not a run of the project's, and is not to push one of its runs out of what is kept.)
      journal: openJournal(projectDir, 0, {}),
      replaying: replay,
    });
    return { once, sameProgram };
  });
  if (options.signal?.aborted) throw new Error(STOPPED_REPLAY);

  const { recorded, answered, other, left } = replay.state;
  // How the recorded attempt ended: its outcome — or, where it failed, how the run did, which is the same failure.
  const recordedResult = recording.outcome ?? (recording.outcome === null ? (recording.end ?? { status: "failed" as const, reason: "The recorded attempt failed." }) : undefined);
  const result = left ? undefined : (once.outcome ?? { status: "failed" as const, reason: once.failure });
  // (Of two failures the words are not held against each other: they tell of where each ran.)
  const sameEnd = result !== undefined && recordedResult !== undefined
    && (result.status === "failed" || recordedResult.status === "failed" ? result.status === recordedResult.status : saysTheSame(result, recordedResult));
  return {
    run: recording.run,
    attempt: recording.attempt,
    sameProgram,
    recorded,
    answered,
    unasked: recorded - answered,
    other,
    ...(left && { left }),
    ...(result && { result }),
    ...(recordedResult && { recordedResult }),
    sameEnd,
    same: !left && answered === recorded && other.length === 0 && sameEnd,
  };
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
  /**
   * Put the copy's meta.json back as it was when the copy was made (see
   * `metaHeld`), and say whether it had been changed: asked once whoever
   * writes has worked, before anything is tried in the copy. Throws, as
   * `ready` does, where what is at the copy's path is no longer the copy.
   */
  own(): boolean;
  /**
   * The copy's meta.json as whoever wrote left it — or null, where none can
   * be read: at a project's making, what its writer says there of what the
   * project takes and gives is the project's contract (see `createProject`).
   * Asked before `own`. Throws where the copy is no longer the copy.
   */
  said(): string | null;
  /** The project's meta.json has been made `text`: the copy's is made the same, and is held as that from here on. */
  says(text: string): void;
  keep(): { changed: string[]; unmerged: Unmerged[] };
}

export function prepareProject(projectDir: string, privateDir: string, program?: string): Prepared {
  // (With `program`: the copy's program is that text — a version of the project's that is to be written from, which is not the program as it is.)
  const { copy, held, beside } = copyProjectWith(projectDir, privateDir, program);
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
  const meta = metaHeld(copy);
  return {
    copy,
    // (Only in the copy itself: where it was moved away and something else put in its place, nothing is read or written
    // there — and nothing of it is tried or kept either, see `ready`.)
    own() {
      intact();
      return meta.putBack();
    },
    said() {
      intact();
      return meta.read();
    },
    says(text) {
      intact();
      meta.hold(text);
    },
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
      // And at meta.json, which is the project's (see `metaHeld`): whatever is there, nothing of it is to arrive.
      const says = pathAsListed(copy, join(root, "meta.json"));
      for (const path of [...places, ...programAt(), ...(says === undefined ? [] : [says])]) {
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
  return stageFileInProject(projectDir, "program.ts", source);
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
  /** The version an update was written from, where its caller knows: else it is the version the program is. */
  parent?: number | null,
  /**
   * What the project is to take and give with this program, where whoever
   * asked for the update says: its meta.json as it is then to be (`text`),
   * and what of it a version is made under (`held`). The two are made the
   * project's together, or neither is.
   */
  says?: { text: string; held: Held },
): number {
  // Three steps, ordered so that a failure at any of them leaves the project
  // as it was: the new program is written beside the old one (nothing else is
  // touched if even that cannot be done), the version is recorded, and only
  // then does the new program take the old one's place — in one move, so
  // program.ts is never half-written, and never a program that is not on record.
  // What an update is written from: the version the program is, while it is still that — or no version, where it is on no record.
  // (Where what the project takes and gives is to be replaced, the project as it is, is put on record first, where it
  // is not: what it took and gave may have been written by hand, and nothing is lost by it.)
  if (says) recordAsFound(projectDir);
  // (By its text: what a program was written from is a program, whatever the project took and gave.)
  const from = reason === "update" ? { parent: parent !== undefined ? parent : textIsOf(projectDir) ?? null } : {};
  const program = stageProgram(projectDir, validated.source);
  let unrecord = () => {}, meta: StagedFile | undefined, was: Buffer | undefined, replaced = false;
  try {
    if (says) {
      was = readFileSync(guardPath(projectDir, "meta.json"));
      meta = stageFileInProject(projectDir, "meta.json", says.text);
    }
    unrecord = recordVersion(projectDir, validated.source, reason, prompt, validated.repairedError
      ? [{ reason: `${reason}-repair`, timestamp: new Date().toISOString(), error: validated.repairedError }]
      : [], from, says?.held);
    meta?.commit();
    replaced = meta !== undefined;
    program.commit();
  } catch (err) {
    unrecord();
    program.discard();
    // (What the project says is what it said, where its program is the one it was.)
    if (replaced && was) { try { stageFileInProject(projectDir, "meta.json", was).commit(); } catch { /* (Not to be put back: said by what is thrown.) */ } } else meta?.discard();
    throw err;
  }
  return (unrecord as { version?: number }).version!;
}

/**
 * Put a validated program on record as a version of the project, beside
 * the program: program.ts is not touched, and nothing else of the project
 * is. It is a version like any — it can be run by its number, and gone to
 * — that the program was never made. Returns its number.
 */
export function keepBeside(
  projectDir: string,
  validated: { source: string; repairedError?: string },
  detail: string | undefined,
  parent: number | null,
  /** What it was made under, where that is not what the project says: it is on record under that, and the project's is not touched. */
  under?: Held,
): number {
  return recordVersion(projectDir, validated.source, "update", detail, validated.repairedError
    ? [{ reason: "update-repair", timestamp: new Date().toISOString(), error: validated.repairedError }]
    : [], { parent, aside: true }, under).version;
}

/**
 * The version a new one is written from, where it is to be kept beside the
 * program: the one that is named — which is to be there — or the program as
 * it is, put on record first where it is not (nothing is lost by it).
 */
export function writtenFrom(projectDir: string, named?: number): number | null {
  if (named === undefined) {
    recordAsFound(projectDir);
    return readHistory(projectDir).current ?? null;
  }
  if (typeof named !== "number" || !Number.isSafeInteger(named) || named < 1) throw new Error("A version is named by its number: 1 and up.");
  if (!versionsOf(projectDir).some((one) => one.version === named)) {
    throw new Error(`No version ${named} is in the history of ${projectDir}: \`trama history <name>\` shows those there are.`);
  }
  return named;
}

/**
 * The program of a run that is of a version: that version's text, in a file
 * of the run's own in the project's directory — where the project's program
 * is, so that what is beside the program is beside it: a module it imports
 * by a relative path, a file it reads by where its own is. (Started from its
 * file in the history, a version that had been found to work where the
 * program is could not be run.) The project's program is not touched, and
 * the file is taken away when the run is over: `remove`.
 */
function besideTheProgram(projectDir: string, version: number): { entry: string; remove(): void } {
  const entry = `.trama-run-${randomBytes(6).toString("hex")}.ts`;
  const place = guardPath(projectDir, entry);
  try {
    writeFileSync(place, textOfVersion(projectDir, version), { flag: "wx" });
  } catch (err) {
    throw new Error(`Version ${version} could not be put beside the program of ${projectDir} to be run: ${messageOf(err)}`);
  }
  return { entry, remove: () => rmSync(place, { force: true }) };
}

// --- Core execution ---

/** How deep programs may run programs, and how many runs one runner carries at a time. */
const MAX_RUN_DEPTH = 16;
const MAX_RUNS_IN_FLIGHT = 128;
let runsInFlight = 0;

/**
 * What a project is made or changed under where a run's program asked for
 * it: that run's — stopped with it, counted in its budget, shown under its
 * name, validated with its variables, and on record beside its journal.
 */
export interface AskedToMake extends Pick<AskedFor, "parent" | "started" | "above"> {
  signal: AbortSignal;
  label?: string;
  env?: Record<string, string>;
  /** How many runs deep the run that asked is. */
  depth?: number;
  /** What is out of the asking run's reach: no project of these is made, or changed, for it. */
  beyond?: Beyond;
  /** Called once a project that writes the program (see `writtenBy`) has a journal of its own: the asking run's record says what it started. */
  writing?(run: string, journal: string): void;
}

/**
 * How a project is made or changed for a program that asks its runner to.
 * The runner is handed it by what starts runs (the runner surface): it is
 * that which knows how a program is written, and it stands on this.
 */
export type Making = (request: MakeRequest, asked: AskedToMake) => Promise<RolledBack | VersionMade | void>;

/** What a run is told when a program asked for it, rather than a person or a host. */
interface AskedFor {
  /** How many runs deep it is: one more than the run that asked. */
  depth: number;
  /** The call that asked for it: which run's, and which of that run's calls — or none of them, where the run itself asked: for a fix. */
  parent?: { run: string; journal: string; seq?: number };
  /** Called once this run has a journal of its own. */
  started(run: string, journal: string): void;
  /** The count of what the run that asked uses of a model: what this one uses is counted there too, and held to it. */
  above?: Meter;
  /** What the runner made the run for, where it made it itself: a fix asked of a project, a check, the writing of a project's first program or of an update. (A check is not checked in its turn, whatever its project says.) */
  purpose?: "fix" | "check" | "create" | "update";
  /** What is out of the reach of the run that asked: it is out of this one's too. */
  beyond?: Beyond;
  /**
   * How it is said that the budget above is spent, where whoever the run is
   * for says that itself: a project that is being made says it once for its
   * budget, in its own words — and the run of whoever writes its program
   * says nothing of it in words of its own.
   */
  spent?(why: string): void;
}

/**
 * Ask a project for a program: the one an update names to write it (see
 * `updateProject`'s `updateWith`), or the runtime's own writer: its program is run
 * with the copy of the project that is being updated as its workspace —
 * the project as it is, what it says of itself and its state with it, its
 * program the one that is written from — and what it ends with is the
 * answer: `{ program }`, the whole of the new program.
 *
 * And so a project's first program (`createProject`'s `createWith`, `what`
 * "create"): the copy is of the project as it was made — its meta.json, and
 * no program — and no program is handed.
 *
 * It is handed the least: what is asked (`prompt`), the program it writes
 * from, whether what it makes beside the program is kept, the API as a
 * program's author is shown it, and where its workspace is (`copy`: for a
 * run it asks for to be given it).
 *
 * **It may answer that there is none to be written** — `{ unwritable }`,
 * why — as whoever fixes says there is no fix: an answer, and no program.
 * Whoever asked is told why, in its words; nothing is validated, and nobody
 * is asked to mend it into a program. Not where the project is, nor its
 * history, nor its records: what more a writer is to see, whoever asks for
 * the update says in the prompt.
 *
 * A run of whoever asked for the update, as a fix by a project is the
 * failing run's: under that count (`meter`), stopped with it, started with
 * its variables — and a run like any otherwise, on its own project's
 * record, which says what it was for. Not fixed where it fails. Its time
 * is its own project's to say.
 */
export async function writtenBy(
  writer: string,
  given: { prompt: string; program?: string; kept: boolean; copy: string },
  asked: Partial<AskedToMake> & { meter: Meter; spent?: (why: string) => void },
  what: "create" | "update" = "update",
): Promise<string> {
  const asking = what === "create" ? "program" : "update";
  const result = await runProgram({
    projectDir: writer,
    workspaceDir: given.copy,
    maxRepairAttempts: 0,
    label: asked.label ? `${asked.label}: ${what}` : what,
    env: asked.env,
    signal: asked.signal,
    args: { prompt: given.prompt, ...(given.program !== undefined && { program: given.program }), kept: given.kept, types: RUNTIME_TYPES, copy: given.copy },
  }, {
    depth: asked.depth === undefined ? 0 : asked.depth + 1,
    parent: asked.parent,
    started: (run, path) => asked.writing?.(run, path),
    above: asked.meter,
    purpose: what,
    ...(asked.spent && { spent: asked.spent }),
  });
  if (result.status !== "done") {
    // Why, as the runner knows it first: whoever asked stopped it; or nothing more may be asked of a model under the
    // count it was made under. Else it is the writer's own failure, in the words its run failed with.
    throwIfAborted(asked.signal);
    const spent = asked.meter.spent();
    if (spent !== undefined) throw new Error(spent);
    throw new Error(`The project asked for the ${asking} ${result.status === "failed" ? "failed" : "did not end its work"}: ${result.reason ?? result.status}`);
  }
  const { program, unwritable } = (result.result ?? {}) as { program?: unknown; unwritable?: unknown };
  if (typeof unwritable === "string" && program === undefined) {
    throw new Error(`It was said that there is none to be written: ${unwritable.trim() || "no reason was given"}`);
  }
  if (typeof program !== "string" || program.trim() === "") {
    throw new Error(`The project asked for the ${asking} answered with no program: its result is to be { program }, the whole of the ${what === "create" ? "" : "new "}program — or { unwritable }, why there is none to be written.`);
  }
  return program;
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
    // (A run that is to have no way to make projects is given none: and so none is there for what it starts.)
    return await runProject(options, depth, askedFor, options.making === false ? undefined : making);
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
  const timeout = checkedTimeout(options.timeout ?? config.defaultTimeout);
  // Of which version the run is, where it is not of the program as it is: one that is there. (Its text is found now —
  // a run that could not be of the version it names is not begun.)
  const ofVersion = options.version === undefined ? undefined : writtenFrom(projectDir, options.version)!;
  if (ofVersion !== undefined) textOfVersion(projectDir, ofVersion);
  // (Such a run is not fixed where it fails, whatever the run is allowed: a fix would be a version nobody asked for.)
  const maxRepairAttempts = ofVersion !== undefined ? 0 : checkedRepairAttempts(options.maxRepairAttempts ?? config.maxRepairAttempts);
  const env = options.env == null ? undefined : checkedEnv(options.env);
  // Who is asked for a fix: the project the run names, or the configuration — or, with neither, the runtime's own
  // fixer, a project among the user's (put there where it is not: see `ownProgram`). Found now, and not when the
  // program has failed — a run that could not have been fixed as it was to be is not begun, and what fixes a run is
  // known before the run can do anything. (Where no fix is to be asked for, nobody is looked for.)
  const namedToFix = options.repairWith ?? config.repairWith;
  const repairWith = maxRepairAttempts <= 0 ? undefined
    : namedToFix !== undefined ? projectNamed(namedToFix)
    : ownProgram(OWN_FIXER, (line) => console.log(tagged(options.label, line)));
  if (repairWith !== undefined && !existsSync(join(repairWith, "meta.json"))) {
    throw new Error(`repairWith names no project: there is none at ${repairWith}`);
  }
  // Who checks the run, where it is checked: found now as well — a run that could not be checked as it was to be is not begun.
  const checkWith = askedFor?.purpose === "check" ? undefined : checkerOf(options);
  // What is out of the run's reach, by its runner: who checks it and who fixes it — and whatever was out of the
  // reach of the run that asked for it. What judges a run is not that run's to change.
  const beyond = new Map(askedFor?.beyond);
  for (const [dir, does] of [[checkWith, "checks"], [repairWith, "fixes"]] as const) {
    const id = dir === undefined ? undefined : identityOf(realRootOf(dir));
    if (id !== undefined && !beyond.has(id)) beyond.set(id, does);
  }
  // Nor is one whose arguments do not fit what the project says it takes: asked now, before a program is started for it.
  // (What it was handed and does not take is left out, and said below — once the run has a record to say it on.)
  // (A run of a version is held to what that version was made under, where that is on record and is not what the
  // project says now: a version is a program and what it was written to.)
  const madeUnder = ofVersion === undefined ? undefined : heldOfVersion(projectDir, ofVersion);
  const says = madeUnder?.held !== undefined && heldNow(projectDir)?.mark !== madeUnder.mark ? madeUnder.held : undefined;
  const { leftOut, takes } = fitted(projectDir, options.args, says && withHeld(readProjectMeta(projectDir), says));
  // Its own budget — the config's, for a run nobody's program asked for and that was given none — under the budgets above it.
  const budget = options.budget != null ? checkedBudget(options.budget) : askedFor ? undefined : config.budget;
  const meter = createMeter(budget, askedFor?.above);
  const outOfBudget = askedFor?.spent ?? ((why: string) => console.warn(tagged(options.label, `[trama] ${why}`)));
  // (Before the journal is opened: once it is, nothing stands between that and the run that ends it — a
  // journal with a beginning and no end is a run that died, and is not to be one that never began.)
  const stillTheProject = sameProjectAs(projectDir);
  // The program as it is run is a version on record: put there now, where it is not. (So a run is of a
  // version, and whatever was run can be gone back to.) That it cannot be is no reason not to run it.
  const startedAt = new Date(), clock = performance.now();
  let beganAs: string | undefined;
  try {
    // (A run of another version is of a version on record already, and says nothing of the program.)
    if (ofVersion === undefined) {
      recordAsFound(projectDir);
      beganAs = programHashOf(projectDir);
    }
  } catch (err) {
    console.warn(tagged(options.label, `[trama] the program is not put on record as a version: ${messageOf(err)}`));
  }
  const backend = createBackend(config, meter, saysOnce(meter, outOfBudget), env);

  const journal = openJournal(projectDir, config.journalRuns, {
    purpose: "run",
    label: options.label,
    depth,
    parent: askedFor?.parent,
    workspace: options.workspaceDir,
    ...(ofVersion !== undefined && { version: ofVersion }),
    timeout,
    maxRepairAttempts,
    repairWith,
    ...(options.making === false && { making: false }),
    budget,
    // (The names: what the variables hold is not for a journal.)
    env: env && Object.keys(env),
    args: options.args, // last: it is the one field of unknown size
  });
  askedFor?.started(journal.run, journal.path);
  if (leftOut.length > 0) {
    // On the run's record, whoever asked for it — and aloud where nobody's program did: there is someone there who
    // wrote the names, and one of them may be a name written wrongly.
    journal.note("left-out", { args: leftOut });
    if (!askedFor) console.warn(tagged(options.label, `[trama] ${projectDir} takes no argument ${leftOut.map((name) => JSON.stringify(name)).join(", ")}: left out. It takes: ${takes}.`));
  }

  const { result, repair } = await journalled(journal, backend, async (backend) => {
    // A run of a version has that version's text for its program, where the program is (see `besideTheProgram`).
    const beside = ofVersion === undefined ? undefined : besideTheProgram(projectDir, ofVersion);
    const execution = await executeProgram({
      projectDir,
      backend,
      meter,
      making,
      beyond,
      maxRepairAttempts,
      timeout,
      argsOverride: options.args,
      ...(beside && { entry: beside.entry }),
      ...(says && { says }),
      workspaceDir: options.workspaceDir,
      depth,
      label: options.label,
      env,
      agentChanges: config.agentChanges,
      agents: config.agents,
      repairWith,
      signal: options.signal,
      journal,
    }).finally(() => beside?.remove());
    // A run that is done is checked, where it is to be: once its program has ended and what it did is the
    // project's — a fix that worked among it — and before the run's own end is written down. What the check
    // says is said beside how the run ended, and is no part of that: done is the program's word.
    if (checkWith === undefined || execution.result.status !== "done") return execution;
    const check = await checkedBy(checkWith, execution.result, { projectDir, args: options.args, timeout, depth, label: options.label, env, signal: options.signal, meter, journal, workspaceDir: options.workspaceDir, says });
    return { ...execution, result: { ...execution.result, check } };
  });

  if (repair) {
    // The program is fixed and has run; failing to write this down must not turn that into an error.
    try {
      stillTheProject();
      const message = `Repair attempt ${repair.attempt}/${maxRepairAttempts}`;
      appendLogEntry(guardPath(projectDir, LATEST_LOG_PATH), message, { error: repair.error });
      console.log(tagged(options.label, `[trama] ${message}`));
      // (Written from the program the run began as: the one that failed.)
      copyToHistory(projectDir, "repair", repair.error, { parent: (beganAs === undefined ? undefined : versionWith(projectDir, beganAs)) ?? null });
    } catch (err) {
      console.warn(tagged(options.label, `[trama] repair bookkeeping failed: ${messageOf(err)}`));
    }
  }
  // The run is over, whatever came of it: a line of the project's history says so — the version it was of, how
  // it ended, what its check said, what it used. Kept as history is, where a journal is kept for some runs.
  try {
    const short = (text: string) => (text.length > 200 ? `${text.slice(0, 200)}…` : text);
    const endedAs = programHashOf(projectDir);
    const version = ofVersion ?? (beganAs === undefined ? undefined : versionWith(projectDir, beganAs));
    const ended = ofVersion !== undefined || endedAs === undefined || endedAs === beganAs ? undefined : versionWith(projectDir, endedAs);
    const { calls, tokens, cost } = meter.counted();
    const models = Object.fromEntries(Object.entries(meter.byModel()).map(([model, by]) => [model, { calls: by.calls, tokens: by.tokens, cost: by.cost }]));
    const { check } = result;
    noteRun(projectDir, {
      ...(journal.run && { run: journal.run }),
      at: startedAt.toISOString(),
      ...(version !== undefined && { version }),
      ...(ended !== undefined && ended !== version && { ended }),
      status: result.status,
      ...(result.status !== "done" && result.reason !== undefined && { reason: short(result.reason.split("\n")[0]) }),
      ...(repair && { repaired: repair.attempt }),
      ...(check && { check: { ...check, ...(check.notes !== undefined && { notes: short(check.notes) }), ...(check.error !== undefined && { error: short(check.error) }) } }),
      used: { calls, tokens, cost },
      ...(Object.keys(models).length > 0 && { models }),
      ms: Math.round(performance.now() - clock),
      input: inputMarkOf(projectDir, options.args),
      ...(askedFor?.purpose && { for: askedFor.purpose }),
    });
  } catch (err) {
    console.warn(tagged(options.label, `[trama] the run is not in the project's history: ${messageOf(err)}`));
  }
  return result;
}

/**
 * The mark of what a run of a project is started with, where it is asked
 * for with these arguments: by it the runs on record that were started
 * with the same are found (`input`, on a run's line). It is of what the
 * program is given — the arguments asked with, laid over those the
 * project's own meta.json says: runs asked for with the same arguments are
 * runs of the same only while the project says the same.
 */
/** What a run was asked with, for whoever checks it: what its program was given, held as the program had it, and what was left out of that beside it. */
function argumentsOf(projectDir: string, args?: Record<string, unknown>, says?: Held): Record<string, unknown> {
  try {
    return fitted(projectDir, args, says && withHeld(readProjectMeta(projectDir), says)).asked;
  } catch {
    return { ...(readProjectMeta(projectDir).input.args ?? {}), ...args };
  }
}

export function inputMarkOf(projectDir: string, args?: Record<string, unknown>): string {
  return inputMark({ ...(readProjectMeta(projectDir).input.args ?? {}), ...args });
}

/** A mark of some arguments: the same for the same, in whatever order they were written. */
function inputMark(args: Record<string, unknown> | undefined): string {
  const ordered = (value: unknown): unknown => (Array.isArray(value) ? value.map(ordered)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, held]) => [key, ordered(held)]))
    : value);
  return createHash("sha256").update(JSON.stringify(ordered(args ?? {})) ?? "").digest("hex").slice(0, 16);
}

/**
 * Go back to a version of a project's program: its text becomes program.ts
 * again, as a new version — so history only grows, and a rollback can be
 * gone back on as anything can. The program as it is now is put on record
 * first where it is not: nothing is lost by it.
 *
 * A version is a program and what the project took and gave when it was
 * made: where that is not what the project says now, it is put back with
 * the program (`contract: "back"`) — its meta.json's `parameters` and
 * `returns`, and nothing else of the file — so that the program is held to
 * what it was written to. Where it is on no record (a version from before
 * such texts were kept), the program alone is gone back to, and that is
 * said (`contract: "unknown"`).
 *
 * Nothing is run, and nothing validated: a rollback has no effect but the
 * program's text and what it is held to, and costs nothing. Nor is anything
 * else of the project touched — its state, its files. (So the old program
 * meets the project as it is now, which its next run will show.)
 */
export function rollbackTo(projectDir: string, version: number): RolledBack {
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) throw new Error("A version is named by its number: 1 and up.");
  if (!existsSync(join(projectDir, "meta.json"))) {
    throw new Error(`Project not found at ${projectDir}. Run \`trama list\` to see available projects.`);
  }
  const versions = versionsOf(projectDir);
  if (!versions.some((one) => one.version === version)) {
    throw new Error(`No version ${version} is in the history of ${projectDir}: \`trama history <name>\` shows those there are.`);
  }
  const text = textOfVersion(projectDir, version);
  // What it was made under: put back with it, where that is not what the project says now and is on record.
  const now = heldNow(projectDir), then = heldOfVersion(projectDir, version);
  const other = now !== undefined && now.mark !== then.mark;
  const back = other ? then.held : undefined;
  // What is the project already is not gone back to.
  if (programIn(projectDir) === text && back === undefined) return { unchanged: true, version: versionWith(projectDir, createHash("sha256").update(text).digest("hex")) ?? version };
  // Asked before anything is put on record: where the program cannot be replaced, there is nothing to prepare for.
  const refusal = whyNotReplaceable(projectDir);
  if (refusal) throw new Error(refusal);
  recordAsFound(projectDir);
  const program = stageProgram(projectDir, text);
  let recorded: (() => void) & { version?: number } = () => {}, meta: StagedFile | undefined, was: Buffer | undefined, replaced = false;
  try {
    if (back) {
      was = readFileSync(guardPath(projectDir, "meta.json"));
      meta = stageFileInProject(projectDir, "meta.json", JSON.stringify(withHeld(JSON.parse(was.toString("utf-8")) as Record<string, unknown>, back), null, 2));
    }
    recorded = recordVersion(projectDir, text, "rollback", undefined, [], { from: version }, back);
    meta?.commit();
    replaced = meta !== undefined;
    program.commit();
  } catch (err) {
    recorded();
    program.discard();
    if (replaced && was) { try { stageFileInProject(projectDir, "meta.json", was).commit(); } catch { /* (Not to be put back: said by what is thrown.) */ } } else meta?.discard();
    throw err;
  }
  return { version: recorded.version!, from: version, ...(other && { contract: back ? "back" as const : "unknown" as const }) };
}
