# improve-by-check

The loop, written as a program: some hundred lines, to be read and changed.

A run of it is one round. It finds out how a project's program does — by a judge, on inputs you name — asks for an update with what was found wanting, finds out how the new program does, and keeps the better of the two: the new one is made the project's program, or the program stays what it is.

trama has the facts and the moves, and no opinion. Every run of a project leaves a line in its history, with the version it was of and what its check said (`trama history <name>`); a version is written and kept beside the program, run by its number (`trama run <name> --at-version N`), and made the program (`trama rollback <name> <version>`). A program has the same: `readHistory`, `updateProject` with `install: false`, `runProgram` with `version`, `rollbackProject`. **Which version is the better is said in this program** — in `better`, ten lines from its top — and nowhere else.

To use it, copy it among your projects, with a judge (see `examples/check-by-command`):

```sh
trama examples improve-by-check --as improve
trama run improve --arg project=my-project --arg check=my-judge \
  --arg inputs='[{"word":"a"},{"word":"b"}]' --arg heldBack='[{"word":"c"}]' \
  --arg ask="Say every word in capitals."
```

It ends with what it did, and why: `{ kept, from, to, before, after, each, why }`. `before` and `after` count the runs that decide — of the inputs held back, where there are any — and `each` says the same of every input by itself, in the order they were given (`{ input, heldBack, before, after }`): which input it was that went wrong is not in a project's history, which is by version. Run again, it is the next round. (`to` is the version that was written and judged. Where it is kept it is made the program as a version more, of its text: `trama history` shows both.)

What it takes and gives is said in its `meta.json`, and held: a round with an argument it does not take, or without `project` and `check`, is refused before anything is run.

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
- `write` — who writes the update: a project, by its name (`examples/write-by-harness` is one) — else whoever the configuration names (`updateWith`), or pi's agent. It is told what this loop tells its writer, in those words, and no more: what more a writer may read — the project's history, the records of its runs — is for the loop to say there, and with that what of the inputs held back it can reach.
- `from` — what a run works on, where that is not the project itself: a directory, copied afresh for every run and handed to it as its workspace. `{name}` in it stands for the input's argument of that name: `--arg from=/tasks/{task}`, for inputs that say which task. (An argument an input has for this alone, which the project does not say it takes, is left out of what its run is given, and said: the project need not be changed for it.)

What to know of it:

- **The runs are of the project in place**, one after another. So it is for a project that is given arguments and ends with a result.
- **A run that uses up what it works on is given a fresh copy of it** (`from`). That is how a harness is improved over tasks: the harness is the project (`examples/coding-harness` works in its run's workspace where it has one), each task is a directory, and every run of every version begins from the task as it was. The judge is handed where the run worked (`workspace`, among its arguments), and the copy is removed once the run is judged. The verdicts are on the harness's own record, by version and by task: a round after another pays for none twice here either.
- **It pays for no run twice.** A verdict that is on record — of this program, on this input, by this judge as it is now — is taken from the record. (Of this program by its text: a version made the program is the text that was judged beside it, and has the verdicts it had.) A round after another runs only what is new.
- **The new version is tried beside the program, and is not the project's program until it is kept**: whoever runs the project meanwhile runs the program as it was. Where it is not kept — or anything goes wrong while it is tried, or the round is stopped in the middle — there is nothing to put back: the version stays on record, with what its runs came to. Where it is kept, it is made the program, as a version more: history only grows. (Its runs are made in the project as it is: of a project whose program keeps a state, the version that is tried writes that state too.)
- **A run that fails is made again, once.** What fails a run is not always its program: a model that cannot be reached fails it as a fault of the program does, and the loop cannot tell which. So the second is what counts (the first is on the project's record, and the result says how many were made again: `remade`). Where the second fails too:
  - of the program as it is, it is a run found wanting — the writer is told what it said as it failed, and that is what there is to mend;
  - of a version that is being tried, **the round decides nothing**: the program stays, and the version is not found worse for it. The round after is told of it as what it is — written, and not judged — with what the run said as it failed and what the version changed. (Where the run was of an input that is held back, nothing of what it said: a program can say as it fails what it was started with. Whoever runs the loop has it, in the round's `why`.)
  - What this does not catch: a version that fails now and then by its own fault passes for one that does not, where the run made again goes through. `remade` is where that shows.
  - None of these runs is fixed where it fails: a fix would be another version, in the middle of what is held against each other.
- **By `score`, how often a version is good is counted over every run there is** — those of inputs that are shown too, and those made again — input by input, so that more runs of a hard input are not held against it. It takes many runs to see that a version is a little less often right, and a version that uses less by doing less is what such a loop finds first. Even so: a version that is right nine times in ten passes a dozen good runs one time in four. What a round decides is a reason to count, not the count.
- **A round is told what the rounds before it tried.** A version that is not kept leaves the program as it was, and the next round begins from that again: its writer is told of each version that was written from this very program, judged, and not kept — what its runs came to, on what decides, and what it changed (a diff, from the project's history). Where inputs are held back, that is one count and one mean of them a round: it is the reason the version was not kept, and it is all of them a writer ever hears.
  It is read from the project's history, and the loop keeps no list of it: a version's line says which it was written from, and its runs say what the judge found. A version is told as tried where it was judged whole — as many verdicts of this judge as a round makes, of every input; one a check of which could not be made, or whose round fell over, was never found no better, and is not told as if it had been. (Of each text its latest version; and the latest 500 runs are read — of a version whose runs are older than those, nothing is told.)
- **What the judge said is told whole.** A project's history keeps the beginning of a verdict's notes. The loop keeps the rest itself (in its state: of the program as it is, of the inputs that may be shown), so that a round whose verdicts come from the record tells its writer as much as the round that made the runs did. The same of what a run said as it failed twice: a line of history has its first line. Words are all the loop keeps.
- **It stops without deciding**, and says so, where the update came to nothing, or a check could not be made. Its `why` has what the failure said without the stack it was said with: all of it is on the record of what failed (`trama journal <project>`, or the writer's, or the judge's).
- **An update costs what an update costs**: the model writes the program, and the program is run once to validate it.
- What each version used, and took, is not part of the rule here. `trama history <project>` shows it, version by version.
