import type { AgentSession, ExtensionFactory, InlineExtension, ResourceLoader, SettingsManager as Settings } from "@earendil-works/pi-coding-agent";
import { onAbort, rejectOnAbort, throwIfAborted } from "./abort.js";
import { messageOf } from "./errors.js";
import { createAgentHosts } from "./agent-hosts.js";
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

/**
 * pi's own extensions — its MCP support among them. The `pi` command hands
 * them to its loader, and the package does not export them: they are read
 * from where pi keeps them, beside what it does export. A pi that keeps them
 * elsewhere is one a call with extensions cannot be served by as it asked —
 * its MCP servers would be missing with no word of it — and the call fails.
 */
async function builtInExtensions(): Promise<InlineExtension[]> {
  const kept = new URL("./extensions/index.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
  try {
    const found: unknown = (await import(kept.href)).builtInExtensions;
    if (!Array.isArray(found)) throw new Error("the file exports none");
    return found as InlineExtension[];
  } catch (err) {
    throw new Error(`pi's built-in extensions (its MCP support among them) cannot be had: trama reads them from pi's own files, at ${kept.pathname} (${messageOf(err)}).`);
  }
}

/** provider/model pairs already warned about, so a loop of agent calls warns once per process. */
const warnedUnknownModels = new Set<string>();

/** What a call may ask of its session, beyond where it works and what it is told. */
type Asked = Pick<AgentCall, "model" | "thinking" | "tools" | "skills" | "templates" | "extensions" | "asText">;

const nameOf = (model: { provider: string; id: string }): string => `${model.provider}/${model.id}`;

/**
 * Of what a call may have all of, some by name, or none: whether it chose
 * from them, and which by name. (A list with no name in it chooses none, as
 * any list chooses only what it names.)
 */
type Choice = boolean | string[] | undefined;
const chosen = (choice: Choice): boolean => choice === true || Array.isArray(choice);
const named = (choice: Choice): string[] | undefined => (Array.isArray(choice) ? choice : undefined);

/** What pi found of each kind a call may choose from, by name: all of it, whatever the call chose. */
interface Found { skills: string[]; templates: string[] }

/** What pi writes of a set of skills, to tell a model of them: differently for each way the model has of reading one. */
type SkillsAsTold = Awaited<ReturnType<typeof loadPi>>["formatSkillsForPrompt"];
const WAYS_TO_READ = ["read", "bash", "indirect"] as const;

/** How long an extension is given to hear that its session is over — and, where a call is cancelled while it is still being told that one begins, to have heard that first. */
const EXTENSION_LEAVE_MS = 5_000;

/**
 * How long a cancelled call is waited for where something holds it. Less
 * than a runner gives the process that serves the call to let go of it
 * (KILL_GRACE_MS): what the call used is said when it is given up here, and
 * that is to be heard there before the process is ended.
 */
const HELD_MS = 3_000;

/**
 * `work` — but once `signal` has said to stop, waited for no longer than a
 * while: a call that was cancelled is not held for good by what does not
 * return (an extension's handler, where the call has extensions).
 */
function notHeld<T>(work: Promise<T>, signal: AbortSignal | undefined, ms: number): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    let late: NodeJS.Timeout | undefined;
    const off = onAbort(signal, () => { late = setTimeout(() => reject(new Error("Aborted")), ms); });
    const over = () => {
      off();
      clearTimeout(late);
    };
    work.then(value => { over(); resolve(value); }, err => { over(); reject(err); });
  });
}

/** Wait for `work`, but no longer than a while. (What becomes of it is not asked.) */
async function within(work: Promise<unknown>, ms: number): Promise<void> {
  let giveUp: NodeJS.Timeout | undefined;
  await Promise.race([work.catch(() => {}), new Promise(resolve => { giveUp = setTimeout(resolve, ms); })]);
  clearTimeout(giveUp);
}

/**
 * Why a session is not the one a call asked for. pi takes a level it does not
 * have for the model, or a tool it has not got, and gives what it can without
 * a word; a call is to have what it asked for or fail. (`serving` is the model
 * by name, if pi has a real one.)
 */
function whyNotAsAsked(session: AgentSession, asked: Asked, serving: string | null, found: Found, asTold: SkillsAsTold): string | undefined {
  const { thinking } = asked;
  // (An extension pi has something against — it did not load, or a tool of it bears the name of another's — is
  // not one the call has as it was written: and it may be where a tool the call names was to come from.)
  const failed = asked.extensions ? session.resourceLoader.getExtensions().errors[0] : undefined;
  if (failed) return `The extension ${failed.path} is not as pi would have it: ${failed.error}`;
  if (thinking !== undefined && session.thinkingLevel !== thinking) {
    return `The model${serving ? ` ${serving}` : ""} does not think at level "${thinking}". ` +
      `Its levels: ${session.getAvailableThinkingLevels().join(", ")}.`;
  }
  // (With extensions, an agent's tools are not all there yet: see whyNotTheTools.)
  const tools = asked.extensions ? undefined : whyNotTheTools(session, asked.tools);
  if (tools) return tools;
  const lacking = (kind: string, choice: Choice, had: string[]): string | undefined => {
    const missing = named(choice)?.find(name => !had.includes(name));
    return missing === undefined ? undefined : `pi has no ${kind} "${missing}". Its ${kind}s: ${had.join(", ") || "none"}.`;
  };
  const missing = lacking("skill", asked.skills, found.skills) ?? lacking("prompt template", asked.templates, found.templates);
  if (missing) return missing;
  // pi tells a model of its skills only where the model has something to read them with: a skill
  // that is for the model to take up (and not only to be called by name, in the prompt) has to be told of.
  // Looked for is what pi would write of them, word for word — nothing, where none is for the model to take up.
  if (chosen(asked.skills)) {
    const skills = session.resourceLoader.getSkills().skills;
    if (!WAYS_TO_READ.some(way => session.systemPrompt.includes(asTold(skills, way).trim()))) {
      const untold = skills.filter(skill => !skill.disableModelInvocation).map(skill => skill.name);
      return `The agent cannot take up its skills (${untold.join(", ")}) with the tools ${JSON.stringify(session.getActiveToolNames())}: ` +
        `pi tells a model of its skills only where it has "read" or "bash" to read them with.`;
    }
  }
  return undefined;
}

/**
 * Why an agent has not the tools a call named — to be asked when it has all
 * it is to have. Without extensions that is when its session is made. With
 * them it is when the model is about to be asked for the first time: an
 * extension may add tools as the run begins (pi's own connects the user's MCP
 * servers then, and their tools are the agent's from there on).
 */
function whyNotTheTools(session: AgentSession, tools: string[] | undefined): string | undefined {
  if (tools === undefined) return undefined;
  const given = session.getActiveToolNames();
  // (pi gives no tool that was not named. What it does not know by the name it was given, it leaves out.)
  return tools.every(name => given.includes(name)) ? undefined
    : `The agent cannot be given the tools ${JSON.stringify(tools)}: pi would give it ${JSON.stringify(given)}.`;
}

/** The name of trama's own extension that says what a call has used as each reply comes (see createSession). */
const COUNTS = "trama-counts";

/** What is kept of a session that has extensions, beside the session. */
interface Extended {
  /** What its extensions have put to the model and is not yet over. */
  puts: Set<Promise<void>>;
  /** Whether its call has come to its end. */
  over: boolean;
  /** Says what the call has used so far, where the model is about to be asked again — and waits for whoever hears it. */
  sofar?: () => Promise<void>;
  /** Looks, once, at what the agent has when the model is about to be asked for the first time (see whyNotTheTools). */
  look?: () => void;
  /** Says what the call has used, a reply of its model's having come that is not on the session's record yet. */
  had?: (reply: Counted) => void;
}

/**
 * Tell a session's extensions that it is over, and wait for them — a while:
 * an extension may hold what is to be let go of (a server it started), and
 * one that does not answer is not waited for. What one of them put to the
 * model and is still on its way there is seen off too, before the session is
 * gone: it is stopped as it begins to ask (see `ask`), where a session that
 * is disposed of under it would let it through.
 */
async function leaveExtensions(session: AgentSession, puts: Set<Promise<void>>): Promise<void> {
  const left = async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    while (puts.size > 0) await Promise.allSettled([...puts]);
  };
  await within(left(), EXTENSION_LEAVE_MS);
}

/**
 * What a session has used: pi's own count, over everything the session asked
 * of its model — a summary it made of a long conversation included. Nothing,
 * where no tokens were counted: the model was never reached, or does not say.
 */
function usageOf(session: AgentSession, more?: Counted): AgentUsage | undefined {
  const { tokens, cost } = session.getSessionStats();
  const input = tokens.input + (more?.input ?? 0), output = tokens.output + (more?.output ?? 0);
  const cacheRead = tokens.cacheRead + (more?.cacheRead ?? 0), cacheWrite = tokens.cacheWrite + (more?.cacheWrite ?? 0);
  if (input + output + cacheRead + cacheWrite === 0) return undefined;
  return {
    ...(session.model && { model: nameOf(session.model) }),
    input, output, cacheRead, cacheWrite, cost: cost + (more?.cost.total ?? 0),
  };
}

/** What a reply of a model's used, as pi has it on the reply — and adds it up into what a session used, once the reply is on its record. */
interface Counted {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
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
function answerOf(session: AgentSession, taken = false): string {
  const replies = session.sessionManager.getEntries()
    .flatMap(entry => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []));
  const reply = replies.at(-1);
  const text = reply?.content.map(block => (block.type === "text" ? block.text : "")).join("") ?? "";
  if (reply?.stopReason === "error") throw new Error(`The model did not answer: ${reply.errorMessage ?? "no reason given"}`);
  if (reply?.stopReason === "length") throw new CutOff(text);
  if (!text) {
    throw new Error(taken
      ? "The prompt was taken by an extension — a command of its own, or its reading of what is asked — and the model gave no answer."
      : "Empty response from LLM");
  }
  return text;
}

/**
 * The pi coding agent: a fresh in-memory session for every call — in this
 * process, or in a process of its own (see agent-host.ts). A call that has
 * extensions is served in one: an extension is somebody's code, and where it
 * runs it can hold up, or bring down, everything else that runs there. And
 * so is every call of an adapter that was given variables (`env`: a run's):
 * what an agent finds of pi, which key it has for a provider, and what the
 * commands it runs are given, are a process's — and this process is the
 * runner's, whose own are not a run's to change.
 */
export class PiAdapter implements AgentBackend {
  private config: ModelConfig;
  /** Whether every call is served in a process of its own: where those processes are given variables this one has not. */
  private apart: boolean;
  /** The processes that serve this adapter's calls. */
  private hosts: ReturnType<typeof createAgentHosts>;

  constructor(config: ModelConfig, env?: Record<string, string>) {
    this.config = config;
    // (Variables that are none are none given: such a run's calls are served as any run's.)
    this.apart = env !== undefined && Object.keys(env).length > 0;
    this.hosts = createAgentHosts(this.apart ? env : undefined);
  }

  /** Have a call served: here, or by a host. */
  async ask(prompt: string, call: AgentCall): Promise<string> {
    return call.extensions || this.apart ? this.hosts.ask(this.config, prompt, call) : this.serve(prompt, call);
  }

  /** End the processes that served calls: what this adapter was for is over. (It can be asked again: it starts them anew.) */
  async close(): Promise<void> {
    await this.hosts.close();
  }

  /**
   * `counted`: whether what the session uses is counted in another process
   * (see `serve`). Such a session has trama's own handlers among its
   * extensions — which is where pi waits for a handler — whether or not the
   * call has any extension of the user's.
   */
  private async createSession(cwd: string, systemPrompt?: string, signal?: AbortSignal, asked: Asked = {}, counted = false): Promise<AgentSession> {
    // Each step below is given up on the moment the call is cancelled.
    const raceAbort = <T>(step: Promise<T>) => rejectOnAbort(step, signal);

    const { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader, ModelRuntime, getAgentDir, formatSkillsForPrompt } = await raceAbort(loadPi());
    const agentDir = getAgentDir();
    // Skills and prompt templates are pi's for the user and for where the agent works — the
    // project's own, in its .pi directory, among them: and a call has those it chose, and no others.
    const found: Found = { skills: [], templates: [] };
    const only = <T extends { name: string }>(choice: Choice, items: T[]): T[] => {
      const names = named(choice);
      return names ? items.filter(item => names.includes(item.name)) : items;
    };
    const resources = new DefaultResourceLoader({
      cwd,
      agentDir,
      noExtensions: true,
      noSkills: !chosen(asked.skills),
      noPromptTemplates: !chosen(asked.templates),
      skillsOverride: (base) => {
        found.skills = base.skills.map(skill => skill.name);
        return { ...base, skills: only(asked.skills, base.skills) };
      },
      promptsOverride: (base) => {
        found.templates = base.prompts.map(template => template.name);
        return { ...base, prompts: only(asked.templates, base.prompts) };
      },
      ...(systemPrompt && { appendSystemPrompt: [systemPrompt] }),
    });
    await raceAbort(resources.reload());

    // Extensions are the user's own, unless the call says the project's are its too: an extension
    // is code, and what a project holds its program can write. So they are loaded apart, by a
    // loader that takes of the project's what the call said it may, and the session has the rest
    // from the other. And so, where the project's are not the call's, an extension that asks is
    // told the project is not one to be trusted — pi has extensions ask that before they take
    // anything of a project's for their own. The session's settings are otherwise what any call's
    // are, the project's among them: a call does not come to other tools, or another shell, for
    // having asked for extensions.
    if (asked.extensions !== undefined && typeof asked.extensions !== "boolean" && asked.extensions !== "project") {
      throw new Error(`extensions is true, false or "project", not ${JSON.stringify(asked.extensions)}`);
    }
    // Whose extensions: the user's — or the project's with them, where the call says so. Then the project
    // is one to be trusted, as it is when pi is run in it and told to: its extensions are loaded, the
    // MCP servers it names are started, and an extension that asks is told so.
    const withProjects = asked.extensions === "project";
    let resourceLoader: ResourceLoader = resources;
    const wary = asked.extensions && !withProjects
      ? Object.assign(Object.create(SettingsManager.create(cwd, agentDir)) as Settings, { isProjectTrusted: () => false })
      : undefined;
    const extended: Extended | undefined = asked.extensions || counted ? { puts: new Set(), over: false } : undefined;
    if (extended) {
      // A session that is to ask no more — its call cancelled, or over — is stopped each time it begins to
      // (see `ask`); and an extension may set it going again each time it stops, by more ways than one. All
      // of that is done without the runner coming to anything else: not to the clock that is to give the
      // call up, nor to any other run. So each beginning of such a session waits a turn of the runner's —
      // by a handler of trama's own among the extensions, which is what pi waits for when a run begins.
      // And before the model is asked again — for a turn, or to sum a long conversation up — what the
      // call has used so far is said from there too, and whoever hears it waited for: a session with
      // extensions is served in a process of its own, and what it is counted against is in the runner.
      const breathes: ExtensionFactory = (pi) => {
        pi.on("agent_start", async () => {
          if (extended.over || signal?.aborted) await new Promise(resolve => setImmediate(resolve));
        });
        const said = async () => {
          extended.look?.();
          extended.look = undefined;
          await extended.sofar?.();
        };
        pi.on("turn_start", said);
        pi.on("session_before_compact", said);
      };
      // And as soon as a reply of the model's has come, what the call has used is said — to whoever would
      // otherwise not know it if this process had to be ended. By a handler that hears of the reply before
      // any other extension's does: one of theirs may be what stops the process. (pi puts a reply on the
      // session's record when all have heard of it.)
      const counts: InlineExtension = {
        name: COUNTS,
        factory: (pi) => {
          pi.on("message_end", (event) => {
            if (event.message.role === "assistant") extended.had?.(event.message.usage);
          });
        },
      };
      const own = new DefaultResourceLoader({
        cwd,
        agentDir,
        // (A call without extensions has trama's two, and nothing that is found or built in.)
        noExtensions: !asked.extensions,
        extensionFactories: [...(asked.extensions ? await raceAbort(builtInExtensions()) : []), counts, breathes],
        // (pi has what it was handed after what it found: the one that counts is put before them all.)
        extensionsOverride: (loaded) => ({
          ...loaded,
          extensions: [...loaded.extensions].sort((a, b) => Number(b.path === `<inline:${COUNTS}>`) - Number(a.path === `<inline:${COUNTS}>`)),
        }),
        settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: withProjects }),
        // (Nothing but its extensions is asked of it, and so it need find nothing else.)
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await raceAbort(own.reload());
      resourceLoader = {
        getExtensions: () => own.getExtensions(),
        getSkills: () => resources.getSkills(),
        getPrompts: () => resources.getPrompts(),
        getThemes: () => resources.getThemes(),
        getAgentsFiles: () => resources.getAgentsFiles(),
        getSystemPrompt: () => resources.getSystemPrompt(),
        getSystemPromptSource: () => resources.getSystemPromptSource(),
        getAppendSystemPrompt: () => resources.getAppendSystemPrompt(),
        getAppendSystemPromptSources: () => resources.getAppendSystemPromptSources(),
        extendResources: (paths) => resources.extendResources(paths),
        reload: async (options) => {
          await resources.reload(options);
          await own.reload();
        },
      };
    }

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
      ...(wary && { settingsManager: wary }),
      ...(asked.thinking !== undefined && { thinkingLevel: asked.thinking as AgentSession["thinkingLevel"] }),
      ...(asked.tools && { tools: asked.tools }),
    });

    let session: AgentSession | undefined;
    // The telling of extensions that a session begins, while it lasts.
    let beginning: Promise<void> | undefined;
    try {
      ({ session } = await raceAbort(sessionPromise));
      // An extension is told that its session has begun, as pi tells it where pi runs by itself:
      // that is when it sets itself up. What goes wrong in one later is said, and is not the call's failure.
      // A command of one can wait for the model it asked, as it can there; the session is one call's, and
      // is not to be left for another.
      if (extended) {
        const here = session;
        const stays = async () => ({ cancelled: true });
        // What an extension puts to the model — a command of it, asking — is the call's to wait for (see
        // `ask`), and the command's own, where it waits: pi calls a session idle while a question is still
        // on its way to being asked, so what was put is kept account of here, as it is put.
        const { puts } = extended;
        this.extended.set(session, extended);
        const prompting = session.prompt.bind(session);
        session.prompt = (text, options) => {
          const put = prompting(text, options);
          if (options?.source !== "extension") return put;
          const over = () => { puts.delete(put); };
          puts.add(put);
          put.then(over, over);
          return put;
        };
        // A command that waits is told, when it has waited, that its call was cancelled — where it was: one
        // that asks until it is satisfied then stops asking, and need not be stopped each time it begins to.
        const idle = async () => {
          while (puts.size > 0) await Promise.allSettled([...puts]);
          await here.waitForIdle();
          throwIfAborted(signal);
        };
        beginning = session.bindExtensions({
          mode: "print",
          commandContextActions: {
            waitForIdle: idle,
            newSession: stays,
            fork: stays,
            switchSession: stays,
            navigateTree: async (target, options) => ({ cancelled: (await here.navigateTree(target, options)).cancelled }),
            reload: () => here.reload(),
          },
          // (A command that was not let wait, its call being cancelled, did not fail: nothing is said of it.)
          onError: (failure) => {
            if (signal?.aborted && failure.error === "Aborted") return;
            console.warn(`[trama] an extension failed (${failure.extensionPath}): ${failure.error}`);
          },
        });
        await raceAbort(beginning);
      }
      // With no model it can use, pi reports a placeholder that is not in its
      // catalog — a model is named only when it is a real one.
      const picked = session.model;
      const serving = picked && modelRuntime.getModel(picked.provider, picked.id) ? nameOf(picked) : null;
      const refusal = whyNotAsAsked(session, asked, serving, found, formatSkillsForPrompt);
      if (refusal) throw new Error(refusal);
      if (!model) this.warnUnknownModel(serving);
      return session;
    } catch (err) {
      // A session that is here is let go of, once, before the call fails — its extensions, if they were
      // still being told that it begins, having heard that out first (or been given the while they are
      // given to hear of its end). Where the call was cancelled before the session came, it may still
      // come: it is disposed of when it does, and no extension was told of it.
      if (session) {
        if (beginning) await within(beginning, EXTENSION_LEAVE_MS);
        await this.letGoOf(session, asked);
      } else {
        sessionPromise.then(({ session: late }) => late.dispose()).catch(() => {});
      }
      throw err;
    }
  }

  /** What is kept of each session that has extensions. */
  private extended = new WeakMap<AgentSession, Extended>();

  /** Be done with a session: its extensions, where it has any, told first that it is over. */
  private async letGoOf(session: AgentSession, asked: Asked): Promise<void> {
    try {
      if (asked.extensions) await leaveExtensions(session, this.extended.get(session)?.puts ?? new Set());
    } catch (err) {
      console.warn(`[trama] an extension could not be told its session is over: ${messageOf(err)}`);
    } finally {
      session.dispose();
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
   * Serve a call in this process: run one prompt in a fresh session and
   * return the assistant's text reply. (What a host does; and what `ask`
   * does itself for a call without extensions.)
   *
   * Cancellation during `createSession` is handled step-by-step inside it; once
   * `session.prompt()` is running, a cancelled call has pi abort the run — which
   * settles the prompt (pi 1.x resolves it rather than rejecting, so
   * `signal.aborted` is checked again when `prompt()` returns) and leaves on
   * the session's record what the request that was cut off had taken by then.
   */
  async serve(prompt: string, call: AgentCall): Promise<string> {
    const { cwd, system, signal, used, sofar, had } = call;
    throwIfAborted(signal);

    // (Whoever is told what the call has used as its replies come — `had` — is in another process.)
    const session = await this.createSession(cwd, system, signal, call, had !== undefined);
    let offAbort = () => {};
    // Whether the call has come to its end: what it used is what it had used by then.
    let over = false;
    // What is kept of the session beside it, where it has extensions.
    const extended = this.extended.get(session);
    // Why the call cannot have the tools it named, where that was found as its run began. It is
    // then stopped as a cancelled call is — it asks nothing, and what would hold it is not waited
    // for long — and fails with that.
    let refused: string | undefined;
    const refusal = new AbortController();
    const stopped = signal ? AbortSignal.any([signal, refusal.signal]) : refusal.signal;

    try {
      throwIfAborted(signal);
      offAbort = onAbort(signal, () => { session.abort().catch(() => {}); });
      // Each time the model is about to be asked again, what the call has used so far is said:
      // whoever hears it may cancel the call there, and the model is then not asked.
      // (pi asks its model for the next turn, and — between two turns — to sum up a conversation grown long.)
      // And a call that was cancelled, or is over, asks no more, whatever sets its session going again
      // after that: a command of an extension that asks the model once more is stopped as it begins to,
      // and so is what an extension starts while it is being told that the call is over.
      // (A session with extensions has said it by then, and been heard: see createSession.)
      if (extended && call.extensions) {
        extended.look = () => {
          refused = whyNotTheTools(session, call.tools);
          if (refused === undefined) return;
          // (The session is stopped where it hears next that a turn begins — just after this: see below.)
          extended.over = true;
          refusal.abort();
        };
      }
      if (extended && had) {
        extended.had = (reply) => {
          const usage = !over && usageOf(session, reply);
          if (usage) had(usage);
        };
      }
      if (extended && sofar) {
        extended.sofar = async () => {
          const usage = !over && !stopped.aborted && usageOf(session);
          if (usage) await sofar(usage);
        };
      }
      if (sofar || call.extensions) {
        session.subscribe((event) => {
          if (event.type !== "turn_start" && event.type !== "compaction_start") return;
          if (over || stopped.aborted) return void session.abort().catch(() => {});
          const usage = sofar && !extended && usageOf(session);
          if (usage) void sofar(usage);
        });
      }

      // The prompt is a program's text, whatever it begins with — but where the call has the user's skills,
      // templates or extensions, and does not say its prompt is text all the same: each of those has a line of
      // its own to be called up by ("/skill:name", "/name", a command), and pi reads a prompt for all of them
      // or for none.
      let taken = false;
      const answered = async () => {
        await session.prompt(prompt, {
          expandPromptTemplates: !call.asText && (chosen(call.skills) || chosen(call.templates) || Boolean(call.extensions)),
          preflightResult: (how) => { taken = how === "handled"; },
        });
        // A command that asked the model has the model's answer be the call's: what it put to the model is
        // waited for — also where the command itself did not wait, or pi had not yet set the run going.
        const puts = this.extended.get(session)?.puts;
        while (puts && puts.size > 0) await Promise.allSettled([...puts]);
        if (taken) await session.waitForIdle();
      };
      await notHeld(answered(), stopped, HELD_MS).catch((err) => { if (refused === undefined) throw err; });
      // (What the call cannot have as it asked is its failure, found before the model was asked anything.)
      if (refused !== undefined) throw new Error(refused);
      // An aborted prompt resolves with no usable answer — report it as an abort,
      // not as an empty LLM response.
      throwIfAborted(signal);
      return answerOf(session, taken);
    } finally {
      offAbort();
      over = true;
      if (extended) extended.over = true;
      try {
        // What the call used is said when it is over, however it ended — and before its extensions are
        // waited for: a count is not to wait on them.
        const usage = used && usageOf(session);
        if (usage) used(usage);
      } finally {
        await this.letGoOf(session, call);
      }
    }
  }
}
