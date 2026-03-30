/**
 * Recursively check that a value is strictly JSON-serializable.
 * Throws TypeError with the path to the offending value.
 *
 * Uses a stack (ancestor chain) instead of a flat set so that shared-but-
 * non-circular structures like { a: shared, b: shared } pass validation.
 */
export function assertSerializable(value: unknown, path: string, ancestors = new Set<unknown>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} is not JSON-serializable (${value})`);
    }
    return;
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new TypeError(`${path} is not JSON-serializable (${typeof value})`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${path} contains a circular reference`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertSerializable(value[i], `${path}[${i}]`, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    const name = (value as object).constructor?.name ?? "unknown";
    throw new TypeError(`${path} is not a plain object (${name})`);
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    assertSerializable(v, `${path}.${k}`, ancestors);
  }
  ancestors.delete(value);
}
