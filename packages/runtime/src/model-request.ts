// One request to a model, as a program makes it — held to its shape.
//
// A program that is its own harness keeps the conversation and asks a model
// one reply at a time (`agent.complete`). What it asks with comes over the
// bridge as JSON, and nothing behind the bridge holds it to anything: pi sends
// a provider what it is handed, and a conversation that is none comes back as
// the provider's complaint, or as pi's own failure half-way through reading
// it. So it is read here first, and what is wrong with it is said in the
// program's words — which message, which part, what was expected.
//
// What a program writes is three kinds of message: the user's, a tool's
// result, and a reply — the last as `complete` returned it, and sent back as
// it came: a reply holds what its provider needs to see again (a signature on
// what the model thought, an id of its own), and none of that is a program's
// to know or to mend. Of a reply only what could not be one is refused.
import { IMAGE_KINDS, type ModelAsk } from "./agent-backend.js";
import { messageOf } from "./errors.js";
import { toolsOf } from "./own-tools.js";
import { isJsonObject } from "./serializable.js";

/** What a request may hold, as a program names it. */
export const REQUEST_FIELDS = ["messages", "system", "tools", "model", "thinking", "maxTokens", "temperature", "toolChoice", "timeout"] as const;

/** A value as it is said back to whoever gave it: what it is, where that is short to say — or what kind of thing. */
function got(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? "an empty list" : "a list";
  return value === null ? "null" : typeof value === "object" ? "an object" : typeof value;
}

/** A field a thing does not take, if it has one. */
const beside = (given: Record<string, unknown>, takes: readonly string[]): string | undefined =>
  Object.keys(given).find(field => !takes.includes(field));

const IMAGES = new Set<string>(IMAGE_KINDS);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

type Part = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };

/** What a user's message says, or a tool's result: text, or parts of text and images — as it is to be sent. */
function saidOf(content: unknown, at: string): string | Part[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.length === 0) throw new Error(`${at} is text, or a list of parts — text and images: got ${got(content)}`);
  return content.map((part, index): Part => {
    const here = `${at}[${index}]`;
    const isPart = isJsonObject(part) && (part.type === "text" || part.type === "image");
    if (!isPart) {
      throw new Error(`${here} is a part — { type: "text", text } or { type: "image", mimeType, data }: got ${
        isJsonObject(part) && part.type !== undefined ? `one of type ${got(part.type)}` : got(part)}`);
    }
    if (part.type === "text") {
      if (typeof part.text !== "string") throw new Error(`${here}.text is text: got ${got(part.text)}`);
      const more = beside(part, ["type", "text"]);
      if (more !== undefined) throw new Error(`${here} has a field a part of text does not take: ${more} (it takes: type, text)`);
      return { type: "text", text: part.text };
    }
    const { mimeType, data } = part;
    if (typeof mimeType !== "string" || !IMAGES.has(mimeType) || typeof data !== "string" || !BASE64.test(data) || beside(part, ["type", "mimeType", "data"]) !== undefined) {
      throw new Error(`${here} is an image of a kind a model is shown — ${IMAGE_KINDS.join(", ")} — with its data in base64`);
    }
    return { type: "image", mimeType, data };
  });
}

/** A reply, as it came: held to nothing but what every reply is. */
function replyOf(message: Record<string, unknown>, at: string): Record<string, unknown> {
  const { content } = message;
  if (!Array.isArray(content)) throw new Error(`${at}.content is a reply's parts, as the reply came: got ${got(content)}`);
  for (const [index, part] of content.entries()) {
    const here = `${at}.content[${index}]`;
    if (!isJsonObject(part)) throw new Error(`${here} is a part of a reply, as the reply came: got ${got(part)}`);
    if (typeof part.type !== "string") throw new Error(`${here} is a part of a reply, as the reply came: it has no type`);
    if (part.type === "toolCall" && (typeof part.id !== "string" || typeof part.name !== "string" || !isJsonObject(part.arguments))) {
      throw new Error(`${here} is a tool's call — its id, the tool's name, and its arguments — as the reply came`);
    }
  }
  return message;
}

const ROLES = `"user", "assistant" or "toolResult"`;

function messageOfAConversation(message: unknown, at: string): Record<string, unknown> {
  if (!isJsonObject(message)) throw new Error(`${at} is a message — from the user, a reply as it came, or a tool's result: got ${got(message)}`);
  const { role } = message;
  if (role === "user") {
    const content = saidOf(message.content, `${at}.content`);
    const more = beside(message, ["role", "content"]);
    if (more !== undefined) throw new Error(`${at} has a field a user's message does not take: ${more} (it takes: role, content)`);
    return { role, content };
  }
  if (role === "assistant") return replyOf(message, at);
  if (role === "toolResult") {
    const { toolCallId, toolName, isError } = message;
    if (typeof toolCallId !== "string" || toolCallId === "") throw new Error(`${at}.toolCallId is the id of the call it answers, as the reply had it: got ${got(toolCallId)}`);
    if (typeof toolName !== "string" || toolName === "") throw new Error(`${at}.toolName is the name of the tool that was called: got ${got(toolName)}`);
    const said = saidOf(message.content, `${at}.content`);
    if (isError != null && typeof isError !== "boolean") throw new Error(`${at}.isError is true or false: got ${got(isError)}`);
    const more = beside(message, ["role", "toolCallId", "toolName", "content", "isError"]);
    if (more !== undefined) throw new Error(`${at} has a field a tool's result does not take: ${more} (it takes: role, toolCallId, toolName, content, isError)`);
    // (As a provider is sent one: its words as parts, and whether it failed said either way.)
    return { role, toolCallId, toolName, content: typeof said === "string" ? [{ type: "text", text: said }] : said, isError: isError === true };
  }
  throw new Error(`${at}: a message's role is ${ROLES}, not ${got(role)}${role === "system" ? " (what a model is told to be is the request's `system`)" : ""}`);
}

/** The tools a model is told of: each declared, as a program declares a tool of its own to an agent — and none named. */
function declaredOf(tools: unknown): ModelAsk["context"]["tools"] {
  if (!Array.isArray(tools)) throw new Error(`tools is a list of tools, each declared: got ${got(tools)}`);
  const named = tools.findIndex(tool => typeof tool === "string");
  if (named !== -1) {
    throw new Error(`tools[${named}]: a tool is declared here — its name, its description, its parameters — and not named: no agent is asked, whose tool ${JSON.stringify(tools[named])} would be`);
  }
  try {
    // (Whether one may run beside another, or ends anything, is a question for whoever runs tools: here nobody does.)
    return toolsOf(tools).declared.map(({ name, description, parameters }) => ({ name, description, parameters }));
  } catch (err) {
    throw new Error(`tools: ${messageOf(err)}`);
  }
}

/**
 * A request as a program gave it, held to what one is: returns it as a
 * backend is handed it. Throws with what is wrong, in words for whoever
 * wrote it. (What is given as null is not given: it is how JSON says so.)
 */
export function requestOf(given: unknown): ModelAsk {
  if (!isJsonObject(given)) throw new Error(`a request is an object — the conversation so far (messages), and what goes with it: got ${got(given)}`);
  const unknown = beside(given, REQUEST_FIELDS);
  if (unknown !== undefined) throw new Error(`a request has no ${unknown}: it has ${REQUEST_FIELDS.join(", ")}`);
  const { messages, system, tools, model, thinking, maxTokens, temperature, toolChoice, timeout } = given;

  if (!Array.isArray(messages) || messages.length === 0) throw new Error(`messages is the conversation so far, a list of messages with at least one in it: got ${got(messages)}`);
  const context: ModelAsk["context"] = { messages: messages.map((message, index) => messageOfAConversation(message, `messages[${index}]`)) };
  if (system != null) {
    if (typeof system !== "string") throw new Error(`system is text: got ${got(system)}`);
    context.systemPrompt = system;
  }
  if (tools != null) {
    const declared = declaredOf(tools);
    if (declared!.length > 0) context.tools = declared;
  }

  const asked: ModelAsk = { context };
  if (model != null) {
    // (Which of its strokes parts the provider from the model is for whoever has the models to say.)
    if (typeof model !== "string" || !/^[^/]+\/./.test(model)) throw new Error(`model is a model by name, "provider/model": got ${got(model)}`);
    asked.model = model;
  }
  if (thinking != null) {
    if (typeof thinking !== "string" || thinking === "") throw new Error(`thinking is a level by name: got ${got(thinking)}`);
    asked.thinking = thinking;
  }
  if (maxTokens != null) {
    if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens <= 0) throw new Error(`maxTokens is a whole number above 0: got ${got(maxTokens)}`);
    asked.maxTokens = maxTokens;
  }
  if (temperature != null) {
    if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0) throw new Error(`temperature is a number that is not negative: got ${got(temperature)}`);
    asked.temperature = temperature;
  }
  if (toolChoice != null) {
    if (toolChoice !== "auto" && toolChoice !== "none") throw new Error(`toolChoice is "auto" or "none": got ${got(toolChoice)}`);
    asked.toolChoice = toolChoice;
  }
  if (timeout != null) {
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) throw new Error(`timeout is milliseconds, a number above 0: got ${got(timeout)}`);
    asked.timeout = timeout;
  }
  return asked;
}
