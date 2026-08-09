import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import { nextChoice, type ChoiceNavigationKey } from "../new-session/choice-navigation";
import { ProviderLogo } from "../provider-logo";
import { WandButton, WandDialogSurface } from "../ui";
import type { WorkspaceProvider } from "./types";

export const WORKSPACE_AGENT_OPTIONS: ReadonlyArray<{
  value: WorkspaceProvider;
  label: string;
  description: string;
}> = [
  { value: "claude", label: "Claude", description: "Claude Code" },
  { value: "codex", label: "Codex", description: "OpenAI Codex CLI" },
  { value: "opencode", label: "OpenCode", description: "OpenCode CLI" },
  { value: "grok", label: "Grok", description: "Grok Build CLI" },
  { value: "qoder", label: "Qoder", description: "Qoder CLI" },
  { value: "pi", label: "Pi", description: "Pi coding agent" },
];

const PROVIDER_VALUES = WORKSPACE_AGENT_OPTIONS.map((option) => option.value);
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
  onConfirm(provider: WorkspaceProvider): void | Promise<void>;
  onDismiss(): void;
}

function presentError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "无法新建 Agent 对话，请确认对应 CLI 已正确安装。";
}

/** Shared provider picker for every task-level “new Agent conversation” entry. */
export function WorkspaceAgentDialog({
  open,
  initialProvider = "claude",
  onConfirm,
  onDismiss,
}: WorkspaceAgentDialogProps) {
  const [provider, setProvider] = useState<WorkspaceProvider>(initialProvider);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const providerRefs = useRef<Partial<Record<WorkspaceProvider, HTMLButtonElement | null>>>({});

  useEffect(() => {
    if (!open) return;
    setProvider(initialProvider);
    setSubmitting(false);
    setError("");
  }, [initialProvider, open]);

  function navigateProvider(
    event: KeyboardEvent<HTMLButtonElement>,
    current: WorkspaceProvider,
  ): void {
    if (!RADIO_NAVIGATION_KEYS.has(event.key as ChoiceNavigationKey)) return;
    event.preventDefault();
    const next = nextChoice(PROVIDER_VALUES, current, event.key as ChoiceNavigationKey);
    setProvider(next);
    window.requestAnimationFrame(() => providerRefs.current[next]?.focus());
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await onConfirm(provider);
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
      title="选择 Agent"
      description="在当前任务的同一 worktree 中新增一个独立对话。"
      className="wand-new-session-dialog wand-workspace-agent-dialog"
      overlayClassName="wand-new-session-overlay"
      titleClassName="wand-new-session-title"
      descriptionClassName="wand-new-session-description"
      headerClassName="wand-new-session-header"
      closeLabel="关闭 Agent 选择"
      testId="workspace-agent-dialog"
      dismissable={!submitting}
    >
      <form className="wand-new-session-form" aria-busy={submitting} onSubmit={(event) => void submit(event)}>
        <div className="wand-new-session-body wand-workspace-agent-body">
          <fieldset className="wand-new-session-fieldset">
            <legend className="wand-new-session-field-label">Agent</legend>
            <div className="wand-new-session-choices wand-workspace-agent-options" role="radiogroup" aria-label="Agent">
              {WORKSPACE_AGENT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  ref={(element) => { providerRefs.current[option.value] = element; }}
                  type="button"
                  role="radio"
                  aria-checked={provider === option.value}
                  tabIndex={provider === option.value ? 0 : -1}
                  className={`wand-new-session-choice wand-new-session-provider-choice${provider === option.value ? " active" : ""}`}
                  data-wand-autofocus={provider === option.value ? "" : undefined}
                  onClick={() => setProvider(option.value)}
                  onKeyDown={(event) => navigateProvider(event, provider)}
                >
                  <ProviderLogo provider={option.value} className="wand-new-session-provider-logo" />
                  <span className="wand-new-session-choice-label">{option.label}</span>
                  <span className="wand-new-session-choice-description">{option.description}</span>
                </button>
              ))}
            </div>
          </fieldset>
          {error ? <p className="wand-new-session-error" role="alert">{error}</p> : null}
        </div>
        <div className="wand-new-session-footer wand-workspace-agent-footer">
          <WandButton kind="ghost" disabled={submitting} onClick={onDismiss}>取消</WandButton>
          <WandButton kind="primary" size="large" type="submit" disabled={submitting}>
            {submitting ? "正在创建…" : `使用 ${WORKSPACE_AGENT_OPTIONS.find((option) => option.value === provider)?.label ?? provider}`}
          </WandButton>
        </div>
      </form>
    </WandDialogSurface>
  );
}
