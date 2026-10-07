/** Attachment snapshots and object URLs remain owned by the browser composer. */
import { MountStore, type MountSnapshot } from "../composer-portal/mount-store";

export interface ComposerAttachmentItem {
  /** 在当前会话附件快照里的下标，移除时回传给 legacy。 */
  readonly index: number;
  readonly name: string;
  /** 由 legacy 侧的 `formatFileSize` 算好，React 不做业务格式化。 */
  readonly sizeLabel: string;
  readonly size?: number;
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
    && a.size === b.size
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
