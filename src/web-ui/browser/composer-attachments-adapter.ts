import { syncPortalMounts } from "./mount-sync";
import {
  composerAttachmentsController,
  type ComposerAttachmentItem,
  type ComposerAttachmentsMount,
} from "../react/composer-attachments/controller";

export interface BrowserComposerAttachmentsConfig {
  /** 当前会话的待发送附件；空数组表示不渲染预览条。 */
  resolve(): ReadonlyArray<ComposerAttachmentItem>;
  onRemove(index: number): void;
}

/**
 * 把待发送附件列表发布给 React。宿主常驻在 `.input-panel` 的种子 markup 里，
 * 列表为空时不发布 mount，React 整条不渲染（旧的 `.hidden` 等价物，且不占布局）。
 */
export function syncBrowserComposerAttachments(config: BrowserComposerAttachmentsConfig): void {
  syncPortalMounts<ComposerAttachmentsMount>({
    selector: "[data-composer-attachments-host]",
    store: composerAttachmentsController,
    build(target) {
      const items = config.resolve();
      if (items.length === 0) return null;
      return {
        key: "composer-attachments",
        target,
        items,
        onRemove: config.onRemove,
      };
    },
  });
}
