// A harness that fixes programs — and is a program itself.
//
// trama asks this project for a fix where a run's program fails and the run
// (or the configuration) names it as `repairWith`. It is run with a copy of
// the failing project as its workspace, and handed:
//
//   program  the program that failed, whole
//   error    how it failed
//   journal  the path of the failed run's record: a line of JSON for each
//            call the program made, and what came back ("" where none is kept)
//   kept     whether what is changed in the copy beside the program reaches
//            the project, with a fix that then works
//   types    the API a program is written against
//
// and it answers with { program }: the whole of the fixed program — or with
// { unfixable }, why there is no fix, where the model says there is none.
//
// Everything that makes it a harness is in this file, to be read and changed:
// what the model is told, the tools it has, how often it is asked again, what
// is made of a reply that failed or was cut off. Each request to the model,
// and each thing a tool does, goes through the runtime — so the run's journal
// has all of it, one line after the other, and its budget counts it.
import { ctx, agent, workspace, heldTo } from "@trama-dev/runtime";
import type { AgentTool, ModelMessage, ToolCallPart } from "@trama-dev/runtime";

const { program, error, journal, kept, types } = ctx.input.args as {
  program: string; error: string; journal: string; kept: boolean; types: string;
};

/** How often the model is asked at most; how often in a row a request that failed is made again; how much of what a tool said the model is handed. */
const TURNS = 40, TRIES = 4, MOST = 20_000;

const system = `You fix a TypeScript program so that it runs.

You are at work in a copy of the program's project, where the program is program.ts. Look before you change anything: read what the program reads, run what tells you something. ${kept
    ? "If what is wrong is in the project and not in the program — a package that is not installed, a file the program needs that is missing or wrong — put it right in the copy: what you change there is kept, with the program you hand over, if that program then runs."
    : "Nothing you change in the copy is kept: the program you hand over is all that is taken from you."}

When you are done, call hand_over with the whole of the fixed program. That ends your work.

If the program cannot be made to run without having it say what is not so, or leave out what it is there to do — a check taken out, a failure handed back as if it were a result — then there is no fix: do not hand over such a program. Call give_up, and say why.

The program is written against this API:

${types}`;

type Tool = Pick<AgentTool, "name" | "description" | "parameters"> & { run(given: any): unknown };

let fixed: string | undefined, unfixable: string | undefined;
/** The longest a command may be given, in seconds; and how the runtime ends the stderr of one it stopped at its time. */
const LONGEST = 600, TIMED_OUT = "\ntimeout";
const shown = (ran: { exitCode: number; stdout: string; stderr: string }) =>
  `exit code ${ran.exitCode}\n${ran.stdout}${ran.stderr ? `\n[stderr]\n${ran.stderr}` : ""}`;

const tools: Tool[] = [
  {
    name: "list", description: "List the project's files whose paths match a glob pattern: \"**\" for all of them.",
    parameters: { pattern: "string" },
    run: async ({ pattern }) => (await workspace.list(pattern)).join("\n") || "(no file matches)",
  },
  {
    name: "read", description: "Read a file of the project.",
    parameters: { path: "string: relative to the project" },
    run: ({ path }) => workspace.read(path),
  },
  {
    name: "write", description: "Write a file of the project: the whole of it. (Not program.ts — hand that over.)",
    parameters: { path: "string: relative to the project", content: "string" },
    run: async ({ path, content }) => { await workspace.write(path, content); return "written"; },
  },
  {
    // A command has the time the model gives it. (With a time the model is not told of, a command that ran into it
    // was only a command that failed, and was made again as it was.)
    name: "shell",
    description: `Run a shell command in the project's directory, and see what it printed. It has the seconds you give it, and is stopped when they are up: give it what it needs and some to spare, ${LONGEST} at most. What takes longer than that, start in the background, writing to a file (… > out.log 2>&1 &), and look in on it.`,
    parameters: { command: "string", seconds: "number: how long it may take before it is stopped" },
    run: async ({ command, seconds }) => {
      if (!(seconds >= 1 && seconds <= LONGEST)) throw new Error(`seconds is to be from 1 to ${LONGEST}: how long the command may take.`);
      const ran = await workspace.shell(command, { timeout: seconds * 1000 });
      // (A command stopped at its time says so of itself; the runtime ends what it wrote to stderr with the word, which is taken off.)
      if (!ran.timedOut) return shown(ran);
      const stderr = ran.stderr.slice(0, -TIMED_OUT.length);
      return `It was stopped: it was not done after the ${seconds}s it was given. Give it longer (${LONGEST}s at most), run less at a time, or start it in the background and look in on it. What it had printed:\n${ran.stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`;
    },
  },
  ...(journal ? [{
    name: "record", description: "Read the end of the failed run's record: each call the program made and what came back, a line of JSON for each.",
    run: async () => (await workspace.shell(`tail -c 30000 ${JSON.stringify(journal)}`)).stdout,
  }] : []),
  {
    name: "hand_over", description: "Hand over the fixed program: the whole text of program.ts. This ends your work.",
    parameters: { program: "string" },
    run: ({ program }) => { fixed = program; return "taken"; },
  },
  {
    name: "give_up", description: "Say that there is no fix, and why: for a program that cannot be made to run and still be the program it was. This ends your work.",
    parameters: { why: "string" },
    run: ({ why }) => { unfixable = why; return "noted"; },
  },
];

/** A tool, run as the model called it: what it said — or how it failed, which the model reads as well, and may mend. */
async function use(call: ToolCallPart): Promise<{ said: string; failed: boolean }> {
  try {
    const tool = tools.find((one) => one.name === call.name);
    if (!tool) throw new Error(`There is no tool "${call.name}". The tools: ${tools.map((one) => one.name).join(", ")}.`);
    if (call.argumentsError) throw new Error(`What ${call.name} was called with is not JSON: ${call.argumentsError}`);
    const said = String(await tool.run(heldTo(tool.parameters, call.arguments)));
    return { said: said.length > MOST ? `${said.slice(0, MOST)}\n[… and ${said.length - MOST} characters more]` : said, failed: false };
  } catch (err) {
    return { said: err instanceof Error ? err.message : String(err), failed: true };
  }
}

const messages: ModelMessage[] = [{ role: "user", content: `The program, program.ts:\n\n${program}\n\nHow it failed:\n\n${error}` }];
let asked = 0, failures = 0;
while (fixed === undefined && unfixable === undefined) {
  if (asked >= TURNS) await ctx.fail(`The model was asked ${TURNS} times and handed no program over.`);
  asked += 1;
  const reply = await agent.complete({ system, messages, tools });

  // The provider failed: asked again, a little later each time — and given up on where it goes on failing.
  if (reply.stopReason === "error") {
    failures += 1;
    if (failures >= TRIES) await ctx.fail(`The model could not be asked, ${TRIES} times in a row: ${reply.errorMessage}`);
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** failures));
    continue;
  }
  failures = 0;
  messages.push(reply);

  const calls = reply.content.filter((part): part is ToolCallPart => part.type === "toolCall");
  if (calls.length === 0) {
    messages.push({ role: "user", content: reply.stopReason === "length"
      ? "Your reply was cut off at its limit. Go on, in smaller steps."
      : "Work with the tools; when the program is fixed, hand it over with hand_over." });
    continue;
  }
  for (const call of calls) {
    // (A reply cut off at its limit may have ended in the middle of a call: none of its calls is run.)
    const { said, failed } = reply.stopReason === "length"
      ? { said: "Your reply was cut off at its limit before this call was whole: it was not run. Make it again — in smaller pieces, if it was long.", failed: true }
      : await use(call);
    messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: said, isError: failed });
  }
}

await ctx.done(fixed !== undefined ? { program: fixed, asked } : { unfixable, asked });
