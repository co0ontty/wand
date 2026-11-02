/**
 * 通知视图的薄壳：真正的视图（antd Card 等）单独成块。
 *
 * 通知只在真的出现时才需要，Card/Alert/Spin 的实现不必跟着首屏 runtime 下载；
 * 代次标记保证「先清后画」的顺序在异步加载下依然成立。
 */
import type { NotificationNoticeOptions, UpdateNoticeOptions } from "./notice-view";

type NoticeViewModule = typeof import("./notice-view");
let viewModule: NoticeViewModule | null = null;
let viewPending: Promise<NoticeViewModule> | null = null;
const generations = new WeakMap<HTMLElement, object>();

function loadNoticeView(): Promise<NoticeViewModule> {
  if (viewModule) return Promise.resolve(viewModule);
  if (!viewPending) {
    viewPending = import("./notice-view").then(module => {
      viewModule = module;
      viewPending = null;
      return module;
    }, error => {
      viewPending = null;
      throw error;
    });
  }
  return viewPending;
}

function nextGeneration(host: HTMLElement): object {
  const next = {};
  generations.set(host, next);
  return next;
}

function paintNotice(host: HTMLElement, apply: (module: NoticeViewModule) => void, onClose?: () => void): Promise<boolean> {
  const generation = nextGeneration(host);
  return loadNoticeView().then(module => {
    if (generations.get(host) !== generation) return false;
    apply(module);
    return true;
  }, () => {
    if (generations.get(host) !== generation) return false;
    host.textContent = "通知加载失败，请重新加载页面。";
    if (onClose) {
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "关闭通知";
      close.onclick = onClose;
      host.appendChild(close);
    }
    return true;
  });
}

export function clearNoticeView(host: HTMLElement): void {
  nextGeneration(host);
  viewModule?.clearNoticeView(host);
}

export function paintOfflineNotice(host: HTMLElement): void {
  void paintNotice(host, module => module.paintOfflineNotice(host));
}

export function paintBootNotice(host: HTMLElement, error?: string, message?: string): void {
  void paintNotice(host, module => module.paintBootNotice(host, error, message));
}

export type { NotificationNoticeOptions, UpdateNoticeOptions } from "./notice-view";

export function paintNotificationNotice(host: HTMLElement, options: NotificationNoticeOptions): Promise<boolean> {
  return paintNotice(host, module => module.paintNotificationNotice(host, options), options.onClose);
}

export function paintUpdateNotice(host: HTMLElement, options: UpdateNoticeOptions): void {
  void paintNotice(host, module => module.paintUpdateNotice(host, options), options.onClose);
}
