// What a project is on disk before anything of it is run: the files trama
// keeps around a program.ts, the config a run of it goes by, and the state
// its last run left.

import {
  readFileSync, writeFileSync, mkdirSync, existsSync,
  symlinkSync, rmSync, lstatSync, readlinkSync, accessSync, constants,
} from "fs";
import { join, dirname, resolve, sep } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import type { TramaConfig } from "./runner-types.js";
import { checkedBudget } from "./budget.js";
import { checkedAgents } from "./outside-agent.js";
import { guardPath, projectAt } from "./path-guard.js";
import { stageFileInProject } from "./replace-file.js";
import { readProjectMeta } from "./meta.js";
import { describeJson, isJsonObject } from "./serializable.js";
import { messageOf } from "./errors.js";

// --- Locating the runtime itself ---

/** The installed @trama-dev/runtime package — this file lives in its dist/. */
const RUNTIME_PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

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
  if (merged.repairWith !== undefined) {
    checks.push([s(merged.repairWith), `"repairWith" must be a project — its name, or a path to it (got ${JSON.stringify(merged.repairWith)})`]);
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
 * Put a project's state on file: all of it, in the place of what was there.
 * It is written beside the file and moved into its place, and not written
 * into it — a program that is stopped in the middle of a checkpoint leaves
 * the state before, and not half of a state, which no run after would start
 * from. (Taking a file's place does not ask the file's leave, as writing
 * into it did: so it is asked here. A state file its owner made read-only
 * stays as it is.)
 *
 * Where no file can be made beside it — a project whose own directory is
 * closed to that, and whose files are not — the state is written into its
 * file, as it always was: there is no other way to it there, and a project
 * kept so is still one that can be run.
 */
export function saveState(projectDir: string, state: Record<string, unknown>): void {
  const path = guardPath(projectDir, "state.json");
  const text = JSON.stringify(state, null, 2);
  if (existsSync(path)) accessSync(path, constants.W_OK);
  try {
    stageFileInProject(projectDir, "state.json", text).commit();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM" && code !== "EROFS") throw err;
    writeFileSync(path, text);
  }
}
