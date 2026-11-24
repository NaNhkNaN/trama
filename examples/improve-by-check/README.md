# improve-by-check

The loop, written as a program: some hundred lines, to be read and changed.

A run of it is one round. It finds out how a project's program does — by a judge, on inputs you name — asks for an update with what was found wanting, finds out how the new program does, and keeps the better of the two: the new one, or the one before, gone back to.

trama has the facts and the moves, and no opinion. Every run of a project leaves a line in its history, with the version it was of and what its check said (`trama history <name>`); a project is changed by an update, and by going back to a version (`trama rollback <name> <version>`). A program has the same: `readHistory`, `updateProject`, `rollbackProject`. **Which version is the better is said in this program** — in `better`, ten lines from its top — and nowhere else.

To use it, copy it among your projects, with a judge (see `examples/check-by-command`):

```sh
cp -R examples/improve-by-check ~/.trama/projects/improve
trama run improve --arg project=my-project --arg check=my-judge \
  --arg inputs='[{"word":"a"},{"word":"b"}]' --arg heldBack='[{"word":"c"}]' \
  --arg ask="Say every word in capitals."
```

It ends with what it did, and why: `{ kept, from, to, before, after, why }`. Run again, it is the next round.

What it is told:

- `project` — the project to improve, by its name among your projects.
- `check` — the project that judges a run of it, by its name. Its verdict is `{ ok, score?, notes? }`.
- `inputs` — what to run the project on: a list of arguments. Of these, what was found wanting is shown to the model that writes the update: the input, and the judge's notes.
- `heldBack` — more inputs, run and judged as the others and **never shown**. Where there are any, they alone decide. A program can be written to the inputs its writer was told of; what decides is to be out of reach of what is decided on.
- `runs` — how many runs of each input (1). The default is a default, and no advice: one run does not rank two versions.
- `ask` — what is wanted, in words: beside what was found wanting, or where nothing was.
- `by` — how a version is found the better: `good` (the rule above: how often it is found good, then its score) or `score` — the mean score, provided it is no less often good. For when the work is done right already and it is something else that is to be better: what a run uses, say, with a judge whose score is of that (it is handed `used`, the runner's own count of what the run used of a model).
- `margin` — by how much a mean score has to be higher (0). A score that is measured is never a tie: without a margin, a version that is no different is kept one round in two.
- `confirm` — how many times the runs that decide are made again where a version passes (0), and counted with the first. A version is chosen by the runs in which it looked best; it is to be kept for more than those.
- `tell` — which runs the writer is told of: `wanting`, or `all` — what the judge said of the runs found good too. Where what is wanted is not that they be good, that is all a writer has to go by.
- `from` — what a run works on, where that is not the project itself: a directory, copied afresh for every run and handed to it as its workspace. `{name}` in it stands for the input's argument of that name: `--arg from=/tasks/{task}`, for inputs that say which task.

What to know of it:

- **The runs are of the project in place**, one after another. So it is for a project that is given arguments and ends with a result.
- **A run that uses up what it works on is given a fresh copy of it** (`from`). That is how a harness is improved over tasks: the harness is the project (`examples/coding-harness` works in its run's workspace where it has one), each task is a directory, and every run of every version begins from the task as it was. The judge is handed where the run worked (`workspace`, among its arguments), and the copy is removed once the run is judged. The verdicts are on the harness's own record, by version and by task: a round after another pays for none twice here either.
- **It pays for no run twice.** A verdict that is on record — of this program, on this input, by this judge as it is now — is taken from the record. (Of this program by its text: a version gone back to is the program it was, and has the verdicts it had.) A round after another runs only what is new.
- **While the new version is tried, it is the project's program**: whoever runs the project meanwhile runs it. Where it is not kept — or anything goes wrong while it is tried — the one before is put back, as a version more: history only grows. A round that is stopped in the middle leaves the new one there; `trama rollback` goes back.
- **A run that fails is a run that was not found good.** None of these runs is fixed where it fails: a fix would be another version, in the middle of what is held against each other.
- **By `score`, how often a version is good is counted over every run there is** — those of inputs that are shown too, and those made again — input by input, so that more runs of a hard input are not held against it. It takes many runs to see that a version is a little less often right, and a version that uses less by doing less is what such a loop finds first. Even so: a version that is right nine times in ten passes a dozen good runs one time in four. What a round decides is a reason to count, not the count.
- **A round is told what the rounds before it tried.** A version that is gone back from leaves the program as it was, and the next round begins from that again: its writer is told of each version that was written from this very program and not kept — what its runs came to, on what decides, and what it changed (a diff, from the project's history). Where inputs are held back, that is one count and one mean of them a round: it is the reason the version was gone back from, and it is all of them a writer ever hears.
- **What the judge said is told whole.** A project's history keeps the beginning of a verdict's notes. The loop keeps the rest itself (in its state: of the program as it is, of the inputs that may be shown), so that a round whose verdicts come from the record tells its writer as much as the round that made the runs did.
- **It stops without deciding**, and says so, where the update came to nothing, or a check could not be made.
- **An update costs what an update costs**: the model writes the program, and the program is run once to validate it.
- What each version used, and took, is not part of the rule here. `trama history <project>` shows it, version by version.
