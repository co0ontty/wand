import {
  composerBadgesController,
  type ComposerApprovalStats,
  type ComposerBadgeMount,
  type ComposerPermissionAction,
  type ComposerPermissionState,
} from "../react/composer-badges/controller";
import { syncPortalMounts } from "./mount-sync";

export interface BrowserComposerBadgeState {
  readonly sessionId: string;
  readonly autoApprovePending: boolean;
  readonly permissionPending: boolean;
  readonly permission: ComposerPermissionState | null;
  /** 模式（managed / full-access）已隐含自动批准时，chip 不应出现。 */
  readonly autoApproveHidden: boolean;
  readonly autoApproveEnabled: boolean;
  /** `null` 表示当前会话还没有自动批准记录。 */
  readonly approvalStats: ComposerApprovalStats | null;
}

export interface BrowserComposerBadgesConfig {
  /** 返回 `null` 表示当前没有选中会话，状态行不渲染会话控件。 */
  resolve(): BrowserComposerBadgeState | null;
  onToggleAutoApprove(sessionId: string): void;
  onPermissionAction(sessionId: string, requestId: string | null, action: ComposerPermissionAction): void;
}

/** 模式隐含自动批准、或没有选中会话时，chip 不出现。 */
export function resolveAutoApproveBadge(
  state: BrowserComposerBadgeState | null,
): { visible: boolean; enabled: boolean } {
  if (!state || state.autoApproveHidden) return { visible: false, enabled: false };
  return { visible: true, enabled: state.autoApproveEnabled };
}

/**
 * 旧实现只在 total > 0 时显示统计：服务端会给会话挂上 `{ total: 0, ... }`，
 * 那不是「有统计」，徽章必须继续隐藏。
 */
export function resolveApprovalStatsBadge(
  stats: ComposerApprovalStats | null | undefined,
): ComposerApprovalStats | null {
  return stats && stats.total > 0 ? stats : null;
}

/**
 * 收集 `[data-composer-badge-host]` 宿主节点，把「值 + 可见性」发布给 React。
 *
 * 宿主 span 常驻在 `.input-panel` 的种子 markup 里（所以 portal 目标在切会话后
 * 仍然有效），空状态通过给宿主加 `.hidden` 表达 —— `.composer-status-row` 的
 * `:has(> *:not(.hidden))` 依赖它决定状态行是否折叠。
 */
export function syncBrowserComposerBadges(config: BrowserComposerBadgesConfig): void {
  const current = config.resolve();
  syncPortalMounts<ComposerBadgeMount>({
    selector: "[data-composer-badge-host]",
    store: composerBadgesController,
    build(target, index) {
      const kind = target.dataset.composerBadgeHost;
      const key = kind || `composer-badge-${index}`;
      if (kind === "auto-approve") {
        const { visible, enabled } = resolveAutoApproveBadge(current);
        target.classList.toggle("hidden", !visible);
        if (!visible || !current) return null;
        const sessionId = current.sessionId;
        return {
          key,
          kind: "auto-approve",
          target,
          sessionId,
          pending: current.autoApprovePending,
          enabled,
          onToggle() {
            config.onToggleAutoApprove(sessionId);
          },
        };
      }
      if (kind === "permissions") {
        target.classList.toggle("hidden", !current?.permission);
        if (!current?.permission) return null;
        const { sessionId, permission } = current;
        return {
          key,
          kind: "permissions",
          target,
          sessionId,
          pending: current.permissionPending,
          permission,
          onAction(action) {
            config.onPermissionAction(sessionId, permission.requestId, action);
          },
        };
      }
      if (kind === "approval-stats") {
        const stats = resolveApprovalStatsBadge(current?.approvalStats);
        target.classList.toggle("hidden", !stats);
        return { key, kind: "approval-stats", target, stats };
      }
      return null;
    },
  });
}
