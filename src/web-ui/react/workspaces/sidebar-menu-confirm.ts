import { wandOverlay } from "../overlay-controller";

/** Confirmations replace the row menu instead of growing or covering it. */
export async function confirmSidebarAction({ title, description, action, danger = true, trigger }: {
  title: string;
  description: string;
  action: string;
  danger?: boolean;
  trigger?: HTMLElement | null;
}): Promise<boolean> {
  (trigger?.querySelector<HTMLElement>(".workspace-task-main,.workspace-row-main")
    ?? trigger?.querySelector<HTMLElement>("button,a[href]"))?.focus({ preventScroll: true });
  const answer = await wandOverlay.dialog({ title, description, actions: [
    { label: "取消", value: false, autoFocus: true },
    { label: action, value: true, kind: danger ? "danger" : "secondary" },
  ] });
  return answer.dismissed !== true && Boolean(answer.action);
}

export function confirmClearSessions(count: number, label: string, trigger?: HTMLElement | null, detail?: string): Promise<boolean> {
  if (count === 0) return Promise.resolve(false);
  return confirmSidebarAction({ title: `清空${label}的会话？`, trigger,
    description: detail ?? `将删除当前列出的全部 ${count} 个会话，包括正在运行的会话，无法撤销。任务和工作区会保留。`,
    action: "确认清空", });
}
