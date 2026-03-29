import assert from "node:assert/strict";
import test from "node:test";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { createProject, listProjects, showLogs, updateProject } from "../packages/runtime/dist/index.js";
import { PiAdapter } from "../packages/runtime/dist/pi-adapter.js";
import {
  DEFAULT_PROGRAM,
  captureConsole,
  cleanupTempDir,
  createProjectFixture,
  makeTempDir,
  readJson,
  withEnv,
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
  assert.equal(readFileSync(join(projectDir, "output.txt"), "utf-8"), "iteration:0");
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
        /Smoke run failed after 3 repair attempts/,
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

  assert.equal(readFileSync(join(projectDir, "program.ts"), "utf-8"), UPDATED_PROGRAM);
  assert.equal(readFileSync(join(projectDir, "updated.txt"), "utf-8"), "updated");
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

test("updateProject preserves update-repair history entries when rollback happens", async (t) => {
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
  assert.equal(historyLines.some(entry => entry.reason === "update-repair"), true);
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
