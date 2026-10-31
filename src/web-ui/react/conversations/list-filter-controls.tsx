import * as React from "react";
import { Flex, Typography } from "antd";
import { WandButton } from "../ui/button";
import { WandHintButton } from "../ui/hint-button";
import { WandIcon } from "../ui/icons";
import { WandPopover } from "../ui/popover";
import { deferredComponent } from "../deferred-feature";
import { conversationFilterCount, conversationFilterSummary, type ConversationListFilters } from "./list-filters";

// Select and searchable option menus load only when the user opens this surface.
const FilterPanel = deferredComponent(
  () => import("./list-filter-panel").then(module => module.ConversationListFilterPanel),
  { title: "筛选条件", renderPending: status => <div className="conversation-list-filter-panel" style={{ minHeight: 188 }}>{status}</div> },
);

export function ConversationListFilterControls({ value, workspaces, enabled, onChange }: {
  value: ConversationListFilters;
  workspaces: readonly { value: string; label: string }[];
  enabled: boolean;
  onChange(value: ConversationListFilters): void;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const count = conversationFilterCount(value);
  React.useEffect(() => { if (!enabled) setOpen(false); }, [enabled]);
  return <WandPopover open={open && enabled} onOpenChange={setOpen} align="center" ariaLabel="筛选会话" popupOwner="conversation-list-filters"
    trigger={<WandHintButton hint={open ? undefined : "设置会话列表的任务阶段、工作区、归档及活动筛选，不影响当前会话"} className="conversation-list-filter-trigger" kind={count ? "soft" : "secondary"} aria-label={`筛选会话${count ? `，${count} 个条件` : ""}`}
      aria-expanded={open} aria-haspopup="dialog" disabled={!enabled}><WandIcon name="sliders" size={16}/><span>{count || "筛选"}</span></WandHintButton>}>
    {open && enabled ? <FilterPanel value={value} workspaces={workspaces} onCancel={() => setOpen(false)}
      onApply={next => { onChange(next); setOpen(false); }}/> : null}
  </WandPopover>;
}

export function ConversationListFilterSummary({ value, workspaces, onClear }: {
  value: ConversationListFilters; workspaces: readonly { value: string; label: string }[]; onClear(): void;
}): React.ReactElement {
  const summary = conversationFilterSummary(value, workspaces);
  return <Flex align="center" justify="space-between" gap={4} className="conversation-list-filter-summary">
    <Typography.Text type="secondary" ellipsis title={summary}>{summary}</Typography.Text>
    {conversationFilterCount(value) ? <WandButton kind="ghost" size="small" onClick={onClear}>清除筛选</WandButton> : null}
  </Flex>;
}
