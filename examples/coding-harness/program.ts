// A harness for work on a codebase — and a program itself.
//
// The project it is in is the codebase: the model reads, edits and runs
// things there by the tools below, until it says it is done. What it is to
// do is the run's argument `task` (trama run <project> --arg task="…"), or
// else the project's own prompt.
//
// Everything that makes it a harness is in this file, to be read and changed:
// what the model is told, the tools it has (and how long a command of its
// may take), how often it is asked again, what is made of a reply that
// failed or was cut off — and what is forgotten when the conversation grows
// long. Each request to the model, and each thing a tool does, goes through
// the runtime: the run's journal has all of it, one line after the other,
// and its budget counts it.
import { ctx, agent, tools, heldTo } from "@trama-dev/runtime";
import type { AgentTool, ModelMessage, ToolCallPart } from "@trama-dev/runtime";

const given = ctx.input.args as { task?: string; turns?: string | number; forgetAt?: string | number };
const task = given.task ?? ctx.input.prompt;

/**
 * How often the model is asked at most; how often in a row a request that
 * failed is made again; how much of what a tool said the model is handed;
 * and how many tokens a request may come to read before what old tools said
 * is forgotten (see `forget`).
 */
const TURNS = Number(given.turns ?? 200), TRIES = 4, MOST = 16_000, FORGET_AT = Number(given.forgetAt ?? 120_000);

const system = `You work on the codebase in the current directory, with the tools you are given, until the task is done.

Look before you change anything: read what matters, run what tells you something. Make changes with edit where a file is long — it replaces one passage and leaves the rest — and with write where a file is new or short. Check your work by running it. When the task is done, call finish and say in a few words what you did. That ends your work.

What tools said long ago is cut short as the conversation grows, and marked so. Where that is done, you are told which of the codebase's files are by then not as they were when you began: go by that, and not by memory, for what you have changed.`;

type Tool = Pick<AgentTool, "name" | "description" | "parameters"> & { run(given: any): unknown };

let finished: string | undefined;
/** The longest a command may be given, in seconds; and how the runtime ends the stderr of one it stopped at its time. */
const LONGEST = 1800, TIMED_OUT = "\ntimeout";
const shown = (ran: { exitCode: number; stdout: string; stderr: string }) =>
  `exit code ${ran.exitCode}\n${ran.stdout}${ran.stderr ? `\n[stderr]\n${ran.stderr}` : ""}`;

/** The codebase's files: not what is in a node_modules or a .git, wherever it is, nor the run's own logs, history and state. */
const FILES = "find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path './logs/*' -not -path './history/*' -not -name state.json";

/**
 * What has been done, kept by the harness and not by the model: the files
 * that are not as they were when the work began, told by a sum of what is in
 * each — so whichever tool changed them, a command of the shell's as much as
 * an edit. A model whose reading has been forgotten has nothing else to tell
 * what it read from what it changed; and whoever asked for the work has it
 * beside what the model says it did.
 */
async function sums(): Promise<Map<string, string>> {
  const { stdout } = await tools.shell(`${FILES} -exec cksum {} +`, { timeout: 300_000 });
  return new Map(stdout.split("\n").filter(Boolean).map((line) => {
    const [sum, size, ...path] = line.split(" ");
    return [path.join(" ").replace(/^\.\//, ""), `${sum} ${size}`];
  }));
}
const began = await sums();
async function done(): Promise<{ changed: string[]; made: string[]; gone: string[] }> {
  const now = await sums();
  return {
    changed: [...now].filter(([path, sum]) => began.has(path) && began.get(path) !== sum).map(([path]) => path).sort(),
    made: [...now.keys()].filter((path) => !began.has(path)).sort(),
    gone: [...began.keys()].filter((path) => !now.has(path)).sort(),
  };
}
/** The same, as the model is told it where something has been forgotten. */
async function record(): Promise<string> {
  const { changed, made, gone } = await done();
  const listed = (paths: string[]) => (paths.length > 50 ? `${paths.slice(0, 50).join(", ")}, and ${paths.length - 50} more` : paths.join(", "));
  const said = [changed.length > 0 && `changed: ${listed(changed)}`, made.length > 0 && `new: ${listed(made)}`, gone.length > 0 && `gone: ${listed(gone)}`].filter(Boolean).join("; ");
  return `[Kept by the harness, which forgets nothing — the codebase's files that are not as they were when you began: ${said || "none"}.]`;
}

const mine: Tool[] = [
  {
    name: "files", description: "List the codebase's files (not what is in a node_modules or a .git, wherever it is, nor the run's own logs and history).",
    run: async () => (await tools.shell(`${FILES} | sed 's|^\\./||' | sort`)).stdout || "(none)",
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
    // A command has the time the model gives it. (With a time the model is not told of, a command that ran into it
    // was only a command that failed, and was made again as it was.)
    name: "shell",
    description: `Run a shell command in the codebase's directory, and see what it printed. It has the seconds you give it, and is stopped when they are up: give it what it needs and some to spare, ${LONGEST} at most. What takes longer than that, start in the background, writing to a file (… > out.log 2>&1 &), and look in on it.`,
    parameters: { command: "string", seconds: "number: how long it may take before it is stopped" },
    run: async ({ command, seconds }) => {
      if (!(seconds >= 1 && seconds <= LONGEST)) throw new Error(`seconds is to be from 1 to ${LONGEST}: how long the command may take.`);
      const began = Date.now(), ran = await tools.shell(command, { timeout: seconds * 1000 });
      // (A command stopped at its time took that long, and the runtime ends what it wrote to stderr with the word.)
      if (!ran.stderr.endsWith(TIMED_OUT) || Date.now() - began < seconds * 1000) return shown(ran);
      const stderr = ran.stderr.slice(0, -TIMED_OUT.length);
      return `It was stopped: it was not done after the ${seconds}s it was given. Give it longer (${LONGEST}s at most), run less at a time, or start it in the background and look in on it. What it had printed:\n${ran.stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`;
    },
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
 * What old tools said, forgotten: their answers are cut to their beginnings,
 * the oldest first, until so many characters are gone — all but the latest
 * two, which are what the model is at work on. Nothing is asked of a model
 * for it, and what the model itself said is left as it was. It is the
 * plainest way there is to keep a long conversation within what a model
 * reads.
 *
 * How much goes is a matter of size, and not of how many answers there are:
 * a dozen long ones are more than some models read. And a conversation is
 * cut well back when it is cut (to ROOM of what it may come to), not a
 * little at every turn: each cut costs the provider's cache of the
 * conversation, from the first answer it changes.
 */
const KEPT = 2, STUB = 200, ROOM = 0.6;
/** What has been cut short already: it is not cut again. */
const cutShort = new Set<ModelMessage>();
/** Returns the latest answer it cut — where the conversation is other than it was from, and the record of what was done is put — or nothing, where there was nothing to cut. */
function forget(messages: ModelMessage[], characters: number): { content: string } | undefined {
  const answers = messages.filter((message) => message.role === "toolResult");
  let latest: { content: string } | undefined;
  for (const answer of answers.slice(0, Math.max(0, answers.length - KEPT))) {
    if (characters <= 0) break;
    if (answer.role !== "toolResult" || typeof answer.content !== "string" || answer.content.length <= STUB + 60 || cutShort.has(answer)) continue;
    const was = answer.content.length;
    answer.content = `${answer.content.slice(0, STUB)}\n[… forgotten: ${was - STUB} characters more. Ask again if it is wanted.]`;
    characters -= was - answer.content.length;
    cutShort.add(answer);
    latest = answer as { content: string };
  }
  return latest;
}
/** Forget so much, and say after the latest of what was cut what has been done by now. Returns whether anything was forgotten. */
async function forgetting(characters: number): Promise<boolean> {
  const latest = forget(messages, characters);
  if (latest) latest.content += `\n${await record()}`;
  return latest !== undefined;
}

const messages: ModelMessage[] = [{ role: "user", content: task }];
// (`sent`: how many characters the conversation was when the model was last asked — what its tokens are measured against.)
let asked = 0, failures = 0, forgotten = 0, sent = 0;
while (finished === undefined) {
  if (asked >= TURNS) throw new Error(`The model was asked ${TURNS} times and did not say it was done.`);
  asked += 1;
  sent = system.length + JSON.stringify(messages).length;
  const reply = await agent.complete({ system, messages, tools: mine });

  // The provider failed: asked again, a little later each time — and given up on where it goes on failing.
  if (reply.stopReason === "error") {
    failures += 1;
    // (Too long for the model, by the provider's word for it — which does not say by how much: half of it is forgotten, and it is asked again.)
    if (/context|too long|too large|maximum.*tokens/i.test(reply.errorMessage ?? "") && await forgetting(sent / 2)) { forgotten += 1; continue; }
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
  // The conversation has grown long: before the next request, what old tools said is forgotten — as much of it as
  // brings what was read back to ROOM of what it may be, by the tokens that so many characters came to.
  const read = reply.usage.input + reply.usage.cacheRead + reply.usage.cacheWrite;
  if (finished === undefined && read > FORGET_AT && await forgetting((1 - (ROOM * FORGET_AT) / read) * sent)) forgotten += 1;
}

// What the model says it did — and what was done.
await ctx.done({ summary: finished, asked, forgotten, files: await done() });
