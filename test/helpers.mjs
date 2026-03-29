import { spawn } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = dirname(TEST_DIR);

export const DEFAULT_PROGRAM = `import { ctx, tools } from "@trama-dev/runtime";

await tools.write("output.txt", \`iteration:\${ctx.iteration}\`);
await ctx.log("ran", { iteration: ctx.iteration });
ctx.state.status = "ok";
await ctx.done({ final: "ok" });
`;

export function makeTempDir(prefix = "trama-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupTempDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

export function writeText(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function readText(path) {
  return readFileSync(path, "utf-8");
}

export function writeJson(path, value) {
  writeText(path, JSON.stringify(value, null, 2));
}

export function readJson(path) {
  return JSON.parse(readText(path));
}

export function createProjectFixture(projectDir, options = {}) {
  mkdirSync(projectDir, { recursive: true });

  if (options.scaffold ?? true) {
    mkdirSync(join(projectDir, "logs"), { recursive: true });
    mkdirSync(join(projectDir, "history"), { recursive: true });
  }

  writeJson(join(projectDir, "meta.json"), {
    input: options.metaInput ?? { prompt: "test prompt", args: {} },
    createdAt: "2026-03-28T00:00:00.000Z",
    piVersion: "0.63.1",
  });

  writeText(join(projectDir, "program.ts"), options.programSource ?? DEFAULT_PROGRAM);

  if (options.packageJson !== undefined) {
    writeJson(join(projectDir, "package.json"), options.packageJson);
  }

  if (typeof options.state === "string") {
    writeText(join(projectDir, "state.json"), options.state);
  } else if (options.state) {
    writeJson(join(projectDir, "state.json"), options.state);
  }
}

export async function captureConsole(method, fn) {
  const original = console[method].bind(console);
  const messages = [];
  console[method] = (...args) => {
    messages.push(args.map(arg => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" "));
  };

  try {
    const result = await fn();
    return { messages, result };
  } finally {
    console[method] = original;
  }
}

export async function withEnv(patch, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(patch)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export async function runNodeCommand(args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}
