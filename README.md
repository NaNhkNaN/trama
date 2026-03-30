# trama

> Agents don't need frameworks. They need a runtime.

---

## What is trama?

trama is an agentic runtime — the execution layer where agent-authored programs come to life.

You describe what you want. trama generates a complete program — with control flow, LLM calls, tool use, and state management — then executes it, monitors it, and repairs it when things break. The program is real code: readable, diffable, shareable, and editable. When requirements change, trama rewrites the program itself.

```
"research competitors and produce a pricing comparison"
            |
        program.ts        <- a complete agent program.
            |              real TypeScript — read it, diff it, edit it.
        trama run          <- the runtime executes, monitors, and auto-repairs.
            |
        trama update       <- natural language rewrites the program itself.
```

This is different from other approaches:

- **LangGraph, CrewAI, Temporal** — you write the orchestration, the agent fills in blanks. The human is the bottleneck, and you're locked into a framework.
- **ReAct loops, tool-calling chains** — the agent improvises every step. Flexible, but no stable artifact. Nothing to inspect, share, or iterate on.
- **Cursor, Claude Code, Codex** — the agent writes code, but you orchestrate the agent. The intent → execution loop is manual.
- **trama** — the agent writes *the orchestration itself*, and the runtime executes it end-to-end. The output is a complete, runnable program that anyone can clone and run. No framework to learn. No prompts to optimize. Just code with a runtime.

---

## See it in action

### One-shot pipeline

A single sentence becomes a complete agent program:

```bash
trama create hn-digest "fetch the Hacker News API (https://hacker-news.firebaseio.com/v0), \
  get the top 10 stories with their titles and scores, \
  and write a formatted digest to digest.md"
trama run hn-digest
```

### Autonomous optimization

The agent writes its own eval-and-improve loop. trama has no built-in optimization framework — the generated program *is* the framework:

```bash
trama create sort-optimizer "read sort.ts, benchmark it with 'node bench.mjs sort.ts', \
  propose improvements via LLM, benchmark each candidate, keep only improvements, \
  repeat until runtime is under 10ms"
trama run sort-optimizer
trama logs sort-optimizer   # watch the optimization iterations
```

This is the [autoresearch](https://github.com/karpathy/autoresearch) pattern — propose, eval, keep-or-discard, repeat — but trama writes the loop for you.

### Self-orchestration — trama composes trama

A trama program can create and run other trama programs. The parent program decomposes a complex task, spawns sub-programs for each part, and synthesizes the results:

```bash
trama create research-lead "given a research topic in ctx.input.args.topic, \
  use the LLM to break it into 3-5 sub-questions, \
  for each sub-question create a trama sub-program that researches it independently, \
  run each sub-program, read their outputs, \
  and synthesize everything into a final report at report.md"
trama run research-lead --arg topic="impact of LLMs on software engineering productivity"
trama logs research-lead
```

No orchestration framework needed. The generated program calls `trama create` and `trama run` through `tools.shell()` — trama programs are the unit of composition, and trama itself is the scheduler.

### Long-running service with live rewrite

```bash
trama create dashboard "host a web dashboard at localhost:3000 that shows the current time, \
  refreshing every second"
trama run dashboard       # open http://localhost:3000

trama update dashboard "add a dark mode toggle"
trama run dashboard       # same app, new feature — the program was rewritten
```

### Persistent state across runs

Programs can remember state between executions via `ctx.checkpoint()`:

```bash
trama create counter "print a number starting at 1, increment it each run, \
  and persist using ctx.state and ctx.checkpoint()"
trama run counter         # prints 1
trama run counter         # prints 2
trama run counter         # prints 3
```

---

## Why trama matters

The insight behind trama: **orchestration is the agent's job, not yours.**

Most agent frameworks ask you to define the workflow and let the agent fill in the gaps. This gets the division of labor backwards. Agents are good at writing code. Humans are good at stating intent and judging results. trama aligns these strengths:

1. **You say what you want.** Natural language, one sentence.
2. **The agent writes the orchestration.** A complete program with explicit control flow — not a black-box chain.
3. **The runtime handles everything else.** Execution, state persistence, logging, auto-repair, version history.
4. **You read, run, and iterate.** The program is yours to inspect, edit, share, and version-control.

This creates a new kind of artifact: **agent code** — programs written by agents, executed by a runtime, that humans can read and share.

- **The control flow is always visible.** Open program.ts and you see exactly what will happen — every loop, branch, LLM call, and side effect. No framework internals to reverse-engineer.
- **No framework lock-in.** The orchestration is TypeScript. If you outgrow trama, take your program.ts and run it however you want.
- **No prompt engineering.** You don't optimize a prompt to get the right behavior from a framework. You read the generated code, and if it's wrong, you tell the agent what to fix — or fix it yourself.

---

## Why a runtime

trama could have stopped at code generation. But generated code without an execution layer is just text.

The runtime is what makes agent programs **self-contained and shareable**:

- **Execution** — spawns programs as child processes with streaming stdout/stderr, manages timeouts, and handles cleanup of background processes.
- **IPC bridge** — programs communicate with the runtime through a local HTTP server. LLM calls, file I/O, and shell commands all go through this bridge, which means the runtime can monitor, log, and control every operation.
- **State persistence** — `ctx.state` survives across runs via `checkpoint()` and `done()`. Programs can be long-running, interruptible, and resumable.
- **Auto-repair** — when a program crashes, the runtime sends the error back to the LLM, gets a fix, validates it in an isolated temp directory, then applies it to the real project with snapshot protection. Up to 3 attempts.
- **Version history** — every create, update, and repair saves a snapshot. You can diff any two versions to see how the program evolved.
- **Scaffolding** — on first run, the runtime creates package.json, module symlinks, gitignore, and log directories. Recipients of a shared program don't need to set anything up.

This is what separates trama from "give an LLM a prompt and run the output." The runtime is the contract between the generated program and the world — and it's what makes `git clone && trama run` work.

---

## Sharing and what programs look like

You don't share prompts — you share code. A trama program is a plain directory:

```
my-optimizer/
+-- program.ts          # the trama-generated program
+-- meta.json           # the original prompt + metadata
+-- eval.mjs            # companion eval script
+-- data/               # input data
```

```bash
# You built an optimizer. Share it:
cd ~/.trama/projects/my-optimizer && git init && git push

# Your teammate runs it — no setup, no prompt engineering:
git clone https://github.com/you/my-optimizer ~/.trama/projects/my-optimizer
trama run my-optimizer
```

Prompts generate different code each time. A trama program is deterministic — same control flow, every run. Recipients can read exactly what it does before running it, and rewrite it with `trama update`.

Here's what program.ts actually looks like:

**Simple — one-shot task:**

```typescript
import { ctx, agent, tools } from "@trama-dev/runtime";

const data = await tools.read("input.csv");
const report = await agent.ask(`Analyze this data and write a report:\n${data}`);
await tools.write("report.md", report);
await ctx.done({ summaryLength: report.length });
```

**Iterative — eval loop with convergence:**

```typescript
import { ctx, agent, tools } from "@trama-dev/runtime";

const brief = await tools.read("brief.md");
let copy = await agent.ask(`Write SEO-optimized landing page copy based on this brief:\n${brief}`);

for (let i = 0; i < ctx.maxIterations; i++) {
  const result = await tools.shell(`node eval-seo.mjs`);
  const score = parseFloat(result.stdout.trim());

  await ctx.log("evaluated", { iteration: i, score });
  if (score >= 0.9) break;

  copy = await agent.ask(
    `This copy scored ${score} on SEO eval. Improve it.\n\nBrief:\n${brief}\n\nCurrent copy:\n${copy}`
  );

  await tools.write("copy.md", copy);
  ctx.state = { copy, lastScore: score };
  await ctx.checkpoint();
}

await tools.write("final-copy.md", copy);
await ctx.done();
```

**Autonomous — [autoresearch](https://github.com/karpathy/autoresearch) pattern:**

Propose one change, eval against a single metric, keep or discard, repeat. The agent writes this loop — it's not a framework feature.

```typescript
import { ctx, agent, tools } from "@trama-dev/runtime";

let code = (ctx.state.code as string | undefined) ?? await tools.read("target.ts");
let best = (ctx.state.bestMetric as number | undefined) ?? Infinity;

for (let i = ctx.iteration; i < ctx.maxIterations; i++) {
  const proposal = await agent.generate<{ reasoning: string; newCode: string }>({
    prompt: `Propose one improvement to this code:\n${code}`,
    schema: { reasoning: "string", newCode: "string" },
  });

  await tools.write("candidate.ts", proposal.newCode);
  const result = await tools.shell("node benchmark.mjs candidate.ts");

  if (result.exitCode === 0) {
    const metric = parseFloat(result.stdout.trim());
    if (metric < best) {
      code = proposal.newCode;
      best = metric;
      ctx.state = { code, bestMetric: best };
      await ctx.checkpoint();
      await ctx.log("improved", { metric, reasoning: proposal.reasoning });
    }
  }
}

await tools.write("target.ts", code);
await ctx.done({ finalMetric: best });
```

**Self-orchestration — trama composes trama:**

A trama program that decomposes a task, creates sub-programs, runs them, and synthesizes the results. This is the compose pattern — trama programs orchestrating other trama programs.

```typescript
import { ctx, agent, tools } from "@trama-dev/runtime";

const topic = ctx.input.args.topic as string;

const plan = await agent.generate<{ questions: string }>({
  prompt: `Break this research topic into 3-5 independent sub-questions:\n${topic}`,
  schema: { questions: "string: newline-separated list of questions" },
});

const questions = plan.questions.split("\n").filter(q => q.trim());
const findings: string[] = [];

for (const [i, question] of questions.entries()) {
  const name = `research-${Date.now()}-${i}`;

  await tools.shell(
    `trama create ${name} "research this question and write findings to findings.md: ${question}"`,
    { timeout: 120000 },
  );
  await tools.shell(`trama run ${name}`, { timeout: 300000 });

  const result = await tools.shell(`cat ~/.trama/projects/${name}/findings.md`);
  findings.push(`## ${question}\n${result.stdout}`);
  await ctx.log("sub-research complete", { question, name });
}

const report = await agent.ask(
  `Synthesize these research findings into a cohesive report:\n\n${findings.join("\n\n")}`,
);

await tools.write("report.md", report);
await ctx.done({ subPrograms: questions.length });
```

---

## Agent code as a medium

trama generates TypeScript, but the goal is not to give TypeScript the ability to call agents. It's the reverse: **give agents the ability to express their work as code.**

Code is the most precise, auditable, and shareable way to describe a multi-step workflow. By having the agent produce real code:

- **The agent leverages the entire TS/npm ecosystem** — HTTP clients, parsers, databases, testing tools — without trama needing to wrap each one as a "tool". The agent chooses the implementation; the runtime just runs it.
- **The orchestration is not locked inside a framework.** program.ts is valid TypeScript. The runtime is minimal scaffolding, not a walled garden.

Pulumi and CDK proved that real code beats DSLs and YAML for infrastructure. trama takes the same position for agent orchestration — and goes one step further: the code itself is written by the agent.

---

## Getting started

### Prerequisites

trama uses [pi](https://github.com/badlogic/pi-mono) for LLM calls. Set an API key for any supported provider:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."   # default provider + model: anthropic / claude-opus-4-6
```

Other providers (OpenAI, Google, Bedrock, Azure) work via `~/.trama/config.json`:

```json
{ "provider": "openai", "model": "gpt-5.4" }
```

Or override per-project: `trama create my-task "do something" --model claude-opus-4-6`

See all config options and supported providers in [pi-ai docs](https://www.npmjs.com/package/@mariozechner/pi-ai).

### Install and run

```bash
npm install -g @trama-dev/cli

trama create scraper "fetch the Hacker News front page, extract all story titles and URLs, \
  and write them to stories.json"
trama run scraper
trama update scraper "also include the comment count for each story"
trama list
trama logs scraper
```

Five commands. `create` turns intent into code, `run` executes it, `update` rewrites it. `list` and `logs` for visibility. Projects are stored at `~/.trama/projects/{name}/`.

### CLI reference

```bash
trama create <name> <prompt> [--model <model>] [--arg key=value ...]
trama run <name> [--timeout <ms>] [--arg key=value ...]
trama update <name> <prompt>
trama list
trama logs <name>
```

- `--model` — override the LLM model for program generation (create only).
- `--timeout` — per-phase timeout in milliseconds. Applies to each run and repair attempt separately. Default: `300000` (5 minutes).
- `--arg` — pass key-value arguments to the program, accessible via `ctx.input.args`. Repeatable.

```bash
# Example: pass arguments that the program can read via ctx.input.args
trama create summarizer "summarize the file given by ctx.input.args.file" --arg file=report.csv
trama run summarizer --arg file=another-report.csv
```

---

## The runtime API

Every generated program imports three objects: `ctx`, `agent`, and `tools`.

```typescript
import { ctx, agent, tools } from "@trama-dev/runtime";
```

### ctx — lifecycle and state

```typescript
ctx.input             // { prompt: string, args: Record<string, unknown> }
ctx.state             // persistent JSON state (local working copy)
ctx.iteration         // progress counter (advances only on checkpoint/done)
ctx.maxIterations     // hint for loop bounds (not enforced by runtime)
await ctx.log(msg)    // structured log entry (appears in `trama logs`)
await ctx.ready(data?)// signal startup complete for long-running programs, idempotent
await ctx.checkpoint()// persist ctx.state to disk, advance iteration
await ctx.done(result?)// signal completion — persists state, logs result, idempotent
```

**State constraints:** `ctx.state` must be strictly JSON-serializable. No `Date`, `Map`, `Set`, circular references, `NaN`, or `Infinity`. `checkpoint()` will throw with a path to the offending value if validation fails. Keys starting with `__trama_` are reserved for internal use.

### agent — LLM calls

```typescript
await agent.ask(prompt, { system? })          // text in -> text out
await agent.generate<T>({ prompt, schema })   // text in -> typed JSON out
```

`agent.ask()` is **not** a simple text completion. The underlying pi-coding-agent runs a full agent loop and may autonomously use its built-in tools (bash, file read/write/edit) to fulfill the request. What you get back is the final text response.

`agent.generate()` returns a typed object. The schema maps field names to primitive types:

```typescript
const result = await agent.generate<{ score: number; reasoning: string }>({
  prompt: "Rate this code",
  schema: {
    score: "number: 1-10 quality rating",      // "type: description" format
    reasoning: "string: explain the rating",
  },
});
// result.score is a number, result.reasoning is a string
```

Only `string`, `number`, and `boolean` are supported as schema types. The part after `:` is a description hint for the LLM (ignored during validation). Retries once on parse/validation failure.

### tools — I/O operations

```typescript
await tools.read(path)                    // -> string (file contents)
await tools.write(path, content)          // -> void
await tools.shell(command, { cwd?, timeout? }) // -> { exitCode, stdout, stderr }
await tools.fetch(url, { method?, headers?, body? })
                                          // -> { status, body, headers }
```

`read` and `write` are path-guarded to the project directory (traversal attempts throw). `shell` defaults to a 30-second timeout; pass `{ timeout: 60000 }` for longer commands. `fetch` returns the response body as a string (capped at 10MB).

Long-running programs should call `ctx.ready()` once startup completes so `create`/`update` smoke validation can treat "server is up" as success instead of waiting for process exit.

### Version history

Every `create`, `update`, and successful `repair` saves a snapshot of program.ts to `history/`:

```
history/
+-- 0001.ts             # initial version from create
+-- 0002.ts             # after first repair
+-- 0003.ts             # after trama update
+-- index.jsonl         # metadata: version, reason, timestamp, prompt/error
```

You can diff any two versions to see how the program evolved: `diff history/0001.ts history/0003.ts`.

### Project scaffolding

trama stores all projects at `~/.trama/projects/{name}/`. On first run, the runtime creates scaffolding automatically:

- `package.json` — with `"type": "module"` (required for top-level await). If one already exists and is valid JSON, trama patches in the `type` field without touching the rest.
- `node_modules/@trama-dev/runtime` — symlink to the installed runtime (recreated on every run).
- `history/` — version snapshots and metadata.
- `logs/` — structured run logs (viewable via `trama logs`).
- `.gitignore` — creates or appends exclusions for generated files.
- `state.json` — written when the program calls `ctx.checkpoint()` or `ctx.done()`.

---

## Trust and safety

trama does not sandbox generated programs. A program can do anything TypeScript can do: read/write files, run shell commands, make network requests.

**`create` and `update` execute the generated program.** After generating code, trama runs it once in a temporary directory to validate it works. If the program makes network requests, calls external APIs, or runs shell commands with side effects, those side effects happen during validation — before you ever run `trama run`. The temp directory isolates file-system changes, but external side effects (HTTP requests, database writes, deployments) cannot be rolled back.

**`agent.ask()` gives the LLM autonomous tool access.** When your program calls `agent.ask()`, the underlying pi-coding-agent may autonomously read files, write files, and run shell commands to fulfill the request. This is not a simple text-in/text-out call — the LLM can take multi-step actions within the project directory.

This is a deliberate design choice. trama is a power tool, not a managed service. If you need execution constraints, apply them below trama: containers, VM isolation, or pi's tool-level configuration. The only built-in guard is a path traversal check on `tools.read()` and `tools.write()` — a footgun guard, not a security boundary.

---

## Design principles

**1. The kernel does less, so the program can do more.**
trama's runtime is ~1000 lines of TypeScript. It loads, executes, and repairs programs. Everything else — loops, strategies, optimization logic, self-improvement — lives in the generated program.

**2. Orchestration is code, not configuration.**
There is no YAML, no JSON graph, no visual builder. The orchestration is a `.ts` file that you can read, diff, and `git log`.

**3. The only built-in intelligence is repair.**
If a program crashes, the runtime sends the error back to the LLM, gets a fix, validates it in isolation, then applies it with snapshot protection. Up to 3 attempts. This is the only "smart" behavior in the kernel.

**4. Adapt trama to your workflow, not the other way around.**
No plugin system, no middleware, no hooks. Extend trama by editing program.ts or composing trama programs together.

---

## Relationship to pi

trama uses [pi](https://github.com/badlogic/pi-mono) as its intelligence substrate. All LLM calls go through [`@mariozechner/pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) — trama does not implement its own agent loop, tool calling, or provider abstraction. When `agent.ask()` runs, pi handles the full agent loop (bash, file I/O, multi-step reasoning). trama benefits from pi's evolution automatically.

---

## Status

Early development. Five commands, three runtime objects, ~1000 lines of kernel. The foundation is stable — what comes next is shaped by what people build with it.
