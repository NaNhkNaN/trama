import type { Agent } from "./types.js";
import type { AgentBackend } from "./agent-backend.js";

/**
 * The program in an LLM reply that was asked to contain nothing else: the last
 * fenced block if there is one (models add explanations, or show a "before"
 * first), otherwise the whole reply.
 */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const matches = [...trimmed.matchAll(/```(?:\w*)\s*\n([\s\S]*?)\n\s*```/g)];
  if (matches.length > 0) {
    return matches[matches.length - 1][1].trim();
  }
  return trimmed;
}

/**
 * Minimal shape validation.
 * Checks all schema keys exist and values match declared primitive types.
 * The part after ":" is a description and is ignored during validation.
 */
function validateShape(result: unknown, schema: Record<string, string>): string | null {
  if (typeof result !== "object" || result === null) return "response is not an object";
  const obj = result as Record<string, unknown>;
  const supportedTypes = new Set(["string", "number", "boolean"]);
  for (const [key, typeDesc] of Object.entries(schema)) {
    if (!(key in obj)) return `missing key: ${key}`;
    const expectedType = typeDesc.split(":")[0].trim();
    if (!supportedTypes.has(expectedType)) return `unsupported schema type "${expectedType}" for key "${key}"`;
    const actual = typeof obj[key];
    if (actual !== expectedType) return `${key}: expected ${expectedType}, got ${actual}`;
  }
  return null;
}

/**
 * The `agent` a program talks to: its calls, served by `backend` working in
 * `cwd`, and cancelled together through `signal`.
 */
export function createAgent(backend: AgentBackend, cwd: string, signal?: AbortSignal): Agent {
  return {
    async instruct(prompt, options) {
      return backend.ask(prompt, { cwd, system: options?.system, signal });
    },

    async generate(input) {
      const schemaInstruction = `Respond with ONLY a JSON object matching this shape:\n${
        JSON.stringify(input.schema, null, 2)
      }\nNo markdown. No explanation. Just the JSON.`;

      const fullPrompt = `${input.prompt}\n\n${schemaInstruction}`;
      const call = { cwd, system: input.system, signal };

      const parseAndValidate = (response: string): Record<string, unknown> => {
        const trimmed = response.trim();
        // Try raw parse first — avoids mangling valid JSON that contains
        // fenced code blocks inside string values.
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
          parsed = JSON.parse(fenceMatch ? fenceMatch[1].trim() : trimmed);
        }
        const error = validateShape(parsed, input.schema);
        if (error) throw new Error(`Schema validation failed: ${error}`);
        return stripToSchema(parsed as Record<string, unknown>, input.schema);
      };

      // First attempt — backend errors (network/auth) propagate immediately.
      // Only parse/validation failures trigger a retry.
      const response = await backend.ask(fullPrompt, call);
      try {
        return parseAndValidate(response) as any;
      } catch (firstError) {
        const retryPrompt = `Your previous response failed validation: ${firstError}.\nTry again.\n\n${fullPrompt}`;
        const retryResponse = await backend.ask(retryPrompt, call);
        return parseAndValidate(retryResponse) as any;
      }
    }
  };
}

/** Return a new object containing only the keys declared in the schema. */
function stripToSchema(obj: Record<string, unknown>, schema: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(schema)) {
    result[key] = obj[key];
  }
  return result;
}
