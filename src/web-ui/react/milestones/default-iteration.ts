// 「默认迭代」的前端口径：没单独选迭代的任务都会落到它下面，
// 所以各新建面板打开时把它预选上，用户看得见自己的任务归属，不用先去下拉里找。
//
// 只做预选，不做强制：用户手动清空后不会被重新填回来（每个面板只在打开时预选一次）。

import * as React from "react";

import { milestonesStore, visibleMilestones } from "./controller";
import type { MilestoneOption } from "./repository";

/** 默认迭代对象（按工作区过滤后取），拿不到时返回 null。 */
export function defaultMilestone(
  items: readonly MilestoneOption[],
  workspaceId?: string | null,
): MilestoneOption | null {
  return visibleMilestones(items, workspaceId).find((item) => item.isDefault) ?? null;
}

/**
 * 当前工作区可用的默认迭代。列表还没加载完时返回 null，等加载完成后自动补上预选。
 *
 * `active` 传宿主面板的打开状态：面板（含登录前的空壳）一直挂载着，只有真正打开时才该
 * 拉列表——否则会在登录前拿到 401，而这时一次性请求不会再重试，预选就永远失效。
 */
export function useDefaultMilestone(
  workspaceId?: string | null,
  active = true,
): MilestoneOption | null {
  const snapshot = React.useSyncExternalStore(
    milestonesStore.subscribe,
    milestonesStore.getSnapshot,
    milestonesStore.getSnapshot,
  );
  React.useEffect(() => {
    if (!active || snapshot.loaded || snapshot.loading) return;
    // 失败（未登录 / 网络）时 loaded 仍为 false，下次打开面板会再试一次。
    void milestonesStore.load().catch(() => undefined);
  }, [active, snapshot.loaded, snapshot.loading]);
  return React.useMemo(
    () => defaultMilestone(snapshot.items, workspaceId),
    [snapshot.items, workspaceId],
  );
}

/**
 * 每个打开周期只预选一次：`openKey` 变化（例如面板被关掉再打开）后才允许再填。
 * 用 ref 而不是依赖数组，避免用户在面板里清空后又被填回去。
 */
export function usePreselectMilestone(
  open: boolean,
  milestone: MilestoneOption | null,
  apply: (id: string) => void,
): void {
  const done = React.useRef(false);
  const applyRef = React.useRef(apply);
  applyRef.current = apply;
  React.useEffect(() => {
    if (!open) {
      done.current = false;
      return;
    }
    if (done.current || !milestone) return;
    done.current = true;
    applyRef.current(milestone.id);
  }, [open, milestone]);
}
