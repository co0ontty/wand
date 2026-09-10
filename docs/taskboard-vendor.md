# Taskboard 集成

Wand 的「任务」入口现在嵌入 `vendor/codex-taskboard` 的完整 Web Taskboard，而不是重新实现一套简化看板。

## 来源

- 上游：`https://github.com/chuspeeism/dashi-taskboard`
- 固定版本：`c346e8e16c9cf6d61969d826d33fe7f6b5bcbc8f`
- 许可证：Apache-2.0，许可证副本保存在 `vendor/codex-taskboard/LICENSE`

## 运行方式

- `vendor/codex-taskboard/dist/web` 是上游 Vite 产物，包含 Dashboard、议题看板、列表视图、甘特图、筛选、显示设置、项目管理、议题编辑器、评论、附件、关系和本地 AI 面板。
- Wand 启动时通过 `src/taskboard-bridge.ts` 启动一个回环 Taskboard 子服务。
- `/taskboard/*` 由 Wand 鉴权后反向代理到该子服务。
- 子服务数据写入当前 Wand 配置目录下的 `taskboard/`，不会污染上游仓库或默认 Wand 数据库。
- iframe 启动时携带当前 Wand 会话 ID；代理注入的 fetch 适配器把 `X-Wand-Session-Id` 传给每个任务写操作，并将关联保存到 Wand SQLite 的 `taskboard_session_bindings`。
- 任务卡片会展示已绑定的 Wand 会话及 provider；可直接打开会话，或把当前会话绑定到任务。
- 绑定不是 Codex 专属：Claude、Codex、OpenCode、Grok、Qoder、Pi 的结构化和 PTY 会话都按 Wand session id 统一处理。

更新上游版本时，需要同时重新生成 `dist/web`，并重新检查 `server/` / `shared/` 与 Wand 的会话、项目和鉴权适配层。

## Wand Agent 指派

任务卡片中的「+ 指派 Agent」由 Wand bridge 注入，不改写上游 Taskboard 的 Codex-only assignee 数据模型。指派弹窗可选择 Claude、Codex、OpenCode、Grok、Qoder、Pi，以及服务端模型目录中的模型和 Wand 的思考深度（关闭 / 标准 / 深入 / 最大）。确认后会创建一个结构化 Wand 会话、把任务提示词发送给它，并写入 `taskboard_session_bindings`；卡片随后显示 Agent、模型和思考深度，点击即可打开会话。
