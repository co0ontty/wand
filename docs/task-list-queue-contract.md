# 任务列表快照

四端列表只读这一次版本化快照，不再分别刷新正式任务列表和目录聚合：

`GET /api/tasks?includeArchived=1&revision=`

revision 覆盖存储投影和当时的会话运行快照。数据变了才会整页返回；未变时 `unchanged: true`，`groups` 和 `tasks` 都是空数组，调用方保留上一份。

完整响应：

| 字段 | 内容 |
| --- | --- |
| `revision` | 这一次快照的版本 |
| `tasks` | 正式任务，顺序与旧 `GET /api/wand-tasks` 相同：排队数、负责人、执行状态、父子层级 |
| `groups` | 工作区目录、执行容器、关联会话，以及 `standaloneSessions` 未分组会话 |

两组数据来自同一次 `TaskReadModel`。底层仍分开：`wand_tasks` 是任务元数据，`workspace_tasks` 是 cwd/worktree/layout，`command_sessions.workspace_task_id` 是当前会话归属。这个接口只读，不回写、不补归属、不同步全表。

`limit` / `maxSessions` 只截目录组，给旧的控体积调用留着。正式任务不截断，避免无会话的排队任务被截掉。四端列表不要带这两个参数。工作区、员工、搜索、业务阶段和归档展示都在客户端投影；服务端不按员工过滤列表。归档范围用 `includeArchived=1` 取全量，各端再投影自己的活动范围。

## 谁读取

| 端 | 数据所有者 |
| --- | --- |
| Web | `HttpWorkspacesRepository.listTaskGroups`；看板 `loadTaskBoardList` 使用同一 revision |
| macOS | `WandAPI.listTaskGroupsPage` / `listBoardTasks` |
| iOS | 同上；任务看板和未分组会话用同一次页面，并写回 `WorkspaceStore` |
| Android | `WandApi.listTaskGroupsPage`；任务看板不再另打正式任务列表 |

旧服务端信封没有 `tasks` 时，正式任务回退 `GET /api/wand-tasks`。新服务端不依赖这条回退。

## 旧列表什么时候才能删

已安装的旧客户端仍把 `GET /api/wand-tasks` 解成数组，把不带 `revision` 的 `GET /api/tasks` 解成目录组数组。这两条列表读取都保留。

只有同时满足下面两条，才可以删掉纯列表读取：

1. 当前安装包里的 Web，以及更新接口提供的 macOS / iOS / Android，都不再调用它们。
2. 明确不再支持比这些包更老、仍会调用它们的已安装客户端。

不删 `POST /api/tasks`、`POST` / `PATCH` / `DELETE /api/wand-tasks`、`GET /api/wand-tasks/:id`、评论、派发、会话绑定和团队运行。详情和变更不是列表。

## 排队展示

无会话的排队任务在 `tasks` 里仍有 `queuedCommentCount` / `executionStatus`，在目录组里有 `queuedDispatchCount` 和 `boardTaskId`。点击用 `boardTaskId` 或正式任务 id 打开原任务，不造会话。

历史样本 `output/queued-sidebar/live-api.json` 的 44 条队列不是当前验收数字。Web 的 executionQueue 是子任务卡片选项，不是服务端排队参数。

iOS / Android 任务看板保留「排队任务」分组：非归档、执行状态为排队或排队计数大于零的任务，包括没有会话的子任务。已在排队分组里的根任务不重复进普通分组。同一任务正在运行且另有派发排队时，卡片仍显示运行。
