// What a project is on disk before anything of it is run: the files trama
// keeps around a program.ts, the config a run of it goes by, and the state
// its last run left.

import {
  readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, lstatSync, readdirSync,
  symlinkSync, rmSync, renameSync, readlinkSync, accessSync, constants,
} from "fs";
import { createHash, randomBytes } from "crypto";
import { join, dirname, resolve, sep } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import type { TramaConfig } from "./runner-types.js";
import { checkedBudget } from "./budget.js";
import { checkedAgents } from "./outside-agent.js";
import { guardPath, projectAt } from "./path-guard.js";
import { stageFileInProject, stagedNameFor } from "./replace-file.js";
import { readProjectMeta } from "./meta.js";
import { describeJson, isJsonObject } from "./serializable.js";
import { messageOf } from "./errors.js";

// --- Locating the runtime itself ---

/** The installed @trama-dev/runtime package — this file lives in its dist/. */
const RUNTIME_PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The @trama-dev packages a program.ts can import, and where they are
 * installed: the runtime.
 */
const IMPORTABLE_PACKAGES: Record<string, string> = { runtime: RUNTIME_PACKAGE_DIR };

// --- Project scaffolding ---
//
// A project is not one runner's alone: runs of it begin together — runs that
// work together, a loop that starts several — and each runner makes
// ready what a run needs. So nothing here is made in steps another could come
// between, or see half done. Each thing is looked at once; where it is not as
// it should be, what should be there is made whole beside it and put in its
// place in one move. Runners that do so at the same moment each put the same
// thing there, and whoever reads the place finds the old or the new.

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

  // One look says all there is to know of the place: what the link there says, that what is there is no link
  // (the system's answer to asking what it says: EINVAL), or that nothing is.
  try {
    if (readlinkSync(linkPath) === target) return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EINVAL") {
      throw new Error(
        `${linkPath} exists and is not a symlink. ` +
        `trama needs this path for module resolution. ` +
        `Remove it manually or rename it to proceed.`
      );
    }
    if (code !== "ENOENT") throw err;
  }

  // The link is made beside its place and moved into it: the place is never without one for a moment — a
  // program of another runner's may be resolving it — and a link another runner put there meanwhile is one
  // that says the same. (A directory that somebody made there meanwhile is not moved over: the system refuses.)
  mkdirSync(linkDir, { recursive: true });
  const staged = stagedNameFor(linkPath);
  symlinkSync(target, staged, "dir");
  try {
    renameSync(staged, linkPath);
  } catch (err) {
    rmSync(staged, { force: true });
    throw err;
  }
}

/**
 * Put a file the runtime keeps in a project in its place, in one move: it
 * is written beside the place and moved into it, and not written into what
 * is there (see stageFile). Whoever reads the place at that moment — another
 * runner, making the same project ready; a run after one that was stopped in
 * the middle of this — reads all of the old or all of the new, and never the
 * beginning of one. A file that is there hands on its permissions, and a
 * link to it stays the link.
 *
 * Taking a file's place does not ask the file's leave, as writing into it
 * does: so it is asked here. A file its owner has closed to writing stays as
 * it is.
 *
 * Where no file can be made beside it — a project whose own directory is
 * closed to that, and whose files are not — the content is written into the
 * file, as it always was: there is no other way to it there, and a project
 * kept so is still one that can be run.
 */
function putInProject(projectDir: string, relativePath: string, content: string): void {
  const place = guardPath(projectDir, relativePath);
  if (existsSync(place)) accessSync(place, constants.W_OK);
  try {
    stageFileInProject(projectDir, relativePath, content).commit();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM" && code !== "EROFS") throw err;
    writeFileSync(place, content);
  }
}

/** Make sure package.json exists and declares an ES module (program.ts uses top-level await). */
function ensureModulePackageJson(projectDir: string): void {
  const pkgPath = guardPath(projectDir, "package.json");
  if (!existsSync(pkgPath)) {
    putInProject(projectDir, "package.json", JSON.stringify({ type: "module" }, null, 2));
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
    putInProject(projectDir, "package.json", JSON.stringify(pkg, null, 2));
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
  putInProject(projectDir, ".gitignore", existing + separator + missing.join("\n") + "\n");
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

// --- Config & state loaders ---

/** What holds where the user's configuration says nothing. */
const CONFIG_DEFAULTS: TramaConfig = {
  provider: "anthropic",
  model: "claude-opus-5-5",
  maxRepairAttempts: 3,
  defaultTimeout: 300_000,
  journalRuns: 20,
  agentChanges: "keep",
};
const configPath = (): string => join(homedir(), ".trama", "config.json");

/** The user's configuration file as it is written: an object — an empty one, where there is no file. */
function writtenConfig(): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(configPath(), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Malformed config at ${configPath()} — fix or delete it.\n` +
      `Parse error: ${messageOf(err)}`
    );
  }
  if (!isJsonObject(parsed)) {
    throw new Error(
      `Malformed config at ${configPath()} — expected a JSON object but got ${describeJson(parsed)}. Fix or delete it to proceed.`
    );
  }
  return parsed;
}

/** What a written configuration comes to: over what holds where it says nothing, and held to what a configuration is. */
function configOf(written: Record<string, unknown>): TramaConfig {
  // null is how JSON says a field is not there.
  const given = Object.fromEntries(Object.entries(written).filter(([, value]) => value !== null));
  return checkedConfig({ ...CONFIG_DEFAULTS, ...given }, "config");
}

export function loadConfig(): TramaConfig {
  return configOf(writtenConfig());
}

/** What the user's configuration holds, by name. */
const HOLDS = ["provider", "model", "maxRepairAttempts", "defaultTimeout", "journalRuns", "agentChanges", "repairWith", "updateWith", "createWith", "agents", "budget"];
const NUMBERS = ["maxRepairAttempts", "defaultTimeout", "journalRuns", "budget"];
const ROLES = ["repairWith", "updateWith", "createWith"] as const;

/**
 * Set one thing of the user's configuration, or take it out (no `text`) —
 * said as a command line says it: by its name, a part of `agents` or of
 * `budget` by the name of the part too (agents.claude, budget.cost), and as
 * text — which is read as a number where the thing is one, and as JSON
 * where it is an object (an agent, or `agents` or `budget` whole). Written
 * only where what it then comes to is a configuration; and who writes or
 * fixes is to be a project that is there. What else the file says is kept.
 */
export function setConfig(key: string, text?: string): void {
  const [top, part, ...more] = key.split(".");
  if (!HOLDS.includes(top)) throw new Error(`The configuration has no ${JSON.stringify(top)}: it holds ${HOLDS.join(", ")}.`);
  if (more.length > 0 || part === "" || (part !== undefined && top !== "agents" && top !== "budget")) {
    throw new Error(`${JSON.stringify(key)} names nothing the configuration holds: a part is named of agents (agents.<name>) and of budget (budget.cost, budget.tokens, budget.calls) alone.`);
  }
  let value: unknown;
  if (text !== undefined) {
    if (top === "agents" || (top === "budget" && part === undefined)) {
      try { value = JSON.parse(text); } catch (err) { throw new Error(`${JSON.stringify(key)} is written as JSON, and this is none: ${messageOf(err)}`); }
    } else if (NUMBERS.includes(top)) {
      value = text.trim() === "" ? NaN : Number(text);
      if (Number.isNaN(value)) throw new Error(`${JSON.stringify(key)} is a number, and ${JSON.stringify(text)} is none.`);
    } else value = text;
  }
  const written = writtenConfig();
  if (part === undefined) {
    if (value === undefined) delete written[top]; else written[top] = value;
  } else {
    const whole = written[top];
    const parts: Record<string, unknown> = isJsonObject(whole) ? { ...whole } : {};
    if (value === undefined) delete parts[part]; else parts[part] = value;
    if (Object.keys(parts).length === 0) delete written[top]; else written[top] = parts;
  }
  const held = configOf(written);
  for (const role of ROLES) {
    const named = top === role ? held[role] : undefined;
    if (named !== undefined && !existsSync(join(projectNamed(named), "meta.json"))) throw new Error(`${role} names no project: there is none at ${projectNamed(named)}`);
  }
  const coming = `${configPath()}.${randomBytes(6).toString("hex")}`;
  mkdirSync(dirname(configPath()), { recursive: true });
  try {
    writeFileSync(coming, JSON.stringify(written, null, 2) + "\n");
    renameSync(coming, configPath());
  } catch (err) {
    rmSync(coming, { force: true });
    throw err;
  }
}

/** A config that holds what the runtime can work with — or an error naming what does not, and where it came from. */
function checkedConfig(merged: TramaConfig, source: string): TramaConfig {
  const s = (v: unknown) => typeof v === "string" && v.length > 0;
  const checks: Array<[boolean, string]> = [
    [s(merged.provider), `"provider" must be a non-empty string (got ${JSON.stringify(merged.provider)})`],
    [s(merged.model), `"model" must be a non-empty string (got ${JSON.stringify(merged.model)})`],
    [Number.isInteger(merged.maxRepairAttempts) && merged.maxRepairAttempts >= 0, `"maxRepairAttempts" must be a non-negative integer (got ${merged.maxRepairAttempts})`],
    [Number.isFinite(merged.defaultTimeout) && merged.defaultTimeout > 0, `"defaultTimeout" must be a positive number (got ${merged.defaultTimeout})`],
    [Number.isInteger(merged.journalRuns) && merged.journalRuns >= 0, `"journalRuns" must be a non-negative integer (got ${merged.journalRuns})`],
    [merged.agentChanges === "keep" || merged.agentChanges === "discard", `"agentChanges" must be "keep" or "discard" (got ${JSON.stringify(merged.agentChanges)})`],
  ];
  if (merged.repairWith !== undefined) {
    checks.push([s(merged.repairWith), `"repairWith" must be a project — its name, or a path to it (got ${JSON.stringify(merged.repairWith)})`]);
  }
  if (merged.createWith !== undefined) {
    checks.push([s(merged.createWith), `"createWith" must be a project — its name, or a path to it (got ${JSON.stringify(merged.createWith)})`]);
  }
  if (merged.updateWith !== undefined) {
    checks.push([s(merged.updateWith), `"updateWith" must be a project — its name, or a path to it (got ${JSON.stringify(merged.updateWith)})`]);
  }
  for (const [ok, msg] of checks) {
    if (!ok) throw new Error(`Invalid ${source}: ${msg}`);
  }
  try {
    if (merged.agents !== undefined) merged = { ...merged, agents: checkedAgents(merged.agents) };
    return merged.budget === undefined ? merged : { ...merged, budget: checkedBudget(merged.budget, `"budget"`) };
  } catch (err) {
    throw new Error(`Invalid ${source}: ${messageOf(err)}`);
  }
}

/**
 * Where a project is, that is named as `repairWith` names one: by a path —
 * what has a stroke in it, or begins with a dot or with "~" for the user's
 * home — or else by its name among the user's projects.
 */
export function projectNamed(given: string): string {
  if (given === "~" || given.startsWith("~/")) return join(homedir(), given.slice(2));
  if (namesAPath(given)) return resolve(given);
  return join(homedir(), ".trama", "projects", given);
}

// --- The programs that come with the runtime ---

/** Where the runtime's own programs are: with the package, beside its dist/. */
const OWN_PROGRAMS = join(RUNTIME_PACKAGE_DIR, "programs");

/**
 * Who writes a project's program, and who fixes one that failed, where
 * nobody is named — by a call, a run or the configuration: a program that
 * comes with the runtime, by its name among the user's projects.
 */
export const OWN_WRITER = "program-writer", OWN_FIXER = "program-fixer";
const DOES = {
  [OWN_WRITER]: ["writes a project's program", "who is to write (createWith, updateWith)"],
  [OWN_FIXER]: ["fixes a program that failed", "who is to fix (repairWith)"],
} as const;

/**
 * The project one of the runtime's own programs is: among the user's, by its
 * name — put there as it came with the runtime, the first time it is wanted,
 * which is said (`say`). From then on it is the user's: on record from its
 * first run, changed and gone back from as any project is; and what is there
 * is who is asked, whatever comes with a later runtime. The runtime has no
 * words of its own to a model for either role: they are these programs'.
 *
 * It is put there whole or not at all — made beside, then moved to its name
 * — and where another runner put it there meanwhile, that one is it. What
 * has its name and is no project is in the way, and is said to be: nothing
 * is laid over it.
 */
export function ownProgram(name: typeof OWN_WRITER | typeof OWN_FIXER, say: (line: string) => void): string {
  const projects = join(homedir(), ".trama", "projects"), dir = join(projects, name);
  const [does, whoElse] = DOES[name];
  const there = (): boolean => existsSync(join(dir, "meta.json"));
  if (there()) {
    anotherSaid(name, dir, does, say);
    return dir;
  }
  if (lstatSync(dir, { throwIfNoEntry: false })) {
    throw new Error(`${name} ${does} where nobody else is named, and is to be a project among yours: what is at ${dir} is none. Move it away, or name ${whoElse}.`);
  }
  mkdirSync(projects, { recursive: true });
  const coming = join(dirname(projects), `.${name}-${randomBytes(6).toString("hex")}`);
  try {
    cpSync(join(OWN_PROGRAMS, name), coming, { recursive: true });
    renameSync(coming, dir);
  } catch (err) {
    rmSync(coming, { recursive: true, force: true });
    if (there()) return dir;
    throw new Error(`${name} ${does} where nobody else is named, and could not be put among your projects (${dir}): ${messageOf(err)}`);
  }
  const came = { runtime: runtimeVersion(), mark: ownMark(name) };
  noteOf(name, { came, seen: came });
  say(`[trama] ${name} is among your projects (${dir}): it ${does} where nobody else is named, and is yours to change.`);
  return dir;
}

/** The runtime's own version, as its package says it. */
const runtimeVersion = (): string => String(JSON.parse(readFileSync(join(RUNTIME_PACKAGE_DIR, "package.json"), "utf-8")).version);

/**
 * What tells one of the runtime's own programs from another: the files the
 * runtime has for it, each by its name and its text — as they are in `dir`,
 * or as the runtime has them. But for what says nothing of what it does (its
 * README), and what a run of it may write over (package.json).
 */
export function ownMark(name: string, dir = join(OWN_PROGRAMS, name)): string {
  const hash = createHash("sha256");
  for (const file of readdirSync(join(OWN_PROGRAMS, name)).filter((each) => each !== "README.md" && each !== "package.json").sort()) {
    let text: string | null;
    try { text = readFileSync(join(dir, file), "utf-8"); } catch { text = null; }
    hash.update(JSON.stringify([file, text]));
  }
  return hash.digest("hex");
}

/** A program of the runtime's own, by which runtime it was, and the mark of its files (see `ownMark`). */
type Came = { runtime: string; mark: string };
/** What is noted of one that is among the user's projects: as what it came there, where the runtime put it; and what the runtime had for it when it was last looked at. */
type Note = { came?: Came; seen?: Came };

/** Where that is noted: beside the user's projects, and in none of them — it is the runtime's account, and the projects are the user's. */
const notesPath = (): string => join(homedir(), ".trama", "came-with.json");
function notes(): Record<string, Note> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(notesPath(), "utf-8"));
    return isJsonObject(parsed) ? parsed as Record<string, Note> : {};
  } catch {
    return {}; // (None, or none that can be read: nothing is noted.)
  }
}
function noteOf(name: string, note: Note): void {
  try {
    const path = notesPath(), coming = `${path}.${randomBytes(6).toString("hex")}`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(coming, JSON.stringify({ ...notes(), [name]: note }, null, 2) + "\n");
    renameSync(coming, path);
  } catch { /* (Not noted: what there is to say is said again another time.) */ }
}

/**
 * Say, once, that this runtime comes with another of its own programs than
 * the one among the user's projects — where it does, and has not been said
 * of this one: a release changes nothing of the user's, and so is to say
 * that it would have. Whether the user's is still as it came is said with
 * it (then the new one is had by moving it away); one that was changed is
 * left as it is, and said to be. Looked at once for a runtime: from then on
 * nothing is read but the note.
 */
function anotherSaid(name: string, dir: string, does: string, say: (line: string) => void): void {
  const had = notes()[name];
  let now: Came, theirs: string;
  try {
    if (had?.seen?.runtime === runtimeVersion()) return;
    now = { runtime: runtimeVersion(), mark: ownMark(name) };
    theirs = ownMark(name, dir);
  } catch {
    return; // (What cannot be looked at is not spoken of.)
  }
  if (theirs !== now.mark && had?.seen?.mark !== now.mark) {
    const own = join(OWN_PROGRAMS, name);
    say(had?.came !== undefined && theirs === had.came.mark
      ? `[trama] ${name} among your projects (${dir}) is as it came with trama ${had.came.runtime}, and trama ${now.runtime} comes with another (${own}). Yours is still the one that ${does}: to have the new one, move yours away — it is put there anew.`
      : `[trama] trama ${now.runtime} comes with another ${name} (${own}) than the one among your projects (${dir}), which is not as it came. Yours is the one that ${does}, and is left as you have it.`);
  }
  // (One that is the runtime's own, and of which nothing is noted, is noted as come: it is as this runtime has it.)
  noteOf(name, { ...(had?.came !== undefined ? { came: had.came } : theirs === now.mark ? { came: now } : {}), seen: now });
}

/** Whether what names a project names it by a path, and not by its name among the user's projects. */
export const namesAPath = (given: string): boolean =>
  given.includes("/") || given.includes(sep) || given.startsWith(".") || given.startsWith("~");

/** The time a run is given, held to what a time is. */
export function checkedTimeout(timeout: number): number {
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error(`Invalid timeout: ${timeout}. Must be a positive number.`);
  return timeout;
}

/** How many fixes a run may be tried with, held to what a count is. */
export function checkedRepairAttempts(attempts: number): number {
  if (!Number.isInteger(attempts) || attempts < 0) throw new Error(`Invalid maxRepairAttempts: ${attempts}. Must be a non-negative integer.`);
  return attempts;
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

/**
 * Put a project's state on file: all of it, in the place of what was there,
 * in one move (see putInProject) — a program that is stopped in the middle
 * of a checkpoint leaves the state before, and not half of a state, which no
 * run after would start from. A state file its owner made read-only stays as
 * it is.
 */
export function saveState(projectDir: string, state: Record<string, unknown>): void {
  putInProject(projectDir, "state.json", JSON.stringify(state, null, 2));
}
