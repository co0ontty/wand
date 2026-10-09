import type { NewSessionForm } from "./types.js";

export function modeHint({ provider, mode, kind, engine }: Pick<NewSessionForm, "provider" | "mode" | "kind" | "engine">): string {
  if (provider === "codex") {
    return "Codex 自动批准工具调用，并关闭 Codex 的沙盒限制。";
  }
  if (provider === "opencode") {
    return mode === "full-access" || mode === "managed" || mode === "auto-edit"
      ? "OpenCode 自动批准未显式拒绝的权限请求。"
      : kind === "structured"
        ? "OpenCode 使用自身权限配置；对话中未批准的工具调用会被拒绝。"
        : "OpenCode 使用自身权限配置，在终端中处理权限确认。";
  }
  if (provider === "grok") {
    return mode === "full-access" || mode === "managed"
      ? "Grok 自动批准工具权限请求。"
      : "Grok 使用自身权限配置；需要确认的操作可能等待或被阻止。";
  }
  if (provider === "qoder") {
    return "Qoder 在所有模式下都跳过工具权限确认。";
  }
  if (provider === "pi") {
    return engine === "sdk"
      ? "Wand Agent 在 Wand 内执行，使用当前会话配置的工具与扩展。"
      : "Pi CLI 使用自身工具与扩展配置；这里的模式不会增加逐项权限确认。";
  }
  if (provider === "gemini") {
    if (mode === "full-access" || mode === "managed" || (kind === "pty" && mode === "auto-edit")) {
      return "Gemini 自动批准全部工具调用。";
    }
    if (mode === "auto-edit") return "Gemini 自动批准编辑工具；其他工具仍遵循自身权限配置。";
    return kind === "structured"
      ? "Gemini 使用自身权限配置；对话中未批准的工具调用会被拒绝。"
      : "Gemini 使用自身权限配置，在终端中处理权限确认。";
  }
  if (mode === "full-access") return "Claude 自动批准工具权限请求，可连续执行修改。";
  if (mode === "auto-edit") return "Claude 自动批准文件编辑；其他工具按当前会话权限策略处理。";
  if (mode === "managed") return "Claude 按目标连续执行，并自动批准工具权限请求；缺少必要信息或工具失败时仍可能停止。";
  return "Claude 保留工具执行方式，操作请求按当前会话权限策略处理。";
}


/** Visual risk only: never changes the permission passed to the execution owner. */
export function hasAutomaticPermissions(form: Pick<NewSessionForm, "provider" | "mode" | "kind">): boolean {
  return form.kind !== "shell" && (form.mode === "full-access" || form.mode === "managed"
    || form.provider === "codex" || form.provider === "qoder"
    || (form.provider === "gemini" && form.kind === "pty" && form.mode === "auto-edit"));
}
