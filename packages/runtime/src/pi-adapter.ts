import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { onAbort, rejectOnAbort, throwIfAborted } from "./abort.js";
import { CutOff, type AgentBackend, type AgentCall, type AgentUsage } from "./agent-backend.js";
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

/** What a call may ask of its session, beyond where it works and what it is told. */
type Asked = Pick<AgentCall, "model" | "thinking" | "tools">;

const nameOf = (model: { provider: string; id: string }): string => `${model.provider}/${model.id}`;

/**
 * Why a session is not the one a call asked for. pi takes a level it does not
 * have for the model, or a tool it has not got, and gives what it can without
 * a word; a call is to have what it asked for or fail. (`serving` is the model
 * by name, if pi has a real one.)
 */
function whyNotAsAsked(session: AgentSession, { thinking, tools }: Asked, serving: string | null): string | undefined {
  if (thinking !== undefined && session.thinkingLevel !== thinking) {
    return `The model${serving ? ` ${serving}` : ""} does not think at level "${thinking}". ` +
      `Its levels: ${session.getAvailableThinkingLevels().join(", ")}.`;
  }
  if (tools !== undefined) {
    const given = session.getActiveToolNames();
    // (pi gives no tool that was not named. What it does not know by the name it was given, it leaves out.)
    if (!tools.every(name => given.includes(name))) {
      return `The agent cannot be given the tools ${JSON.stringify(tools)}: pi would give it ${JSON.stringify(given)}.`;
    }
  }
  return undefined;
}

/**
 * What a session has used: pi's own count, over everything the session asked
 * of its model — a summary it made of a long conversation included. Nothing,
 * where no tokens were counted: the model was never reached, or does not say.
 */
function usageOf(session: AgentSession): AgentUsage | undefined {
  const { tokens, cost } = session.getSessionStats();
  if (tokens.total === 0) return undefined;
  return {
    ...(session.model && { model: nameOf(session.model) }),
    input: tokens.input, output: tokens.output, cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite, cost,
  };
}

/**
 * The model's answer: the text of the last reply the session has on record.
 *
 * The record, not the conversation as the model would next be shown it: pi
 * takes a reply that failed out of that — one the provider refused as too
 * long, one cut off — and what is left there to be last is an earlier turn.
 * And an answer only if the model ended it itself: a reply that is the
 * provider's error, or was cut off at the output limit, is the call's failure
 * (the second with what there was of it: see CutOff). A reply cut off in the
 * middle of a tool call is never the last: pi has the model make the call again.
 */
function answerOf(session: AgentSession): string {
  const replies = session.sessionManager.getEntries()
    .flatMap(entry => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []));
  const reply = replies.at(-1);
  const text = reply?.content.map(block => (block.type === "text" ? block.text : "")).join("") ?? "";
  if (reply?.stopReason === "error") throw new Error(`The model did not answer: ${reply.errorMessage ?? "no reason given"}`);
  if (reply?.stopReason === "length") throw new CutOff(text);
  if (!text) throw new Error("Empty response from LLM");
  return text;
}

/** The pi coding agent, run in-process: a fresh in-memory session for every call. */
export class PiAdapter implements AgentBackend {
  private config: ModelConfig;

  constructor(config: ModelConfig) {
    this.config = config;
  }

  private async createSession(cwd: string, systemPrompt?: string, signal?: AbortSignal, asked: Asked = {}): Promise<AgentSession> {
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
    // user's models.json). The project's own, if it is unknown there, resolves
    // to undefined, in which case pi falls back to its own default selection;
    // a model a call names is that model or the call fails.
    const modelRuntime = await raceAbort(ModelRuntime.create({ signal }));
    // (A call names it "provider/model": the provider's name ends at a stroke, and either name may have more of them.)
    const strokes = [...(asked.model ?? "").matchAll(/\//g)].map(stroke => stroke.index);
    const model = asked.model === undefined
      ? modelRuntime.getModel(this.config.provider, this.config.model)
      : strokes.map(at => modelRuntime.getModel(asked.model!.slice(0, at), asked.model!.slice(at + 1))).find(Boolean);
    if (asked.model !== undefined && !model) {
      throw new Error(`Unknown model "${asked.model}". A model is named "provider/model", as pi's model catalog has it.`);
    }

    // Keep a reference to the raw promise so we can clean up a late-arriving session
    const sessionPromise = createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model,
      sessionManager: SessionManager.inMemory(cwd),
      resourceLoader,
      ...(asked.thinking !== undefined && { thinkingLevel: asked.thinking as AgentSession["thinkingLevel"] }),
      ...(asked.tools && { tools: asked.tools }),
    });

    try {
      const { session } = await raceAbort(sessionPromise);
      // With no model it can use, pi reports a placeholder that is not in its
      // catalog — a model is named only when it is a real one.
      const picked = session.model;
      const serving = picked && modelRuntime.getModel(picked.provider, picked.id) ? nameOf(picked) : null;
      const refusal = whyNotAsAsked(session, asked, serving);
      if (refusal) {
        session.dispose();
        throw new Error(refusal);
      }
      if (!model) this.warnUnknownModel(serving);
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

  /**
   * Run one prompt in a fresh session and return the assistant's text reply.
   *
   * Cancellation during `createSession` is handled step-by-step inside it; once
   * `session.prompt()` is running, a cancelled call has pi abort the run — which
   * settles the prompt (pi 1.x resolves it rather than rejecting, so
   * `signal.aborted` is checked again when `prompt()` returns) and leaves on
   * the session's record what the request that was cut off had taken by then.
   */
  async ask(prompt: string, call: AgentCall): Promise<string> {
    const { cwd, system, signal, used } = call;
    throwIfAborted(signal);

    const session = await this.createSession(cwd, system, signal, call);
    let offAbort = () => {};

    try {
      throwIfAborted(signal);
      offAbort = onAbort(signal, () => { session.abort().catch(() => {}); });

      // (The prompt is a program's text, whatever it begins with: it is not one of the user's own pi commands or templates.)
      await session.prompt(prompt, { expandPromptTemplates: false });
      // An aborted prompt resolves with no usable answer — report it as an abort,
      // not as an empty LLM response.
      throwIfAborted(signal);
      return answerOf(session);
    } finally {
      offAbort();
      session.dispose();
      // What the call used is said when it is over, however it ended.
      const usage = used && usageOf(session);
      if (usage) used(usage);
    }
  }
}
