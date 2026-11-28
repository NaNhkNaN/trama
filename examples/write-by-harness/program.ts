// A writer, by a harness — and a program itself.
//
// Where a project's program is to be written — its first (`trama create`,
// `createProject`) or its next (`trama update`, `updateProject`) — trama asks
// a project for it: the one the call or the configuration names (`createWith`,
// `updateWith`) — else the writer that comes with trama. This is one to name. It
// writes nothing itself: it words what is asked, has a harness do the work,
// and hands back what the harness left.
//
// What it is handed, by the runner: `prompt` (what is asked), `program` (the
// one it is written from — none, at a project's making), `kept` (whether what
// is made beside the program is kept), `types` (the API a program has), and
// `copy` — where it works: a copy of the project, which is its workspace.
// What it answers with: `{ program }`, the whole of the program.
//
// At a project's making the copy has the project's meta.json and no program:
// what the harness says there of what the project takes and gives —
// `description`, `parameters`, `returns` — is the project's from then on.
//
// The harness is a project too (examples/coding-harness, or whichever this
// project's own arguments name — see meta.json): run in the same copy, so
// that the work it does there is the work. A better harness is a better
// writer; and the harness, through this, can be asked to update the harness.
import { ctx, tools, workspace } from "@trama-dev/runtime";
import { resolveProject, runProgram } from "@trama-dev/runtime/runner";

const { prompt, program, kept, types, copy, harness = "coding-harness", model, turns, seconds } = ctx.input.args as {
  prompt?: string; program?: string; kept?: boolean; types?: string; copy?: string;
  harness?: string; model?: string; turns?: number; seconds?: number;
};

if (prompt === undefined || copy === undefined) {
  // (Run by itself — as it is when a new version of it is validated — it has nothing to write.)
  await ctx.done({ nothing: "to write: it was not handed what is asked, or where to work" });
} else {
  // The harness, found before anything is asked of it — and where it is not there, said in this writer's own words:
  // a harness copied under another name is not found by the one this writer has for it.
  let its: string;
  try {
    its = resolveProject(harness);
  } catch {
    throw new Error(`The harness that is to do the writing is not among your projects: ${JSON.stringify(harness)}. Copy one there — trama examples coding-harness — or say which project it is: "harness", among this project's own arguments in its meta.json ({ "input": { "args": { "harness": "…" } } }).`);
  }
  // With no program handed, it is a project's first that is asked for: its making.
  const making = program === undefined;
  // What the harness is told. This wording is the policy of a making and of an update, and is this program's to change.
  const task = [
    making
      ? `Write program.ts, in the current directory: a TypeScript program for the trama runtime, the first of a project that is new. What is asked of it:`
      : `Rewrite program.ts, in the current directory: a TypeScript program for the trama runtime. What is asked of the new version:`,
    prompt,
    `The directory is a copy of the program's project, and is where the program will run: where what is asked speaks of the project's files, look at them. ` +
      (making
        ? `meta.json says what the project is made with (\`input\`: its arguments where a run gives none — it is validated by a run with them). ` +
          `Say there, too, what the project does not say of itself yet, for whoever is to choose this program among others and call it: "description" (what it is for, in a sentence), "parameters" (what a run of it is given, as an object of fields) and "returns" (what the program ends with), written as a Schema is (see the API below) — an argument a run need not be given with a "?" at the end of its name. ` +
          `What the file says already is not yours to change, and the program is held to what it says from its first run.`
        : `meta.json says what the project is for, and — where it says — what a run of it takes (\`parameters\`) and gives (\`returns\`): the program is held to that, and meta.json is not yours to change. ` +
          `state.json, where there is one, is the state the program has kept from its runs.`),
    kept
      ? `What the program needs beside it — a package installed, a module it imports, a file it reads — you can make here: it is kept with the program, if the program then passes its validation.`
      : `Nothing you make here beside program.ts is kept.${making ? " (But what you say in meta.json is.)" : ""}`,
    `Write the whole of the ${making ? "" : "new "}program to program.ts: no partial patch. If the program is long-running (an HTTP server, say), it calls ctx.ready(...) once it is up, and handles SIGTERM and SIGINT to shut down cleanly.`,
    ...(types ? [`The runtime's API, as a program has it:\n${types}`] : []),
    // (For a first program there is none to go by: some are shown — this project's own to choose, beside its program.)
    ...(making ? [`Programs, for what one looks like:\n${await tools.read("example-programs.txt")}`] : []),
  ].join("\n\n");

  const ran = await runProgram({
    projectDir: its,
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
