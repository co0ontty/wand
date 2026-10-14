import { ClaudeModelInfo } from "../../types.js";
import { cloneModels, CODEX_FALLBACK_MODELS } from "../shared.js";

export interface CodexModelEntry {
  slug: string;
  display_name?: string;
  visibility?: string;
  priority?: number;
  default_reasoning_level?: string;
  supported_reasoning_levels?: Array<{
    effort?: string;
    description?: string;
  }>;
}
/** Parse the machine-readable model registry emitted by the installed Codex CLI. */
export function parseCodexModels(stdout: string): ClaudeModelInfo[] {
  try {
    const data = JSON.parse(stdout) as { models?: CodexModelEntry[] };
    const visible = (Array.isArray(data.models) ? data.models : [])
      .filter((model) => typeof model.slug === "string" && model.slug.length > 0)
      .filter((model) => model.visibility === "list")
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
    if (!visible.length) return cloneModels(CODEX_FALLBACK_MODELS);
    const defaultModel = visible[0];
    const defaultLabel = formatCodexModelLabel(defaultModel);
    const result: ClaudeModelInfo[] = [
      {
        id: "default",
        label: `${defaultLabel}（Codex 默认）`,
        alias: true,
        ...codexReasoningMetadata(defaultModel),
      },
    ];
    for (const model of visible) {
      result.push({
        id: model.slug,
        label: formatCodexModelLabel(model),
        ...codexReasoningMetadata(model),
      });
    }
    return result;
  } catch {
    return cloneModels(CODEX_FALLBACK_MODELS);
  }
}
export function codexReasoningMetadata(model: CodexModelEntry): Pick<ClaudeModelInfo, "reasoningEfforts" | "defaultReasoningEffort"> {
  const reasoningEfforts = (Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [])
    .filter((level) => typeof level?.effort === "string" && level.effort.length > 0)
    .map((level) => ({
      effort: level.effort as string,
      ...(typeof level.description === "string" && level.description ? { description: level.description } : {}),
    }));
  return {
    ...(reasoningEfforts.length ? { reasoningEfforts } : {}),
    ...(typeof model.default_reasoning_level === "string" && model.default_reasoning_level
      ? { defaultReasoningEffort: model.default_reasoning_level }
      : {}),
  };
}
export function formatCodexModelLabel(model: CodexModelEntry): string {
  return model.display_name && model.display_name !== model.slug
    ? `${model.display_name} · ${model.slug}`
    : model.slug;
}
