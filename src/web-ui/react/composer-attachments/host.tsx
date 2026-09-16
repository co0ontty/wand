import { useSyncExternalStore } from "react";
import * as React from "react";
import { createPortal } from "react-dom";
import { WandIcon } from "../ui";
import {
  composerAttachmentsController,
  type ComposerAttachmentsMount,
} from "./controller";

/**
 * 待发送附件 pill 列表。保留 `.attachment-preview` / `.attachment-pill*`
 * 这套 class：桌面与移动两套 CSS 都挂在它们上面（移动端是 36px 横向滚动条）。
 * 空列表时适配器不发布 mount，整条预览不渲染 —— 等价于旧的 `.hidden` 且不占布局。
 */
export function ComposerAttachments({ mount }: { mount: ComposerAttachmentsMount }): React.ReactElement {
  return (
    <div className="attachment-preview" aria-label="待发送附件" aria-live="polite">
      {mount.items.map((item) => (
        <span className="attachment-pill" data-index={item.index} key={item.index}>
          {item.previewUrl ? (
            <img src={item.previewUrl} alt="" />
          ) : (
            <span className="att-icon">
              <WandIcon name="file" size={13} strokeWidth={1.7} />
            </span>
          )}
          <span className="att-name" title={item.name}>{item.name}</span>
          <span className="att-size">{item.sizeLabel}</span>
          <button
            className="att-remove"
            data-index={item.index}
            type="button"
            title="移除"
            aria-label={`移除附件 ${item.name}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              mount.onRemove(item.index);
            }}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

export function ComposerAttachmentsHost(): React.ReactElement[] {
  const snapshot = useSyncExternalStore(
    composerAttachmentsController.subscribe,
    composerAttachmentsController.getSnapshot,
    composerAttachmentsController.getSnapshot,
  );

  return snapshot.mounts.map((mount) => createPortal(
    <ComposerAttachments mount={mount} />,
    mount.target,
    mount.key,
  ));
}
