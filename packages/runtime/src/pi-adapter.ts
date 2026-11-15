import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { onAbort, rejectOnAbort, throwIfAborted } from "./abort.js";
import type { AgentBackend, AgentCall } from "./agent-backend.js";
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

    // Resolve the model through pi's model runtime (built-in catalog plus the
    // user's models.json). An unknown provider/model resolves to undefined, in
    // which case pi falls back to its own default selection.
    const modelRuntime = await raceAbort(ModelRuntime.create({ signal }));
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
   * Run one prompt in a fresh session and return the assistant's text reply.
   *
   * Cancellation during `createSession` is handled step-by-step inside it; once
   * `session.prompt()` is running, abort disposes the session so pi settles the
   * in-flight prompt (pi 1.x resolves rather than rejects on dispose, so
   * `signal.aborted` is checked again when `prompt()` returns).
   */
  async ask(prompt: string, call: AgentCall): Promise<string> {
    const { cwd, system, signal } = call;
    throwIfAborted(signal);

    const session = await this.createSession(cwd, system, signal);
    let offAbort = () => {};

    try {
      throwIfAborted(signal);
      offAbort = onAbort(signal, () => session.dispose());

      await session.prompt(prompt);
      // An aborted prompt resolves with no usable answer — report it as an abort,
      // not as an empty LLM response.
      throwIfAborted(signal);
      const text = this.extractText(session);
      if (!text) throw new Error("Empty response from LLM");
      return text;
    } finally {
      offAbort();
      session.dispose();
    }
  }
}
