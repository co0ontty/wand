import { MountStore } from "../composer-portal/mount-store";
import type { PiSessionSettings } from "../../../pi-session-settings.js";

/** 打开来源：决定收起后焦点回到输入框还是设置图标。 */
export type PiSettingsOpener = "draft" | "toggle";

export interface PiSettingsMount {
  key: string;
  target: HTMLElement;
  /** 输入框里的设置图标宿主；与面板同一个 mount，避免两份开关状态。 */
  toggleTarget: HTMLElement;
  sessionId: string;
  draft: string;
  open: boolean;
  /** Changes on every real reopening, including close/open within one React batch. */
  openRevision?: number;
  onSaved(sessionId: string, settings: PiSessionSettings): void;
  /** 收起后把焦点还给触发点（输入框或设置图标）。 */
  returnFocus(): void;
}

export class PiSettingsController extends MountStore<PiSettingsMount> {
  private dismissed: { sessionId: string; draft: string } | null = null;
  /** 由输入框里的设置图标展开的会话（与草稿无关，输入内容不收起面板）。 */
  private expanded: string | null = null;
  private opener: PiSettingsOpener = "draft";
  private focusPending = false;
  private openRevision = 0;
  private panelFocus: { sessionId: string; target: HTMLElement; focus(last: boolean): boolean } | null = null;
  constructor() {
    super((a, b) => a.target === b.target && a.toggleTarget === b.toggleTarget
      && a.sessionId === b.sessionId && a.draft === b.draft && a.open === b.open && a.openRevision === b.openRevision);
  }

  override sync(mounts: ReadonlyArray<PiSettingsMount>): void {
    // 会话换了就把展开态丢掉：不能在另一个会话上重放上一个会话的面板。
    if (this.expanded && this.expanded !== mounts[0]?.sessionId) this.expanded = null;
    const current = this.getSnapshot().mounts[0];
    if (current?.sessionId !== mounts[0]?.sessionId) {
      this.focusPending = false;
      this.opener = "draft";
    }
    if (mounts[0]?.open && (!current?.open || current.sessionId !== mounts[0].sessionId)) this.openRevision++;
    super.sync(mounts.map((mount) => ({ ...mount, openRevision: this.openRevision })));
  }

  isDismissed(sessionId: string, draft: string): boolean {
    return this.dismissed?.sessionId === sessionId && this.dismissed.draft === draft;
  }

  isExpanded(sessionId: string): boolean {
    return this.expanded === sessionId;
  }

  openedBy(): PiSettingsOpener {
    return this.opener;
  }

  /** 返回切换后的展开状态；只有真正打开时才需要把焦点送进面板。 */
  toggle(sessionId: string): boolean {
    const mount = this.getSnapshot().mounts[0];
    if (!mount || mount.sessionId !== sessionId) return false;
    if (mount.open) {
      this.dismiss();
      return false;
    }
    this.dismissed = null;
    this.expanded = sessionId;
    this.opener = "toggle";
    this.focusPending = true;
    this.sync([{ ...mount, open: true }]);
    return true;
  }

  dismiss(): void {
    const mount = this.getSnapshot().mounts[0];
    if (!mount) return;
    this.dismissed = { sessionId: mount.sessionId, draft: mount.draft };
    this.expanded = null;
    this.focusPending = false;
    this.sync([{ ...mount, open: false }]);
  }

  /** 输入 `/settings` 等命令时展开：来源记为草稿，收起后焦点回输入框。 */
  reopen(): void {
    this.dismissed = null;
    this.expanded = null;
    this.opener = "draft";
    const mount = this.getSnapshot().mounts[0];
    if (mount) this.sync([{ ...mount, open: true }]);
  }

  /**
   * 图标展开时请求把焦点送进面板。设置还在读取中时控件都是禁用的，
   * 所以这个请求要保留到「真的聚焦到某个控件」才算用完。
   */
  hasPendingFocus(): boolean {
    return this.focusPending;
  }

  clearPendingFocus(): void {
    this.focusPending = false;
  }

  registerFocus(mount: PiSettingsMount, focus: (last: boolean) => boolean): () => void {
    const entry = { sessionId: mount.sessionId, target: mount.target, focus };
    this.panelFocus = entry;
    return () => { if (this.panelFocus === entry) this.panelFocus = null; };
  }

  /** 返回是否真的聚焦到了控件；没有可用控件时不谎报成功。 */
  focusControl(last = false): boolean {
    const mount = this.getSnapshot().mounts[0];
    if (mount?.open && this.panelFocus?.sessionId === mount.sessionId && this.panelFocus.target === mount.target) {
      return this.panelFocus.focus(last);
    }
    return false;
  }
}
export const piSettingsController = new PiSettingsController();
