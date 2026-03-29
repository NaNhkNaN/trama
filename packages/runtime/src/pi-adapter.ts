import {
  createAgentSession,
  SessionManager,
  DefaultResourceLoader,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import type { PiAdapterConfig, RepairInput } from "./types.js";

export class PiAdapter {
  private config: PiAdapterConfig;
  private cwd: string;

  constructor(config: PiAdapterConfig, cwd: string) {
    this.config = config;
    this.cwd = cwd;
  }

  private async createSession(systemPrompt?: string): Promise<AgentSession> {
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.cwd,
      noExtensions: true,
      noSkills: true,
      ...(systemPrompt && { appendSystemPrompt: systemPrompt }),
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: this.cwd,
      model: (getModel as Function)(this.config.provider, this.config.model),
      sessionManager: SessionManager.inMemory(),
      resourceLoader,
    });
    return session;
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

  async ask(prompt: string, options?: { system?: string }): Promise<string> {
    const session = await this.createSession(options?.system);
    try {
      await session.prompt(prompt);
      const text = this.extractText(session);
      if (!text) throw new Error("Empty response from LLM");
      return text;
    } finally {
      session.dispose();
    }
  }

  async repair(input: RepairInput): Promise<string> {
    return this.ask(
      `Fix this program so it runs.\n\n` +
      `Runtime types:\n${input.runtimeTypes}\n\n` +
      `Broken program:\n${input.programSource}\n\n` +
      `Error:\n${input.error}\n\n` +
      `Output ONLY the fixed program. No explanation.`,
      { system: "You are a TypeScript repair tool." }
    );
  }
}
