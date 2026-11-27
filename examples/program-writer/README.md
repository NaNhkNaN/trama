# program-writer

A writer of programs, written as a program: what trama does where nobody is named to write one, in some hundred lines with their comments, to be read and changed.

Where a project's program is to be written — its first (`trama create`, `createProject`) or its next (`trama update`, `updateProject`) — trama asks for it: of the project the call or the configuration names, and where none is named, of its own agent, once, in a copy of the project, in words that are in the runtime. This project is those words and that one asking, as a program: what the agent is asked by it is what the runtime asks, to the letter (a test holds the two together).

To use it, copy it among your projects and name it:

```sh
trama examples program-writer

trama create my-project "count the comments of each story" --with program-writer
trama update my-project "also count the points" --with program-writer
# or for every one: "createWith": "program-writer", "updateWith": "program-writer" in ~/.trama/config.json
```

What it is, and is not:

- **Its wording is the policy, and is yours to change** — what the agent is told (`system` and `ask`, in `program.ts`), the programs a first program is shown to go by (`example-programs.txt`, beside it), which model is asked (the one the project was made with, where its `meta.json` says one), how the answer is read. It is a project like any: a change to it is a version, validated, on record, and gone back from by `trama rollback`. And it can be asked to write its own next version: `trama update program-writer "…" --with program-writer`.
- **What trama does round the writing is trama's, whoever writes**: the copy, the validation of what comes back, the version on record, what is installed and what is kept.
- **It asks the runtime's agent, once, at work in the copy** (`agent.instruct(…, { workspace: true })`), and takes the program from its answer (`stripCodeFences`). `examples/write-by-harness` has a harness do the work instead — which looks before it writes, and changes a line of a long program where this has the whole written out again.
- **It can say that there is no program to be written**: where the agent's answer begins "NO PROGRAM:", it answers `{ unwritable }` with the reason, and whoever asked is told why. Nothing is validated, and nobody mends that into a program.
- **Run with nothing to write it says so and ends**: that is how a new version of it is validated, which shows that it loads and no more. Whether a writer writes well is for a judge to say, over programs it was asked for (see `examples/improve-by-check`, with `from`).
