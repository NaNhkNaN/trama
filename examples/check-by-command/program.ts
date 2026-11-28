// A checker: a project that says what a run's work is worth. Where a run names it (`checkWith`, or
// `trama run <name> --check check-by-command`), this program is run once that run is done, and what it ends
// with is the verdict — { ok, score?, notes? } — on the run's result and on its record.
//
// This one checks by a command: the work is good where the command ends well, where the work is — in the project,
// or in the run's workspace where it had one (a harness at work on a codebase). It is a starting point, to be
// copied and changed — a checker is a program like any, and can as well put in tests that were held back, ask a
// model for its judgement (`agent`), or hold the program to its earlier runs (`replayAll`).

import { ctx, workspace } from "@trama-dev/runtime";

/** The most of what the command printed that goes into the verdict: the end of it, where a failure shows. */
const MOST = 2000;

// Its own arguments (in its meta.json): the command, and how long it may take. Beside them it is handed the run it
// checks — `result` (what the program ended with), `args` (what the run was started with), `journal` and `run`
// (the run's record, and its id), `used` (what it had used of a model) — which a command has no use for, and
// another checker would — and `workspace`: where the run worked, where that was not in its project.
const { command: given, seconds = 600, workspace: where } = ctx.input.args as { command?: string; seconds?: number; workspace?: string };
// (Where it is not said, the run has failed with that, in these words — ctx.fail: nothing is wrong with this program.)
const command = typeof given === "string" && given.trim() !== ""
  ? given
  : await ctx.fail('It is not said what command checks: "command", among the arguments in the meta.json of this project.');

// Its workspace is a copy of the project as the run left it. A run that had a workspace of its own left its work
// there, and not in the project: that place is copied too, into this one. Either way the command is run in a
// copy, and whatever it changes is thrown away with it: a check changes nothing.
let at: string | undefined;
if (typeof where === "string") {
  const copied = await workspace.shell('at=$(mktemp -d .work-XXXXXX) && cp -R "$WHERE/." "$at" && printf %s "$at"', { env: { WHERE: where }, timeout: seconds * 1000 });
  if (copied.exitCode !== 0) await ctx.fail(`Where the run worked could not be copied, to be checked: ${where}\n${copied.stderr}`);
  at = copied.stdout;
}
const ran = await workspace.shell(command, { timeout: seconds * 1000, cwd: at });
// (A command stopped at its time says so of itself; the runtime ends what it wrote to stderr with the word, which is taken off.)
const printed = ran.stdout + (ran.timedOut ? ran.stderr.slice(0, -"\ntimeout".length) : ran.stderr);
const how = ran.timedOut ? `It was not done after the ${seconds}s it was given.\n` : ran.exitCode === 0 ? "" : `exit code ${ran.exitCode}\n`;
await ctx.done({ ok: ran.exitCode === 0 && !ran.timedOut, notes: how + (printed.length > MOST ? `…${printed.slice(-MOST)}` : printed) });
