import { isRecord } from "./shared.js";
import { ClaudeModelInfo } from "../types.js";

export const EFFORT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export interface ThinkingEffortLevel {
  effort: string;
  description?: string;
}
/** 各 CLI 自己报出来的思考档位。Codex / 部分 OpenCode 模型另有 per-model 列表。 */
export interface ProviderThinkingEfforts {
  claude: ThinkingEffortLevel[];
  opencode: ThinkingEffortLevel[];
  grok: ThinkingEffortLevel[];
  qoder: ThinkingEffortLevel[];
  pi: ThinkingEffortLevel[];
  /** Gemini CLI 没有思考档位开关，只保留「不覆盖」一项，不假装能调。 */
  gemini: ThinkingEffortLevel[];
}
/** 探针失败时的已知档位。下一次 CLI 成功应答会把它换掉。 */
export const FALLBACK_PROVIDER_THINKING: ProviderThinkingEfforts = {
  claude: effortLevelsFromIds(["low", "medium", "high", "xhigh", "max"]),
  opencode: effortLevelsFromIds(["low", "medium", "high", "max"]),
  grok: effortLevelsFromIds(["low", "medium", "high", "xhigh"]),
  qoder: effortLevelsFromIds(["auto", "none", "low", "medium", "high", "xhigh", "max", "ultracode"]),
  pi: effortLevelsFromIds(["minimal", "low", "medium", "high", "xhigh", "max"]),
  gemini: effortLevelsFromIds(["off"]),
};
export function cloneThinkingEfforts(efforts: ProviderThinkingEfforts): ProviderThinkingEfforts {
  const copy = (levels: readonly ThinkingEffortLevel[]) => levels.map((level) => ({ ...level }));
  return {
    claude: copy(efforts.claude),
    opencode: copy(efforts.opencode),
    grok: copy(efforts.grok),
    qoder: copy(efforts.qoder),
    pi: copy(efforts.pi),
    gemini: copy(efforts.gemini),
  };
}
export function effortLevelsFromIds(ids: readonly string[]): ThinkingEffortLevel[] {
  return ids.map((effort) => ({ effort }));
}
export function variantsToEfforts(value: unknown): ThinkingEffortLevel[] {
  const ids: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") ids.push(item);
      else if (isRecord(item) && typeof item.effort === "string") ids.push(item.effort);
    }
  } else if (isRecord(value)) {
    ids.push(...Object.keys(value));
  }
  const unique = Array.from(new Set(
    ids.map((id) => id.trim().toLowerCase()).filter((id) => EFFORT_ID_PATTERN.test(id)),
  ));
  return effortLevelsFromIds(unique);
}
export function unionModelEfforts(models: readonly ClaudeModelInfo[]): ThinkingEffortLevel[] {
  const seen = new Set<string>();
  const levels: ThinkingEffortLevel[] = [];
  for (const model of models) {
    for (const level of model.reasoningEfforts ?? []) {
      const effort = level.effort.trim().toLowerCase();
      if (!EFFORT_ID_PATTERN.test(effort) || seen.has(effort)) continue;
      seen.add(effort);
      levels.push({ effort, ...(level.description ? { description: level.description } : {}) });
    }
  }
  return levels;
}
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
/**
 * Same rule as Pi's `getSupportedThinkingLevels`: no reasoning means only off;
 * `xhigh` / `max` exist only when `thinkingLevelMap` defines them; `null` drops a level.
 */
export function piThinkingLevelsForModel(model: {
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, unknown> | null;
}): string[] {
  if (!model.reasoning) return ["off"];
  const map = model.thinkingLevelMap ?? {};
  return PI_THINKING_LEVELS.filter((level) => {
    if (!Object.prototype.hasOwnProperty.call(map, level)) {
      return level !== "xhigh" && level !== "max";
    }
    return map[level] !== null;
  });
}
/** 从 CLI 的 help / 非法档位报错里抽出 `low, medium, high` 这种列表。 */
export function parseCliEffortList(text: string): string[] {
  const patterns = [
    /valid values(?:\s+are)?\s*:\s*([^.`\n]+)/i,
    /use one of:\s*([^.`\n]+)/i,
    /set thinking level:\s*([^.`\n]+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const ids = match[1]
      .split(/[,/]/)
      .map((part) => part.trim().toLowerCase())
      .filter((part) => EFFORT_ID_PATTERN.test(part));
    if (ids.length) return Array.from(new Set(ids));
  }
  return [];
}
