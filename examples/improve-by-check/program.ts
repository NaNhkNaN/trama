// The loop, as a program: one round of it a run. It holds a project's program against the one an update
// writes — by a judge, on inputs that are said — and keeps the better: the new one, or the one before, gone
// back to.
//
// trama has the facts and the moves: every run of a project leaves a line in its history, with the version it
// was of and what its check said (`readHistory`); a project is changed by an update (`updateProject`) and by
// going back to a version (`rollbackProject`). Which version is the better is said here, in `better`, and
// nowhere else. It is a starting point, to be copied and changed.
//
// It is for a project that is given arguments and ends with a result: its runs are made in place, one after
// another. A run that uses up what it works on — a harness, doing a task in a codebase — is given a fresh copy
// of it each time (`from`): the project then works in its run's workspace, and is itself left as it is.

import { join } from "node:path";
import { ctx, tools } from "@trama-dev/runtime";
import { inputMarkOf, readHistory, resolveProject, rollbackProject, runProgram, updateProject } from "@trama-dev/runtime/runner";

type Input = Record<string, unknown>;
/** What a judge said of one run. (A score that was not given is none: 0.) */
interface Verdict { ok: boolean; score: number; notes?: string }
/** What it said of some runs, together: how many were found good, of how many, and their mean score. */
interface Tally { ok: number; of: number; score: number }

/** The rule. A version is kept where more of its runs were found good; where as many were, where their mean score is higher (by more than `margin`). A tie goes to the one before: it is the one that is known. */
const better = (is: Tally, was: Tally, margin: number): boolean => is.ok > was.ok || (is.ok === was.ok && is.score > was.score + margin);
/**
 * The rule where it is the score that is to be improved — what a run uses, say — and that the work is good is a
 * condition (`by=score`): the mean score is higher by more than `margin`, and not a smaller part of the runs was
 * found good. That part is counted over all the runs there are, those of inputs that are shown too: it takes many
 * runs to see that a version is a little less often right, and every run is one. (See `partGood`.)
 */
const betterByScore = (is: Tally, was: Tally, isGood: number, wasGood: number, margin: number): boolean =>
  is.score > was.score + margin && isGood >= wasGood - 1e-9;

// What it is told (its arguments — as `--arg`s, where a list is written as JSON, or in the meta.json of this project):
//   project   the project to improve, by its name among the user's projects
//   check     the project that judges a run of it (see examples/check-by-command), by its name
//   inputs    what to run it on: a list of arguments. What is found wanting of these is shown to the model.
//   heldBack  more of them, never shown: where there are any, they alone decide. (A program can be written to
//             the inputs its writer was told of. What decides is to be out of reach of what is decided on.)
//   runs      how many runs of each input (1). One run does not rank two versions: the same program, on the
//             same input, is found good one time and not the next.
//   ask       what is wanted, in words — beside what was found wanting, or where nothing was.
//   from      what a run works on, where that is not the project itself: a directory, copied afresh for every run
//             and handed to it as its workspace (and to the judge, as where the work is). `{name}` in it stands
//             for the input's argument of that name: from=/tasks/{task}, for inputs that say which task.
//   by        how a version is found the better: `good` (as said above: how often, then the score) or `score`
//             (the score, provided it is no less often good — where it is what a run uses that is to be improved).
//   margin    by how much a mean score has to be higher (0). A score that is measured is never a tie: without a
//             margin, a version no different is kept one round in two.
//   confirm   how many times the runs that decide are made again where a version passes (0), and counted with
//             the first: it is kept where it passes by all of them. What chose a version is the runs in which it
//             looked best — it is to be kept for more than those.
//   tell      which runs the writer is told of: `wanting` (those found not good) or `all` (what the judge said
//             of the good ones too — where what is wanted is not that they be good, that is all there is to go by).
const given = ctx.input.args as { project?: unknown; check?: unknown; inputs?: unknown; heldBack?: unknown; runs?: unknown; ask?: unknown; from?: unknown; by?: unknown; margin?: unknown; confirm?: unknown; tell?: unknown };
const listOf = (what: unknown, name: string): Input[] => {
  const list: unknown = typeof what === "string" ? JSON.parse(what) : what ?? [];
  if (!Array.isArray(list) || list.some((each) => each === null || typeof each !== "object" || Array.isArray(each))) throw new Error(`"${name}" is to be a list of arguments: [{ … }, { … }].`);
  return list as Input[];
};
const { project, check } = given;
const inputs = listOf(given.inputs, "inputs"), heldBack = listOf(given.heldBack, "heldBack");
const runs = Number(given.runs ?? 1);
const ask = typeof given.ask === "string" && given.ask.trim() !== "" ? given.ask.trim() : undefined;
const from = typeof given.from === "string" && given.from.trim() !== "" ? given.from.trim() : undefined;
if (typeof project !== "string" || typeof check !== "string") throw new Error('It is not said which project to improve, or which checks it: "project" and "check", each by its name.');
if (inputs.length + heldBack.length === 0) throw new Error('It is not said what to run the project on: "inputs", a list of arguments.');
if (!Number.isInteger(runs) || runs < 1) throw new Error('"runs" is how many runs of each input: 1 or more.');
const by = given.by ?? "good", tell = given.tell ?? "wanting";
const margin = Number(given.margin ?? 0), confirm = Number(given.confirm ?? 0);
if (by !== "good" && by !== "score") throw new Error('"by" is how a version is found the better: good, or score.');
if (!(margin >= 0) || !Number.isFinite(margin)) throw new Error('"margin" is by how much a mean score is to be higher: 0 or more.');
if (!Number.isInteger(confirm) || confirm < 0) throw new Error('"confirm" is how many times the runs that decide are made again: 0 or more.');
if (tell !== "wanting" && tell !== "all") throw new Error('"tell" is which runs the writer is told of: wanting, or all.');

const dir = resolveProject(project), judge = resolveProject(check);
const all = [...inputs, ...heldBack];
/** Whether an input, by its place among them all, is one that decides: those held back, where there are any — else every one. */
const decides = (n: number): boolean => heldBack.length === 0 || n >= inputs.length;

/** A check that could not be made: there is nothing to decide by. */
class NoVerdict extends Error {}

/**
 * What this loop keeps from one round to the next (its state): what the judge said, whole, of the runs it made of
 * the program as it is. A project's history keeps the beginning of a verdict's notes — and what comes after is
 * often what a writer can act on. By the program's text, then by the mark of the input; of inputs that are shown.
 */
const kept = ctx.state as { notes?: Record<string, Record<string, string[]>>; tried?: Record<string, number[]> };
kept.notes ??= {};
/**
 * And the versions this loop judged and went back from, by the text of the program they were written from. A
 * project's history says a version was gone back from, and not why: one put back because a check of it could not be
 * made — or by anybody else, or by a round that fell over — was never found no better, and is not to be told as if
 * it had been. Only what the loop decided itself is here; what it does not know it decided, it does not say.
 */
kept.tried ??= {};
/** The version this round judged and went back from, where it did. */
let judgedAndGoneBackFrom: number | undefined;
/** The notes of a verdict from the record, whole where this loop heard them itself: the record's are their beginning. */
const whole = (notes: string | undefined, text: string | undefined, mark: string): string | undefined => {
  if (notes === undefined || text === undefined || !notes.endsWith("…")) return notes;
  return [...(kept.notes![text]?.[mark] ?? [])].reverse().find((heard) => heard.startsWith(notes.slice(0, -1))) ?? notes;
};

const quoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
/**
 * A place for one run to work in: a fresh copy of what `from` names for this input, made in this project under
 * `name` — or none, where runs are of the project in place. (Made by a command, which is on this run's record: a
 * replay of the round makes no copy. And named by what the run is — not by chance — so that a replay asks the same.)
 */
async function fresh(input: Input, name: string): Promise<string | undefined> {
  if (from === undefined) return undefined;
  const source = from.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = input[key];
    if (typeof value !== "string" && typeof value !== "number") throw new Error(`"from" has {${key}}, and an input has no such argument to put there.`);
    return String(value);
  });
  const made = await tools.shell(`rm -rf ${quoted(name)} && mkdir -p work && cp -R ${quoted(source)} ${quoted(name)}`, { timeout: 600_000 });
  if (made.exitCode !== 0) throw new Error(`A fresh copy of ${source} could not be made: ${made.stderr.trim()}`);
  return join(process.cwd(), name);
}

/**
 * The verdicts on the project's program as it is now: `runs` of them for each input. Taken from the project's
 * history where they are there — runs of this program, started with this input, checked by this judge as it is
 * now — and by a run where they are not. So a round after another pays for no run that was made.
 *
 * "This program" is told by its text, not by its version's number: a version gone back to is the program it was
 * under a new number, and the verdicts on it are its verdicts still.
 *
 * `again`: made again, to confirm — of the inputs that decide only, and by new runs alone: nothing from the record.
 */
async function verdicts(again = 0): Promise<Verdict[][]> {
  // (The latest runs are enough, and a call's record has room for no more than some.)
  const history = await readHistory(dir, { runs: 500 });
  // The judge as it is now: a verdict on record is its own where the judge's program was this one. (It is on record once it has checked anything.)
  const judging = await readHistory(judge, { runs: 0 });
  const judgedBy = judging.versions.find((version) => version.version === judging.current)?.sha256;
  // The versions that are the program as it is now: the one it is, and any before it with the same text.
  const text = history.versions.find((version) => version.version === history.current)?.sha256;
  const same = new Set(history.versions.filter((version) => text !== undefined && version.sha256 === text).map((version) => version.version));
  const each: Verdict[][] = [], heard: Array<[string, string]> = [];
  for (const [n, input] of all.entries()) {
    if (again > 0 && !decides(n)) { each.push([]); continue; }
    const mark = await inputMarkOf(dir, input);
    const found: Verdict[] = again > 0 || history.current === undefined || judgedBy === undefined ? [] : history.runs
      .filter((run) => run.version !== undefined && same.has(run.version) && run.ended === undefined && run.input === mark)
      .flatMap(({ check: said }) => (said && said.by === judge && said.program === judgedBy && said.ok !== undefined ? [{ ok: said.ok, score: said.score ?? 0, notes: whole(said.notes, text, mark) }] : []))
      .slice(-runs);
    while (found.length < runs) {
      // (Not fixed where it fails: a fix would be another version, in the middle of what is held against each other.)
      const work = `work/v${history.current ?? 0}-${n}-${found.length}${again > 0 ? `-again${again}` : ""}`;
      const workspaceDir = await fresh(input, work);
      const ran = await runProgram({ projectDir: dir, args: input, checkWith: judge, maxRepairAttempts: 0, ...(workspaceDir !== undefined && { workspaceDir }) });
      // (The judge has seen it by now: a check is part of the run. The copy has done what it was for.)
      if (workspaceDir !== undefined) await tools.shell(`rm -rf ${quoted(work)}`, { timeout: 600_000 });
      if (ran.status !== "done") found.push({ ok: false, score: 0, notes: `The run ${ran.status}: ${(ran.reason ?? "").split("\n")[0]}` });
      else if (ran.check?.ok === undefined) throw new NoVerdict(ran.check?.error ?? "the run was not checked.");
      else found.push({ ok: ran.check.ok, score: ran.check.score ?? 0, notes: ran.check.notes });
      if (ran.check?.notes !== undefined && n < inputs.length) heard.push([mark, ran.check.notes]);
    }
    each.push(found);
  }
  // What was heard is kept, whole, for the rounds to come: of an input that may be shown, as many as a round makes of
  // it. (By the program's text — which, of a program that had never been run, is on record only now that it has been.)
  if (heard.length > 0) {
    const ran = text !== undefined ? undefined : await readHistory(dir, { runs: 0 });
    const of = text ?? ran?.versions.find((version) => version.version === ran.current)?.sha256;
    if (of !== undefined) for (const [mark, notes] of heard) ((kept.notes![of] ??= {})[mark] = [...(kept.notes![of][mark] ?? []), notes].slice(-(runs * (1 + confirm))));
  }
  return each;
}

/**
 * What was tried before from the program as it is, and gone back from: each version an update wrote of this very
 * text that this loop judged and found no better — what its runs came to, on what decides, and what it changed. A round begins
 * from the program again; without this its writer does not know what the rounds before came to, and writes it again.
 * (All of it is read by the runner or by a command: it is on this run's record, and a replay is told the same.)
 */
async function triedBefore(was: Tally): Promise<string[]> {
  const history = await readHistory(dir, { runs: 500 });
  const judging = await readHistory(judge, { runs: 0 });
  const judgedBy = judging.versions.find((version) => version.version === judging.current)?.sha256;
  const text = history.versions.find((version) => version.version === history.current)?.sha256;
  if (text === undefined) return [];
  // The latest try of each text: the version, and the one it was written from.
  const tries = new Map<string, { version: number; from: number }>();
  const judged = new Set(kept.tried![text] ?? []);
  for (const [at, version] of history.versions.entries()) {
    const from = history.versions[at - 1];
    if (judged.has(version.version) && version.reason === "update" && version.sha256 !== undefined && version.sha256 !== text && from?.sha256 === text) tries.set(version.sha256, { version: version.version, from: from.version });
  }
  if (tries.size === 0) return [];
  const marks = new Set<string>();
  for (const [n, input] of all.entries()) if (decides(n)) marks.add(await inputMarkOf(dir, input));
  const file = (version: number) => join(dir, "history", `${String(version).padStart(4, "0")}.ts`);
  const told: string[] = [];
  for (const [sha256, { version, from }] of [...tries].slice(-5)) {
    const its = new Set(history.versions.filter((one) => one.sha256 === sha256).map((one) => one.version));
    // (A run that failed is a run not found good, as it was when it was made.)
    const came: Verdict[] = history.runs.filter((run) => run.version !== undefined && its.has(run.version) && run.ended === undefined && marks.has(run.input))
      .flatMap((run) => (run.status !== "done" ? [{ ok: false, score: 0 }]
        : run.check && run.check.by === judge && run.check.program === judgedBy && run.check.ok !== undefined ? [{ ok: run.check.ok, score: run.check.score ?? 0 }] : []));
    const is = came.length > 0 ? tally([came]) : undefined;
    // (Cut at 20,000 characters: a version a model wrote of a harness of 340 lines was a diff of 13,000.)
    const diff = (await tools.shell(`diff ${quoted(file(from))} ${quoted(file(version))} | head -c 20000`, { timeout: 60_000 })).stdout.trimEnd();
    told.push(`- version ${version}: ${is ? `${is.ok} of ${is.of} runs found good, at a mean score of ${is.score}, where the program as it is has ${was.ok} of ${was.of} at ${was.score}.` : "what its runs came to is on record no longer."}`
      + (diff ? ` What it changed, as a diff from the program as it is:\n${diff.split("\n").map((line) => `  ${line}`).join("\n")}` : ""));
  }
  return told;
}

const tally = (verdictsOf: Verdict[][]): Tally => {
  const said = verdictsOf.flat();
  return { ok: said.filter((verdict) => verdict.ok).length, of: said.length, score: Number((said.reduce((sum, verdict) => sum + verdict.score, 0) / said.length).toFixed(4)) };
};
/**
 * What part of a version's runs was found good, input by input: each input counts once, however many runs there
 * are of it. (Runs that are made again are of the inputs that decide alone. Where those are the harder ones, a
 * version would have a smaller part of all its runs good for having more runs of what is hard, and nothing else.)
 */
const partGood = (each: Verdict[][]): number => {
  const run = each.filter((of) => of.length > 0);
  return run.reduce((sum, of) => sum + of.filter((verdict) => verdict.ok).length / of.length, 0) / run.length;
};
/** What decides: the inputs held back, where there are any — else all there are. */
const deciding = (each: Verdict[][]): Tally => tally(each.filter((_, n) => decides(n)));

async function round(): Promise<Record<string, unknown>> {
  // Before: how the program as it is does.
  let before: Verdict[][];
  try {
    before = await verdicts();
  } catch (err) {
    if (!(err instanceof NoVerdict)) throw err;
    return { kept: false, why: `Nothing was changed: a check could not be made — ${err.message}` };
  }
  const was = deciding(before), wasAll = tally(before), wasGood = partGood(before);
  const from = (await readHistory(dir, { runs: 0 })).current;
  if (from === undefined) throw new Error(`The program of ${project} is on no record as it is: there would be no version to go back to.`);

  // Ask for an update: with what is wanted, and what was found wanting — of the inputs that may be shown, the latest of
  // each. (And, where it is asked for, what the judge said of the latest that was found good.)
  const said = (ok: boolean) => inputs.flatMap((input, n) => before[n].filter((verdict) => verdict.ok === ok).slice(-1).map((verdict) => `- started with ${JSON.stringify(input)}: ${verdict.notes ?? (ok ? "found good" : "found not good")}`));
  const wanting = said(false), good = tell === "all" ? said(true) : [];
  if (wanting.length === 0 && !ask) {
    return { kept: false, from, before: was, why: "Nothing was asked for: no run that may be shown was found wanting, and no `ask` says what else is wanted." };
  }
  const checked = "Runs of the program as it is were checked, and these";
  const tried = await triedBefore(was);
  try {
    await updateProject(project, [
      ask,
      wanting.length > 0 && `${checked} were found wanting:\n${wanting.join("\n")}`,
      good.length > 0 && `${wanting.length > 0 ? "And these" : checked} were found good — what the judge said of each:\n${good.join("\n")}`,
      tried.length > 0 && `Tried before, from the program as it is, and gone back from — none was kept. Write something else:\n${tried.join("\n")}`,
    ].filter(Boolean).join("\n\n"));
  } catch (err) {
    return { kept: false, from, before: was, why: `No update came of the asking: ${(err as Error).message}` };
  }
  const to = (await readHistory(dir, { runs: 0 })).current;

  // After: how the new one does. Decide — and where it passes and is to be confirmed, make the runs that decide again,
  // and decide by all of them. Whatever happens meanwhile, it is not left there untried: the one before is put back.
  let after: Verdict[][], kept: boolean, confirmed = 0;
  const passes = () => (by === "score" ? betterByScore(deciding(after), was, partGood(after), wasGood, margin) : better(deciding(after), was, margin));
  try {
    after = await verdicts();
    kept = passes();
    for (let again = 1; kept && again <= confirm; again++) {
      const more = await verdicts(again);
      after = after.map((of, n) => [...of, ...more[n]]);
      confirmed += more.flat().length;
      kept = passes();
    }
  } catch (err) {
    await rollbackProject(project, from);
    if (!(err instanceof NoVerdict)) throw err;
    return { kept: false, from, to, before: was, why: `Version ${from} is put back: a check of version ${to} could not be made — ${err.message}` };
  }
  if (!kept) {
    await rollbackProject(project, from);
    judgedAndGoneBackFrom = to;
  }

  // What it did, and why.
  const is = deciding(after), isAll = tally(after);
  let why: string;
  if (by === "score") {
    const scores = `a mean score of ${is.score} where it was ${was.score}`, more = margin > 0 ? ` by more than ${margin}` : "";
    why = kept ? `Version ${to} is kept: ${scores}, higher${more}; ${isAll.ok} of ${isAll.of} runs of all inputs found good where ${wasAll.ok} of ${wasAll.of} were.`
      : !(is.score > was.score + margin) ? `Version ${from} is put back: ${scores}, not higher${more}.`
      : `Version ${from} is put back: ${isAll.ok} of ${isAll.of} runs of version ${to}, all inputs counted, were found good where ${wasAll.ok} of ${wasAll.of} were — a smaller part, input by input (${Number(partGood(after).toFixed(2))} where it was ${Number(wasGood.toFixed(2))}), whatever its score.`;
  } else {
    const counts = `${is.ok} of ${is.of} runs${kept ? "" : ` of version ${to}`} were found good ${is.ok === was.ok ? "as" : "where"} ${was.ok} of ${was.of} were`;
    const scores = is.ok === was.ok || kept ? `, at a mean score of ${is.score} where it was ${was.score}` : "";
    why = kept ? `Version ${to} is kept: ${counts}${scores}.`
      : `Version ${from} is put back: ${counts}${is.ok === was.ok ? `${scores} — ${margin > 0 ? `not better by more than ${margin}` : "no better"}, and the one before is the one that is known` : ""}.`;
  }
  if (confirmed > 0) why += kept ? ` The runs that decide were made again to be sure of it: ${confirmed} more, counted here.` : ` It had passed by its first runs; with the ${confirmed} made again, it does not.`;
  return {
    kept, from, to, before: was, after: is,
    ...(by === "score" && { all: { before: { ok: wasAll.ok, of: wasAll.of }, after: { ok: isAll.ok, of: isAll.of } } }),
    ...(confirmed > 0 && { confirmed }),
    why,
  };
}

const came = await round();
// What is kept for the rounds to come is of the program as it is now: of one that was gone back from, or took another's place, nothing is.
const now = await readHistory(dir, { runs: 0 });
const standing = now.versions.find((version) => version.version === now.current)?.sha256;
kept.notes = standing !== undefined && kept.notes[standing] ? { [standing]: kept.notes[standing] } : {};
const tried = [...(standing !== undefined ? kept.tried[standing] ?? [] : []), ...(judgedAndGoneBackFrom !== undefined ? [judgedAndGoneBackFrom] : [])];
kept.tried = standing !== undefined && tried.length > 0 ? { [standing]: tried } : {};
await ctx.done(came);
