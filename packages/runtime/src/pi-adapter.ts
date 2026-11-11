import {
  createAgentSession,
  SessionManager,
  DefaultResourceLoader,
  ModelRuntime,
  getAgentDir,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { PiAdapterConfig, RepairInput } from "./types.js";

/** Strip markdown code fences and trim whitespace. */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  // Extract the last fenced code block (LLMs may prepend explanation or emit multiple blocks)
  const matches = [...trimmed.matchAll(/```(?:\w*)\s*\n([\s\S]*?)\n\s*```/g)];
  if (matches.length > 0) {
    return matches[matches.length - 1][1].trim();
  }
  return trimmed;
}

/** provider/model pairs already warned about, so a loop of agent calls warns once per process. */
const warnedUnknownModels = new Set<string>();

export class PiAdapter {
  private config: PiAdapterConfig;
  private cwd: string;

  constructor(config: PiAdapterConfig, cwd: string) {
    this.config = config;
    this.cwd = cwd;
  }

  /** Create a copy of this adapter that operates in a different working directory. */
  withCwd(cwd: string): PiAdapter {
    return new PiAdapter(this.config, cwd);
  }

  private async createSession(systemPrompt?: string, signal?: AbortSignal): Promise<AgentSession> {
    if (signal?.aborted) throw new Error("Aborted");

    const agentDir = getAgentDir();
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir,
      noExtensions: true,
      noSkills: true,
      ...(systemPrompt && { appendSystemPrompt: [systemPrompt] }),
    });

    // Race an async step against the abort signal.
    // Returns the result on success, or rejects with "Aborted" on abort.
    const raceAbort = <T>(promise: Promise<T>): Promise<T> => {
      if (!signal) return promise;
      let onAbort: (() => void) | null = null;
      const cleanup = () => {
        if (onAbort) { signal.removeEventListener("abort", onAbort); onAbort = null; }
      };
      return Promise.race([
        promise.finally(cleanup),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error("Aborted"));
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    };

    await raceAbort(resourceLoader.reload());
    if (signal?.aborted) throw new Error("Aborted");

    // Resolve the model through pi's model runtime (built-in catalog plus the
    // user's models.json). An unknown provider/model resolves to undefined, in
    // which case pi falls back to its own default selection.
    const modelRuntime = await raceAbort(ModelRuntime.create({ signal }));
    if (signal?.aborted) throw new Error("Aborted");
    const model = modelRuntime.getModel(this.config.provider, this.config.model);

    // Keep a reference to the raw promise so we can clean up a late-arriving session
    const sessionPromise = createAgentSession({
      cwd: this.cwd,
      agentDir,
      modelRuntime,
      model,
      sessionManager: SessionManager.inMemory(this.cwd),
      resourceLoader,
    });

    try {
      const { session } = await raceAbort(sessionPromise);
      if (!model) {
        // With nothing to fall back to, pi reports a placeholder model that is
        // not in its catalog — only name the fallback when it is a real one.
        const picked = session.model;
        const fallback = picked && modelRuntime.getModel(picked.provider, picked.id)
          ? `${picked.provider}/${picked.id}` : null;
        this.warnUnknownModel(fallback);
      }
      return session;
    } catch (err) {
      // If abort won the race, the real promise may still resolve later — dispose it
      sessionPromise.then(({ session }) => session.dispose()).catch(() => {});
      throw err;
    }
  }

  /**
   * The configured provider/model is not in pi's catalog, so pi picked a model
   * on its own. Say so once — otherwise a typo silently runs a different model.
   */
  private warnUnknownModel(fallback: string | null): void {
    const requested = `${this.config.provider}/${this.config.model}`;
    if (warnedUnknownModels.has(requested)) return;
    warnedUnknownModels.add(requested);
    console.warn(
      `[trama] warning: model "${requested}" was not found in pi's model catalog. ` +
      (fallback
        ? `pi is falling back to "${fallback}". `
        : `pi has no fallback model available, so LLM calls will fail. `) +
      `Check "provider" and "model" in ~/.trama/config.json or the project's meta.json.`
    );
  }

  private extractText(session: AgentSession): string {
    const messages = session.state.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if ("role" in msg && msg.role === "assistant") {
        return (msg.content as Array<{ type: string; text?: string }>)
          .filter(b => b.type === "text" && b.text)
          .map(b => b.text!)
          .join("");
      }
    }
    return "";
  }

  /**
   * Abort cancellation relies on session.dispose() interrupting session.prompt().
   * This is an upstream contract of pi-coding-agent — if dispose() does not
   * actually settle the in-flight prompt, the abort signal will not terminate the call.
   * pi 1.x settles the prompt by resolving it (not rejecting), so abort is
   * re-checked after prompt() returns.
   */
  async ask(prompt: string, options?: { system?: string; signal?: AbortSignal }): Promise<string> {
    const signal = options?.signal;
    if (signal?.aborted) throw new Error("Aborted");

    // Track session so abort can dispose it at any point — even during createSession
    let session: AgentSession | null = null;
    const onAbort = () => session?.dispose();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      session = await this.createSession(options?.system, signal);
      // Re-check: abort may have fired during createSession (before session existed)
      if (signal?.aborted) throw new Error("Aborted");

      await session.prompt(prompt);
      // An aborted prompt resolves with no usable answer — report it as an abort,
      // not as an empty LLM response.
      if (signal?.aborted) throw new Error("Aborted");
      const text = this.extractText(session);
      if (!text) throw new Error("Empty response from LLM");
      return text;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      session?.dispose();
    }
  }

  async repair(input: RepairInput, signal?: AbortSignal): Promise<string> {
    const response = await this.ask(
      `Fix this program so it runs.\n\n` +
      `Runtime types:\n${input.runtimeTypes}\n\n` +
      `Broken program:\n${input.programSource}\n\n` +
      `Error:\n${input.error}\n\n` +
      `Output ONLY the fixed program. No explanation.`,
      { system: "You are a TypeScript repair tool.", signal }
    );
    return stripCodeFences(response);
  }
}
