// A checker: a project that says what a run's work is worth. Where a run names it (`checkWith`, or
// `trama run <name> --check check-by-command`), this program is run once that run is done, and what it ends
// with is the verdict — { ok, score?, notes? } — on the run's result and on its record.
//
// This one checks by a command: the work is good where the command ends well. It is a starting point, to be
// copied and changed — a checker is a program like any, and can as well put in tests that were held back, ask a
// model for its judgement (`agent`), or hold the program to its earlier runs (`replayAll`).

import { ctx, workspace } from "@trama-dev/runtime";

/** The most of what the command printed that goes into the verdict: the end of it, where a failure shows. */
const MOST = 2000;

// Its own arguments (in its meta.json): the command, and how long it may take. Beside them it is handed the run it
// checks — `result` (what the program ended with), `args` (what the run was started with), `journal` and `run`
// (the run's record, and its id) — which a command has no use for, and another checker would.
const { command, seconds = 600 } = ctx.input.args as { command?: string; seconds?: number };
if (typeof command !== "string" || command.trim() === "") {
  throw new Error('It is not said what command checks: "command", among the arguments in the meta.json of this project.');
}

// Its workspace is a copy of the project as the run left it. The command is run there, and whatever it changes
// is thrown away with the copy: a check changes nothing.
const ran = await workspace.shell(command, { timeout: seconds * 1000 });
// (A command stopped at its time says so of itself; the runtime ends what it wrote to stderr with the word, which is taken off.)
const printed = ran.stdout + (ran.timedOut ? ran.stderr.slice(0, -"\ntimeout".length) : ran.stderr);
const how = ran.timedOut ? `It was not done after the ${seconds}s it was given.\n` : ran.exitCode === 0 ? "" : `exit code ${ran.exitCode}\n`;
await ctx.done({ ok: ran.exitCode === 0 && !ran.timedOut, notes: how + (printed.length > MOST ? `…${printed.slice(-MOST)}` : printed) });
