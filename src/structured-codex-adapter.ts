import type { SessionSnapshot } from "./types.js";
import { thinkingEffortToCodexReasoningEffort } from "./structured-provider-common.js";

/** Build the stable CLI contract for a structured Codex turn. */
export function buildCodexArgs(session: SessionSnapshot): string[] {
  const args = ["exec", "--json", "--color", "never"];
  const shouldBypass = session.autoApprovePermissions === true
    || session.mode === "full-access"
    || session.mode === "managed";

  if (shouldBypass) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (session.mode === "auto-edit" || session.mode === "agent" || session.mode === "agent-max") {
    args.push("--sandbox", "workspace-write");
  } else {
    args.push("--sandbox", "read-only");
  }

  args.push("--skip-git-repo-check");
  const modelChoice = session.selectedModel?.trim();
  if (modelChoice && modelChoice !== "default") args.push("--model", modelChoice);

  const reasoningEffort = thinkingEffortToCodexReasoningEffort(session.thinkingEffort);
  if (reasoningEffort) args.push("-c", `model_reasoning_effort=${reasoningEffort}`);

  if (session.claudeSessionId) args.push("resume", session.claudeSessionId, "-");
  else args.push("-");
  return args;
}
