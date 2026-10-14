import { useSyncExternalStore } from "react";
import * as React from "react";
import { createPortal } from "react-dom";
import { FileCard } from "@ant-design/x";
import { WandUiBoundary } from "../theme";
import { composerAttachmentsController, type ComposerAttachmentItem, type ComposerAttachmentsMount } from "./controller";
import { installStyleSheet } from "../styles.js";
import { imageViewerController } from "../image-viewer/controller.js";
import { borrowComposerFocus } from "../composer-sender/focus-borrow.js";

/** URLs and attachment lifetime belong to ComposerStore; X only displays its captured list. */
export function ComposerAttachmentList({ items, onRemove }: {
  items: ReadonlyArray<ComposerAttachmentItem>;
  onRemove(index: number): void;
}): React.ReactElement {
  const host = React.useRef<HTMLDivElement>(null);
  const [failedPreviews, setFailedPreviews] = React.useState<ReadonlySet<string>>(new Set());
  React.useEffect(() => {
    const urls = new Set(items.map(item => item.previewUrl));
    setFailedPreviews(previous => [...previous].every(url => urls.has(url)) ? previous : new Set([...previous].filter(url => urls.has(url))));
  }, [items]);
  const images = items.filter(item => item.previewUrl && !failedPreviews.has(item.previewUrl));
  const preview = (item: ComposerAttachmentItem, target: HTMLElement): void => {
    // Ant Image puts tabIndex/role/aria-label on its wrapper, not the inner img.
    const trigger = target;
    const composer = host.current?.closest<HTMLElement>(".conversation-composer, .input-panel, .input-composer");
    const owner = composer?.dataset.composerFocusOwner;
    trigger.focus({ preventScroll: true });
    const release = borrowComposerFocus(host.current?.closest<HTMLElement>(".conversation-input-wrap, .input-composer"), "attachment-preview");
    const opened = imageViewerController.openGroup(images.map(image => ({ src: image.previewUrl!, label: image.name })), images.findIndex(image => image.index === item.index), () => {
      // Keep the return target with this gallery, across the lazy host's loading
      // dialog. Ant calls this after its own leave animation and focus return.
      release();
      if (composer && composer.dataset.composerFocusOwner !== owner) return;
      if (trigger.isConnected && trigger.getClientRects().length && !trigger.closest("[inert],[hidden]")) {
        trigger.focus({ preventScroll: true });
      } else if (composer?.isConnected && composer.getClientRects().length && !composer.closest("[inert],[hidden]")) {
        const fallback = host.current?.querySelector<HTMLElement>('[role="button"][aria-label^="预览附件"]')
          ?? composer.querySelector<HTMLElement>("textarea:not(:disabled)");
        fallback?.focus({ preventScroll: true });
      }
    });
    if (!opened) release();
  };
  React.useLayoutEffect(() => installStyleSheet("wand-composer-attachments", `
    .composer-attachment-list { min-width:0; padding-block:4px 8px; max-height:min(168px,16dvh); overflow:auto; }
    .composer-attachment-list .ant-file-card-list { gap:8px; }
    .composer-attachment-list .ant-file-card-list-item { max-width:100%; padding-inline-end:32px; }
    .composer-attachment-list .ant-file-card-file { width:220px; max-width:100%; min-height:60px; padding:8px 10px; }
    .composer-attachment-list .ant-file-card-image { width:64px; height:60px; }
    .composer-attachment-list .ant-file-card-image-img img { height:60px; object-fit:cover; }
    .composer-attachment-list .ant-file-card-list-remove { opacity:1; transform:none; width:32px; height:32px; display:grid; place-items:center; inset-inline-end:0; inset-block-start:0; background:var(--bg-primary); color:var(--text-secondary); border-radius:var(--control-radius); }
    .composer-attachment-list .ant-file-card-list-remove:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
    .composer-attachment-preview-error { display:block; font-size:var(--font-size-xs); color:var(--text-secondary); overflow-wrap:anywhere; margin-block-start:4px; }
    @media(pointer:coarse) { .composer-attachment-list .ant-file-card-list-item { padding-inline-end:44px; } .composer-attachment-list .ant-file-card-list-remove { width:44px; height:44px; } }
  `), []);
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
  return <WandUiBoundary><div ref={host} className="composer-attachment-list" aria-label="待发送附件" aria-live="polite">
    <FileCard.List removable overflow="wrap" items={items.map(item => ({ key: String(item.index), name: item.name,
      byte: item.size, src: item.previewUrl || undefined, type: item.previewUrl && failedPreviews.has(item.previewUrl) ? "file" as const : item.previewUrl ? "image" as const : "file" as const,
      description: item.previewUrl && failedPreviews.has(item.previewUrl) ? "图片无法预览，已保留文件；可移除后重新添加" : item.sizeLabel,
      imageProps: { preview: false, tabIndex: 0, role: "button", "aria-label": `预览附件 ${item.name}`,
        onError: () => { if (item.previewUrl) setFailedPreviews(previous => new Set([...previous, item.previewUrl!])); },
        onClick: event => { event.stopPropagation(); preview(item, event.currentTarget); },
        onKeyDown: event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); preview(item, event.currentTarget); } },
      } }))} onRemove={item => onRemove(Number(item.key))}/>
  </div></WandUiBoundary>;
}

export function ComposerAttachments({ mount }: { mount: ComposerAttachmentsMount }): React.ReactElement {
  return <ComposerAttachmentList items={mount.items} onRemove={mount.onRemove}/>;
}

export function ComposerAttachmentsHost(): React.ReactElement[] {
  const snapshot = useSyncExternalStore(composerAttachmentsController.subscribe, composerAttachmentsController.getSnapshot, composerAttachmentsController.getSnapshot);
  return snapshot.mounts.map(mount => createPortal(<ComposerAttachments mount={mount}/>, mount.target, mount.key));
}
