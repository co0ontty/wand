import * as React from "react";
import { Card, Flex, Typography } from "antd";
import { DeferredMarkdownPreview } from "../file-preview/deferred-markdown";
import { WandButton } from "../ui/button";
import { usePopupDismiss } from "../ui/popup-lifecycle";
import { TaskTextArea } from "./task-form";

/** The saved task brief is reading content, never an implicit dispatch prompt. */
export function TaskDescription({ description, busy, onSave }: {
  description: string;
  busy: boolean;
  onSave(value: string): Promise<boolean>;
}): React.ReactElement {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(description);
  const [saving, setSaving] = React.useState(false);
  const input = React.useRef<HTMLTextAreaElement>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const close = () => { if (!saving) { setEditing(false); trigger.current?.focus(); } };
  usePopupDismiss(editing, close);
  React.useEffect(() => { if (editing) input.current?.focus(); }, [editing]);
  const save = async () => {
    if (saving || busy) return;
    if (draft === description) { close(); return; }
    setSaving(true);
    try {
      if (await onSave(draft) && mounted.current) { setEditing(false); trigger.current?.focus(); }
    } finally { if (mounted.current) setSaving(false); }
  };
  return <Card size="small" title="任务描述" role="region" aria-label="任务描述" extra={
    <WandButton ref={trigger} kind="ghost" size="small" disabled={busy || saving} aria-expanded={editing}
      onClick={() => { if (editing) close(); else { setDraft(description); setEditing(true); } }}>
      {editing ? "取消编辑" : "编辑描述"}
    </WandButton>
  }>
    {editing ? <Flex vertical gap="small" className="task-board-detail-content">
      <TaskTextArea ref={input} autoSize={{ minRows: 6, maxRows: 20 }} value={draft} disabled={busy || saving}
        aria-label="编辑任务描述" placeholder="补充背景、验收标准或复现步骤…"
        onChange={event => setDraft(event.currentTarget.value)}/>
      <Flex justify="space-between" align="center" gap="small">
        <Typography.Text type="secondary">仅保存描述，不会启动执行。</Typography.Text>
        <WandButton kind="primary" size="small" disabled={busy || saving} onClick={() => void save()}>
          {saving ? "正在保存…" : "保存描述"}
        </WandButton>
      </Flex>
    </Flex> : <div className="task-board-detail-content">
      {description.trim() ? <DeferredMarkdownPreview content={description} variant="inline" wrap/>
        : <Typography.Text type="secondary">暂无描述，可补充背景、验收标准或复现步骤。</Typography.Text>}
    </div>}
  </Card>;
}
