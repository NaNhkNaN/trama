# Changelog

All three packages (`@trama-dev/runtime`, `@trama-dev/session`, `@trama-dev/cli`) are released together under one version.

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

- **A repair runs the fixed program once**, not twice. The trial run on a throwaway copy is gone; the fix runs in the real project under a snapshot and is rolled back if it fails too. This halves the LLM cost and the external side effects of a repaired run.
- Rolling back swaps the project directory for its snapshot instead of deleting it and copying it back, so the project's content is never absent mid-rollback. The snapshot is kept beside the project while a run is in flight.
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
