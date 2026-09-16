import { state } from "./state";
import { syncPortalMounts } from "./mount-sync";
import {
  composerActionErrorController,
  type ComposerActionErrorMount,
} from "../react/composer-action-error/controller";

/**
 * 输入面板内联错误条（`#action-error`）的 legacy 侧入口。
 *
 * 过去每个失败回调都自己 `getElementById("action-error")` 再
 * `showError(el, msg)`；那条路径依赖「节点确实在 DOM 里」——它在种子标签
 * 不平衡时会被 `replaceChildren()` 丢掉，于是错误静默消失。现在文案进
 * `state.actionError`，由 React 渲染，调用方只描述状态。
 */
export function showActionError(message: string): void {
  state.actionError = message;
  syncComposerActionError();
}

export function hideActionError(): void {
  if (!state.actionError) return;
  state.actionError = null;
  syncComposerActionError();
}

/**
 * 发布错误文案。`flush: true` 让错误在调用后立刻可见 —— 调用点分布在
 * fetch 的 `.catch()` 与 React 按钮的 onClick 里，不想等一次批处理。
 */
export function syncComposerActionError(): void {
  syncPortalMounts<ComposerActionErrorMount>({
    selector: "[data-composer-action-error-host]",
    store: composerActionErrorController,
    flush: true,
    build(target) {
      const message = state.actionError;
      if (!message) return null;
      return { key: "action-error", target, message };
    },
  });
}
