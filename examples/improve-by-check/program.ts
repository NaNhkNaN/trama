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
// another. It is not for a project that is itself the work — a codebase that one run changes for good.

import { ctx } from "@trama-dev/runtime";
import { inputMarkOf, readHistory, resolveProject, rollbackProject, runProgram, updateProject } from "@trama-dev/runtime/runner";

type Input = Record<string, unknown>;
/** What a judge said of one run. (A score that was not given is none: 0.) */
interface Verdict { ok: boolean; score: number; notes?: string }
/** What it said of some runs, together: how many were found good, of how many, and their mean score. */
interface Tally { ok: number; of: number; score: number }

/** The rule. A version is kept where more of its runs were found good; where as many were, where their mean score is higher. A tie goes to the one before: it is the one that is known. */
const better = (is: Tally, was: Tally): boolean => is.ok > was.ok || (is.ok === was.ok && is.score > was.score);

// What it is told (its arguments — as `--arg`s, where a list is written as JSON, or in the meta.json of this project):
//   project   the project to improve, by its name among the user's projects
//   check     the project that judges a run of it (see examples/check-by-command), by its name
//   inputs    what to run it on: a list of arguments. What is found wanting of these is shown to the model.
//   heldBack  more of them, never shown: where there are any, they alone decide. (A program can be written to
//             the inputs its writer was told of. What decides is to be out of reach of what is decided on.)
//   runs      how many runs of each input (1). One run does not rank two versions: the same program, on the
//             same input, is found good one time and not the next.
//   ask       what is wanted, in words — beside what was found wanting, or where nothing was.
const given = ctx.input.args as { project?: unknown; check?: unknown; inputs?: unknown; heldBack?: unknown; runs?: unknown; ask?: unknown };
const listOf = (what: unknown, name: string): Input[] => {
  const list: unknown = typeof what === "string" ? JSON.parse(what) : what ?? [];
  if (!Array.isArray(list) || list.some((each) => each === null || typeof each !== "object" || Array.isArray(each))) throw new Error(`"${name}" is to be a list of arguments: [{ … }, { … }].`);
  return list as Input[];
};
const { project, check } = given;
const inputs = listOf(given.inputs, "inputs"), heldBack = listOf(given.heldBack, "heldBack");
const runs = Number(given.runs ?? 1);
const ask = typeof given.ask === "string" && given.ask.trim() !== "" ? given.ask.trim() : undefined;
if (typeof project !== "string" || typeof check !== "string") throw new Error('It is not said which project to improve, or which checks it: "project" and "check", each by its name.');
if (inputs.length + heldBack.length === 0) throw new Error('It is not said what to run the project on: "inputs", a list of arguments.');
if (!Number.isInteger(runs) || runs < 1) throw new Error('"runs" is how many runs of each input: 1 or more.');

const dir = resolveProject(project), judge = resolveProject(check);
const all = [...inputs, ...heldBack];

/** A check that could not be made: there is nothing to decide by. */
class NoVerdict extends Error {}

/**
 * The verdicts on the project's program as it is now: `runs` of them for each input. Taken from the project's
 * history where they are there — runs of this version, started with this input, checked by this judge as it is
 * now — and by a run where they are not. So a round after another pays for no run that was made.
 */
async function verdicts(): Promise<Verdict[][]> {
  // (The latest runs are enough, and a call's record has room for no more than some.)
  const history = await readHistory(dir, { runs: 500 });
  // The judge as it is now: a verdict on record is its own where the judge's program was this one. (It is on record once it has checked anything.)
  const judging = await readHistory(judge, { runs: 0 });
  const judgedBy = judging.versions.find((version) => version.version === judging.current)?.sha256;
  const each: Verdict[][] = [];
  for (const input of all) {
    const mark = await inputMarkOf(dir, input);
    const found: Verdict[] = history.current === undefined || judgedBy === undefined ? [] : history.runs
      .filter((run) => run.version === history.current && run.ended === undefined && run.input === mark)
      .flatMap(({ check: said }) => (said && said.by === judge && said.program === judgedBy && said.ok !== undefined ? [{ ok: said.ok, score: said.score ?? 0, notes: said.notes }] : []))
      .slice(-runs);
    while (found.length < runs) {
      // (Not fixed where it fails: a fix would be another version, in the middle of what is held against each other.)
      const ran = await runProgram({ projectDir: dir, args: input, checkWith: judge, maxRepairAttempts: 0 });
      if (ran.status !== "done") found.push({ ok: false, score: 0, notes: `The run ${ran.status}: ${(ran.reason ?? "").split("\n")[0]}` });
      else if (ran.check?.ok === undefined) throw new NoVerdict(ran.check?.error ?? "the run was not checked.");
      else found.push({ ok: ran.check.ok, score: ran.check.score ?? 0, notes: ran.check.notes });
    }
    each.push(found);
  }
  return each;
}

const tally = (verdictsOf: Verdict[][]): Tally => {
  const said = verdictsOf.flat();
  return { ok: said.filter((verdict) => verdict.ok).length, of: said.length, score: Number((said.reduce((sum, verdict) => sum + verdict.score, 0) / said.length).toFixed(4)) };
};
/** What decides: the inputs held back, where there are any — else all there are. */
const deciding = (each: Verdict[][]): Tally => tally(heldBack.length > 0 ? each.slice(inputs.length) : each);

async function round(): Promise<Record<string, unknown>> {
  // Before: how the program as it is does.
  let before: Verdict[][];
  try {
    before = await verdicts();
  } catch (err) {
    if (!(err instanceof NoVerdict)) throw err;
    return { kept: false, why: `Nothing was changed: a check could not be made — ${err.message}` };
  }
  const was = deciding(before);
  const from = (await readHistory(dir, { runs: 0 })).current;
  if (from === undefined) throw new Error(`The program of ${project} is on no record as it is: there would be no version to go back to.`);

  // Ask for an update: with what is wanted, and what was found wanting — of the inputs that may be shown, the latest of each.
  const wanting = inputs.flatMap((input, n) => before[n].filter((verdict) => !verdict.ok).slice(-1).map((verdict) => `- started with ${JSON.stringify(input)}: ${verdict.notes ?? "found not good"}`));
  if (wanting.length === 0 && !ask) {
    return { kept: false, from, before: was, why: "Nothing was asked for: no run that may be shown was found wanting, and no `ask` says what else is wanted." };
  }
  try {
    await updateProject(project, [ask, wanting.length > 0 && `Runs of the program as it is were checked, and these were found wanting:\n${wanting.join("\n")}`].filter(Boolean).join("\n\n"));
  } catch (err) {
    return { kept: false, from, before: was, why: `No update came of the asking: ${(err as Error).message}` };
  }
  const to = (await readHistory(dir, { runs: 0 })).current;

  // After: how the new one does — and whatever happens meanwhile, it is not left there untried: the one before is put back.
  let is: Tally;
  try {
    is = deciding(await verdicts());
  } catch (err) {
    await rollbackProject(project, from);
    if (!(err instanceof NoVerdict)) throw err;
    return { kept: false, from, to, before: was, why: `Version ${from} is put back: a check of version ${to} could not be made — ${err.message}` };
  }

  // Decide.
  const kept = better(is, was);
  if (!kept) await rollbackProject(project, from);
  const counts = `${is.ok} of ${is.of} runs${kept ? "" : ` of version ${to}`} were found good ${is.ok === was.ok ? "as" : "where"} ${was.ok} of ${was.of} were`;
  const scores = is.ok === was.ok || kept ? `, at a mean score of ${is.score} where it was ${was.score}` : "";
  return {
    kept, from, to, before: was, after: is,
    why: kept ? `Version ${to} is kept: ${counts}${scores}.`
      : `Version ${from} is put back: ${counts}${is.ok === was.ok ? `${scores} — no better, and the one before is the one that is known` : ""}.`,
  };
}

await ctx.done(await round());
