# Task 1：工作空间 + 任务 + 标签 + 无级分屏 UI

> 参考 [Orca（stablyai/orca）](https://github.com/stablyai/orca)，把 wand 的 React shell 从「单活动会话」升级为「项目 → 任务 → 标签 → 无级分屏」模型。
>
- **计划文件**：`/Users/co0ontty/.claude/plans/wondrous-pondering-ladybug.md`
- **状态**：P0 / P1 / P2 已交付并完成浏览器验收；顶部改为 VS Code 风格任务/文件标签，侧栏入口收敛为「会话 / 项目」。HTML5 标签拖放受自动化输入限制，布局移动纯函数已有回归测试覆盖。
- **日期**：2026-08-09

---

## 一、任务要求

### 1.1 三层数据模型

```
Workspace（工作区 = 项目目录，如 wand）
  └── Task（任务：命名 + 独立 git worktree 隔离，侧栏列表单独展示）
        ├── 标签页（session / IDE）
        ├── 标签页（terminal）
        └── 标签页（editor / preview）
```

- **新建项目** = 起名 + 选默认 IDE，**不自动启动任何会话**。
- **工作区内新增任务**，新建任务时**必须重命名**。
- 每个任务**独占一个 git worktree**（`prepareSessionWorktree`），任务下所有会话共享该 worktree 目录；非 git 目录时退化为直接用项目目录运行（`worktree=null, isolated=false, worktreeError`）。

### 1.2 关键能力

- 项目/任务的 CRUD + 布局持久化（标签/分屏布局 `LayoutNode` 挂在 **Task** 上）。
- 创建会话时绑定 `workspaceId` / `workspaceTaskId`，会话归属到任务。
- 主区「工作空间窗口」：顶部标签栏 + 内容区；标签可切换。
- **无级分屏**：任意已分屏处可再上下/左右拆分，递归嵌套；分隔条可拖拽调比例并持久化。
- **标签拖拽**：跨窗格移动；窗格可新建/关闭。
- v1 只做**窗内分屏**，撕出独立浮窗留 v2。

### 1.3 技术约束（来自 CLAUDE.md）

- 2 空格缩进、双引号、分号；`node:` 前缀内置模块；加列式迁移只加不删。
- 资产管线：`browser/*.ts` → `bundle-browser.js`(esbuild) → `content/scripts.js`（生成，禁手改）→ `generate-web-assets.js` → `embedded-assets.ts`（生成，禁手改）。`content/styles.css` 是手编源。
- React 模块用 external store + `useSyncExternalStore`；`configureXxxRuntime(adapter)`；host 读 `xxxStore.getRuntime()`。
- 终端单例 `state.terminal` 切换时销毁重建，分屏要求 N 个 session 标签同时各有**活的**终端实例。

### 1.4 已确认的架构决策

- 走现有 `reactShell` localStorage flag 增量上线（React shell 默认 ON）。
- 项目锚定一个目录（Orca 风格）。
- 终端从单例改成**每标签一实例**池化（ws 已支持多并发 subscribe）；无分屏时活动标签复用全局终端。
- **分屏引擎**：plan 原定 allotment，**实际改为自研递归分屏**（见下「P2 偏离说明」）。

---

## 二、交付总结

### P0：后端（✅ 完成）

| 项 | 落地 |
|----|------|
| `workspaces` 表 | `src/storage.ts` 加列式迁移：`workspaces(id,name,cwd,default_provider,layout_json,created_at,last_opened_at)` |
| `workspace_tasks` 表 | `id/workspace_id/name/worktree_json/layout_json/status/created_at/last_opened_at` + `command_sessions.workspace_task_id` 加列 |
| 类型 | `src/types.ts`：`Workspace/LayoutNode/PaneTab`、`WorkspaceTask/WorkspaceTaskWorktree/WorkspaceTaskStatus`、`SessionSnapshot.workspaceId/workspaceTaskId`、`CommandRequest.workspaceId/workspaceTaskId` |
| storage CRUD | listWorkspaces / getWorkspace / createWorkspace / updateWorkspace / deleteWorkspace / saveWorkspaceLayout；listWorkspaceTasks / getWorkspaceTask / createWorkspaceTask / updateWorkspaceTask / saveWorkspaceTaskLayout / touchWorkspaceTask / deleteWorkspaceTask / listSessionsByWorkspaceTask / setSessionWorkspaceTaskId |
| REST | `src/server-workspace-routes.ts`（`registerWorkspaceRoutes`）：`GET/POST /api/workspaces`、`GET/PATCH/DELETE /api/workspaces/:id`、`PUT /api/workspaces/:id/layout`、`POST/GET /api/workspaces/:id/tasks`、`GET/PATCH/DELETE /api/workspace-tasks/:taskId`、`PUT /api/workspace-tasks/:taskId/layout`。POST 任务调 `prepareSessionWorktree` 建独立 worktree；删除隔离任务时先终止并删除绑定会话，再尽力 `git worktree remove --force` + `branch -D`，避免留下 cwd 已失效的僵尸会话。路径校验复用 `middleware/path-safety.ts` |
| 会话透传 | `/api/commands`、`/api/structured-sessions` → ProcessManager.start/startShell、StructuredSessionManager.createSession 透传 workspaceId/workspaceTaskId |

**坑**：`prepareSessionWorktree` 返回的 `WorktreeInfo.baseRef/repoRoot` 是 optional，清理 worktree 时要判 `repoRoot` 非空；`saveSession` VALUES 现为 **33** 个 `?`。

### P1：工作空间窗口 + 标签（单窗格）（✅ 完成）

- **新建项目对话框**（workspace 层）：`src/web-ui/react/workspaces/{types,repository,controller,host}.tsx` + `src/web-ui/browser/workspaces-adapter.ts`（installRuntime：effectiveCwd / openWorkspace / openTask / toast）。挂 overlay-host；动作 `workspace.new`/`workspace.newAt`；react-overlay-coordinator 注册 `"workspaces"`。
- **侧栏「项目」面板** `workspaces-panel.tsx`：列项目 → 展开看任务；每项目「新任务」内联新建任务（重命名）→ POST task 建 worktree → 自动打开；任务行带 隔离/共享 徽章 + 打开 + 删除（二次确认）；项目删除（二次确认）。`useWorkspaces`/`useWorkspaceTasks` 轮询。
- **打开任务** → `workspaces-adapter.openTask` 设 `state.activeWorkspaceId/TaskId` + `startSessionInCwd(cwd,{workspaceId,workspaceTaskId,provider})`（session-engine.ts 新增，镜像 quickStartSession）在任务 worktree 启动绑定会话。
- **侧栏接入** `shell-sidebar.tsx`：顶部只保留「会话 / 项目」两个 view mode；项目模式渲染 `<WorkspacesPanel/>`，footer「项目」按钮触发 `workspace.new`。
- **主区标签栏** `<WorkspaceTabBar/>`（`workspace-tab-bar.tsx`）：`shell-main-content.tsx` 在 ShellTopbar 后渲染；无活动任务返回 null（SSR/reactShell=0 兜底安全）。订阅 context store + ui 快照(selected.id)；轮询 `getTask(taskId)` 拿 `detail.sessions`；点标签 = `session.select`（既有全局终端重指向，**无需终端池**）；「+」= newTaskSession；「×」= clearActiveWorkspaceContext + nav.home。
- **活动上下文外部 store** `workspace-context.ts`（`workspaceContextStore` + setActive/clear）——**刻意独立于 UiSnapshotData 契约**，避免给快照加字段牵动测试 fixture。
- `browser/types.ts` + `state.ts` 加 `activeWorkspaceTaskId`。
- **关键降风险**：P1 单窗格复用全局终端槽位，**不做终端池**（终端池只在 P2 多终端同时可见时才必需）。
- 样式：`styles.css` 末尾「工作空间 / 任务 面板」+「顶部标签栏」段（实际主题是**浅色奶白** + CSS 变量 `--bg-elevated/--accent/--border-subtle` 等，非深色）。

### P2：无级分屏 + 拖拽 + 终端池（✅ 完成）

> **偏离说明**：plan 原定 allotment 做递归分屏。allotment 要 CSS 打包集成、盲改不可测，故**改为自研递归分屏**：`split 节点 = 两子 + 可拖 sash（pointer 事件，松手回写 ratio）+ path 寻址`，零新依赖、自包含，用户侧效果等价。

**布局树纯函数** `src/web-ui/react/workspaces/layout-tree.ts`（全不可变）：
- `emptyLayout` / `wrapInSplit` / `splitPane` / `addTab` / `activateTab` / `removeTab`（+ 折叠空窗格 + 重 clamp active）/ `moveTab`
- **path 版**（供渲染器 DnD / sash）：`splitPaneAtPath` / `setRatioAtPath` / `addTabAtPath`（path = 每层 split 取左 0 / 右 1 的 number[]）

**递归渲染器** `src/web-ui/react/workspaces/workspace-window.tsx`：
- `LayoutRenderer` → `SplitNode`（可拖 sash + 本地 ratio 态 + `setRatioAtPath` pointerup 回写）/ `PaneNode`（标签条 + 拖放落区 + 新建/分屏按钮）/ `SessionPane`（useEffect 挂池终端，cleanup 卸载）
- 轮询 `getTask(taskId)` 拿会话标题/provider 给标签显示
- 退出分屏 unmount 时清池

**终端池** `src/web-ui/browser/terminal-pool.ts`（与 `state.terminal` 单例**完全隔离**）：
- 每会话一个 `XTermLib.Terminal`（深色主题 / 字体读 `--term-font-family`），挂到窗格容器，回放 `state.sessions[].output`，按 sessionId 自路由 input/resize/output
- `websocket.ts` 单例分支加 `!hasPooledTerminal()` 守卫 + 新增池分支（chunk → `writePooledTerminal` / 全量 → `replacePooledTerminalOutput` / else ack）
- **`writePooledTerminal` / `replacePooledTerminalOutput` 额外维护 `state.sessions[].output`（用 `clampClientTerminalOutput`）**，保证切换标签 remount 回放不丢字
- 导出：`createPooledTerminal` / `writePooledTerminal` / `replacePooledTerminalOutput` / `fitPooledTerminal` / `focusPooledTerminal` / `disposePooledTerminal` / `disposeAllPooledTerminals` / `hasPooledTerminal` / `getPooledTerminal`

**runtime adapter** `workspaces-adapter.ts`：
- `enterTaskSplit`（当前会话包单 pane + 空 pane → saveTaskLayout）
- `saveTaskLayout`（写 context + PUT 持久化）
- `exitTaskSplit`（清池 + `syncTerminalBuffer(selectedId, session.output, {mode:"replace"})` 重置单例，避免退出后单例停在分屏前旧画面）
- `mountSessionTerminal` / `unmountSessionTerminal` / `disposeAllSessionTerminals`
- **`newTaskSession` 改为 resolve 出 `state.selectedId`**（供窗格「+」建会话后建 tab）

**标签栏 + shell 接入**：
- 标签栏加「分屏」按钮（仅当有会话时显示）→ `enterTaskSplit`
- `shell-main-content.tsx`：`context.layout?.type === "split"` 时渲染 `<WorkspaceWindow/>` 并用 `.main-content-in-split` 隐藏 `#output` / `#chat-output` / `#blank-chat` / `.input-panel` / 标签栏（`#output` 仍挂 DOM，单例终端实例不销毁，退出分屏重置即可恢复）

**DnD 语义（MVE）**：
- 拖标签落到另一窗格**中心** = `moveTab`（移动入栈）
- 窗格「⇆ / ⇅」按钮 = `splitPaneAtPath`（**按钮分屏**，替代 plan 的「拖到边缘分屏」——边缘 drop 与 removeTab 的空窗格折叠逻辑冲突，留作精修）
- sash 拖拽调比例并回写

**样式** `styles.css` 末尾「工作空间分屏窗口（P2）」段：浅色 token（header）+ 窗格深底对齐终端主题（`#1f1b17`）。

---

## 三、改动文件清单

**后端**
- `src/storage.ts`（workspaces / workspace_tasks 表 + 迁移 + 全 CRUD）
- `src/types.ts`（Workspace / LayoutNode / PaneTab / WorkspaceTask* / SessionSnapshot.workspace* / CommandRequest.workspace*）
- `src/server-workspace-routes.ts`（新）+ `src/server.ts`（挂载 + 创建会话透传）
- `src/server-session-routes.ts`、`src/process-manager.ts`、`src/structured-session-manager.ts`（透传 workspaceId）

**前端**
- `src/web-ui/react/workspaces/`：`types.ts` / `repository.ts` / `controller.ts` / `host.tsx` / `workspaces-panel.tsx` / `workspace-context.ts` / `workspace-tab-bar.tsx` / `layout-tree.ts`（新）/ `workspace-window.tsx`（新）
- `src/web-ui/react/shell/`：`shell-sidebar.tsx`（工作区 view + 面板）、`shell-main-content.tsx`（标签栏 + 分屏态切渲染）
- `src/web-ui/browser/`：`workspaces-adapter.ts`（runtime）、`session-engine.ts`（startSessionInCwd）、`terminal-pool.ts`（新）、`websocket.ts`（池路由 + 单例守卫）、`state.ts` + `types.ts`（activeWorkspaceTaskId）
- `src/web-ui/content/styles.css`（工作区 / 任务面板 + 标签栏 + 分屏窗口三段）

**生成文件（npm 脚本再生，禁手改）**：`src/web-ui/content/scripts.js`、`src/web-ui/embedded-assets.ts`

**测试**：`tests/server-workspace-routes.test.ts`、`tests/server-workspace-task-routes.test.ts`、`tests/web-ui-workspace.test.ts`（layout-tree 纯函数 15 例）

---

## 四、验收记录（全绿）

| 验证 | 结果 |
|------|------|
| `npm run check`（bundle + regenerate assets + tsc × 3 config） | ✅ 3 tsconfig 全过 |
| `npm run build` | ✅ 成功；dist/scripts.js 含 P2 标记（ws-pane-empty / 退出分屏 / pooled-terminal-wrap / workspace-window 共 10 处） |
| `npm test` | ⚠️ **439/440**；唯一失败为既有 zsh history 临时目录清理竞态 `ENOTEMPTY`，同一测试文件单独复跑 **6/6** 通过 |
| 服务端启动 | ✅ 隔离 server `http://127.0.0.1:8477` HTTP 200，shell 正常下发 |
| **后端分屏布局往返实测**（curl 真实 server） | ✅ PUT 嵌套 split 树（h-split 含嵌套 v-split + tabs）→ GET 完整保持（type/dir/ratio/嵌套/tabs 全对）→ PUT null 清空 |
| 浏览器视觉 QA | ✅ 实际创建项目/任务/多会话；确认顶部无重复标题栏、VS Code 风格会话与文件标签、侧栏仅「会话 / 项目」、新增任务即时进入填写态并可提交、分屏保持全部标签、池终端恢复正确、脏文件跨标签切换不丢稿。HTML5 DnD 由布局纯函数回归测试补充覆盖 |

**隔离测试 server / 数据**：验收结束后已停止并清理。

**修复的既有测试**：
- `shell-session-route.test.ts`（startShell options 现多带 `workspaceId/workspaceTaskId: undefined`）
- `web-ui-shell-chrome.test.ts:206`（shell-file-panel 的 `#file-explorer` div 不再自闭合）

---

## 五、浏览器 QA 步骤（已执行）

1. 打开 `http://127.0.0.1:8477`，用上方密码登录。
2. localStorage 设 `reactShell=1`（React shell 默认已 ON，可跳过）。
3. 侧栏切「工作区」→ 新建项目（名 + 目录 `/tmp/wand-dev/workspace` + 默认 IDE）→ 确认**不自动起会话**。
4. 项目下「+」新建任务（重命名）→ 确认建了独立 worktree（隔离徽章）。
5. 打开任务 → 自动起一个绑定会话 → 标签栏出现「分屏」按钮。
6. 点「分屏」→ 已确认两个窗格、sash、全部既有标签与空窗格同时存在；比例回写由 `setRatioAtPath` 回归测试覆盖。
7. 已确认窗格「⇆/⇅」、「+」与标签关闭控件；HTML5 标签拖放受浏览器自动化输入限制，跨窗格移动由 `moveTab` / `moveTabToPath` 回归测试覆盖。
8. 「退出分屏」→ 回单窗格，确认单例终端画面与历史一致。

---

## 六、留作精修（v1 之外的后续）

- **拖到边缘分屏**：plan 原文的四向边缘落区分屏，当前用按钮分屏代替（边缘 drop 与 removeTab 空窗格折叠逻辑冲突，需专门处理 path 失效）。
- **标签持久化与 layout 同步**：当前标签栏的会话来自 `getTask().sessions`（服务端绑定），与 layout 树里的 tab 是两套来源，分屏 tab 的增删已回写 layout，但二者的一致性边界可再收紧。
- 撕出独立浮窗（v2，plan 明确不做）。
