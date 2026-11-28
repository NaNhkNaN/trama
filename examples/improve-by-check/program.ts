// The loop, as a program: one round of it a run. It holds a project's program against the one an update
// writes — by a judge, on inputs that are said — and keeps the better: the new one is made the program, or the
// program stays what it is.
//
// trama has the facts and the moves: every run of a project leaves a line in its history, with the version it
// was of and what its check said (`readHistory`); a version is written and kept beside the program
// (`updateProject` with `install: false`), run by its number (`runProgram` with `version`), and made the program
// (`rollbackProject`). So the new one is judged before it is the program: the project never holds a program
// that was not yet judged, and a round that comes to nothing leaves nothing to undo. Which version is the
// better is said here, in `better`, and nowhere else. It is a starting point, to be copied and changed.
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
//   write     who writes the update: a project, by its name (see examples/write-by-harness) — else whoever the
//             configuration names, or the writer that comes with trama. (Who writes is told what this loop tells, in the words it tells it:
//             what more a writer may read — the project's history, the records of its runs — is for it to be told there.)
const given = ctx.input.args as { project?: unknown; check?: unknown; inputs?: unknown; heldBack?: unknown; runs?: unknown; ask?: unknown; from?: unknown; by?: unknown; margin?: unknown; confirm?: unknown; tell?: unknown; write?: unknown };
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
const write = typeof given.write === "string" && given.write.trim() !== "" ? given.write.trim() : undefined;
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
 * A run that failed, and failed again when it was made again. What failed it is not known here — the program, or
 * what is around it: a model that could not be reached fails a run as a fault of the program does. Of a version
 * that is being tried there is then nothing to decide by: it is not found worse for it.
 */
class RunFailed extends Error { shown = false; on: Input | undefined; }
/** The runs of this round that failed and were made again. */
let remade = 0;

/**
 * What this loop keeps from one round to the next (its state): words, and nothing else. What the judge said, whole,
 * of the runs it made of the program as it is — a project's history keeps the beginning of a verdict's notes, and
 * what comes after is often what a writer can act on. By the program's text, then by the mark of the input; of
 * inputs that are shown.
 *
 * And what a run of a version said as it failed, where it failed twice and nothing was decided: of that a line of
 * history has the first line, which seldom says what failed. By the text of the program the version was written
 * from, then by the version; of a run of an input that may be shown. (Of one that is held back, nothing: a program
 * can say as it fails what it was started with.)
 *
 * It keeps no list of what it tried, nor of what it decided: which versions were written from the program, and what
 * the runs of each came to, is on the project's record — see `writtenBefore`.
 */
const kept = ctx.state as { notes?: Record<string, Record<string, string[]>>; said?: Record<string, Record<string, string>> };
kept.notes ??= {};
kept.said ??= {};
/** What a run of the version this round wrote said as it failed twice, where it did and may be told. */
let saidAsItFailed: { version: number; said: string } | undefined;
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
 * `tried`: of that version — one kept beside the program, by its number — and not of the program.
 *
 * `again`: made again, to confirm — of the inputs that decide only, and by new runs alone: nothing from the record.
 *
 * A run that fails is made again, once, and it is the second that counts: what fails a run is not always its
 * program. Where that fails too: of the program as it is, it is a run found wanting, and what it said as it failed
 * is what there is to mend; of a version that is being tried, nothing is decided — RunFailed.
 */
async function verdicts(again = 0, tried?: number): Promise<Verdict[][]> {
  // (The latest runs are enough, and a call's record has room for no more than some.)
  const history = await readHistory(dir, { runs: 500 });
  // The judge as it is now: a verdict on record is its own where the judge's program was this one. (It is on record once it has checked anything.)
  const judging = await readHistory(judge, { runs: 0 });
  const judgedBy = judging.versions.find((version) => version.version === judging.current)?.sha256;
  // The versions that are the program as it is now — or the version that is tried: the one it is, and any before it with the same text.
  const of = tried ?? history.current;
  const text = history.versions.find((version) => version.version === of)?.sha256;
  const same = new Set(history.versions.filter((version) => text !== undefined && version.sha256 === text).map((version) => version.version));
  const each: Verdict[][] = [], heard: Array<[string, string]> = [];
  for (const [n, input] of all.entries()) {
    if (again > 0 && !decides(n)) { each.push([]); continue; }
    const mark = await inputMarkOf(dir, input);
    const found: Verdict[] = again > 0 || of === undefined || judgedBy === undefined ? [] : history.runs
      .filter((run) => run.version !== undefined && same.has(run.version) && run.ended === undefined && run.input === mark)
      .flatMap(({ check: said }) => (said && said.by === judge && said.program === judgedBy && said.ok !== undefined ? [{ ok: said.ok, score: said.score ?? 0, notes: whole(said.notes, text, mark) }] : []))
      .slice(-runs);
    while (found.length < runs) {
      // (Not fixed where it fails: a fix would be another version, in the middle of what is held against each other.)
      const work = `work/v${of ?? 0}-${n}-${found.length}${again > 0 ? `-again${again}` : ""}`;
      const make = async (work: string) => {
        const workspaceDir = await fresh(input, work);
        // (A run that is judged is given no way to make projects, or change them: a version under judgment is not to go to itself, whatever is said of it.)
        const ran = await runProgram({ projectDir: dir, args: input, checkWith: judge, maxRepairAttempts: 0, making: false, ...(tried !== undefined && { version: tried }), ...(workspaceDir !== undefined && { workspaceDir }) });
        // (The judge has seen it by now: a check is part of the run. The copy has done what it was for.)
        if (workspaceDir !== undefined) await tools.shell(`rm -rf ${quoted(work)}`, { timeout: 600_000 });
        return ran;
      };
      let ran = await make(work);
      if (ran.status !== "done") {
        remade++;
        ran = await make(`${work}-remade`);
      }
      if (ran.status !== "done") {
        const said = `The run ${ran.status}, and ${ran.status} when it was made again: ${(ran.reason ?? "").trim().slice(0, 1000)}`;
        if (tried !== undefined) throw Object.assign(new RunFailed(said), { shown: n < inputs.length, on: input });
        found.push({ ok: false, score: 0, notes: said });
      } else if (ran.check?.ok === undefined) throw new NoVerdict(ran.check?.error ?? "the run was not checked.");
      else found.push({ ok: ran.check.ok, score: ran.check.score ?? 0, notes: ran.check.notes });
      if (ran.check?.notes !== undefined && n < inputs.length) heard.push([mark, ran.check.notes]);
    }
    each.push(found);
  }
  // What was heard is kept, whole, for the rounds to come: of an input that may be shown, as many as a round makes of
  // it. (By the program's text — which, of a program that had never been run, is on record only now that it has been.)
  if (heard.length > 0) {
    const ran = text !== undefined ? undefined : await readHistory(dir, { runs: 0 });
    const under = text ?? ran?.versions.find((version) => version.version === ran.current)?.sha256;
    if (under !== undefined) for (const [mark, notes] of heard) ((kept.notes![under] ??= {})[mark] = [...(kept.notes![under][mark] ?? []), notes].slice(-(runs * (1 + confirm))));
  }
  return each;
}

/**
 * What was written before from the program as it is, and is not the program: read from the project's history, which
 * has every version with the one it was written from, and every run of each with what its check said. A round
 * begins from the program again; without this its writer does not know what the rounds before came to, and writes
 * it again. Of each text, its latest version; and of those, two kinds —
 *
 *  - `tried`: judged whole — as many verdicts of this judge as a round makes, of every input — and it is not the
 *    program: it was found no better. What its runs came to, on what decides, and what it changed. The five latest.
 *  - `notJudged`: its latest run of some input did not end done — it failed, and failed when it was made again — so
 *    nothing was decided of it. What the run said as it failed, where that may be told, and what it changed. The
 *    three latest.
 *
 * A version that is neither — a check of it could not be made, or its round fell over — was never judged, and is
 * not told as if it had been, whatever runs of it happened to be judged first.
 * (All of it is read by the runner or by a command: it is on this run's record, and a replay is told the same.)
 */
async function writtenBefore(was: Tally): Promise<{ tried: string[]; notJudged: string[] }> {
  const history = await readHistory(dir, { runs: 500 });
  const judging = await readHistory(judge, { runs: 0 });
  const judgedBy = judging.versions.find((version) => version.version === judging.current)?.sha256;
  const text = history.versions.find((version) => version.version === history.current)?.sha256;
  const tried: string[] = [], notJudged: string[] = [];
  if (text === undefined) return { tried, notJudged };
  // The latest version of each text that an update wrote from this very text: its line says which version it was written from.
  const written = new Map<string, { version: number; from: number }>();
  for (const version of history.versions) {
    const from = history.versions.find((one) => one.version === version.parent);
    if (version.reason === "update" && version.sha256 !== undefined && version.sha256 !== text && from?.sha256 === text) written.set(version.sha256, { version: version.version, from: from.version });
  }
  if (written.size === 0) return { tried, notJudged };
  const marks: string[] = [];
  for (const input of all) marks.push(await inputMarkOf(dir, input));
  for (const [sha256, { version, from }] of written) {
    const its = new Set(history.versions.filter((one) => one.sha256 === sha256).map((one) => one.version));
    const runsOf = (mark: string) => history.runs.filter((run) => run.version !== undefined && its.has(run.version) && run.ended === undefined && run.input === mark);
    // (The runs it was judged by: one that failed was made again, and is none of them.)
    const verdictsOf = (mark: string): Verdict[] => runsOf(mark)
      .flatMap((run) => (run.status === "done" && run.check && run.check.by === judge && run.check.program === judgedBy && run.check.ok !== undefined ? [{ ok: run.check.ok, score: run.check.score ?? 0 }] : []));
    const failed = marks.findIndex((mark) => { const last = runsOf(mark).at(-1); return last !== undefined && last.status !== "done"; });
    if (failed >= 0) {
      const last = runsOf(marks[failed]).at(-1)!;
      // What the run said: as this loop heard it — or, where it did not, what the history has of it. Of an input that is held back, nothing.
      const said = failed >= inputs.length ? "a run of an input that is held back."
        : kept.said![text]?.[version] ?? `started with ${JSON.stringify(all[failed])}: ${last.reason ?? `the run ${last.status}`}`;
      notJudged.push(`- version ${version}: ${said}${await changedBy(from, version)}`);
    } else if (marks.every((mark) => verdictsOf(mark).length >= runs)) {
      const is = tally([[...new Set(marks.filter((_, n) => decides(n)))].flatMap(verdictsOf)]);
      tried.push(`- version ${version}: ${is.ok} of ${is.of} runs found good, at a mean score of ${is.score}, where the program as it is has ${was.ok} of ${was.of} at ${was.score}.${await changedBy(from, version)}`);
    }
  }
  return { tried: tried.slice(-5), notJudged: notJudged.slice(-3) };
}

/** What a version changed, as a diff from the one it was written from: of the two files in the project's history. */
async function changedBy(from: number, version: number): Promise<string> {
  const file = (version: number) => join(dir, "history", `${String(version).padStart(4, "0")}.ts`);
  // (Cut at 20,000 characters: a version a model wrote of a harness of 340 lines was a diff of 13,000.)
  const diff = (await tools.shell(`diff ${quoted(file(from))} ${quoted(file(version))} | head -c 20000`, { timeout: 60_000 })).stdout.trimEnd();
  return diff ? ` What it changed, as a diff from the program as it is:\n${diff.split("\n").map((line) => `  ${line}`).join("\n")}` : "";
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
/**
 * How each input went, in the order they were given — those held back after the others, and marked: what the
 * program came to on it, and the version that was tried where one was. For whoever runs the loop: what decides is
 * one count, a project's history is by version, and neither says which input it was that went wrong. (No writer
 * is told it: of the inputs held back a writer hears the one count, as before.)
 */
const eachOf = (before: Verdict[][], after?: Verdict[][]) =>
  all.map((input, n) => ({ input, heldBack: n >= inputs.length, before: tally([before[n]]), ...(after && { after: tally([after[n]]) }) }));
/**
 * What a failure said, for a round's `why`: without where in the code each thing was said. A program that failed
 * is told with all it printed as it died — a stack, and what it died of one line in it — and a `why` is read by
 * whoever runs the loop, for what to do next. (The whole of it is on record where it happened: `trama journal`.)
 */
const told = (message: string): string =>
  message.split("\n").filter((line) => !/^\s+at \S/.test(line) && !/^Node\.js v\d/.test(line)).join("\n").trim();

async function round(): Promise<Record<string, unknown>> {
  // Before: how the program as it is does.
  let before: Verdict[][];
  try {
    before = await verdicts();
  } catch (err) {
    if (!(err instanceof NoVerdict)) throw err;
    return { kept: false, why: `Nothing was changed: a check could not be made — ${told(err.message)}` };
  }
  const was = deciding(before), wasAll = tally(before), wasGood = partGood(before);
  const from = (await readHistory(dir, { runs: 0 })).current;
  if (from === undefined) throw new Error(`The program of ${project} is on no record as it is: there would be no version to go back to.`);

  // Ask for an update: with what is wanted, and what was found wanting — of the inputs that may be shown, the latest of
  // each. (And, where it is asked for, what the judge said of the latest that was found good.)
  const said = (ok: boolean) => inputs.flatMap((input, n) => before[n].filter((verdict) => verdict.ok === ok).slice(-1).map((verdict) => `- started with ${JSON.stringify(input)}: ${verdict.notes ?? (ok ? "found good" : "found not good")}`));
  const wanting = said(false), good = tell === "all" ? said(true) : [];
  if (wanting.length === 0 && !ask) {
    return { kept: false, from, before: was, each: eachOf(before), why: "Nothing was asked for: no run that may be shown was found wanting, and no `ask` says what else is wanted." };
  }
  const checked = "Runs of the program as it is were checked, and these";
  const { tried, notJudged } = await writtenBefore(was);
  let to: number;
  try {
    // (Written, and kept beside the program: the program is not replaced by what has not been judged.)
    ({ version: to } = await updateProject(project, [
      ask,
      wanting.length > 0 && `${checked} were found wanting:\n${wanting.join("\n")}`,
      good.length > 0 && `${wanting.length > 0 ? "And these" : checked} were found good — what the judge said of each:\n${good.join("\n")}`,
      tried.length > 0 && `Tried before, from the program as it is — none was kept. Write something else:\n${tried.join("\n")}`,
      notJudged.length > 0 && `Written before, from the program as it is, and not judged: a run of each failed, and failed when it was made again. Whether that was the version's doing is not known — where it was, do not write that again:\n${notJudged.join("\n")}`,
    ].filter(Boolean).join("\n\n"), { install: false, ...(write !== undefined && { updateWith: write }) }));
  } catch (err) {
    return { kept: false, from, before: was, each: eachOf(before), why: `No update came of the asking: ${told((err as Error).message)}` };
  }

  // After: how the new one does — run by its number, from beside the program. Decide — and where it passes and is to
  // be confirmed, make the runs that decide again, and decide by all of them. Whatever happens meanwhile, the program
  // is the one it was: there is nothing to put back.
  let after: Verdict[][], kept: boolean, confirmed = 0;
  const passes = () => (by === "score" ? betterByScore(deciding(after), was, partGood(after), wasGood, margin) : better(deciding(after), was, margin));
  try {
    after = await verdicts(0, to);
    kept = passes();
    for (let again = 1; kept && again <= confirm; again++) {
      const more = await verdicts(again, to);
      after = after.map((of, n) => [...of, ...more[n]]);
      confirmed += more.flat().length;
      kept = passes();
    }
  } catch (err) {
    if (err instanceof RunFailed) {
      if (err.shown) saidAsItFailed = { version: to, said: `started with ${JSON.stringify(err.on)}: ${err.message}` };
      return { kept: false, from, to, before: was, each: eachOf(before), remade, why: `Version ${from} stays, and nothing is decided: a run of version ${to} failed, and failed when it was made again — whether that is the version's doing is not known. ${told(err.message)}` };
    }
    if (!(err instanceof NoVerdict)) throw err;
    return { kept: false, from, to, before: was, each: eachOf(before), why: `Version ${from} stays: a check of version ${to} could not be made — ${told(err.message)}` };
  }
  // It is the better: it is made the program. It is not: it stays where it is, on record with what its runs came to —
  // which is all that the rounds to come need to know that it was tried.
  if (kept) await rollbackProject(project, to);

  // What it did, and why.
  const is = deciding(after), isAll = tally(after);
  let why: string;
  if (by === "score") {
    const scores = `a mean score of ${is.score} where it was ${was.score}`, more = margin > 0 ? ` by more than ${margin}` : "";
    why = kept ? `Version ${to} is kept: ${scores}, higher${more}; ${isAll.ok} of ${isAll.of} runs of all inputs found good where ${wasAll.ok} of ${wasAll.of} were.`
      : !(is.score > was.score + margin) ? `Version ${from} stays: ${scores}, not higher${more}.`
      : `Version ${from} stays: ${isAll.ok} of ${isAll.of} runs of version ${to}, all inputs counted, were found good where ${wasAll.ok} of ${wasAll.of} were — a smaller part, input by input (${Number(partGood(after).toFixed(2))} where it was ${Number(wasGood.toFixed(2))}), whatever its score.`;
  } else {
    const counts = `${is.ok} of ${is.of} runs${kept ? "" : ` of version ${to}`} were found good ${is.ok === was.ok ? "as" : "where"} ${was.ok} of ${was.of} were`;
    const scores = is.ok === was.ok || kept ? `, at a mean score of ${is.score} where it was ${was.score}` : "";
    why = kept ? `Version ${to} is kept: ${counts}${scores}.`
      : `Version ${from} stays: ${counts}${is.ok === was.ok ? `${scores} — ${margin > 0 ? `not better by more than ${margin}` : "no better"}, and the one before is the one that is known` : ""}.`;
  }
  if (remade > 0) why += ` ${remade} run${remade === 1 ? "" : "s"} failed and ${remade === 1 ? "was" : "were"} made again: what came of ${remade === 1 ? "it" : "them"} then is what is counted.`;
  if (confirmed > 0) why += kept ? ` The runs that decide were made again to be sure of it: ${confirmed} more, counted here.` : ` It had passed by its first runs; with the ${confirmed} made again, it does not.`;
  return {
    kept, from, to, before: was, after: is, each: eachOf(before, after),
    ...(by === "score" && { all: { before: { ok: wasAll.ok, of: wasAll.of }, after: { ok: isAll.ok, of: isAll.of } } }),
    ...(confirmed > 0 && { confirmed }),
    ...(remade > 0 && { remade }),
    why,
  };
}

const came = await round();
// What is kept for the rounds to come is of the program as it is now: of one that another took the place of, nothing is.
const now = await readHistory(dir, { runs: 0 });
const standing = now.versions.find((version) => version.version === now.current)?.sha256;
kept.notes = standing !== undefined && kept.notes[standing] ? { [standing]: kept.notes[standing] } : {};
const said = { ...(standing !== undefined ? kept.said[standing] : undefined), ...(saidAsItFailed !== undefined && { [saidAsItFailed.version]: saidAsItFailed.said }) };
kept.said = standing !== undefined && Object.keys(said).length > 0 ? { [standing]: said } : {};
await ctx.done(came);
