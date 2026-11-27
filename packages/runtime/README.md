# @trama-dev/runtime

> Agents don't need frameworks. They need a runtime.

The runtime of [trama](https://github.com/NaNhkNaN/trama): what runs an agent's programs, and what a program imports. The command line is [`@trama-dev/cli`](https://www.npmjs.com/package/@trama-dev/cli).

## Two surfaces

**What a program imports** — `@trama-dev/runtime`:

```typescript
import { ctx, agent, tools } from "@trama-dev/runtime";

const data = await tools.read("input.csv");
const report = await agent.instruct(`Analyze this:\n${data}`);
await tools.write("report.md", report);
await ctx.done({ words: report.split(/\s+/).length });
```

- `ctx` is the run: its arguments (`ctx.input.args`), a state that is kept from one run to the next (`ctx.state`, `checkpoint`), how it ends (`done` with a result, or `yield`), `log`, `ready`.
- `agent` is a model. `instruct` and `generate` have pi's agent do a piece of work, with the model, the thinking and the tools the call names — functions of the program's own among them. `complete` is one request to a model and one reply: a program that loops on it is a harness of its own.
- `tools` is the project's directory and the world: `read`, `write`, `shell`, `fetch` — and `agent`, which hands a task to an agent from outside, over ACP.
- `workspace` is a directory the run is given to work in beside its project — a codebase, or what several runs share: `read`, `write`, `list`, `observe`, `shell`, `agent`.

`trama api` prints the whole of it, with what each call takes and gives.

**What runs programs** — `@trama-dev/runtime/runner`:

```typescript
import { runProgram, resolveProject } from "@trama-dev/runtime/runner";

const result = await runProgram({
  projectDir: resolveProject("my-harness"),
  workspaceDir: "/path/to/code",
  args: { task: "make the failing test pass" },
  budget: { cost: 2 },
  checkWith: "check-by-command",
});
```

Beside it: `createProject`, `updateProject`, `addVersion`, `rollbackProject`, `readHistory`, `describeProjects`, `replayProgram`, `createWorkspace`. A program may import these too. Its calls are then carried out by the runner of its own run: under that run's budget, and on its record.

## What the runtime does

It gives mechanisms, and decides for no use of them.

- **A run.** A program is a process of its own. Every call it makes on `ctx`, `agent`, `tools` and `workspace`, and every run it asks for, crosses one bridge to the one runner, which carries it out.
- **A record.** Each call, with what it was asked and what it answered, is in the run's journal (`logs/journal/`, `trama journal`). A recorded run can be replayed: the program is run again and its calls are answered from the record.
- **A budget.** A run is held to a cost, a number of tokens or a number of calls to a model — and so is everything it starts.
- **A contract.** A project says what a run of it takes and gives (`description`, `parameters`, `returns` in its `meta.json`). Arguments and results are held to it, and it is what another program, or an agent, chooses the project by.
- **A check.** A project can judge the work of a run (`checkWith`): in a copy, out of the reach of the program it judges.
- **Versions.** Every program a project has had is in its `history/`, with the contract it was made under and how its runs went. A version can be run as it was, kept beside the program without being installed, and gone back to.
- **Repair.** A program that crashes is fixed, the fix tried in a copy of the project, and installed only if it works.

What has a policy is a program, and can be another: who fixes (`repairWith`), who writes (`createWith`, `updateWith`), who judges (`checkWith`), the harness a model works in, the loop that improves a program. One of each comes with the command line: `trama examples`.

Node 22.19 or later, on macOS or Linux. Models are asked through [pi](https://github.com/earendil-works/pi).
