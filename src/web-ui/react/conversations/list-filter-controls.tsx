import * as React from "react";
import { Flex, Typography } from "antd";
import { WandButton } from "../ui/button";
import { conversationFilterCount, conversationFilterSummary, type ConversationListFilters } from "./list-filters";

export function ConversationListFilterSummary({ value, workspaces, employees = [], onClear }: {
  value: ConversationListFilters; workspaces: readonly { value: string; label: string }[];
  employees?: readonly { value: string; label: string }[]; onClear(): void;
}): React.ReactElement | null {
  if (!conversationFilterCount(value)) return null;
  const summary = conversationFilterSummary(value, workspaces, employees);
  return <Flex align="center" justify="space-between" gap={4} className="conversation-list-filter-summary">
    <Typography.Text type="secondary" ellipsis title={summary}>{summary}</Typography.Text>
    {conversationFilterCount(value) ? <WandButton kind="ghost" size="small" onClick={onClear}>清除筛选</WandButton> : null}
  </Flex>;
}
