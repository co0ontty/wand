/**
 * 输入面板内联错误条（`#action-error`）的 portal 渲染契约。
 *
 * 旧实现由调用方 `document.getElementById("action-error")` 拿节点后
 * `showError(el, msg)` 直接写 `textContent` + 切 `.hidden`。现在错误文案存在
 * `state.actionError`，React 负责渲染 —— 没有错误时整条 `<p>` 不存在
 * （等价于原来的 `.hidden`，且不占布局）。
 *
 * 幂等注册表见 `../composer-portal/mount-store`。
 */
import { MountStore, type MountSnapshot } from "../composer-portal/mount-store";

export interface ComposerActionErrorState {
  /** 非空字符串才会渲染错误条。 */
  readonly message: string;
}

export interface ComposerActionErrorMount extends ComposerActionErrorState {
  readonly key: string;
  readonly target: HTMLElement;
}

export interface ComposerActionErrorSnapshot extends MountSnapshot<ComposerActionErrorMount> {}

function sameMount(a: ComposerActionErrorMount, b: ComposerActionErrorMount): boolean {
  return a.target === b.target && a.message === b.message;
}

export class ComposerActionErrorController extends MountStore<ComposerActionErrorMount> {
  constructor() {
    super(sameMount);
  }
}

export const composerActionErrorController = new ComposerActionErrorController();
