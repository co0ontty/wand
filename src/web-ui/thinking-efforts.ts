/**
 * 思考档位下拉。
 *
 * 旧的 off/standard/deep/max 继续表示「不覆盖 / 各 CLI 的低、中、高档」，
 * CLI 新报出来的档位用 `provider:level` 存，避免和旧的 max 撞车。
 */

export interface CliThinkingEffort {
  effort: string;
  description?: string;
}

export interface ThinkingChoice {
  id: string;
  /** CLI 原生档位名，例如 low / xhigh。off 档的 label 是 auto。 */
  label: string;
  hint: string;
}

const LEGACY_NATIVE: Record<string, { standard: string; deep: string; max: string }> = {
  claude: { standard: "low", deep: "medium", max: "max" },
  codex: { standard: "low", deep: "medium", max: "xhigh" },
  opencode: { standard: "low", deep: "high", max: "max" },
  grok: { standard: "low", deep: "high", max: "xhigh" },
  qoder: { standard: "low", deep: "high", max: "max" },
  pi: { standard: "low", deep: "high", max: "max" },
};

const COMPACT_LABELS: Record<string, string> = {
  auto: "自动",
  none: "关闭",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "极高",
  ultra: "极限",
  ultracode: "极限代码",
};

/** 能和旧四档对上的原生档位继续用旧 id，其余写成 `provider:level`。 */
export function thinkingChoiceId(provider: string, native: string): string {
  const legacy = LEGACY_NATIVE[provider];
  if (legacy?.standard === native) return "standard";
  if (legacy?.deep === native) return "deep";
  if (legacy?.max === native) return "max";
  return `${provider}:${native}`;
}

export function compactThinkingLabel(native: string): string {
  return COMPACT_LABELS[native] ?? native;
}

/**
 * 用 CLI 报出的档位生成下拉。完全没有档位时返回 null，调用方继续用旧的四档兜底。
 * 模型明确只支持 off 时只保留「不覆盖」。原生 off 不重复列出。
 */
export function dynamicThinkingChoices(
  provider: string,
  efforts: readonly CliThinkingEffort[],
  defaultEffort?: string,
): ThinkingChoice[] | null {
  const reported = efforts
    .map((level) => level.effort.trim().toLowerCase())
    .filter((effort) => /^[a-z][a-z0-9_-]{0,31}$/.test(effort));
  if (!reported.length) return null;
  const natives = efforts
    .map((level) => ({
      effort: level.effort.trim().toLowerCase(),
      description: level.description?.trim() || "",
    }))
    .filter((level) => /^[a-z][a-z0-9_-]{0,31}$/.test(level.effort) && level.effort !== "off");
  if (!natives.length) {
    return [{
      id: "off",
      label: "auto",
      hint: "这个模型不能调思考深度",
    }];
  }
  const hint = defaultEffort
    ? `使用模型默认档位（${defaultEffort}）`
    : "使用模型默认档位";
  const choices: ThinkingChoice[] = [{ id: "off", label: "auto", hint }];
  const seen = new Set<string>(["off"]);
  for (const level of natives) {
    const id = thinkingChoiceId(provider, level.effort);
    if (seen.has(id)) continue;
    seen.add(id);
    choices.push({
      id,
      label: level.effort,
      hint: level.description || level.effort,
    });
  }
  return choices;
}
