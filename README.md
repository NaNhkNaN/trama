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
# Set your API key (Anthropic is the default provider)
export ANTHROPIC_API_KEY="sk-ant-..."

# Or use OpenAI / other providers via config
mkdir -p ~/.trama
cat > ~/.trama/config.json << 'EOF'
{
  "provider": "openai",
  "model": "gpt-5.4"
}
EOF
export OPENAI_API_KEY="sk-..."
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

Five commands. `create` turns intent into code, `run` executes it, `update` rewrites it. `list` and `logs` for visibility.

---

## Why trama matters

Every other approach puts something between you and execution: a graph definition, a prompt chain, a state machine, a YAML file. That middle layer is where complexity hides and debugging gets hard.

trama removes that layer. Your intent becomes a program. The program is what runs. When you change your mind, the program changes. The history of your intent is the `git log` of a `.ts` file.

This means:
- **The control flow is always visible.** Open program.ts and you see exactly what will happen — every loop, branch, LLM call, and side effect. No framework internals to reverse-engineer.
- **No framework lock-in.** The orchestration is TypeScript. If you outgrow trama, take your program.ts and run it however you want.
- **No prompt engineering.** You don't optimize a prompt to get the right behavior from a framework. You read the generated code, and if it's wrong, you tell the agent what to fix — or fix it yourself.

Note: programs can call LLMs (`agent.ask`), run shell commands (`tools.shell`), and make HTTP requests (`tools.fetch`). These have external side effects and non-deterministic results. What trama makes deterministic is the *control flow* — the structure of what happens, not the content of every response.

---

## Trust and safety

trama does not sandbox generated programs. A program can do anything TypeScript can do: read/write files, run shell commands, make network requests. The underlying pi agent has its own tool set (bash, file I/O) that operates autonomously when `agent.ask()` is called.

This is a deliberate design choice. trama is a power tool, not a managed service. If you need execution constraints, apply them at a layer below trama:
- Run in a container or VM for filesystem/network isolation.
- Use pi's configuration to restrict its built-in tools.
- Wrap `tools.shell()` calls in your own policy by editing program.ts directly.

The only built-in guard is a path traversal check on `tools.read()` and `tools.write()`, which constrains file paths to the project directory. This is a footgun guard, not a security boundary.

---

## The runtime API

trama exposes exactly 9 functions to generated programs:

```typescript
import { ctx, agent, tools } from "@trama-dev/runtime";

// ctx -- lifecycle and state
ctx.input           // the user's original prompt + args
ctx.state           // persistent JSON state (local working copy, synced on checkpoint/done)
ctx.iteration       // committed progress counter (advances on checkpoint/done only)
ctx.maxIterations   // hint for loop bounds (not enforced)
ctx.log()           // structured logging (async)
ctx.checkpoint()    // persist state to disk (async)
ctx.done()          // signal completion, persist state (async, idempotent)

// agent -- LLM calls (powered by pi-coding-agent)
agent.ask()         // text in -> text out (pi may use bash/read/edit/write internally)
agent.generate()    // text in -> typed JSON out (string, number, boolean fields)

// tools -- I/O operations (read/write path-guarded to project dir)
tools.read()        // read a file
tools.write()       // write a file
tools.shell()       // run a command -> { exitCode, stdout, stderr }
tools.fetch()       // HTTP request
```

A program that uses only these 9 functions can express anything from `console.log("hello")` to a multi-day [autoresearch](https://github.com/karpathy/autoresearch) optimization loop.

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
If a generated program crashes, the runtime sends the error back to the agent and asks for a fix. Up to 3 attempts. This is the only "smart" behavior in the kernel.

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

Anyone with trama installed can clone it and run it:

```bash
git clone https://github.com/you/my-seo-optimizer ~/.trama/projects/my-seo-optimizer
trama run my-seo-optimizer
```

On first run, the runtime creates scaffolding automatically — you don't need to include any of it in the repo:

- `package.json` — with `"type": "module"` (required for top-level await). If one already exists and is valid JSON, trama patches in the `type` field without touching the rest.
- `node_modules/@trama-dev/runtime` — symlink to the installed runtime (recreated on every run).
- `history/` and `logs/` — version history and run logs.
- `.gitignore` — creates or appends exclusions for generated files.

If the program calls `ctx.checkpoint()` or `ctx.done()`, trama also writes `state.json` to persist program state across runs.

What you share is not a prompt or a workflow graph. It's a complete, readable, modifiable program. Recipients can read exactly what it does, adapt it with `trama update`, or edit `program.ts` directly.

---

## Status

trama is in early development. The current scope is the minimum viable product: `create`, `run`, `update`, `list`, `logs`, and 9 runtime API functions.
