/**
 * 待发送附件预览（`#attachment-preview`）的 portal 渲染契约。
 *
 * 旧实现用 `innerHTML` 拼 pill 列表、挂 `.att-remove` 监听、再用
 * `.hidden` 表达空状态；每次列表变化都要整段重建 DOM。现在 items 由
 * legacy 侧的 `state.attachmentsBySession` 算出快照，React 渲染并自带移除回调。
 *
 * `previewUrl` 是 legacy 侧 `URL.createObjectURL` 的产物，revoke 也由 legacy
 * 负责（`removePendingAttachment` / `discardPendingAttachments`），React 只负责显示。
 *
 * 幂等注册表见 `../composer-portal/mount-store`。
 */
import { MountStore, type MountSnapshot } from "../composer-portal/mount-store";

export interface ComposerAttachmentItem {
  /** 在 `state.attachmentsBySession[sessionId]` 里的下标，移除时回传给 legacy。 */
  readonly index: number;
  readonly name: string;
  /** 由 legacy 侧的 `formatFileSize` 算好，React 不做业务格式化。 */
  readonly sizeLabel: string;
  /** 图片附件的 object URL；其他类型为 null。 */
  readonly previewUrl: string | null;
}

export interface ComposerAttachmentsMount {
  readonly key: string;
  readonly target: HTMLElement;
  readonly items: ReadonlyArray<ComposerAttachmentItem>;
  readonly onRemove: (index: number) => void;
}

export interface ComposerAttachmentsSnapshot extends MountSnapshot<ComposerAttachmentsMount> {}

function sameItem(a: ComposerAttachmentItem, b: ComposerAttachmentItem): boolean {
  return a.index === b.index
    && a.name === b.name
    && a.sizeLabel === b.sizeLabel
    && a.previewUrl === b.previewUrl;
}

/** 回调不参与比较：它每次都是新闭包，但指向模块级稳定函数。 */
function sameMount(a: ComposerAttachmentsMount, b: ComposerAttachmentsMount): boolean {
  if (a.target !== b.target) return false;
  if (a.items.length !== b.items.length) return false;
  for (let i = 0; i < a.items.length; i += 1) {
    if (!sameItem(a.items[i], b.items[i])) return false;
  }
  return true;
}

export class ComposerAttachmentsController extends MountStore<ComposerAttachmentsMount> {
  constructor() {
    super(sameMount);
  }
}

export const composerAttachmentsController = new ComposerAttachmentsController();
