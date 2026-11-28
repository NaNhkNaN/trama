# @trama-dev/runtime

> Agents don't need frameworks. They need a runtime.

The TypeScript runtime for [trama](https://github.com/NaNhkNaN/trama) — a policy-free execution engine where every piece of agent behavior (harnesses, writers, crash fixers, judges, evolution loops, and task programs) lives as a plain, versioned TypeScript program (`program.ts`).

For the command-line interface and bundled harness/evolution examples, see [`@trama-dev/cli`](https://www.npmjs.com/package/@trama-dev/cli).

Requires Node 22.19+ on macOS or Linux. Models are called through [pi](https://github.com/earendil-works/pi).

---

## Two Package Surfaces

### 1. Program API — `@trama-dev/runtime`

What every `program.ts` imports. Every call crosses a local IPC bridge to the runner process, giving the runtime a single boundary for journaling, replay, budgets, cancellation, and contracts.

```typescript
import { ctx, agent, tools, workspace } from "@trama-dev/runtime";

const data = await tools.read("input.csv");
if (!data.trim()) await ctx.fail("input.csv is empty.");

const report = await agent.instruct(`Analyze this dataset:\n${data}`);
await tools.write("report.md", report);
await ctx.done({ words: report.split(/\s+/).length });
```

- **`ctx`** — Run context and lifecycle:
  - `ctx.input` (`{ prompt, args }`), `ctx.state`, `ctx.resumed`, `ctx.yieldReason`
  - `ctx.log(message, data?)`, `ctx.ready(data?)`, `ctx.checkpoint()`
  - Terminal signals: `ctx.done(result?)` (validated against `returns`), `ctx.yield(reason)` (cooperative suspend), `ctx.fail(reason)` (expected domain failure — does **not** trigger auto-repair; uncaught errors do)
- **`agent`** — Three ways to drive models (mix freely in one program):
  - `agent.complete(request)` — Single raw model request/reply. Your code owns the full loop, tools, retries, and context compaction (how programmable harnesses are built).
  - `agent.instruct(prompt, opts?)` — Autonomous multi-step agent via `pi`, supporting custom `model`, `thinking`, built-in tools, custom TypeScript functions as tools (`AgentTool`, including `ends: true` and binary image returns), pi `skills` / `templates` / `extensions`, and `workspace: true`.
  - `agent.generate<T>({ prompt, schema, ...opts })` — Same managed agent, returning a schema-validated typed object.
- **`tools`** — Project-scoped I/O and world access:
  - `tools.read(path)`, `tools.write(path, content)`, `tools.shell(cmd, opts?)`, `tools.fetch(url, opts?)`
  - `tools.agent(prompt, opts)` — Delegate a task to an external coding agent over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP).
- **`workspace`** — Operates on an external working directory passed to the run (e.g. a target codebase or a shared multi-run directory):
  - `workspace.read`, `workspace.write`, `workspace.list`, `workspace.observe`, `workspace.shell`, `workspace.agent`
- **Helpers** — `heldTo(schema, value)` (validate arguments against trama schema notation) and `stripCodeFences(text)`.

Run `trama api` (via `@trama-dev/cli`) or call `programGuide()` to inspect the full TypeScript definitions and schema notation.

### 2. Runner API — `@trama-dev/runtime/runner`

Programmatic control over projects, runs, versions, checks, and replays. Programs can import this surface too — inside a running program, every call automatically routes through the parent runner's IPC bridge, inheriting budgets, cancellation, journal lineage, and reach protections.

```typescript
import { runProgram, resolveProject } from "@trama-dev/runtime/runner";

const result = await runProgram({
  projectDir: resolveProject("my-harness"),
  workspaceDir: "/path/to/code",
  args: { task: "Make the failing tests pass" },
  budget: { cost: 2 },
  checkWith: "check-by-command",
});
```

Key exports:
- **Execution & evaluation:** `runProgram`, `replayProgram`, `replayAll`, `createWorkspace`
- **Project & version lifecycle:** `createProject`, `updateProject`, `addVersion`, `rollbackProject`, `readHistory`, `describeProject`, `describeProjects`, `resolveProject`
- **Configuration & inspection:** `configuration`, `setConfig`, `projectSettings`, `setForProject`, `programGuide`, `failureOf`

---

## Runtime Mechanisms

The runtime enforces mechanisms and hardcodes no policy:

- **Call-by-call journal & bridge-level replay:** Every IPC call is recorded in `logs/journal/`. `replayProgram` / `replayAll` re-execute `program.ts` answering bridge calls from the journal without API spend or re-executing bridge-mediated actions. *(Direct Node file/network calls outside the bridge still run, and clocks/randomness are not frozen.)*
- **Hierarchical budgets:** Cap `cost`, `tokens`, or `calls` across a run, its repairs, its checks, and all nested sub-runs.
- **Versioned contracts:** `description`, `parameters`, and `returns` in `meta.json` validate inputs/outputs and snapshot with every version so rollbacks restore code and contract together.
- **Version history:** Every `create`, `update`, `addVersion`, `repair`, and `rollback` is kept on record in `history/` with lineage and run verdicts. Run any past or candidate version without touching the live program (`version` option).
- **Copy-on-trial repair:** Crashes are repaired in a temporary copy of the project's files and installed only if validation succeeds.
- **Independent checks & runner reach guards:** `checkWith` runs a separate judge project in a throwaway copy of the project after `ctx.done()`. The runner blocks any run (and its children) from modifying its own checker or fixer through the runner API; `making: false` disables project mutations through the runner. *(trama does not provide OS-level sandboxing.)*

### Bundled self-hosted policy programs

`@trama-dev/runtime` ships two default policy projects — `program-writer` (for `create` / `update`) and `program-fixer` (for crash repair). They are copied into `~/.trama/projects/` on first use and become ordinary user-owned projects you can edit, version, roll back, or replace via config (`createWith`, `updateWith`, `repairWith`). Future upgrades never overwrite your copies.

## License

MIT
