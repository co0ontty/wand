import { useSyncExternalStore } from "react";
import * as React from "react";
import { createPortal } from "react-dom";
import { composerBadgesController, type ComposerApprovalStats, type ComposerBadgeMount, type ComposerPermissionMount } from "./controller";
import { WandButton, WandIcon, WandPopover } from "../ui";

export function ComposerAutoApproveChip({ enabled, pending = false, onToggle }: {
  enabled: boolean; pending?: boolean; onToggle(): void;
}): React.ReactElement {
  return <WandButton id="auto-approve-toggle" size="small" kind={enabled ? "soft" : "ghost"}
    aria-pressed={enabled} aria-busy={pending || undefined} disabled={pending}
    aria-label={`自动批准已${enabled ? "启用，点击关闭" : "关闭，点击开启"}`} onClick={onToggle}>
    <WandIcon name={enabled ? "shieldCheck" : "shield"} size={12}/>{enabled ? "自动" : "手动"}
  </WandButton>;
}

export function ComposerApprovalStatsBadge({ stats }: { stats: ComposerApprovalStats | null; revision: number }): React.ReactElement | null {
  if (!stats) return null;
  return <WandPopover ariaLabel="自动批准统计" contentId="approval-stats-popup"
    trigger={<WandButton id="approval-stats-badge" kind="ghost" size="small" aria-label="本次会话自动批准统计">
      <WandIcon name="shield" size={12}/>{stats.total}</WandButton>}>
    <div id="approval-stats">命令执行 {stats.command} · 文件写入 {stats.file} · 其他工具 {stats.tool} · 合计 {stats.total}</div>
  </WandPopover>;
}

export function ComposerPermissionActions({ permission, pending, onAction }: Pick<ComposerPermissionMount, "permission" | "pending" | "onAction">): React.ReactElement {
  return <span id="permission-actions" aria-busy={pending || undefined}>
    <span id="permission-actions-label" role="status" aria-live="polite" aria-atomic="true">{permission.label}</span>
    {!permission.autoApproving && <>
      <WandButton id="approve-permission-btn" size="small" kind="primary" disabled={pending} onClick={() => onAction("approve")}>批准</WandButton>
      {permission.requestId && <WandButton id="approve-turn-permission-btn" size="small" disabled={pending} onClick={() => onAction("approve-turn")}>本轮允许</WandButton>}
      <WandButton id="deny-permission-btn" size="small" kind="danger" disabled={pending} onClick={() => onAction("deny")}>拒绝</WandButton>
    </>}
  </span>;
}

function renderBadge(mount: ComposerBadgeMount, revision: number): React.ReactElement | null {
  if (mount.kind === "permissions") return <ComposerPermissionActions permission={mount.permission} pending={mount.pending} onAction={mount.onAction}/>;
  if (mount.kind === "auto-approve") return <ComposerAutoApproveChip enabled={mount.enabled} pending={mount.pending} onToggle={mount.onToggle}/>;
  return <ComposerApprovalStatsBadge stats={mount.stats} revision={revision}/>;
}

export function ComposerBadgesHost(): React.ReactElement[] {
  const snapshot = useSyncExternalStore(composerBadgesController.subscribe, composerBadgesController.getSnapshot, composerBadgesController.getSnapshot);
  return snapshot.mounts.map(mount => createPortal(renderBadge(mount, snapshot.revision), mount.target, mount.key));
}
