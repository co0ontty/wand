/** Non-null objects excluding arrays; retains the existing Date/class-instance behavior. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
