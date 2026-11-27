// A harness for work on a codebase — and a program itself.
//
// The project it is in is the codebase: the model reads, edits and runs
// things there by the tools below, until it says it is done. What it is to
// do is the run's argument `task` (trama run <project> --arg task="…"), or
// else the project's own prompt.
//
// Or the codebase is somewhere else, and the harness a project of its own:
// where its run has a workspace (`workspaceDir`), the work is done there.
// Then one harness does many pieces of work, each run is a run of *it* — on
// its record, of one of its versions — and it can be held against another
// version of itself (see examples/improve-by-check).
//
// Everything that makes it a harness is in this file, to be read and changed:
// what the model is told, the tools it has (and how long a command of its
// may take), how often it is asked again, what is made of a reply that
// failed or was cut off — and what is forgotten, and what summed up, when the
// conversation grows long. Each request to the model, and each thing a tool does, goes through
// the runtime: the run's journal has all of it, one line after the other,
// and its budget counts it.
import { ctx, agent, tools, workspace, heldTo } from "@trama-dev/runtime";
import type { AgentTool, ModelMessage, ShellResult, ToolCallPart } from "@trama-dev/runtime";

/** Where the codebase is, and what is done to it: read, written, and commands run in it. */
interface Codebase {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<unknown>;
  shell(command: string, options?: { timeout?: number }): Promise<ShellResult>;
}
// The run's workspace, where it has one; else the project this is the program of. (A run that has none is told so
// when it asks for it — and only that is taken for having none.)
const codebase: Codebase = await workspace.shell("true").then(() => workspace, (err: unknown) => {
  if (/This run has no workspace/.test(String((err as Error)?.message))) return tools;
  throw err;
});

const given = ctx.input.args as { task?: string; turns?: string | number; forgetAt?: string | number; model?: string };
/** The model that does the work, where the run names one ("provider/model"): else the project's own. */
const MODEL = typeof given.model === "string" && given.model !== "" ? { model: given.model } : {};
const task = given.task ?? ctx.input.prompt;

/**
 * How often the model is asked at most; how often in a row a request that
 * failed is made again; how much of what a tool said the model is handed;
 * and how many tokens a request may come to read before the conversation is
 * made shorter (see `shorten`).
 */
const TURNS = Number(given.turns ?? 200), TRIES = 4, MOST = 16_000, FORGET_AT = Number(given.forgetAt ?? 120_000);

const system = `You work on the codebase in the current directory, with the tools you are given, until the task is done.

Look before you change anything: read what matters, run what tells you something. Make changes with edit where a file is long — it replaces one passage and leaves the rest — and with write where a file is new or short. Check your work by running it. When the task is done, call finish and say in a few words what you did. That ends your work.

What tools said long ago is cut short as the conversation grows, and marked so; and where it outgrows that too, what came before its latest steps is summed up. Either way you are told which of the codebase's files are by then not as they were when you began: go by that, and not by memory, for what you have changed.`;

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
 *
 * What the codebase's .gitignore leaves out is left out of it: what is
 * built, fetched or logged is no part of the work, and would be most of a
 * record of it. (Asked of git, by an empty repository made beside the work
 * for the asking — so the codebase need be none itself, and may have others
 * within it. Where git is not to be had, nothing is left out.)
 */
const LEFT_OUT = `g=$(mktemp -d) && git init -q --bare "$g" >/dev/null 2>&1 && ${FILES} -print0 | git --git-dir="$g" --work-tree=. check-ignore --no-index -z --stdin 2>/dev/null | tr '\\0' '\\n'; rm -rf "$g"`;
async function sums(): Promise<Map<string, string>> {
  const { stdout } = await codebase.shell(`${FILES} -exec cksum {} +`, { timeout: 300_000 });
  const leftOut = new Set((await codebase.shell(LEFT_OUT, { timeout: 300_000 })).stdout.split("\n"));
  return new Map(stdout.split("\n").filter(Boolean).map((line): [string, string] => {
    const [sum, size, ...path] = line.split(" ");
    return [path.join(" "), `${sum} ${size}`];
  }).filter(([path]) => !leftOut.has(path)).map(([path, sum]) => [path.replace(/^\.\//, ""), sum]));
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
    run: async () => (await codebase.shell(`${FILES} | sed 's|^\\./||' | sort`)).stdout || "(none)",
  },
  {
    name: "read", description: "Read a file, whole.",
    parameters: { path: "string: relative to the codebase" },
    run: ({ path }) => codebase.read(path),
  },
  {
    name: "read_lines", description: "Read some lines of a file, with their numbers: for a file too long to read whole.",
    parameters: { path: "string: relative to the codebase", from: "number: the first line, counted from 1", to: "number: the last line" },
    run: async ({ path, from, to }) => (await codebase.read(path)).split("\n").slice(from - 1, to).map((line, at) => `${from + at}\t${line}`).join("\n"),
  },
  {
    name: "write", description: "Write a file: the whole of it. For a new file, or a short one.",
    parameters: { path: "string: relative to the codebase", content: "string" },
    run: async ({ path, content }) => { await codebase.write(path, content); return "written"; },
  },
  {
    name: "edit", description: "Replace one passage of a file by another. The passage is to be in the file exactly once, as it is written there.",
    parameters: { path: "string: relative to the codebase", find: "string: the passage as the file has it", replace: "string: what is to stand in its place" },
    run: async ({ path, find, replace }) => {
      const text = await codebase.read(path), times = find === "" ? 0 : text.split(find).length - 1;
      if (times !== 1) throw new Error(times === 0 ? "The passage is not in the file as you wrote it: read the file again, and copy it exactly." : `The passage is in the file ${times} times: give more of what is round it, so that it is there once.`);
      await codebase.write(path, text.replace(find, () => replace));
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
      const ran = await codebase.shell(command, { timeout: seconds * 1000 });
      // (A command stopped at its time says so of itself; the runtime ends what it wrote to stderr with the word, which is taken off.)
      if (!ran.timedOut) return shown(ran);
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
 * reads, and the first that is tried (see `shorten`).
 *
 * How much goes is a matter of size, and not of how many answers there are:
 * a dozen long ones are more than some models read. And a conversation is
 * cut well back when it is cut (to ROOM of what it may come to), not a
 * little at every turn: each cut costs the provider's cache of the
 * conversation, from the first answer it changes.
 */
const KEPT = 2, STUB = 200, ROOM = 0.6;
type Answer = Extract<ModelMessage, { role: "toolResult" }> & { content: string };
/** What has been cut short already: it is not cut again. */
const cutShort = new Set<ModelMessage>();
/** The answers that can be cut: old enough, long enough to be worth it, and not cut before. */
function forgettable(): Answer[] {
  const answers = messages.filter((message) => message.role === "toolResult");
  return answers.slice(0, Math.max(0, answers.length - KEPT))
    .filter((answer): answer is Answer => typeof answer.content === "string" && answer.content.length > STUB + 60 && !cutShort.has(answer));
}
const stubOf = (content: string) => `${content.slice(0, STUB)}\n[… forgotten: ${content.length - STUB} characters more. Ask again if it is wanted.]`;
/** Cut so many characters, and say after the latest answer cut — where the conversation is other than it was from — what has been done by now. */
async function forget(characters: number): Promise<void> {
  let latest: Answer | undefined;
  for (const answer of forgettable()) {
    if (characters <= 0) break;
    const was = answer.content.length;
    answer.content = stubOf(answer.content);
    characters -= was - answer.content.length;
    cutShort.add(answer);
    latest = answer;
  }
  if (latest) latest.content += `\n${await record()}`;
}

/**
 * The conversation summed up, where forgetting is not enough. What the model
 * itself said — every command it ran, every edit, as it wrote them — is
 * never forgotten, and in a long piece of work comes to more than may be
 * read by itself. Then the model is asked once, with no tools, for what was
 * found and done and what is left; and all but the latest of the work gives
 * way to its answer, and to the harness's record of the files.
 *
 * (Left to forgetting alone, such a conversation is over what it may be at
 * every turn, has one more answer cut at every turn — which is the
 * provider's cache of all of it lost at every turn — and leaves the model at
 * work with what its latest two tools said and nothing else whole.)
 */
const SUMMING = `You sum up the work a model has done so far on a codebase, from the record of it, for the same model to go on from. You do not go on with the work and you call no tools: you answer with the summary, and with nothing else.`;
const TO_SUM_UP = `The above is the record of the work so far. Whoever goes on with it will have the task, your summary, a list of the files that are not as they were, and the latest step or two — and nothing else of the above. Sum it up for them, under these three heads:

## Done
What was found, and what was changed: file by file, and why.

## Left to do
What remains of the task, in the order to do it — and what was being done when this was written.

## To know
What it cost effort to learn: how to build and how to run the tests, and how long that takes; what fails for reasons that are none of the task's; paths, names and messages, exactly.

Be exact and brief, and leave out what is of no use for going on.`;
/** How much of what may be read the latest of the work may be, kept as it is; and how much of one call or one answer goes into the record that is summed up. */
const LATEST = 0.25, OF_EACH = 2000;
/** What the work was summed up as, the last time it was. */
let summary: string | undefined;
const cutTo = (text: string, most: number) => (text.length > most ? `${text.slice(0, most)} [… ${text.length - most} characters more]` : text);
const wordsOf = (content: Extract<ModelMessage, { role: "user" }>["content"]) =>
  (typeof content === "string" ? content : content.map((part) => (part.type === "text" ? part.text : "[an image]")).join(""));
/** Messages as a record to be read: what was said, what was called and what came back. */
const written = (said: ModelMessage[]) => said.flatMap((message) => {
  if (message.role === "user") return [`[Told]: ${wordsOf(message.content)}`];
  if (message.role === "toolResult") return [`[${message.toolName} said${message.isError ? ", failing" : ""}]: ${cutTo(wordsOf(message.content), OF_EACH)}`];
  return message.content.flatMap((part) => (part.type === "text" && part.text.trim() ? [`[Model]: ${part.text}`]
    : part.type === "toolCall" ? [`[Model called]: ${part.name}(${cutTo(JSON.stringify(part.arguments), OF_EACH)})`] : []));
}).join("\n\n");
/** What the conversation begins with: the task — and, once the work has been summed up, that and the record of the files. */
const opening = async (): Promise<ModelMessage> => ({
  role: "user",
  content: summary === undefined ? task
    : `${task}\n\n[You have been at this task for a while, in this same run. The conversation grew too long to be carried whole, so what came before the latest of it was summed up — by you yourself, a moment ago: what follows is your own account of your own work, and no one else's notes. Go on from there.]\n\n${summary}\n\n${await record()}`,
});
/** How many tokens some messages come to, and a request that has them for its conversation: going by what the model's last request came to. */
const tokens = (said: ModelMessage[]) => Math.round(JSON.stringify(said).length / perToken);
const whole = (conversation: ModelMessage[]) => Math.round((FIXED + JSON.stringify(conversation).length) / perToken);
async function sumUp(): Promise<void> {
  // The latest of the work is kept as it is: whole turns — a reply of the model's, and what was said to it —
  // from the end, as many as come to LATEST of what may be read; the last, whatever it comes to.
  const turns = messages.map((message, at) => (message.role === "assistant" ? at : -1)).filter((at) => at > 0);
  let from = turns.at(-1) ?? messages.length;
  for (const at of turns.slice(0, -1).reverse()) {
    if (tokens(messages.slice(at)) > LATEST * FORGET_AT) break;
    from = at;
  }
  const before = messages.slice(1, from), latest = messages.slice(from);
  // Where there is nothing before it, or it is too much by itself, no summing-up will do: said now, and not at every turn from here on.
  const least = whole([{ role: "user", content: task }, ...latest]);
  if (before.length === 0 || least > FORGET_AT) throw new Error(`The conversation cannot be kept within ${FORGET_AT} tokens: the task and the latest of the work alone come to some ${least}.`);
  const soFar = [`[The task]: ${task}`, ...(summary === undefined ? [] : [`[Summed up before]: ${summary}`]), written(before)].join("\n\n");
  for (let tries = 1; ; tries += 1) {
    const reply = await agent.complete({ system: SUMMING, messages: [{ role: "user", content: `${soFar}\n\n---\n\n${TO_SUM_UP}` }], ...MODEL });
    const said = reply.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("").trim();
    if (reply.stopReason !== "error" && said) { summary = said; break; }
    if (tries >= TRIES) throw new Error(`The conversation outgrew what may be read, and could not be summed up: ${reply.stopReason === "error" ? reply.errorMessage : "the model answered with nothing"}`);
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** tries));
  }
  const goesOn = [await opening(), ...latest];
  // (A summing-up that is itself too long would be made again at every turn: that is said, too.)
  if (whole(goesOn) > FORGET_AT) throw new Error(`The conversation cannot be kept within ${FORGET_AT} tokens: summed up, with the latest of the work, it still comes to some ${whole(goesOn)}.`);
  messages.splice(0, messages.length, ...goesOn);
}

/**
 * Make the conversation shorter by so many characters: by forgetting, where
 * what can be forgotten comes to that; by summing up, where it does not.
 * Nothing is forgotten that does not bring the conversation back.
 */
async function shorten(characters: number): Promise<void> {
  const can = forgettable().reduce((sum, answer) => sum + answer.content.length - stubOf(answer.content).length, 0);
  if (can >= characters) { await forget(characters); forgotten += 1; } else { await sumUp(); summed += 1; }
}

const messages: ModelMessage[] = [{ role: "user", content: task }];
// (`FIXED`: how many characters every request has beside its conversation — what the model is told to be, and its
// tools; `sent`: how many a request was in all when the model was last asked; `perToken`: how many of them a token
// of the model's came to then — four, until it has said.)
const FIXED = system.length + JSON.stringify(mine).length;
let asked = 0, failures = 0, forgotten = 0, summed = 0, sent = 0, perToken = 4;
while (finished === undefined) {
  if (asked >= TURNS) throw new Error(`The model was asked ${TURNS} times and did not say it was done.`);
  asked += 1;
  sent = FIXED + JSON.stringify(messages).length;
  const reply = await agent.complete({ system, messages, tools: mine, ...MODEL });

  // The provider failed: asked again, a little later each time — and given up on where it goes on failing.
  if (reply.stopReason === "error") {
    failures += 1;
    if (failures >= TRIES) throw new Error(`The model could not be asked, ${TRIES} times in a row: ${reply.errorMessage}`);
    // (Too long for the model, by the provider's word for it — which does not say by how much: it is made shorter by half, and asked again.)
    if (/context|too long|too large|maximum.*tokens/i.test(reply.errorMessage ?? "")) { await shorten(sent / 2); continue; }
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
  // The conversation has grown long: before the next request it is made shorter — by as much as brings what was
  // read back to ROOM of what it may be, going by the tokens that so many characters came to.
  const read = reply.usage.input + reply.usage.cacheRead + reply.usage.cacheWrite;
  if (read > 0) perToken = sent / read;
  if (finished === undefined && read > FORGET_AT) await shorten((1 - (ROOM * FORGET_AT) / read) * sent);
}

// What the model says it did — and what was done.
await ctx.done({ summary: finished, asked, forgotten, summed, files: await done() });
