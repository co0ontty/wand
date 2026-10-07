import { Alert, Flex } from "antd";
import "../issues/library-layout";
import { TaskForm } from "../issues/form-controls";
import {
  type FormEvent,
  useEffect,
  useState,
} from "react";
import * as React from "react";

import { httpNewSessionRepository } from "../new-session/repository";
import { MODEL_CATALOG_DEFAULT_VALUE, pickedModelId } from "../model-catalog";
import { WandButton, WandDialogSurface } from "../ui";
import type { WorkspaceProvider, WorkspaceSessionKind, WorkspaceSessionTarget } from "./types";
import {
  WORKSPACE_AGENT_OPTIONS,
  WorkspaceAgentPicker,
  workspaceModelDefault,
} from "./workspace-agent-picker";
import { failureMessage } from "../errors";

export { WORKSPACE_AGENT_OPTIONS, WORKSPACE_KIND_OPTIONS } from "./workspace-agent-picker";

export interface WorkspaceAgentDialogProps {
  open: boolean;
  initialProvider?: WorkspaceProvider;
  initialKind?: WorkspaceSessionKind;
  /** `model` 为真实模型 id；空串表示跟随服务端默认。 */
  onConfirm(target: WorkspaceSessionTarget, kind: WorkspaceSessionKind, model: string, employeeId?: string): void | Promise<void>;
  onDismiss(): void;
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
  const [model, setModel] = useState(MODEL_CATALOG_DEFAULT_VALUE);
  const [employeeId, setEmployeeId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const choiceTouched = React.useRef(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    choiceTouched.current = false;
    setSubmitting(false);
    setError("");
    setTarget(initialProvider);
    setEmployeeId("");
    setKind(initialKind === "pty" ? "pty" : "structured");
    setModel(workspaceModelDefault(initialProvider));
    void httpNewSessionRepository.loadConfig()
      .then((config) => {
        if (cancelled || choiceTouched.current) return;
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
  }, [initialKind, initialProvider, open]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await onConfirm(target, employeeId ? "structured" : target === "shell" ? "pty" : kind,
        employeeId ? "" : pickedModelId(model), employeeId || undefined);
      onDismiss();
    } catch (createError) {
      setError(failureMessage(createError, "无法新建工作窗口，请确认对应 CLI 或 Shell 配置正确。"));
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
      className="wand-task-library-dialog wand-workspace-agent-modal"
      closeLabel="关闭工作窗口选择"
      testId="workspace-agent-dialog"
      dismissable={!submitting}
    >
      <TaskForm noValidate aria-busy={submitting} onSubmit={(event) => void submit(event)}>
        <Flex vertical gap={16}>
          <WorkspaceAgentPicker
            usageEnabled={open}
            target={target}
            kind={kind}
            model={model}
            disabled={submitting}
            employeeId={employeeId}
            onTargetChange={(next) => { choiceTouched.current = true; setTarget(next); setModel(workspaceModelDefault(next)); }}
            onKindChange={(next) => { choiceTouched.current = true; setKind(next); }}
            onModelChange={(next) => { choiceTouched.current = true; setModel(next); }}
            onEmployeeChange={(next) => { choiceTouched.current = true; setEmployeeId(next); }}
          />
          {error ? <Alert type="error" showIcon role="alert" title={error}/> : null}
        <Flex justify="flex-end" gap={8}>
          <WandButton kind="ghost" disabled={submitting} onClick={onDismiss}>取消</WandButton>
          <WandButton kind="primary" size="large" type="submit" disabled={submitting}>
            {submitting ? "正在创建…" : employeeId ? "与员工对话" : `创建 ${WORKSPACE_AGENT_OPTIONS.find((option) => option.value === target)?.label ?? target}`}
          </WandButton>
        </Flex>
        </Flex>
      </TaskForm>
    </WandDialogSurface>
  );
}
