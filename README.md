# trama

> Agents don't need frameworks. They need a runtime.

**trama** is a TypeScript runtime for **programmable, self-bootstrapping agents**.

Instead of locking an agent inside a fixed loop or a workflow framework, trama turns every piece of agent behavior into a plain, versioned TypeScript program (`program.ts`) backed by a policy-free runtime. The coding harness a model works in, the writer that creates programs, the fixer that repairs crashes, the judge that grades runs, and the loop that tests and promotes new versions — all of them are programs you (and your agents) can read, edit, version, benchmark, and replace.

```bash
npm install -g @trama-dev/cli
```

Requires Node 22.19+ on macOS or Linux. Models are called through [pi](https://github.com/earendil-works/pi), using your provider API key in the environment (`ANTHROPIC_API_KEY`, etc.) or `~/.pi/agent/auth.json`.

---

## Why trama

The ecosystem has largely converged on **code** as the right medium for agents. The real difference now is **where the code stops**:

- **Code mode** (Cloudflare Code Mode, Claude's programmatic tool calling, Claude Code's experimental Code Mode, pi's `codemode`) lets a model write code that calls its tools. It confirms that code is the right medium — but the script typically lives for one turn or session inside someone else's harness (or, in Cloudflare's case, as a saved snippet), rather than as a standalone artifact with a contract, version history, and an independent judge.
- **Scripted orchestration inside a coding agent** (Claude Code's dynamic workflows) keeps and reruns the script — but the script can only start that product's own subagents, with no direct file/shell access, modules, or raw model calls of its own. The orchestration is programmable; the harness is not.
- **Agents as code** (Cursor's Agent SDK, Claude Managed Agents) version your instructions, tools, and evals/config on top of the vendor's harness. You version what goes *into* the loop, not the loop itself.
- **Durable execution** (Temporal, Restate, Inngest, Cloudflare's durable runtime, `pi-durable`) journals and replays a run so it survives crashes and resumes mid-flight. That solves durable state for *one run* (something trama does not yet support — its replay is dry-run only), rather than keeping a versioned history of the *program* with verdicts on each version.
- **Open harnesses** (Codex, pi, OpenCode) aren't black boxes — you can fork and edit their source. But changing the loop means modifying and rebuilding the product, not adding a candidate version to a program, judging it, and rolling it back at runtime.
- **Hand-rolled SDK loops** give you full control over the loop, but zero runtime infrastructure — no call-level journaling, bridge-level replay, shared budgets, contract checks, or version history.

Self-improving harnesses are now an active research and industry direction (from papers like Meta-Harness and VERSE to Thoughtworks' Technology Radar), though most implementations still live as custom research loops rather than an everyday runtime feature — and recent benchmarks show that automated harness edits can be unstable, model-dependent, or even regress below the baseline. That is precisely why self-modification needs runtime discipline: version lineage, held-back checks, and instant rollback. **trama aims to turn programmable, versioned harnesses into a general-purpose local primitive by separating mechanism from policy:**

- **The runtime owns mechanism, never policy.** Every call a program makes — to a model, a tool, a shell, a workspace, an external agent, or another trama program — crosses one local IPC bridge. That single boundary gives every program call-by-call journaling, bridge-level dry-run replay, shared budgets, input/output contracts, version history, copy-on-trial repair, and runner-enforced reach guards during evaluation.
- **Programs own all policy.** Everything that involves judgment, prompting, looping, or strategy is just a `program.ts` inside `~/.trama/projects/<name>/`. Because a harness is an ordinary versioned program — and because a running harness can invoke the runtime itself — an agent can read its own history, stage candidate versions beside the live program behind held-out checks, and roll back when a change doesn't hold up.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Policy Layer — Every role is a plain TypeScript program (program.ts)   │
│                                                                         │
│  coding-harness     program-writer     program-fixer     your programs  │
│  harness-by-agent   write-by-harness   repair-harness    (any npm pkg)  │
│  improve-by-check   check-by-command   custom judges                    │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
           Single Local IPC Bridge   │   ctx · agent · tools · workspace
                                     │   + @trama-dev/runtime/runner
┌────────────────────────────────────▼────────────────────────────────────┐
│  Runtime Layer — Mechanisms only, zero hardcoded policy                 │
│                                                                         │
│  • Call-by-call journal & bridge replay    • Versioned program history  │
│  • Shared budgets (cost / tokens / calls)  • Copy-on-trial repair       │
│  • Enforced I/O contracts (meta.json)      • Checks & runner-API guard  │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
            External Backends & OS   │   Models via pi · External agents
                                     │   via ACP · OS / Container sandbox
```

---

## Quick Start

A project is a directory under `~/.trama/projects/<name>/` containing `program.ts`, `meta.json` (its contract and default args), `history/` (every version and run record), and `logs/journal/` (call-by-call traces).

```bash
# 1. Generate a program from a prompt (validated by running it)
trama create digest "fetch the top 10 Hacker News stories and write digest.md"

# 2. Run it — crashes are repaired in a temporary copy and installed only if fixed
trama run digest

# 3. Evolve it as real code (not hidden prompt tweaking)
trama update digest "also include the comment count for each story"

# 4. Inspect its versions, call trace, replay bridge calls from the journal, or roll back
trama history digest --runs
trama journal digest
trama replay digest
trama rollback digest 1
```

You don't have to generate programs with an LLM. Write `program.ts` yourself and register it directly — the runtime doesn't care who wrote the code:

```bash
trama create summarise "Summarise text and identify risks" \
  --program summarise.ts --contract summarise.json --arg text="$(cat notes.md)"
```

---

## Programmable Harnesses & Self-Bootstrapping

Generating one-off scripts is just the entry point. The real power of trama is making the **agent harness itself** a programmable, versioned, evolvable artifact.

### 1. Run a programmable harness on any codebase

`coding-harness` is a complete coding agent harness written as a single, readable TypeScript program (`~500` lines). It drives the model turn by turn via `agent.complete()`, executes file/edit/shell tools, retries provider errors, and manages long context by trimming old tool outputs and summarizing when needed. Every detail of its behavior is plain code you can edit.

```bash
trama examples coding-harness --as my-harness
trama examples check-by-command

trama run my-harness \
  --workspace ./code \
  --arg task="Make the failing tests pass. Do not change the tests." \
  --check check-by-command \
  --budget cost=2
```

Notice the separation: `./code` is passed as `--workspace`, while `my-harness` stays its own versioned project. Every task you throw at it is recorded under `my-harness`'s history and version number, and judged independently by `check-by-command` (which runs `npm test` in a temporary copy of what the harness left behind).

### 2. Let the agent control trama — and rewrite its own harness

Pass `--arg programs=true` and the agent working inside `coding-harness` gets your trama projects as tools alongside its codebase tools:

- `programs` / `program` — discover available projects, contracts, versions, and past run outcomes
- `program_guide` — read the full runtime API and contract guide
- `run_program` — run any project in the current workspace
- `make_program` — turn a new script it wrote into a persistent, validated trama project
- `add_version` / `use_version` — test a candidate version beside an existing project and promote (or roll back) it

The harness itself is in that list. An agent can build reusable tools for future runs and **modify the harness it is currently running inside** — with changes taking effect on the next run. Every call routes through the parent runner: metered under the same `--budget`, recorded in the same journal, and blocked at the runner API from modifying whatever checks or fixes the run.

### 3. Evolve programs and harnesses with held-back evaluation

Variation without selection isn't evolution. `improve-by-check` is a ~400-line program that implements an evolutionary improvement round using only trama's public runner API:

```bash
trama examples improve-by-check --as improve

trama run improve \
  --arg project=my-project \
  --arg check=my-judge \
  --arg inputs='[{"word":"a"},{"word":"b"}]' \
  --arg heldBack='[{"word":"c"}]' \
  --arg ask="Return every word in uppercase."
```

Each run executes one disciplined round:
1. Evaluates the current version on `inputs` and `heldBack` (reusing cached verdicts from history so you never pay for the same run twice).
2. Shows the writer **only** the failures/notes from `inputs` plus diffs of previously failed attempts — never `heldBack`.
3. Writes a candidate version **beside** the live program (`install: false` / `--beside`), leaving production untouched.
4. Evaluates the candidate with `--no-making` and a judge the candidate cannot modify through the runner. For stateful codebases or harnesses, `--arg from=/tasks/{task}` gives every run a fresh workspace copy of each benchmark task.
5. Promotes the candidate via `rollbackProject` only if it beats the baseline on `heldBack` (with optional `--arg confirm=N`, `--arg margin=X`, and `--arg by=score` to optimize cost or speed without regressing pass rate).

Because candidate edits can overfit, regress, or behave differently across models, nothing replaces the live version until it clears held-back checks (and every prior version stays one rollback away). And because `improve-by-check` is just a program, its selection rule, confirmation logic, and writer prompt are all yours to edit.

### 4. Plug in external coding agents on the exact same footing

Need an existing coding agent (like Claude Code or any agent speaking the [Agent Client Protocol](https://agentclientprotocol.com))? Treat it as a tool (`tools.agent` / `workspace.agent`) or wrap it with `harness-by-agent`:

```bash
trama config agents.claude '{"command":"npx","args":["-y","<acp-adapter-package>"]}'
trama examples harness-by-agent --as by-claude
trama config --project by-claude args.agent claude

trama run by-claude --workspace ./code --arg task="Make the failing tests pass." --check check-by-command
```

`by-claude` sits in the exact same slot as `my-harness`. You can benchmark your programmable `coding-harness` head-to-head against an external agent under the same judge, or configure `write-by-harness` to use `by-claude` to author new versions of your programs.

---

## Every Policy Is a Replaceable Program

Nothing strategic is hardcoded in the runtime. Every role defaults to a real project or an included example you can inspect, copy, version, and swap:

| Role | Default (bundled) | Included Example (`trama examples`) | How to Configure |
|---|---|---|---|
| **Program Writer** (`create` / `update`) | `program-writer` | `write-by-harness` | `create --with`, `update --with`, `trama config createWith` / `updateWith` |
| **Crash Fixer** (auto-repair) | `program-fixer` | `repair-harness` | `run --fix-with`, `trama config repairWith` |
| **Run Evaluator** (independent judge) | *(none)* | `check-by-command` | `run --check`, `trama config --project <name> checkWith` |
| **Coding Harness** | `pi` via `agent.instruct` | `coding-harness`, `harness-by-agent` | Run the harness project directly |
| **Evolution Loop** | *(none)* | `improve-by-check` | Run the loop project directly |

`program-writer` and `program-fixer` ship with `@trama-dev/runtime` and are copied into `~/.trama/projects/` the first time they are needed. From that moment on, they belong to you: edit their prompts or logic, track versions with `trama history`, roll back with `trama rollback`, or even update them with `trama update program-writer "..."`. Future trama upgrades never overwrite your copies (they notify you once if the bundled version changed).

Copy any example into your projects to inspect and customize it:

```bash
trama examples                                # list all bundled examples
trama examples repair-harness                 # copy into ~/.trama/projects/repair-harness
trama config repairWith repair-harness        # use it as your default crash fixer
```

---

## Three Levels of Agency in One Runtime

Inside any `program.ts`, you choose how much control you want over the model — and you can mix all three in the same program:

| Level | API | What it does | Best for |
|---|---|---|---|
| **1. Raw model turn** | `agent.complete(req)` | Single request & reply (messages, tools, thinking, usage, stop reason). Your code owns the entire loop. | Custom harnesses (`coding-harness`, `repair-harness`), custom context compaction, specialized agent loops. |
| **2. Managed agent** | `agent.instruct(prompt, opts)`<br>`agent.generate({ prompt, schema, ... })` | Runs `pi`'s full multi-step coding agent with configurable model, thinking level, built-in tools, custom TS functions as tools (`AgentTool`, incl. `ends: true` & image returns), pi skills/templates/extensions, and `workspace: true`. | High-level tasks, structured extraction, hybrid deterministic + autonomous workflows. |
| **3. External agent** | `tools.agent(prompt, opts)`<br>`workspace.agent(prompt, opts)` | Delegates a full task to an external ACP-compatible coding agent under your own login. | Wrapping existing coding agents, head-to-head benchmarks, leveraging external harnesses. |

---

## Writing a Program

A program imports from `@trama-dev/runtime` — `ctx`, `agent`, `tools`, `workspace` (plus helpers `heldTo` and `stripCodeFences`) — and is otherwise standard ESM TypeScript. Import any npm package, use `Promise.all`, or shell out to Python, Rust, or SQL.

```typescript
// summarise.ts
import { ctx, agent } from "@trama-dev/runtime";

const text = ctx.input.args.text as string;

// Expected domain failure: exits cleanly with this message, does NOT trigger auto-repair.
if (text.trim().split(/\s+/).length < 20) {
  await ctx.fail("Input is too short to summarise (fewer than 20 words).");
}

const { summary, risks } = await agent.generate<{ summary: string; risks: string[] }>({
  prompt: `Summarise this in two sentences and list key risks:\n\n${text}`,
  schema: {
    summary: "string",
    risks: ["string: one concrete risk"],
  },
});

await ctx.done({ summary, risks });
```

Declare its contract beside it (`summarise.json`, stored in `meta.json`):

```json
{
  "description": "Summarises text and identifies key risks.",
  "parameters": {
    "text": "string: content to summarise"
  },
  "returns": {
    "summary": "string",
    "risks": ["string"]
  }
}
```

```bash
trama create summarise "Summarise text and identify key risks" \
  --program summarise.ts --contract summarise.json --arg text="$(cat notes.md)"

trama run summarise --arg text="$(cat minutes.md)" --budget cost=0.50 --json
trama describe summarise --json   # emits contract + JSON Schema for tools/agents
```

### Explicit run lifecycle

Every program ends its run in one of four distinct ways:

- **`ctx.done(result?)`** — Completed normally. Persists `ctx.state`, validates `result` against `returns` in `meta.json`, and runs `--check` if configured.
- **`ctx.yield(reason)`** — Cooperative suspension. Persists `ctx.state` and exits cleanly; the next run resumes with `ctx.resumed === true` and `ctx.yieldReason === reason`.
- **`ctx.fail(reason)`** — Expected/foreseen failure (bad input, unreachable provider, max turns reached). Ends the run cleanly with `reason` and **does not trigger auto-repair**.
- **Uncaught exception / crash** — Program fault. Triggers copy-on-trial repair in a temporary copy of the project (up to `maxRepairAttempts`).

Long-running services (e.g. HTTP servers) call `ctx.ready()` once initialized so validation knows startup succeeded, and handle `SIGTERM`/`SIGINT` for clean shutdown.

### Programs that orchestrate programs (`@trama-dev/runtime/runner`)

The runner itself is importable from inside a program. When a program imports `@trama-dev/runtime/runner`, its calls automatically route over the parent runner's IPC bridge — inheriting budgets, cancellation, journal lineage, and reach protections:

```typescript
import { ctx } from "@trama-dev/runtime";
import { runProgram, resolveProject } from "@trama-dev/runtime/runner";

const ran = await runProgram({
  projectDir: resolveProject("my-harness"),
  workspaceDir: "/path/to/code",
  args: { task: "Make the failing tests pass" },
  budget: { cost: 2 },
  checkWith: "check-by-command",
});

await ctx.done({ status: ran.status, passed: ran.check?.ok ?? false });
```

Also exported on `@trama-dev/runtime/runner`: `createProject`, `updateProject`, `addVersion`, `rollbackProject`, `readHistory`, `describeProject`, `describeProjects`, `replayProgram`, `replayAll`, `createWorkspace`, and `programGuide`.

Run `trama api` anytime to print the complete API reference, schema syntax, and example programs.

---

## Runtime Mechanisms

- **Call-by-call journal & bridge-level replay:** Every bridge call (arguments, response, usage, timing) is recorded in `logs/journal/` (`trama journal <name>`). `trama replay <name>` (or `--all` / `--loose`) re-executes `program.ts` answering runtime calls from the recording — no model spend, and bridge-mediated actions (`agent`, `tools`, `workspace`, runner) are not carried out again. *(Direct file/network calls made by `program.ts` outside the bridge still execute, and clocks/randomness are not frozen.)*
- **Hierarchical budgets:** `--budget cost=2` (or `tokens=`, `calls=`) caps the run, its repairs, its checker, and every sub-run it spawns.
- **Versioned contracts:** `description`, `parameters`, and `returns` use a compact schema notation (`string`, `number`, `boolean`, `object`, `json`, nested objects, `[item]`, optional `field?`). Inputs are validated before startup, outputs at `ctx.done()`, and contracts are snapshotted per version so `trama rollback` restores code and contract together.
- **Version history & candidate trials:** Every creation, update, repair, `add-version`, and rollback is kept on record in `history/` with parent lineage and run verdicts (`trama history <name> --runs`). Stage candidates beside the active program with `update --beside` and test them with `run --at-version <n>`.
- **Copy-on-trial repair:** Crashes are repaired in a temporary copy of the project; a candidate fix is installed (with any auxiliary files if `agentChanges=keep`) only after passing validation.
- **Independent checks & runner reach guards:** `--check <project>` runs in a throwaway copy of the project after `ctx.done()`. The runner blocks a running program and its children from modifying their own checker or fixer through the runner API, and `--no-making` disables all project creation/mutation through the runner.

---

## CLI Reference

| Command | Description |
|---|---|
| `trama create <name> <prompt>` | Generate a project from a prompt, or register your own (`--program <file>`, `--contract <file>`, `--arg`, `--with`, `--model`). |
| `trama run <name>` | Run a project (`--arg`, `--workspace <dir>`, `--budget`, `--check`, `--fix-with`, `--at-version <n>`, `--no-making`, `--timeout <ms>`, `--json`). |
| `trama update <name> <prompt>` | Rewrite a project (`--from <n>`, `--beside`, `--with`, `--contract`). |
| `trama add-version <name> <file>` | Validate and record a hand-written file as a candidate version without installing it (`--parent`, `--detail`, `--contract`). |
| `trama history <name>` | Show version lineage and run outcomes (`--runs`, `--json`). |
| `trama rollback <name> <version>` | Restore an earlier version (code and contract) as a new active version. |
| `trama describe [name]` | Show project description and I/O contracts (`--json` includes JSON Schema). |
| `trama journal <name> [run]` | Inspect every bridge call and token/cost usage of a run (`--list`). |
| `trama replay <name> [run]` | Re-run a program answering bridge calls from recorded journals (`--all`, `--loose`). |
| `trama config [key] [value]` | View or edit global `~/.trama/config.json` or project settings (`--project <name>`, `--unset`). |
| `trama examples [name]` | List included policy/harness programs or copy one into your projects (`--as <name>`). |
| `trama api` | Print the full program authoring guide, TypeScript API, and schema syntax. |
| `trama list` / `trama logs <name>` | List all projects; inspect structured `ctx.log()` entries from the last run. |

Run `trama <command> --help` for full option details.

---

## Configuration

Inspect and modify `~/.trama/config.json` with `trama config` (`trama config <key> <value>`, `--unset`):

| Key | Default | Purpose |
|---|---|---|
| `provider`, `model` | `anthropic`, `claude-opus-5-5` | Default model for new projects and unspecified agent calls (each project records the model it was created with). |
| `createWith`, `updateWith` | `program-writer` | Project used to write new programs (`create`) and updates (`update`). |
| `repairWith` | `program-fixer` | Project used to repair crashed runs. |
| `maxRepairAttempts` | `3` | Maximum repair attempts on crash (`0` disables auto-repair). |
| `defaultTimeout` | `300000` | Per-phase timeout in milliseconds (applies separately to a run and each repair attempt). |
| `budget` | *(none)* | Default budget cap (`budget.cost`, `budget.tokens`, `budget.calls`) for runs without an explicit `--budget`. |
| `agents` | *(none)* | External ACP agents by name (`agents.<name>` as JSON `{ command, args?, env? }`). |
| `journalRuns` | `20` | Number of recent runs to retain journals for (`0` disables journaling). |
| `agentChanges` | `keep` | Whether auxiliary files modified by a writer/fixer beside `program.ts` are copied back on success (`keep` or `discard`). |

Per-project defaults are managed with `trama config --project <name>`: `checkWith`, `provider`, `model`, and `args.<name>`.

---

## Boundaries & Current Status

**What trama deliberately does not do:**

- **No sandboxing.** Programs, shell commands, and external agents run with the runner's OS permissions and environment variables (including API keys). `history/` and other project files are ordinary files on disk that a program with filesystem access can modify directly. If you need isolation, place it below trama — a container, VM, or dedicated OS user.
- **Bridge-only replay.** `trama replay` intercepts calls that cross the runtime IPC bridge (`agent`, `tools`, `workspace`, runner). It does not intercept direct Node `fs`/network calls made outside the bridge, nor does it freeze system clocks or randomness.
- **Validation executes the program.** `create`, `update`, and `add-version` run the program with the project's default arguments to verify it. Long-running servers pass 2 seconds after `ctx.ready()`; programs that invoke runner APIs (`runProgram`, `createProject`, etc.) pass when they make that call without executing the nested side effect.
- **Temporary copies protect project files only.** Repair trials, validations, and checks work in copies of the project directory, but absolute paths, `--workspace` directories, and network requests hit the real system.
- **Runner-API reach guard only.** The runner blocks a run (and its sub-runs) from modifying its own checker or fixer via runner APIs, and `--no-making` blocks all project mutations through the runner. OS-level filesystem protection remains your environment's responsibility.
- **Journals store call payloads.** Kept owner-readable for the last `journalRuns` runs; note that anything passed across the bridge (including credentials handled by a program) appears in the journal.

**Where it stands (0.x):**

trama ships as two packages — [`@trama-dev/runtime`](packages/runtime/README.md) and [`@trama-dev/cli`](packages/cli/README.md) — and is under active development (minor versions may change APIs; see [CHANGELOG.md](CHANGELOG.md)).

- **Policy-as-programs is live:** `program-writer`, `program-fixer`, and all six example harnesses/judges/loops are standalone TypeScript projects. Only `agent.generate` still formats schema instructions inside the runtime.
- **Early experimental evidence:** `coding-harness --arg programs=true` has been run modifying itself and creating tools, and `improve-by-check` has run improvement loops on both task programs and harnesses — so far only on small tasks and a single model family. Whether an evolved harness improves — and transfers to held-out tasks or other/weaker models — is empirical and model-dependent, not guaranteed by the runtime; trama supplies the versioning, held-back judging, and rollback machinery to measure what actually holds up. Automated evaluation of meta-programs (writers and fixers themselves) is not bundled yet.
- **Not yet implemented:** Live mid-run resume from a journal (unlike durable execution engines, `trama replay` answers calls in a dry run rather than resuming live work from step N) and Windows support.

## License

MIT
