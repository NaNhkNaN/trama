# write-by-harness

A writer of programs, written as a program: some seventy lines with their comments, to be read and changed.

Where a project's program is to be written — its first (`trama create`, `createProject`) or its next (`trama update`, `updateProject`) — trama asks for it: of pi's agent, unless the call or the configuration names a project to ask instead. This is such a project. It writes nothing itself. It words what is asked, has a harness do the work in the copy of the project it was handed, and hands back `program.ts` as the harness left it.

To use it, copy it among your projects with a harness (`examples/coding-harness` works in its run's workspace, which is what this needs — as `examples/harness-by-agent` does, which has an agent from outside do the writing), and name it:

```sh
trama examples write-by-harness
trama examples coding-harness

trama create my-project "count the comments of each story" --with write-by-harness
trama update my-project "also count the points" --with write-by-harness
# or for every one: "createWith": "write-by-harness", "updateWith": "write-by-harness" in ~/.trama/config.json
# or by a program: createProject("my-project", "…", { createWith: "write-by-harness" })
```

The writer looks for its harness by the name `coding-harness`. One copied under another name (`trama examples coding-harness --as my-harness`) is to be named to the writer: `"args": { "harness": "my-harness" }`, under `"input"` in the writer's own `meta.json`. Where it finds none, it says so before anything is asked of a model.

What it is, and is not:

- **What trama does round the writing is trama's, whoever writes**: the copy, the validation of what comes back, the version on record, what is installed and what is kept. A writer answers with a program; it does not install one.
- **It is handed the least**: what is asked (`prompt`), the program it is written from (none, at a project's making), whether what is made beside the program is kept, the API a program has, and where its copy is. Not where the project is, nor its history, nor the records of its runs. What more a writer is to read, whoever asks says in the prompt — a loop that holds inputs back decides so what its writer can reach.
- **What a project says of itself is the project's.** The copy has the project's `meta.json`, with what a run takes and gives; the harness is told that the program is held to it. What a writer does to that file is put back before its program is tried, and none of it is kept — **but at a project's making**: there the copy's `meta.json` has no program's contract yet, and what the harness says in it — `description`, `parameters`, `returns`, and those alone, of what whoever asked for the project did not say — is the project's from then on.
- **Its wording is the policy** — the lines of `task` in `program.ts` — and is yours to change, as the harness is yours to choose: `harness`, `model`, `turns` and `seconds` in this project's own `meta.json` (`"args": { "model": "provider/a-large-one" }` has a large model write what a small one runs). And the programs a first program is shown to go by: `example-programs.txt`, beside it.
- **A better harness is a better writer.** And since the harness is a project like any, it can be updated by this very writer: `trama update coding-harness "…" --with write-by-harness` has the harness write the next version of the harness — validated as any update is.
- **It works in the copy, and changes what is there**: for a long program, of which one thing is to change, that is a line edited and not the whole written out again by a model.
- **Run with nothing to write it says so and ends**: that is how a new version of it is validated, which shows that it loads and no more. Whether a writer writes well is for a judge to say, over programs it was asked for (see `examples/improve-by-check`, with `from`).
- A writer need not be this. Anything that is run in a copy and answers `{ program }` is one: a loop of its own over `agent.complete`, as `examples/repair-harness` has; or a program that hands the copy to some other program.
