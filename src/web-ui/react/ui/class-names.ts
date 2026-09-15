export function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

/**
 * Appica / Base UI accept a state-driven `className` function. Wand always
 * passes a plain string, so normalise it back before handing it to
 * `classNames` - a function would otherwise be silently stringified.
 */
export function staticClassName(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
