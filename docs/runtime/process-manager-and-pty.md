# ProcessManager 与 PTY / Claude Bridge 运行逻辑

这一部分是整个项目最关键的运行时链路。浏览器里看到的“一个会话”，后端实际上要同时管理：子进程、PTY、原始输出、结构化聊天、权限状态、恢复状态、生命周期状态、磁盘日志与 SQLite 快照。

## 1. `ProcessManager` 是会话运行时核心

`src/process-manager.ts` 持有所有活动/历史会话的内存态，并通过 `EventEmitter` 向 server 层发出 `ProcessEvent`。

每个会话在内存中以 `SessionRecord` 表示，它基于 `SessionSnapshot` 扩展出大量运行时字段，例如：

- `ptyProcess`
- `childProcess`
- `stopRequested`
- `confirmWindow`
- `pendingEscalation`
- `autoApprovePermissions`
- `rememberedEscalationScopes`
- `messages`
- `ptyBridge`
- `currentTask`
- 各类 discovery / debounce / initial input timer

这说明 `SessionSnapshot` 是“可持久化对外视图”，而 `SessionRecord` 是“带运行时状态的内部对象”。

## 2. `ProcessManager` 构造时就会恢复历史状态

初始化时，它会接收：

- `config`
- `storage`
- `configDir`

并创建：

- `SessionLogger`
- `SessionLifecycleManager`

随后从 `storage.loadSessions()` 读取历史会话，把它们装回内存映射中。对于那些数据库里还标记为 `running` 的会话，由于真实 PTY 不可能跨进程重建，它会按已退出状态处理，并在后续的自动恢复逻辑里决定是否重启一个新的 Claude 恢复会话。

所以应用重启后看到的“历史会话还在”，并不是旧 PTY 活过来了，而是旧快照被重新加载到了会话列表里。

## 3. 新会话启动链路 `start()`

`server.ts` 调用 `processes.start()` 后，关键步骤大致是：

1. 校验命令
2. 解析 cwd
3. 识别是否为 Claude 命令
4. 构造 sessionId 与 `SessionRecord`
5. 创建 `ClaudePtyBridge`
6. 使用 `node-pty` 启动 PTY 子进程
7. 注册 `onData` / `onExit`
8. 注册 lifecycle 初始状态
9. 持久化快照
10. 发出 `started` 事件

### 3.1 命令校验
如果配置了 `allowedCommandPrefixes`，则只有白名单命令可启动。这是一个运行前边界控制，而不是纯 UI 限制。

### 3.2 Claude 命令识别
是否是 Claude 会话会影响很多行为：

- 是否启用 `ClaudePtyBridge` 的权限提示检测
- 是否尝试捕获 `claudeSessionId`
- 是否允许使用恢复逻辑
- 某些输入过滤逻辑是否生效

## 4. PTY 输出是如何流转的

### 4.1 从 `node-pty` 到浏览器终端
当 PTY 有输出时，Manager 会：

1. 收到 `onData(chunk)`
2. 更新原始输出窗口
3. 写入 `SessionLogger.appendPtyOutput()`
4. 让 `ClaudePtyBridge.processChunk(chunk)` 继续做结构化解析
5. 触发持久化
6. 通过 `ProcessEvent` 把事件送给 WebSocket 广播层

因此一个输出 chunk 会同时进入三条路径：

- 内存 raw output
- 文件日志
- 结构化解析器

### 4.2 为什么既保留 raw output，又保留 messages
因为 UI 有两种视图：

- terminal 视图需要最原始的输出
- chat 视图需要结构化 turn

如果只保留其中一种，另一种体验就会受损。

## 5. `ClaudePtyBridge` 的角色

`src/claude-pty-bridge.ts` 并不负责创建或管理 PTY，它只负责消费 PTY 字节流并输出语义事件。

它内部维护几类状态：

- `rawOutput`
- `messages`
- `chatState`
- `permissionState`
- `sessionIdWindow`
- `currentTask`
- remembered scopes / targets

## 6. `processChunk()` 具体干了什么

每次 PTY 输出到来时，Bridge 的 `processChunk(chunk)` 会按顺序做：

1. 追加到 `rawOutput`（窗口截断）
2. emit `output.raw`
3. `captureSessionId(chunk)`：抓 Claude session UUID
4. `detectPermission(chunk)`：滚动窗口检测权限提示
5. 如果当前处于 `responding` 状态，继续 `parseChatResponse()` 更新聊天内容

这意味着一个 chunk 是多重用途的：既是终端输出，也可能是权限提示，也可能是 Claude 会话 ID，也可能是 assistant 回复正文。

## 7. Chat 模式如何形成 `ConversationTurn[]`

### 7.1 用户输入时
`ProcessManager.sendInput()` 会先调用 `bridge.onUserInput(input)`。

Bridge 做的事：

1. 过滤掉不应视为正常聊天输入的内容
2. 追加一条 `role: "user"`
3. 追加一个空的 assistant 占位 turn
4. 把 `chatState.phase` 切到 `responding`
5. emit `output.chat`

然后 Manager 再真正把文本写进 PTY。

### 7.2 assistant 回复流式更新
后续每个输出 chunk 进入 `parseChatResponse()`：

- 去 ANSI
- 跳过终端中的用户回显
- 累加到当前 assistant turn
- 持续 emit `output.chat`

当 Bridge 认为一次回复完成时，会：

- finalize 当前 assistant turn
- emit `chat.turn`
- 重置 `chatState`

### 7.3 为什么还要有 `message-parser.ts`
因为不是所有旧会话都一定已有 `messages`。在读取历史会话详情时，server 还可能通过 `parseMessages(snapshot.output)` 从原始终端文本降级生成聊天消息。

## 8. 权限提示检测与审批流

Claude CLI 在 PTY 中提出权限请求时，不会直接变成结构化 API；wand 需要自己从终端文本中识别。

### 8.1 检测
Bridge 内部维护一个滚动窗口，根据关键词与模式推断：

- 当前是否阻塞在权限提示
- prompt 文本是什么
- scope 属于 `write_file` / `network` / `run_command` / `outside_workspace` / `dangerous_shell` / `unknown`
- target 是什么

### 8.2 自动审批与记忆
Bridge 支持：

- 自动 approve
- approve once
- remember this turn

因此同一回合里，某些已记住范围的权限请求可以自动通过，而不必每次都弹给前端。

### 8.3 用户审批
如果没有自动通过：

1. Bridge emit `permission.prompt`
2. Manager 更新会话的 `pendingEscalation`
3. 前端通过 API 调用 approve / deny / resolve
4. Manager 调用 Bridge 的 `resolvePermission()`
5. Bridge 往 PTY 写入确认输入（如回车或 `n\r`）
6. emit `permission.resolved`

这是典型的“PTY 文本检测 -> 状态提升 -> HTTP 决策 -> 写回 PTY”的闭环。

## 9. Claude session ID 与恢复机制

恢复功能的关键前提是：wand 能从 Claude 输出中抓到 session UUID，并且后续还能在磁盘上找到对应的 Claude 历史文件。

### 9.1 抓取 session UUID
Bridge 使用若干正则，从以下几类文本中抓取：

- JSON 字段中的 `session_id`
- `--resume <uuid>` 命令本身
- 终端提示中的 `session id`

### 9.2 何时允许显示恢复
`process-manager.ts` 里有一系列 `shouldAllowResume()` / `shouldPromoteResumeAction()` / `hasStoredConversationHistory()` 之类的判断函数，核心思想是：

- 不只是有 `claudeSessionId` 就够
- 还要有真实的 user + assistant 对话痕迹

这样能减少 UI 上出现“实际上不能恢复”的假按钮。

### 9.3 自动恢复
应用启动时，Manager 会扫描持久化会话与 Claude 项目历史文件，尝试找最近可恢复的会话，并按条件启动新的 `claude --resume <id>` 进程。

因此“自动恢复”其实是在新进程里重放恢复命令，而不是把旧 PTY 复活。

## 10. `sendInput()` 除了写入 PTY 还做了什么

输入链路不仅仅是 `pty.write()`：

1. 找到 `SessionRecord`
2. 更新 lifecycle：`touch()` / `startThinking()`
3. 调用 `bridge.onUserInput()` 建立 chat turn
4. 把输入写入 PTY
5. 更新快照并持久化

因此任何“输入后聊天视图不更新”的问题，都要同时排查：

- 前端有没有发到 `/api/sessions/:id/input`
- Manager 有没有找到会话
- Bridge 有没有接受这次输入
- PTY 是否真的写入成功

## 11. `SessionLifecycleManager` 在会话链路中的作用

Manager 并不自己实现状态机，而是把这件事委托给 `src/session-lifecycle.ts`。

状态包括：

- `initializing`
- `running`
- `thinking`
- `waiting-input`
- `idle`
- `archived`

Manager 在几个关键时机触发状态变化：

- 新会话创建
- 用户发送输入
- assistant 回复中
- 会话超时
- 会话归档

这部分状态既服务 UI，也帮助控制归档逻辑。

## 12. 持久化与日志写入点

`ProcessManager` 每次关键状态变化都要同时考虑两种存储：

### 12.1 SQLite
通过 `WandStorage` 保存：

- 会话元数据
- 原始输出窗口
- `claudeSessionId`
- `messages`
- resume 关系
- autoRecovered 标志

### 12.2 文件日志
通过 `SessionLogger` 保存：

- `pty-output.log`
- `stream-events.jsonl`
- `messages.json`
- `metadata.json`
- `shortcut-interactions.jsonl`

SQLite 更偏“系统可查询状态”，而日志目录更偏“诊断与审计材料”。

## 13. 停止、删除、归档是三种不同概念

在维护这个模块时，要区分这几个动作：

- **stop**：尝试终止当前运行中的 PTY
- **delete**：从存储与日志中移除会话
- **archive**：标记为已归档，仍然保留历史
- **resume**：创建新会话，并通过 resume 关系链接旧会话

如果混淆这些概念，就容易在 UI 上做出破坏历史链路的改动。

## 14. 与其他模块的依赖关系

```text
ProcessManager
  ├─ node-pty                 启动 PTY 进程
  ├─ WandStorage              持久化 SQLite 快照
  ├─ SessionLogger            磁盘日志
  ├─ SessionLifecycleManager  会话状态机
  ├─ ClaudePtyBridge          Claude 输出结构化解析
  ├─ pty-text-utils.ts        文本清洗/窗口裁剪
  └─ types.ts                 共享类型

ClaudePtyBridge
  ├─ pty-text-utils.ts
  └─ types.ts
```

## 15. 排障时应该怎么切分问题

### 如果问题是“终端有输出，但聊天视图没有”
先查：

1. PTY 输出是否进入 Manager
2. Bridge 是否处于 `responding`
3. `parseChatResponse()` 是否更新了 assistant turn
4. WebSocket 是否发出了 `output.chat`
5. 前端是否在 chat 模式渲染 `messages`

### 如果问题是“Resume 按钮不出现 / 恢复失败”
先查：

1. `claudeSessionId` 有没有被 Bridge 捕获
2. SQLite 里是否保存了 `claude_session_id`
3. 会话是否有真实对话痕迹
4. Claude 项目文件是否还存在
5. 恢复命令是否以 `claude` 开头

### 如果问题是“权限提示卡死”
先查：

1. Bridge 是否检测到 prompt
2. `pendingEscalation` 是否挂到 session 上
3. 前端是否看到了权限卡片
4. resolve API 是否调用成功
5. PTY 是否收到确认输入

这也是为什么理解 `ProcessManager + ClaudePtyBridge + storage + UI` 的联动，比只看单个函数更重要。
