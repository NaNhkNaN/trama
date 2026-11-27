# program-fixer

A fixer of programs, written as a program: what trama does where nobody is named to fix one, in some sixty lines with their comments, to be read and changed.

Where a run's program fails, trama asks for a fix: of the project the run or the configuration names, and where none is named, of its own agent, once, in a copy of the failing project, in words that are in the runtime. This project is those words and that one asking, as a program: what the agent is asked by it is what the runtime asks, to the letter (a test holds the two together).

To use it, copy it among your projects and name it:

```sh
trama examples program-fixer
```

```jsonc
// ~/.trama/config.json
{ "repairWith": "program-fixer" }
```

or for one run of a program of yours: `runProgram({ projectDir, repairWith: "program-fixer" })`.

What it is, and is not:

- **Its wording is the policy, and is yours to change** — what the agent is asked (`ask`, in `program.ts`), which model (the one the failing project was made with, where its `meta.json` says one), how the answer is read. It is a project like any: a change to it is a version, validated, on record, and gone back from.
- **What trama does round a fix is trama's, whoever fixes**: the copy, the trial of what comes back, what is kept of it. A fixer is not itself fixed where it fails, and a project is not asked to fix itself.
- **It asks the runtime's agent, once, at work in the copy** (`agent.instruct(…, { workspace: true })`). `examples/repair-harness` keeps the conversation with the model itself instead, with tools of its own.
- **It can say that there is no fix**: where the agent's answer begins "NO FIX:", it answers `{ unfixable }` with the reason, and the run failed as it had.
- **Run with nothing to fix it says so and ends**: that is how a new version of it is validated.
