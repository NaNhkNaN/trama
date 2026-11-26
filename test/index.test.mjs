import assert from "node:assert/strict";
import test from "node:test";
import { join } from "path";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "fs";
import { createProject, listProjects, runProgram, showLogs, updateProject, validateProjectName } from "../packages/runtime/dist/index.js";
import { llm } from "./fake-llm.mjs";
import {
  DEFAULT_PROGRAM,
  captureConsole,
  cleanupTempDir,
  createProjectFixture,
  makeTempDir,
  readJson,
  withEnv,
  writeJson,
  writeText,
} from "./helpers.mjs";

const UPDATED_PROGRAM = `import { ctx, tools } from "@trama-dev/runtime";

await tools.write("updated.txt", "updated");
ctx.state.mode = "updated";
await ctx.done({ updated: true });
`;

test("createProject writes scaffold, validates the generated program, and records history", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const originalAsk = llm.ask;
  const originalRepair = llm.repair;
  const prompts = [];

  llm.ask = async function ask(prompt, options) {
    prompts.push(options?.system ?? "");
    assert.match(prompt, /Output ONLY the TypeScript program/);
    return DEFAULT_PROGRAM;
  };
  llm.repair = async function repair() {
    throw new Error("repair should not be called");
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await createProject("alpha", "write an output file", { model: "test-model" });
    });
  } finally {
    llm.ask = originalAsk;
    llm.repair = originalRepair;
  }

  const projectDir = join(fakeHome, ".trama", "projects", "alpha");
  assert.equal(existsSync(join(projectDir, "program.ts")), true);
  // Smoke run side effects (output.txt) should NOT persist in the project dir
  assert.equal(existsSync(join(projectDir, "output.txt")), false);
  assert.equal(readJson(join(projectDir, "package.json")).type, "module");
  assert.equal(existsSync(join(projectDir, "history", "0001.ts")), true);

  const historyLines = readFileSync(join(projectDir, "history", "index.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));
  assert.equal(historyLines.at(-1).reason, "create");
  assert.equal(historyLines.at(-1).prompt, "write an output file");
  assert.match(prompts[0], /Runtime API:/);
});

for (const [agentChanges, kept] of [[undefined, true], ["keep", true], ["discard", false]]) {
  test(`createProject generation runs in a temp cwd, and what the agent leaves there is ${kept ? "kept with the program" : "discarded"} (agentChanges: ${agentChanges ?? "not said"})`, async (t) => {
    const fakeHome = makeTempDir("trama-home-");
    t.after(() => cleanupTempDir(fakeHome));
    if (agentChanges) writeJson(join(fakeHome, ".trama", "config.json"), { agentChanges });

    const originalAsk = llm.ask;
    const originalRepair = llm.repair;
    let observedCwd = "";

    llm.ask = async function ask(_prompt, call) {
      observedCwd = call.cwd;
      writeText(join(call.cwd, "ask-side-effect.txt"), "made where the agent worked");
      return DEFAULT_PROGRAM;
    };
    llm.repair = async function repair() {
      throw new Error("repair should not be called");
    };

    try {
      await withEnv({ HOME: fakeHome }, async () => {
        await createProject("alpha-temp-cwd", "write an output file");
      });
    } finally {
      llm.ask = originalAsk;
      llm.repair = originalRepair;
    }

    const projectDir = join(fakeHome, ".trama", "projects", "alpha-temp-cwd");
    assert.match(observedCwd, /trama-gen-/);
    assert.notEqual(observedCwd, projectDir);
    assert.equal(existsSync(join(projectDir, "ask-side-effect.txt")), kept);
  });
}

test("createProject cleans up the project directory when generation fails before program.ts is written", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const originalAsk = llm.ask;
  llm.ask = async function ask() {
    throw new Error("LLM unavailable");
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await assert.rejects(
        async () => createProject("broken", "make something"),
        /LLM unavailable/,
      );
    });
  } finally {
    llm.ask = originalAsk;
  }

  assert.equal(existsSync(join(fakeHome, ".trama", "projects", "broken")), false);
});

test("createProject keeps the generated project when validation fails after program.ts is written", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const originalAsk = llm.ask;
  const originalRepair = llm.repair;

  llm.ask = async function ask() {
    return 'throw new Error("broken");';
  };
  // Each attempt proposes a different program, and each is broken.
  let attempts = 0;
  llm.repair = async function repair() {
    attempts += 1;
    return `throw new Error("still broken, attempt ${attempts}");`;
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await assert.rejects(
        async () => createProject("broken-after-write", "make something"),
        /Failed after 3 repair attempts/,
      );
    });
  } finally {
    llm.ask = originalAsk;
    llm.repair = originalRepair;
  }

  const projectDir = join(fakeHome, ".trama", "projects", "broken-after-write");
  assert.equal(existsSync(projectDir), true);
  assert.equal(existsSync(join(projectDir, "program.ts")), true);
});

test("createProject smoke validation errors include buffered stdout", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const originalAsk = llm.ask;
  const originalRepair = llm.repair;

  llm.ask = async function ask() {
    return 'console.log("stdout-hint"); process.exit(1);';
  };
  llm.repair = async function repair() {
    return 'console.log("stdout-hint"); process.exit(1);';
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await assert.rejects(
        async () => createProject("broken-stdout", "make something"),
        /stdout: stdout-hint/,
      );
    });
  } finally {
    llm.ask = originalAsk;
    llm.repair = originalRepair;
  }
});

test("createProject smoke repair runs in a temp cwd and records create-repair history", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const originalAsk = llm.ask;
  const originalRepair = llm.repair;
  let repairCwd = "";
  const fixedProgram = `import { ctx, tools } from "@trama-dev/runtime";
await tools.write("fixed.txt", "ok");
await ctx.done();
`;

  llm.ask = async function ask() {
    return 'throw new Error("boom");';
  };
  llm.repair = async function repair(_prompt, call) {
    repairCwd = call.cwd;
    writeText(join(call.cwd, "repair-side-effect.txt"), "temp-only");
    return fixedProgram;
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await createProject("alpha-repair", "fix the generated program");
    });
  } finally {
    llm.ask = originalAsk;
    llm.repair = originalRepair;
  }

  const projectDir = join(fakeHome, ".trama", "projects", "alpha-repair");
  assert.match(repairCwd, /trama-repair-/);
  assert.notEqual(repairCwd, projectDir);
  assert.equal(existsSync(join(projectDir, "repair-side-effect.txt")), false);
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), fixedProgram.trim());

  const historyLines = readFileSync(join(projectDir, "history", "index.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));
  assert.equal(historyLines.some(entry => entry.reason === "create-repair"), true);
});

test("createProject accepts long-running server programs during smoke validation after ctx.ready", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  writeJson(join(fakeHome, ".trama", "config.json"), {
    provider: "anthropic",
    model: "test-model",
    maxRepairAttempts: 0,
    defaultTimeout: 10_000,
    defaultMaxIterations: 100,
  });

  const originalAsk = llm.ask;
  const originalRepair = llm.repair;
  let repairCalled = false;
  const serverProgram = `import { ctx } from "@trama-dev/runtime";
import { createServer } from "node:http";

const server = createServer((_req, res) => {
  res.end("ok");
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve());
});

await ctx.ready({ mode: "smoke-ready" });

process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});

await new Promise(() => {});
`;

  llm.ask = async function ask() {
    return serverProgram;
  };
  llm.repair = async function repair() {
    repairCalled = true;
    throw new Error("repair should not run");
  };

  try {
    const startedAt = Date.now();
    await withEnv({ HOME: fakeHome }, async () => {
      await createProject("server-app", "host a website");
    });
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 15_000, `expected smoke validation to finish quickly, got ${elapsed}ms`);
  } finally {
    llm.ask = originalAsk;
    llm.repair = originalRepair;
  }

  const projectDir = join(fakeHome, ".trama", "projects", "server-app");
  assert.equal(repairCalled, false);
  assert.equal(existsSync(join(projectDir, "program.ts")), true);
});

test("createProject times out long-running server programs that never call ctx.ready", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  writeJson(join(fakeHome, ".trama", "config.json"), {
    provider: "anthropic",
    model: "test-model",
    maxRepairAttempts: 0,
    defaultTimeout: 1_000,
    defaultMaxIterations: 100,
  });

  const originalAsk = llm.ask;
  const originalRepair = llm.repair;
  const serverProgram = `import { createServer } from "node:http";

const server = createServer((_req, res) => {
  res.end("ok");
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve());
});

process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});

await new Promise(() => {});
`;

  llm.ask = async function ask() {
    return serverProgram;
  };
  llm.repair = async function repair() {
    throw new Error("repair should not run");
  };

  try {
    const startedAt = Date.now();
    await withEnv({ HOME: fakeHome }, async () => {
      await assert.rejects(
        async () => createProject("server-without-ready", "host a website"),
        /timeout/i,
      );
    });
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 5_000, `expected smoke validation to fail quickly, got ${elapsed}ms`);
  } finally {
    llm.ask = originalAsk;
    llm.repair = originalRepair;
  }
});

test("createProject detects server crash during smoke grace period after ctx.ready", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  writeJson(join(fakeHome, ".trama", "config.json"), {
    provider: "anthropic",
    model: "test-model",
    maxRepairAttempts: 0,
    defaultTimeout: 10_000,
    defaultMaxIterations: 100,
  });

  const originalAsk = llm.ask;
  const originalRepair = llm.repair;
  // Server calls ctx.ready() then crashes 200ms later — should fail smoke validation
  const crashingServer = `import { ctx } from "@trama-dev/runtime";
import { createServer } from "node:http";

const server = createServer((_req, res) => {
  res.end("ok");
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve());
});

await ctx.ready({ url: "http://127.0.0.1:3000" });

// Crash shortly after ready
setTimeout(() => {
  process.exit(1);
}, 200);

await new Promise(() => {});
`;

  llm.ask = async function ask() {
    return crashingServer;
  };
  llm.repair = async function repair() {
    throw new Error("repair should not run");
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await assert.rejects(
        async () => createProject("crashing-server", "host a website"),
        /Program failed/,
        "server that crashes after ready should fail smoke validation",
      );
    });
  } finally {
    llm.ask = originalAsk;
    llm.repair = originalRepair;
  }
});

test("createProject rejects path-like project names before creating any directories", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  await withEnv({ HOME: fakeHome }, async () => {
    await assert.rejects(
      async () => createProject("../escaped", "make something"),
      /Invalid project name/,
    );
  });

  assert.equal(existsSync(join(fakeHome, ".trama", "projects")), false);
  assert.equal(existsSync(join(fakeHome, ".trama", "escaped")), false);
});

test("updateProject rewrites the program and appends an update history entry", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const projectDir = join(fakeHome, ".trama", "projects", "beta");
  createProjectFixture(projectDir, {
    state: { prior: "state" },
    packageJson: { name: "beta-project" },
    programSource: DEFAULT_PROGRAM,
  });

  const originalAsk = llm.ask;
  const originalRepair = llm.repair;
  let systemPrompt = "";

  llm.ask = async function ask(_prompt, options) {
    systemPrompt = options?.system ?? "";
    return UPDATED_PROGRAM;
  };
  llm.repair = async function repair() {
    throw new Error("repair should not be called");
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await updateProject("beta", "add an updated output");
    });
  } finally {
    llm.ask = originalAsk;
    llm.repair = originalRepair;
  }

  // stripCodeFences trims the LLM response, so program.ts won't have trailing whitespace
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), UPDATED_PROGRAM.trim());
  // Smoke run side effects (updated.txt) should NOT persist in the project dir
  assert.equal(existsSync(join(projectDir, "updated.txt")), false);
  assert.match(systemPrompt, /Original prompt: test prompt/);
  assert.match(systemPrompt, /Current program\.ts:/);
  assert.match(systemPrompt, /Current state:/);

  const historyLines = readFileSync(join(projectDir, "history", "index.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));
  assert.equal(historyLines.at(-1).reason, "update");
  assert.equal(historyLines.at(-1).prompt, "add an updated output");
});

for (const [agentChanges, kept] of [[undefined, true], ["discard", false]]) test(`updateProject generation runs in a temp cwd, and what the agent leaves there is ${kept ? "kept with the program" : "discarded"} (agentChanges: ${agentChanges ?? "not said"})`, async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));
  if (agentChanges) writeJson(join(fakeHome, ".trama", "config.json"), { agentChanges });

  const projectDir = join(fakeHome, ".trama", "projects", "beta-temp-cwd");
  createProjectFixture(projectDir, {
    state: { prior: "state" },
    packageJson: { name: "beta-project" },
    programSource: DEFAULT_PROGRAM,
  });

  const originalAsk = llm.ask;
  const originalRepair = llm.repair;
  let observedCwd = "";

  llm.ask = async function ask(_prompt, call) {
    observedCwd = call.cwd;
    writeText(join(call.cwd, "ask-side-effect.txt"), "made where the agent worked");
    return UPDATED_PROGRAM;
  };
  llm.repair = async function repair() {
    throw new Error("repair should not be called");
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await updateProject("beta-temp-cwd", "add an updated output");
    });
  } finally {
    llm.ask = originalAsk;
    llm.repair = originalRepair;
  }

  assert.match(observedCwd, /trama-gen-/);
  assert.notEqual(observedCwd, projectDir);
  assert.equal(existsSync(join(projectDir, "ask-side-effect.txt")), kept);
});

test("updateProject restores original program.ts when validation fails", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const projectDir = join(fakeHome, ".trama", "projects", "gamma");
  createProjectFixture(projectDir, {
    packageJson: { type: "module" },
    programSource: DEFAULT_PROGRAM,
  });

  const originalAsk = llm.ask;
  const originalRepair = llm.repair;

  llm.ask = async function ask() {
    return 'throw new Error("broken");';
  };
  llm.repair = async function repair() {
    return 'throw new Error("still broken");';
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await assert.rejects(
        async () => updateProject("gamma", "break it"),
        /the program is unchanged/,
      );
    });
  } finally {
    llm.ask = originalAsk;
    llm.repair = originalRepair;
  }

  // Original program.ts should be restored
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), DEFAULT_PROGRAM);
});

test("updateProject restores original state.json when validation fails after checkpointing", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const projectDir = join(fakeHome, ".trama", "projects", "delta");
  createProjectFixture(projectDir, {
    packageJson: { type: "module" },
    programSource: DEFAULT_PROGRAM,
    state: { stable: true },
  });

  const originalAsk = llm.ask;
  const originalRepair = llm.repair;
  const brokenProgram = `import { ctx } from "@trama-dev/runtime";

ctx.state.mode = "broken";
await ctx.checkpoint();
throw new Error("boom");
`;

  llm.ask = async function ask() {
    return brokenProgram;
  };
  llm.repair = async function repair() {
    return brokenProgram;
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await assert.rejects(
        async () => updateProject("delta", "break state"),
        /the program is unchanged/,
      );
    });
  } finally {
    llm.ask = originalAsk;
    llm.repair = originalRepair;
  }

  assert.deepEqual(readJson(join(projectDir, "state.json")), { stable: true });
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), DEFAULT_PROGRAM);
});

test("updateProject restores files written by a failed validation run", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const projectDir = join(fakeHome, ".trama", "projects", "epsilon");
  createProjectFixture(projectDir, {
    packageJson: { type: "module" },
    programSource: DEFAULT_PROGRAM,
  });

  const originalAsk = llm.ask;
  const originalRepair = llm.repair;
  const brokenProgram = `import { tools } from "@trama-dev/runtime";

await tools.write("leftover.txt", "oops");
throw new Error("boom");
`;

  llm.ask = async function ask() {
    return brokenProgram;
  };
  llm.repair = async function repair() {
    return brokenProgram;
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await assert.rejects(
        async () => updateProject("epsilon", "leave files"),
        /the program is unchanged/,
      );
    });
  } finally {
    llm.ask = originalAsk;
    llm.repair = originalRepair;
  }

  assert.equal(existsSync(join(projectDir, "leftover.txt")), false);
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), DEFAULT_PROGRAM);
});

test("updateProject records no repair in history when the update fails", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const projectDir = join(fakeHome, ".trama", "projects", "zeta");
  createProjectFixture(projectDir, {
    packageJson: { type: "module" },
    programSource: DEFAULT_PROGRAM,
  });
  writeText(
    join(projectDir, "history", "index.jsonl"),
    `${JSON.stringify({ version: 1, reason: "create", timestamp: "2026-03-28T00:00:00.000Z" })}\n`,
  );

  const originalAsk = llm.ask;
  const originalRepair = llm.repair;
  const brokenProgram = 'throw new Error("boom");\n';

  llm.ask = async function ask() {
    return brokenProgram;
  };
  llm.repair = async function repair() {
    return brokenProgram;
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await assert.rejects(
        async () => updateProject("zeta", "break history"),
        /the program is unchanged/,
      );
    });
  } finally {
    llm.ask = originalAsk;
    llm.repair = originalRepair;
  }

  const historyLines = readFileSync(join(projectDir, "history", "index.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));
  assert.equal(historyLines[0].reason, "create");
  // Repairs that never produced a verified-working program should not appear in history
  assert.equal(historyLines.some(entry => entry.reason === "update-repair"), false);
});

test("updateProject rejects path-like project names before resolving a directory", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  await withEnv({ HOME: fakeHome }, async () => {
    await assert.rejects(
      async () => updateProject("../escaped", "break out"),
      /Invalid project name/,
    );
  });
});

test("listProjects and showLogs print human-readable summaries", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const alphaDir = join(fakeHome, ".trama", "projects", "alpha");
  const betaDir = join(fakeHome, ".trama", "projects", "beta");
  createProjectFixture(alphaDir, {
    metaInput: { prompt: "alpha prompt", args: {} },
    packageJson: { type: "module" },
  });
  createProjectFixture(betaDir, {
    metaInput: { prompt: "beta prompt that is deliberately a bit longer than sixty characters to test truncation", args: {} },
    packageJson: { type: "module" },
  });
  writeText(
    join(alphaDir, "logs", "latest.jsonl"),
    `${JSON.stringify({ ts: Date.parse("2024-01-02T03:04:05.000Z"), message: "step", data: { count: 1 } })}\n`,
  );

  const listed = await withEnv({ HOME: fakeHome }, async () => captureConsole("log", async () => {
    await listProjects();
  }));
  assert.equal(listed.messages.some(line => line.includes("alpha")), true);
  assert.equal(listed.messages.some(line => line.includes("beta")), true);

  const shown = await withEnv({ HOME: fakeHome }, async () => captureConsole("log", async () => {
    await showLogs("alpha");
  }));
  assert.deepEqual(shown.messages, ["[03:04:05] step  {\"count\":1}"]);
});

// --- Regression tests for consolidated bug fixes ---

test("createProject strips code fences from LLM-generated program", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const originalAsk = llm.ask;
  const originalRepair = llm.repair;

  llm.ask = async function ask() {
    return "```typescript\n" + DEFAULT_PROGRAM + "```";
  };
  llm.repair = async function repair() {
    throw new Error("repair should not be called");
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await createProject("fenced", "write something");
    });
  } finally {
    llm.ask = originalAsk;
    llm.repair = originalRepair;
  }

  const projectDir = join(fakeHome, ".trama", "projects", "fenced");
  const written = readFileSync(join(projectDir, "program.ts"), "utf-8");
  assert.doesNotMatch(written, /^```/m);
  assert.match(written, /import.*@trama-dev\/runtime/);
});

test("updateProject strips code fences from LLM-updated program", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const projectDir = join(fakeHome, ".trama", "projects", "fenced-update");
  createProjectFixture(projectDir, {
    packageJson: { type: "module" },
    programSource: DEFAULT_PROGRAM,
  });

  const originalAsk = llm.ask;
  const originalRepair = llm.repair;

  llm.ask = async function ask() {
    return "```typescript\n" + UPDATED_PROGRAM + "```";
  };
  llm.repair = async function repair() {
    throw new Error("repair should not be called");
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await updateProject("fenced-update", "add an updated output");
    });
  } finally {
    llm.ask = originalAsk;
    llm.repair = originalRepair;
  }

  const written = readFileSync(join(projectDir, "program.ts"), "utf-8");
  assert.doesNotMatch(written, /^```/m);
  assert.equal(written, UPDATED_PROGRAM.trimEnd());
});

test("createProject smoke validation uses config maxRepairAttempts", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  writeJson(join(fakeHome, ".trama", "config.json"), { maxRepairAttempts: 0 });

  const originalAsk = llm.ask;
  const originalRepair = llm.repair;
  let repairCalled = false;

  llm.ask = async function ask() {
    return 'throw new Error("broken");';
  };
  llm.repair = async function repair() {
    repairCalled = true;
    return 'throw new Error("still broken");';
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await assert.rejects(
        async () => createProject("no-repair", "make something"),
        /Program failed \(repair disabled\)/,
      );
    });
    assert.equal(repairCalled, false, "repair should not be called when maxRepairAttempts is 0");
  } finally {
    llm.ask = originalAsk;
    llm.repair = originalRepair;
  }
});

// --- Additional coverage tests ---

test("createProject rejects duplicate project names", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  // Pre-create the project directory
  mkdirSync(join(fakeHome, ".trama", "projects", "dupe"), { recursive: true });

  const originalAsk = llm.ask;
  llm.ask = async function ask() { return DEFAULT_PROGRAM; };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await assert.rejects(
        async () => createProject("dupe", "anything"),
        /already exists/,
      );
    });
  } finally {
    llm.ask = originalAsk;
  }
});

test("a project's name is one line of text: what would break a line is no name", () => {
  for (const name of ["two\nlines", "tab\there", "bell\x07", "gone\x7f", "nul\0"]) assert.throws(() => validateProjectName(name), /Invalid project name/, JSON.stringify(name));
  for (const name of ["plain", "with space", "dotted.name", "-dashed", "ünïcödé"]) validateProjectName(name);
});

test("a project is what can be run by its name: listed where it is reached through a link, and not found where the name is a file's", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  const elsewhere = makeTempDir("trama-elsewhere-");
  t.after(() => { cleanupTempDir(fakeHome); cleanupTempDir(elsewhere); });
  const projects = join(fakeHome, ".trama", "projects");
  mkdirSync(projects, { recursive: true });
  createProjectFixture(join(elsewhere, "kept-elsewhere"), { scaffold: false });
  symlinkSync(join(elsewhere, "kept-elsewhere"), join(projects, "linked"));
  writeText(join(projects, "a-file"), "no project");

  const { messages } = await withEnv({ HOME: fakeHome }, () => captureConsole("log", () => listProjects()));
  assert.equal(messages.filter((line) => line.includes("linked")).length, 1, messages.join("\n"));
  assert.equal(messages.some((line) => line.includes("a-file")), false);
  await withEnv({ HOME: fakeHome }, async () => {
    await assert.rejects(() => updateProject("a-file", "change it"), /Project "a-file" not found/);
  });
});

test("createProject takes a model by its name: what is no text is refused before a project is made", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));
  await withEnv({ HOME: fakeHome }, async () => {
    for (const model of [7, { id: "m" }, ["m"], true]) {
      await assert.rejects(() => createProject("typed", "p", { model }), /Invalid model: .*\. A model is named in text\./, JSON.stringify(model));
      assert.equal(existsSync(join(fakeHome, ".trama", "projects", "typed")), false);
    }
  });
});

test("validateProjectName rejects empty, dot, and slash names", () => {
  assert.throws(() => validateProjectName(""), /Invalid project name/);
  assert.throws(() => validateProjectName("."), /Invalid project name/);
  assert.throws(() => validateProjectName(".."), /Invalid project name/);
  assert.throws(() => validateProjectName("a/b"), /Invalid project name/);
  assert.throws(() => validateProjectName("a\\b"), /Invalid project name/);
});

test("listProjects prints nothing when projects dir exists but is empty", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));
  mkdirSync(join(fakeHome, ".trama", "projects"), { recursive: true });

  const { messages } = await withEnv({ HOME: fakeHome }, () =>
    captureConsole("log", () => listProjects()),
  );
  assert.equal(messages.some(m => m.includes("No projects found")), true);
});

test("showLogs reports no logs when logs file is missing", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const projectDir = join(fakeHome, ".trama", "projects", "nologs");
  createProjectFixture(projectDir);
  // Delete the logs file
  const { rmSync } = await import("fs");
  try { rmSync(join(projectDir, "logs", "latest.jsonl")); } catch {}

  const { messages } = await withEnv({ HOME: fakeHome }, () =>
    captureConsole("log", () => showLogs("nologs")),
  );
  assert.equal(messages.some(m => m.includes("No logs found")), true);
});

test("showLogs reports no entries when logs file is empty", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const projectDir = join(fakeHome, ".trama", "projects", "emptylogs");
  createProjectFixture(projectDir);
  writeText(join(projectDir, "logs", "latest.jsonl"), "");

  const { messages } = await withEnv({ HOME: fakeHome }, () =>
    captureConsole("log", () => showLogs("emptylogs")),
  );
  assert.equal(messages.some(m => m.includes("No log entries")), true);
});

test("showLogs handles malformed JSON lines gracefully", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const projectDir = join(fakeHome, ".trama", "projects", "badlogs");
  createProjectFixture(projectDir);
  writeText(join(projectDir, "logs", "latest.jsonl"),
    `${JSON.stringify({ ts: Date.parse("2024-01-01T00:00:00Z"), message: "good" })}\nnot valid json\n`);

  const { messages } = await withEnv({ HOME: fakeHome }, () =>
    captureConsole("log", () => showLogs("badlogs")),
  );
  assert.equal(messages[0], "[00:00:00] good");
  assert.equal(messages[1], "not valid json");
});

test("showLogs omits data suffix when log entry has no data", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const projectDir = join(fakeHome, ".trama", "projects", "nodata");
  createProjectFixture(projectDir);
  writeText(join(projectDir, "logs", "latest.jsonl"),
    `${JSON.stringify({ ts: Date.parse("2024-06-15T12:30:00Z"), message: "step" })}\n`);

  const { messages } = await withEnv({ HOME: fakeHome }, () =>
    captureConsole("log", () => showLogs("nodata")),
  );
  assert.equal(messages[0], "[12:30:00] step");
});

test("listProjects shows projects without meta.json or program.ts gracefully", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  // Create a project dir with no meta.json and no program.ts
  mkdirSync(join(fakeHome, ".trama", "projects", "bare"), { recursive: true });

  const { messages } = await withEnv({ HOME: fakeHome }, () =>
    captureConsole("log", () => listProjects()),
  );
  assert.equal(messages.some(m => m.includes("bare")), true);
});

test("listProjects truncates long prompts at 60 characters", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const projectDir = join(fakeHome, ".trama", "projects", "longprompt");
  createProjectFixture(projectDir, {
    metaInput: { prompt: "a".repeat(100), args: {} },
  });

  const { messages } = await withEnv({ HOME: fakeHome }, () =>
    captureConsole("log", () => listProjects()),
  );
  const line = messages.find(m => m.includes("longprompt"));
  assert.ok(line);
  assert.match(line, /\.\.\./, "long prompt should be truncated with ...");
  // Should not contain the full 100 chars
  assert.ok(!line.includes("a".repeat(100)));
});

test("updateProject refuses a program that is read-only before a new one is asked for", { skip: process.getuid?.() === 0 }, async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));
  const projectDir = join(fakeHome, ".trama", "projects", "locked");
  createProjectFixture(projectDir, { packageJson: { type: "module" }, programSource: DEFAULT_PROGRAM });
  chmodSync(join(projectDir, "program.ts"), 0o444);

  let asked = 0;
  const originalAsk = llm.ask;
  llm.ask = async () => { asked += 1; return UPDATED_PROGRAM; };
  t.after(() => { llm.ask = originalAsk; });

  await withEnv({ HOME: fakeHome }, async () => {
    await assert.rejects(
      updateProject("locked", "change it"),
      /the program is unchanged\.\nThe program cannot be replaced: .*program\.ts is read-only/,
    );
  });
  // An update's only use is a new program: the model was not paid to write one that could not be installed.
  assert.equal(asked, 0);
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), DEFAULT_PROGRAM);
});

test("updateProject says a project nothing can be created in cannot be updated, before it prepares anything in it", { skip: process.getuid?.() === 0 }, async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  const projectDir = join(fakeHome, ".trama", "projects", "sealed");
  t.after(() => { chmodSync(projectDir, 0o755); cleanupTempDir(fakeHome); });
  // Hand-written and never run: it has no history/ or logs/ yet.
  createProjectFixture(projectDir, { scaffold: false, programSource: DEFAULT_PROGRAM });
  chmodSync(projectDir, 0o555);

  let asked = 0;
  const originalAsk = llm.ask;
  llm.ask = async () => { asked += 1; return UPDATED_PROGRAM; };
  t.after(() => { llm.ask = originalAsk; });

  await withEnv({ HOME: fakeHome }, async () => {
    await assert.rejects(
      updateProject("sealed", "change it"),
      /the program is unchanged\.\nThe program cannot be replaced: nothing can be created in /,
    );
  });
  assert.equal(asked, 0);
  assert.equal(existsSync(join(projectDir, "history")), false);
});

// --- A model that answers with nothing, and a project that is another by now ---

test("createProject makes no project of an answer that holds no program", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  const originalAsk = llm.ask, originalRepair = llm.repair;
  let fixesAsked = 0;
  llm.repair = async () => { fixesAsked += 1; return DEFAULT_PROGRAM; };
  t.after(() => { llm.ask = originalAsk; llm.repair = originalRepair; cleanupTempDir(fakeHome); });

  for (const [i, nothing] of ["", "  \n", "```ts\n```"].entries()) {
    llm.ask = async () => nothing;
    await withEnv({ HOME: fakeHome }, () => captureConsole("log", () =>
      assert.rejects(() => createProject(`empty-${i}`, "make something"), /answered with no program/)));
    assert.equal(existsSync(join(fakeHome, ".trama", "projects", `empty-${i}`)), false, JSON.stringify(nothing));
  }
  // Nothing was tried, so nothing was there to mend.
  assert.equal(fixesAsked, 0);
});

test("updateProject leaves the program as it is where the answer holds none", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  const projectDir = join(fakeHome, ".trama", "projects", "kept");
  createProjectFixture(projectDir);
  const originalAsk = llm.ask;
  llm.ask = async () => "\n";
  t.after(() => { llm.ask = originalAsk; cleanupTempDir(fakeHome); });

  await withEnv({ HOME: fakeHome }, () => captureConsole("log", () =>
    assert.rejects(() => updateProject("kept", "change it"), /Update failed — the program is unchanged\.\n.*answered with no program/s)));
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), DEFAULT_PROGRAM);
});

test("an answer that says there is no program to be written is that, and no program: it is not tried as one, nobody is asked to mend it, and whoever asked is told why — an update leaves the program as it is, a making makes no project", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  const projectDir = join(fakeHome, ".trama", "projects", "kept");
  createProjectFixture(projectDir);
  const originalAsk = llm.ask, originalRepair = llm.repair;
  let fixesAsked = 0, system;
  // (Tried as a program, the answer would fail to be read as one, and this fix would be installed in its place.)
  llm.repair = async () => { fixesAsked += 1; return DEFAULT_PROGRAM + "// mended\n"; };
  t.after(() => { llm.ask = originalAsk; llm.repair = originalRepair; cleanupTempDir(fakeHome); });
  const quietly = (fn) => withEnv({ HOME: fakeHome }, () => captureConsole("log", () => captureConsole("warn", () => captureConsole("error", fn))));

  llm.ask = async (prompt, call) => { system = call.system; return "\n  NO PROGRAM: the project says it gives `greeting` alone,\nand `letters` would be left out of every run.\n"; };
  await quietly(() => assert.rejects(() => updateProject("kept", "give the letters too"), (err) => {
    assert.equal(err.message, "Update failed — the program is unchanged.\nIt was said that there is none to be written: the project says it gives `greeting` alone,\nand `letters` would be left out of every run.");
    return true;
  }));
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), DEFAULT_PROGRAM);
  assert.equal(fixesAsked, 0);
  // Whoever writes is told of this way out as it is asked.
  assert.match(system, /then there is no program, and you are not to hand over one that does something else: answer instead with one line that begins "NO PROGRAM:" and says why\.\n/);

  await quietly(() => assert.rejects(() => createProject("none", "make something"), /It was said that there is none to be written: the project says it gives `greeting` alone,\nand `letters` would be left out of every run\.$/));
  assert.equal(existsSync(join(fakeHome, ".trama", "projects", "none")), false);
  assert.equal(fixesAsked, 0);

  // Said with no reason, it is still said.
  llm.ask = async () => "NO PROGRAM:\n";
  await quietly(() => assert.rejects(() => updateProject("kept", "give the letters too"), /\nIt was said that there is none to be written: no reason was given$/));

  // And it is how an answer begins: a program that has the words in it is a program.
  const speaksOfIt = DEFAULT_PROGRAM + "// NO PROGRAM: is how whoever writes says there is none.\n";
  llm.ask = async () => speaksOfIt;
  await quietly(() => updateProject("kept", "say how it is said"));
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8").trim(), speaksOfIt.trim());
  assert.equal(fixesAsked, 0);
});

test("createProject takes away only the directory it made: another that is at the name by then stays", async (t) => {
  const { renameSync } = await import("fs");
  const fakeHome = makeTempDir("trama-home-");
  const projectDir = join(fakeHome, ".trama", "projects", "swapped");
  const originalAsk = llm.ask;
  // While the program is asked for, somebody moves the new project away and puts a directory of their own at its name.
  llm.ask = async () => {
    renameSync(projectDir, join(fakeHome, "moved-away"));
    mkdirSync(projectDir);
    writeText(join(projectDir, "theirs.txt"), "somebody's own");
    throw new Error("LLM unavailable");
  };
  t.after(() => { llm.ask = originalAsk; cleanupTempDir(fakeHome); });

  await withEnv({ HOME: fakeHome }, () => captureConsole("log", () =>
    assert.rejects(() => createProject("swapped", "make something"), /LLM unavailable/)));
  assert.equal(readFileSync(join(projectDir, "theirs.txt"), "utf-8"), "somebody's own");

  // And where the answer does come, it is not written into that directory either.
  llm.ask = async () => {
    renameSync(join(fakeHome, ".trama", "projects", "swapped-2"), join(fakeHome, "moved-away-2"));
    mkdirSync(join(fakeHome, ".trama", "projects", "swapped-2"));
    return DEFAULT_PROGRAM;
  };
  const second = join(fakeHome, ".trama", "projects", "swapped-2");
  await withEnv({ HOME: fakeHome }, () => captureConsole("log", () =>
    assert.rejects(() => createProject("swapped-2", "make something"), /is not the project this was started on/)));
  assert.equal(existsSync(second), true);
  assert.equal(existsSync(join(second, "program.ts")), false);
});

test("a program is asked for where the project can be looked at — in a copy of it, of which nothing is kept but the answer, where what the agent changes is to be discarded", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));
  writeJson(join(fakeHome, ".trama", "config.json"), { agentChanges: "discard" });
  const projectDir = join(fakeHome, ".trama", "projects", "looked-at");
  createProjectFixture(projectDir, { packageJson: { name: "looked-at", type: "module" }, programSource: DEFAULT_PROGRAM, state: { seen: 3 } });
  writeText(join(projectDir, "data", "sample.csv"), "name,age\nada,36\n");

  const originalAsk = llm.ask;
  const saw = {};
  llm.ask = async function ask(_prompt, call) {
    const { readdirSync, rmSync } = await import("fs");
    const here = (path) => join(call.cwd, path);
    Object.assign(saw, {
      cwd: call.cwd,
      names: readdirSync(call.cwd).sort(),
      data: existsSync(here("data/sample.csv")) && readFileSync(here("data/sample.csv"), "utf-8"),
      program: existsSync(here("program.ts")) && readFileSync(here("program.ts"), "utf-8"),
      state: existsSync(here("state.json")) && readJson(here("state.json")),
      told: /You are working in a copy of the project's directory, which is where the program will run: where the task speaks of the project's files, look at them\. Nothing you write here is kept — only the program you answer with\./.test(call.system),
    });
    // What the agent does there, it does to the copy.
    writeText(here("data/sample.csv"), "overwritten");
    writeText(here("notes.md"), "left by the agent");
    rmSync(here("meta.json"), { force: true });
    return saw.program === false ? DEFAULT_PROGRAM : UPDATED_PROGRAM;
  };
  t.after(() => { llm.ask = originalAsk; });

  await withEnv({ HOME: fakeHome }, () => updateProject("looked-at", "use the columns of data/sample.csv"));
  assert.match(saw.cwd, /trama-gen-[^/]+\/looked-at$/);
  assert.equal(saw.data, "name,age\nada,36\n");
  assert.equal(saw.program, DEFAULT_PROGRAM);
  assert.deepEqual(saw.state, { seen: 3 });
  assert.equal(saw.told, true);
  assert.equal(readFileSync(join(projectDir, "data", "sample.csv"), "utf-8"), "name,age\nada,36\n");
  assert.equal(existsSync(join(projectDir, "notes.md")), false);
  assert.equal(existsSync(join(projectDir, "meta.json")), true);
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), UPDATED_PROGRAM.trim());
  assert.equal(existsSync(saw.cwd), false, "the copy is gone when the answer is in");

  // A project that is being made is looked at as far as it is made: what trama put there, and no program yet.
  await withEnv({ HOME: fakeHome }, () => createProject("just-made", "write an output file"));
  const made = join(fakeHome, ".trama", "projects", "just-made");
  assert.match(saw.cwd, /trama-gen-[^/]+\/just-made$/);
  assert.equal(saw.program, false);
  assert.equal(saw.told, true);
  assert.ok(saw.names.includes("meta.json") && saw.names.includes("package.json"), JSON.stringify(saw.names));
  assert.equal(existsSync(join(made, "notes.md")), false);
  assert.equal(existsSync(join(made, "meta.json")), true);
  assert.equal(readFileSync(join(made, "program.ts"), "utf-8"), DEFAULT_PROGRAM.trim());
});

test("createProject shows the agent the project it made, not another directory that is at the path by the time it asks", async (t) => {
  const { renameSync } = await import("fs");
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));
  const projectDir = join(fakeHome, ".trama", "projects", "swapped");
  const originalAsk = llm.ask;
  let asked = 0;
  llm.ask = async () => { asked += 1; return DEFAULT_PROGRAM; };
  t.after(() => { llm.ask = originalAsk; });

  // (What is asked of the arguments when they are written down is asked after the project is made, and before the agent is.)
  const args = {
    toJSON() {
      renameSync(projectDir, join(fakeHome, "moved-away"));
      writeText(join(projectDir, "others-secret.txt"), "not the project's");
      return {};
    },
  };
  await assert.rejects(
    () => withEnv({ HOME: fakeHome }, () => createProject("swapped", "write an output file", { args })),
    /is not the project/,
  );
  assert.equal(asked, 0, "no agent was shown the other directory");
  assert.equal(readFileSync(join(projectDir, "others-secret.txt"), "utf-8"), "not the project's");
});

test("what the agent that writes a program makes beside it is validated with it and kept with it — with a program that passes, and no other", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));
  writeJson(join(fakeHome, ".trama", "config.json"), { maxRepairAttempts: 0 });
  const projectDir = join(fakeHome, ".trama", "projects", "prepared");
  createProjectFixture(projectDir, { packageJson: { name: "prepared", type: "module" }, programSource: DEFAULT_PROGRAM });
  writeText(join(projectDir, "data", "sample.csv"), "name,age\nada,36\n");
  // A program that cannot run without what the agent made beside it — and that does something of its own when it runs.
  const LEANS = `import { ctx, tools } from "@trama-dev/runtime";
import { columns } from "./lib/columns.mjs";
await tools.write("written-by-a-run.txt", "x");
await ctx.done({ columns: columns() });`;
  const originalAsk = llm.ask;
  const agent = { answer: LEANS, also: () => {} };
  llm.ask = async (_prompt, call) => {
    agent.told = /What the program needs beside it[^\n]*you can make here: it is kept, with the program, if the program then passes its validation\. The program itself is what you answer with, whatever you wrote to program\.ts here\./.test(call.system);
    const here = (path) => join(call.cwd, path);
    writeText(here("lib/columns.mjs"), 'import { readFileSync } from "fs";\nexport const columns = () => readFileSync("data/sample.csv", "utf-8").split("\\n")[0].split(",");\n');
    writeText(here("data/sample.csv"), "name,age,city\nada,36,london\n");
    writeText(here("program.ts"), "// a draft, left where the agent worked");
    agent.also(here);
    return agent.answer;
  };
  t.after(() => { llm.ask = originalAsk; });
  const inProject = (path) => { try { return readFileSync(join(projectDir, path), "utf-8"); } catch { return null; } };

  const first = await captureConsole("log", () => withEnv({ HOME: fakeHome }, () => updateProject("prepared", "use the columns")));
  assert.equal(agent.told, true);
  assert.ok(first.messages.includes("[trama] 3 path(s) made or changed beside the program, while it was written: data/sample.csv, lib, lib/columns.mjs"), first.messages.join("\n"));
  // The program is the answer, not what was left at program.ts; beside it, what the agent made and changed.
  assert.equal(inProject("program.ts"), LEANS);
  assert.match(inProject("lib/columns.mjs"), /export const columns/);
  assert.equal(inProject("data/sample.csv"), "name,age,city\nada,36,london\n");
  // What the validation's run did is no part of that: it ran in a copy of the agent's copy.
  assert.equal(inProject("written-by-a-run.txt"), null);
  // And the project runs as it was validated.
  const run = await withEnv({ HOME: fakeHome }, () => runProgram({ projectDir, maxRepairAttempts: 0, timeout: 20_000 }));
  assert.deepEqual(run, { status: "done", result: { columns: ["name", "age", "city"] } });

  // With a program that does not pass, nothing of the agent's arrives.
  Object.assign(agent, { answer: 'throw new Error("boom");', also: (here) => { writeText(here("from-a-failed-update.txt"), "x"); writeText(here("data/sample.csv"), "ruined"); } });
  await withEnv({ HOME: fakeHome }, () => captureConsole("log", () =>
    assert.rejects(() => updateProject("prepared", "break it"), /Update failed — the program is unchanged/)));
  assert.deepEqual([inProject("from-a-failed-update.txt"), inProject("data/sample.csv"), inProject("program.ts")], [null, "name,age,city\nada,36,london\n", LEANS]);

  // Where somebody has been at a place meanwhile, theirs stays — and that the agent's did not arrive is said.
  Object.assign(agent, {
    answer: LEANS,
    also: (here) => { writeText(here("notes.md"), "the agent's"); writeText(join(projectDir, "notes.md"), "somebody's, meanwhile"); writeText(here("../made-beside.txt"), "x"); },
  });
  const third = await captureConsole("warn", () => withEnv({ HOME: fakeHome }, () => captureConsole("log", () => updateProject("prepared", "again"))));
  assert.deepEqual(third.messages, [
    "[trama] 2 thing(s) done while the program was written did not reach the project:",
    "[trama]   notes.md — something else is at that place in the project",
    "[trama]   ../made-beside.txt — it was made beside the copy that was worked in, and goes with it: beside the project there is no such thing",
  ]);
  assert.equal(inProject("notes.md"), "somebody's, meanwhile");
  assert.equal(existsSync(join(projectDir, "..", "made-beside.txt")), false);

  // An agent that removes program.ts where it worked has not removed the program: that is its answer.
  Object.assign(agent, { answer: LEANS, also: (here) => rmSync(here("program.ts")) });
  const removed = await captureConsole("warn", () => withEnv({ HOME: fakeHome }, () => captureConsole("log", () => updateProject("prepared", "once more"))));
  assert.deepEqual([removed.messages, inProject("program.ts")], [[], LEANS]);

  // An agent that moves the program into a directory it makes, with a link at program.ts: the directory and what else
  // it put there arrive, the program is its answer where the program was, and what it left at the link is not carried.
  Object.assign(agent, {
    answer: LEANS,
    also: (here) => { rmSync(here("program.ts")); writeText(here("src/main.ts"), "// moved here"); symlinkSync("src/main.ts", here("program.ts")); writeText(here("src/beside.mjs"), "export {};\n"); },
  });
  const moved = await captureConsole("warn", () => withEnv({ HOME: fakeHome }, () => captureConsole("log", () => updateProject("prepared", "and again"))));
  assert.deepEqual([moved.messages, inProject("program.ts"), inProject("src/beside.mjs"), inProject("src/main.ts")], [[], LEANS, "export {};\n", null]);

  // A project that is being made is prepared the same way: it is made with what its program needs.
  Object.assign(agent, { answer: LEANS, also: () => {} });
  // (Nothing is told of the draft it left at program.ts, where there was none before: that is the program's place, and no work of its own.)
  const fourth = await captureConsole("warn", () => withEnv({ HOME: fakeHome }, () => captureConsole("log", () => createProject("made-whole", "use the columns"))));
  assert.deepEqual(fourth.messages, []);
  const made = join(fakeHome, ".trama", "projects", "made-whole");
  assert.equal(readFileSync(join(made, "program.ts"), "utf-8"), LEANS);
  assert.equal(readFileSync(join(made, "data", "sample.csv"), "utf-8"), "name,age,city\nada,36,london\n");
  assert.deepEqual(await withEnv({ HOME: fakeHome }, () => runProgram({ projectDir: made, maxRepairAttempts: 0, timeout: 20_000 })),
    { status: "done", result: { columns: ["name", "age", "city"] } });
});

test("a candidate is validated in the project as it will be: not with what was made beside the agent's copy, and not with what a repair's agent did where it worked", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));
  const projectDir = join(fakeHome, ".trama", "projects", "as-it-will-be");
  createProjectFixture(projectDir, { packageJson: { name: "as-it-will-be", type: "module" }, programSource: DEFAULT_PROGRAM });
  const originalAsk = llm.ask, originalRepair = llm.repair;
  t.after(() => { llm.ask = originalAsk; llm.repair = originalRepair; });
  const READS = (path) => `import { ctx } from "@trama-dev/runtime";\nimport * as fs from "fs";\nawait ctx.done({ read: fs.readFileSync(${JSON.stringify(path)}, "utf-8") });`;
  const update = () => withEnv({ HOME: fakeHome }, () => captureConsole("warn", () => captureConsole("log", () =>
    updateProject("as-it-will-be", "read it").then(() => "updated", (err) => err.message))));
  const program = () => readFileSync(join(projectDir, "program.ts"), "utf-8");

  // The agent makes what the program reads beside its copy, where it will not be beside the project.
  llm.ask = async (_prompt, call) => { writeText(join(call.cwd, "..", "made-beside.json"), "{}"); return READS("../made-beside.json"); };
  llm.repair = async () => { throw new Error("no fix today"); };
  assert.match((await update()).result.result, /Update failed — the program is unchanged[\s\S]*made-beside\.json/);
  assert.equal(program(), DEFAULT_PROGRAM);

  // The candidate fails for want of a file; the agent asked for a fix makes the file where it works and answers with the candidate.
  llm.ask = async () => READS("config.json");
  llm.repair = async (prompt, call) => { writeText(join(call.cwd, "config.json"), "{}"); return /Broken program:\n([\s\S]*?)\n\nError:/.exec(prompt)[1]; };
  assert.match((await update()).result.result, /Update failed — the program is unchanged[\s\S]*The repair returned the program unchanged\./);
  assert.equal(program(), DEFAULT_PROGRAM);
  assert.equal(existsSync(join(projectDir, "config.json")), false);

  // An agent that moves its copy away and leaves a link there, or leaves in it what cannot be copied, has its
  // program validated by itself — in the project as it is — and nothing else of its work is kept: which is said.
  const victim = makeTempDir("trama-victim-");
  t.after(() => cleanupTempDir(victim));
  const leaves = {
    "a link where its copy was": async (cwd) => {
      const { renameSync, symlinkSync } = await import("fs");
      renameSync(cwd, `${cwd}-moved`);
      symlinkSync(victim, cwd);
    },
    "a file nobody may read": async (cwd) => { writeText(join(cwd, "sealed.txt"), "x"); chmodSync(join(cwd, "sealed.txt"), 0o000); },
  };
  for (const [what, does] of Object.entries(leaves)) {
    if (process.getuid?.() === 0 && what === "a file nobody may read") continue; // (root reads everything)
    llm.ask = async (_prompt, call) => {
      writeText(join(call.cwd, "made-by-the-agent.txt"), "x");
      await does(call.cwd);
      return READS("meta.json") + `\n// ${what}`;
    };
    const { messages, result } = await update();
    assert.equal(result.result, "updated", what);
    assert.equal(messages.length, 1, `${what}: ${messages.join("\n")}`);
    assert.match(messages[0], /^\[trama\] the program is validated by itself, and nothing else its agent did is kept: the copy the agent worked in cannot be used \(.+\)$/, what);
    assert.equal(program(), READS("meta.json") + `\n// ${what}`, what);
    assert.equal(existsSync(join(projectDir, "made-by-the-agent.txt")), false, what);
    assert.equal(existsSync(join(projectDir, "sealed.txt")), false, what);
    assert.deepEqual((await import("fs")).readdirSync(victim), [], what);

    // And where the program, by itself, does not pass — it leaned on what the agent made — that it was by itself is still said.
    llm.ask = async (_prompt, call) => {
      writeText(join(call.cwd, "made-by-the-agent.txt"), "x");
      await does(call.cwd);
      return READS("made-by-the-agent.txt");
    };
    llm.repair = async () => { throw new Error("no fix today"); };
    const failed = await update();
    assert.match(failed.result.result, /Update failed — the program is unchanged[\s\S]*made-by-the-agent\.txt/, what);
    assert.equal(failed.messages.filter(line => /validated by itself/.test(line)).length, 1, `${what}: ${failed.messages.join("\n")}`);
  }

  // A candidate that, while it is validated, moves the agent's copy away and leaves a link there: it passes, and is
  // installed — and nothing is carried into the project from what the link leads to, which would empty it to match.
  let agentsCopy;
  llm.ask = async (_prompt, call) => {
    agentsCopy = call.cwd;
    writeText(join(call.cwd, "made-by-the-agent.txt"), "x");
    return `import { ctx } from "@trama-dev/runtime";\nimport * as fs from "fs";
if (fs.lstatSync(${JSON.stringify(call.cwd)}).isDirectory()) { fs.renameSync(${JSON.stringify(call.cwd)}, ${JSON.stringify(`${call.cwd}-moved`)}); fs.symlinkSync(${JSON.stringify(victim)}, ${JSON.stringify(call.cwd)}); }
await ctx.done();`;
  };
  const swapped = await update();
  assert.equal(swapped.result.result, "updated");
  assert.match(swapped.messages.join("\n"), /could not be carried into the project: the copy that was worked in is no longer where it was made/);
  assert.equal(existsSync(join(projectDir, "meta.json")), true);
  assert.equal(existsSync(join(projectDir, "made-by-the-agent.txt")), false);
  assert.deepEqual((await import("fs")).readdirSync(victim), []);
});

test("a candidate is validated where it will be installed: what the agent made of the name program.ts where it worked is not where its answer is tried", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));
  writeJson(join(fakeHome, ".trama", "config.json"), { maxRepairAttempts: 0 });
  const originalAsk = llm.ask;
  t.after(() => { llm.ask = originalAsk; });
  const FROM = (lib) => `import { ctx } from "@trama-dev/runtime";\nimport { where } from ${JSON.stringify(lib)};\nawait ctx.done({ where });`;
  const update = (name) => withEnv({ HOME: fakeHome }, () => captureConsole("warn", () => captureConsole("log", () =>
    updateProject(name, "use the library").then(() => "updated", (err) => err.message))));
  const run = (projectDir) => withEnv({ HOME: fakeHome }, () => runProgram({ projectDir, maxRepairAttempts: 0, timeout: 20_000 }));

  // A project whose program.ts is a link to src/app.ts: the agent puts a file of its own at the name, and answers
  // with a program written for where the program is — in src. It is validated there, and installed there.
  const linked = join(fakeHome, ".trama", "projects", "linked");
  createProjectFixture(linked, { packageJson: { name: "linked", type: "module" }, programSource: DEFAULT_PROGRAM });
  rmSync(join(linked, "program.ts"));
  writeText(join(linked, "src", "app.ts"), DEFAULT_PROGRAM);
  symlinkSync("src/app.ts", join(linked, "program.ts"));
  writeText(join(linked, "lib", "where.mjs"), 'export const where = "found from src";\n');
  llm.ask = async (_prompt, call) => {
    rmSync(join(call.cwd, "program.ts"));
    writeText(join(call.cwd, "program.ts"), "// a file of the agent's own, at the name");
    return FROM("../lib/where.mjs");
  };
  const first = await update("linked");
  assert.deepEqual([first.messages, first.result.result], [[], "updated"]);
  assert.equal(readFileSync(join(linked, "src", "app.ts"), "utf-8"), FROM("../lib/where.mjs"));
  assert.deepEqual(await run(linked), { status: "done", result: { where: "found from src" } });

  // And the other way round: a project whose program.ts is a file, an agent that moves it into src and leaves a
  // link, and an answer written for where the program is — beside lib. A link the agent left is not where it is tried.
  const plain = join(fakeHome, ".trama", "projects", "plain");
  createProjectFixture(plain, { packageJson: { name: "plain", type: "module" }, programSource: DEFAULT_PROGRAM });
  writeText(join(plain, "lib", "where.mjs"), 'export const where = "found from beside";\n');
  llm.ask = async (_prompt, call) => {
    rmSync(join(call.cwd, "program.ts"));
    writeText(join(call.cwd, "src", "main.ts"), "// moved here by the agent");
    symlinkSync("src/main.ts", join(call.cwd, "program.ts"));
    return FROM("./lib/where.mjs");
  };
  assert.equal((await update("plain")).result.result, "updated");
  assert.equal(readFileSync(join(plain, "program.ts"), "utf-8"), FROM("./lib/where.mjs"));
  assert.equal(existsSync(join(plain, "src", "main.ts")), false);
  assert.deepEqual(await run(plain), { status: "done", result: { where: "found from beside" } });

  // And a link of the project's that the agent made to lead elsewhere is put back as it was: the answer is tried
  // and installed where the project's link leads, and what else the agent made is kept — nothing is set aside.
  llm.ask = async (_prompt, call) => {
    rmSync(join(call.cwd, "program.ts"));
    writeText(join(call.cwd, "elsewhere", "impl.ts"), "// where the agent pointed the link");
    symlinkSync("elsewhere/impl.ts", join(call.cwd, "program.ts"));
    writeText(join(call.cwd, "lib", "where.mjs"), 'export const where = "found from src, as the agent left the library";\n');
    return FROM("../lib/where.mjs");
  };
  const repointed = await update("linked");
  assert.deepEqual([repointed.messages, repointed.result.result], [[], "updated"]);
  assert.equal((await import("fs")).readlinkSync(join(linked, "program.ts")), "src/app.ts");
  assert.equal(existsSync(join(linked, "elsewhere", "impl.ts")), false);
  assert.deepEqual(await run(linked), { status: "done", result: { where: "found from src, as the agent left the library" } });
});

test("where an agent changed the way from program.ts further along, its answer is validated by itself; and what a copy leaves out may be closed without costing what the agent made", { skip: process.getuid?.() === 0 }, async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));
  writeJson(join(fakeHome, ".trama", "config.json"), { maxRepairAttempts: 0 });
  const originalAsk = llm.ask;
  t.after(() => { llm.ask = originalAsk; });
  const HELPED = `import { ctx } from "@trama-dev/runtime";\nimport { from } from "./helper.mjs";\nawait ctx.done({ from });`;
  const update = (name) => withEnv({ HOME: fakeHome }, () => captureConsole("warn", () => captureConsole("log", () =>
    updateProject(name, "use the helper").then(() => "updated", (err) => err.message))));
  const run = (projectDir) => withEnv({ HOME: fakeHome }, () => runProgram({ projectDir, maxRepairAttempts: 0, timeout: 20_000 }));
  /** A project whose program.ts leads, by `links`, to src/app.ts — with a helper beside the program, and another in sub. */
  const project = (name, links) => {
    const projectDir = join(fakeHome, ".trama", "projects", name);
    createProjectFixture(projectDir, { packageJson: { name, type: "module" }, programSource: DEFAULT_PROGRAM });
    rmSync(join(projectDir, "program.ts"));
    writeText(join(projectDir, "src", "app.ts"), DEFAULT_PROGRAM);
    writeText(join(projectDir, "src", "helper.mjs"), 'export const from = "src";\n');
    writeText(join(projectDir, "sub", "helper.mjs"), 'export const from = "sub";\n');
    for (const [at, to] of Object.entries(links)) symlinkSync(to, join(projectDir, at));
    return projectDir;
  };
  const { renameSync } = await import("fs");
  const changes = {
    "a link on the way made to lead elsewhere": [{ "program.ts": "a", a: "src/app.ts" }, (cwd) => { rmSync(join(cwd, "a")); symlinkSync("sub/impl.ts", join(cwd, "a")); }],
    "a link on the way removed": [{ "program.ts": "a", a: "src/app.ts" }, (cwd) => rmSync(join(cwd, "a"))],
    "a directory on the way replaced by a link": [{ "program.ts": "src/app.ts" }, (cwd) => { renameSync(join(cwd, "src"), join(cwd, "src-moved")); symlinkSync("sub", join(cwd, "src")); }],
  };
  for (const [what, [links, does]] of Object.entries(changes)) {
    const name = what.replaceAll(" ", "-");
    const projectDir = project(name, links);
    llm.ask = async (_prompt, call) => { writeText(join(call.cwd, "made-by-the-agent.txt"), "x"); does(call.cwd); return HELPED; };
    const { messages, result } = await update(name);
    assert.equal(result.result, "updated", `${what}: ${result.result}`);
    assert.equal(messages.length, 1, `${what}: ${messages.join("\n")}`);
    assert.match(messages[0], /validated by itself[\s\S]*program\.ts does not lead, in the copy that was worked in, where it led before/, what);
    // Installed where the project's program is, having been validated there; and the project is otherwise as it was.
    assert.equal(readFileSync(join(projectDir, "src", "app.ts"), "utf-8"), HELPED, what);
    assert.equal(existsSync(join(projectDir, "made-by-the-agent.txt")), false, what);
    assert.deepEqual(await run(projectDir), { status: "done", result: { from: "src" } }, what);
  }

  // A directory of journals is no part of a copy, and is not looked into when one is made. An agent that makes one
  // where it works and closes it has still made what else it made: that arrives, and the program runs with it.
  const projectDir = join(fakeHome, ".trama", "projects", "closed-journals");
  createProjectFixture(projectDir, { scaffold: false, packageJson: { name: "closed-journals", type: "module" }, programSource: DEFAULT_PROGRAM });
  llm.ask = async (_prompt, call) => {
    mkdirSync(join(call.cwd, "logs", "journal"), { recursive: true });
    chmodSync(join(call.cwd, "logs", "journal"), 0o000);
    writeText(join(call.cwd, "helper.mjs"), 'export const from = "what the agent made";\n');
    return HELPED;
  };
  const { messages, result } = await update("closed-journals");
  // (Its directory of journals is not the project's, which has had one made for the validation meanwhile: that is said, and is all that is.)
  assert.deepEqual([messages, result.result], [[
    "[trama] 1 thing(s) done while the program was written did not reach the project:",
    "[trama]   logs/journal — something else is at that place in the project",
  ], "updated"]);
  assert.deepEqual(await run(projectDir), { status: "done", result: { from: "what the agent made" } });
});

test("a link the project lists as Program.ts, put back where the agent removed it, is no work of the agent's: nothing is said of it", { skip: !(existsSync(import.meta.filename.toUpperCase()) && existsSync(import.meta.filename.toLowerCase())) }, async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));
  writeJson(join(fakeHome, ".trama", "config.json"), { maxRepairAttempts: 0 });
  const projectDir = join(fakeHome, ".trama", "projects", "cased");
  createProjectFixture(projectDir, { packageJson: { name: "cased", type: "module" }, programSource: DEFAULT_PROGRAM });
  rmSync(join(projectDir, "program.ts"));
  writeText(join(projectDir, "src", "app.ts"), DEFAULT_PROGRAM);
  symlinkSync("src/app.ts", join(projectDir, "Program.ts"));
  const originalAsk = llm.ask;
  llm.ask = async (_prompt, call) => { rmSync(join(call.cwd, "Program.ts")); writeText(join(call.cwd, "made.mjs"), "export {};\n"); return UPDATED_PROGRAM; };
  t.after(() => { llm.ask = originalAsk; });

  const said = await captureConsole("warn", () => withEnv({ HOME: fakeHome }, () => captureConsole("log", () => updateProject("cased", "anything"))));
  assert.deepEqual(said.messages, []);
  assert.ok(said.result.messages.includes("[trama] 1 path(s) made or changed beside the program, while it was written: made.mjs"), said.result.messages.join("\n"));
  assert.equal(readFileSync(join(projectDir, "src", "app.ts"), "utf-8"), UPDATED_PROGRAM.trim());
  assert.equal(existsSync(join(projectDir, "made.mjs")), true);
});
