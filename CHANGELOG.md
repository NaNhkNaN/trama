# Changelog

All three packages (`@trama-dev/runtime`, `@trama-dev/session`, `@trama-dev/cli`) are released together under one version.

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
