# @trama-dev/cli

> Agents don't need frameworks. They need a runtime.

The command-line interface for [trama](https://github.com/NaNhkNaN/trama) — a TypeScript runtime for programmable, self-bootstrapping agents. Every piece of agent behavior (task scripts, coding harnesses, writers, crash fixers, judges, and evolution loops) lives as a versioned `program.ts` project backed by [`@trama-dev/runtime`](https://www.npmjs.com/package/@trama-dev/runtime).

```bash
npm install -g @trama-dev/cli
```

Requires Node 22.19+ on macOS or Linux. Models are called through [pi](https://github.com/earendil-works/pi) using your provider API key in the environment (`ANTHROPIC_API_KEY`, etc.) or `~/.pi/agent/auth.json`.

---

## Quick Start

Projects live in `~/.trama/projects/<name>/` with `program.ts`, `meta.json` (contract and default args), `history/`, and `logs/journal/`.

```bash
# Generate a program from a prompt (validated by running it)
trama create digest "fetch the top 10 Hacker News stories and write digest.md"

# Run it (crashes are repaired in a temporary copy and installed only if fixed)
trama run digest

# Rewrite it as real code, inspect history/journal, dry-run replay, or roll back
trama update digest "also include the comment count for each story"
trama history digest --runs
trama journal digest
trama replay digest
trama rollback digest 1
```

Or register a `program.ts` you wrote by hand:

```bash
trama create summarise "Summarise text and list risks" \
  --program summarise.ts --contract summarise.json --arg text="$(cat notes.md)"
```

---

## Programmable Harnesses & Evolution

In trama, every policy is a program you can copy, inspect, customize, and replace. Six ready-to-use projects ship with the CLI:

- **`coding-harness`** — A ~500-line programmable coding agent built on `agent.complete()`.
- **`harness-by-agent`** — Wraps an external ACP coding agent (e.g. Claude Code) in the same harness slot.
- **`check-by-command`** — Evaluates a run by executing a command (e.g. `npm test`) in a temporary copy.
- **`improve-by-check`** — Runs evolutionary improvement rounds with held-back test inputs.
- **`write-by-harness`** / **`repair-harness`** — Harness-driven alternatives to the bundled `program-writer` and `program-fixer`.

```bash
trama examples                                  # list included programs
trama examples coding-harness --as my-harness   # copy into ~/.trama/projects/my-harness
trama examples check-by-command

# Point your harness at any codebase and grade the result independently
trama run my-harness \
  --workspace ./code \
  --arg task="Make the failing tests pass. Do not change the tests." \
  --check check-by-command \
  --budget cost=2
```

Add `--arg programs=true` to give the model inside `coding-harness` access to your trama projects as tools — letting it run existing programs, create new ones, and add or switch versions of any project (including the harness itself).

---

## Commands

| Command | Purpose |
|---|---|
| `trama create <name> <prompt>` | Generate a project from a prompt or register your own (`--program <file>`, `--contract <file>`, `--arg`, `--with`, `--model`). |
| `trama run <name>` | Execute a project (`--arg`, `--workspace <dir>`, `--budget cost=\|tokens=\|calls=`, `--check <project>`, `--fix-with <project>`, `--at-version <n>`, `--no-making`, `--timeout <ms>`, `--json`). |
| `trama update <name> <prompt>` | Rewrite a project (`--from <n>`, `--beside` to record without installing, `--with`, `--contract`). |
| `trama add-version <name> <file>` | Validate and archive a hand-written program file as a candidate version (`--parent`, `--detail`, `--contract`). |
| `trama history <name>` | View version history and per-version run outcomes (`--runs`, `--json`). |
| `trama rollback <name> <version>` | Restore an earlier version (code and contract) as the active program. |
| `trama describe [name]` | Inspect project descriptions and I/O contracts (`--json` includes JSON Schema). |
| `trama journal <name> [run]` | View every call, response, and token/cost usage of a run (`--list`). |
| `trama replay <name> [run]` | Re-run a program answering bridge calls from recorded journals without spending model calls (`--all`, `--loose`). |
| `trama config [key] [value]` | View or edit global `~/.trama/config.json` (`createWith`, `updateWith`, `repairWith`, `provider`, `model`, `budget.*`, `agents.*`, etc.) or per-project settings (`--project <name>` for `checkWith`, `provider`, `model`, `args.<name>`). Use `--unset` to remove a key. |
| `trama examples [name]` | List bundled examples or copy one into `~/.trama/projects/` (`--as <name>`). |
| `trama api` | Print the full program authoring guide, TypeScript API, and schema syntax. |
| `trama list` / `trama logs <name>` | List all projects; print structured `ctx.log()` output from the last run. |

Run `trama <command> --help` for full details on any command.

---

## Script & Agent Integration

Every core inspection and execution command supports structured JSON output:

- `trama describe --json` — Lists all projects with their contracts as JSON Schema.
- `trama run <name> --json` — Emits a single JSON result document (`status`, `result`, `check`) on `stdout` while streaming live run logs to `stderr`.
- `trama history <name> --json` — Returns full version lineage and run records as JSON.
- `trama api` — Outputs everything a human or agent needs to author a valid `program.ts` and contract from scratch.

## License

MIT
