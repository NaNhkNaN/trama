# @trama-dev/session

> Multi-agent coordination for trama programs.

The session layer for [trama](https://github.com/NaNhkNaN/trama) — shared workspace, cooperative suspension, and structured program results for coordinating multiple agent-authored programs.

## Usage

```typescript
import { ctx, agent, tools, workspace } from "@trama-dev/runtime";
import { Session } from "@trama-dev/session";

const session = await Session.createTemp();

// Spawn participants — each is a full trama program
const handle = session.spawn("check-sql", {
  projectDir: "~/.trama/projects/check-sql",
});

const result = await handle.wait();
// { status: "done" | "yielded" | "failed", reason?, result? }

// Resume a yielded participant
if (result.status === "yielded") {
  const resumed = await handle.resume({ feedback: "approved" });
  await resumed.wait();
}
```

## What the session layer provides

- **Shared workspace** — participants read and write artifacts through a common directory with atomic writes and path guarding.
- **Structured results** — `ProgramResult` with `status`, `reason`, and `result` fields. The session layer never reads `state.json` directly.
- **Yield/resume** — participants can suspend cooperatively via `ctx.yield()` and be resumed with new args.
- **Failure isolation** — each participant has its own trama lifecycle, repair loop, and state. A crashing participant doesn't corrupt the workspace or block others.

## Design

The session layer is **policy**. The runtime is **mechanism**. The session manages coordination (who participates, when to resume). The runtime manages execution (state persistence, auto-repair, version history). This boundary is enforced: `session` depends on `runtime`, never the reverse.

See the [main README](https://github.com/NaNhkNaN/trama) for the full API reference, and [docs/workspace-rfc.md](https://github.com/NaNhkNaN/trama/blob/main/docs/workspace-rfc.md) for the design rationale.
