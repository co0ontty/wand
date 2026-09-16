import type { WandSelectOption } from "../ui";

export type ComposerSelectControl = "mode" | "model" | "thinking";
export type ComposerSelectScope = "mode" | "runtime" | "all" | "dropdown";

export interface ComposerSelectMount {
  readonly key: string;
  readonly target: HTMLElement;
  readonly control: ComposerSelectControl;
  readonly scope: ComposerSelectScope;
  readonly value: string;
  readonly options: ReadonlyArray<WandSelectOption>;
  readonly ariaLabel: string;
  readonly placeholder?: string;
  readonly displayValue?: string;
  /** 悬停 tooltip 用的完整值（例如带完整前缀的模型 ID），不参与可见文本。 */
  readonly displayTitle?: string;
  readonly disabled?: boolean;
  readonly align?: "start" | "center" | "end";
  readonly onValueChange: (value: string) => void;
}

export interface ComposerSelectSnapshot {
  readonly revision: number;
  readonly mounts: ReadonlyArray<ComposerSelectMount>;
}

const EMPTY_SNAPSHOT: ComposerSelectSnapshot = Object.freeze({
  revision: 0,
  mounts: Object.freeze([]),
});

export class ComposerSelectController {
  private snapshot: ComposerSelectSnapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ComposerSelectSnapshot => this.snapshot;

  sync(mounts: ReadonlyArray<ComposerSelectMount>): void {
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

export const composerSelectController = new ComposerSelectController();
