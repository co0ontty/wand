import { useSyncExternalStore } from "react";
import * as React from "react";
import { createPortal } from "react-dom";
import { Attachments } from "@ant-design/x";
import { WandUiBoundary } from "../theme";
import { composerAttachmentsController, type ComposerAttachmentItem, type ComposerAttachmentsMount } from "./controller";

/** URLs and attachment lifetime belong to ComposerStore; X only displays its captured list. */
export function ComposerAttachmentList({ items, onRemove }: {
  items: ReadonlyArray<ComposerAttachmentItem>;
  onRemove(index: number): void;
}): React.ReactElement {
  const host = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const target = host.current;
    if (!target) return;
    // X's removal affordance is a div. Add the keyboard/accessible button contract without another control.
    const enhance = () => target.querySelectorAll<HTMLElement>(".ant-file-card-list-remove").forEach((node, index) => {
      node.setAttribute("role", "button"); node.tabIndex = 0;
      node.setAttribute("aria-label", `移除附件 ${items[index]?.name || ""}`);
      node.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); node.click(); } };
    });
    enhance();
    const observer = new MutationObserver(enhance); observer.observe(target, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [items]);
  return <WandUiBoundary><div ref={host} aria-label="待发送附件" aria-live="polite">
    <Attachments items={items.map(item => ({ uid: String(item.index), name: item.name,
      description: item.sizeLabel, size: item.size, status: "done", thumbUrl: item.previewUrl || undefined,
      url: item.previewUrl || undefined }))} overflow="wrap" maxCount={items.length} openFileDialogOnClick={false} getDropContainer={() => null} beforeUpload={() => false}
      onRemove={item => { onRemove(Number(item.uid)); return false; }}/>
  </div></WandUiBoundary>;
}

export function ComposerAttachments({ mount }: { mount: ComposerAttachmentsMount }): React.ReactElement {
  return <ComposerAttachmentList items={mount.items} onRemove={mount.onRemove}/>;
}

export function ComposerAttachmentsHost(): React.ReactElement[] {
  const snapshot = useSyncExternalStore(composerAttachmentsController.subscribe, composerAttachmentsController.getSnapshot, composerAttachmentsController.getSnapshot);
  return snapshot.mounts.map(mount => createPortal(<ComposerAttachments mount={mount}/>, mount.target, mount.key));
}
