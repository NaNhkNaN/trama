// A writer of programs, by one asking of the runtime's own agent — and a
// program itself.
//
// Where a project's program is to be written — its first (`trama create`,
// `createProject`) or its next (`trama update`, `updateProject`) — trama asks
// a project for it: the one the call or the configuration names
// (`createWith`, `updateWith`), and where nobody is named, this one. It comes
// with the runtime and is put among the user's projects the first time it is
// wanted; from then on it is theirs, to be read and changed. The runtime has
// no words of its own to a model for a writing: they are these.
//
// What it is handed, by the runner: `prompt` (what is asked), `program` (the
// one it is written from — none, at a project's making), `kept` (whether what
// is made beside the program is kept), `types` (the API a program has) — and
// its workspace, which is a copy of the project: the agent works there.
// What it answers with: `{ program }`, the whole of the program — or
// `{ unwritable }`, why there is none to be written.
//
// The program is what the agent answers with — or program.ts in the copy as
// the agent left it, where its answer says so ("IN THE FILE:"): an agent with
// tools for files changes a line of a long program where it is, and is not
// to write six hundred lines out again to say that it did.
//
// Everything here is the policy of a writing, and is this program's to
// change: what the agent is told, the programs it is shown to go by
// (example-programs.txt, beside this), which model is asked, how its answer
// is read. What is round a writing is trama's, whoever writes: the copy, the
// validation of what comes back, the version on record.
import { ctx, agent, tools, workspace, stripCodeFences } from "@trama-dev/runtime";

const { prompt, program, kept, types } = ctx.input.args as { prompt?: string; program?: string; kept?: boolean; types?: string };

/** How an answer begins that says there is no program to be written. */
const NO_PROGRAM = "NO PROGRAM:";
/** How an answer begins that says the program is program.ts, where the agent worked, as it left it — and is itself no program. */
const IN_THE_FILE = "IN THE FILE:";
/** What a project says of itself for whoever is to choose it: the three things, and what each is. */
const CONTRACT = ["description", "parameters", "returns"] as const;
const WHAT_EACH_IS: Record<(typeof CONTRACT)[number], string> = {
  description: `"description" is what the project is for, in a sentence`,
  parameters: `"parameters" is what a run of it is given — its arguments — as an object of fields`,
  returns: `"returns" is what the program ends with: what it hands to ctx.done`,
};

if (prompt === undefined) {
  // (Run by itself — as it is when a new version of it is validated — it has nothing to write.)
  await ctx.done({ nothing: "to write: it was not handed what is asked" });
} else {
  // The project, as its copy has it: what it says of itself, and what it has kept.
  const meta = JSON.parse(await workspace.read("meta.json")) as {
    description?: unknown; parameters?: unknown; returns?: unknown; provider?: string; model?: string;
    input: { prompt: string; args?: Record<string, unknown> };
  };
  let state: Record<string, unknown> = {};
  try { state = JSON.parse(await workspace.read("state.json")); } catch { /* (It has kept none.) */ }
  // With no program handed, it is a project's first that is asked for: its making — and what the project does not
  // say of itself yet is then its writer's to say.
  const making = program === undefined;
  const proposes = making ? CONTRACT.filter((field) => meta[field] === undefined || meta[field] === null) : [];
  const says = { description: meta.description, parameters: meta.parameters, returns: meta.returns };
  const examples = (await tools.read("example-programs.txt")).trimEnd();

  // What the agent is told beside what is asked. This wording is the policy, and is this program's to change.
  const system =
    `You are generating a TypeScript program for the trama runtime.\n\n` +
    `If the program is long-running (for example an HTTP server), call ctx.ready(...) after startup completes and handle SIGTERM/SIGINT for clean shutdown.\n\n` +
    `The workspace object is there where a run is given a directory to work in beside its project (a codebase, or what several runs share): workspace.read, write, list, shell. ` +
    `ctx.yield(reason) suspends the program cooperatively — persists state and exits. ` +
    `ctx.resumed is true if this run follows a yield; ctx.yieldReason has the reason.\n\n` +
    `You are working in a copy of the project's directory, which is where the program will run: ` +
    `where the task speaks of the project's files, look at them. ` +
    (kept
      ? `What the program needs beside it — a package installed, a module it imports, a file it reads — ` +
        `you can make here: it is kept, with the program, if the program then passes its validation. ` +
        `The program itself is what you answer with, whatever you wrote to program.ts here. `
      : `Nothing you write here is kept — only the program you answer with. `) +
    `Unless your answer is one line that begins "${IN_THE_FILE}" and says what you did: the program is then program.ts here, as you left it — written there, or changed where it was.\n\n` +
    `If the program cannot be written as it is asked for — what is asked goes against what the project says it takes and gives, or cannot be done with what there is — ` +
    `then there is no program, and you are not to hand over one that does something else: answer instead with one line that begins "${NO_PROGRAM}" and says why.\n\n` +
    `Runtime API:\n${types}\n\n` +
    `Examples:\n${examples}` +
    (says.parameters !== undefined || says.returns !== undefined
      ? `\n\nWhat the project says it takes and gives (its meta.json): the program is held to it — a run's arguments are these and no others, and what the program ends with is to be of this shape — and it is not the program's to change.\n${JSON.stringify(says, null, 2)}`
      : "") +
    (proposes.length > 0
      ? `\n\nSay in meta.json, here, what the project does not say of itself yet — ${proposes.map((field) => `"${field}"`).join(", ")} — for whoever is to choose this program among others, and call it: ` +
        `${proposes.map((field) => WHAT_EACH_IS[field]).join("; ")}. ` +
        `What is taken and given is written as a Schema is (see the API): a field by its kind — "string", "number", "boolean", "object" for an object whatever its fields, "json" for any value — with what it is after a colon, an object by its fields, a list by the shape of its items in brackets, and a field that may be absent with a "?" at the end of its name. ` +
        `Add them to the file and change nothing else of it. This is kept, whatever else of what you make here is; and the program is held to it from its first run.\n` +
        `The project is made with these arguments, and is validated by a run of it with them: ${JSON.stringify(meta.input.args ?? {})}. An argument a run need not be given is written as one that may be absent.`
      : "") +
    (making ? "" :
      `\n\nOriginal prompt: ${meta.input.prompt}` +
      `\n\nCurrent program.ts:\n${program}` +
      (Object.keys(state).length > 0 ? `\n\nCurrent state:\n${JSON.stringify(state, null, 2)}` : ""));
  const ask = making
    ? `${prompt}\n\nOutput ONLY the TypeScript program. No markdown fences. No explanation. (Or the one line that begins "${IN_THE_FILE}", where the program is in program.ts as you left it.)`
    : `${prompt}\n\nOutput the complete updated program.ts. No partial patches. No markdown fences. No explanation. (Or the one line that begins "${IN_THE_FILE}", where the change is made in program.ts as you left it.)`;

  // The agent is asked once, at work in the copy — by the model the project is made with, where it says one.
  const reply = await agent.instruct(ask, {
    system, workspace: true,
    ...(meta.provider && meta.model && { model: `${meta.provider}/${meta.model}` }),
  });

  // Its answer is the program — out of its fences, where it came in some — or says that there is none; or that
  // the program is in program.ts, which is then read as it was left.
  if (reply.trimStart().startsWith(NO_PROGRAM)) {
    await ctx.done({ unwritable: reply.trimStart().slice(NO_PROGRAM.length).trim() });
  } else if (reply.trimStart().startsWith(IN_THE_FILE)) {
    let left: string | undefined;
    try { left = await workspace.read("program.ts"); } catch { /* (None is there.) */ }
    if (left === undefined || left.trim() === "") throw new Error("The model said that the program is in program.ts, and there is none there.");
    // (An update is another program in the place of the one there was: a file that is as it was is none.)
    if (left === program) throw new Error("The model said that the change is made in program.ts, and that file is as it was.");
    await ctx.done({ program: left });
  } else {
    const written = stripCodeFences(reply);
    if (written === "") throw new Error("The model answered with no program.");
    await ctx.done({ program: written });
  }
}
