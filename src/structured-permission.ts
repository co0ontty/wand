import type { EscalationRequest, EscalationScope } from "./types.js";

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const COMMAND_TOOLS = new Set(["Bash", "BashOutput"]);
const NETWORK_TOOLS = new Set(["WebFetch", "WebSearch"]);
const DANGEROUS_SHELL_RE = /\bsudo\b|\brm\s+-[rf]{1,2}\b|\bmkfs\b|\bdd\s+if=|\bshutdown\b|\breboot\b/i;

export interface StructuredToolPermissionContext {
  title?: string;
  description?: string;
  blockedPath?: string;
  displayName?: string;
  toolUseID?: string;
  decisionReason?: string;
}

function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function truncateTarget(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > 200 ? `${compact.slice(0, 197)}...` : compact;
}

export function inferStructuredEscalation(
  toolName: string,
  input: Record<string, unknown>,
  ctx: StructuredToolPermissionContext = {},
): Pick<EscalationRequest, "scope" | "target" | "reason"> {
  let scope: EscalationScope = "unknown";
  let target = firstString(input, ["file_path", "path", "command", "url", "query", "description", "prompt", "name"]);

  if (FILE_TOOLS.has(toolName)) {
    scope = "write_file";
    target = firstString(input, ["file_path", "path"]) ?? target;
  } else if (COMMAND_TOOLS.has(toolName)) {
    const command = firstString(input, ["command"]) ?? target;
    scope = command && DANGEROUS_SHELL_RE.test(command) ? "dangerous_shell" : "run_command";
    target = command;
  } else if (NETWORK_TOOLS.has(toolName)) {
    scope = "network";
    target = firstString(input, ["url", "query"]) ?? target;
  } else if (typeof ctx.blockedPath === "string" && ctx.blockedPath.trim()) {
    scope = "outside_workspace";
    target = ctx.blockedPath.trim();
  }

  if (!target && typeof ctx.blockedPath === "string" && ctx.blockedPath.trim()) {
    target = ctx.blockedPath.trim();
  }

  const reason = (ctx.title?.trim()
    || ctx.description?.trim()
    || ctx.decisionReason?.trim()
    || `需要授权使用 ${toolName}`).slice(0, 300);

  return {
    scope,
    target: truncateTarget(target),
    reason,
  };
}

export function structuredPermissionDenied(message: string): { behavior: "deny"; message: string } {
  return { behavior: "deny", message };
}
