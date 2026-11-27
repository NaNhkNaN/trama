# @trama-dev/cli

> Agents don't need frameworks. They need a runtime.

The command line of [trama](https://github.com/NaNhkNaN/trama): a runtime in which an agent's behaviour lives as programs. A program is TypeScript, in a project of its own. It is run, recorded call by call, held to a budget and to what it says it takes and gives, checked, kept as versions, and gone back from.

```bash
npm install -g @trama-dev/cli
```

Node 22.19 or later, on macOS or Linux. Models are asked through [pi](https://github.com/earendil-works/pi), which needs a provider's key as pi takes one: in the environment, or in `~/.pi/agent/auth.json`.

## A program that is kept

```bash
trama create digest "fetch the top ten Hacker News stories and write digest.md"   # a model writes program.ts
trama run digest                  # run it; one that crashes is fixed in a copy, and the fix installed only if it works
trama update digest "also say how many comments each story has"
trama history digest              # the versions it has had, and how the runs of each went
trama rollback digest 1           # go back to one
```

A project is a directory under `~/.trama/projects`: its `program.ts`, a `meta.json` that says what a run of it takes and gives, its history, and the record of its runs.

## Programs that come with it

What has a policy in trama is a program: the harness a model works in, the judge of a run, whoever fixes a program or writes one, the loop that improves one. Each comes as an example, to copy, read, run and change.

```bash
trama examples                                    # what there is
trama examples coding-harness --as my-harness     # copy one among your projects
trama examples check-by-command
trama run my-harness --workspace ./code --arg task="make the failing test pass" --check check-by-command
```

The last line has a harness work on a codebase, and its work judged by a command (`npm test`, unless the judge is told another) in a copy of what it left.

## Commands

| | |
|---|---|
| `create <name> <prompt>` | Have a program written from a prompt: `--with <project>` says who writes it, `--contract <file>` what it is to take and give, `--arg` its own arguments. |
| `run <name>` | Run it: `--arg`, `--workspace <dir>`, `--budget cost=2` (or `tokens=`, `calls=`), `--check <project>`, `--at-version <n>`, `--timeout <ms>`, `--json`. |
| `update <name> <prompt>` | Have it rewritten: `--from <n>`, `--beside` (kept as a version, not installed), `--with`, `--contract`. |
| `add-version <name> <file>` | Put a program you wrote yourself on record as a version: validated, not installed. |
| `history <name>` | Its versions, and how the runs of each went (`--runs`, `--json`). |
| `rollback <name> <version>` | Go back to a version. |
| `describe [name]` | What a project says of itself: what it is for, what a run takes and gives (`--json`). |
| `journal <name> [run]` | What a run did, call by call, and what it used. |
| `replay <name> [run]` | Run a program again with its calls answered from the record of a run: nothing is carried out. |
| `examples [name]` | List the programs that come with trama, or copy one (`--as`). |
| `api` | What a program is, for whoever writes one: where a project is, how a contract is written, the runtime's API, programs to go by. |
| `list`, `logs <name>` | The projects; what the last run of one logged. |

`trama <command> --help` says each in full.

## For an agent, or a script

`trama describe --json` says what every project takes and gives, as JSON Schema. `trama run <name> --json` puts one document on standard output — the run's status, its result, its check — and everything said as the run goes on standard error. `trama history <name> --json` is a project's versions and runs. `trama api` is all that is needed to write a program without having trama write it.

Who fixes, who writes and who judges by default, the budget of a run, and the agents from outside a program may call are said in `~/.trama/config.json`.
