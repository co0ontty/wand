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

## 标题可选（留空自动生成）

`wand_tasks.title` 在 API 层是**可选**字段；`title_source` 记录标题来源（`user` / `auto`，只加列，历史行读取时视为 `user`）。

- `POST /api/wand-tasks` 只要 `title` 或 `description` 有一个非空即可：
  - 给了 `title` → `titleSource = "user"`，永远不再被生成器覆盖。
  - 没给 `title` → 先用描述首个有意义的行占位（`provisionalTaskTitleFromDescription`），
    同时 `titleSource = "auto"`，响应**立即返回**，不等模型。
- 服务端随后在后台用描述总结一个标题（`src/task-title.ts` → `generateWandTaskTitle`），
  AI 来源与其它会话周边 AI 动作一致（`resolveSystemAiContext`：默认 provider + 默认模型，
  直连 API 可用时优先）。多次建任务会排队而不是丢弃。
- 写入前会检查 `titleSource` 仍是 `auto`，用户自己改过标题就不覆盖；`PATCH` 带 `title`
  一律把来源标回 `user`。模型返回 provider 报错文案、整段解释或多句文字时拒绝落库，
  保留占位标题，只打一条服务端日志。
- 客户端因此**创建后需要再刷新一次**：Web 用 `taskBoardRepository.get()` 短轮询，
  Android 用 `getBoardTask`，iOS/macOS 用 `getBoardTask`，超时就保留占位标题。

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
44px 顶栏（项目切换 / 仪表盘·议题看板·列表·甘特图 / 搜索 / 筛选 / 显示设置）、
彩色列头与状态图标、列内「+」新建、卡片拖拽换列、处理中光泽与会话气泡、
点击进入全页详情。指派 Agent（CLI 工具 / 模型 / 思考深度）仍只属于单条任务。

新建任务对话框里**标题是可选字段**：标签写「任务标题」+「可选」徽标，输入框比描述框小
（Web 端 14px / 单行，不再是与描述争视觉重量的 18px 大标题），占位文案说明「留空按描述
自动生成」。标题与描述同时为空时不能提交。
