# update-by-harness

A writer of updates, written as a program: some forty lines, to be read and changed.

Where a project's program is to be rewritten — `trama update`, or a program's `updateProject` — trama asks for the new one: of pi's agent, unless the update or the configuration names a project to ask instead. This is such a project. It writes nothing itself. It words what is asked, has a harness do the work in the copy of the project it was handed, and hands back `program.ts` as the harness left it.

To use it, copy it among your projects with a harness (`examples/coding-harness` works in its run's workspace, which is what this needs), and name it:

```sh
cp -R examples/update-by-harness ~/.trama/projects/update-by-harness
cp -R examples/coding-harness ~/.trama/projects/coding-harness

trama update my-project "also count the comments" --with update-by-harness
# or for every update: "updateWith": "update-by-harness" in ~/.trama/config.json
# or by a program: updateProject("my-project", "…", { updateWith: "update-by-harness" })
```

What it is, and is not:

- **What trama does round the writing is trama's, whoever writes**: the copy, the validation of what comes back, the version on record, what is installed and what is kept. A writer answers with a program; it does not install one.
- **It is handed the least**: what is asked (`prompt`), the program it is written from, whether what is made beside the program is kept, the API a program has, and where its copy is. Not where the project is, nor its history, nor the records of its runs. What more a writer is to read, whoever asks for the update says in the prompt — a loop that holds inputs back decides so what its writer can reach.
- **The copy has what the project says of itself**: `meta.json`, with what a run takes and gives. The harness is told that the program is held to it.
- **Its wording is the policy** — the dozen lines of `task` in `program.ts` — and is yours to change, as the harness is yours to choose: `harness`, `model`, `turns` and `seconds` in this project's own `meta.json` (`"args": { "model": "provider/a-large-one" }` has a large model write what a small one runs).
- **A better harness is a better writer.** And since the harness is a project like any, it can be updated by this very writer: `trama update coding-harness "…" --with update-by-harness` has the harness write the next version of the harness — validated as any update is.
- **Run with nothing to write it says so and ends**: that is how a new version of it is validated, which shows that it loads and no more. Whether a writer writes well is for a judge to say, over updates it was asked for (see `examples/improve-by-check`, with `from`).
- A writer need not be this. Anything that is run in a copy and answers `{ program }` is one: a loop of its own over `agent.complete`, as `examples/repair-harness` has; or a program that hands the copy to some other program.
