# iOS 接口审计（进行中）

以 `ios/Wand/` 的 URL 构造和调用点为入口，按功能归类；动态字符串、资源链接和 `/ws` 也计入。此表是源码定位和行为梳理，不表示所有入口均已在四端实机验收。用户数据、凭据和请求正文不记入报告。

| iOS 功能及接口 | 服务端入口与运行逻辑 | 跨端核对 |
| --- | --- | --- |
| 登录 `/api/login`、认证探测 `/api/session-check` | `server-auth-routes.ts`；校验身份并建立会话，探测认证状态。 | 公用认证接口；iOS 设置页还使用 `settings-web-access.ts` 的 `/api/settings/webview-session`，Android 同样使用。 |
| 配置、模型与设置 `/api/config`、`/api/models`、`/api/settings`、`/api/settings/config` | `server.ts` 和 `server-settings-routes.ts`；公开配置投影、模型目录及经授权的配置读写。 | Web、Android、macOS 使用相同资源；设置投影和权限有区别，不能简单视为重复。 |
| 客户端更新 `/api/ios-ipa-update`、服务更新 `/api/update` | `server-update-routes.ts`；客户端发行物与服务更新是不同生命周期。 | 平台更新包格式和签名不同，Android 与 macOS 分别有自己的发行端点。 |
| 推送 `/api/push/apns/subscription`、`/api/push/apns/live-activity` | `server-apns-routes.ts`；分别处理 APNs 通知和 Live Activity 订阅。 | iOS 平台能力，不能合并为普通会话消息接口。 |
| 客户端故障反馈 `/api/feedback/client` | `server-feedback-routes.ts`，受大小和速率约束。 | Web、Android、macOS 也使用该接口。 |
| WebSocket `/ws` | `server.ts` 的 WebSocket 服务及会话事件处理；会话状态和消息增量经此推送。 | 四端各有原生传输实现，不能与 HTTP 资源操作混为一条执行链。 |
| 会话列表 `/api/session-list`、`/api/sessions`、`/api/session-directories`、`/api/session-directories/name` | `server-session-list-routes.ts`；分页列表带 revision，完整托管会话列表与目录树各自投影。 | iOS 使用分页和完整列表；macOS 使用完整列表和分页 revision 探测，Android 使用完整列表。两种读取范围不同，不能删除其一。 |
| 会话创建、详情、消息、工具内容 `/api/sessions`、`/api/sessions/:id`、`/messages`、`/tool-content/:toolUseId` | `server-session-lifecycle-routes.ts`、`server-session-list-routes.ts`、`server-session-history.ts`；按 owner 获取运行态或持久历史，消息按回合、块和字节预算分页。 | 四端使用统一会话资源；不同分页参数表达不同窗口。 |
| 输入、停止、权限与升级 `/api/sessions/:id/input`、`/stop`、`/approve-permission`、`/deny-permission`、`/escalations/:requestId/resolve` | `server-session-input-routes.ts`；输入按 structured/PTY 实际 owner 分流，回执区分接受与未知；PTY 文本和回车保持既有契约。 | iOS、Android、macOS 已用统一输入；本轮将 Web 结构化发送及团队 relay 发送迁移到该入口，旧 structured messages 路径保留兼容。 |
| structured 排队 `/api/structured-sessions/:id/queued`、`/:index`、`/:index/promote` | `server-session-input-routes.ts` 调用 structured manager；用预期内容/队列核对并发修改，promote 明确中断并保留其他队列。 | 四端调用同一组路径；这是 structured 专有操作，不等同于 PTY 输入。 |
| 会话设置 `/provider`、`/employee`、`/directory`、`/model`、`/thinking-effort`、`/mode`、`/pi-settings` | `server-session-lifecycle-routes.ts` 和 `server-session-context.ts`；修改各自真实会话状态并按 provider/运行时约束验证。 | 多端对应操作使用同一资源族；Pi CLI 与 SDK 资源仍按各自能力隔离。 |
| 会话恢复和归档 `/resume`、`/archive`、`/unarchive`、`/batch-archive`、`/batch-delete`、`/completion/view`、`DELETE /api/sessions/:id` | `server-session-lifecycle-routes.ts`、`server-session-list-routes.ts`；管理运行所有权、持久状态、批量结果与已查看代次。 | 四端按相同资源操作；归档、删除、查看与停止语义不同。 |
| 外部历史 `/:provider-history`、`/:provider-history/:id`、`/:provider-history/batch-delete`、`/:provider-sessions/:id/resume` | `server-history-routes.ts`、`server-resume-routes.ts` 和 Claude 专属恢复路径；provider 原生历史的发现和恢复条件不同。 | 保留 provider 差异与原生 ID，不把历史扫描结果当已托管会话。 |
| 会话附件与文件 `/api/sessions/:id/upload`、`/api/session-file/:id`、`/api/file-preview`、`/api/file-write`、`/api/file-raw`、`/api/local-file/:encodedRoot`、`/api/local-preview/:host/:port` | `upload-routes.ts`、`server-file-routes.ts`、`server-local-preview-routes.ts`；会话文件可重定向到受限文件/预览资源；写入使用预期修改时间和大小。 | 四端共用服务资源；路径预览、原始下载和本地服务代理权限与响应不同。 |
| 目录 `/api/directory`、`/api/path-suggestions`、`/api/recent-paths` | `server-file-routes.ts`；分别浏览、提示和读取最近目录。 | 多端共用，不是等价的三个列表。 |
| Git `/api/sessions/:id/git-status`、`/git/merge-worktrees`、`/quick-commit`、`/generate-commit-message`、`/git/push`、`/api/workspaces/:id/worktree-merge-agent` | `server-session-worktree-routes.ts`；以会话或工作区的真实目录处理检查、合并、提交建议与推送。 | 多端共享路由；只读状态和有副作用操作分开。 |
| 工作区及任务 `/api/workspaces`、`/:id`、`/order`、`/:id/tasks`、`/:id/worktrees`、`/api/tasks`、`/organize-by-title`、`/api/workspace-tasks/:id`、`/sessions`、`/archive`、`/layout` | `server-workspace-routes.ts` 与 storage 原子入口；`/api/tasks` 是跨目录聚合，项目任务入口与独立任务入口共用创建实现。 | 四端有相同资源族。项目任务归属、会话归属和任务面板元数据是不同事实。 |
| 会话分区 `/api/workspace-sections`、`/unassign` | `server-workspace-routes.ts` 的 layout 分区和原子会话归属操作。 | Web、macOS、Android、iOS 均使用；不是看板任务元数据。 |
| 任务面板 `/api/wand-tasks`、`/:id`、`/:id/dispatch`、`/:id/comments`、`/:id/comments/:commentId/result`、`/api/wand-task-agent-defaults` | `server-task-routes.ts`、`task-comment-dispatch.ts`；任务元数据、派发、评论及结果分别管理。 | 四端共享任务资源，不能与运行目录聚合 `/api/tasks` 合并。 |
| Mission `/api/missions`、`/:id/archive`、`/:id/attempts/:attemptId/diff`、`/comments`、`/review/send` 及 `/api/inbox`、`/read` | `server-mission-routes.ts` 转发到 Missions 领域操作；review/send 返回接受结果。 | iOS、Android、Web 使用该资源族；Mission 尝试和看板任务不是同一实体。 |
| 对话 `/api/conversations`、`/:id`、`/list-state`、`/invitations`、`/channel`、`/messages`、`/tasks`、`/actions`、`/requests/:requestId` | `server-conversation-routes.ts` 调用 ConversationService，按 requestId 返回创建/发送/派发回执。 | 四端对应对话使用该业务接口；不能替换为裸会话输入，否则丢失目标、成员版本和业务回执。 |
| 员工及知识 `/api/silicon-employees`、`/:id`、`/api/knowledge`、`/owners`、`/:id` | `server-employee-routes.ts`、`server-knowledge-routes.ts`；知识文档校验归属与 revision。 | iOS、Android 的知识库页面使用新版接口；服务端旧员工知识接口仍供兼容和 Web 清空使用。iOS 中未被引用的三个旧调用及两个模型已删除。 |
| 团队 `/api/ai-teams`、`/:id`、`/:id/runs`、`/api/ai-team-runs/:id`、`/live`、动态 action、`/api/wand-tasks/:id/team-runs`、`/api/team-dispatch/plan`、`/start` | `server-ai-team-routes.ts`、`server-team-dispatch-routes.ts`；团队定义、运行、状态及派发有独立业务语义。 | Web 与原生端共享相应业务接口；后台团队 relay 的会话输入本轮归一。 |
| 对话整理 `/api/sessions/auto-organize`、`/by-token/:token`、`/:id`、`/:id/cancel` | `server-conversation-organize-routes.ts`；准备、启动、按 token 追踪和取消为独立阶段。 | 四端使用同一任务回执语义。 |
| 预测 `/api/sessions/:id/prediction` | 当前源码未注册；独立 `codex-prediction.ts` 与探针存在但无调用方。隔离构建服务返回 Express 404。 | iOS、Android、Web 存在调用；已记录回归任务 `209c9c11-a401-4617-aab5-38fd2f21c87e`，未修复。 |

## 本轮输入归一的兼容边界

统一输入新增 `interrupt`、`preserveQueue`、`expectedKind: "structured"`；`respondImmediately: false` 显式等待完成，保留旧 Web structured 入口的等待行为。服务端仍保留旧 `/api/structured-sessions/:id/messages`，以兼容已安装客户端和外部调用；因此不能仅凭仓库内引用少就删除它。未改变 structured 与 PTY 执行实现或 owner。

## 验证与未完成事项

- 基线 Node 24.21.0 下 `npm run check`、`npm run build` 通过；临时路由验证覆盖明确等待、提前接受、中断与队列、重复拒绝、接受后失败、类型保护及旧入口。
- 隔离服务使用真实 PTY 验证 structured-only 输入被拒绝；另以真实 structured manager、进程内宿主和本地假 Codex 验证等待、排队、重复拒绝、中断时保留其余队列和队列消费。独立隔离服务未能连接 structured 守护进程，未完成该服务上的 structured 端到端；没有调用真实付费模型。已安装服务只读接口基线可用，不代表已部署本次代码。
- iOS Ad Hoc `4.108.0-debug.11030608` 已签名发布；更新接口的版本、文件名、大小、签名状态与本地 IPA 一致，manifest 的 bundle ID 与构建号一致。文件大小 8265624，SHA-256 `bd120f700e854e31a3b47c98ed390cdc72b4cf8c2399618d0dbbc80412f6326a`。构建包含子仓已有未提交工作；未安装设备。
- `/ios/download` 会清理旧 IPA；验证时目录有两个包，为保留历史没有访问实际下载端点，因此下载字节的大小和摘要尚未核验。对应已有任务 `79d8b8db-017a-48ef-be81-bfe1b88e164e`。
- 浏览器隔离验收遇到系统通知权限提示，等待用户处理；未完成实际页面发送、排队、中断和团队聊天验收。
- 逐接口的深层存储、竞态及所有平台运行态仍需继续核对；本表不宣称全部接口均已完成行为验证。
- 跨会话排队未知送达恢复问题另见任务 `be446144-979f-408c-85bb-43f2be1e28b1`；Codex MCP App 的 Web 路由缺失与预测回归同卡跟进。不得把已安装旧版行为或静态搜索当成新版本端到端通过。
