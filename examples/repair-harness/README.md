# repair-harness

A harness that fixes programs, written as a program: about a hundred lines, to be read and changed.

Where a run's program fails, trama asks for a fix — of pi's agent, unless the run or the configuration names a project to ask instead. This is such a project. It keeps the conversation with the model itself (`agent.complete`), runs the tools the model calls in a copy of the failing project (`workspace.read`, `write`, `list`, `shell`), asks again where the provider failed, and hands the fixed program back.

To use it, copy it among your projects and name it:

```sh
cp -R examples/repair-harness ~/.trama/projects/repair-harness
```

```jsonc
// ~/.trama/config.json
{ "repairWith": "repair-harness" }
```

or for one run of a program of yours: `runProgram({ projectDir, repairWith: "repair-harness" })`.

What it does for a fix is in its own journal — `trama journal repair-harness` — a line for each request to the model and for each thing a tool did, and what each request used. The run it fixed for names that journal in its own.

It is a starting point, not the best harness there is: it sums nothing up when a conversation grows long, and knows no more of a project than its tools tell it. Change it.
