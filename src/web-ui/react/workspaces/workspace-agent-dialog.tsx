import {
  type FormEvent,
  useEffect,
  useState,
} from "react";

import { httpNewSessionRepository } from "../new-session/repository";
import { WandButton, WandDialogSurface } from "../ui";
import type { WorkspaceProvider, WorkspaceSessionKind, WorkspaceSessionTarget } from "./types";
import {
  WORKSPACE_AGENT_OPTIONS,
  WorkspaceAgentPicker,
} from "./workspace-agent-picker";

export { WORKSPACE_AGENT_OPTIONS, WORKSPACE_KIND_OPTIONS } from "./workspace-agent-picker";

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

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSubmitting(false);
    setError("");
    setTarget(initialProvider);
    setKind(initialKind === "pty" ? "pty" : "structured");
    void httpNewSessionRepository.loadConfig()
      .then((config) => {
        if (cancelled) return;
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
      description="在当前任务中选择 CLI 工具，以及结构化或 PTY 会话。"
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
          <WorkspaceAgentPicker
            target={target}
            kind={kind}
            disabled={submitting}
            onTargetChange={setTarget}
            onKindChange={setKind}
          />
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
