import { flushSync } from "react-dom";

import type { MountStore } from "../react/composer-portal/mount-store";

export interface SyncPortalMountsOptions<M> {
  /** 宿主 selector，例如 `[data-composer-config-host]`。 */
  selector: string;
  /** 返回 `null` 表示这个宿主当前不渲染任何东西（例如徽章处于隐藏状态）。 */
  build(target: HTMLElement, index: number): M | null;
  store: MountStore<M>;
  /**
   * 是否用 `flushSync` 提交。需要「同一帧长出内层宿主供其他适配器扫描」
   * 时必须开启；否则用默认的自动批处理即可。
   */
  flush?: boolean;
}

/**
 * 扫描常驻宿主并向 React 发布 mounts。
 *
 * 宿主 span 常驻在 `.input-panel` 的种子 markup 里（切会话后 portal 目标
 * 仍然有效），空状态由宿主上的 `.hidden` 表达 —— `.composer-status-row` 的
 * `:has(> *:not(.hidden))` 依赖它决定状态行是否折叠。
 */
export function syncPortalMounts<M>(options: SyncPortalMountsOptions<M>): void {
  const mounts: M[] = [];
  document.querySelectorAll<HTMLElement>(options.selector).forEach((target, index) => {
    if (!target.isConnected) return;
    const mount = options.build(target, index);
    if (mount) mounts.push(mount);
  });

  const apply = (): void => {
    if (mounts.length === 0) options.store.clear();
    else options.store.sync(mounts);
  };
  if (options.flush) flushSync(apply);
  else apply();
}
