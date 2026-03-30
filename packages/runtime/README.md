# @trama-dev/runtime

> Agents don't need frameworks. They need a runtime.

The runtime behind [trama](https://github.com/NaNhkNaN/trama) — execution, state persistence, auto-repair, and version history for agent-authored programs.

## Two surfaces

**Client** — what trama-generated programs import. Three objects: `ctx`, `agent`, `tools`.

```typescript
import { ctx, agent, tools } from "@trama-dev/runtime";

const data = await tools.read("input.csv");
const report = await agent.ask(`Analyze this:\n${data}`);
await tools.write("report.md", report);
await ctx.done();
```

`ctx` manages lifecycle and persistent state. `agent` makes LLM calls (including autonomous tool use via pi-coding-agent). `tools` handles file I/O, shell commands, and HTTP requests.

**Runner** — what the CLI and programmatic callers use to create and execute programs.

```typescript
import { createProject, runProgram, updateProject } from "@trama-dev/runtime/runner";
```

## What the runtime provides

The runtime is what makes agent programs **self-contained and shareable**:

- **Execution** — child process spawning, streaming output, timeout management, background process cleanup.
- **IPC bridge** — local HTTP server mediating all LLM calls, file I/O, and shell commands. The runtime monitors and controls every operation.
- **State persistence** — `ctx.state` survives across runs. Programs can be long-running, interruptible, and resumable.
- **Auto-repair** — on crash, the runtime gets an LLM fix, validates it in isolation, applies it with snapshot protection. Up to 3 attempts.
- **Version history** — every create, update, and repair saves a snapshot to `history/`.
- **Scaffolding** — package.json, module symlinks, gitignore, logs. `git clone && trama run` just works.

## Self-orchestration

trama programs can create and run other trama programs through `tools.shell()`. The generated program becomes the orchestrator — decomposing tasks, spawning sub-programs, and synthesizing results. No orchestration framework needed. trama is the scheduler.

See the [main README](https://github.com/NaNhkNaN/trama) for examples, the full API reference, and design philosophy.
