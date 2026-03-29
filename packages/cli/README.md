# @trama-dev/cli

The CLI for [trama](https://github.com/NaNhkNaN/trama) — where the program is the orchestration.

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

`create` turns your intent into a TypeScript program. `run` executes it deterministically. `update` rewrites it with new requirements. The program is the only artifact — no configs, no graphs, no prompts to manage.

See the [main README](https://github.com/NaNhkNaN/trama) for the full picture.
