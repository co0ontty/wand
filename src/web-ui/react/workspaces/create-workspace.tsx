import * as React from "react";
import { Alert, Flex, Form, Typography } from "antd";
import { WandButton, WandInput } from "../ui";
import { WandDialogSurface } from "../ui/dialog";
import { httpFolderPickerRepository } from "../folder-picker/repository";
import { FolderPickerOptions } from "../folder-picker/options";
import type { FolderPickerListing } from "../folder-picker/types";
import { HttpNewSessionRepository } from "../new-session/repository";
import { httpWorkspacesRepository } from "./repository";
import { taskGroupsStore } from "./task-groups-store";
import { notifyTasksChanged } from "../task-changes";
import { useParentPopupOwner } from "../ui/portal-context";
import { registerPopupOwner } from "../ui/popup-lifecycle";
import { addWorkspaceDraftFor, clearAddWorkspaceDraft, rememberAddWorkspaceDraft, requestAddWorkspace, workspacesController } from "./controller";
import type { Workspace } from "./types";

export function AddWorkspaceButton({ onCreated, initialCwd = "" }: { initialCwd?: string; onCreated?(workspace: Workspace): void }) {
  const parentOwner = useParentPopupOwner();
  return <WandButton kind="ghost" onClick={() => requestAddWorkspace(initialCwd, onCreated, parentOwner ?? undefined)}>＋ 添加工作区</WandButton>;
}

export function CreateWorkspaceDialog({ initialCwd = "", popupOwner, onClose, onCreated }: {
  initialCwd?: string; popupOwner?: string; onClose(): void; onCreated(workspace: Workspace): void;
}) {
  const restored = addWorkspaceDraftFor(initialCwd);
  const [cwd, setCwd] = React.useState(restored?.cwd || initialCwd);
  const [name, setName] = React.useState(restored?.name || "");
  const succeeded = React.useRef(false);
  const close = () => {
    if (!succeeded.current) rememberAddWorkspaceDraft({ initialCwd, cwd, name });
    onClose();
  };
  const [recent, setRecent] = React.useState<readonly { path: string; name: string }[]>([]);
  const [listing, setListing] = React.useState<FolderPickerListing | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [directoryError, setDirectoryError] = React.useState("");
  const lock = React.useRef(false);
  const itemRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const id = React.useId();
  const parentOwner = useParentPopupOwner();
  React.useLayoutEffect(() => registerPopupOwner(id, popupOwner || parentOwner), [id, popupOwner, parentOwner]);
  React.useEffect(() => {
    const abort = new AbortController();
    void new HttpNewSessionRepository().load({ signal: abort.signal }).then(defaults => {
      if (abort.signal.aborted) return;
      setRecent(defaults.recentPaths);
      setCwd(current => current || defaults.recentPaths[0]?.path || defaults.config.defaultCwd);
    }).catch(cause => { if (!abort.signal.aborted) setError(String(cause.message || cause)); });
    return () => abort.abort();
  }, []);
  React.useEffect(() => {
    const abort = new AbortController();
    setListing(null); setDirectoryError("");
    if (!cwd.trim()) { setLoading(false); return; }
    setLoading(true);
    void httpFolderPickerRepository.list(cwd, { signal: abort.signal }).then(value => {
      if (!abort.signal.aborted) setListing(value);
    }).catch(cause => { if (!abort.signal.aborted) setDirectoryError(String(cause.message || cause)); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [cwd]);
  const save = async () => {
    if (lock.current || !listing || !name.trim() || loading) return;
    lock.current = true; setBusy(true); setError(""); workspacesController.setDismissable(false);
    try {
      const workspace = await httpWorkspacesRepository.create({ name: name.trim(), cwd: listing.currentPath, userAdded: true });
      succeeded.current = true;
      clearAddWorkspaceDraft();
      void taskGroupsStore.reload();
      notifyTasksChanged();
      window.dispatchEvent(new Event("wand-workspaces-changed"));
      onCreated(workspace);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "添加失败，请重试。"); }
    finally { lock.current = false; setBusy(false); workspacesController.setDismissable(true); }
  };
  return <WandDialogSurface open popupOwner={id} title="添加工作区" dismissable={!busy} onOpenChange={next => { if (!next) close(); }}>
    <Flex vertical gap={12}>
      <Form layout="vertical" onFinish={() => void save()}>
        <Form.Item label="目录路径" required><WandInput autoFocus aria-label="工作区目录路径" value={cwd} disabled={busy} onChange={event => setCwd(event.currentTarget.value)}/></Form.Item>
        {recent.length ? <Flex vertical gap={4}><Typography.Text type="secondary">执行过任务的目录</Typography.Text>
          {recent.slice(0, 6).map(item => <WandButton key={item.path} kind="ghost" disabled={busy} title={item.path} onClick={() => setCwd(item.path)}>{item.name} · {item.path}</WandButton>)}</Flex> : null}
        {directoryError ? <Alert type="error" title={directoryError}/> : null}
        <FolderPickerOptions id={id} optionPrefix={id} items={listing?.items} loading={loading} error={directoryError} activeIndex={activeIndex}
          itemRefs={itemRefs} onActiveIndex={setActiveIndex} onActivate={item => { if (!busy) setCwd(item.path); }}/>
        <Form.Item label="路径别名" required><WandInput aria-label="工作区别名" maxLength={80} value={name} disabled={busy} placeholder="例如：Wand 项目" onChange={event => setName(event.currentTarget.value)}/></Form.Item>
        {error ? <Alert type="error" showIcon title={error}/> : null}
        <Flex gap={8} justify="end"><WandButton disabled={busy} onClick={close}>取消</WandButton>
          <WandButton kind="primary" type="submit" style={{ minWidth: 112 }} disabled={busy || loading || !listing || !name.trim()}>{busy ? "正在添加…" : "添加工作区"}</WandButton></Flex>
      </Form>
    </Flex>
  </WandDialogSurface>;
}
