// 「当前打开的工作空间 / 任务」上下文（外部 store）。
// 主区标签栏 <WorkspaceTabBar/> 订阅它，决定是否渲染、加载哪个任务的会话列表。
// 刻意独立于 ui-store 的快照契约：避免给 UiSnapshotData 加字段、牵动一堆测试 fixture。
// 镜像 controller.ts 的 workspacesStore 模式：模块级单例 + subscribe/getSnapshot。

import type { TaskWindowLayout, WorkspaceProvider } from "./types";

export interface ActiveWorkspaceContext {
  /** 当前活动项目 id；无则为 null（标签栏隐藏）。 */
  workspaceId: string | null;
  workspaceName: string;
  /** 当前活动任务 id；任务粒度的标签栏以此为键拉取会话列表。 */
  taskId: string | null;
  taskName: string;
  /** 任务运行目录（worktree 路径或项目目录），新建会话时复用。 */
  cwd: string;
  /** 项目默认 provider（新建会话时优先使用）。 */
  provider?: WorkspaceProvider;
  /**
   * 当前任务的工作窗口集合。每个 window 对应顶部一个 Tab；活动 window
   * 内部是 split 时渲染 <WorkspaceWindow/>（终端池，多窗格并存）。
   */
  layout: TaskWindowLayout | null;
}

type Listener = () => void;

const EMPTY: ActiveWorkspaceContext = {
  workspaceId: null,
  workspaceName: "",
  taskId: null,
  taskName: "",
  cwd: "",
  layout: null,
};

let context: ActiveWorkspaceContext = EMPTY;
const listeners = new Set<Listener>();

export const workspaceContextStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot(): ActiveWorkspaceContext {
    return context;
  },
  getServerSnapshot(): ActiveWorkspaceContext {
    return EMPTY;
  },
};

/** 打开项目 / 任务时写入活动上下文（部分更新，与既有字段合并）。 */
export function setActiveWorkspaceContext(next: Partial<ActiveWorkspaceContext>): void {
  context = { ...context, ...next };
  for (const listener of listeners) listener();
}

/** 关闭工作空间窗口（标签栏「×」）时清空，标签栏随之隐藏。 */
export function clearActiveWorkspaceContext(): void {
  if (context === EMPTY) return;
  context = EMPTY;
  for (const listener of listeners) listener();
}
