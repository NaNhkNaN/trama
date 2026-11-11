# Changelog

All three packages (`@trama-dev/runtime`, `@trama-dev/session`, `@trama-dev/cli`) are released together under one version.

## Unreleased

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

- **A repair runs the fixed program once**, not twice. (How it does so in 0.2.0 and 0.2.1 has a flaw — see the fix listed under Unreleased.)
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
