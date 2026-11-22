# coding-harness

A harness for work on a codebase, written as a program: some hundred and fifty lines, to be read and changed.

It does what `agent.instruct` has pi's agent do — but the loop is here, in `program.ts`: it keeps the conversation with the model itself (`agent.complete`), runs the tools the model calls in the project it is in (`tools.read`, `write`, `shell`, and an `edit` made of those), asks again where the provider failed, and forgets what old tools said when the conversation grows long.

To use it, make it the program of the project whose files are the work:

```sh
cp examples/coding-harness/program.ts ~/.trama/projects/my-codebase/program.ts
trama run my-codebase --arg task="Make the failing tests pass. Do not change the tests."
```

What it did is in the run's journal — `trama journal my-codebase` — a line for each request to the model and for each thing a tool did, and what each request used.

It is a starting point, not the best harness there is. What it does about a long conversation is the plainest thing that works: it cuts what old tools said to their beginnings, and asks nobody to sum anything up. Change it.
