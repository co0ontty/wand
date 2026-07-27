export type ChoiceNavigationKey =
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowUp"
  | "ArrowDown"
  | "Home"
  | "End";

/** Returns the next enabled radio-card value with wrapping navigation. */
export function nextChoice<T>(
  values: readonly T[],
  current: T,
  key: ChoiceNavigationKey,
): T {
  if (values.length === 0) return current;
  if (key === "Home") return values[0];
  if (key === "End") return values[values.length - 1];
  const currentIndex = Math.max(0, values.indexOf(current));
  const forwards = key === "ArrowRight" || key === "ArrowDown";
  const offset = forwards ? 1 : -1;
  return values[(currentIndex + offset + values.length) % values.length];
}
