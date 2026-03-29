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
  for (const [key, typeDesc] of Object.entries(schema)) {
    if (!(key in obj)) return `missing key: ${key}`;
    const expectedType = typeDesc.split(":")[0].trim();
    const actual = typeof obj[key];
    if (expectedType === "string" && actual !== "string") return `${key}: expected string, got ${actual}`;
    if (expectedType === "number" && actual !== "number") return `${key}: expected number, got ${actual}`;
    if (expectedType === "boolean" && actual !== "boolean") return `${key}: expected boolean, got ${actual}`;
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

      const attempt = async (p: string) => {
        const response = await adapter.ask(p, signal ? { system: input.system, signal } : { system: input.system });
        const cleaned = response
          .trim()
          .replace(/^```json\s*/i, "")
          .replace(/^```\s*/, "")
          .replace(/\s*```$/, "")
          .trim();
        const parsed = JSON.parse(cleaned);
        const error = validateShape(parsed, input.schema);
        if (error) throw new Error(`Schema validation failed: ${error}`);
        return parsed;
      };

      try {
        return await attempt(fullPrompt);
      } catch (firstError) {
        const retryPrompt = `Your previous response failed validation: ${firstError}.\nTry again.\n\n${fullPrompt}`;
        return await attempt(retryPrompt);
      }
    }
  };
}
