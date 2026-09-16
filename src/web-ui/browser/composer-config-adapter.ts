import {
  composerConfigController,
  type ComposerConfigMount,
  type ComposerConfigScope,
  type ComposerConfigState,
} from "../react/composer-config/controller";
import { syncPortalMounts } from "./mount-sync";

export interface BrowserComposerConfigConfig {
  resolve(scope: ComposerConfigScope): ComposerConfigState;
  onRefreshModels(): void;
  onOpenSkills(trigger: HTMLButtonElement): void;
}

function isScope(value: string | undefined): value is ComposerConfigScope {
  return value === "mode" || value === "runtime" || value === "all";
}

/**
 * 收集 `[data-composer-config-host]` 宿主，把 chip 状态发布给 React。
 *
 * chip 内部还有 `[data-composer-select-host]` 宿主，`refreshComposerConfigControls`
 * 紧接着会调 `syncBrowserComposerSelects` 去扫它们，所以这里必须同步提交
 * （flushSync），否则 select 会晚一帧才出现在刚挂上的 chip 里。宿主用
 * `display: contents`，所以 chip 依然是 `.composer-status-row` 的 flex item，
 * 折叠判定（`:has(> *:not(.hidden))`）也继续成立。
 */
export function syncBrowserComposerConfig(config: BrowserComposerConfigConfig): void {
  syncPortalMounts<ComposerConfigMount>({
    selector: "[data-composer-config-host]",
    store: composerConfigController,
    flush: true,
    build(target) {
      const scope = target.dataset.composerConfigHost;
      if (!isScope(scope)) return null;
      return {
        key: `composer-config-${scope}`,
        target,
        scope,
        ...config.resolve(scope),
        onRefreshModels: config.onRefreshModels,
        onOpenSkills: config.onOpenSkills,
      };
    },
  });
}
