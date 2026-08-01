export interface ComposerSelectValueOption {
  readonly value: string;
}

export function normalizeComposerModelValue(value: string | null | undefined): string {
  return value === "default" ? "" : (value || "");
}

export function normalizeAvailableComposerValue(
  value: string | null | undefined,
  options: ReadonlyArray<ComposerSelectValueOption>,
  fallback: string,
): string {
  const candidate = value || fallback;
  return options.some((option) => option.value === candidate) ? candidate : fallback;
}
