/**
 * Recursively check that a value is strictly JSON-serializable.
 * Throws TypeError with the path to the offending value.
 */
export function assertSerializable(value: unknown, path: string): void {
  // The objects on the way down to the value being checked. An ancestor chain
  // rather than a set of everything seen, so that a structure that is shared
  // but not circular — { a: shared, b: shared } — passes.
  const ancestors = new Set<unknown>();

  const check = (value: unknown, path: string): void => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError(`${path} is not JSON-serializable (${value})`);
      return;
    }
    if (typeof value !== "object") {
      throw new TypeError(`${path} is not JSON-serializable (${typeof value})`);
    }
    if (ancestors.has(value)) {
      throw new TypeError(`${path} contains a circular reference`);
    }
    ancestors.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) check(value[i], `${path}[${i}]`);
    } else {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        const name = (value as object).constructor?.name ?? "unknown";
        throw new TypeError(`${path} is not a plain object (${name})`);
      }
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) check(v, `${path}.${k}`);
    }
    ancestors.delete(value);
  };
  check(value, path);
}

export const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Best-effort log payload sanitization: returns `data` unchanged when it
 * survives `JSON.stringify`, or a fallback wrapper when it cannot (e.g. a
 * circular reference or BigInt).
 */
export function toLogData<T>(data: T): T | { __trama_unserializable: string } {
  try {
    JSON.stringify(data);
    return data;
  } catch {
    return { __trama_unserializable: String(data) };
  }
}
