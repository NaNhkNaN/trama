# trama

> Agents don't need frameworks. They need a runtime.

```bash
npm install -g @trama-dev/cli
export ANTHROPIC_API_KEY="sk-ant-..."

trama create hello "fetch the top 5 Hacker News stories and write a summary to digest.md"
trama run hello
cat ~/.trama/projects/hello/digest.md
```

---

## What is trama?

trama is a runtime for programs that contain agent behavior.

A trama program is a TypeScript file that can mix deterministic operations (read files, run commands, make HTTP requests) with autonomous agent calls (let an LLM reason, write code, take multi-step actions). The runtime handles everything around it: execution, state persistence, auto-repair, version history, structured logging. When programs need to collaborate, a shared workspace and cooperative suspension let multiple agents coordinate through artifacts — without a task graph DSL or orchestration framework.

The program can come from anywhere:

```
trama create optimizer "..."     <- the LLM writes the whole program
trama run optimizer              <- the runtime executes it

# or: you write program.ts yourself, use trama as the runtime
mkdir -p ~/.trama/projects/my-task
echo '{"input":{"prompt":"","args":{}}}' > ~/.trama/projects/my-task/meta.json
cat > ~/.trama/projects/my-task/program.ts << 'EOF'
import { ctx, agent, tools } from "@trama-dev/runtime";
await agent.instruct("Add auth to the codebase at /path/to/myproject. Write tests.");
const tests = await tools.shell("cd /path/to/myproject && npm test");
if (tests.exitCode !== 0) await agent.instruct("Tests failed, fix:\n" + tests.stderr);
await ctx.done({ testsPass: tests.exitCode === 0 });
EOF
trama run my-task                <- same runtime, same state/logging/repair
```

`trama create` is a convenient entry point — the LLM generates the entire program from a prompt. But the core of trama is the runtime, not code generation. You can hand-write the orchestration and let `agent.instruct()` deploy a full autonomous coding agent for the actual work. You can write pure automation that never calls an LLM at all. You can generate a skeleton with `trama create` and then edit it by hand. The runtime doesn't care who wrote the program.

This is different from other approaches:

- **LangGraph, CrewAI, Temporal** — you write the orchestration, the agent fills in blanks. The human is the bottleneck, and you're locked into a framework.
- **ReAct loops, tool-calling chains** — the agent improvises every step. Flexible, but no stable artifact. Nothing to inspect, share, or iterate on.
- **Cursor, Claude Code, Codex** — the agent writes code, but you orchestrate the agent. The intent → execution loop is manual.
- **trama** — the orchestration is a program. The agent can write it, you can write it, or both. The runtime executes it end-to-end — with state persistence, auto-repair, and version history. The result is a complete, runnable artifact that anyone can clone and run.

In trama, the orchestration, the program, and the runtime converge into one unit. As **program.ts**, it is an artifact with a lifecycle — born (`create`), executed (`run`), evolved (`update`), self-healed (`repair`), and shared (`git clone`). As **a runtime**, it is the infrastructure that closes this loop. The program is what you see. The runtime is what makes it live.

What trama produces is not traditional automation — where every step is predetermined — and not an agent conversation — where nothing is reproducible. It is a program that can contain arbitrarily complex agent behavior (LLM reasoning, multi-step tool use, autonomous decisions) while remaining a readable, diffable, version-tracked artifact. Your intent goes in as a sentence or as hand-written code. What comes out is something you can reproduce, hand to a teammate, and evolve over time.

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

### Multi-agent coordination

Multiple trama programs share a workspace and coordinate through artifacts. The entry program spawns participants, they write results, and everyone can observe what others produce:

```bash
trama create guardian "coordinate multiple check agents: fan out diff analysis \
  to sql-injection, xss, and auth-bypass checkers via shared workspace, \
  observe their result artifacts, and synthesize a final security report"
trama run guardian
```

No task graph. No message bus. The guardian is a TypeScript program that creates a `Session`, spawns check agents, and calls `session.workspace.observe()` to wait for their results. Each check agent is its own trama program with its own lifecycle, repair loop, and state. See [Session API](#session--multi-agent-coordination) below.

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

## The bigger picture

trama is small — six CLI commands, three packages. But the thing it enables is not small.

### No ceiling

The upper bound of what trama can do is not defined by trama. It is defined by the LLM's ability to write TypeScript.

LangGraph's ceiling is its graph abstraction. CrewAI's ceiling is its role/task model. trama has no abstraction between intent and code — whatever strategy the LLM can express as a program, trama can run. The autoresearch loop in the examples is not a framework feature. It is a strategy the LLM invented and expressed as TypeScript. Tomorrow the LLM might invent a strategy you haven't thought of, and trama will run that too.

This also means trama gets more powerful automatically. As LLMs get better at writing code, trama's capability space expands — without a single line of framework change.

### Auditable agent behavior

Other agent frameworks produce opaque behavior. You don't know what a ReAct loop will do next. You can't review a prompt chain's reasoning before it runs. You can't `git blame` a tool-calling sequence.

trama's agent behavior is always a `.ts` file. Any developer can read it. This is not just a debugging convenience — it means you can **code review** agent behavior before deploying it, **diff** two versions to see exactly what changed, **compliance audit** every loop, API call, and side effect in the source, and **git blame** the evolution of agent behavior over time.

For any context where you need to explain, justify, or reproduce what an agent did, trama gives you a source-of-truth artifact that other approaches cannot.

### Evolvable orchestration

`trama update` is not prompt tuning. It is not config adjustment. It is rewriting the program itself.

When you say `trama update optimizer "also track memory usage"`, the agent reads the current program, understands its structure, and produces a new version with the requested change. It works in a copy of the project while it does, so it can look at what the program is to work with — `trama update report "use the columns of data/sample.csv"` — and make what the program needs beside it: a package installed, a module, a fixture. The candidate is validated in a copy of that copy; once it has been shown to run, the program reaches the project and what the agent made beside it comes with it, the paths printed. A candidate that does not pass takes nothing into the project. (`"agentChanges": "discard"` in `~/.trama/config.json` takes the program alone.) (A copy shields the project's own files. What a link in the project leads to outside it — the installed runtime under `node_modules`, a shared directory, the repository a git worktree belongs to — is the same place from the copy, and the agent's tools are not confined to where it works.) The old version is saved in `history/`. The change is a real code diff — not a hidden prompt mutation.

This means orchestration is a living thing with a version history. The `history/` directory is a record of how your agent's behavior evolved, in a format anyone can read.

### Self-bootstrapping and composition

A trama program can spawn other trama programs — through the session layer (`Session.create()` + `session.spawn()`), by `runProgram()`, or via `tools.shell("trama create/run ...")` — and can have them written: `createProject(name, prompt)` and `updateProject(name, prompt)`, from `@trama-dev/runtime/runner`, are what `trama create` and `trama update` do. The session layer adds shared workspace and structured lifecycle management; shell composition still works for simpler cases. What a program asks for in code — a run, a project made or changed — its runner carries out: under the run's budget, on its record, shown under its name, and stopped with it. So a project is written with the runner's pi and the runner's environment, like any agent call: what the program set in its own `process.env`, and the variables its run was given (`env`), do not reach the agent that writes it — a key, a pi directory, a proxy among them. The candidate is validated with the run's variables. (A `trama` command a program starts from a shell is a runner of its own, and none of that.) This means:

- A trama program can **decompose** a complex task into sub-programs, run them, and synthesize the results — with shared workspace for artifact exchange.
- A trama program can **generate its own eval harness** — write a benchmark script, then use it to evaluate its own output.
- The autoresearch pattern can be applied to **trama programs themselves** — one program iteratively improving another program's `program.ts`.

trama is not just a tool that generates programs. It is a tool whose programs can generate programs. This is the same property that makes compilers and languages powerful: GCC compiles GCC. trama orchestrates trama.

### Language is not the boundary

TypeScript is the orchestration language. It is not the execution boundary.

A trama program can generate and run code in any language — Python, SQL, Rust, shell scripts — through `tools.write()` and `tools.shell()`. The orchestration stays in TypeScript; the work happens wherever it needs to:

```typescript
const script = await agent.instruct("Write a Python script that analyzes this dataset...");
await tools.write("analyze.py", script);
const result = await tools.shell("python3 analyze.py");
```

The pattern — agent generates code, runtime executes it, agent reads results — is language-agnostic. TypeScript is the first orchestration language, not the last.

### program.ts as a universal format

Docker images became the standard unit of deployment. npm packages became the standard unit of code sharing. program.ts can become the standard unit of agent behavior:

- It is **readable** — any developer can understand what it does.
- It is **executable** — `trama run`.
- It is **shareable** — `git clone` and run.
- It is **evolvable** — `trama update` with natural language.
- It is **composable** — one program can spawn others.
- It is **portable** — program.ts is just TypeScript. If you outgrow trama, take your file and run it however you want.

The last point is what separates this from every agent marketplace and workflow platform: trama's output is not locked inside trama.

---

## Patterns

trama's API is four objects and fifteen functions. They are primitives — the interesting things happen when programs combine them in ways the framework never anticipated.

### Hand-written orchestration against your codebase

You don't need `trama create` to use trama. Write the orchestration yourself and let `agent.instruct()` deploy a full autonomous coding agent for the actual work:

```typescript
import { ctx, agent, tools } from "@trama-dev/runtime";

// You define the workflow — what to do, in what order, how to validate
const feature = ctx.input.args.feature as string;

await agent.instruct(
  `Add ${feature} to the codebase at /home/user/myproject. ` +
  "Create the necessary modules, update routes, and write tests."
);

const tests = await tools.shell("cd /home/user/myproject && npm test", { timeout: 60000 });
await ctx.log("tests", { exitCode: tests.exitCode });

if (tests.exitCode !== 0) {
  await agent.instruct(`Tests failed after adding ${feature}. Fix the issues:\n${tests.stderr}`);
  const retry = await tools.shell("cd /home/user/myproject && npm test", { timeout: 60000 });
  await ctx.log("retry", { exitCode: retry.exitCode });
}

await ctx.done();
```

```bash
trama run my-task --arg feature="user authentication"
```

trama provides the runtime — state, logging, repair, history. `agent.instruct()` provides a free agent that reads files, writes code, and runs commands autonomously. You control the strategy; the agent does the work.

### Programs that build their own tools

A trama program can generate the scripts it needs, then use them. The eval harness doesn't have to exist before the program runs:

```typescript
import { ctx, agent, tools } from "@trama-dev/runtime";

// Step 1: generate a benchmark script tailored to the task
const bench = await agent.instruct(
  "Write a Node.js script (benchmark.mjs) that measures the p50/p99 latency of the function exported from sort.ts. " +
  "It should run 1000 iterations, print the p99 in milliseconds to stdout, and exit."
);
await tools.write("benchmark.mjs", bench);

// Step 2: now use it in an optimization loop
let code = await tools.read("sort.ts");
for (let i = 0; i < ctx.maxIterations; i++) {
  const result = await tools.shell("node benchmark.mjs");
  const p99 = parseFloat(result.stdout.trim());
  if (p99 < 5) break;

  code = await agent.instruct(`This sort function has p99=${p99}ms. Improve it:\n${code}`);
  await tools.write("sort.ts", code);
  await ctx.checkpoint();
}
await ctx.done();
```

The program creates its own measurement infrastructure, then uses it. No framework plugin needed.

### Self-improving programs

A trama program can read its own source and rewrite itself:

```bash
trama create improver "read your own program.ts from the current directory, \
  benchmark how long you take to run with 'time trama run improver', \
  then call 'trama update improver' with a suggestion to make yourself faster. \
  repeat 3 times."
trama run improver
```

This is not a thought experiment. `tools.shell("trama update improver '...'")` is a valid operation — the program rewrites its own orchestration through the same mechanism a human would use.

### Any npm package, zero configuration

program.ts is TypeScript. It can import anything:

```typescript
import { ctx, agent, tools } from "@trama-dev/runtime";
import Anthropic from "@anthropic-ai/sdk";      // direct API access
import { chromium } from "playwright";           // browser automation
import { Client } from "pg";                     // database
import sharp from "sharp";                       // image processing

// the agent decides what to import — trama doesn't need to know
```

Other agent frameworks require you to register tools, write adapters, or use framework-specific wrappers. trama programs use the npm ecosystem directly. If the package exists on npm, the agent can use it.

### Cross-language orchestration

TypeScript is the orchestration layer. The work happens in whatever language fits:

```typescript
import { ctx, agent, tools } from "@trama-dev/runtime";

// Generate and run a Python ML pipeline
const pipeline = await agent.instruct("Write a Python script that trains a classifier on data.csv...");
await tools.write("train.py", pipeline);
await tools.shell("pip install scikit-learn pandas && python3 train.py");

// Generate and run a SQL migration
const migration = await agent.instruct("Write a PostgreSQL migration that adds an index on...");
await tools.shell(`psql -d mydb -c "${migration}"`);

// Generate and compile a Rust binary for the hot path
const rustCode = await agent.instruct("Write a Rust program that sorts this 10GB file...");
await tools.write("sorter/src/main.rs", rustCode);
await tools.shell("cd sorter && cargo build --release && ./target/release/sorter data.bin");
```

The agent picks the right language for each subtask. trama just runs it.

### Cooperative yield and resume

A program can suspend itself and resume later with new input:

```typescript
import { ctx, agent, tools } from "@trama-dev/runtime";

if (ctx.resumed && ctx.yieldReason === "awaiting_review") {
  const feedback = ctx.input.args.feedback as string;
  const revised = await agent.instruct(`Revise based on feedback:\n${feedback}\n\nOriginal:\n${ctx.state.draft}`);
  await tools.write("final.md", revised);
  await ctx.done();
} else {
  const draft = await agent.instruct("Write a technical proposal for...");
  await tools.write("draft.md", draft);
  ctx.state.draft = draft;
  await ctx.yield("awaiting_review");
}
```

```bash
trama run proposal                           # writes draft.md, yields
# human reviews draft.md
trama run proposal --arg feedback="expand the security section"  # resumes, writes final.md
```

### Multi-agent session

Multiple programs coordinate through a shared workspace — no shell hacks, no polling for files:

```typescript
import { ctx, agent, tools } from "@trama-dev/runtime";
import { Session } from "@trama-dev/session";

const session = await Session.createTemp();
const checks = ["sql-injection", "xss", "auth-bypass"];

// Spawn check agents — each is a full trama program
const handles = checks.map(check =>
  session.spawn(check, { projectDir: `~/.trama/projects/check-${check}` })
);

// Wait for all to complete
const results = await Promise.all(handles.map(h => h.wait()));
const report = await agent.instruct(`Synthesize:\n${JSON.stringify(results)}`);
await tools.write("security-report.md", report);
await ctx.done();
```

Each participant has its own lifecycle, state, and repair loop. The session layer handles coordination; trama handles execution.

### Parallel execution

No framework feature needed — it's just TypeScript:

```typescript
import { ctx, agent, tools } from "@trama-dev/runtime";

const urls = ["https://api.a.com/data", "https://api.b.com/data", "https://api.c.com/data"];

const results = await Promise.all(
  urls.map(url => tools.fetch(url).then(r => JSON.parse(r.body)))
);

const analysis = await agent.instruct(`Compare these three datasets:\n${JSON.stringify(results, null, 2)}`);
await tools.write("comparison.md", analysis);
await ctx.done();
```

---

## Agent code as a medium

trama generates TypeScript, but the goal is not to give TypeScript the ability to call agents. It's the reverse: **give agents the ability to express their work as code.**

Code is the most precise, auditable, and shareable way to describe a multi-step workflow. By having the agent produce real code:

- **The agent leverages the entire TS/npm ecosystem** — HTTP clients, parsers, databases, testing tools — without trama needing to wrap each one as a "tool". The agent chooses the implementation; the runtime just runs it.
- **The orchestration is not locked inside a framework.** program.ts is valid TypeScript. The runtime is minimal scaffolding, not a walled garden.

Pulumi and CDK proved that real code beats DSLs and YAML for infrastructure. trama takes the same position for agent orchestration — and goes one step further: the code itself is written by the agent.

---

## Why a runtime

trama could have stopped at code generation. But generated code without an execution layer is just text.

The runtime is what makes agent programs **self-contained and shareable**:

- **Execution** — spawns programs as child processes with streaming stdout/stderr, and manages timeouts. Nothing a program starts outlives its run: when the run ends — or the runner goes, however it goes — its shell commands and its own child processes are asked to stop (SIGTERM) and killed if they have not gone five seconds later, and the run is not over until they are gone. A small watchdog process sees to it when the runner cannot: one that is killed outright, runs out of memory, or crashes. A process the program detaches into a process group of its own is out of reach.
- **IPC bridge** — programs communicate with the runtime through a local HTTP server. Every `ctx`, `agent`, `tools` and `workspace` call goes through this bridge, which gives the runtime a single point where it validates each request and can cancel work in flight when a run ends.
- **State persistence** — `ctx.state` survives across runs via `checkpoint()` and `done()`. Programs can be long-running, interruptible, and resumable. `ctx.yield()` suspends a program cooperatively — persists state and exits, ready for the session layer to resume it later.
- **Shared workspace** — when programs run in a session, they share a workspace for artifact I/O. Atomic writes, path guarding, and level-triggered observation (`workspace.observe()`) — without a message bus or coordination framework.
- **Auto-repair** — when a program crashes, the runtime sends the error back to the LLM, gets a fix, and tries it on a private copy of the project — the copy the agent worked in when it was asked, so a fix may be to the project as well as to the program: a missing package installed, a broken config file put right. Only a fix that works is installed, along with what was done in the copy — by the agent and by the run: files, directories, links and permissions; one that fails takes nothing into the project. What the agent changed beside the program is printed and recorded in the journal. (While `create` or `update` validates a candidate, a fix is the program alone: nothing else of a validation is kept.) Up to 3 attempts. A `program.ts` you have made read-only is never replaced: it is run, and if it fails no fix is asked for. If something the fixed run did could not be carried into the project — because that place changed there in the meantime — the run says so, and its journal records it. In a session the fix runs against the live shared workspace, so a participant being repaired can still be heard and answered.
- **A record of every run** — each call a program makes through the bridge is written down as it happens, with how it ended: what the agent was asked and answered, what was read and written, each command and its output, each program it started. `trama journal` shows it.
- **Version history** — every create, update, and repair saves a snapshot. You can diff any two versions to see how the program evolved.
- **Scaffolding** — the runtime creates package.json, the module symlink, gitignore, and the history and log directories, and checks them before every run. Recipients of a shared program don't need to set anything up.

This is what separates trama from "give an LLM a prompt and run the output." The runtime is the contract between the generated program and the world — and it's what makes `git clone && trama run` work.

And this is also what separates trama from "just write TypeScript yourself." You *can* write the same program.ts by hand — it's real TypeScript, not a proprietary format. But without the runtime, you'd be reimplementing state persistence, error recovery, version history, module scaffolding, and the generate → execute → evolve loop every time. trama is the infrastructure that turns a script into a living, shareable, self-healing agent.

---

## Sharing

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

Prompts generate different code each time. A trama program is the same code every run — the orchestration is fixed and readable, even though the agent calls inside it are not deterministic. Recipients can read exactly what it does before running it, and rewrite it with `trama update`.

Here's what program.ts actually looks like:

**Simple — one-shot task:**

```typescript
import { ctx, agent, tools } from "@trama-dev/runtime";

const data = await tools.read("input.csv");
const report = await agent.instruct(`Analyze this data and write a report:\n${data}`);
await tools.write("report.md", report);
await ctx.done({ summaryLength: report.length });
```

**Iterative — eval loop with convergence:**

```typescript
import { ctx, agent, tools } from "@trama-dev/runtime";

const brief = await tools.read("brief.md");
let copy = await agent.instruct(`Write SEO-optimized landing page copy based on this brief:\n${brief}`);

for (let i = 0; i < ctx.maxIterations; i++) {
  const result = await tools.shell(`node eval-seo.mjs`);
  const score = parseFloat(result.stdout.trim());

  await ctx.log("evaluated", { iteration: i, score });
  if (score >= 0.9) break;

  copy = await agent.instruct(
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
await ctx.done({ finalMetric: Number.isFinite(best) ? best : null });
```

**Cooperative yield/resume:**

A program that pauses for human review, then continues with feedback:

```typescript
import { ctx, agent, tools } from "@trama-dev/runtime";

if (ctx.resumed) {
  const feedback = ctx.input.args.feedback as string;
  const final = await agent.instruct(
    `Revise this analysis based on feedback:\n${feedback}\n\n${ctx.state.analysis}`
  );
  await tools.write("final-analysis.md", final);
  await ctx.done();
} else {
  const data = await tools.read("data.csv");
  const analysis = await agent.instruct(`Analyze this dataset:\n${data}`);
  await tools.write("draft-analysis.md", analysis);
  ctx.state.analysis = analysis;
  await ctx.yield("awaiting_human_feedback");
}
```

---

## Getting started

### Prerequisites

Node.js 22.19 or newer, on macOS or Linux.

trama uses [pi](https://github.com/earendil-works/pi) for LLM calls. Set an API key for any supported provider:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."   # default provider + model: anthropic / claude-opus-5-5
```

Other providers (OpenAI, Google, Bedrock, Azure) work via `~/.trama/config.json`:

```json
{ "provider": "openai", "model": "gpt-5.4" }
```

Or override per-project: `trama create my-task "do something" --model claude-sonnet-5-5`

See all supported providers in [pi-ai docs](https://www.npmjs.com/package/@earendil-works/pi-ai).

### Install and run

```bash
npm install -g @trama-dev/cli

trama create scraper "fetch the Hacker News front page, extract all story titles and URLs, \
  and write them to stories.json"
trama run scraper
trama update scraper "also include the comment count for each story"
trama list
trama logs scraper
trama journal scraper
```

Six commands. `create` turns intent into code, `run` executes it, `update` rewrites it. `list`, `logs`, and `journal` for visibility. Projects are stored at `~/.trama/projects/{name}/`.

### CLI reference

```bash
trama create <name> <prompt> [--model <model>] [--arg key=value ...]
trama run <name> [--timeout <ms>] [--budget cap=number ...] [--arg key=value ...]
trama update <name> <prompt>
trama list
trama logs <name>
trama journal <name> [run] [--list]
```

- `--model` — override the LLM model for program generation (create only).
- Ctrl-C (or SIGTERM) stops a run politely: the program is sent SIGTERM and given five seconds to finish what it must, and `trama run` returns once it is gone. Press Ctrl-C again to leave at once.
- `--timeout` — per-phase timeout in milliseconds. Applies to each run and repair attempt separately. Default: `300000` (5 minutes). It limits the program's own time: while a participant it spawned is running — under a timeout of its own — the clock is stopped.
- `--budget` — cap what the run may use of a model: `cost=2.50` (US dollars), `tokens=500000` or `calls=40`. Repeatable. See [Budgets](#budgets).
- `--arg` — pass key-value arguments to the program, accessible via `ctx.input.args`. Repeatable.
- `trama journal` — what a run did, call by call: the latest run of the project, or the one named. `--list` shows which runs are on record. See [The journal](#the-journal).

```bash
# Example: pass arguments that the program can read via ctx.input.args
trama create summarizer "summarize the file given by ctx.input.args.file" --arg file=report.csv
trama run summarizer --arg file=another-report.csv
```

---

## The runtime API

Every program imports `ctx`, `agent`, and `tools`. Programs in a session also get `workspace`.

```typescript
import { ctx, agent, tools } from "@trama-dev/runtime";
// in a session:
import { ctx, agent, tools, workspace } from "@trama-dev/runtime";
```

### ctx — lifecycle and state

```typescript
ctx.input             // { prompt: string, args: Record<string, unknown> }
ctx.state             // persistent JSON state (local working copy)
ctx.iteration         // progress counter (advances only on checkpoint/done)
ctx.maxIterations     // hint for loop bounds (not enforced by runtime)
ctx.resumed           // boolean — true if this run follows a yield
ctx.yieldReason       // string | null — reason from previous yield
await ctx.log(msg)    // structured log entry (appears in `trama logs`)
await ctx.ready(data?)// signal startup complete for long-running programs, idempotent
await ctx.checkpoint()// persist ctx.state to disk, advance iteration
await ctx.done(result?)// signal completion — persists state, idempotent
await ctx.yield(reason)// cooperative suspension — persists state, exits process
```

`done()` and `yield()` are **mutually exclusive** terminal signals. The first one to succeed wins; a conflicting later call throws. A call that fails (for example because `ctx.state` isn't serializable) settles nothing — fix the problem and call either one. Once a run has ended its state is settled: a `checkpoint()` after `done()` or `yield()` throws too.

**State constraints:** `ctx.state` must be strictly JSON-serializable. No `Date`, `Map`, `Set`, circular references, `NaN`, or `Infinity`. `checkpoint()` will throw with a path to the offending value if validation fails. Keys starting with `__trama_` are reserved for internal use.

### agent — LLM calls

```typescript
await agent.instruct(prompt, { system?, model?, thinking?, tools?, skills?, templates?, extensions?, cutOff? })   // instruct the agent — may use tools autonomously
await agent.generate<T>({ prompt, schema, system?, model?, thinking?, tools?, skills?, extensions?, cutOff? }) // the same, answered as typed JSON
```

`agent.instruct()` is **not** a simple text completion. The underlying pi-coding-agent runs a full agent loop and may autonomously use its built-in tools (bash, file read/write/edit) to fulfill the instruction. What you get back is the final text response.

`agent.generate()` is the same agent, answering as a typed object: it may use its tools to find out what it is asked — read the file, run the tests — and gives its answer in the shape you name. The schema says what each field is to be:

```typescript
const result = await agent.generate<{ score: number; reasoning: string }>({
  prompt: "Rate the code in target.ts",
  schema: {
    score: "number: 1-10 quality rating",      // "type: description" format
    reasoning: "string: explain the rating",
  },
});
// result.score is a number, result.reasoning is a string
```

A field is `"string"`, `"number"` or `"boolean"` — the part after `:` is a description hint for the LLM (ignored during validation) — or an object of such fields, or a list, written as the shape of its items in brackets:

```typescript
const report = await agent.generate<{ passed: boolean; failures: Array<{ test: string; line: number }>; tags: string[] }>({
  prompt: "Run the tests and say what failed.",
  schema: {
    passed: "boolean: did every test pass",
    failures: [{ test: "string", line: "number: where it failed" }],   // a list of objects
    tags: ["string"],                                                   // a list of strings
  },
});
```

The answer holds the fields you declared and no others, at every depth, each of the kind declared; a list may be empty. Where the reply is not of that shape the model is told where (`failures[1].line: expected number, got string`) and asked once more.

A call can say how it is to be served:

```typescript
// A cheap model that only reads, for the survey; the project's model, thinking hard, for the decision.
const survey = await agent.instruct("List every place the config is read.", {
  model: "anthropic/claude-haiku-5-5",
  tools: ["read", "grep", "find", "ls"],
});
const plan = await agent.instruct(`Decide how to split the config:\n${survey}`, { thinking: "high", tools: [] });
```

- `model` — the model for this call, as `"provider/model"`, in place of the project's.
- `thinking` — how much the model is to think: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` or `"max"`.
- `tools` — the agent's tools for this call: exactly the ones named, `[]` for none. Left to itself pi takes `read`, `bash`, `edit` and `write`; it also has `grep`, `find` and `ls`, among others. A `generate` that is to be made from its prompt alone — nothing read, run or written — is one with `tools: []`.
- `skills`, `templates`, `extensions` — your pi's skills, prompt templates and extensions: see below. Without them the call has none of the three.
- `cutOff` — what to make of an answer that was cut off at the model's output limit: `"fail"` (as it is without the option) or `"keep"`.

Each is honoured or the call fails. A model pi does not know, a level pi does not have for the model, a tool the agent has not got: pi itself would serve such a call with something else and say nothing, so trama checks what the call was given before the model is asked. One thing it cannot see to: what a provider makes of a level is the provider's. For some models two levels pi offers come to the same request (`"minimal"` and `"low"` for several of Anthropic's, say), and a few take any level and send none.

**Your pi's skills, templates and extensions.** An agent call is served by pi with none of your skills, prompt templates or extensions, unless the call asks for them (your pi's settings, models and `AGENTS.md` it has always had):

```typescript
// The skills pi finds for you and for the project (.pi/skills, .agents/skills). Or the ones named.
await agent.instruct("Turn report.md into a PDF.", { skills: ["pdf"] });
// A prompt template of yours, or of the project's (.pi/prompts): "/name" and what it is filled in with.
await agent.instruct("/review src/config.ts", { templates: ["review"] });
// Your extensions and MCP servers: the tools they add can then be named among a call's tools.
await agent.instruct("Find the ticket this change belongs to.", { extensions: true, tools: ["read", "ticket_search"] });
```

- `skills` — `true` for all the skills pi finds, or a list of names. pi looks where it looks when you run it in the project: your pi directory and `~/.agents/skills`, what your settings and the project's `.pi/settings.json` name (packages among it), the project's `.pi/skills`, and `.agents/skills` in the project and the directories above it; where two have one name, the project's is taken. The model is told of them and reads the one it needs; a prompt of `instruct` that begins with `/skill:name ` (the name, then a space) is that skill's text and, after it, the rest of the prompt. pi tells a model of its skills only where it has `read` or `bash` to read them with, so a call with skills and neither is an error.
- `templates` — `true` for all your prompt templates and the project's, or a list of names; of two by one name, the project's. A prompt that begins with `/name` is then the template of that name, with the rest as its arguments — split as a shell splits words: quotes are taken off, and a line break or a run of spaces becomes one space, so a diff or a file put after the name does not arrive in its shape (put it in the template's own text, or ask without a template). It is an option of `agent.instruct` only: what tells the model how a typed answer is to be written follows the prompt, and a template is free to leave out what follows its name.
- `extensions` — `true` for your pi extensions: those of your pi directory and settings, and the ones pi has built in — its MCP support among them, so the MCP servers in your `mcp.json` are the agent's. `"project"` for the project's own as well: its `.pi/extensions`, and the MCP servers its `.pi/mcp.json` names. With them come the tools they register, which a call's `tools` can then name — an MCP server's too, by the name pi gives it (`mcp__server__tool`), where your `mcp.json` has the server show its tools to the model (`"exposure": "direct"`; as pi has it otherwise, the agent reaches a server through a tool of pi's, `codemode`, which is then among its tools). The tools a call names are looked for when its model is first about to be asked, when what extensions add is there: a call that names one nobody has fails there, its model not asked (and a prompt a command takes without the model ever being asked is not looked at for them). pi starts an MCP server for each call that has it, and ends it with the call. With them come, too, the commands a prompt of `instruct` can then begin with, and what they do to a session — the skills and templates an extension brings come with it where the call names none of its own (a list of names is a list of all the call has, an extension's included). **A call with extensions is served by pi in a process of its own**, not in the runner: an extension is somebody's code, and where it runs it can hold up or bring down everything else that runs there. So what an extension gets wrong — it does not return, it goes round without end, it throws where nobody catches it — ends that process and fails that one call; the run goes on, and its next call with extensions has a process again. (Such a process loads pi at the first call it serves, which takes that much longer — a second or two on a quiet machine, more on a busy one; the calls that follow one another use the same process, and calls made together have one each.) With `true` the project is not one to be trusted — which is what pi has an extension ask before it takes anything of a project's for its own — and with `"project"` it is. The call's own settings are what they are without extensions. An extension pi has something against — it does not load, or a tool of it bears the name of another's — is the call's error. A command that puts a question to the model before it returns has the model's answer be the call's, whether or not it waits for it; a prompt a command takes and that gets no answer fails the call, which says so. A call that is cancelled — by a timeout, or by its budget — asks no more. Where something holds it, its process gives it up after three seconds, says what it used, and serves on; a process that has not let go of it after five is ended, with what it started — what it started in process groups of their own too (an MCP server, a command the agent was running), as far as the system can still say whose they were: it is asked by its `/proc` where it has one, and by `ps` elsewhere. Where the runner itself is gone, whatever way it went, its watchdog ends each such process the same way, with what it has under it. A call whose process was ended is taken to have used what the process last said it had: every reply of its model's that had come. What an extension does once the model has first been asked is its own to do: one that changes the tools or the instructions of a session then changes what the call asked for, and nothing checks it after.

A name pi has no skill or template by is an error that lists the ones it has. `false`, or an empty list, is the same as leaving the option out. Without any of the three a prompt is the text it is, whatever it begins with — as is the prompt of `agent.generate` always (an extension that looks at what is put to a session still sees it, and may change it). `create`, `update` and a repair take none of the three.

An option that is not one of these is an error too, as is any option a call to the runtime does not take, or a value that cannot be sent to it (a callback, say): `tool: [...]`, misspelt, would otherwise restrict nothing and say nothing. This is so of the calls a program makes to its runtime — `agent`, `tools`, `workspace`, `ctx`, `runProgram`, `createProject` and `updateProject`. A `Session`, and `runProgram` called outside a program, are ordinary TypeScript, and take no notice of what they do not know.

The answer of a call is the model's last reply, and only if the model ended it itself: a reply that is the provider's error fails the call with the provider's words, and so does one that was cut off at the output limit — unless the call says `cutOff: "keep"`, and then it returns what there was of the reply, as if that were the answer (the call still fails where there was nothing of it: a reply cut off before its first word, or while the model was still thinking). That is for a call whose work is what the agent did with its tools, and whose closing words matter little: `await agent.instruct("add the endpoint and its tests", { cutOff: "keep" })` does not fail, and start over, because the summary at the end ran long. (A reply cut off in the middle of a tool call never ends a call: pi has the model make the call again. But the agent goes no further than a reply that was cut off in its words — where those were leading up to more work, the work was not done. And a typed answer that was cut off is seldom whole: `generate` holds what it kept to the schema like any reply, and asks again where it does not fit.) And the prompt is text: it reaches the model as written, also where it begins like one of your own pi commands (`/review …`) — unless the call asks for your templates, skills or extensions (above).

### tools — I/O operations

```typescript
await tools.read(path)                    // -> string (file contents)
await tools.write(path, content)          // -> void
await tools.shell(command, { cwd?, timeout?, env? }) // -> { exitCode, stdout, stderr }
await tools.fetch(url, { method?, headers?, body? })
                                          // -> { status, body, headers }
```

`read` and `write` are path-guarded to the project directory (traversal and symlink escape attempts throw — every link on the way to a path is followed, whether or not what it points at exists yet). A path is read the way the system reads it, so it names the same file as it would in the program's own `fs` calls: `dir/../file` goes up from where `dir` leads, and a path the system would not follow (`file.txt/`, `missing/..`) is refused. So is a path that leads to something other than a file or a directory — a named pipe, a socket, a device. `shell` defaults to a 30-second timeout; pass `{ timeout: 60000 }` for longer commands. A command is given no input: one that reads standard input finds it at an end. It has the runner's environment and the variables its run was started with; `{ env: { NAME: "value" } }` gives it more, for that command. What the program sets in its own `process.env` is not handed on unless it is given: `{ env: process.env }` hands on all of it. A variable given as `undefined` is one not given (there is no way to take one away), and the two by which a program finds its runner, `TRAMA_PORT` and `TRAMA_INIT`, are passed over whoever gives them. The journal records the names of the variables given, never their values — so write a value as a value: of a name like `"KEY=secret"`, which is refused, what follows the `=` is not repeated. The shell that runs the command is the one the runner's own `PATH` leads to, whatever `PATH` the command is given. `fetch` returns the response body as a string (capped at 10MB).

Long-running programs should call `ctx.ready()` once startup completes so `create`/`update` smoke validation can treat "server is up" as success instead of waiting for process exit.

### workspace — shared artifact I/O

Available when running in a session. Path-guarded to the workspace root (independent of the project directory). The program that creates a session gets the same four functions as `session.workspace`.

```typescript
await workspace.read(path)                           // -> string
await workspace.write(path, content)                 // -> void (atomic: temp + fsync + rename)
await workspace.list(pattern)                        // -> string[] (glob match, sorted)
await workspace.observe(pattern, { expect?, timeout? })
  // level-triggered: existing matches are included immediately
  // single-file: returns string; glob/expect>1: returns [{path, content}, ...]
```

`workspace.write()` is **atomic** — writes to a temp file, fsyncs, then renames. Concurrent readers via `observe()` or `read()` never see partial content. `workspace.observe()` counts unique paths, not write events. The same path written twice counts as one.

A write to the workspace is **immediate and never undone**. The workspace is how participants talk to each other, so nothing written there is held back — not by a run that later fails, and not by a repair that is being tried. Two things follow:

- An artifact says that something was written, not that its writer finished. Check the participant's result (`handle.wait()`) before trusting what it left.
- A participant that fails is run again from its last checkpoint — by a repair, or by you — and will write again what it wrote after that checkpoint. Give artifacts names that do not depend on the attempt, so a second write replaces the first instead of adding to it.

If `workspace` is not available (program not running in a session), all calls throw with a clear message.

### Session — multi-agent coordination

`@trama-dev/session` provides the session layer for coordinating multiple trama programs through a shared workspace.

```typescript
import { Session } from "@trama-dev/session";

const session = await Session.create({ workspace: "/tmp/my-session" });
// or: const session = await Session.createTemp();

// The creating program takes part through session.workspace — the same
// read / write / list / observe that participants import as `workspace`.
await session.workspace.write("brief.md", brief);

const handle = session.spawn("check-sql", {
  projectDir: "~/.trama/projects/check-sql",
  args: { target: "src/" },
  env: { REVIEW_DEPTH: "full" },   // optional: variables for this participant
});

const result = await handle.wait();
// result: { status: "done" | "yielded" | "failed", reason?, result? }

// Resume a yielded participant with new args:
if (result.status === "yielded") {
  const resumed = await handle.resume({ feedback: "approved" });
  await resumed.wait();
}
```

Each participant is a full trama program with its own lifecycle, repair loop, and state. The session layer does not manage execution — trama does. The session manages coordination: who participates, when to resume, and what the shared workspace contains.

Each participant also has its own timeout, and its time is charged to it alone. A program is never timed out for the time its participants take: its clock stops while one of them is running, so a participant that needs a repair does not bring down the program waiting for it. How long a session may run is therefore decided by the participants' timeouts, not by the entry program's.

**One runner runs the whole session.** A program does not run its participants itself: `spawn()` asks the runner that is running the program — the `trama run` you started — to run them. So however deep a session goes, there is one process that owns every program in it:

- A participant belongs to the program that spawned it. When that program's run ends — finished, failed, timed out, or yielded — its participants are stopped, whether or not the program is in a state to do anything about it. Stopping `trama run` stops all of them.
- A participant's output appears in the runner's output, each line under the participant's name (`[check-sql] …`) — what it prints, and what the runner reports about it. It is not part of the output of the program that spawned it.
- A participant runs with the runner's environment, not with the environment of the program that spawned it. What it is to have besides is given in `env` (`runProgram({ …, env })` takes the same): its program has those variables, and so do the commands it runs, its agents, and the participants it spawns in turn. An agent of such a run is served by pi in a process of its own, started with the run's variables: what it finds of pi (`PI_CODING_AGENT_DIR`, `HOME`), the key it has for a provider, and what the commands it runs are given, are the run's. (That process loads pi at the first call it serves — a second or two — and calls made together have one each; a run that was given no variables has its agents served in the runner, as before, unless a call asks for extensions. Variables that keep node from starting — a `NODE_OPTIONS` it refuses, more than the system hands a process — keep the run's agents from being served, as they keep its program from running: each call fails, saying that its process could not be started or ended as it started.) A program that wants its participants to have its whole environment says `env: process.env`. (`create` and `update` take no variables: a candidate is validated with the environment `trama` itself was started in.)
- Programs may run programs up to 16 deep, and one runner carries up to 128 runs at a time. Past either, the participant is not run and `wait()` rejects — a program that spawns itself is stopped there rather than when the machine gives out.
- The `trama` command is the exception: started by a program, as any other tool might be, it is a runner of its own, and what it runs is not part of the session.

`runProgram()` (and so `handle.wait()`) returns a structured `ProgramResult`:

```typescript
interface ProgramResult {
  status: "done" | "yielded" | "failed";
  reason?: string;      // yield reason, or error summary for failed
  result?: unknown;     // from ctx.done(result), if provided
}
```

The runner determines status by checking **terminal signals first, then exit code**. A `done()` or `yield()` the program completed takes precedence over a non-zero exit code.

### The journal

Every run is recorded. As a program runs, each call it makes through the bridge is appended to a journal — the request when it arrives, the result (or the error) when it is answered — together with what only the runtime knows: which program text was run, how each attempt exited and what it printed, each fix that was asked for and what came back, and how the run ended.

```
$ trama journal lead
2026-11-12T01-54-59-389Z-0f38e7  run  done
    0.003s  attempt 0  program 55ab701c
    0.161s  #1   workspace/write    brief.md                                                      ok  8ms
    0.172s  #2   run/program        scout (/home/you/.trama/projects/scout)                       ok  169ms
    0.173s  #2   started run 2026-11-12T01-54-59-563Z-538f2c
    0.176s  #3   workspace/observe  findings/*.md                                                 ok  253ms
    0.430s  #4   tools/read         not-there.txt                                                 failed  0ms  Error: File not found: not-there.txt
    0.431s  #5   ctx/done                                                                         ok  0ms
    0.434s  attempt 0 over: exit code 0 → done
    0.434s  end: done
```

An agent call's line ends with what it used, and the last line with what the run used in all — `1200 tokens  $0.0125`.

- **One file per run**, `logs/journal/<run>.jsonl` in the project, one JSON record per line. A repair is part of the run it repairs: the failed attempt, the fix, and the attempt that tried the fix are in the same journal — including an attempt whose fix did not work and left no other trace.
- **A session is a tree of journals.** A participant's run has a journal of its own, in its own project. The journal of the program that spawned it says which run that call started, and the participant's journal says which call started it.
- **Written as things happen.** A journal says what had happened by the time of its last line. The journal of a run that died has no `end`; a call that nobody was left to answer — the program was gone — has no `result`.
- **What the agent used is counted.** Each time the agent behind a call was asked, a `usage` record says which model served it, the tokens it read and wrote (and read from and wrote to a cache), and what pi's price list makes of that in US dollars — over everything the agent asked of the model for that call: every turn, every retry, a summary pi made of a conversation grown long. It is written when the call is over, however it ended: a call that failed, or was stopped half-way, has used what it used, and a run that is recorded waits for the calls it cut off to say so before its journal ends (up to five seconds, for a backend that does not let go). The same is recorded for each fix that was asked for. Nothing is recorded where nothing was counted — the provider was never reached, or does not say.
- **What writing a program used is with its validation.** `create` and `update` ask a model for the program before there is any run: what that took is printed (`writing the program used 3410 tokens  $0.0212`) and is the first `usage` record of the validation's journal, counted in its total. Where no program came back — the model failed, or the writing was stopped — there is no validation, and the printed line is all there is.
- **It is a record, not a control.** Nothing reads a journal back to change what a run does. (A budget is counted in the runner's memory as calls are made, not from the journal.)

What goes in it is what the program did: prompts and answers, the contents of files read and written, shell commands and their output. Keep that in mind before sharing one. Two things are held back on purpose: the values of credential-looking headers of a web request (`Authorization`, `Cookie`, `X-Api-Key`, anything with "key", "token" or "auth" in its name) are replaced by `[redacted]`, and of the variables given to a command or a run (`env`) only the names are written. A secret a program puts anywhere else — in a URL, a prompt, a command — is recorded as written. Journals are readable by their owner only, and `logs/` is kept out of version control.

It is bounded in size. A text longer than 256 KB is cut to its beginning, and a record holds about 1 MB. A record that lost something says so in its `cuts`: which value, and what was there — a text's full length and hash, how many items a list had. A record without `cuts` is whole. A journal that has grown past 64 MB goes on recording how the run goes — attempts, exits, the end — but no more of its calls, nor what they used: the total `trama journal` shows for such a run is what is on record, and says so.

A project keeps the journals of its latest 20 runs — more for a while, if older ones are still being written. Change that with `"journalRuns"` in `~/.trama/config.json`; `0` records nothing. A journal that names another run's journal does not keep that one from being removed in its turn.

### Budgets

A run can be capped in what it uses of a model:

```bash
trama run optimizer --budget cost=2.50 --budget calls=40
```

```jsonc
// ~/.trama/config.json — for every run that is given none of its own, and for each create and update
{ "budget": { "cost": 5, "tokens": 2000000, "calls": 200 } }
```

```typescript
// A participant, or any run a program asks for, can be given less than the run that asks has
session.spawn("scout", { projectDir: "~/.trama/projects/scout", budget: { cost: 0.5 } });
await runProgram({ projectDir, budget: { calls: 10 } });
```

- `cost` is US dollars as pi's price list counts them, `tokens` is everything the model read and wrote (cached or not), `calls` is how many calls to an agent are taken on — a `generate` that had to ask again is two, a request for a fix is one, and a call counts once it is taken on, whatever becomes of it. What is not named is not capped. A run given a budget of its own has that one, and not the config's beside it.
- **A budget covers everything a run causes**: its program's agent calls, each request for a fix, and all that the runs it asks for use. Those runs are held to the budgets above them as well as to their own, so a program can give a run it starts less than it has, and never more. The config's budget is for a run nobody's program asked for; it is not applied a second time to each run inside it.
- **Once it is spent**, an agent call is refused — the program gets an error that says what was used of what (`The budget is spent: $2.0134 used of $2.`) — and no repair is tried, since a fix is asked of a model too. A call that is under way when a cap on cost or tokens is reached is stopped where its agent would ask the model again: what it had asked for by then is used, and the request in flight is let finish. So a run ends over its cap by the requests that were in flight when it was reached — one, for a program that makes its calls one after another; as many as it has going at once, for one that makes them together. The first time a call is refused or stopped it is printed; and a journal says so in a `budget` record before its last, where its run ended with a budget spent — its own, whose caps are in its first record, or one above it — or had a call refused or stopped for one.
- For `create` and `update` the config's budget covers writing the program and validating it together.
- **It is a guard, not a wall.** It counts what goes through the runner's agent calls. A program is not confined (see [Trust and safety](#trust-and-safety)): one that calls a model's API itself, or runs another agent from a shell command, spends what trama never sees. (A project a program has made or changed — `createProject`, `updateProject` — is not such a way: its runner does that, and it is counted in the run's budget like a run the program asks for. A `trama create` it starts from a shell is a runner of its own, under the config's budget.) And what pi cannot count — a provider that does not say what a request took — is counted as nothing; `calls` is the cap that holds there.

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

trama stores all projects at `~/.trama/projects/{name}/`. The runtime creates the scaffolding around `program.ts` automatically — at `create`, and again before every run, so a hand-written or freshly cloned project needs no setup:

- `package.json` — with `"type": "module"` (required for top-level await). If one already exists and is valid JSON, trama patches in the `type` field without touching the rest.
- `node_modules/@trama-dev/runtime` and `node_modules/@trama-dev/session` — symlinks to the installed packages (re-pointed if they have moved), so `program.ts` can import both.
- `history/` — version snapshots and metadata.
- `logs/` — structured run logs (viewable via `trama logs`), and under `logs/journal/` the journals of the latest runs (viewable via `trama journal`).
- `.gitignore` — creates or appends exclusions for generated files.
- `state.json` — written when the program calls `ctx.checkpoint()`, `ctx.done()` or `ctx.yield()`.

---

## Trust and safety

trama does not sandbox generated programs. A program can do anything TypeScript can do: read/write files, run shell commands, make network requests.

**`create` and `update` execute the generated program.** After generating code, trama runs it once to validate it works. If the program makes network requests, calls external APIs, or runs shell commands with side effects, those side effects happen during validation — before you ever run `trama run`.

Three kinds of program are validated only part of the way, because running them to the end would not be a validation any more:

- A program that runs until it is stopped passes once it has called `ctx.ready()` and stayed up for two seconds.
- A program that runs other programs passes at the moment it asks for the first one. That program is not started: what a session does is not what is being checked, and its participants would run for real — in their own projects, at their own cost. What the program does after that point is first exercised by `trama run`, where a crash is repaired as usual.
- A program that has a project made or changed (`createProject`, `updateProject`) passes at the moment it asks, for the same reason: the project would be made for real, and a model asked for its program. It is not made.

**A copy shields the project's own files, and nothing else.** A fix is tried, a candidate validated, and both agents work, in a copy of the project. Beside the copy stands a link for each name beside the project, so that `..` leads where it leads from the project: a program that reads `../shared.json` or runs `../worker` can be repaired and updated. What is reached that way — like the shared workspace, an absolute path, or a link in the project that leads out of it — is the real thing, and what is done to it is done: in a validation, and by a fix that fails, too. The project itself is among it: from a directory beside the project, `..` is the real directory, so a module in `../lib` that writes `../my-project/data.txt` by that path writes the project's own file, not the copy's. Three limits: one level up only; a directory that may be passed through but not listed shows the copy nothing; and a *name* made or removed beside the copy (`../new.txt`, `rm ../shared.json`) is not made or removed beside the project — a repaired run says so, as `create` and `update` do of the agent's work — though what is done through a name (`rm -rf ../shared/`) is done to the real thing. With tens of thousands of names beside a project, every copy takes seconds.

**`create`, `update` and a repair may change more of a project than `program.ts`.** The agent that writes or fixes a program works in the copy the program is then tried in, and what it changed there — files made, changed or removed, trama's own (`state.json`, `meta.json`, `history/`) among them — reaches the project with a program that ran, and only with one. The paths are printed (the first ten), and for a fix recorded in the journal (the first two hundred); `history/` versions the program only. Set `"agentChanges": "discard"` in `~/.trama/config.json` to take nothing from the agent but the program.

**An agent works under the project's own pi settings.** pi takes a `.pi/settings.json` in the directory it works in, and an agent call works in the project: so a project can say which shell the agent's `bash` runs, which command stands for `npm` where pi has packages of yours to look up, which tools and how much thinking an agent has where a call names none — and the pi packages it names are pi's to fetch. These are commands the runner starts, on the word of a file in the project, which the project's program can write: no more than the program could run by itself with `tools.shell`, but it is the runner that runs them. (Its extensions and the MCP servers it names are not taken unless a call asks for them — `extensions: "project"` — and then they run in the process that serves that call: see above.)

**`agent.instruct()` gives the LLM autonomous tool access.** When your program calls `agent.instruct()`, the underlying pi-coding-agent may autonomously read files, write files, and run shell commands to fulfill the request. This is not a simple text-in/text-out call — the LLM can take multi-step actions within the project directory.

**A call with extensions runs somebody's code — yours, and with `extensions: "project"` the project's — in a process of its own.** Not in the runner, which carries every run of a tree: what an extension gets wrong ends the process that served the call, and that call fails; nothing else does. It is a process like the program's own — with your rights, your files and your network, and no more confined than a program is. With `"project"` that is code the project holds, which its program can write: no more than the program could run by itself, and now run where an agent's tools are made. A call that does not ask for extensions loads none, and starts no such process — unless its run was given variables, which an agent has by being served in a process started with them. What the process is kept from is the runner and every other call: it cannot hold them up or bring them down. The call it serves is its own to answer for — an extension can say what it will of that call's answer, and of what the call used, and a budget counts what it is told.

This is a deliberate design choice. trama is a power tool, not a managed service. A program can narrow what one call may do (`tools: ["read", "grep"]`, or `tools: []` for none), which is a way to say what a step is for, not a wall around it. If you need execution constraints, apply them below trama: containers, VM isolation, or pi's tool-level configuration. The only built-in guard is a path check on `tools` and `workspace` file access (traversal and symlink escapes) — a footgun guard, not a security boundary.

---

## Design principles

**1. The kernel does less, so the program can do more.**
trama's runtime is minimal. It loads, executes, and repairs programs. Everything else — loops, strategies, optimization logic, multi-agent coordination — lives in the generated program or the session layer above it.

**2. Orchestration is code, not configuration.**
There is no YAML, no JSON graph, no visual builder. The orchestration is a `.ts` file that you can read, diff, and `git log`.

**3. The only built-in intelligence is repair.**
If a program crashes, the runtime sends the error back to the LLM, gets a fix, and tries it on a copy of the project — installing it only if it works. Up to 3 attempts. This is the only "smart" behavior in the kernel.

**4. Adapt trama to your workflow, not the other way around.**
No plugin system, no middleware, no hooks. Extend trama by editing program.ts or composing trama programs together.

---

## Relationship to pi

trama uses [pi](https://github.com/earendil-works/pi) as its intelligence substrate. All LLM calls go through [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) — trama does not implement its own agent loop, tool calling, or provider abstraction. When `agent.instruct()` runs, pi handles the full agent loop (bash, file I/O, multi-step reasoning). trama benefits from pi's evolution automatically.

---

## Status

Early development. Three packages (`runtime`, `session`, `cli`), six CLI commands, four runtime objects (`ctx`, `agent`, `tools`, `workspace`). The single-agent runtime is stable. The session layer (`@trama-dev/session`) for multi-agent coordination is functional — workspace I/O, cooperative yield/resume, and structured program results are implemented and tested. What comes next is shaped by what people build with it.
