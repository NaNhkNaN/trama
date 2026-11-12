import type { Agent } from "./types.js";
import type { AgentBackend } from "./agent-backend.js";
import { isJsonObject } from "./serializable.js";

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

const SUPPORTED_SCHEMA_TYPES = new Set(["string", "number", "boolean"]);
type SchemaPrimitive = "string" | "number" | "boolean";

/**
 * Parse and validate the caller's schema declaration up front.
 * The part after ":" is a description and is ignored during validation.
 */
function parseSchema(schema: Record<string, string>): Array<[string, SchemaPrimitive]> {
  return Object.entries(schema).map(([key, typeDesc]) => {
    const expectedType = typeDesc.split(":")[0].trim();
    if (!SUPPORTED_SCHEMA_TYPES.has(expectedType)) {
      throw new Error(`Schema validation failed: unsupported schema type "${expectedType}" for key "${key}"`);
    }
    return [key, expectedType as SchemaPrimitive];
  });
}

/**
 * Minimal shape validation + projection: verifies every schema key exists with
 * its declared primitive type, and returns an object containing only those keys.
 */
function extractBySchema(
  result: unknown,
  entries: Array<[string, SchemaPrimitive]>,
): Record<string, unknown> {
  if (!isJsonObject(result)) throw new Error("Schema validation failed: response is not an object");
  const picked: Record<string, unknown> = {};
  for (const [key, expectedType] of entries) {
    if (!(key in result)) throw new Error(`Schema validation failed: missing key: ${key}`);
    const actual = typeof result[key];
    if (actual !== expectedType) {
      throw new Error(`Schema validation failed: ${key}: expected ${expectedType}, got ${actual}`);
    }
    picked[key] = result[key];
  }
  return picked;
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
      const schemaEntries = parseSchema(input.schema);
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
        return extractBySchema(parsed, schemaEntries);
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
