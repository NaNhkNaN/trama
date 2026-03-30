# @trama-dev/cli

> Agents don't need frameworks. They need a runtime.

The CLI for [trama](https://github.com/NaNhkNaN/trama) — the agentic runtime that turns intent into self-contained, shareable agent programs.

```bash
npm install -g @trama-dev/cli
```

Five commands. That's the whole interface.

```bash
trama create optimizer "improve sort.ts by benchmarking alternatives"
trama run optimizer
trama update optimizer "also track memory usage"
trama list
trama logs optimizer
```

`create` generates a complete agent program from one sentence. `run` executes it — with auto-repair if it crashes. `update` rewrites it with new requirements. The output is real TypeScript you can read, diff, and share. Anyone can `git clone && trama run`.

### What trama generates

From a single sentence, trama produces programs that range from one-shot pipelines to autonomous optimization loops to self-orchestrating multi-agent workflows — where trama programs create and run other trama programs.

```bash
# One-shot pipeline
trama create hn-digest "fetch the HN API, get top 10 stories, write digest.md"

# Autonomous optimization (autoresearch pattern)
trama create sort-opt "benchmark sort.ts, propose improvements, keep only faster versions"

# Self-orchestration — trama composes trama
trama create research "break topic into sub-questions, create a trama sub-program for each, \
  run them, synthesize a final report"
```

### CLI options

```bash
trama create <name> <prompt> [--model <model>] [--arg key=value ...]
trama run <name> [--timeout <ms>] [--arg key=value ...]
trama update <name> <prompt>
trama list
trama logs <name>
```

See the [main README](https://github.com/NaNhkNaN/trama) for the full picture — why a runtime matters, what generated programs look like, and the runtime API.
