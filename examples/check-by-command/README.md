# check-by-command

A checker, written as a program: thirty lines, to be read and changed.

That a run ended as done is its program's own word. Where a run names a project to check it, that project's program is run once the run is done, and says what the work is worth: `{ ok, score?, notes? }`. This is such a project. It says it by a command — the work is good where the command ends well — run in a copy of the project as the run left it.

To use it, copy it among your projects and say what command checks:

```sh
trama examples check-by-command
```

```jsonc
// ~/.trama/projects/check-by-command/meta.json
{ "input": { "prompt": "…", "args": { "command": "npm test", "seconds": 600 } } }
```

Then name it for one run — `trama run <name> --check check-by-command`, or `runProgram({ projectDir, checkWith: "check-by-command" })` — or for every run of a project, in that project's `meta.json`: `"checkWith": "check-by-command"`.

What it found is in the run's result (`check`), in a line where the run was started, and in the run's journal — `trama journal <name>` — with the hash of this program as it was when it checked: verdicts are comparable where the checker is the same. `trama run` ends with 1 where the check says the work is not good, or could not be made.

A checker stays as it is while the program it checks is changed, by an update or a fix: that is why it is a project of its own, and no part of that program. Nothing keeps a program from reaching it all the same — there is no boundary yet — so that it was changed is what shows, by the hash.

It is a starting point. A checker is a program like any: its workspace is the copy, and it is handed the run it checks — `result` (what the program ended with), `args` (what the run was started with), `journal` and `run` (the run's record, and its id), `used` (what the run had used of a model when the check began: `{ calls, tokens, cost }`, by the runner's own count), and `workspace` (where the run worked, where that was not its project). One that knows more could put in tests that were held back, ask a model for its judgement, or hold the program to its earlier runs (`replayAll`).
