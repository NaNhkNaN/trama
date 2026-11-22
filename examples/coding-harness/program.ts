// A harness for work on a codebase — and a program itself.
//
// The project it is in is the codebase: the model reads, edits and runs
// things there by the tools below, until it says it is done. What it is to
// do is the run's argument `task` (trama run <project> --arg task="…"), or
// else the project's own prompt.
//
// Everything that makes it a harness is in this file, to be read and changed:
// what the model is told, the tools it has, how often it is asked again, what
// is made of a reply that failed or was cut off — and what is forgotten when
// the conversation grows long. Each request to the model, and each thing a
// tool does, goes through the runtime: the run's journal has all of it, one
// line after the other, and its budget counts it.
import { ctx, agent, tools, heldTo } from "@trama-dev/runtime";
import type { AgentTool, ModelMessage, ToolCallPart } from "@trama-dev/runtime";

const given = ctx.input.args as { task?: string; turns?: string | number; forgetAt?: string | number };
const task = given.task ?? ctx.input.prompt;

/**
 * How often the model is asked at most; how often in a row a request that
 * failed is made again; how much of what a tool said the model is handed;
 * and how much a request may come to read before what old tools said is
 * forgotten (see `forget`).
 */
const TURNS = Number(given.turns ?? 200), TRIES = 4, MOST = 16_000, FORGET_AT = Number(given.forgetAt ?? 120_000);

const system = `You work on the codebase in the current directory, with the tools you are given, until the task is done.

Look before you change anything: read what matters, run what tells you something. Make changes with edit where a file is long — it replaces one passage and leaves the rest — and with write where a file is new or short. Check your work by running it. When the task is done, call finish and say in a few words what you did. That ends your work.`;

type Tool = Pick<AgentTool, "name" | "description" | "parameters"> & { run(given: any): unknown };

let finished: string | undefined;
const shown = (ran: { exitCode: number; stdout: string; stderr: string }) =>
  `exit code ${ran.exitCode}\n${ran.stdout}${ran.stderr ? `\n[stderr]\n${ran.stderr}` : ""}`;

const mine: Tool[] = [
  {
    name: "files", description: "List the codebase's files (not what is in a node_modules or a .git, wherever it is, nor the run's own logs and history).",
    run: async () => (await tools.shell("find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path './logs/*' -not -path './history/*' -not -name state.json | sed 's|^\\./||' | sort")).stdout || "(none)",
  },
  {
    name: "read", description: "Read a file, whole.",
    parameters: { path: "string: relative to the codebase" },
    run: ({ path }) => tools.read(path),
  },
  {
    name: "read_lines", description: "Read some lines of a file, with their numbers: for a file too long to read whole.",
    parameters: { path: "string: relative to the codebase", from: "number: the first line, counted from 1", to: "number: the last line" },
    run: async ({ path, from, to }) => (await tools.read(path)).split("\n").slice(from - 1, to).map((line, at) => `${from + at}\t${line}`).join("\n"),
  },
  {
    name: "write", description: "Write a file: the whole of it. For a new file, or a short one.",
    parameters: { path: "string: relative to the codebase", content: "string" },
    run: async ({ path, content }) => { await tools.write(path, content); return "written"; },
  },
  {
    name: "edit", description: "Replace one passage of a file by another. The passage is to be in the file exactly once, as it is written there.",
    parameters: { path: "string: relative to the codebase", find: "string: the passage as the file has it", replace: "string: what is to stand in its place" },
    run: async ({ path, find, replace }) => {
      const text = await tools.read(path), times = find === "" ? 0 : text.split(find).length - 1;
      if (times !== 1) throw new Error(times === 0 ? "The passage is not in the file as you wrote it: read the file again, and copy it exactly." : `The passage is in the file ${times} times: give more of what is round it, so that it is there once.`);
      await tools.write(path, text.replace(find, () => replace));
      return "edited";
    },
  },
  {
    name: "shell", description: "Run a shell command in the codebase's directory, and see what it printed.",
    parameters: { command: "string" },
    run: async ({ command }) => shown(await tools.shell(command, { timeout: 300_000 })),
  },
  {
    name: "finish", description: "Say that the task is done, and in a few words what was done. This ends your work.",
    parameters: { summary: "string" },
    run: ({ summary }) => { finished = summary; return "noted"; },
  },
];

/** A tool, run as the model called it: what it said — or how it failed, which the model reads as well, and may mend. */
async function use(call: ToolCallPart): Promise<{ said: string; failed: boolean }> {
  try {
    const tool = mine.find((one) => one.name === call.name);
    if (!tool) throw new Error(`There is no tool "${call.name}". The tools: ${mine.map((one) => one.name).join(", ")}.`);
    if (call.argumentsError) throw new Error(`What ${call.name} was called with is not JSON: ${call.argumentsError}`);
    const said = String(await tool.run(heldTo(tool.parameters, call.arguments)));
    return { said: said.length > MOST ? `${said.slice(0, MOST)}\n[… and ${said.length - MOST} characters more: ask for less at a time]` : said, failed: false };
  } catch (err) {
    return { said: err instanceof Error ? err.message : String(err), failed: true };
  }
}

/**
 * What old tools said, forgotten: all but the latest few of their answers
 * are cut to their beginnings. Nothing is asked of a model for it, and what
 * the model itself said is left as it was. (It is the plainest way there is
 * to keep a long conversation within what a model reads — and it costs the
 * provider's cache of the conversation, once, from the first answer it cuts.)
 */
const KEPT = 12, STUB = 200;
function forget(messages: ModelMessage[]): number {
  const answers = messages.filter((message) => message.role === "toolResult");
  let cut = 0;
  for (const answer of answers.slice(0, -KEPT)) {
    if (answer.role !== "toolResult" || typeof answer.content !== "string" || answer.content.length <= STUB + 60) continue;
    answer.content = `${answer.content.slice(0, STUB)}\n[… forgotten: ${answer.content.length - STUB} characters more. Ask again if it is wanted.]`;
    cut += 1;
  }
  return cut;
}

const messages: ModelMessage[] = [{ role: "user", content: task }];
let asked = 0, failures = 0, forgotten = 0;
while (finished === undefined) {
  if (asked >= TURNS) throw new Error(`The model was asked ${TURNS} times and did not say it was done.`);
  asked += 1;
  const reply = await agent.complete({ system, messages, tools: mine });

  // The provider failed: asked again, a little later each time — and given up on where it goes on failing.
  if (reply.stopReason === "error") {
    failures += 1;
    // (Too long for the model, by the provider's word for it: what can be forgotten is, and it is asked again.)
    if (/context|too long|too large|maximum.*tokens/i.test(reply.errorMessage ?? "") && forget(messages) > 0) { forgotten += 1; continue; }
    if (failures >= TRIES) throw new Error(`The model could not be asked, ${TRIES} times in a row: ${reply.errorMessage}`);
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** failures));
    continue;
  }
  failures = 0;
  messages.push(reply);

  const calls = reply.content.filter((part): part is ToolCallPart => part.type === "toolCall");
  if (calls.length === 0) {
    messages.push({ role: "user", content: reply.stopReason === "length"
      ? "Your reply was cut off at its limit. Go on, in smaller steps."
      : "Work with the tools; when the task is done, call finish." });
    continue;
  }
  for (const call of calls) {
    // (A reply cut off at its limit may have ended in the middle of a call: none of its calls is run.)
    const { said, failed } = reply.stopReason === "length"
      ? { said: "Your reply was cut off at its limit before this call was whole: it was not run. Make it again — in smaller pieces, if it was long.", failed: true }
      : await use(call);
    messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: said, isError: failed });
  }
  // The conversation has grown long: before the next request, what old tools said is forgotten.
  if (reply.usage.input + reply.usage.cacheRead + reply.usage.cacheWrite > FORGET_AT && forget(messages) > 0) forgotten += 1;
}

await ctx.done({ summary: finished, asked, forgotten });
