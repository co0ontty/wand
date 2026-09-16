import {
  composerPopoverController,
  type ComposerPopoverMount,
  type ComposerPopoverState,
} from "../react/composer-popover/controller";
import { syncPortalMounts } from "./mount-sync";

export interface BrowserComposerPopoverConfig {
  resolve(): ComposerPopoverState;
  onAttach(keyboard: boolean): void;
  onToggleInteractive(): void;
}

const HOST_SELECTOR = "[data-composer-popover-host]";

/**
 * 把加号 popover 两个条目的状态发布给 React。
 *
 * 必须同步提交（`flush: true`）：Android 原生壳注入的
 * `EnableTerminalPassthroughScript` 会点 `#terminal-interactive-toggle-top`
 * 后立刻读 `aria-pressed`，异步批处理会让它读到旧值。
 */
export function syncBrowserComposerPopover(config: BrowserComposerPopoverConfig): void {
  syncPortalMounts<ComposerPopoverMount>({
    selector: HOST_SELECTOR,
    store: composerPopoverController,
    flush: true,
    build(target) {
      return {
        key: "composer-popover-items",
        target,
        ...config.resolve(),
        onAttach: config.onAttach,
        onToggleInteractive: config.onToggleInteractive,
      };
    },
  });
}
