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
import { WandButton, WandIcon, WandSelect } from "../ui";
import { workspacesStore } from "./controller";
import type { WorkspaceProvider, WorkspaceSessionKind, WorkspaceSessionTarget } from "./types";

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

const TARGET_VALUES = WORKSPACE_AGENT_OPTIONS.map((option) => option.value);
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
  onTargetChange(target: WorkspaceSessionTarget): void;
  onKindChange(kind: WorkspaceSessionKind): void;
  onModelChange(model: string): void;
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
  onTargetChange,
  onKindChange,
  onModelChange,
}: WorkspaceAgentPickerProps) {
  const catalog = useWandModelCatalog();
  const targetRefs = useRef<Partial<Record<WorkspaceSessionTarget, HTMLButtonElement | null>>>({});
  const kindRefs = useRef<Partial<Record<WorkspaceSessionKind, HTMLButtonElement | null>>>({});

  function selectTarget(next: WorkspaceSessionTarget): void {
    if (disabled) return;
    onTargetChange(next);
    if (persistPreferences && next !== "shell") {
      void httpNewSessionRepository.savePreferences({ defaultProvider: next }).catch(() => undefined);
    }
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
    const next = nextChoice(TARGET_VALUES, current, event.key as ChoiceNavigationKey);
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

  return (
    <>
      <fieldset className="wand-new-session-fieldset" disabled={disabled}>
        <legend className="wand-new-session-field-label">CLI 工具</legend>
        <div className="wand-new-session-choices wand-workspace-agent-options" role="radiogroup" aria-label="CLI 工具">
          {WORKSPACE_AGENT_OPTIONS.map((option) => (
            <button
              key={option.value}
              ref={(element) => { targetRefs.current[option.value] = element; }}
              type="button"
              role="radio"
              aria-checked={target === option.value}
              tabIndex={target === option.value ? 0 : -1}
              disabled={disabled}
              className={`wand-new-session-choice wand-new-session-provider-choice${target === option.value ? " active" : ""}`}
              data-wand-autofocus={target === option.value ? "" : undefined}
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
      {target !== "shell" ? (
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
      {target !== "shell" ? (
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
  onStart,
}: {
  eyebrow?: string;
  title: string;
  subtitle: string;
  cwd?: string;
  submitLabel?: string;
  onStart(target: WorkspaceSessionTarget, kind: WorkspaceSessionKind, model: string): void | Promise<void>;
}) {
  const [target, setTarget] = useState<WorkspaceSessionTarget>("claude");
  const [kind, setKind] = useState<WorkspaceSessionKind>("structured");
  const [model, setModel] = useState(MODEL_CATALOG_DEFAULT_VALUE);
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
      // 选择器用 `default` 表示跟随服务端默认；交给调用方时统一换成真实模型 id（空串 = 默认）。
      await onStart(target, target === "shell" ? "pty" : kind, pickedModelId(model));
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "无法启动会话。");
    } finally {
      setSubmitting(false);
    }
  }

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
          onTargetChange={(next) => { setTarget(next); setModel(workspaceModelDefault(next)); }}
          onKindChange={setKind}
          onModelChange={setModel}
        />
        {error ? <p className="wand-new-session-error" role="alert">{error}</p> : null}
        <WandButton kind="primary" size="large" type="submit" disabled={submitting}>
          {submitting ? "正在启动…" : `${submitLabel}${target === "shell" ? "空白终端" : (WORKSPACE_AGENT_OPTIONS.find((option) => option.value === target)?.label ?? "")}`}
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
