import assert from "node:assert/strict";
import test from "node:test";
import { join } from "path";
import { REPO_ROOT, runNodeCommand } from "./helpers.mjs";

test("client.ts throws a clear error when run directly without trama", async () => {
  const result = await runNodeCommand(
    ["-e", `import "@trama-dev/runtime";`],
    { cwd: REPO_ROOT, env: { ...process.env, TRAMA_PORT: undefined } },
  );

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /TRAMA_PORT/);
});
