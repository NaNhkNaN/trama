import type { Agent } from "./types.js";
import type { PiAdapter } from "./pi-adapter.js";

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

export function createAgent(adapter: PiAdapter, signal?: AbortSignal): Agent {
  return {
    async ask(prompt, options) {
      return adapter.ask(prompt, signal ? { ...options, signal } : options);
    },

    async generate(input) {
      const schemaInstruction = `Respond with ONLY a JSON object matching this shape:\n${
        JSON.stringify(input.schema, null, 2)
      }\nNo markdown. No explanation. Just the JSON.`;

      const fullPrompt = `${input.prompt}\n\n${schemaInstruction}`;
      const askOptions = signal ? { system: input.system, signal } : { system: input.system };

      const parseAndValidate = (response: string): Record<string, unknown> => {
        const cleaned = response
          .trim()
          .replace(/^```json\s*/i, "")
          .replace(/^```\s*/, "")
          .replace(/\s*```$/, "")
          .trim();
        const parsed = JSON.parse(cleaned);
        const error = validateShape(parsed, input.schema);
        if (error) throw new Error(`Schema validation failed: ${error}`);
        return stripToSchema(parsed as Record<string, unknown>, input.schema);
      };

      // First attempt — adapter errors (network/auth) propagate immediately.
      // Only parse/validation failures trigger a retry.
      const response = await adapter.ask(fullPrompt, askOptions);
      try {
        return parseAndValidate(response) as any;
      } catch (firstError) {
        const retryPrompt = `Your previous response failed validation: ${firstError}.\nTry again.\n\n${fullPrompt}`;
        const retryResponse = await adapter.ask(retryPrompt, askOptions);
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
