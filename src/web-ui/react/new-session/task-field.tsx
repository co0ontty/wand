import * as React from "react";
import { Alert, Flex, Form } from "antd";
import { WandButton, WandIcon, WandPopover, WandSelect } from "../ui";
import { useTaskGroups } from "../workspaces/task-groups-store";
import type { NewSessionForm } from "./types";

export function NewSessionTaskField({ form, initialName, disabled, cwd, onChange, onCreateTask, inline }: {
  form: NewSessionForm;
  initialName?: string;
  disabled: boolean;
  cwd: string;
  onChange(form: NewSessionForm): void;
  onCreateTask(): void;
  inline?: boolean;
}) {
  const { groups, loading, error, reload } = useTaskGroups();
  const [popoverOpen, setPopoverOpen] = React.useState(false);
  const tasks = groups.flatMap(group => group.tasks.filter(task => !task.archived).map(task => ({ task, group })));
  const selected = tasks.find(({ task }) => task.id === form.workspaceTaskId);
  const taskLabel = form.workspaceTaskId
    ? (selected?.task.name || form.taskName || initialName || "所选任务")
    : (form.taskName !== undefined ? (form.taskName || "新建任务…") : "默认任务");

  const selector = (
    <WandSelect ariaLabel="所属任务" className="wand-new-session-model-select" disabled={disabled}
      searchable searchPlaceholder="搜索任务" value={form.workspaceTaskId || (form.taskName !== undefined ? "new" : "")}
      options={[
        { value: "", label: "默认任务" },
        { value: "new", label: "新建任务…" },
        ...(form.workspaceTaskId && !selected ? [{ value: form.workspaceTaskId, label: form.taskName || initialName || "当前任务" }] : []),
        ...tasks.map(({ task, group }) => ({ value: task.id, label: task.name, group: group.workspaceName })),
      ]}
      onValueChange={value => {
        const target = tasks.find(({ task }) => task.id === value);
        if (target) {
          onChange({ ...form, workspaceTaskId: target.task.id, workspaceId: target.task.workspaceId,
            taskName: undefined, cwd: target.task.worktree?.path || target.task.cwd || target.group.workspaceCwd });
          if (inline) setPopoverOpen(false);
        } else if (value === "new") {
          setPopoverOpen(false);
          onCreateTask();
        } else if (value === "") {
          onChange({ ...form, workspaceTaskId: undefined,
            workspaceId: selected && !selected.group.synthetic && !selected.group.global ? selected.group.workspaceId : form.workspaceId,
            cwd: form.workspaceTaskId ? form.cwd : selected?.group.workspaceCwd || cwd, taskName: undefined });
          if (inline) setPopoverOpen(false);
        }
      }}/>
  );

  const content = (
    <Flex vertical gap={8} style={inline ? { minWidth: 260, padding: 4 } : undefined}>
      <Form.Item label="所属任务" style={{ marginBottom: 0 }}>
        {selector}
      </Form.Item>
      {loading ? <span role="status">正在加载已有任务…</span> : null}
      {error ? <Alert type="warning" title={error} action={<WandButton size="small" onClick={() => void reload()}>重试</WandButton>}/> : null}
    </Flex>
  );

  if (inline) {
    return <WandPopover ariaLabel="选择所属任务" side="bottom" open={popoverOpen} onOpenChange={setPopoverOpen}
      trigger={<button type="button" disabled={disabled} className="new-work-inline-trigger new-work-inline-task"
        title={`所属任务：${taskLabel}，点击更换`} aria-label="所属任务">
        <WandIcon name="clipboard" size={14} className="new-work-inline-task-icon"/>
        <span className="new-work-inline-task-name">{taskLabel}</span>
        <WandIcon name="chevronDown" size={12} className="new-work-inline-arrow"/>
      </button>}>
      {content}
    </WandPopover>;
  }

  return content;
}
