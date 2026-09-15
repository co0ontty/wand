import {
  composerRailController,
  type ComposerRailMount,
} from "../react/composer-rail/controller";

export interface BrowserComposerRailConfig {
  /** 只有「网页端 + PTY 直通」才保留 drafting row，原生嵌入壳自带底栏。 */
  active(): boolean;
  submit(): void;
  focusInput(): void;
}

/**
 * Collects `[data-composer-rail-host]` nodes and publishes one Appica submit
 * button per host. The host span lives in the composer markup, so the portal
 * target survives session switches; stale nodes are dropped by `isConnected`.
 */
export function syncBrowserComposerRail(config: BrowserComposerRailConfig): void {
  if (!config.active()) {
    composerRailController.clear();
    return;
  }
  const mounts: ComposerRailMount[] = [];
  document.querySelectorAll<HTMLElement>("[data-composer-rail-host]").forEach((target, index) => {
    if (!target.isConnected) return;
    mounts.push({
      key: target.dataset.composerRailHost || `composer-rail-${index}`,
      target,
      onSubmit() {
        config.submit();
        config.focusInput();
      },
    });
  });
  composerRailController.sync(mounts);
}
