import { type FormEvent, type KeyboardEvent, useRef, useState } from "react";

import { nextChoice, type ChoiceNavigationKey } from "../new-session/choice-navigation";
import { httpNewSessionRepository } from "../new-session/repository";
import { ProviderLogo } from "../provider-logo";
import { WandButton, WandIcon } from "../ui";
import type { WorkspaceSessionKind, WorkspaceSessionTarget } from "./types";

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
  disabled?: boolean;
  persistPreferences?: boolean;
  onTargetChange(target: WorkspaceSessionTarget): void;
  onKindChange(kind: WorkspaceSessionKind): void;
}

export function WorkspaceAgentPicker({
  target,
  kind,
  disabled = false,
  persistPreferences = true,
  onTargetChange,
  onKindChange,
}: WorkspaceAgentPickerProps) {
  const targetRefs = useRef<Partial<Record<WorkspaceSessionTarget, HTMLButtonElement | null>>>({});

  function navigateTarget(
    event: KeyboardEvent<HTMLButtonElement>,
    current: WorkspaceSessionTarget,
  ): void {
    if (disabled || !RADIO_NAVIGATION_KEYS.has(event.key as ChoiceNavigationKey)) return;
    event.preventDefault();
    const next = nextChoice(TARGET_VALUES, current, event.key as ChoiceNavigationKey);
    onTargetChange(next);
    window.requestAnimationFrame(() => targetRefs.current[next]?.focus());
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
              onClick={() => {
                onTargetChange(option.value);
                if (persistPreferences && option.value !== "shell") {
                  void httpNewSessionRepository.savePreferences({ defaultProvider: option.value }).catch(() => undefined);
                }
              }}
              onKeyDown={(event) => navigateTarget(event, target)}
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
                type="button"
                role="radio"
                aria-checked={kind === option.value}
                disabled={disabled}
                className={`wand-new-session-choice wand-new-session-kind-choice${kind === option.value ? " active" : ""}`}
                onClick={() => {
                  onKindChange(option.value);
                  if (persistPreferences) {
                    void httpNewSessionRepository.savePreferences({ defaultSessionKind: option.value }).catch(() => undefined);
                  }
                }}
              >
                <span className="wand-new-session-choice-label">{option.label}</span>
                <span className="wand-new-session-choice-description">{option.description}</span>
              </button>
            ))}
          </div>
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
  onStart(target: WorkspaceSessionTarget, kind: WorkspaceSessionKind): void | Promise<void>;
}) {
  const [target, setTarget] = useState<WorkspaceSessionTarget>("claude");
  const [kind, setKind] = useState<WorkspaceSessionKind>("structured");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await onStart(target, target === "shell" ? "pty" : kind);
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
      <form className="workspace-welcome-form" aria-busy={submitting} onSubmit={(event) => void submit(event)}>
        <WorkspaceAgentPicker
          target={target}
          kind={kind}
          disabled={submitting}
          onTargetChange={setTarget}
          onKindChange={setKind}
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
