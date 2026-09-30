/** Exact semantic snapshots: compare values, never text lengths or lossy hash sums.
 * Strings are retained directly; histories are not serialized into giant cache keys.
 * Object fields are snapshotted so in-place nested edits are detectable as well.
 */
export interface SemanticSignature {
  revision: number;
  kind: "value" | "object" | "array";
  value?: unknown;
  keys?: string[];
  length?: number;
  children?: SemanticSignature[];
}

export function captureSemanticSignature(
  value: unknown,
  previous: SemanticSignature | undefined,
  nextRevision: () => number,
): SemanticSignature {
  if (value === null || typeof value !== "object") {
    if (previous?.kind === "value" && Object.is(previous.value, value)) return previous;
    return { revision: nextRevision(), kind: "value", value };
  }
  const kind = Array.isArray(value) ? "array" : "object";
  const keys = Object.keys(value);
  const length = Array.isArray(value) ? value.length : undefined;
  const sameKeys = previous?.kind === kind && previous.length === length && keys.length === previous.keys?.length
    && keys.every((key, index) => key === previous.keys![index]);
  const children = keys.map((key, index) => captureSemanticSignature(
    (value as Record<string, unknown>)[key], sameKeys ? previous.children![index] : undefined,
    nextRevision,
  ));
  if (sameKeys && children.every((child, index) => child === previous.children![index])) return previous;
  return { revision: nextRevision(), kind, keys, length, children };
}
