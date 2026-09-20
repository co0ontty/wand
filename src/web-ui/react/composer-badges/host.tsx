import { useSyncExternalStore } from "react";
import * as React from "react";
import { createPortal } from "react-dom";
import {
  composerBadgesController,
  type ComposerApprovalStats,
  type ComposerBadgeMount,
  type ComposerPermissionMount,
} from "./controller";
import { WandIcon } from "../ui";

const AUTO_APPROVE_LABELS = {
  on: { label: "自动", aria: "自动批准已启用，点击关闭", title: "自动批准已启用 — 点击关闭" },
  off: { label: "手动", aria: "自动批准已关闭，点击开启", title: "自动批准已关闭 — 点击开启" },
} as const;

export function ComposerAutoApproveChip({
  enabled,
  pending = false,
  onToggle,
}: {
  enabled: boolean;
  pending?: boolean;
  onToggle: () => void;
}): React.ReactElement {
  const copy = enabled ? AUTO_APPROVE_LABELS.on : AUTO_APPROVE_LABELS.off;
  return (
    <button
      id="auto-approve-toggle"
      type="button"
      className={`composer-pill composer-pill-chip auto-approve-indicator${enabled ? " active" : ""}`}
      aria-pressed={enabled}
      aria-busy={pending || undefined}
      disabled={pending}
      aria-label={copy.aria}
      title={copy.title}
      onClick={(event) => {
        event.preventDefault();
        onToggle();
      }}
    >
      <WandIcon
        className="composer-pill-icon"
        name={enabled ? "shieldCheck" : "shield"}
        size={12}
        strokeWidth={1.7}
      />
      <span className="composer-pill-label">{copy.label}</span>
    </button>
  );
}

export function ComposerApprovalStatsBadge({
  stats,
  revision,
}: {
  stats: ComposerApprovalStats | null;
  revision: number;
}): React.ReactElement | null {
  const badgeRef = React.useRef<HTMLSpanElement>(null);

  // 每次同步重放一次脉冲动画（等价于旧实现里的 class 移除 + 强制回流 + 加回）。
  React.useEffect(() => {
    const badge = badgeRef.current;
    if (!badge) return;
    badge.classList.remove("approval-stats-pulse");
    void badge.offsetWidth;
    badge.classList.add("approval-stats-pulse");
  }, [revision]);

  if (!stats) return null;

  const rows: ReadonlyArray<{ icon: "terminal" | "file" | "wrench"; label: string; count: number }> = [
    { icon: "terminal", label: "命令执行", count: stats.command },
    { icon: "file", label: "文件写入", count: stats.file },
    { icon: "wrench", label: "其他工具", count: stats.tool },
  ];

  return (
    <span className="approval-stats" id="approval-stats">
      <span className="approval-stats-divider"/>
      <span className="approval-stats-badge" id="approval-stats-badge" ref={badgeRef} title="本次会话自动批准统计">
        <WandIcon className="approval-stats-icon" name="shield" size={12} strokeWidth={2}/>
        <span className="approval-stats-total">{stats.total}</span>
      </span>
      <span className="approval-stats-popup" id="approval-stats-popup">
        <span className="approval-stats-popup-title">自动批准统计</span>
        {rows
          .filter((row) => row.count > 0)
          .map((row) => (
            <span className="approval-stats-row" key={row.icon}>
              <span className="approval-stats-row-icon"><WandIcon name={row.icon} size={12} strokeWidth={1.8}/></span>
              <span className="approval-stats-row-label">{row.label}</span>
              <span className="approval-stats-row-count">{row.count}</span>
            </span>
          ))}
        <span className="approval-stats-row approval-stats-row-total">
          <span className="approval-stats-row-icon"><WandIcon name="sigma" size={12} strokeWidth={1.8}/></span>
          <span className="approval-stats-row-label">合计</span>
          <span className="approval-stats-row-count">{stats.total}</span>
        </span>
      </span>
    </span>
  );
}

export function ComposerPermissionActions({ permission, pending, onAction }: Pick<
  ComposerPermissionMount, "permission" | "pending" | "onAction"
>): React.ReactElement {
  return (
    <span className="permission-actions" id="permission-actions" aria-busy={pending || undefined}>
      <span className="permission-actions-label" id="permission-actions-label"
        role="status" aria-live="polite" aria-atomic="true">{permission.label}</span>
      {!permission.autoApproving && <>
        <button id="approve-permission-btn" className="btn btn-permission btn-permission-approve"
          type="button" disabled={pending} onClick={() => onAction("approve")}>批准</button>
        {permission.requestId && <button id="approve-turn-permission-btn"
          className="btn btn-permission btn-permission-approve" type="button" disabled={pending}
          onClick={() => onAction("approve-turn")}>本轮允许</button>}
        <button id="deny-permission-btn" className="btn btn-permission btn-permission-deny"
          type="button" disabled={pending} onClick={() => onAction("deny")}>拒绝</button>
      </>}
    </span>
  );
}

function renderBadge(mount: ComposerBadgeMount, revision: number): React.ReactElement | null {
  if (mount.kind === "permissions") {
    return <ComposerPermissionActions permission={mount.permission} pending={mount.pending} onAction={mount.onAction}/>;
  }
  if (mount.kind === "auto-approve") {
    return (
      <ComposerAutoApproveChip
        key={mount.key}
        enabled={mount.enabled}
        pending={mount.pending}
        onToggle={mount.onToggle}
      />
    );
  }
  return <ComposerApprovalStatsBadge key={mount.key} stats={mount.stats} revision={revision}/>;
}

export function ComposerBadgesHost(): React.ReactElement[] {
  const snapshot = useSyncExternalStore(
    composerBadgesController.subscribe,
    composerBadgesController.getSnapshot,
    composerBadgesController.getSnapshot,
  );

  return snapshot.mounts.map((mount) => createPortal(
    renderBadge(mount, snapshot.revision),
    mount.target,
    mount.key,
  ));
}
