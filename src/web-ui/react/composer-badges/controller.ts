/**
 * Composer 状态徽章的 portal 注册表。
 *
 * `.input-panel` 的宿主 markup 由 legacy seed 生成，React 只接管这两个叶子：
 * `auto-approve`（自动批准 chip）与 `approval-stats`（自动批准统计）。legacy 侧
 * 每轮同步把「值 + 可见性」推到这里，React 负责渲染；旧的命令式 innerHTML
 * 覆盖与「节点不存在就删掉」都已删除。
 */
import { MountStore, type MountSnapshot } from "../composer-portal/mount-store";

export type ComposerBadgeKind = "auto-approve" | "approval-stats";

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

export type ComposerBadgeMount = ComposerAutoApproveBadgeMount | ComposerApprovalStatsBadgeMount;

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
  if (a.kind === "auto-approve" && b.kind === "auto-approve") return a.enabled === b.enabled;
  if (a.kind === "approval-stats" && b.kind === "approval-stats") return sameStats(a.stats, b.stats);
  return false;
}

export class ComposerBadgesController extends MountStore<ComposerBadgeMount> {
  constructor() {
    super(sameMount);
  }
}

export const composerBadgesController = new ComposerBadgesController();
