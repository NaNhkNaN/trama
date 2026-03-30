import assert from "node:assert/strict";
import test from "node:test";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { createProject, listProjects, showLogs, updateProject, validateProjectName } from "../packages/runtime/dist/index.js";
import { PiAdapter } from "../packages/runtime/dist/pi-adapter.js";
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

  const originalAsk = PiAdapter.prototype.ask;
  const originalRepair = PiAdapter.prototype.repair;
  const prompts = [];

  PiAdapter.prototype.ask = async function ask(prompt, options) {
    prompts.push(options?.system ?? "");
    assert.match(prompt, /Output ONLY the TypeScript program/);
    return DEFAULT_PROGRAM;
  };
  PiAdapter.prototype.repair = async function repair() {
    throw new Error("repair should not be called");
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await createProject("alpha", "write an output file", { model: "test-model" });
    });
  } finally {
    PiAdapter.prototype.ask = originalAsk;
    PiAdapter.prototype.repair = originalRepair;
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

test("createProject generation runs in a temp cwd and does not leak ask side effects", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const originalAsk = PiAdapter.prototype.ask;
  const originalRepair = PiAdapter.prototype.repair;
  let observedCwd = "";

  PiAdapter.prototype.ask = async function ask() {
    observedCwd = this.cwd;
    writeText(join(this.cwd, "ask-side-effect.txt"), "temp-only");
    return DEFAULT_PROGRAM;
  };
  PiAdapter.prototype.repair = async function repair() {
    throw new Error("repair should not be called");
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await createProject("alpha-temp-cwd", "write an output file");
    });
  } finally {
    PiAdapter.prototype.ask = originalAsk;
    PiAdapter.prototype.repair = originalRepair;
  }

  const projectDir = join(fakeHome, ".trama", "projects", "alpha-temp-cwd");
  assert.match(observedCwd, /trama-gen-/);
  assert.notEqual(observedCwd, projectDir);
  assert.equal(existsSync(join(projectDir, "ask-side-effect.txt")), false);
});

test("createProject cleans up the project directory when generation fails before program.ts is written", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const originalAsk = PiAdapter.prototype.ask;
  PiAdapter.prototype.ask = async function ask() {
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
    PiAdapter.prototype.ask = originalAsk;
  }

  assert.equal(existsSync(join(fakeHome, ".trama", "projects", "broken")), false);
});

test("createProject keeps the generated project when validation fails after program.ts is written", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const originalAsk = PiAdapter.prototype.ask;
  const originalRepair = PiAdapter.prototype.repair;

  PiAdapter.prototype.ask = async function ask() {
    return 'throw new Error("broken");';
  };
  PiAdapter.prototype.repair = async function repair() {
    return 'throw new Error("still broken");';
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await assert.rejects(
        async () => createProject("broken-after-write", "make something"),
        /Failed after 3 repair attempts/,
      );
    });
  } finally {
    PiAdapter.prototype.ask = originalAsk;
    PiAdapter.prototype.repair = originalRepair;
  }

  const projectDir = join(fakeHome, ".trama", "projects", "broken-after-write");
  assert.equal(existsSync(projectDir), true);
  assert.equal(existsSync(join(projectDir, "program.ts")), true);
});

test("createProject smoke validation errors include buffered stdout", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const originalAsk = PiAdapter.prototype.ask;
  const originalRepair = PiAdapter.prototype.repair;

  PiAdapter.prototype.ask = async function ask() {
    return 'console.log("stdout-hint"); process.exit(1);';
  };
  PiAdapter.prototype.repair = async function repair() {
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
    PiAdapter.prototype.ask = originalAsk;
    PiAdapter.prototype.repair = originalRepair;
  }
});

test("createProject smoke repair runs in a temp cwd and records create-repair history", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const originalAsk = PiAdapter.prototype.ask;
  const originalRepair = PiAdapter.prototype.repair;
  let repairCwd = "";
  const fixedProgram = `import { ctx, tools } from "@trama-dev/runtime";
await tools.write("fixed.txt", "ok");
await ctx.done();
`;

  PiAdapter.prototype.ask = async function ask() {
    return 'throw new Error("boom");';
  };
  PiAdapter.prototype.repair = async function repair() {
    repairCwd = this.cwd;
    writeText(join(this.cwd, "repair-side-effect.txt"), "temp-only");
    return fixedProgram;
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await createProject("alpha-repair", "fix the generated program");
    });
  } finally {
    PiAdapter.prototype.ask = originalAsk;
    PiAdapter.prototype.repair = originalRepair;
  }

  const projectDir = join(fakeHome, ".trama", "projects", "alpha-repair");
  assert.match(repairCwd, /trama-repair-/);
  assert.notEqual(repairCwd, projectDir);
  assert.equal(existsSync(join(projectDir, "repair-side-effect.txt")), false);
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), fixedProgram);

  const historyLines = readFileSync(join(projectDir, "history", "index.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));
  assert.equal(historyLines.some(entry => entry.reason === "create-repair"), true);
});

test("createProject accepts long-running server programs during smoke validation after readiness log", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  writeJson(join(fakeHome, ".trama", "config.json"), {
    provider: "anthropic",
    model: "test-model",
    maxRepairAttempts: 0,
    defaultTimeout: 1_000,
    defaultMaxIterations: 100,
  });

  const originalAsk = PiAdapter.prototype.ask;
  const originalRepair = PiAdapter.prototype.repair;
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

await ctx.log("server started", { mode: "smoke-ready" });

process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});

await new Promise(() => {});
`;

  PiAdapter.prototype.ask = async function ask() {
    return serverProgram;
  };
  PiAdapter.prototype.repair = async function repair() {
    repairCalled = true;
    throw new Error("repair should not run");
  };

  try {
    const startedAt = Date.now();
    await withEnv({ HOME: fakeHome }, async () => {
      await createProject("server-app", "host a website");
    });
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 5_000, `expected smoke validation to finish quickly, got ${elapsed}ms`);
  } finally {
    PiAdapter.prototype.ask = originalAsk;
    PiAdapter.prototype.repair = originalRepair;
  }

  const projectDir = join(fakeHome, ".trama", "projects", "server-app");
  assert.equal(repairCalled, false);
  assert.equal(existsSync(join(projectDir, "program.ts")), true);
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

  const originalAsk = PiAdapter.prototype.ask;
  const originalRepair = PiAdapter.prototype.repair;
  let systemPrompt = "";

  PiAdapter.prototype.ask = async function ask(_prompt, options) {
    systemPrompt = options?.system ?? "";
    return UPDATED_PROGRAM;
  };
  PiAdapter.prototype.repair = async function repair() {
    throw new Error("repair should not be called");
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await updateProject("beta", "add an updated output");
    });
  } finally {
    PiAdapter.prototype.ask = originalAsk;
    PiAdapter.prototype.repair = originalRepair;
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

test("updateProject generation runs in a temp cwd and does not leak ask side effects", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const projectDir = join(fakeHome, ".trama", "projects", "beta-temp-cwd");
  createProjectFixture(projectDir, {
    state: { prior: "state" },
    packageJson: { name: "beta-project" },
    programSource: DEFAULT_PROGRAM,
  });

  const originalAsk = PiAdapter.prototype.ask;
  const originalRepair = PiAdapter.prototype.repair;
  let observedCwd = "";

  PiAdapter.prototype.ask = async function ask() {
    observedCwd = this.cwd;
    writeText(join(this.cwd, "ask-side-effect.txt"), "temp-only");
    return UPDATED_PROGRAM;
  };
  PiAdapter.prototype.repair = async function repair() {
    throw new Error("repair should not be called");
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await updateProject("beta-temp-cwd", "add an updated output");
    });
  } finally {
    PiAdapter.prototype.ask = originalAsk;
    PiAdapter.prototype.repair = originalRepair;
  }

  assert.match(observedCwd, /trama-gen-/);
  assert.notEqual(observedCwd, projectDir);
  assert.equal(existsSync(join(projectDir, "ask-side-effect.txt")), false);
});

test("updateProject restores original program.ts when validation fails", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  const projectDir = join(fakeHome, ".trama", "projects", "gamma");
  createProjectFixture(projectDir, {
    packageJson: { type: "module" },
    programSource: DEFAULT_PROGRAM,
  });

  const originalAsk = PiAdapter.prototype.ask;
  const originalRepair = PiAdapter.prototype.repair;

  PiAdapter.prototype.ask = async function ask() {
    return 'throw new Error("broken");';
  };
  PiAdapter.prototype.repair = async function repair() {
    return 'throw new Error("still broken");';
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await assert.rejects(
        async () => updateProject("gamma", "break it"),
        /have been restored/,
      );
    });
  } finally {
    PiAdapter.prototype.ask = originalAsk;
    PiAdapter.prototype.repair = originalRepair;
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

  const originalAsk = PiAdapter.prototype.ask;
  const originalRepair = PiAdapter.prototype.repair;
  const brokenProgram = `import { ctx } from "@trama-dev/runtime";

ctx.state.mode = "broken";
await ctx.checkpoint();
throw new Error("boom");
`;

  PiAdapter.prototype.ask = async function ask() {
    return brokenProgram;
  };
  PiAdapter.prototype.repair = async function repair() {
    return brokenProgram;
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await assert.rejects(
        async () => updateProject("delta", "break state"),
        /project files have been restored/,
      );
    });
  } finally {
    PiAdapter.prototype.ask = originalAsk;
    PiAdapter.prototype.repair = originalRepair;
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

  const originalAsk = PiAdapter.prototype.ask;
  const originalRepair = PiAdapter.prototype.repair;
  const brokenProgram = `import { tools } from "@trama-dev/runtime";

await tools.write("leftover.txt", "oops");
throw new Error("boom");
`;

  PiAdapter.prototype.ask = async function ask() {
    return brokenProgram;
  };
  PiAdapter.prototype.repair = async function repair() {
    return brokenProgram;
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await assert.rejects(
        async () => updateProject("epsilon", "leave files"),
        /project files have been restored/,
      );
    });
  } finally {
    PiAdapter.prototype.ask = originalAsk;
    PiAdapter.prototype.repair = originalRepair;
  }

  assert.equal(existsSync(join(projectDir, "leftover.txt")), false);
  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), DEFAULT_PROGRAM);
});

test("updateProject does not record unverified repair history entries on rollback", async (t) => {
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

  const originalAsk = PiAdapter.prototype.ask;
  const originalRepair = PiAdapter.prototype.repair;
  const brokenProgram = 'throw new Error("boom");\n';

  PiAdapter.prototype.ask = async function ask() {
    return brokenProgram;
  };
  PiAdapter.prototype.repair = async function repair() {
    return brokenProgram;
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await assert.rejects(
        async () => updateProject("zeta", "break history"),
        /project files have been restored/,
      );
    });
  } finally {
    PiAdapter.prototype.ask = originalAsk;
    PiAdapter.prototype.repair = originalRepair;
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

  const originalAsk = PiAdapter.prototype.ask;
  const originalRepair = PiAdapter.prototype.repair;

  PiAdapter.prototype.ask = async function ask() {
    return "```typescript\n" + DEFAULT_PROGRAM + "```";
  };
  PiAdapter.prototype.repair = async function repair() {
    throw new Error("repair should not be called");
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await createProject("fenced", "write something");
    });
  } finally {
    PiAdapter.prototype.ask = originalAsk;
    PiAdapter.prototype.repair = originalRepair;
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

  const originalAsk = PiAdapter.prototype.ask;
  const originalRepair = PiAdapter.prototype.repair;

  PiAdapter.prototype.ask = async function ask() {
    return "```typescript\n" + UPDATED_PROGRAM + "```";
  };
  PiAdapter.prototype.repair = async function repair() {
    throw new Error("repair should not be called");
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await updateProject("fenced-update", "add an updated output");
    });
  } finally {
    PiAdapter.prototype.ask = originalAsk;
    PiAdapter.prototype.repair = originalRepair;
  }

  const written = readFileSync(join(projectDir, "program.ts"), "utf-8");
  assert.doesNotMatch(written, /^```/m);
  assert.equal(written, UPDATED_PROGRAM.trimEnd());
});

test("createProject smoke validation uses config maxRepairAttempts", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  writeJson(join(fakeHome, ".trama", "config.json"), { maxRepairAttempts: 0 });

  const originalAsk = PiAdapter.prototype.ask;
  const originalRepair = PiAdapter.prototype.repair;
  let repairCalled = false;

  PiAdapter.prototype.ask = async function ask() {
    return 'throw new Error("broken");';
  };
  PiAdapter.prototype.repair = async function repair() {
    repairCalled = true;
    return 'throw new Error("still broken");';
  };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await assert.rejects(
        async () => createProject("no-repair", "make something"),
        /Failed after 0 repair attempts/,
      );
    });
    assert.equal(repairCalled, false, "repair should not be called when maxRepairAttempts is 0");
  } finally {
    PiAdapter.prototype.ask = originalAsk;
    PiAdapter.prototype.repair = originalRepair;
  }
});

// --- Additional coverage tests ---

test("createProject rejects duplicate project names", async (t) => {
  const fakeHome = makeTempDir("trama-home-");
  t.after(() => cleanupTempDir(fakeHome));

  // Pre-create the project directory
  mkdirSync(join(fakeHome, ".trama", "projects", "dupe"), { recursive: true });

  const originalAsk = PiAdapter.prototype.ask;
  PiAdapter.prototype.ask = async function ask() { return DEFAULT_PROGRAM; };

  try {
    await withEnv({ HOME: fakeHome }, async () => {
      await assert.rejects(
        async () => createProject("dupe", "anything"),
        /already exists/,
      );
    });
  } finally {
    PiAdapter.prototype.ask = originalAsk;
  }
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
