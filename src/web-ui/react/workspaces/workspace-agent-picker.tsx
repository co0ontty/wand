import { type FormEvent, useEffect, useState } from "react";
import * as React from "react";

import {
  MODEL_CATALOG_DEFAULT_VALUE,
  pickedModelId,
} from "../model-catalog";
import { httpNewSessionRepository } from "../new-session/repository";
import { WandButton, WandIcon } from "../ui";
import {
  UnifiedExecutionSubjectPicker,
  type UnifiedExecutionSubject,
} from "./unified-execution-subject-picker.js";
import { workspacesStore } from "./controller";
import type {
  WorkspaceProvider,
  WorkspaceSessionKind,
  WorkspaceSessionTarget,
  WorkspaceTeamOption,
} from "./types";

/** 镜像服务端 src/types.ts 的 GLOBAL_WORKSPACE_ID：隐藏的「全局暂存」工作区没有真实目录。 */
const GLOBAL_WORKSPACE_ID = "wand-global";

/** 团队直发的禁用说明：原位显示在分组里，不另起浮层（§5.1 修正 B8）。 */
export const TEAM_NEEDS_PROJECT_HINT = "AI 团队需要先选择已有项目。";

/**
 * 团队开工要的 workspaceId：必须是**已经存在**的非 global 项目 id。
 * 手输目录（提交时才 create）与无项目态（合成 global）都拿不到，只能返回空串让 UI 禁用（§4.2 R2）。
 */
export function usableTeamWorkspaceId(
  workspaceId: string | null | undefined,
  kind?: string,
): string {
  if (!workspaceId) return "";
  if (kind === "global" || workspaceId === GLOBAL_WORKSPACE_ID) return "";
  return workspaceId;
}

export const WORKSPACE_AGENT_OPTIONS: ReadonlyArray<{
  value: WorkspaceSessionTarget;
  label: string;
  description: string;
}> = [
  { value: "claude", label: "Claude", description: "Claude Code" },
  { value: "codex", label: "Codex", description: "OpenAI Codex CLI" },
  { value: "opencode", label: "OpenCode", description: "OpenCode CLI" },
  { value: "grok", label: "Grok", description: "Grok Build CLI" },
  { value: "qoder", label: "Qoder", description: "Qoder CLI" },
  { value: "pi", label: "Pi", description: "Pi coding agent" },
  { value: "gemini", label: "Gemini", description: "Gemini CLI" },
  { value: "shell", label: "空白终端", description: "仅启动系统 Shell" },
];

export const WORKSPACE_KIND_OPTIONS: ReadonlyArray<{
  value: WorkspaceSessionKind;
  label: string;
  description: string;
}> = [
  { value: "structured", label: "结构化", description: "智能对话模式" },
  { value: "pty", label: "PTY", description: "原始 CLI 终端" },
];

export interface WorkspaceAgentPickerProps {
  target: WorkspaceSessionTarget;
  kind: WorkspaceSessionKind;
  /** 启动会话时使用的模型；`default` 表示跟随服务端配置的默认模型。 */
  model: string;
  disabled?: boolean;
  persistPreferences?: boolean;
  usageEnabled?: boolean;
  /** 「AI 团队」分组的内容；null（还没拉到）或空列表（还没有团队）时整组不出现。 */
  teams?: ReadonlyArray<WorkspaceTeamOption> | null;
  /** 团队开工要用的已有项目 id；空串表示当前状态不能开工，整组禁用并原位说明。 */
  teamWorkspaceId?: string;
  /** 独立于 target 的团队选择态；空串 = 这一轮起会话。 */
  teamId?: string;
  /** 选中员工的 id，若选中则与 team/target 互斥 */
  employeeId?: string;
  onTargetChange(target: WorkspaceSessionTarget): void;
  onKindChange(kind: WorkspaceSessionKind): void;
  onModelChange(model: string): void;
  /** 选团队 / 退回 CLI（传空串）。 */
  onTeamChange?(teamId: string): void;
  /** 选员工 / 退回（传空串）。 */
  onEmployeeChange?(employeeId: string): void;
}

/**
 * 某个 CLI 工具「上次用过的模型」：与输入框 composer 的记忆同源（localStorage + 会话状态）。
 * 空值表示还没选过，回落到「跟随服务端默认」。
 */
export function workspaceModelDefault(provider: WorkspaceSessionTarget): string {
  if (provider === "shell") return MODEL_CATALOG_DEFAULT_VALUE;
  return workspacesStore.getRuntime()?.modelPreference(provider as WorkspaceProvider)
    || MODEL_CATALOG_DEFAULT_VALUE;
}

export function WorkspaceAgentPicker({
  target,
  kind,
  model,
  disabled = false,
  persistPreferences = true,
  teams = null,
  teamWorkspaceId = "",
  teamId = "",
  employeeId = "",
  onTargetChange,
  onKindChange,
  onModelChange,
  onTeamChange,
  onEmployeeChange,
}: WorkspaceAgentPickerProps): React.ReactElement {
  const selectedSubject: UnifiedExecutionSubject = employeeId
    ? { type: "employee", id: employeeId }
    : teamId
      ? { type: "team", id: teamId }
      : { type: "cli", id: target };

  const selectSubject = (next: UnifiedExecutionSubject): void => {
    if (next.type === "employee") {
      onTeamChange?.("");
      onEmployeeChange?.(next.id);
      return;
    }
    if (next.type === "team") {
      onEmployeeChange?.("");
      onTeamChange?.(next.id);
      return;
    }
    onEmployeeChange?.("");
    onTeamChange?.("");
    onTargetChange(next.id as WorkspaceSessionTarget);
    if (next.id === "shell") onKindChange("pty");
    if (persistPreferences && next.id !== "shell") {
      void httpNewSessionRepository.savePreferences({
        defaultProvider: next.id as WorkspaceProvider,
      }).catch(() => undefined);
    }
  };

  return <UnifiedExecutionSubjectPicker
    selectedSubject={selectedSubject}
    kind={target === "shell" ? "pty" : kind}
    model={model}
    disabled={disabled}
    teams={teams}
    teamWorkspaceId={teamWorkspaceId}
    onSubjectChange={selectSubject}
    onKindChange={(next) => {
      onKindChange(next);
      if (persistPreferences) {
        void httpNewSessionRepository.savePreferences({ defaultSessionKind: next })
          .catch(() => undefined);
      }
    }}
    onModelChange={(next) => {
      onModelChange(next);
      if (persistPreferences && target !== "shell") {
        workspacesStore.getRuntime()?.rememberModelPreference(target as WorkspaceProvider, pickedModelId(next));
      }
    }}
  />;
}

export function WorkspaceWelcomeChooser({
  eyebrow,
  title,
  subtitle,
  cwd,
  submitLabel = "开始",
  teams = null,
  teamWorkspaceId = "",
  onStart,
  onStartTeam,
}: {
  eyebrow?: string;
  title: string;
  subtitle: string;
  cwd?: string;
  submitLabel?: string;
  /** 传了才显示「AI 团队」分组；任务上下文入口不传（§5.1）。 */
  teams?: ReadonlyArray<WorkspaceTeamOption> | null;
  /** 当前项目 id；空串表示这里没有可开工的已有项目。 */
  teamWorkspaceId?: string;
  onStart(target: WorkspaceSessionTarget, kind: WorkspaceSessionKind, model: string, employeeId?: string): void | Promise<void>;
  /** 团队分支旁路：onStart 签名不动，选团队时改走这条（§5.1 修正 B8）。 */
  onStartTeam?(teamId: string, workspaceId: string): void | Promise<void>;
}) {
  const [target, setTarget] = useState<WorkspaceSessionTarget>("claude");
  const [kind, setKind] = useState<WorkspaceSessionKind>("structured");
  const [model, setModel] = useState(MODEL_CATALOG_DEFAULT_VALUE);
  const [teamId, setTeamId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void httpNewSessionRepository.loadConfig()
      .then((config) => {
        if (cancelled) return;
        const savedProvider = WORKSPACE_AGENT_OPTIONS.some((option) => option.value === config.defaultProvider)
          ? config.defaultProvider as WorkspaceSessionTarget
          : null;
        if (savedProvider && savedProvider !== "shell") {
          setTarget(savedProvider);
          setModel(workspaceModelDefault(savedProvider));
        }
        if (config.defaultSessionKind === "pty" || config.defaultSessionKind === "structured") {
          setKind(config.defaultSessionKind);
        }
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      if (teamId) {
        // 团队分支：workspaceId 必须是已存在的非 global 项目，服务端才认（§4.2 R2）。
        if (!onStartTeam || !teamWorkspaceId) throw new Error(TEAM_NEEDS_PROJECT_HINT);
        await onStartTeam(teamId, teamWorkspaceId);
        return;
      }
      if (employeeId) {
        await onStart(target, "structured", "", employeeId);
        return;
      }
      // 选择器用 `default` 表示跟随服务端默认；交给调用方时统一换成真实模型 id（空串 = 默认）。
      await onStart(target, target === "shell" ? "pty" : kind, pickedModelId(model));
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "无法启动会话。");
    } finally {
      setSubmitting(false);
    }
  }

  const submitted = employeeId
    ? "硅基员工"
    : teamId
      ? (teams?.find((team) => team.id === teamId)?.name ?? "AI 团队")
      : target === "shell" ? "空白终端" : (WORKSPACE_AGENT_OPTIONS.find((option) => option.value === target)?.label ?? "");

  return (
    <div className="blank-chat-inner workspace-task-welcome workspace-session-welcome">
      {eyebrow ? <div className="workspace-task-welcome-eyebrow">{eyebrow}</div> : null}
      <div className="blank-chat-logo"><WandIcon name="task" size={28} strokeWidth={1.8}/></div>
      <h2 className="blank-chat-title">{title}</h2>
      <p className="blank-chat-subtitle">{subtitle}</p>
      <form noValidate className="workspace-welcome-form" aria-busy={submitting} onSubmit={(event) => void submit(event)}>
        <WorkspaceAgentPicker
          target={target}
          kind={kind}
          model={model}
          disabled={submitting}
          teams={teams}
          teamWorkspaceId={teamWorkspaceId}
          teamId={teamId}
          employeeId={employeeId}
          onTargetChange={(next) => { setTarget(next); setModel(workspaceModelDefault(next)); }}
          onKindChange={setKind}
          onModelChange={setModel}
          onTeamChange={setTeamId}
          onEmployeeChange={setEmployeeId}
        />
        {error ? <p className="wand-new-session-error" role="alert">{error}</p> : null}
        <WandButton kind="primary" size="large" type="submit" disabled={submitting}>
          {submitting ? (teamId ? "正在开工…" : "正在启动…") : `${submitLabel}${submitted}`}
        </WandButton>
      </form>
      {cwd ? (
        <div className="workspace-task-welcome-cwd" title={cwd}>
          <WandIcon name="folder" size={13} strokeWidth={1.8}/>
          <span>{cwd}</span>
        </div>
      ) : null}
    </div>
  );
}
