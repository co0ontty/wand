import { isExecutionMode } from "./config.js";
import { isSystemAiCall } from "./system-ai-call.js";
import type { ExecutionMode, SessionSource } from "./types.js";
import { badRequest } from "./http-error.js";

export function parseExecutionMode(value: unknown, fallback: ExecutionMode): ExecutionMode {
  if (value === undefined) return fallback;
  if (!isExecutionMode(value)) {
    throw new Error(`无效执行模式: ${String(value)}`);
  }
  return value;
}

export function parseSessionCreationOrigin(
  body: { sessionSource?: unknown; automationId?: unknown } | null | undefined,
  allowQuickTerminal = false,
): { sessionSource: SessionSource; automationId?: string } {
  const rawSource = body?.sessionSource;
  if (rawSource === "quick-terminal" && (!allowQuickTerminal || body?.automationId !== undefined)) {
    throw badRequest("快捷终端只允许无自动化绑定的空白 PTY shell。");
  }
  if (rawSource !== undefined && rawSource !== "interactive" && rawSource !== "automation" && rawSource !== "startup" && rawSource !== "quick-terminal") {
    throw new Error("sessionSource 必须是 interactive、automation 或 startup。");
  }

  const rawAutomationId = body?.automationId;
  if (rawAutomationId !== undefined && typeof rawAutomationId !== "string") {
    throw new Error("automationId 必须是非空字符串。");
  }
  const automationId = rawAutomationId?.trim();
  if (isSystemAiCall({ automationId })) throw new Error("automationId 使用了系统调用的保留命名空间。");
  if (rawAutomationId !== undefined && !automationId) {
    throw new Error("automationId 必须是非空字符串。");
  }

  return {
    sessionSource: rawSource ?? "interactive",
    ...(automationId ? { automationId } : {}),
  };
}

