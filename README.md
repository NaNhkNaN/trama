# trama

> The program is the orchestration.

---

## What is trama?

trama is an agentic runtime for TypeScript. The central artifact is **program.ts** — it is the orchestration, the executable, and the record of your intent, all in one file.

You say what you want. trama writes a TypeScript program. trama runs it. When you want something different, you say so, and trama rewrites the program. There is no configuration layer, no prompt template, no graph sitting between your intent and what runs.

```
"optimize sorting by benchmarking alternatives"
            |
        program.ts        <- real, readable TypeScript code.
            |              you can read it, diff it, edit it by hand.
        trama run          <- control flow is explicit in the code.
            |              LLM calls, shell commands, file I/O — all visible.
            |              auto-repairs on failure (up to 3 attempts).
        trama update       <- natural language rewrites the program itself.
```

This is different from other agent frameworks:

- **LangGraph, CrewAI, Temporal** — you write the orchestration, the agent fills in the blanks. The human is the bottleneck.
- **ReAct loops, tool-calling chains** — the agent improvises every step. Flexible, but no stable artifact. Nothing to read, diff, or share.
- **trama** — trama writes the whole program. The control flow is explicit and readable. trama rewrites it on demand.

---

## Getting started

### Prerequisites

trama uses [pi](https://github.com/badlogic/pi-mono) for LLM calls. You need an API key for a supported provider.

```bash
# Set your API key (Anthropic is the default provider, default model is claude-opus-4-6)
export ANTHROPIC_API_KEY="sk-ant-..."

# Or use OpenAI / other providers via ~/.trama/config.json
mkdir -p ~/.trama
cat > ~/.trama/config.json << 'EOF'
{
  "provider": "openai",
  "model": "gpt-5.4"
}
EOF
export OPENAI_API_KEY="sk-..."
```

You can also override the model per-project at creation time:

```bash
trama create my-task "do something" --model claude-opus-4-6
```

Full config options (all optional — defaults shown):

```json
{
  "provider": "anthropic",
  "model": "claude-opus-4-6",
  "maxRepairAttempts": 3,
  "defaultTimeout": 300000,
  "defaultMaxIterations": 100
}
```

Supported providers: `anthropic`, `openai`, `google`, `amazon-bedrock`, `azure-openai-responses`, and others supported by [pi-ai](https://www.npmjs.com/package/@mariozechner/pi-ai). The API key is read from the standard environment variable for each provider (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`).

### Install and run

```bash
npm install -g @trama-dev/cli

trama create optimizer "continuously improve the sorting function in sort.ts by benchmarking alternatives"
trama run optimizer
trama update optimizer "also track memory usage as a secondary metric"
trama list
trama logs optimizer
```

Five commands. `create` turns intent into code, `run` executes it, `update` rewrites it. `list` and `logs` for visibility. Projects are stored at `~/.trama/projects/{name}/`.

### CLI options

```bash
trama create <name> <prompt> [--model <model>] [--arg key=value ...]
trama run <name> [--timeout <ms>] [--arg key=value ...]
trama update <name> <prompt>
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

## Try it yourself

These examples work out of the box. Each one generates a complete program from a single sentence.

**Persistent state** — a number that remembers your changes across runs:

```bash
trama create counter "print number 1, and every time I run this program, the number should +1"
trama run counter    # prints 1
trama run counter    # prints 2
```

**Long-running server with live editing** — a web app that persists state:

```bash
trama create editor "print a number, and host a website at localhost:1111, \
  in this website I can modify the number and next time I run this program, \
  you will first print the number I modified, and host the same website"
trama run editor     # open http://localhost:1111
```

Long-running programs should call `ctx.ready()` once startup completes so `create`/`update` validation can treat "server is up" as success instead of waiting for process exit.

**Behavioral rewrite** — change how the program behaves without starting over:

```bash
trama create chatbot "host a website at localhost:1234 to show a chat window \
  that I can continuously chat with AI, the AI should always reply sadly"
trama run chatbot    # open http://localhost:1234, talk to a sad AI

trama update chatbot "now reply always happy"
trama run chatbot    # same app, same URL, but now the AI is happy
```

---

## Why trama matters

Every other approach puts something between you and execution: a graph definition, a prompt chain, a state machine, a YAML file. That middle layer is where complexity hides and debugging gets hard.

trama removes that layer. Your intent becomes a program. The program is what runs. When you change your mind, the program changes. The history of your intent is the `git log` of a `.ts` file.

Pulumi and CDK proved that real code beats DSLs and YAML for infrastructure. trama takes the same position for agent orchestration: **orchestration as code** — not as configuration, not as a graph, not as a prompt template. And it goes one step further: the code itself is written by the system, not by the human.

This means:
- **The control flow is always visible.** Open program.ts and you see exactly what will happen — every loop, branch, LLM call, and side effect. No framework internals to reverse-engineer.
- **No framework lock-in.** The orchestration is TypeScript. If you outgrow trama, take your program.ts and run it however you want.
- **No prompt engineering.** You don't optimize a prompt to get the right behavior from a framework. You read the generated code, and if it's wrong, you tell the agent what to fix — or fix it yourself.

Note: programs can call LLMs (`agent.ask`), run shell commands (`tools.shell`), and make HTTP requests (`tools.fetch`). These have external side effects and non-deterministic results. What trama makes deterministic is the *control flow* — the structure of what happens, not the content of every response.

---

## Trust and safety

trama does not sandbox generated programs. A program can do anything TypeScript can do: read/write files, run shell commands, make network requests.

**`create` and `update` execute the generated program.** After generating code, trama runs it once in a temporary directory to validate it works. If the program makes network requests, calls external APIs, or runs shell commands with side effects, those side effects happen during validation — before you ever run `trama run`. The temp directory isolates file-system changes, but external side effects (HTTP requests, database writes, deployments) cannot be rolled back.

For long-running programs such as HTTP servers, call `await ctx.ready(...)` once startup completes. This tells smoke validation that the program started successfully and can be shut down cleanly instead of waiting for it to exit on its own.

**`agent.ask()` gives the LLM autonomous tool access.** When your program calls `agent.ask()`, the underlying pi-coding-agent may autonomously read files, write files, and run shell commands to fulfill the request. This is not a simple text-in/text-out call — the LLM can take multi-step actions within the project directory.

This is a deliberate design choice. trama is a power tool, not a managed service. If you need execution constraints, apply them at a layer below trama:
- Run in a container or VM for filesystem/network isolation.
- Use pi's configuration to restrict its built-in tools.
- Wrap `tools.shell()` calls in your own policy by editing program.ts directly.

The only built-in guard is a path traversal check on `tools.read()` and `tools.write()`, which constrains file paths to the project directory. This is a footgun guard, not a security boundary.

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

---

This API can express anything from `console.log("hello")` to a multi-day [autoresearch](https://github.com/karpathy/autoresearch) optimization loop.

---

## What generated programs look like

### Simple

```typescript
import { ctx } from "@trama-dev/runtime";
console.log("hello");
await ctx.done();
```

### Medium

```typescript
import { ctx, agent, tools } from "@trama-dev/runtime";

const data = await tools.read("input.csv");
const report = await agent.ask(`Analyze this data and write a report:\n${data}`);
await tools.write("report.md", report);
await ctx.done({ summaryLength: report.length });
```

### Iterative (SEO copywriting with eval loop)

Each loop iteration = one eval + one agent call. The control flow is plain TypeScript.

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

### Complex ([autoresearch](https://github.com/karpathy/autoresearch) pattern)

This implements Andrej Karpathy's [autoresearch](https://github.com/karpathy/autoresearch) pattern: propose one change, eval against a single metric, keep or discard, repeat.

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

The autoresearch loop is not a framework feature. It's just TypeScript that trama wrote.

---

## Design principles

**1. The kernel does less, so the program can do more.**
trama's runtime is ~1000 lines of TypeScript. It loads, executes, and repairs programs. Everything else — loops, strategies, optimization logic, self-improvement — lives in the generated program.

**2. Orchestration is code, not configuration.**
There is no YAML, no JSON graph, no visual builder. The orchestration is a `.ts` file that you can read, diff, and `git log`.

**3. The only built-in intelligence is repair.**
If a generated program crashes, the runtime sends the error (with stdout/stderr) back to the LLM and asks for a fix. The repair runs in an isolated temp directory — your real project is untouched until the fix is verified. If verification passes, the fixed program runs in the real project with a snapshot so the directory is restored cleanly if it fails there. Up to 3 attempts (configurable via `maxRepairAttempts`). This is the only "smart" behavior in the kernel.

**4. Adapt trama to your workflow, not the other way around.**
Minimal core, maximum extensibility through external tools and conventions rather than built-in features.

---

## Relationship to pi

trama uses [pi](https://github.com/badlogic/pi-mono) as its intelligence substrate. All LLM calls go through [`@mariozechner/pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) via a thin adapter layer. trama does not implement its own agent loop, tool calling, or provider abstraction.

When the agent inside a trama program calls `agent.ask()`, pi runs a full agent loop — it may use its built-in tools (bash, read, edit, write) to fulfill the request. trama just passes the prompt through and gets text back.

This means trama automatically benefits from pi's evolution — new models, new tools, new capabilities — without changing its own code.

---

## Sharing

You don't share prompts — you share code. A trama program is a plain directory that works as a git repo:

```
my-seo-optimizer/
+-- README.md
+-- program.ts          # the trama-generated program
+-- meta.json           # the original prompt + metadata
+-- eval-seo.mjs        # companion eval script
+-- brief.md            # input data
```

trama stores all projects at `~/.trama/projects/{name}/`. Anyone with trama installed can clone a project directly into that location and run it:

```bash
git clone https://github.com/you/my-seo-optimizer ~/.trama/projects/my-seo-optimizer
trama run my-seo-optimizer
```

On first run, the runtime creates scaffolding automatically — you don't need to include any of it in the repo:

- `package.json` — with `"type": "module"` (required for top-level await). If one already exists and is valid JSON, trama patches in the `type` field without touching the rest.
- `node_modules/@trama-dev/runtime` — symlink to the installed runtime (recreated on every run).
- `history/` — version history (see below).
- `logs/` — structured run logs (viewable via `trama logs`).
- `.gitignore` — creates or appends exclusions for generated files.

If the program calls `ctx.checkpoint()` or `ctx.done()`, trama also writes `state.json` to persist program state across runs.

### Version history

Every `create`, `update`, and successful `repair` saves a snapshot of program.ts to `history/`:

```
history/
+-- 0001.ts             # initial version from create
+-- 0002.ts             # after first repair
+-- 0003.ts             # after trama update
+-- index.jsonl         # metadata: version, reason, timestamp, prompt/error
```

You can diff any two versions to see how the program evolved: `diff history/0001.ts history/0003.ts`. The history directory is `.gitignore`d by default since it can be regenerated, but you can track it in git if you want a full audit trail.

What you share is not a prompt or a workflow graph. It's a complete, readable, modifiable program. Recipients can read exactly what it does, adapt it with `trama update`, or edit `program.ts` directly.

---

## Status

trama is in early development. The current scope is the minimum viable product: five CLI commands (`create`, `run`, `update`, `list`, `logs`) and the runtime API (`ctx`, `agent`, `tools`), including `ctx.ready()` for long-running programs.
