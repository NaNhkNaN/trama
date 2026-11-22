# coding-harness

A harness for work on a codebase, written as a program: some two hundred lines, to be read and changed.

It does what `agent.instruct` has pi's agent do — but the loop is here, in `program.ts`: it keeps the conversation with the model itself (`agent.complete`), runs the tools the model calls in the project it is in (`tools.read`, `write`, `shell`, and an `edit` made of those), asks again where the provider failed, and forgets what old tools said when the conversation grows long.

To use it, make it the program of the project whose files are the work:

```sh
cp examples/coding-harness/program.ts ~/.trama/projects/my-codebase/program.ts
trama run my-codebase --arg task="Make the failing tests pass. Do not change the tests."
```

What it did is in the run's journal — `trama journal my-codebase` — a line for each request to the model and for each thing a tool did, and what each request used.

It is a starting point, not the best harness there is. What it does about a long conversation is the plainest thing that works: once a request has read more than it is to (`--arg forgetAt=…`, in tokens), it cuts what old tools said to their beginnings — the oldest first, and enough to bring the conversation back to six tenths of that — and asks nobody to sum anything up. What it keeps instead is a record of its own of what has been done: the files that are not as they were when the work began, told by what is in them (so whichever tool changed them). The model is told it wherever something is forgotten, and the run answers with it — `files: { changed, made, gone }` — beside what the model says it did. A command has the seconds the model gives it (1,800 at most), and the model is told so. Change it.
