import { systemPromptArgs, thinkingEffortToQoderEffort } from "./structured-provider-common.js";
import type { SessionSnapshot } from "./types.js";

/** Legacy stream-json capture only. Production structured sessions use QoderAcpRunner. */
export function buildQoderArgs(session: SessionSnapshot, prompt: string): string[] {
  const args = ["-p", prompt, "--output-format", "stream-json"];
  const model = session.selectedModel?.trim();
  if (model && model !== "default") args.push("--model", model);
  const effort = thinkingEffortToQoderEffort(session.thinkingEffort);
  if (effort) args.push("--reasoning-effort", effort);

  // Historical print protocol has no permission bridge. This is not the ACP
  // permission policy and must not be used to launch production structured runs.
  args.push("--permission-mode", "bypass_permissions");
  args.push(...systemPromptArgs(session));
  if (session.claudeSessionId) args.push("-r", session.claudeSessionId);
  return args;
}
