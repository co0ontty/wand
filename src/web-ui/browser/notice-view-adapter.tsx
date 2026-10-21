/**
 * 通知视图的薄壳：真正的视图（antd Card 等）单独成块。
 *
 * 通知只在真的出现时才需要，Card/Alert/Spin 的实现不必跟着首屏 runtime 下载；
 * 代次标记保证「先清后画」的顺序在异步加载下依然成立。
 */
type NoticeViewModule = typeof import("./notice-view");
let viewModule: NoticeViewModule | null = null;
let viewPending: Promise<NoticeViewModule> | null = null;
const generations = new Map<HTMLElement, number>();

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

function nextGeneration(host: HTMLElement): number {
  const next = (generations.get(host) ?? 0) + 1;
  generations.set(host, next);
  return next;
}

function paintNotice(host: HTMLElement, apply: (module: NoticeViewModule) => void): void {
  const generation = nextGeneration(host);
  void loadNoticeView().then(module => {
    if (generations.get(host) !== generation) return;
    apply(module);
  }, () => {
    host.textContent = "通知加载失败，请重新加载页面。";
  });
}

export function clearNoticeView(host: HTMLElement): void {
  nextGeneration(host);
  viewModule?.clearNoticeView(host);
}

export function paintOfflineNotice(host: HTMLElement): void {
  paintNotice(host, module => module.paintOfflineNotice(host));
}

export function paintBootNotice(host: HTMLElement, error?: string, message?: string): void {
  paintNotice(host, module => module.paintBootNotice(host, error, message));
}

export function paintNotificationNotice(host: HTMLElement, options: { title: string; body?: string; type?: string; actionLabel?: string }): void {
  paintNotice(host, module => module.paintNotificationNotice(host, options));
}

export function paintUpdateNotice(host: HTMLElement, current: string, latest: string): void {
  paintNotice(host, module => module.paintUpdateNotice(host, current, latest));
}
