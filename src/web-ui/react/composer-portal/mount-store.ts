/**
 * portal 宿主的幂等注册表。
 *
 * `.input-panel` 里已经有一批「种子留宿主 → browser 适配器扫宿主发布快照 →
 * React `createPortal` 渲染」的叶子（composer select / config / badges / popover）。
 * 每个叶子的差别只有「状态字段」和「哪些字段变化才算一次更新」，其余
 * subscribe / getSnapshot / sync / clear 完全一样，所以统一收敛到这里。
 *
 * 约定：
 * - `sync()` 必须幂等 —— `render()` 每轮都会重新发布一遍 mounts，值没变就
 *   不能广播，否则入口动画会随重渲染重放。
 * - **回调不参与比较**：它们每次都是新闭包，但捕获的都是模块级稳定函数；
 *   比较它们会让每次 `render()` 都广播一遍。
 */
export interface MountSnapshot<M> {
  readonly revision: number;
  readonly mounts: ReadonlyArray<M>;
}

export class MountStore<M> {
  private snapshot: MountSnapshot<M>;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly equals: (a: M, b: M) => boolean) {
    this.snapshot = Object.freeze({ revision: 0, mounts: Object.freeze([]) as ReadonlyArray<M> });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): MountSnapshot<M> => this.snapshot;

  sync(mounts: ReadonlyArray<M>): void {
    const current = this.snapshot.mounts;
    if (current.length === mounts.length && mounts.every((mount, i) => this.equals(current[i], mount))) {
      return;
    }
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
