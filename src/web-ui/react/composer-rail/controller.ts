/**
 * 直通 composer 的尾部操作区（Appica 渲染）。
 *
 * PTY 直通模式下 `#input-box` 是唯一的输入面，legacy 的发送 / 语音 / 优化按钮
 * 全部收起，右侧栏会留下一条空白。这里由 React 侧 portal 一个 Appica 按钮补上
 * 「发送回车」这个真实动作，让底部输入栏的可见控件都来自组件库。
 */
export interface ComposerRailMount {
  readonly key: string;
  readonly target: HTMLElement;
  /** 把当前行提交给 PTY（网页直通下等价于按 Enter）。 */
  readonly onSubmit: () => void;
  readonly disabled?: boolean;
  readonly hint?: string;
}

export interface ComposerRailSnapshot {
  readonly revision: number;
  readonly mounts: ReadonlyArray<ComposerRailMount>;
}

const EMPTY_SNAPSHOT: ComposerRailSnapshot = Object.freeze({
  revision: 0,
  mounts: Object.freeze([]),
});

export class ComposerRailController {
  private snapshot: ComposerRailSnapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ComposerRailSnapshot => this.snapshot;

  sync(mounts: ReadonlyArray<ComposerRailMount>): void {
    this.snapshot = Object.freeze({
      revision: this.snapshot.revision + 1,
      mounts: Object.freeze(mounts.slice()),
    });
    for (const listener of this.listeners) listener();
  }

  clear(): void {
    if (this.snapshot.mounts.length === 0) return;
    this.sync([]);
  }
}

export const composerRailController = new ComposerRailController();
