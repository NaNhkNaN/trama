# Changelog

All three packages (`@trama-dev/runtime`, `@trama-dev/session`, `@trama-dev/cli`) are released together under one version.

## Unreleased

### Fixed

- **A file could be written outside the project through two links.** With `first` a link to `second`, and `second` a link to a file outside the project that did not exist yet, `tools.write("first", …)` created that file. The guard followed only one link whose destination was missing, and looked for the nearest existing directory with a check that cannot see such a link — so a path below a directory link pointing outside and at nothing passed too. It now follows every link on the way to a path, whether or not what it points at exists, and refuses links that lead back to themselves. `workspace.write` was not led outside, but through a chain of links it replaced the link in the middle with the file; it now writes where the chain ends.
- **A file outside the project could be read through a link whose target goes up after another link.** With `here` a link to `.` and `a` a link to `here/../secret.txt`, every link points inside the project as text — but the system takes `..` from where `here` leads, and reads the file beside the project. `tools.read`, `workspace.read`, `workspace.observe`, a `shell` `cwd`, and the runtime's own files (`state.json`, `history/`, `.gitignore`) all went by the text. The guard now walks a path the way the system does, one step at a time, and `workspace.list` resolves links the same way, so what is listed is what can be read. A link target that is not valid UTF-8 is refused rather than guessed at. So is a path the system would not follow: one that goes on from a file, says with a closing slash that a file is a directory, leads on from something that does not exist, passes through a link to nothing or a directory it has no leave to search, or follows more than 32 links. The guard now ends by asking the system: where the system can follow a path it must arrive where the guard's own walk did, and where it cannot, that must be because nothing is there yet.
- **A path a program gives is read the way the system reads it.** The guard followed links step by step, but only after the path it was handed had been tidied up as text — so everything it had learned to refuse inside a link was still let through when written out directly. `tools.write("notes.txt/", …)` overwrote `notes.txt`; `write("missing/.", …)` created a file called `missing`; `write("notes.txt/../other.txt", …)`, or the same through a directory with no leave to search, overwrote `other.txt`; and with `deep` a link to `a/b`, `tools.read("deep/../item.txt")` read the project's `item.txt` where the program's own `fs.readFileSync` reads `a/item.txt`. None of these left the project. The path is now walked as it is written, and the check against the system at the end is made of the path as written too. A path that only leaves the project as text — `deep/../../item.txt` above — is no longer refused, since it never leaves it. `tools.shell`'s `cwd` and the workspace calls are read the same way. A link that names a directory of the project in other letters than the directory has, on a file system that takes the two for one name, is no longer refused as leading outside: whether a path ends up inside the project is decided by what the directories are, not by how they are spelled.
- **A run's journal could be written beside the project.** The journal directory was worked out with the same textual reading of `..`: with `logs` a link to `x/../..` and `x` a link two directories down, the guard and the system both take `logs/journal` to be inside the project, and the journal went to a directory of that name above it. Nothing in the runtime asks Node where a path leads any more; one walk answers for all of it, and a test keeps it that way.
- **A `create` or `update` that fails while installing the program leaves the project as it was.** The new program is written beside the old one, the version is recorded in `history/`, and only then does the new program take the old one's place, in one move — and if any of that fails, what was done is taken back. Before, `program.ts` was overwritten first: a `create` whose version could not be recorded left a program installed that was not in the history, and a write cut short left half a program. A `program.ts` its owner has made read-only is still not replaced. Taking a version back never removes what another run of the project recorded in the meantime, and a version is never written over a version file that is already there. The message of a failed `update` now says the program is unchanged — which is what it can promise — where it said the project was.
- **`agent.generate` with a schema type it does not support fails before asking.** It used to ask the model, find that no reply could satisfy the schema, ask again, and only then report the schema.
- **A `meta.json` that is not JSON, or has no `input` object, is reported as that,** naming the file and what it needs to hold, rather than as a syntax or type error from wherever its contents were first used. The `model` and `provider` it names are held to what the global config is held to — an empty or mistyped one is an error, not a quiet return to the global model; `null` is a field left out. A file that holds `null` where an object is expected is said to hold null, not "object", and a `null` in `~/.trama/config.json` is a field left out, as it is in `meta.json`.
- **A state that cannot be written leaves `ctx` as it was.** A failed `checkpoint()`, `done()` or `yield()` had already advanced the iteration marker and cleared or set the yield marker in `ctx.state` before the write failed.
- `ctx.log` no longer throws over data that cannot even be described — a circular object with no prototype. And the optimisation loop shown to the model as an example (and in the README) no longer ends in an error when nothing improved: it passed `Infinity` to `ctx.done()`.
- A stop asked for with a signal that had already fired when it was handed over now takes effect; it was only listened for from then on.
- **A repair that worked becomes the project's program before anything its run wrote reaches the project,** and in one move, the way `create` and `update` install one. The order was the other way round: what the run wrote was merged first — `program.ts` among it, copied over in place — so a project that could not take the new program was left with the new state beside the old program. Now such a fix leaves the project as it was, and the run fails with the reason.
- **Once a run has ended, its state is settled.** `ctx.checkpoint()` after `ctx.done()` or `ctx.yield()` is refused. After a yield it erased the marker the next run resumes from, and the program yielded again for ever; after `done()` it rewrote the state the run had ended on. A call that is refused, or a repeated `done()`, no longer takes the state it was handed either.
- **A `program.ts` its owner has made read-only no longer breaks the run that tries to repair it, or the update that validates its successor.** The copy a fix or a candidate is tried in carried the file's permissions, and the candidate was written into it: `trama run` threw a permission error naming a temp directory instead of reporting the failed run, and `trama update` threw the same after the model had already written the new program. A copy's program is now the copy's own file. And whether the project's program can be replaced at all is asked before the work whose only use is to replace it: a read-only program that fails is reported as failed with no fix asked for, and `update` refuses before generating. The same holds for a project directory nothing can be created in.
- The bridge answers a request whose body is not a JSON object with 400. `null` was a 500, and a string or an array was carried out as a request with no fields.
- **Every field of a bridge call is declared, and held to its kind.** Only some were: a `cwd`, `timeout`, `system`, `headers` or `expect` of the wrong kind went through to whatever used it, and came back as a 500, or as something stranger — `tools.shell` with a `timeout` that was not a number answered with an internal error in the command's `stderr`. They are 400s now, and a field a call does not declare is not passed on.
- **A number JSON cannot carry is refused where the call is made.** `runProgram({ timeout: Infinity })` inside a program crossed the bridge as `null`, which the runner reads as a field left out, and ran under the default timeout — where the same call outside a program is an error. So did `tools.shell(…, { timeout: NaN })`, and such a number anywhere in a run's `args`. The call now fails in the program, naming the field. Log data is the exception it always was: it is recorded as JSON makes of it.
- `workspace.write` that cannot put its file in place no longer leaves its temp file in the workspace, and refuses the workspace itself as an artifact path (`""`, `"."`) instead of briefly creating a temp file beside it. Its temp file is created under a name that cannot be guessed, and never opened if the name is taken: a link planted where the temp file would go used to be written through, to wherever it pointed. A temp file left behind by a runner that was killed in the middle is no longer listed or observed as an artifact, and an artifact that is replaced keeps its permissions. The timeout of `workspace.observe` is measured on a clock that cannot be set.

### Added

- **The types of the program-facing API can be imported from `@trama-dev/runtime`:** `Ctx`, `Agent`, `Tools`, `ShellResult`, `Workspace`, `ObserveResult`. The API reference shown to the model has always declared them there; only the values were exported.

### Changed

- **The program a repair leaves is the program as its run left it.** A fix that rewrites its own `program.ts` while it runs is replaced by what it wrote, as it would be in any other run; before, the rewrite was dropped and the fix as the model returned it was installed. Validation in `create` and `update` already worked this way.
- `tools.write` through a link to a file in a directory that does not exist yet creates the directory, as `workspace.write` does. It used to fail.
- `create` and `update` put the new program in place by renaming a new file over `program.ts` rather than writing into it. The file keeps its permissions; a second hard link to the old file keeps the old content.
- Internal, no change in behaviour: one cancellation helper (`abort.ts`) in place of five hand-written listeners; `ctx.done()` without its in-flight lock, now that persisting is one synchronous step; one reader for `meta.json`; one place that decides where a write through links lands, and one that puts a file in place by temp file and rename (`workspace.write` and installing a program had one each); one guard function, which answers where a path leads (there were two, one answering with the path as given); one function that makes the copy of a project a program is tried in (three places wrote the program into a copy themselves); the runner's side of `ctx` takes the state as an argument of each call that persists it, instead of mirroring the program's `ctx` and being assigned the state first, and is where a run's ending is kept (the runner kept a second record of it); a bridge call's handler is typed by the fields it declares.

## 0.4.0 — 2026-11-11

### Added

- **The journal: a record of every run.** Each call a program makes through the bridge is written down as it happens — the request when it arrives, the result or the error when it is answered — along with which program was run, how each attempt exited and what it printed, each fix that was asked for and what came back, and how the run ended. One file per run, `logs/journal/<run>.jsonl` in the project, appended to as things happen, so the journal of a run that died is true up to where it died.
  - A repair is recorded as part of the run it repairs, including an attempt whose fix did not work — which used to leave no trace at all, having run on a copy that was thrown away.
  - A session is a tree of journals: the journal of a program says which run each of its `spawn()` calls started, and that run's journal says which call started it.
  - `trama journal <name> [run] [--list]` shows a run call by call, or lists the runs on record.
  - `"journalRuns"` in `~/.trama/config.json` sets how many runs of a project keep their journal (default 20; 0 records nothing).
  - A journal holds what the program did — prompts and answers, file contents, commands and their output. Credential-looking headers of web requests are redacted; nothing else is. It is bounded: a text over 256 KB is cut to its beginning, a record holds about 1 MB and lists what it lost in its `cuts`, and a journal past 64 MB stops taking down calls. Journals are readable by their owner only and live under `logs/`, which is kept out of version control.
  - Recording never changes a run: a journal that cannot be opened or written says so once, and the run goes on.

### Fixed

- **A shell command that reads its input no longer waits for its timeout.** `tools.shell` gave every command an input that was never closed, so `cat`, or anything else that reads standard input, sat until it was killed. A command now has no input and finds it at an end.

### Changed

- When a program fails and no fix comes back, the reason reads `No fix came back: …` after the program's own failure. It used to be a numbered list headed `Repair errors:`, which could only ever hold one entry.
- Internal, no change in behaviour: stopping process groups and the watchdog that does it when the runner is gone are one module; the journal's reader is apart from the runner surface; a run's journal is ended in one place.

## 0.3.1 — 2026-11-11

### Changed

- **One runner runs a whole session.** A program that spawned participants used to run them itself: `Session.spawn()` started a second, complete runner inside the program's own process, which the runner of that program could not see. Starting a run is now a call on the bridge, like any other the program makes, and the runner that is running the program carries it out. `Session`, `spawn()`, `wait()` and `resume()` are used as before. What follows from it:
  - A participant is stopped with the program that spawned it by the runner itself. It no longer depends on that program being able to act: a coordinator that hangs, or is killed outright, does not strand its participants or their shell commands.
  - A participant's output is written by the runner, each line under the participant's name. It is no longer part of its parent's output, and so no longer appears in the parent's failure report or repair prompt.
  - A participant that cannot be run at all — its project is missing, say — makes `wait()` reject as before, but the message now starts with `trama runtime error:`.
  - A participant runs with the runner's environment, not the environment of the program that spawned it. A program that changed `process.env` to affect the runs it starts no longer does.
  - Programs may run programs up to 16 deep, and one runner carries up to 128 runs at a time. There was no bound before.
  - A program that uses a session no longer loads the runner and the agent into its own process. Importing the session layer went from about 0.7 s and 80 MB to about 30 ms and 9 MB (measured once each, on one machine).
- The program that creates a session reaches its workspace through the bridge too, instead of touching the directory itself.
- **`create` and `update` no longer run a program's participants.** Validating a program meant running it to the end — and for a program that runs others, that ran them too: for real, in their own projects, at their own cost, and with a crash among them repaired in place. A participant named by a relative path was not found at all, so a correct program failed. A validation now ends, successfully, the moment the program asks for another program to be run. What the program does after that point is first exercised when it is run.
- **The runner no longer handles signals.** It used to catch SIGINT, SIGTERM and SIGHUP to stop what it had started, and then pass the signal on. That is the watchdog's job now (see below); a process that embeds the runner keeps its own signal handling entirely.
- **`trama run` stops politely on a signal.** The command now handles SIGINT, SIGTERM and SIGHUP itself: the program is asked to stop and waited for, and then the command ends as the signal would have ended it. A second signal does not wait. Ctrl-C used to return at once and leave the program its grace period in the background.

### Added

- `runProgram({ signal })`: aborting the signal stops the run. Its program is stopped, no repair is attempted, and the run ends as failed once the program is gone; a fix that was being tried leaves no trace. A program that exits cleanly on being stopped has still not finished. It works the same from inside a program.
- `runProgram({ label })`: a name for the run, shown in front of each line of its output. `Session.spawn()` passes the participant's name.

### Fixed

- **A runner that is killed outright no longer leaves its programs running.** SIGKILL, running out of memory, a crash: the runner ran no code on its way out, so its programs, their shell commands and its temp directories — one of them holding the bridge secret — were all left as they were. A small watchdog process now holds a pipe from the runner and is told what the runner starts. When the pipe closes, however the runner went, it stops what is still running and removes the directories. (One thing it is not told about: a shell command the agent itself has running at that moment.)
- Shell commands the agent ran on behalf of a participant could read the bridge secret of the program that spawned it. (0.2.2 closed this for `tools.shell()` only.) The agent no longer runs inside that program.

- A cancelled agent call is given up on at once, whether or not the agent itself notices the cancellation. A run's end no longer depends on it noticing.

### Internal

- pi is loaded when the agent is first called, not when the runtime is. `trama list` and `trama logs`, and programs that never call the agent, do not load it.
- The message by which a runner inside a program asked the outer runner to hold the program's clock is gone, with the inner runner.
- The process that saw a stop through after the runner had exited is gone too: the watchdog is that process, started ahead of time.

## 0.3.0 — 2026-11-11

### Changed

- **A participant that is being repaired stays in its session.** Since 0.2.2 a fix was tried against a private copy of the shared workspace, merged back only if the fix worked. A fix could therefore neither be seen by the other participants nor see them, and any participant that writes a request and waits for a reply failed every repair attempt. A fix now runs against the live workspace. The project is still copied: a fix that fails never touches it.

  The cost is that what a failed fix wrote to the workspace stays there — as what a failed first run wrote always has. A workspace write is immediate and is never undone; see the README for what that asks of a program.

- **A program is no longer timed out for the time its participants take.** A program waiting on a session participant had the same five-minute default as the participant, so a participant that needed a single repair outlasted the program waiting for it — which was killed, taking the participant with it. A timeout now limits a program's own time: its clock stops while a run it started is in flight, since that run is under a timeout of its own.

  This changes what `--timeout` means for a program that runs others. It is no longer a limit on the whole session; the participants' timeouts are what bound it.

### Fixed

- **Stopping the runner no longer leaves the shell commands of session participants running.** A stopped runner killed its program's process group outright. But a program that coordinates others holds a runner of its own, which was killed before it could stop what it had started: the participant went, its shell command stayed. A runner now asks first — SIGTERM, then SIGKILL to whatever is still there after five seconds — both for its program and for shell commands, so that anything holding a runner gets to stop what it started. A program that ignores SIGTERM is therefore killed five seconds after the runner is stopped rather than at once.
- **A program has the whole grace period to act on SIGTERM.** Programs were started through the `tsx` command, which put a process of its own in front of the program — one that killed the program about 60 ms after a SIGTERM it had not yet acted on. A program busy for longer than that never ran its handler. Programs are now run by node directly, with tsx loaded into it.
- **A long-running program does not have to handle SIGTERM to be created or updated.** Validation stops a program once it has been ready for a while. Behind the `tsx` command, a program that simply died of that signal looked like one that had exited with code 143, and was rejected — or sent to be repaired.
- **What a program starts itself no longer outlives its run.** Shell commands run through `tools.shell()` were stopped when a run ended; a process the program started on its own, with `child_process`, was not — it kept running after the program finished or crashed, and was still there when a repair ran. The program's process group is now stopped at the end of every run, and the run is not over until what it started is gone. A process the program deliberately detaches is still left alone.
- **A run ends when its program does.** A process the program had detached, but which still held the program's output open, kept the run from ever ending — timeout included.
- A timeout now kills everything left in the process group after the grace period, not only the process that was started.
- A timeout longer than about 24.8 days expired at once. Timeouts are also no longer thrown off by the system clock being set while a program runs.
- A request to the bridge with a body over 50 MB is answered with 413 and the rest of the body discarded. The connection used to be cut as the answer was sent, so the sender could see a broken connection instead of the reason.

### Internal

- Everything the runtime asks of an LLM goes through one interface, `AgentBackend`: a prompt and where to work in, the agent's final text out. pi is its one implementation. No change in behaviour; it is the seam for other backends.

## 0.2.2 — 2026-11-11

### Fixed

- **A repair no longer puts an unproven fix into the project.** Since 0.2.0 a proposed fix was written into the real project and run there, to be rolled back if it failed. That left the fix installed, with whatever state it had written, if the runner was stopped mid-way, and the rollback itself could fail and lose the only copy of the original. A fix is now tried on a private copy of the project; only a fix that works is installed, together with what its run produced. A fix that fails, or a runner that is stopped, leaves the project untouched because it was never written to. It still runs once.
- **Stopping the runner stops what it started.** Ctrl-C on `trama run`, or a timeout, used to leave the program and its shell commands running. A program that used a session left its participants running when it ended, timed out or yielded — and a repair could then start duplicates beside them. They are now stopped, and temporary files (including the one holding the bridge secret) are removed.
- **A single call can last longer than five minutes.** `agent.instruct()`, `tools.shell()` and `workspace.observe()` failed after 300 seconds whatever the run's timeout was.
- Shell commands run by a session participant could read the bridge secret of the program that spawned it. They no longer inherit it.
- `trama update` no longer copies the whole project aside and swaps it back on failure. The new program is validated off to the side and the project is written only once it works.
- A repair that returns an empty program, or the same program, is reported as such instead of being run again.
- The error text sent to the repair model and written to history is limited to the last part of the program's output, instead of up to 20 MB of it.
- Symlinks inside a project or workspace keep their targets when it is copied for a trial run.

### Changed

- `Session.spawn()` no longer throws synchronously for a missing project directory; like any other project that cannot be run, the failure arrives from `wait()`.
- Merging a successful repair's workspace writes now also applies deletions.

### Internal

- The release workflow is split in two: one job installs, builds, packs and tests with no publishing rights; the other only hands the packed tarballs to npm. Actions are pinned to commit SHAs, dependency install scripts are not run, and npm is no longer installed at release time — the publish job uses the npm that ships with Node 24. A release that fails part-way can be re-run.
- `tsx` and `commander` are pinned to exact versions, as pi already was.

## 0.2.1 — 2026-11-11

No change to how trama behaves; this release exercises the new release process.

### Internal

- Releases are published with npm trusted publishing (OIDC) and the latest npm CLI. The workflow no longer uses a stored npm token.
- Publishing no longer marks older versions as deprecated. (0.1.x was deprecated when 0.2.0 came out and stays that way.)
- `repository.url` and the CLI's `bin` path are written the way npm normalises them, so publishing has nothing to correct.

## 0.2.0 — 2026-11-11

### Breaking

- **Node.js 22.19 or newer is required** (was 20). The upgrade to pi 1.x and commander 15 sets the floor.
- **`agent.ask()` is removed.** It was a deprecated alias; use `agent.instruct()`. A program that still calls it crashes on its next run and goes through repair.
- **`session.workspace` is now the workspace itself**, not its path. It has the same `read` / `write` / `list` / `observe` that participants get from `@trama-dev/runtime`. The path is `session.workspaceDir`.
- **`ctx.done()` and `ctx.yield()` follow one rule:** the first to succeed wins, and a call that fails settles nothing. A failed `done()` used to block `yield()` for the rest of the run.
- **`workspace.observe()` returns multiple matches in plain code-unit order**, the same as `workspace.list()`. It used to sort by locale, which differs between machines.
- **The default model is `claude-opus-5-5`** (was `claude-opus-4-6`). Projects keep the model they were created with.
- pi moved to the `@earendil-works` scope and to 1.x. Project-level pi settings (`.pi/` inside a project) are no longer loaded unless the project is trusted in pi; user-level settings in `~/.pi/agent` are unaffected.

### Security

- **The IPC bridge now authenticates its caller.** The runner listens on a loopback port, and until now any local process that found the port could have it run shell commands while a program was running. Every request must now carry a secret generated for that run and handed only to the program.

### Changed

- **A repair runs the fixed program once**, not twice. (How it does so in 0.2.0 and 0.2.1 has a flaw — see the fix in 0.2.2.)
- `ctx.done()` followed by `ctx.checkpoint()` and a crash is reported as done. It used to be mistaken for a failure and sent to repair.
- `state.json` no longer contains a `__trama_done` key.
- The API reference shown to the LLM when it writes or repairs a program is generated from the real type definitions, doc comments included.
- `trama update` on a hand-written project that has never run scaffolds it first instead of failing.
- `trama create` creates the project's module links up front rather than on first run.
- A configured model that pi does not know now produces a warning naming the model pi fell back to.
- `trama --version` reports the installed version (it reported 0.1.4 in 0.1.5).

### Added

- **A program can import `@trama-dev/session`.** The CLI installs it and every project gets a link to it, so a `program.ts` run by `trama run` can create a session and coordinate participants itself.
- `Session` expands a leading `~` in `projectDir` and `workspace`.
- `createWorkspace` and the `Workspace` type are exported from `@trama-dev/runtime/runner`.

### Internal

- The runtime was consolidated: one path guard, one child-process supervisor, a route table for the IPC server, one scaffolding function. Source shrank by about 15% with no loss of tests.
- Publishing a release marks older versions as deprecated on npm.

## 0.1.5

- Published `@trama-dev/session`: shared workspace, cooperative `ctx.yield()` / resume, structured `ProgramResult`.

## 0.1.4

- Renamed `agent.ask()` to `agent.instruct()`, keeping `ask` as an alias.

## 0.1.0 – 0.1.3

- Initial releases: `create` / `run` / `update` / `list` / `logs`, auto-repair, version history, `ctx.ready()` for long-running programs, runtime hardening.
