import { Alert, Flex, Result, Typography } from "antd";
import { TaskForm } from "../issues/form-controls";
import { type FormEvent, useEffect, useState } from "react";
import * as React from "react";

import {
  MODEL_CATALOG_DEFAULT_VALUE,
  pickedModelId,
} from "../model-catalog";
import { httpNewSessionRepository } from "../new-session/repository";
import { WandButton, WandIcon } from "../ui";
import { AGENT_TOOL_OPTIONS, WAND_AGENT_TOOL_ID } from "../../provider-identity";
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
import { workspaceTargetEngine, workspaceTargetProvider } from "./types";

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

/**
 * 工作窗口可选的执行项。
 * 单一真源是浏览器层的 `AGENT_TOOL_OPTIONS`（Pi 与 Wand Agent 是两条独立选项），
 * 这里只追加“空白终端”这一项，不再自己维护一份 provider 列表。
 */
export const WORKSPACE_AGENT_OPTIONS: ReadonlyArray<{
  value: WorkspaceSessionTarget;
  label: string;
  description: string;
}> = [
  ...AGENT_TOOL_OPTIONS.map((option) => ({
    value: option.id as WorkspaceSessionTarget,
    label: option.label,
    description: option.description,
  })),
  { value: "shell", label: "空白终端", description: "仅启动系统 Shell" },
];

/** 工具选项 id（如用 pi / wand-agent）对应的展示名；认不出来就回落成原值。 */
export function workspaceAgentLabel(target: WorkspaceSessionTarget): string {
  return WORKSPACE_AGENT_OPTIONS.find((option) => option.value === target)?.label ?? target;
}

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
export function workspaceModelDefault(target: WorkspaceSessionTarget): string {
  const provider = workspaceTargetProvider(target);
  if (!provider) return MODEL_CATALOG_DEFAULT_VALUE;
  return workspacesStore.getRuntime()?.modelPreference(provider)
    || MODEL_CATALOG_DEFAULT_VALUE;
}

/** 选中项 → 选择器用的主体（provider + 引擎）；Wand Agent 用 pi provider + sdk 引擎。 */
function pickerSubjectFor(target: WorkspaceSessionTarget): UnifiedExecutionSubject {
  const engine = workspaceTargetEngine(target);
  const provider = workspaceTargetProvider(target);
  return { type: "cli", id: provider || "shell", ...(engine ? { engine } : {}) };
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
      : pickerSubjectFor(target);

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
    // 引擎是第二个维度：Wand Agent 与 Pi 共享 provider，但 target 要能分辨。
    const nextTarget: WorkspaceSessionTarget = next.id === "shell"
      ? "shell"
      : next.engine === "sdk" ? WAND_AGENT_TOOL_ID : next.id as WorkspaceSessionTarget;
    onTargetChange(nextTarget);
    if (nextTarget === "shell") onKindChange("pty");
    const provider = workspaceTargetProvider(nextTarget);
    if (persistPreferences && provider) {
      void httpNewSessionRepository.savePreferences({
        defaultProvider: provider,
        // 与 provider 一起记住引擎，下次打开直接回到 Wand Agent。
        defaultEngine: workspaceTargetEngine(nextTarget) ?? "cli",
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
      const provider = workspaceTargetProvider(target);
      if (persistPreferences && provider) {
        workspacesStore.getRuntime()?.rememberModelPreference(provider, pickedModelId(next));
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
  const choiceTouched = React.useRef(false);

  useEffect(() => {
    let cancelled = false;
    void httpNewSessionRepository.loadConfig()
      .then((config) => {
        if (cancelled || choiceTouched.current) return;
        const savedTarget = WORKSPACE_AGENT_OPTIONS.some((option) => option.value === config.defaultProvider)
          ? (config.defaultProvider === "pi" && config.defaultEngine === "sdk"
              ? WAND_AGENT_TOOL_ID
              : config.defaultProvider) as WorkspaceSessionTarget
          : null;
        if (savedTarget && savedTarget !== "shell") {
          setTarget(savedTarget);
          setModel(workspaceModelDefault(savedTarget));
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
      : target === "shell" ? "空白终端" : workspaceAgentLabel(target);

  return <Result icon={<WandIcon name="task" size={36} strokeWidth={1.8}/>} title={title} subTitle={subtitle}
    extra={<TaskForm noValidate aria-busy={submitting} onSubmit={(event) => void submit(event)}>
      <Flex vertical gap={16} style={{ maxWidth: 600, marginInline: "auto", textAlign: "start" }}>
        {eyebrow ? <Typography.Text type="secondary">{eyebrow}</Typography.Text> : null}
        <WorkspaceAgentPicker
          target={target}
          kind={kind}
          model={model}
          disabled={submitting}
          teams={teams}
          teamWorkspaceId={teamWorkspaceId}
          teamId={teamId}
          employeeId={employeeId}
          onTargetChange={(next) => { choiceTouched.current = true; setTarget(next); setModel(workspaceModelDefault(next)); }}
          onKindChange={(next) => { choiceTouched.current = true; setKind(next); }}
          onModelChange={(next) => { choiceTouched.current = true; setModel(next); }}
          onTeamChange={(next) => { choiceTouched.current = true; setTeamId(next); }}
          onEmployeeChange={(next) => { choiceTouched.current = true; setEmployeeId(next); }}
        />
        {error ? <Alert type="error" showIcon role="alert" title={error}/> : null}
        <WandButton kind="primary" size="large" type="submit" disabled={submitting}>
          {submitting ? (teamId ? "正在开工…" : "正在启动…") : `${submitLabel}${submitted}`}
        </WandButton>
        {cwd ? <Typography.Text type="secondary" ellipsis title={cwd}><WandIcon name="folder" size={13} strokeWidth={1.8}/> {cwd}</Typography.Text> : null}
      </Flex>
    </TaskForm>}/>;
}
