import { ClaudeModelInfo } from "../types.js";

export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Shared catalog IDs are later forwarded to `--model`. Qoder and Pi both use
// provider-qualified values (`zhipu/glm5.2-cp`, `xai/grok-4.6`); Pi also emits
// `@` in some Cloudflare-style ids.
export const QODER_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
export const PI_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}\/[A-Za-z0-9@][A-Za-z0-9._:@/-]{0,127}$/;
export const CLAUDE_BUILTIN_MODELS: ClaudeModelInfo[] = [
  {
    id: "default",
    label: "跟随 Claude Code 默认",
    alias: true,
    source: "builtin",
    availability: "default",
    note: "不传 --model 参数",
  },
  { id: "opus", label: "opus（最新 Opus）", alias: true, source: "builtin", availability: "candidate" },
  { id: "sonnet", label: "sonnet（最新 Sonnet）", alias: true, source: "builtin", availability: "candidate" },
  { id: "haiku", label: "haiku（最新 Haiku）", alias: true, source: "builtin", availability: "candidate" },
];
export const CODEX_FALLBACK_MODELS: ClaudeModelInfo[] = [
  { id: "default", label: "GPT-5.5 · gpt-5.5（Codex 默认）", alias: true },
];
export const OPENCODE_FALLBACK_MODELS: ClaudeModelInfo[] = [
  { id: "default", label: "跟随 OpenCode 默认", alias: true },
];
export const GROK_FALLBACK_MODELS: ClaudeModelInfo[] = [
  { id: "default", label: "跟随 Grok 默认", alias: true },
  { id: "grok-4.5", label: "grok-4.5" },
];
export const QODER_FALLBACK_MODELS: ClaudeModelInfo[] = [
  { id: "default", label: "跟随 Qoder 默认", alias: true },
  { id: "lite", label: "Lite" },
  { id: "efficient", label: "Efficient" },
  { id: "auto", label: "Auto" },
  { id: "performance", label: "Performance" },
  { id: "ultimate", label: "Ultimate" },
];
export const PI_FALLBACK_MODELS: ClaudeModelInfo[] = [
  { id: "default", label: "跟随 Pi 默认", alias: true },
];
/**
 * Gemini CLI 没有列模型的子命令，只能给出稳定别名（`packages/core/src/config/models.ts`
 * 里的 GEMINI_MODEL_ALIAS_*）。具体版本名随发布滚动，不适合写死在这里；
 * 设置页的模型输入框是自由文本，用户可以自己填完整模型名。
 */
export const GEMINI_FALLBACK_MODELS: ClaudeModelInfo[] = [
  { id: "default", label: "跟随 Gemini 默认", alias: true },
  { id: "auto", label: "Auto（按任务自动选模型）" },
  { id: "pro", label: "Pro" },
  { id: "flash", label: "Flash" },
  { id: "flash-lite", label: "Flash Lite" },
];
export function cloneModels(models: readonly ClaudeModelInfo[]): ClaudeModelInfo[] {
  return models.map((model) => ({
    ...model,
    ...(model.reasoningEfforts
      ? { reasoningEfforts: model.reasoningEfforts.map((level) => ({ ...level })) }
      : {}),
  }));
}
export { isRecord } from "../object-utils.js";
