import { Alert, Flex, Form } from "antd";
import { WandButton, WandInput, WandSelect } from "../ui";
import { useTaskGroups } from "../workspaces/task-groups-store";
import type { NewSessionForm } from "./types";

export function NewSessionTaskField({ form, initialName, disabled, cwd, onChange }: {
  form: NewSessionForm;
  initialName: string;
  disabled: boolean;
  cwd: string;
  onChange(form: NewSessionForm): void;
}) {
  const { groups, loading, error, reload } = useTaskGroups();
  const tasks = groups.flatMap(group => group.tasks.filter(task => !task.archived).map(task => ({ task, group })));
  const selected = tasks.find(({ task }) => task.id === form.workspaceTaskId);
  return <Flex vertical gap={8}>
    <Form.Item label="所属任务" style={{ marginBottom: 0 }}>
      <WandSelect ariaLabel="所属任务" className="wand-new-session-model-select" disabled={disabled}
        searchable searchPlaceholder="搜索任务" value={form.workspaceTaskId || (form.taskName !== undefined ? "new" : "")}
        options={[
          { value: "", label: "不分组" },
          { value: "new", label: "新建任务…" },
          ...(form.workspaceTaskId && !selected ? [{ value: form.workspaceTaskId, label: form.taskName || initialName || "当前任务" }] : []),
          ...tasks.map(({ task, group }) => ({ value: task.id, label: task.name, group: group.workspaceName })),
        ]}
        onValueChange={value => {
          const target = tasks.find(({ task }) => task.id === value);
          if (target) onChange({ ...form, workspaceTaskId: target.task.id, workspaceId: target.task.workspaceId,
            taskName: undefined, cwd: target.task.worktree?.path || target.task.cwd || target.group.workspaceCwd });
          else if (value === "" || value === "new") onChange({ ...form, workspaceTaskId: undefined,
            workspaceId: selected && !selected.group.synthetic && !selected.group.global ? selected.group.workspaceId : form.workspaceId,
            cwd: selected?.group.workspaceCwd || cwd, taskName: value === "new" ? form.taskName ?? "" : undefined });
        }}/>
    </Form.Item>
    {form.taskName !== undefined && !form.workspaceTaskId ? <Form.Item label="任务名称" htmlFor="wand-new-session-task-name" required
      style={{ marginBottom: 0 }} extra="先创建任务，再在任务中启动会话。">
      <WandInput id="wand-new-session-task-name" value={form.taskName} disabled={disabled} maxLength={200}
        placeholder="输入任务名称" onChange={event => onChange({ ...form, taskName: event.currentTarget.value })}/>
    </Form.Item> : null}
    {loading ? <span role="status">正在加载已有任务…</span> : null}
    {error ? <Alert type="warning" title={error} action={<WandButton size="small" onClick={() => void reload()}>重试</WandButton>}/> : null}
  </Flex>;
}
