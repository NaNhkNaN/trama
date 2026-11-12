import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { rejectOnAbort, type AgentBackend, type AgentCall } from "./agent-backend.js";
import type { ModelConfig } from "./runner-types.js";

/**
 * pi is loaded when it is first needed, not when this file is: it is most of
 * what the runtime weighs, and listing projects, reading logs, or running a
 * program that never calls the agent does not need it.
 */
const loadPi = () => import("@earendil-works/pi-coding-agent");

/** The pi version this runtime is built against (recorded in each project's meta.json). */
export const piVersion = async (): Promise<string> => (await loadPi()).VERSION;

/** provider/model pairs already warned about, so a loop of agent calls warns once per process. */
const warnedUnknownModels = new Set<string>();

/** The pi coding agent, run in-process: a fresh in-memory session for every call. */
export class PiAdapter implements AgentBackend {
  private config: ModelConfig;

  constructor(config: ModelConfig) {
    this.config = config;
  }

  private async createSession(cwd: string, systemPrompt?: string, signal?: AbortSignal): Promise<AgentSession> {
    if (signal?.aborted) throw new Error("Aborted");

    // Each step below is given up on the moment the call is cancelled.
    const raceAbort = <T>(step: Promise<T>) => rejectOnAbort(step, signal);

    const { createAgentSession, SessionManager, DefaultResourceLoader, ModelRuntime, getAgentDir } = await raceAbort(loadPi());
    const agentDir = getAgentDir();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      noExtensions: true,
      noSkills: true,
      ...(systemPrompt && { appendSystemPrompt: [systemPrompt] }),
    });

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
      cwd,
      agentDir,
      modelRuntime,
      model,
      sessionManager: SessionManager.inMemory(cwd),
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
  async ask(prompt: string, call: AgentCall): Promise<string> {
    const { cwd, system, signal } = call;
    if (signal?.aborted) throw new Error("Aborted");

    // Track session so abort can dispose it at any point — even during createSession
    let session: AgentSession | null = null;
    const onAbort = () => session?.dispose();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      session = await this.createSession(cwd, system, signal);
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
}
