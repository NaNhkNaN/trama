# program-fixer

Who fixes a program that failed where nobody else is named: a program, some sixty lines with their comments, to be read and changed.

Where a run's program fails, trama asks a project for a fix: the one the run names (`repairWith`) or the configuration does, and where none is named, this one. It comes with the runtime, and is put among your projects the first time it is wanted — before a run that may be fixed begins — which is said, once. From then on it is yours: trama has no words of its own to a model for a fix; what the agent is asked is what `program.ts` here says.

What it is, and is not:

- **Its wording is the policy, and is yours to change** — what the agent is asked (`ask`, in `program.ts`), which model (the one the failing project was made with, where its `meta.json` says one), how the answer is read. It is a project like any: a change to it is a version, validated, on record, and gone back from.
- **What is here is who fixes, whatever comes with a later trama.** A newer runtime does not lay its fixer over yours: move this directory away to have the one that came with it, or put its `program.ts` on record as a version.
- **What trama does round a fix is trama's, whoever fixes**: the copy, the trial of what comes back, what is kept of it. A fixer is not itself fixed where it fails, and a project is not asked to fix itself.
- **A run cannot change what fixes it**: a run that may be fixed by this project cannot have it changed through its runner, nor can a run that one started. It is changed by the command line, by hand, or from a run that is not to be fixed (`maxRepairAttempts: 0`).
- **It asks pi's agent, once, at work in the copy** (`agent.instruct(…, { workspace: true })`). `examples/repair-harness` keeps the conversation with the model itself instead, with tools of its own.
- **It can say that there is no fix**: where the agent's answer begins "NO FIX:", it answers `{ unfixable }` with the reason, and the run failed as it had.
- **Run with nothing to fix it says so and ends**: that is how a new version of it is validated.
