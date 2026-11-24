# coding-harness

A harness for work on a codebase, written as a program: some three hundred lines, to be read and changed.

It does what `agent.instruct` has pi's agent do — but the loop is here, in `program.ts`: it keeps the conversation with the model itself (`agent.complete`), runs the tools the model calls in the project it is in (`tools.read`, `write`, `shell`, and an `edit` made of those), asks again where the provider failed, and keeps a conversation that grows long within what the model reads — by forgetting what old tools said, and by summing up where that is not enough.

To use it, make it the program of the project whose files are the work:

```sh
cp examples/coding-harness/program.ts ~/.trama/projects/my-codebase/program.ts
trama run my-codebase --arg task="Make the failing tests pass. Do not change the tests."
```

Or keep it a project of its own, and point a run of it at the codebase — its workspace:

```ts
await runProgram({ projectDir: resolveProject("my-harness"), workspaceDir: "/path/to/a/codebase", args: { task: "Make the failing tests pass." } });
```

(`--arg model=provider/model` has another model do the work than the project's own — a small one, say, under a harness that a large one wrote.)

Where a run has a workspace the work is done there, and the project the harness is the program of is left as it is. One harness then does many pieces of work; each is a run of *it*, on its record and of one of its versions — which is what lets it be held against another version of itself, on the same pieces of work (`examples/improve-by-check`, with `from`).

What it did is in the run's journal — `trama journal my-codebase` — a line for each request to the model and for each thing a tool did, and what each request used.

It is a starting point, not the best harness there is. What it does about a long conversation, once a request has read more than it is to (`--arg forgetAt=…`, in tokens):

- **It forgets**, where that is enough: what old tools said is cut to its beginnings — the oldest first, all but the latest two, and as much as brings the conversation back to six tenths of what it may be. Nothing is asked of a model for it. And nothing is forgotten that does not bring the conversation back: every cut costs the provider's cache of the conversation, from where it is made.
- **It sums up**, where forgetting is not enough — which it comes to in any long piece of work, since what the model itself said (every command, every edit) is never forgotten and in time outgrows what may be read. The model is asked once, with no tools, for what was found and done and what is left; all but the latest of the work gives way to its answer.
- **It stops and says so**, where neither would do: the task and the latest turn are too much by themselves, or the summing-up is.

Beside these it keeps a record of its own of what has been done: the files that are not as they were when the work began, told by what is in them (so whichever tool changed them), without what the codebase's `.gitignore` leaves out. The model is told it wherever something is forgotten or summed up, and the run answers with it — `files: { changed, made, gone }` — beside what the model says it did, how often it was asked, and how often the conversation was cut either way (`forgotten`, `summed`). A command has the seconds the model gives it (1,800 at most), and the model is told so. Change it.
