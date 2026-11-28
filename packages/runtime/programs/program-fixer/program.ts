// A fixer of programs, by one asking of the runtime's own agent — and a
// program itself.
//
// Where a run's program fails, trama asks a project for a fix: the one the run
// or the configuration names (`repairWith`), and where nobody is named, this
// one. It comes with the runtime and is put among the user's projects the
// first time it is wanted; from then on it is theirs, to be read and changed.
// The runtime has no words of its own to a model for a fix: they are these.
//
// What it is handed, by the runner: `program` (the one that failed, whole),
// `error` (how it failed), `journal` (the path of the failed run's record),
// `kept` (whether what is changed beside the program is kept, with a fix
// that then works), `types` (the API a program has) — and its workspace,
// which is a copy of the failing project: the agent works there.
// What it answers with: `{ program }`, the whole of the fixed program — or
// `{ unfixable }`, why there is no fix.
//
// Everything here is the policy of a fix, and is this program's to change:
// what the agent is told, which model is asked, how its answer is read. What
// is round a fix is trama's, whoever fixes: the copy, the trial of what
// comes back, what is kept of it.
import { ctx, agent, workspace, stripCodeFences } from "@trama-dev/runtime";

const { program, error, journal, kept, types } = ctx.input.args as { program?: string; error?: string; journal?: string; kept?: boolean; types?: string };

/** How an answer begins that says there is no fix. */
const NO_FIX = "NO FIX:";

if (program === undefined || error === undefined) {
  // (Run by itself — as it is when a new version of it is validated — it has nothing to fix.)
  await ctx.done({ nothing: "to fix: it was not handed a program that failed, and what it failed with" });
} else {
  // What the agent is asked. This wording is the policy, and is this program's to change.
  const ask =
    `Fix this program so it runs.\n\n` +
    `You are working in a copy of the project's directory, where the program is program.ts. ` +
    (kept
      ? `If what is wrong is in the project and not in the program — a package that is not installed, a file the program needs that is missing or wrong — put it right here: ` +
        `what you change in this directory is kept, with the program you answer with, if that program then runs. If it does not, none of it is.\n`
      : `Nothing you change in this directory is kept: the program you answer with is all that is taken from you.\n`) +
    (journal ? `The record of the run that failed — each call the program made, and what came back — is at ${journal}, a line of JSON for each.\n` : "") +
    `If the program cannot be made to run without having it say what is not so, or leave out what it is there to do — a check taken out, a failure handed back as if it were a result — then there is no fix, and you are not to hand over such a program: answer instead with one line that begins "${NO_FIX}" and says why.\n` +
    `\nRuntime types:\n${types}\n\n` +
    `Broken program:\n${program}\n\n` +
    `Error:\n${error}\n\n` +
    `Output ONLY the fixed program${kept ? ": the whole of it, also where it is the project that needed fixing" : ""}. No explanation.`;

  // By the model the failing project is made with, where it says one.
  let model: string | undefined;
  try {
    const meta = JSON.parse(await workspace.read("meta.json")) as { provider?: string; model?: string };
    if (meta.provider && meta.model) model = `${meta.provider}/${meta.model}`;
  } catch { /* (It says none that can be read: the model is this project's own.) */ }

  // The agent is asked once, at work in the copy.
  const answer = await agent.instruct(ask, { system: "You are a TypeScript repair tool.", workspace: true, ...(model !== undefined && { model }) });

  // Its answer is the program — out of its fences, where it came in some — or that there is no fix.
  if (answer.trimStart().startsWith(NO_FIX)) {
    await ctx.done({ unfixable: answer.trimStart().slice(NO_FIX.length).trim() });
  } else {
    await ctx.done({ program: stripCodeFences(answer) });
  }
}
