import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import * as React from "react";

import {
  MODEL_CATALOG_DEFAULT_VALUE,
  pickedModelId,
  wandModelOptions,
} from "../model-catalog";
import { useWandModelCatalog } from "../use-model-catalog";
import { nextChoice, type ChoiceNavigationKey } from "../new-session/choice-navigation";
import { httpNewSessionRepository } from "../new-session/repository";
import { ProviderLogo } from "../provider-logo";
import { sortProviderOptions, useProviderUsage } from "../provider-usage";
import { WandButton, WandIcon, WandSelect } from "../ui";
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

const KIND_VALUES = WORKSPACE_KIND_OPTIONS.map((option) => option.value);
const RADIO_NAVIGATION_KEYS = new Set<ChoiceNavigationKey>([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
]);

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
  onTargetChange(target: WorkspaceSessionTarget): void;
  onKindChange(kind: WorkspaceSessionKind): void;
  onModelChange(model: string): void;
  /** 选团队 / 退回 CLI（传空串）。 */
  onTeamChange?(teamId: string): void;
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
  usageEnabled = true,
  teams = null,
  teamWorkspaceId = "",
  teamId = "",
  onTargetChange,
  onKindChange,
  onModelChange,
  onTeamChange,
}: WorkspaceAgentPickerProps) {
  const catalog = useWandModelCatalog();
  const providerUsage = useProviderUsage(usageEnabled);
  const targetOptions = sortProviderOptions(WORKSPACE_AGENT_OPTIONS, providerUsage ?? {}, (option) => option.value);
  const targetValues = targetOptions.map((option) => option.value);
  const targetRefs = useRef<Partial<Record<WorkspaceSessionTarget, HTMLButtonElement | null>>>({});
  const kindRefs = useRef<Partial<Record<WorkspaceSessionKind, HTMLButtonElement | null>>>({});
  // 团队是独立选择态：选上之后 CLI 组不再高亮，会话类型 / 模型这两组整体隐藏（§5.1）。
  const teamSelected = teamId !== "";
  const teamBlocked = teamWorkspaceId === "";

  function selectTarget(next: WorkspaceSessionTarget): void {
    if (disabled) return;
    onTargetChange(next);
    if (teamSelected) onTeamChange?.("");
    if (persistPreferences && next !== "shell") {
      void httpNewSessionRepository.savePreferences({ defaultProvider: next }).catch(() => undefined);
    }
  }

  function selectTeam(next: string): void {
    if (disabled || teamBlocked || !onTeamChange) return;
    onTeamChange(next);
  }

  function selectKind(next: WorkspaceSessionKind): void {
    if (disabled) return;
    onKindChange(next);
    if (persistPreferences) {
      void httpNewSessionRepository.savePreferences({ defaultSessionKind: next }).catch(() => undefined);
    }
  }

  /** 选中的模型写回按 provider 的记忆（与 composer 同一份），下次打开默认沿用。 */
  function selectModel(next: string): void {
    if (disabled) return;
    onModelChange(next);
    if (persistPreferences && target !== "shell") {
      workspacesStore.getRuntime()?.rememberModelPreference(target as WorkspaceProvider, pickedModelId(next));
    }
  }

  function navigateTarget(
    event: KeyboardEvent<HTMLButtonElement>,
    current: WorkspaceSessionTarget,
  ): void {
    if (disabled || !RADIO_NAVIGATION_KEYS.has(event.key as ChoiceNavigationKey)) return;
    event.preventDefault();
    const next = nextChoice(targetValues, current, event.key as ChoiceNavigationKey);
    selectTarget(next);
    window.requestAnimationFrame(() => targetRefs.current[next]?.focus());
  }

  function navigateKind(
    event: KeyboardEvent<HTMLButtonElement>,
    current: WorkspaceSessionKind,
  ): void {
    if (disabled || !RADIO_NAVIGATION_KEYS.has(event.key as ChoiceNavigationKey)) return;
    event.preventDefault();
    const next = nextChoice(KIND_VALUES, current, event.key as ChoiceNavigationKey);
    selectKind(next);
    window.requestAnimationFrame(() => kindRefs.current[next]?.focus());
  }

  if (providerUsage === null) {
    return <fieldset className="wand-new-session-fieldset" disabled={disabled}>
      <legend className="wand-new-session-field-label">CLI 工具</legend>
      <p className="wand-new-session-field-hint" role="status">正在加载工具列表…</p>
    </fieldset>;
  }

  return (
    <>
      <fieldset className="wand-new-session-fieldset" disabled={disabled}>
        <legend className="wand-new-session-field-label">CLI 工具</legend>
        <div className="wand-new-session-choices wand-workspace-agent-options" role="radiogroup" aria-label="CLI 工具">
          {targetOptions.map((option) => (
            <button
              key={option.value}
              ref={(element) => { targetRefs.current[option.value] = element; }}
              type="button"
              role="radio"
              aria-checked={!teamSelected && target === option.value}
              tabIndex={!teamSelected && target === option.value ? 0 : -1}
              disabled={disabled}
              className={`wand-new-session-choice wand-new-session-provider-choice${!teamSelected && target === option.value ? " active" : ""}`}
              data-wand-autofocus={!teamSelected && target === option.value ? "" : undefined}
              onClick={() => selectTarget(option.value)}
              onKeyDown={(event) => navigateTarget(event, option.value)}
            >
              {option.value === "shell"
                ? <WandIcon name="terminal" size={20} className="wand-new-session-provider-logo" strokeWidth={1.8} />
                : <ProviderLogo provider={option.value} className="wand-new-session-provider-logo" />}
              <span className="wand-new-session-choice-label">{option.label}</span>
              <span className="wand-new-session-choice-description">{option.description}</span>
            </button>
          ))}
        </div>
      </fieldset>
      {teams && teams.length > 0 ? <fieldset className="wand-new-session-fieldset" disabled={disabled}>
        <legend className="wand-new-session-field-label">AI 团队</legend>
        <div className="wand-new-session-choices wand-workspace-agent-options" role="radiogroup" aria-label="AI 团队">
          {teams.map((team) => (
            <button
              key={team.id}
              type="button"
              role="radio"
              aria-checked={teamId === team.id}
              tabIndex={teamId === team.id ? 0 : -1}
              disabled={disabled || teamBlocked}
              title={teamBlocked ? TEAM_NEEDS_PROJECT_HINT : undefined}
              className={`wand-new-session-choice wand-new-session-provider-choice${teamId === team.id ? " active" : ""}`}
              onClick={() => selectTeam(team.id)}
            >
              <WandIcon name="parallel" size={20} className="wand-new-session-provider-logo" strokeWidth={1.8} />
              <span className="wand-new-session-choice-label">{team.name}</span>
              <span className="wand-new-session-choice-description">{team.detail}</span>
            </button>
          ))}
        </div>
        {teamBlocked ? <p className="wand-new-session-field-hint" role="status">{TEAM_NEEDS_PROJECT_HINT}</p> : null}
      </fieldset> : null}
      {!teamSelected && target !== "shell" ? (
        <fieldset className="wand-new-session-fieldset" disabled={disabled}>
          <legend className="wand-new-session-field-label">会话类型</legend>
          <div className="wand-new-session-choices" role="radiogroup" aria-label="会话类型">
            {WORKSPACE_KIND_OPTIONS.map((option) => (
              <button
                key={option.value}
                ref={(element) => { kindRefs.current[option.value] = element; }}
                type="button"
                role="radio"
                aria-checked={kind === option.value}
                tabIndex={kind === option.value ? 0 : -1}
                disabled={disabled}
                className={`wand-new-session-choice wand-new-session-kind-choice${kind === option.value ? " active" : ""}`}
                onClick={() => selectKind(option.value)}
                onKeyDown={(event) => navigateKind(event, option.value)}
              >
                <span className="wand-new-session-choice-label">{option.label}</span>
                <span className="wand-new-session-choice-description">{option.description}</span>
              </button>
            ))}
          </div>
        </fieldset>
      ) : null}
      {!teamSelected && target !== "shell" ? (
        <fieldset className="wand-new-session-fieldset wand-workspace-agent-model" disabled={disabled}>
          <legend className="wand-new-session-field-label">模型</legend>
          <WandSelect
            value={model || MODEL_CATALOG_DEFAULT_VALUE}
            options={wandModelOptions(catalog, target as WorkspaceProvider)}
            ariaLabel="模型"
            searchable
            searchPlaceholder="搜索模型"
            disabled={disabled}
            className="wand-workspace-agent-model-select"
            onValueChange={selectModel}
          />
          <p className="wand-new-session-field-hint">
            所选模型随会话启动一起提交；「跟随服务端默认」沿用服务端配置的默认模型。
          </p>
        </fieldset>
      ) : null}
    </>
  );
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
  onStart(target: WorkspaceSessionTarget, kind: WorkspaceSessionKind, model: string): void | Promise<void>;
  /** 团队分支旁路：onStart 签名不动，选团队时改走这条（§5.1 修正 B8）。 */
  onStartTeam?(teamId: string, workspaceId: string): void | Promise<void>;
}) {
  const [target, setTarget] = useState<WorkspaceSessionTarget>("claude");
  const [kind, setKind] = useState<WorkspaceSessionKind>("structured");
  const [model, setModel] = useState(MODEL_CATALOG_DEFAULT_VALUE);
  const [teamId, setTeamId] = useState("");
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
      // 选择器用 `default` 表示跟随服务端默认；交给调用方时统一换成真实模型 id（空串 = 默认）。
      await onStart(target, target === "shell" ? "pty" : kind, pickedModelId(model));
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "无法启动会话。");
    } finally {
      setSubmitting(false);
    }
  }

  const submitted = teamId
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
          onTargetChange={(next) => { setTarget(next); setModel(workspaceModelDefault(next)); }}
          onKindChange={setKind}
          onModelChange={setModel}
          onTeamChange={setTeamId}
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
