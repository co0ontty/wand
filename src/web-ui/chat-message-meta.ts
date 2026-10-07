import type { ConversationTurn } from "../types.js";
import { formatMinutes } from "./running-activity.js";

export interface ChatUsageMetric {
  key: string;
  label: string;
  value: string;
  title: string;
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(value));
}

/** Display only reported counts. Round aggregation remains owned by the chat renderer. */
export function chatUsageMetrics(usage: ConversationTurn["usage"]): ChatUsageMetric[] {
  if (!usage) return [];
  const metrics: ChatUsageMetric[] = [];
  const fields = [
    ["inputTokens", "输入", false],
    ["cacheReadInputTokens", "缓存命中", false],
    ["cacheCreationInputTokens", "缓存写入", false],
    ["outputTokens", "输出", true],
    ["reasoningOutputTokens", "推理", true],
  ] as const;
  for (const [key, label, estimatedOutput] of fields) {
    const value = usage[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    const approximate = usage.estimated === true && estimatedOutput ? "≈" : "";
    metrics.push({ key, label, value: approximate + compactNumber(value),
      title: `${label} ${approximate}${Math.round(value)} Token${approximate ? "（估算）" : ""}` });
  }
  const cost = usage.totalCostUsd;
  if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) {
    metrics.push({ key: "totalCostUsd", label: "费用", value: `$${cost.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`,
      title: `费用 $${cost}` });
  }
  if (!metrics.length && usage.estimated === true) {
    metrics.push({ key: "pending", label: "用量", value: "统计中…", title: "正在统计用量，尚无可显示的计数" });
  }
  return metrics;
}

/** Never infer a finished duration from wall time, a live turn, or invalid/reversed anchors. */
export function chatReplyDuration(turn: Pick<ConversationTurn, "role" | "createdAt" | "completedAt">): string | null {
  if (turn.role !== "assistant" || !turn.createdAt || !turn.completedAt) return null;
  const duration = Date.parse(turn.completedAt) - Date.parse(turn.createdAt);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return duration < 1_000 ? "不足 1 秒" : formatMinutes(duration);
}
