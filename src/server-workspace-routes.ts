import path from "node:path";
import crypto from "node:crypto";
import { existsSync, statSync } from "node:fs";
import type { Express } from "express";
import { asyncRoute } from "./express-async.js";
import { getErrorMessage } from "./error-utils.js";
import { expandHomePath } from "./middleware/path-safety.js";
import {
  checkSessionWorktreeMergeabilityAsync,
  cleanupWorktreeSync,
  prepareSessionWorktree,
  resolveWorktreeTargetBranchAsync,
} from "./git-worktree.js";
import type { SessionRegistry } from "./session-registry.js";
import type { WandStorage } from "./storage.js";
import { collectSessionTopicBlocklist } from "./session-topic.js";
import { resolveSessionDisplayTitle } from "./session-transport.js";
import type { LayoutNode, PaneTab, SessionProvider, SessionSnapshot, TaskWindowLayout, WorkspaceDefaultProvider, WorkspaceTaskWorktree } from "./types.js";
import {
  attachUnboundSessionsToWorkspace,
  backfillSessionWorkspaces,
} from "./workspace-binding.js";

const PROVIDERS: ReadonlySet<string> = new Set(["claude", "codex", "opencode", "grok", "qoder", "pi"]);

function workspaceSessionTitle(
  session: SessionSnapshot,
  names: { taskName?: string | null; workspaceName?: string | null } = {},
): string {
  return resolveSessionDisplayTitle(session, collectSessionTopicBlocklist({
    taskName: names.taskName,
    workspaceName: names.workspaceName,
    cwd: session.cwd,
  }));
}

function parseDefaultProvider(value: unknown): WorkspaceDefaultProvider | undefined {
  return typeof value === "string" && PROVIDERS.has(value) ? (value as SessionProvider) : undefined;
}

/** Resolve + validate a workspace cwd: expand home, require an existing directory. */
function resolveWorkspaceCwd(raw: unknown): string {
  const expanded = expandHomePath(typeof raw === "string" ? raw : "");
  if (!expanded.trim()) throw new Error("请选择项目目录。");
  const resolved = path.resolve(expanded);
  if (!existsSync(resolved)) throw new Error(`目录不存在：${resolved}`);
  if (!statSync(resolved).isDirectory()) throw new Error(`不是目录：${resolved}`);
  return resolved;
}

function deleteSessions(
  storage: WandStorage,
  sessions: SessionRegistry | undefined,
  sessionIds: Iterable<string>,
): void {
  for (const sessionId of new Set(sessionIds)) {
    if (sessions) sessions.deleteWithProviderHistory(sessionId);
    else storage.deleteSession(sessionId);
  }
}

function workspaceWithCounts(
  storage: WandStorage,
  workspace: NonNullable<ReturnType<WandStorage["getWorkspace"]>>,
  sessionCounts?: Map<string, number>,
) {
  const worktreeCount = storage.listWorkspaceTasks(workspace.id)
    .filter((task) => task.worktree !== null)
    .length;
  const sessionCount = sessionCounts?.get(workspace.id)
    ?? storage.listSessionsByWorkspace(workspace.id).length;
  return { ...workspace, worktreeCount, sessionCount };
}

// ── Layout validation / sanitization（前端 PUT 与测试共用）──

function sanitizePaneTab(value: unknown): PaneTab | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const id = typeof v.id === "string" && v.id ? v.id : null;
  if (!id) return null;
  if (v.kind === "session") {
    if (typeof v.sessionId !== "string" || !v.sessionId) return null;
    return { id, kind: "session", sessionId: v.sessionId };
  }
  if (v.kind === "editor" || v.kind === "preview") {
    if (typeof v.path !== "string" || !v.path) return null;
    return { id, kind: v.kind, path: v.path };
  }
  return null;
}

function sanitizeLayoutNode(value: unknown): LayoutNode | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.type === "pane") {
    const rawTabs = Array.isArray(v.tabs) ? v.tabs : [];
    const tabs = rawTabs
      .map(sanitizePaneTab)
      .filter((tab): tab is PaneTab => tab !== null);
    const tabCount = Math.max(1, tabs.length);
    const active = typeof v.active === "number" && Number.isFinite(v.active)
      ? Math.max(0, Math.min(Math.floor(v.active), tabCount - 1))
      : 0;
    return { type: "pane", tabs, active };
  }
  if (v.type === "split") {
    if (v.dir !== "h" && v.dir !== "v") return null;
    const kids = Array.isArray(v.children) ? v.children : [];
    if (kids.length !== 2) return null;
    const a = sanitizeLayoutNode(kids[0]);
    const b = sanitizeLayoutNode(kids[1]);
    if (!a || !b) return null;
    const ratio = typeof v.ratio === "number" && Number.isFinite(v.ratio)
      ? Math.max(0.05, Math.min(0.95, v.ratio))
      : 0.5;
    return { type: "split", dir: v.dir, ratio, children: [a, b] };
  }
  return null;
}

/** 校验并清洗前端提交的布局树；非法输入返回 null（空工作空间）。 */
export function sanitizeLayout(value: unknown): LayoutNode | null {
  return sanitizeLayoutNode(value);
}

function layoutHasTab(node: LayoutNode, tabId: string): boolean {
  if (node.type === "pane") return node.tabs.some((tab) => tab.id === tabId);
  return layoutHasTab(node.children[0], tabId) || layoutHasTab(node.children[1], tabId);
}

function firstLayoutTabId(node: LayoutNode): string | undefined {
  if (node.type === "pane") return node.tabs[node.active]?.id ?? node.tabs[0]?.id;
  return firstLayoutTabId(node.children[0]) ?? firstLayoutTabId(node.children[1]);
}

/** 校验任务级工作窗口集合；旧版单棵布局会兼容升级成一个 window。 */
export function sanitizeTaskLayout(value: unknown): TaskWindowLayout | null {
  const legacy = sanitizeLayoutNode(value);
  if (legacy) {
    return {
      type: "windows",
      windows: [{ id: "window-legacy", layout: legacy, activeTabId: firstLayoutTabId(legacy) }],
      activeWindowId: "window-legacy",
    };
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "windows" || !Array.isArray(record.windows)) return null;
  const used = new Set<string>();
  const windows = record.windows.slice(0, 128).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const window = candidate as Record<string, unknown>;
    const id = typeof window.id === "string" ? window.id.trim().slice(0, 160) : "";
    const layout = sanitizeLayoutNode(window.layout);
    if (!id || used.has(id) || !layout) return [];
    used.add(id);
    const requestedActive = typeof window.activeTabId === "string" ? window.activeTabId : undefined;
    const activeTabId = requestedActive && layoutHasTab(layout, requestedActive)
      ? requestedActive
      : firstLayoutTabId(layout);
    return [{ id, layout, ...(activeTabId ? { activeTabId } : {}) }];
  });
  const requestedWindow = typeof record.activeWindowId === "string" ? record.activeWindowId : null;
  const activeWindowId = windows.some((window) => window.id === requestedWindow)
    ? requestedWindow
    : windows[0]?.id ?? null;
  return { type: "windows", windows, activeWindowId };
}

/**
 * Workspace（多标签 / 分屏项目）REST 路由。
 *
 * 设计要点：
 * - POST 只建项目实体，**不启动任何会话**；会话由工作空间内「+」标签按需创建并绑定 workspaceId。
 * - 布局树由前端 allotment 构造，PUT 时经 sanitizeLayout 校验/规整后落库。
 */
export function registerWorkspaceRoutes(
  app: Express,
  storage: WandStorage,
  sessions?: SessionRegistry,
): void {
  // 列出所有项目（按最近打开排序）
  app.get("/api/workspaces", (_req, res) => {
    backfillSessionWorkspaces(storage);
    const sessionCounts = storage.countSessionsByWorkspace();
    res.json(storage.listWorkspaces().map((workspace) => workspaceWithCounts(storage, workspace, sessionCounts)));
  });

  // 新建项目：名称 + 目录 + 默认 IDE，不启动会话
  app.post("/api/workspaces", asyncRoute(async (req, res) => {
    const body = req.body as { name?: unknown; cwd?: unknown; defaultProvider?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      res.status(400).json({ error: "请输入项目名称。" });
      return;
    }
    let cwd: string;
    try {
      cwd = resolveWorkspaceCwd(body.cwd);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "目录无效。") });
      return;
    }
    const defaultProvider = parseDefaultProvider(body.defaultProvider);
    const workspace = storage.createWorkspace({ name, cwd, defaultProvider });
    const attached = attachUnboundSessionsToWorkspace(storage, workspace);
    res.status(201).json({ ...workspace, worktreeCount: 0, sessionCount: attached });
  }));

  // 项目详情：meta + 会话 + 布局；访问即更新 lastOpenedAt
  app.get("/api/workspaces/:id", (req, res) => {
    const workspace = storage.getWorkspace(req.params.id);
    if (!workspace) {
      res.status(404).json({ error: "未找到该项目。" });
      return;
    }
    storage.touchWorkspace(workspace.id);
    res.json({
      ...workspaceWithCounts(storage, workspace),
      sessions: storage.listSessionsByWorkspace(workspace.id).map((session) => ({
        ...session,
        title: workspaceSessionTitle(session, { workspaceName: workspace.name }),
      })),
    });
  });

  // 改名 / 目录 / 默认 IDE
  app.patch("/api/workspaces/:id", (req, res) => {
    const existing = storage.getWorkspace(req.params.id);
    if (!existing) {
      res.status(404).json({ error: "未找到该项目。" });
      return;
    }
    const body = req.body as { name?: unknown; cwd?: unknown; defaultProvider?: unknown };
    const patch: { name?: string; cwd?: string; defaultProvider?: WorkspaceDefaultProvider | null } = {};
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
    if (body.cwd !== undefined) {
      try {
        patch.cwd = resolveWorkspaceCwd(body.cwd);
      } catch (error) {
        res.status(400).json({ error: getErrorMessage(error, "目录无效。") });
        return;
      }
    }
    if (body.defaultProvider === null) {
      patch.defaultProvider = null;
    } else if (body.defaultProvider !== undefined) {
      const parsed = parseDefaultProvider(body.defaultProvider);
      if (parsed) patch.defaultProvider = parsed;
    }
    storage.updateWorkspace(existing.id, patch);
    const updated = storage.getWorkspace(existing.id);
    res.json(updated ? workspaceWithCounts(storage, updated) : null);
  });

  // 删除项目；cascade=true 连带删会话，否则仅解绑
  app.delete("/api/workspaces/:id", (req, res) => {
    const cascade = req.query.cascade === "1" || req.query.cascade === "true";
    const existing = storage.getWorkspace(req.params.id);
    if (!existing) {
      res.status(404).json({ error: "未找到该项目。" });
      return;
    }
    const tasks = storage.listWorkspaceTasks(existing.id);
    if (cascade) {
      deleteSessions(storage, sessions, [
        ...storage.listSessionsByWorkspace(existing.id).map((session) => session.id),
        ...tasks.flatMap((task) => storage.listSessionsByWorkspaceTask(task.id).map((session) => session.id)),
      ]);
    } else {
      // 非级联删除可以保留项目根目录里的会话，但隔离任务的 cwd 会随
      // worktree 一起消失，因此必须删除这些会话，不能留下僵尸记录。
      deleteSessions(storage, sessions, tasks.flatMap((task) => task.worktree
        ? storage.listSessionsByWorkspaceTask(task.id).map((session) => session.id)
        : []));
    }
    for (const task of tasks) {
      if (cascade || task.worktree) cleanupWorktreeSync(task.worktree);
    }
    storage.deleteWorkspace(existing.id, { cascade });
    res.json({ ok: true });
  });

  // 保存布局树（标签 + 分屏）
  app.put("/api/workspaces/:id/layout", (req, res) => {
    const existing = storage.getWorkspace(req.params.id);
    if (!existing) {
      res.status(404).json({ error: "未找到该项目。" });
      return;
    }
    const body = req.body as { layout?: unknown };
    const layout = sanitizeLayout(body === null || typeof body !== "object" ? undefined : body.layout);
    storage.saveWorkspaceLayout(existing.id, layout);
    res.json({ ok: true, layout });
  });

  // ── 任务（Task = 命名 + 独立 worktree + 一组标签）──

  // 目录组为一级容器的任务聚合列表，供侧栏「任务」视图一次拉全。
  app.get("/api/tasks", (req, res) => {
    // 查询参数：workspaceId 过滤单目录；limit 截断每目录任务数；
    // maxSessions 截断每任务内嵌会话数（大数据量时控制响应体积）。
    const workspaceFilter = typeof req.query.workspaceId === "string" ? req.query.workspaceId : "";
    const parseBoundedCount = (raw: unknown): number | null => {
      const value = Number(raw);
      return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 500) : null;
    };
    const taskLimit = parseBoundedCount(req.query.limit);
    const sessionLimit = parseBoundedCount(req.query.maxSessions);
    backfillSessionWorkspaces(storage);
    const workspaces = storage.listWorkspaces();
    // 目录组为一级容器：任务归属目录；未绑定任务的会话以 standaloneSessions
    // 归入所在目录的组（含无项目的合成组），保证没有会话在任务视图里失联。
    interface TaskDirectoryGroup {
      workspaceId: string;
      workspaceName: string;
      workspaceCwd: string;
      synthetic?: boolean;
      tasks: unknown[];
      standaloneSessions: unknown[];
    }
    const summarize = (session: SessionSnapshot, names: { taskName?: string; workspaceName?: string } = {}) => ({
      id: session.id,
      provider: session.provider,
      sessionKind: session.sessionKind,
      runner: session.runner,
      command: session.command,
      title: workspaceSessionTitle(session, names),
      status: session.status,
      cwd: session.cwd,
      startedAt: session.startedAt,
    });
    const visibleWorkspaces = workspaceFilter
      ? workspaces.filter((workspace) => workspace.id === workspaceFilter)
      : workspaces;
    const groups = new Map<string, TaskDirectoryGroup>();
    for (const workspace of visibleWorkspaces) {
      groups.set(workspace.id, {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspaceCwd: workspace.cwd,
        tasks: storage.listWorkspaceTasks(workspace.id)
          .slice(0, taskLimit ?? undefined)
          .map((task) => {
            const allSessions = storage.listSessionsByWorkspaceTask(task.id);
            const sessions = allSessions
              .slice(0, sessionLimit ?? undefined)
              .map((session) => ({
                ...summarize(session, { taskName: task.name, workspaceName: workspace.name }),
                workspaceTaskId: task.id,
              }));
            return {
              ...task,
              cwd: task.worktree?.path ?? workspace.cwd,
              isolated: task.worktree !== null,
              sessions,
              totalSessions: allSessions.length,
            };
          }),
        standaloneSessions: [],
      });
    }
    const taskBoundSessionIds = new Set<string>();
    for (const workspace of workspaces) {
      for (const task of storage.listWorkspaceTasks(workspace.id)) {
        for (const session of storage.listSessionsByWorkspaceTask(task.id)) taskBoundSessionIds.add(session.id);
      }
    }
    for (const session of storage.loadSessions()) {
      if (taskBoundSessionIds.has(session.id)) continue;
      const direct = session.workspaceId ? groups.get(session.workspaceId) : undefined;
      let group = direct && !direct.synthetic ? direct : undefined;
      const resolved = session.cwd ? path.resolve(session.cwd) : "";
      if (!group && resolved) {
        group = [...groups.values()].find((candidate) => !candidate.synthetic && candidate.workspaceCwd === resolved);
      }
      // 过滤模式下不创建合成组：不属于目标目录的会话直接排除。
      if (!group && resolved && !workspaceFilter) {
        const id = `cwd:${resolved}`;
        let synthetic = groups.get(id);
        if (!synthetic) {
          synthetic = {
            workspaceId: id,
            workspaceName: resolved.split("/").filter(Boolean).at(-1) || resolved,
            workspaceCwd: resolved,
            synthetic: true,
            tasks: [],
            standaloneSessions: [],
          };
          groups.set(id, synthetic);
        }
        group = synthetic;
      }
      // workspaceId 过滤时，不属于目标目录组的会话直接排除（含合成组）。
      if (workspaceFilter && group?.workspaceId !== workspaceFilter) continue;
      group?.standaloneSessions.push(summarize(session, {
        workspaceName: group.workspaceName,
      }));
    }
    res.json([...groups.values()]);
  });

  // 列出某工作空间下的任务
  app.get("/api/workspaces/:id/tasks", (req, res) => {
    const workspace = storage.getWorkspace(req.params.id);
    if (!workspace) {
      res.status(404).json({ error: "未找到该项目。" });
      return;
    }
    res.json(storage.listWorkspaceTasks(workspace.id));
  });

  // 项目级 Worktree 总览：一次解析默认目标分支，再为每个任务读取可合并状态。
  app.get("/api/workspaces/:id/worktrees", asyncRoute(async (req, res) => {
    const workspace = storage.getWorkspace(req.params.id);
    if (!workspace) {
      res.status(404).json({ error: "未找到该项目。" });
      return;
    }
    const tasks = storage.listWorkspaceTasks(workspace.id).filter((task) => task.worktree !== null);
    if (tasks.length === 0) {
      res.json({ workspaceId: workspace.id, repoRoot: workspace.cwd, targetBranch: "", worktrees: [] });
      return;
    }

    let target: Awaited<ReturnType<typeof resolveWorktreeTargetBranchAsync>>;
    try {
      target = await resolveWorktreeTargetBranchAsync(workspace.cwd);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法识别项目默认分支。") });
      return;
    }

    const worktrees = await Promise.all(tasks.map(async (task) => {
      const worktree = task.worktree as WorkspaceTaskWorktree;
      try {
        const inspection = await checkSessionWorktreeMergeabilityAsync({
          worktree,
          targetBranch: target.targetBranch,
        });
        const actionable = inspection.hasUncommittedChanges || inspection.aheadCount > 0;
        const state = inspection.hasUncommittedChanges
          ? "dirty"
          : inspection.hasConflicts
            ? "conflict"
            : inspection.aheadCount > 0
              ? "ready"
              : "empty";
        return {
          taskId: task.id,
          taskName: task.name,
          taskStatus: task.status,
          branch: worktree.branch,
          path: worktree.path,
          baseRef: worktree.baseRef ?? "",
          state,
          actionable,
          reason: inspection.reason ?? "",
          aheadCount: inspection.aheadCount,
          hasUncommittedChanges: inspection.hasUncommittedChanges,
          hasConflicts: inspection.hasConflicts,
          commits: inspection.commits,
        };
      } catch (error) {
        return {
          taskId: task.id,
          taskName: task.name,
          taskStatus: task.status,
          branch: worktree.branch,
          path: worktree.path,
          baseRef: worktree.baseRef ?? "",
          state: "unavailable",
          actionable: false,
          reason: getErrorMessage(error, "无法读取 Worktree 状态。"),
          aheadCount: 0,
          hasUncommittedChanges: false,
          hasConflicts: false,
          commits: [],
        };
      }
    }));

    res.json({
      workspaceId: workspace.id,
      repoRoot: target.repoRoot,
      targetBranch: target.targetBranch,
      worktrees,
    });
  }));

  // 新建任务：命名 + 可选独立 worktree（默认尝试创建，非 git 仓库时退化为直接用项目目录；
  // 显式传 worktree:false 时跳过隔离，会话直接跑在项目目录）。
  app.post("/api/workspaces/:id/tasks", asyncRoute(async (req, res) => {
    const workspace = storage.getWorkspace(req.params.id);
    if (!workspace) {
      res.status(404).json({ error: "未找到该项目。" });
      return;
    }
    const body = req.body as { name?: unknown; baseRef?: unknown; worktree?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      res.status(400).json({ error: "请输入任务名称。" });
      return;
    }
    const baseRef = typeof body.baseRef === "string" && body.baseRef.trim() ? body.baseRef.trim() : undefined;
    const wantWorktree = body.worktree !== false;
    let worktree: WorkspaceTaskWorktree | null = null;
    let worktreeError: string | undefined;
    if (wantWorktree) {
      try {
        const setup = prepareSessionWorktree({
          cwd: workspace.cwd,
          // 用随机短 id 作分支后缀，避免同名任务撞分支。
          sessionId: crypto.randomUUID(),
          spec: { taskName: name, baseRef },
        });
        worktree = setup.worktree;
      } catch (error) {
        // 非 git 仓库 / 基线不存在：任务照常创建，但无 worktree 隔离。
        worktreeError = getErrorMessage(error, "无法创建 worktree，将在项目目录直接运行。");
      }
    }
    const task = storage.createWorkspaceTask({ workspaceId: workspace.id, name, worktree });
    res.status(201).json({
      ...task,
      cwd: worktree?.path ?? workspace.cwd,
      isolated: worktree !== null,
      worktreeError,
    });
  }));

  // 任务详情：meta + 该任务下的会话；访问即更新 lastOpenedAt
  app.get("/api/workspace-tasks/:taskId", (req, res) => {
    const task = storage.getWorkspaceTask(req.params.taskId);
    if (!task) {
      res.status(404).json({ error: "未找到该任务。" });
      return;
    }
    storage.touchWorkspaceTask(task.id);
    const workspace = storage.getWorkspace(task.workspaceId);
    res.json({
      ...task,
      cwd: task.worktree?.path ?? workspace?.cwd ?? "",
      sessions: storage.listSessionsByWorkspaceTask(task.id).map((session) => ({
        ...session,
        title: workspaceSessionTitle(session, {
          taskName: task.name,
          workspaceName: workspace?.name,
        }),
      })),
    });
  });

  // 改名 / 状态
  app.patch("/api/workspace-tasks/:taskId", (req, res) => {
    const existing = storage.getWorkspaceTask(req.params.taskId);
    if (!existing) {
      res.status(404).json({ error: "未找到该任务。" });
      return;
    }
    const body = req.body as { name?: unknown; status?: unknown };
    const patch: { name?: string; status?: "active" | "done" } = {};
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
    if (body.status === "active" || body.status === "done") patch.status = body.status;
    storage.updateWorkspaceTask(existing.id, patch);
    res.json(storage.getWorkspaceTask(existing.id));
  });

  // 删除任务；cascade=true 连带删会话，否则仅解绑；尽力清理 worktree
  app.delete("/api/workspace-tasks/:taskId", (req, res) => {
    const existing = storage.getWorkspaceTask(req.params.taskId);
    if (!existing) {
      res.status(404).json({ error: "未找到该任务。" });
      return;
    }
    // 删除隔离任务必然会移除其 cwd，因此即使调用方没有显式传 cascade，
    // 也必须同步删除会话；非隔离任务仍保留旧的“默认解绑”API 语义。
    const cascade = req.query.cascade === "1"
      || req.query.cascade === "true"
      || existing.worktree !== null;
    if (cascade) {
      deleteSessions(
        storage,
        sessions,
        storage.listSessionsByWorkspaceTask(existing.id).map((session) => session.id),
      );
    }
    // 尽力清理 worktree 与分支；失败不阻塞删除任务行。
    if (cascade) cleanupWorktreeSync(existing.worktree);
    storage.deleteWorkspaceTask(existing.id, { cascade });
    res.json({ ok: true });
  });

  // 保存任务的标签 / 分屏布局
  app.put("/api/workspace-tasks/:taskId/layout", (req, res) => {
    const existing = storage.getWorkspaceTask(req.params.taskId);
    if (!existing) {
      res.status(404).json({ error: "未找到该任务。" });
      return;
    }
    const body = req.body as { layout?: unknown };
    const layout = sanitizeTaskLayout(body === null || typeof body !== "object" ? undefined : body.layout);
    storage.saveWorkspaceTaskLayout(existing.id, layout);
    res.json({ ok: true, layout });
  });
}
