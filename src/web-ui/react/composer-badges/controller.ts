/**
 * Composer 状态徽章的 portal 注册表。
 *
 * `.input-panel` 的宿主 markup 由 legacy seed 生成，React 接管状态行中的
 * 自动批准 chip、权限操作与自动批准统计。browser 只发布会话状态和命令回调，
 * React 负责节点、事件和请求期间的禁用状态。
 */
import { MountStore, type MountSnapshot } from "../composer-portal/mount-store";

export type ComposerBadgeKind = "auto-approve" | "approval-stats" | "permissions";
export type ComposerPermissionAction = "approve" | "approve-turn" | "deny";

export interface ComposerPermissionState {
  readonly requestId: string | null;
  readonly label: string;
  readonly autoApproving: boolean;
}

export interface ComposerPermissionMount {
  readonly key: string;
  readonly kind: "permissions";
  readonly target: HTMLElement;
  readonly sessionId: string;
  readonly pending: boolean;
  readonly permission: ComposerPermissionState;
  readonly onAction: (action: ComposerPermissionAction) => void;
}

export interface ComposerApprovalStats {
  readonly total: number;
  readonly command: number;
  readonly file: number;
  readonly tool: number;
}

export interface ComposerAutoApproveBadgeMount {
  readonly key: string;
  readonly kind: "auto-approve";
  readonly target: HTMLElement;
  readonly sessionId: string;
  readonly pending: boolean;
  readonly enabled: boolean;
  readonly onToggle: () => void;
}

export interface ComposerApprovalStatsBadgeMount {
  readonly key: string;
  readonly kind: "approval-stats";
  readonly target: HTMLElement;
  /** `null` 表示当前会话没有自动批准记录，徽章整体不渲染。 */
  readonly stats: ComposerApprovalStats | null;
}

export type ComposerBadgeMount = ComposerAutoApproveBadgeMount | ComposerApprovalStatsBadgeMount | ComposerPermissionMount;

export interface ComposerBadgesSnapshot extends MountSnapshot<ComposerBadgeMount> {}

function sameStats(a: ComposerApprovalStats | null, b: ComposerApprovalStats | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.total === b.total && a.command === b.command && a.file === b.file && a.tool === b.tool;
}

/**
 * `render()` 每次都会重新同步一遍徽章，而同步本身是幂等的：值没变就不广播，
 * 否则统计徽章会在每次重渲染时重放一遍脉冲动画。`onToggle` 每次都是新闭包，
 * 所以不参与比较。
 */
function sameMount(a: ComposerBadgeMount, b: ComposerBadgeMount): boolean {
  if (a.key !== b.key || a.target !== b.target) return false;
  if (a.kind === "auto-approve" && b.kind === "auto-approve") {
    return a.sessionId === b.sessionId && a.enabled === b.enabled && a.pending === b.pending;
  }
  if (a.kind === "permissions" && b.kind === "permissions") {
    return a.sessionId === b.sessionId && a.pending === b.pending
      && a.permission.requestId === b.permission.requestId
      && a.permission.label === b.permission.label
      && a.permission.autoApproving === b.permission.autoApproving;
  }
  if (a.kind === "approval-stats" && b.kind === "approval-stats") return sameStats(a.stats, b.stats);
  return false;
}

export class ComposerBadgesController extends MountStore<ComposerBadgeMount> {
  constructor() {
    super(sameMount);
  }
}

export const composerBadgesController = new ComposerBadgesController();
