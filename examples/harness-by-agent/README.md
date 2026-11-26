# harness-by-agent

A harness that is somebody else's, written as a program: some twenty lines, to be read and changed.

`examples/coding-harness` is a harness whose loop, tools and words are a program's. This is the other choice: the work is handed, whole, to an agent from outside — a coding agent you have installed and are logged in to — by `workspace.agent`. It is a black box: a task in; out, what it said and how its turn ended. Which agent is yours to say, in the configuration:

```json
{ "agents": { "claude": { "command": "npx", "args": ["-y", "<the package that speaks the Agent Client Protocol for it>"] } } }
```

(`~/.trama/config.json`. trama names no agent and ships no list of them: an agent is whatever speaks the [Agent Client Protocol](https://agentclientprotocol.com), version 1, on its standard input and output.)

To use it, copy it among your projects and say which agent it is — once, in the project's own arguments, or run by run:

```sh
trama examples harness-by-agent --as by-claude
# in ~/.trama/projects/by-claude/meta.json:  "input": { …, "args": { "agent": "claude" } }
```

```ts
import { resolveProject, runProgram } from "@trama-dev/runtime/runner";
await runProgram({ projectDir: resolveProject("by-claude"), workspaceDir: "/path/to/a/codebase", args: { task: "Make the failing tests pass." } });
```

What it is, and is not:

- **It sits where a harness that is a program sits.** Run with a `task`, it works where its run works: the run's workspace, where it has one; else its own project. So it can be pointed at a codebase, checked by a judge of what it left there (`checkWith`), held against `coding-harness` on the same work by the same judge, or named as the harness a writer has write a project's program — `"harness": "by-claude"` in the arguments of `examples/write-by-harness`, and `trama update my-project "…" --with write-by-harness` is then an update written by that agent: in a copy, validated, recorded and installed as any is.
- **What trama holds of it is little, and is said**: where it works, how long it may take (`seconds`), and that it is gone when the run is. Every permission the agent asks is granted, for the once. It reads and writes as itself, under your login for it, and can reach whatever you can — a boundary round it is yours to choose, as it is round a shell command.
- **What it says it used is its own account**: on the run's record under the call (`trama journal`), in what this program ends with (`usage`), and not under the run's budget, nor in what the run is said to have used. A judge that goes by what a run used cannot go by it; one that goes by the work can.
- **A run fails where the agent did not do the work** — not installed, not logged in, too slow, refusing — and says which. A turn that ended at a limit of the agent's own (`max_tokens`, `max_turn_requests`) is the run's result, with `ok` false: the work may be done, and whoever judges it looks.
- **It has no harness to improve**: the agent's is its own. What can be said to it is here to change — the task's wording, `system`, the model where the agent has none of its own — and a loop over this program (`examples/improve-by-check`) improves that much and no more.
- A validation of a new version of this program calls the agent for real, as a run does: with the project's own prompt for a task, where its own arguments name an agent — and is refused before anything is started where they name none.
