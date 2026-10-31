import * as React from "react";
import { Flex, Select, Switch, Typography } from "antd";
import { WandButton } from "../ui/button";
import { usePopupDismiss } from "../ui/popup-lifecycle";
import { CONVERSATION_TASK_STAGES, DEFAULT_CONVERSATION_FILTERS, type ConversationListFilters } from "./list-filters";

type Field = "taskStage" | "workspace" | "archive";
function FilterField({ name, label, value, options, open, onOpenChange, onChange, searchable = false }: {
  name: Field; label: string; value: string; options: readonly { value: string; label: string }[];
  open: boolean; onOpenChange(open: boolean): void; onChange(value: string): void; searchable?: boolean;
}): React.ReactElement {
  const ref = React.useRef<React.ComponentRef<typeof Select>>(null);
  const [search, setSearch] = React.useState("");
  const labelId = React.useId();
  usePopupDismiss(open, () => { onOpenChange(false); ref.current?.focus({ preventScroll: true }); });
  React.useEffect(() => { if (!open) setSearch(""); }, [open]);
  return <div className="conversation-filter-field" data-conversation-filter-field={name}>
    <span id={labelId} className="conversation-filter-field-label">{label}</span>
    <Select ref={ref} aria-label={label} aria-labelledby={labelId} title={options.find(option => option.value === value)?.label}
      value={value} options={[...options]} labelRender={({ label }) => value === "all" ? "全部" : label} open={open} onOpenChange={onOpenChange}
      onChange={next => { onChange(String(next)); onOpenChange(false); }}
      showSearch={searchable} searchValue={search} onSearch={setSearch} optionFilterProp="label"
      notFoundContent="没有匹配的工作区" popupMatchSelectWidth={200} listHeight={240}
      getPopupContainer={(trigger: HTMLElement) => trigger.closest<HTMLElement>(".conversation-list-filter-panel") ?? document.body}/>
  </div>;
}


export function ConversationListFilterPanel({ value, workspaces, onCancel, onApply }: {
  value: ConversationListFilters;
  workspaces: readonly { value: string; label: string }[];
  onCancel(): void;
  onApply(value: ConversationListFilters): void;
}): React.ReactElement {
  const [draft, setDraft] = React.useState(value);
  const [field, setField] = React.useState<Field | null>(null);
  const options = workspaces.some(option => option.value === draft.workspace) ? workspaces
    : [...workspaces, { value: draft.workspace, label: "工作区不可用（可清除）" }];
  const close = (): void => { setField(null); onCancel(); };
  const fieldOpen = (name: Field) => (next: boolean): void => setField(next ? name : null);
  return (
    <div className="conversation-list-filter-panel" role="dialog" aria-label="会话筛选条件">
      <Flex justify="space-between" align="center"><Typography.Text strong>高级筛选</Typography.Text>
        <WandButton kind="ghost" size="small" onClick={() => { setField(null); setDraft(DEFAULT_CONVERSATION_FILTERS); }}>重置</WandButton></Flex>
      <div className="conversation-list-filter-fields">
        <FilterField name="taskStage" label="任务阶段" value={draft.taskStage} options={CONVERSATION_TASK_STAGES}
          open={field === "taskStage"} onOpenChange={fieldOpen("taskStage")} onChange={taskStage => setDraft({ ...draft, taskStage: taskStage as ConversationListFilters["taskStage"] })}/>
        <FilterField name="workspace" label="工作区" value={draft.workspace} options={options} searchable
          open={field === "workspace"} onOpenChange={fieldOpen("workspace")} onChange={workspace => setDraft({ ...draft, workspace })}/>
        <FilterField name="archive" label="归档范围" value={draft.archive} options={[
          { value: "all", label: "全部" }, { value: "active", label: "未归档" }, { value: "archived", label: "已归档" },
        ]} open={field === "archive"} onOpenChange={fieldOpen("archive")} onChange={archive => setDraft({ ...draft, archive: archive as ConversationListFilters["archive"] })}/>
      </div>
      <Flex align="center" gap={8} className="conversation-list-filter-activity"><Switch size="small" aria-label="只看活动会话" checked={draft.activityOnly} onChange={activityOnly => setDraft({ ...draft, activityOnly })}/><span>仅活动会话</span></Flex>
      <Flex className="conversation-list-filter-footer" justify="end" gap={8}><WandButton onClick={close}>取消</WandButton>
        <WandButton kind="primary" onClick={() => onApply(draft)}>应用筛选</WandButton></Flex>
    </div>
  );
}
