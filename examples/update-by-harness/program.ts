// A writer, by a harness — and a program itself.
//
// Where a project's program is to be rewritten (`trama update`, or a program's
// `updateProject`), trama asks for the new one — of pi's agent, unless the
// update or the configuration names a project to ask instead (`updateWith`).
// This is such a project. It writes nothing itself: it words what is asked,
// has a harness do the work, and hands back what the harness left.
//
// What it is handed, by the runner: `prompt` (what is asked of the new
// version), `program` (the one it is written from), `kept` (whether what is
// made beside the program is kept), `types` (the API a program has), and
// `copy` — where it works: a copy of the project, which is its workspace.
// What it answers with: `{ program }`, the whole of the new program.
//
// The harness is a project too (examples/coding-harness, or whichever this
// project's own arguments name — see meta.json): run in the same copy, so
// that the work it does there is the work. A better harness is a better
// writer; and the harness, through this, can be asked to update the harness.
import { ctx, workspace } from "@trama-dev/runtime";
import { resolveProject, runProgram } from "@trama-dev/runtime/runner";

const { prompt, kept, types, copy, harness = "coding-harness", model, turns, seconds } = ctx.input.args as {
  prompt?: string; program?: string; kept?: boolean; types?: string; copy?: string;
  harness?: string; model?: string; turns?: number; seconds?: number;
};

if (prompt === undefined || copy === undefined) {
  // (Run by itself — as it is when a new version of it is validated — it has nothing to write.)
  await ctx.done({ nothing: "to write: it was not handed what is asked, or where to work" });
} else {
  // What the harness is told. This wording is the policy of an update, and is this program's to change.
  const task = [
    `Rewrite program.ts, in the current directory: a TypeScript program for the trama runtime. What is asked of the new version:`,
    prompt,
    `The directory is a copy of the program's project, and is where the program will run: where what is asked speaks of the project's files, look at them. ` +
      `meta.json says what the project is for, and — where it says — what a run of it takes (\`parameters\`) and gives (\`returns\`): the program is held to that, and meta.json is not yours to change. ` +
      `state.json, where there is one, is the state the program has kept from its runs.`,
    kept
      ? `What the program needs beside it — a package installed, a module it imports, a file it reads — you can make here: it is kept with the program, if the program then passes its validation.`
      : `Nothing you make here beside program.ts is kept.`,
    `Write the whole of the new program to program.ts: no partial patch. If the program is long-running (an HTTP server, say), it calls ctx.ready(...) once it is up, and handles SIGTERM and SIGINT to shut down cleanly.`,
    ...(types ? [`The runtime's API, as a program has it:\n${types}`] : []),
  ].join("\n\n");

  const ran = await runProgram({
    projectDir: resolveProject(harness),
    workspaceDir: copy,
    maxRepairAttempts: 0,
    ...(seconds !== undefined && { timeout: seconds * 1000 }),
    args: { task, ...(model !== undefined && { model }), ...(turns !== undefined && { turns }) },
  });
  if (ran.status !== "done") throw new Error(`The harness ${ran.status === "failed" ? "failed" : "did not end its work"}: ${ran.reason ?? ran.status}`);

  // The program is what the harness left where the program is.
  const said = (ran.result as { summary?: unknown } | undefined)?.summary;
  await ctx.done({ program: await workspace.read("program.ts"), ...(typeof said === "string" && { said }) });
}
