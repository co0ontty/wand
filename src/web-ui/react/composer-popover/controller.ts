/**
 * 加号 popover 内两个条目的 portal 渲染契约。
 *
 * 容器（`#composer-plus-popover`）、开合状态、键盘导航与「点外部关闭」仍由
 * legacy 负责，因为它们绑的是容器本身；这里只接管条目内容：
 * 「上传附件」按钮与「终端交互」开关。旧实现让 `updateInteractiveControls`
 * 直接改写开关的 class / aria / 文案，现在改为发布快照。
 *
 * 幂等注册表本身见 `../composer-portal/mount-store`。
 */
import { MountStore, type MountSnapshot } from "../composer-portal/mount-store";

export interface ComposerPopoverState {
  /** 终端交互开关是否应在 popover 里露出（结构化会话、非终端视图下隐藏）。 */
  readonly interactiveVisible: boolean;
  readonly interactiveOn: boolean;
}

export interface ComposerPopoverMount extends ComposerPopoverState {
  readonly key: string;
  readonly target: HTMLElement;
  /** `keyboard` 表示触发来自键盘（`event.detail === 0`），用于决定关闭后焦点归位。 */
  readonly onAttach: (keyboard: boolean) => void;
  readonly onToggleInteractive: () => void;
}

export interface ComposerPopoverSnapshot extends MountSnapshot<ComposerPopoverMount> {}

/** 回调不参与比较：它们每次都是新闭包，但指向模块级稳定函数。 */
function sameMount(a: ComposerPopoverMount, b: ComposerPopoverMount): boolean {
  return a.target === b.target
    && a.interactiveVisible === b.interactiveVisible
    && a.interactiveOn === b.interactiveOn;
}

export class ComposerPopoverController extends MountStore<ComposerPopoverMount> {
  constructor() {
    super(sameMount);
  }
}

export const composerPopoverController = new ComposerPopoverController();
