/** The renderer supplies identity and visible body; navigation never reconstructs either. */
export interface TurnNavSource {
  ownerKey: string | null;
  role?: string;
  notice?: boolean;
  placeholder?: boolean;
  visibleText: string;
  visibleIndex: number;
}
export interface TurnNavEntry {
  ownerKey: string;
  label: string;
  preview: string;
  visibleIndex: number;
}
export function turnPreview(text: string, maxLength = 120): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > maxLength ? value.slice(0, maxLength - 1) + "…" : value;
}
/** Only real user questions. Ambiguous or unproven owners cannot be jump targets. */
export function buildTurnNavIndex(rows: readonly TurnNavSource[]): TurnNavEntry[] {
  const counts = new Map<string, number>();
  for (const row of rows) if (row.ownerKey) counts.set(row.ownerKey, (counts.get(row.ownerKey) ?? 0) + 1);
  return rows.flatMap(row => {
    if (row.role !== "user" || row.notice || row.placeholder || !row.ownerKey || counts.get(row.ownerKey) !== 1) return [];
    const preview = turnPreview(row.visibleText);
    return preview ? [{ ownerKey: row.ownerKey, label: "", preview, visibleIndex: row.visibleIndex }] : [];
  }).map((entry, index) => ({ ...entry, label: `提问 ${index + 1}` }));
}
export function turnNavRange(count: number, earlier: "available" | "unknown" | "none", omitted = false): string {
  const range = `当前已载入 ${count} 个提问`;
  const older = earlier === "available" ? "；更早内容请用消息顶部的原有加载入口" : earlier === "unknown" ? "；仅索引当前提供的历史范围" : "";
  return range + older + (omitted ? "；部分旧提问暂无可靠定位标识" : "");
}
