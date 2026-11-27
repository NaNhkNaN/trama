# coding-harness

A harness for work on a codebase, written as a program: some three hundred lines, to be read and changed.

It does what `agent.instruct` has pi's agent do — but the loop is here, in `program.ts`: it keeps the conversation with the model itself (`agent.complete`), runs the tools the model calls in the project it is in (`tools.read`, `write`, `shell`, and an `edit` made of those), asks again where the provider failed, and keeps a conversation that grows long within what the model reads — by forgetting what old tools said, and by summing up where that is not enough.

To use it, make it the program of the project whose files are the work:

```sh
trama examples coding-harness
cp ~/.trama/projects/coding-harness/program.ts ~/.trama/projects/my-codebase/program.ts
trama run my-codebase --arg task="Make the failing tests pass. Do not change the tests."
```

Or keep it a project of its own, and point a run of it at the codebase — its workspace:

```sh
trama examples coding-harness --as my-harness
trama run my-harness --workspace /path/to/a/codebase --arg task="Make the failing tests pass."
```

From a program, the same:

```ts
await runProgram({ projectDir: resolveProject("my-harness"), workspaceDir: "/path/to/a/codebase", args: { task: "Make the failing tests pass." } });
```

(`--arg model=provider/model` has another model do the work than the project's own — a small one, say, under a harness that a large one wrote.)

Where a run has a workspace the work is done there, and the project the harness is the program of is left as it is. One harness then does many pieces of work; each is a run of *it*, on its record and of one of its versions — which is what lets it be held against another version of itself, on the same pieces of work (`examples/improve-by-check`, with `from`).

## With the programs there are

```sh
trama run my-harness --workspace /path/to/a/codebase --arg programs=true --arg task="…"
```

With `programs`, the model has your trama projects as tools beside the codebase's: it lists them (`programs`), looks at one (`program`: what a run takes and gives, its versions and how their runs went), and runs one where it works (`run_program`). And it makes them: a program it wrote becomes a project (`make_program`, by the runner's `createProject` with the program handed over), one that is there is given a version more (`add_version`) — validated, kept beside the program, run by its number — and that version is made the program (`use_version`), as any earlier one is again. `program_guide` tells it how a program is written. So what the model works out while it works is a program that is there the next time, with what it takes and gives said, and every version to go back to.

The harness itself is one of those programs, and the model is told which: it changes the harness it is at work in by the same moves, and the change is in force from the next run.

Each of these tools is one call of the runner's, carried out by the run's own runner: under the run's budget and on its record (`trama journal`). What the runner refuses, the model is told in the runner's words — a run started with `--no-making` has the programs to look at and run and no way to make or change one, and no run can change the project that checks it. It is off unless a run asks for it: with it, what a run can reach is no longer the codebase it was pointed at, but every program you have.

What it did is in the run's journal — `trama journal my-codebase` — a line for each request to the model and for each thing a tool did, and what each request used.

It is a starting point, not the best harness there is. What it does about a long conversation, once a request has read more than it is to (`--arg forgetAt=…`, in tokens):

- **It forgets**, where that is enough: what old tools said is cut to its beginnings — the oldest first, all but the latest two, and as much as brings the conversation back to six tenths of what it may be. Nothing is asked of a model for it. And nothing is forgotten that does not bring the conversation back: every cut costs the provider's cache of the conversation, from where it is made.
- **It sums up**, where forgetting is not enough — which it comes to in any long piece of work, since what the model itself said (every command, every edit) is never forgotten and in time outgrows what may be read. The model is asked once, with no tools, for what was found and done and what is left; all but the latest of the work gives way to its answer.
- **It stops and says so**, where neither would do: the task and the latest turn are too much by themselves, or the summing-up is.

Beside these it keeps a record of its own of what has been done: the files that are not as they were when the work began, told by what is in them (so whichever tool changed them), without what the codebase's `.gitignore` leaves out. The model is told it wherever something is forgotten or summed up, and the run answers with it — `files: { changed, made, gone }` — beside what the model says it did, how often it was asked, and how often the conversation was cut either way (`forgotten`, `summed`). A command has the seconds the model gives it (1,800 at most), and the model is told so. Change it.
