# @trama-dev/runtime

The runtime behind [trama](https://github.com/NaNhkNaN/trama) — where the program is the orchestration.

This package has two surfaces:

**Client** — what trama-generated programs import. 9 functions, nothing else.

```typescript
import { ctx, agent, tools } from "@trama-dev/runtime";

const data = await tools.read("input.csv");
const report = await agent.ask(`Analyze this:\n${data}`);
await tools.write("report.md", report);
await ctx.done();
```

**Runner** — what the CLI and programmatic callers use to execute programs.

```typescript
import { runProgram, createProject } from "@trama-dev/runtime/runner";
```

See the [main README](https://github.com/NaNhkNaN/trama) for the full picture.
