# Codex 接入能力与支持边界

本文记录 Wand 对 Codex `app-server` 协议的实际覆盖范围、明确的支持边界，以及尚未实现的部分。
结论以源码与本机回放验证为准；协议能力存在不等于当前账户一定可用。

Codex CLI 基线：`codex-cli 0.166.0`（`codex app-server --listen stdio://`，schema 由
`codex app-server generate-json-schema --experimental` 导出）。

## 1. 已投影的 ThreadItem

服务端在 `src/codex-app-protocol.ts`（camelCase → Wand 投影）与
`src/structured-codex-protocol.ts`（投影 → `ContentBlock[]`）两处完成映射，四端共用同一份 DTO。

| Codex item | Wand 投影 | 说明 |
| --- | --- | --- |
| `agentMessage` / `reasoning` / `plan` | text / thinking / text | 文本增量与完成态按 item id 原位替换 |
| `commandExecution` | `Bash` + 结果 | 保留 aggregatedOutput、exitCode、declined/failed |
| `fileChange` | `Edit`/`Write` + 结果 | 完成时用前后快照重建 unified diff |
| `mcpToolCall` | `<server>__<tool>` + 结果 | 保留 content 里的图片、`structuredContent`、`_meta`、`appContext`、`mcpAppUi`、`pluginId`、`readOnlyHint` |
| `webSearch` | `WebSearch` + 结果 | 保留 `action`（search/openPage/findInPage）与 `results` |
| `imageView` | `Read`（带 `file_path`） | 四端已有「Read 带图片路径 → 内联缩略图」链路直接生效 |
| `imageGeneration` | `ImageGeneration` + 图片结果 | `savedPath` 落盘图读成 base64 image part；也接受内联 data URL / 裸 base64；保留 revisedPrompt、透明背景、输入图片、失败原因（含用量额度） |
| `collabAgentToolCall` | `Codex/<tool>` + 子代理状态汇总 | 名称对照 v2 schema，不是 `collabToolCall` |
| `subAgentActivity` | `Codex/Agent` | 保留 kind / agentPath / agentThreadId / model |
| `enteredReviewMode` / `exitedReviewMode` | `Codex/review` + 评审正文 | 评审结论进 tool_result |
| `contextCompaction` | `ContextCompaction` 卡 | 压缩会改变后续可见历史，必须显式告知 |
| `functionCallOutput` | tool_result | 没有对应 tool_use 时按结果卡展示 |
| `todo_list` | `TodoWrite` | 状态二值化：completed / pending |
| `dynamicToolCall` | `function_call` | 见下方边界：Wand 不下发动态工具，实际不会出现 |
| `sleep` | 不立卡 | 只有 durationMs 的纯展示项，无可用语义 |
| `userMessage` / `hookPrompt` | 忽略 | 用户消息由 Wand 自己的转录持有 |

图片在传输层统一改写为 `/api/sessions/:id/tool-images/:toolUseId/:index`，四端用同一套带鉴权的
取图通道按需加载，不把 base64 塞进每次快照或 WebSocket 帧。

## 2. 图片原生输入

四端上传附件统一在 prompt 前注入
`[附件已上传，请查看以下文件:\n<path>\n]\n\n<正文>`（Web `buildAttachmentPrefix`、macOS
`ChatView`、Android `ChatComposer`、iOS 同款）。`src/structured-attachment-input.ts` 解析这条
Wand 自有协议，只把「绝对路径 + 真实存在的普通文件 + 位图后缀 + 有界大小」映射成 Codex
`UserInput.localImage`：

- `turn/start` 与 `turn/steer`（执行中插话）都携带原生图片；
- 单轮最多 10 张，单张不超过 20MB；
- PDF/代码/目录/丢失文件继续留在路径文本里，由模型按路径读取；
- 用户正文里出现的图片路径不会被当成附件（不猜自由文本）。

## 3. 下一条输入预测

`thread/prediction/request` + `thread/prediction/updated` 是可编辑草稿预测。预测本身会调用模型，
因此 Wand 的实现边界是：

- **只由用户显式点击触发**（输入面板加号菜单「预测下一条」），服务端不轮询、不预取；
- 只在 Codex 结构化会话、回合已结束、草稿为空时可用；
- 结果只填入空草稿，期间用户已输入则放弃落地；**永不自动发送**，也不覆盖已有草稿或附件；
- 预测用一次性探针进程（`src/codex-prediction-probe.ts`）完成，不拖住回合收敛；
- 账户或协议不支持时如实返回原因，不降级成猜测文本。

## 4. MCP Apps 插件面板

带 `mcpAppUi.resourceUri` 的 MCP 工具调用在工具卡里有「打开插件面板」入口：

- 服务端 `POST /api/sessions/:id/mcp-app` 起一个只读探针（`codex-mcp-app-probe.ts`）：
  `initialize → thread/resume(excludeTurns) → mcpServer/resource/read`，返回 `ui://` 资源的 HTML
  （≤2MB）与 `panelId`；同一 thread 已有 writer（回合执行中）时如实返回不可用。
- 面板内交互通过 `POST /api/sessions/:id/mcp-app/:panelId/call` 回到 **同一条 MCP 连接**
  （`mcpServer/tool/call`），不经过模型；关闭面板或空闲 10 分钟回收探针进程。
- Web 端把 HTML 渲染在 `sandbox="allow-scripts allow-forms"` 的 iframe 里（不透明源，
  拿不到 Wand 的 cookie / DOM），用 JSON-RPC 桥（`src/web-ui/browser/mcp-app-bridge.ts`）
  完成 `ui/initialize` 握手、`ui/notifications/tool-input|tool-result` 推送、`tools/call`
  代理与 `ui/open-link`（仅 http(s)）。未实现的能力（写模型上下文、代发消息）明确回 `-32601`，
  不假装成功。
- 已验证：面板探针与工具调用回放（假 app-server）、桥接协议回放、真实 Codex 0.166.0
  app-server 上的方法名与错误路径。**未验证**：真实 MCP App 插件的界面渲染与交互（本机没有
  可用的 MCP App server）。

## 5. 明确的支持边界

| 能力 | 现状 | 原因 |
| --- | --- | --- |
| MCP Apps 面板（原生端） | Web 已实现；Android/iOS/macOS 未接入 | 原生端需要各自的 WebView 宿主与桥接，属独立工作量 |
| MCP Apps 的模型上下文写入 | 明确拒绝（`-32601`） | 插件内容不进对话上下文，避免静默改写模型输入 |
| 动态工具（`item/tool/call`） | worker 明确回 `-32601` | Wand 不下发 `dynamicTools`，不伪造能力 |
| 审批 / elicitation | `approvalPolicy=never`，`McpServerElicitation` 未接入 | 不扩大权限；接入需要四端审批 UI 与策略 |
| Codex 原生 Plan mode | 未下发 `collaborationMode` | Wand 没有「计划模式」这个执行模式，属产品取舍；已有 plan 文本与 Todo 展示不等于模式选择 |
| `review/start` 主动发起评审 | 只展示 `entered/exitedReviewMode` | 没有四端入口，属产品取舍 |
| 原生端预测入口 | Web / macOS / Android / iOS 均已接入 | 入口在各自加号或会话菜单；只填空草稿、不自动发送 |
| `sleep` 展示项 | 不立卡 | 无可用语义 |

## 6. 验证方式

- 协议回放：把 v2 真实 item 形状喂给 `CodexAppProtocolReducer`，断言 DTO 不丢图片、结构化结果、
  插件元数据、评审/压缩/子代理事件，并检查传输层把内联图片改写成取图 URL。
- 原生图片输入回放：用假 `codex app-server` 记录 `turn/start` 与 `turn/steer` 的 `input`，
  断言文本在前、`localImage` 数量与路径正确。
- MCP Apps 回放：面板探针（资源读取 + 工具调用 + 关闭回收）与 Web 桥接（initialize、
  tool-input/tool-result、tools/call、open-link、未知方法拒绝、尺寸上限）各一组断言。
- 回放不等于真机验收：真实图片生成、真实 MCP 插件界面、真实账户预测能力仍需在已安装服务上
  由用户显式触发验证。
