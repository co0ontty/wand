# 任务管理（Wand 原生）

「任务管理」是 Wand 自己的原生面板（原「议题看板」），**不再嵌入外部 Codex Taskboard**。历史版本曾
通过 `src/taskboard-bridge.ts` 拉起一个回环子服务并用 iframe 展示
`vendor/codex-taskboard`；那条链路已整体移除。

## 现状

- 数据真源是 Wand SQLite 的 `wand_tasks` / `wand_task_sessions`（见 `src/storage.ts`）。
- 前端是 `src/web-ui/react/issues/`：`task-board-host.tsx`（原生 React 面板）、
  `task-board-repository.ts`（`/api/wand-tasks*`）、`task-board-agent.ts`（CLI 工具、
  模型目录、分组排序等纯逻辑）、`task-board-controller.ts`（打开状态）。
- 服务端是 `src/server-task-routes.ts`，挂在 `/api/wand-tasks`，登录即可（与 Missions 相同，不要求 admin）。
- 看板「归档」不会删行，只把状态标成 `done`；侧栏手动新建的工作任务若还没有看板卡片，会按项目/任务名自动补一张并填好标题、项目与目录。
- 打开看板走独立路由 `?view=taskboard`（旧 `?view=issues` 仍识别），绝对定位盖在主内容区上面，不再是浮层 iframe，也不再卸载 `#output` 等终端槽位。打开时 CSS 隐藏会话顶栏、标签栏和输入框，避免它们被 flex 顶到看板上方。侧栏点任务/会话、看板「返回」、浏览器后退都会离开看板。原生客户端走同一套 API。

## 任务 → 项目目录

任务可绑定一个 Wand 项目（`wand_tasks.workspace_id`，`ON DELETE SET NULL`）：

- 未指定项目时 `workspaceId = null`，派发 Agent 会落到 `config.defaultCwd`。
- 指定项目后，列表 DTO 带上 `workspace: { id, name, cwd }`，卡片显示项目名。
- 删除项目时任务自动回到「未指定项目」，不会留下悬空引用。

## 任务 → CLI 工具与派发

任务可以预设「CLI 工具 + 模型 + 思考深度」（`wand_tasks.agent_json`）：

- 可选 Claude / Codex / OpenCode / Grok / Qoder / Pi；模型下拉来自 `/api/models`，
  按 provider 过滤，并始终保留一项「跟随服务端默认」。
- `POST /api/wand-tasks/:id/dispatch` 用该配置创建结构化 Wand 会话，cwd 取任务项目
  目录，把任务标题 + 描述作为首个 prompt 发出，并把会话绑定回该任务
  （`wand_task_sessions`）。派发成功后任务自动从 `todo` 推进到 `doing`。
- 卡片上会列出已绑定会话（provider + 模型），点击即可跳到该会话。

## 与其它「任务」实体的关系

Wand 仍有四套并存的实体，见 `docs/server-logic-analysis.md` §9。任务管理只负责
WandTask；它不会自动变成 WorkspaceTask 或 Mission attempt，状态也不互相同步。
侧栏「任务」仍是 WorkspaceTask（会话容器），底部「任务管理」是看板。

## 界面约定

原生看板的布局与交互对标 `https://github.com/chuspeeism/dashi-taskboard`：
44px 顶栏（项目切换 / 看板·列表 / 搜索 / 显示设置）、彩色列头、列内「+」新建、
卡片拖拽换列、点击进入全页详情。指派 Agent 仍只属于单条任务。
