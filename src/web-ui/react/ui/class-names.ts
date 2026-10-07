export function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

/**
 * Retained compatibility helper for callers with a state-driven className.
 * Wand styling hooks are plain strings; never stringify a callback.
 */
export function staticClassName(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
