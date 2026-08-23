import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import { nextChoice, type ChoiceNavigationKey } from "../new-session/choice-navigation";
import { httpNewSessionRepository } from "../new-session/repository";
import { ProviderLogo } from "../provider-logo";
import { WandButton, WandDialogSurface, WandIcon } from "../ui";
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

const KIND_OPTIONS: ReadonlyArray<{ value: WorkspaceSessionKind; label: string; description: string }> = [
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

export interface WorkspaceAgentDialogProps {
  open: boolean;
  initialProvider?: WorkspaceProvider;
  initialKind?: WorkspaceSessionKind;
  onConfirm(target: WorkspaceSessionTarget, kind: WorkspaceSessionKind): void | Promise<void>;
  onDismiss(): void;
}

function presentError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "无法新建工作窗口，请确认对应 CLI 或 Shell 配置正确。";
}



/** Shared work-window picker for every task-level add entry. */
export function WorkspaceAgentDialog({
  open,
  initialProvider = "claude",
  initialKind = "structured",
  onConfirm,
  onDismiss,
}: WorkspaceAgentDialogProps) {
  const [target, setTarget] = useState<WorkspaceSessionTarget>(initialProvider);
  const [kind, setKind] = useState<WorkspaceSessionKind>(initialKind);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const targetRefs = useRef<Partial<Record<WorkspaceSessionTarget, HTMLButtonElement | null>>>({});

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSubmitting(false);
    setError("");
    setTarget(initialProvider);
    setKind(initialKind === "pty" ? "pty" : "structured");
    void fetch("/api/config", { credentials: "same-origin" })
      .then((response) => response.ok ? response.json() : null)
      .then((config: { defaultProvider?: string; defaultSessionKind?: string } | null) => {
        if (cancelled || !config) return;
        const savedProvider = WORKSPACE_AGENT_OPTIONS.some((option) => option.value === config.defaultProvider)
          ? config.defaultProvider as WorkspaceSessionTarget
          : null;
        if (savedProvider && savedProvider !== "shell") setTarget(savedProvider);
        if (config.defaultSessionKind === "pty" || config.defaultSessionKind === "structured") {
          setKind(config.defaultSessionKind);
        }
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [initialKind, initialProvider, open]);

  function navigateTarget(
    event: KeyboardEvent<HTMLButtonElement>,
    current: WorkspaceSessionTarget,
  ): void {
    if (!RADIO_NAVIGATION_KEYS.has(event.key as ChoiceNavigationKey)) return;
    event.preventDefault();
    const next = nextChoice(TARGET_VALUES, current, event.key as ChoiceNavigationKey);
    setTarget(next);
    window.requestAnimationFrame(() => targetRefs.current[next]?.focus());
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await onConfirm(target, target === "shell" ? "pty" : kind);
      onDismiss();
    } catch (createError) {
      setError(presentError(createError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <WandDialogSurface
      open={open}
      onOpenChange={(nextOpen) => { if (!nextOpen) onDismiss(); }}
      title="新建工作窗口"
      description="在当前任务的同一 worktree 中选择 Agent，或直接启动空白终端。"
      className="wand-new-session-dialog wand-workspace-agent-dialog"
      overlayClassName="wand-new-session-overlay"
      titleClassName="wand-new-session-title"
      descriptionClassName="wand-new-session-description"
      headerClassName="wand-new-session-header"
      closeLabel="关闭工作窗口选择"
      testId="workspace-agent-dialog"
      dismissable={!submitting}
    >
      <form className="wand-new-session-form" aria-busy={submitting} onSubmit={(event) => void submit(event)}>
        <div className="wand-new-session-body wand-workspace-agent-body">
          <fieldset className="wand-new-session-fieldset">
            <legend className="wand-new-session-field-label">工作窗口类型</legend>
            <div className="wand-new-session-choices wand-workspace-agent-options" role="radiogroup" aria-label="工作窗口类型">
              {WORKSPACE_AGENT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  ref={(element) => { targetRefs.current[option.value] = element; }}
                  type="button"
                  role="radio"
                  aria-checked={target === option.value}
                  tabIndex={target === option.value ? 0 : -1}
                  className={`wand-new-session-choice wand-new-session-provider-choice${target === option.value ? " active" : ""}`}
                  data-wand-autofocus={target === option.value ? "" : undefined}
                  onClick={() => {
                    setTarget(option.value);
                    if (option.value !== "shell") {
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
            <fieldset className="wand-new-session-fieldset">
              <legend className="wand-new-session-field-label">会话类型</legend>
              <div className="wand-new-session-choices" role="radiogroup" aria-label="会话类型">
                {KIND_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={kind === option.value}
                    className={`wand-new-session-choice wand-new-session-kind-choice${kind === option.value ? " active" : ""}`}
                    onClick={() => {
                      setKind(option.value);
                      void httpNewSessionRepository.savePreferences({ defaultSessionKind: option.value }).catch(() => undefined);
                    }}
                  >
                    <span className="wand-new-session-choice-label">{option.label}</span>
                    <span className="wand-new-session-choice-description">{option.description}</span>
                  </button>
                ))}
              </div>
            </fieldset>
          ) : null}
          {error ? <p className="wand-new-session-error" role="alert">{error}</p> : null}
        </div>
        <div className="wand-new-session-footer wand-workspace-agent-footer">
          <WandButton kind="ghost" disabled={submitting} onClick={onDismiss}>取消</WandButton>
          <WandButton kind="primary" size="large" type="submit" disabled={submitting}>
            {submitting ? "正在创建…" : `创建 ${WORKSPACE_AGENT_OPTIONS.find((option) => option.value === target)?.label ?? target}`}
          </WandButton>
        </div>
      </form>
    </WandDialogSurface>
  );
}
