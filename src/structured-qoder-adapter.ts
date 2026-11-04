import { systemPromptArgs, thinkingEffortToQoderEffort } from "./structured-provider-common.js";
import type { SessionSnapshot } from "./types.js";

export function buildQoderArgs(session: SessionSnapshot, prompt: string): string[] {
  const args = ["-p", prompt, "--output-format", "stream-json"];
  const model = session.selectedModel?.trim();
  if (model && model !== "default") args.push("--model", model);
  const effort = thinkingEffortToQoderEffort(session.thinkingEffort);
  if (effort) args.push("--reasoning-effort", effort);

  // 与 PTY runner 一致：Qoder 一律以 yolo（bypass_permissions）启动。结构化 runner 没有
  // 权限桥，--print 下未批准的调用只会被拒绝，因此不做任何模式降级。
  args.push("--permission-mode", "bypass_permissions");
  args.push(...systemPromptArgs(session));
  if (session.claudeSessionId) args.push("-r", session.claudeSessionId);
  return args;
}
