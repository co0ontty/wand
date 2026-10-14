import { AGENT_TOOL_OPTIONS } from "../../provider-identity";
import { MODEL_CATALOG_DEFAULT_VALUE } from "../model-catalog";
import { workspacesStore } from "./controller";
import { workspaceTargetProvider, type WorkspaceSessionTarget, type WorkspaceSessionKind } from "./types";

const GLOBAL_WORKSPACE_ID = "wand-global";
export const TEAM_NEEDS_PROJECT_HINT = "AI 团队需要先选择已有项目。";

/** Only an existing, non-global project can start a team. */
export function usableTeamWorkspaceId(workspaceId: string | null | undefined, kind?: string): string {
  if (!workspaceId || kind === "global" || workspaceId === GLOBAL_WORKSPACE_ID) return "";
  return workspaceId;
}

/** Execution identities come from the same provider + engine source as composer. */
export const WORKSPACE_AGENT_OPTIONS: ReadonlyArray<{
  value: WorkspaceSessionTarget;
  label: string;
  description: string;
}> = [
  ...AGENT_TOOL_OPTIONS.map((option) => ({
    value: option.id as WorkspaceSessionTarget, label: option.label, description: option.description,
  })),
  { value: "shell", label: "空白终端", description: "仅启动系统 Shell" },
];

export function workspaceAgentLabel(target: WorkspaceSessionTarget): string {
  return WORKSPACE_AGENT_OPTIONS.find((option) => option.value === target)?.label ?? target;
}

export const WORKSPACE_KIND_OPTIONS: ReadonlyArray<{
  value: WorkspaceSessionKind;
  label: string;
  description: string;
}> = [
  { value: "structured", label: "对话", description: "阅读回复、查看工具执行过程" },
  { value: "pty", label: "终端", description: "使用命令行工具的交互界面" },
];

export function workspaceModelDefault(target: WorkspaceSessionTarget): string {
  const provider = workspaceTargetProvider(target);
  if (!provider) return MODEL_CATALOG_DEFAULT_VALUE;
  return workspacesStore.getRuntime()?.modelPreference(provider) || MODEL_CATALOG_DEFAULT_VALUE;
}
