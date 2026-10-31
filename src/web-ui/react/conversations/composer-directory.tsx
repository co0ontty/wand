import * as React from "react";
import { Alert, Flex, Typography } from "antd";
import { FolderPickerOptions } from "../folder-picker/options";
import { httpFolderPickerRepository } from "../folder-picker/repository";
import type { FolderPickerListing } from "../folder-picker/types";
import { WandButton, WandIcon, WandInput, WandPopover } from "../ui";

/** Page-local new-work directory; never changes an existing execution session. */
export function ConversationComposerDirectory({ value, defaultCwd, disabled, onChange }: {
  value: string; defaultCwd: string; disabled: boolean; onChange(value: string): void;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [path, setPath] = React.useState("");
  const [listing, setListing] = React.useState<FolderPickerListing | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const itemRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const id = React.useId();
  const effectiveCwd = value || defaultCwd;
  React.useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  React.useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setListing(null); setError(""); setActiveIndex(-1);
    if (!path.trim()) { setLoading(false); return; }
    setLoading(true);
    void httpFolderPickerRepository.list(path, { signal: abort.signal }).then(next => {
      if (!abort.signal.aborted) setListing(next);
    }).catch(cause => {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "无法读取目录。");
    }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [open, path]);
  return <WandPopover side="top" align="end" ariaLabel="本次消息运行目录" open={open && !disabled} onOpenChange={next => {
    setOpen(next); if (next) setPath(effectiveCwd);
  }} trigger={<WandButton kind="ghost" className="conversation-directory-trigger" disabled={disabled}
    title={effectiveCwd || "默认目录尚未读取"} aria-label={`选择运行目录：${effectiveCwd || "默认目录尚未读取"}`}>
    <WandIcon name="folder" size={14}/><span>{effectiveCwd.split(/[\\/]/).filter(Boolean).at(-1) || effectiveCwd || "选择目录"}</span><WandIcon name="chevronDown" size={12}/>
  </WandButton>}>
    <Flex vertical gap={8} className="conversation-directory-picker">
      <Typography.Text strong>本次消息运行目录</Typography.Text>
      <WandInput autoFocus aria-label="临时聊天目录（本页共用）" placeholder="输入服务端目录路径" value={path} onChange={event => setPath(event.currentTarget.value)}/>
      {error ? <Alert type="error" showIcon title={error}/> : null}
      <FolderPickerOptions id={id} optionPrefix={id} items={listing?.items} loading={loading} error={error}
        activeIndex={activeIndex} itemRefs={itemRefs} onActiveIndex={setActiveIndex} onActivate={item => setPath(item.path)}/>
      <Typography.Text type="secondary">只影响之后发送的新工作；本页联系人共用，不改变已有工作的目录。</Typography.Text>
      <Flex gap={8} justify="space-between">
        <WandButton disabled={disabled} onClick={() => { onChange(""); setOpen(false); }}>使用默认目录</WandButton>
        <WandButton kind="primary" disabled={disabled || loading || !listing || !!error} onClick={() => {
          if (listing) { onChange(listing.currentPath); setOpen(false); }
        }}>使用此目录</WandButton>
      </Flex>
    </Flex>
  </WandPopover>;
}
