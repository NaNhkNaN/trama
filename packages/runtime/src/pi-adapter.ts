import {
  createAgentSession,
  SessionManager,
  DefaultResourceLoader,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
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

    const resourceLoader = new DefaultResourceLoader({
      cwd: this.cwd,
      noExtensions: true,
      noSkills: true,
      ...(systemPrompt && { appendSystemPrompt: systemPrompt }),
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

    // Keep a reference to the raw promise so we can clean up a late-arriving session
    const sessionPromise = createAgentSession({
      cwd: this.cwd,
      model: (getModel as Function)(this.config.provider, this.config.model),
      sessionManager: SessionManager.inMemory(),
      resourceLoader,
    });

    try {
      const { session } = await raceAbort(sessionPromise);
      return session;
    } catch (err) {
      // If abort won the race, the real promise may still resolve later — dispose it
      sessionPromise.then(({ session }) => session.dispose()).catch(() => {});
      throw err;
    }
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
   * actually reject the in-flight prompt, the abort signal will not terminate the call.
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
