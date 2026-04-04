# Source of Truth 对照表

这份文档对应任务拆解里的 A4。目标是回答一句常被混淆的话：**同一份信息到底该以哪里为准。**

这里的重点不是描述“数据会流经哪些地方”，而是当几份状态不一致时，应该先信哪一层、再用哪一层修正。

---

## 1. 总原则

当前系统存在四类状态载体：

1. **PTY 原始输出**
2. **运行时内存快照**（主要是 `ProcessManager` 的 `SessionRecord` 与前端 `state`）
3. **SQLite 持久化快照**（`WandStorage`）
4. **文件日志**（`SessionLogger`）

它们不是平级关系。

### 建议的一句话规则

- **terminal 事实源 = raw PTY output**
- **chat 事实源 = `ConversationTurn[]`**
- **permission 事实源 = 运行时 blocked / pending escalation 状态**
- **resume 事实源 = `claudeSessionId` + 最小真实对话信号**
- **历史审计事实源 = SQLite + session 日志，而不是前端 state**

也就是说：

- 前端 state 主要是展示缓存，不是最终真值
- 文件日志主要是审计/排障，不是在线业务判断主源
- fallback parser 只是兼容兜底，不应与主模型平级

---

## 2. 总表

| 信息项 | 在线主事实源 | 持久化副本 | UI 使用位置 | 不一致时先信谁 |
|---|---|---|---|---|
| raw terminal output | `ProcessManager` 中 `record.output` / PTY 实时流 | SQLite `output`，日志 PTY 文件 | terminal 视图 | 先信运行时 raw output |
| chat messages | `record.messages: ConversationTurn[]` | SQLite `messages`，日志 messages snapshot | chat 视图 | 先信 `ConversationTurn[]` |
| fallback chat | `parseMessages(output)` 临时派生 | 无独立持久化 | `/api/sessions/:id?format=chat`、前端 fallback | 只能在结构化消息缺席时使用 |
| session status | `SessionLifecycleManager` + `SessionRecord.status` | SQLite snapshot | sessions 列表、头部状态 | 先信运行时 status |
| permission blocked | `record.pendingEscalation` + `record.ptyPermissionBlocked` | SQLite snapshot metadata | composer 授权区 | 先信运行时 blocked 状态 |
| current task | `record.currentTask` / bridge task event | 仅间接随 snapshot 保存 | 顶部 task 条 | 先信运行时 task |
| claudeSessionId | bridge 捕获后写入 `record.claudeSessionId` | SQLite snapshot | resume 能力、历史关联 | 先信运行时已验证绑定 |
| resume eligibility | `claudeSessionId` + `messages` 最小对话信号 | SQLite snapshot + Claude history 文件 | resume 按钮/接口 | 先信运行时规则，不信孤立 sessionId |
| Claude history 列表 | 磁盘 `.claude/projects/**.jsonl` 扫描结果 | hidden ids 存 SQLite config | 历史侧栏 | 先信磁盘扫描结果 |
| auth/session 登录态 | auth storage + cookie | SQLite auth session | 登录/鉴权 | 先信 auth 存储 |

---

## 3. 分项说明

## 3.1 raw output

### 主事实源
- `src/process-manager.ts` 中的运行时输出缓冲
- 对应 bridge `output.raw` 事件

### 为什么它是 terminal 真值

terminal 是字节流/字符流视图，不要求语义结构化。只要 PTY 真正输出了，terminal 就应该以那份 raw output 为准。

### 持久化层作用

- SQLite 的 `output`：为了页面刷新、重启恢复后还能看到历史输出
- `SessionLogger` PTY 日志：为了排障与审计

### 不一致时如何判断

- **在线运行中**：优先信内存里的最新 raw output
- **会话结束后重新打开**：信已保存的 snapshot.output
- **怀疑 snapshot 损坏**：再对照 PTY 日志文件

### 前端对应
- `src/web-ui/content/scripts.js:3461` 的 `loadOutput(id)` 拉 `GET /api/sessions/:id`
- `src/web-ui/content/scripts.js:6764` 的 WS `output` 增量更新 terminal

结论：**terminal 不应依赖 fallback parser，也不应以 messages 反推 raw output。**

---

## 3.2 chat messages

### 主事实源
- `ConversationTurn[]`
- 具体由 `ClaudePtyBridge` 维护，`ProcessManager.handleBridgeEvent(...)` 写回 `record.messages`

### 为什么它应该是 chat 主模型

chat 视图需要保留：
- user / assistant 边界
- tool_use / tool_result block
- streaming 过程中的局部更新
- 后续 resume / 结构化展示所需信息

这些信息不是从 plain terminal output 总能可靠反推出来的。

### 持久化层作用

- SQLite `messages`：刷新/重启后恢复 chat 历史
- `SessionLogger.saveMessages(...)`：保留结构化快照便于排障

### 不一致时如何判断

- 如果 `messages.length > 0`，应优先信 `messages`
- 只有 `messages` 缺失时，才允许 `parseMessages(output)` 兜底

### 服务端对应
- `src/server.ts:738` 的 `/api/sessions/:id?format=chat`
- 当前逻辑：有 `snapshot.messages` 就直接返回；没有才 `parseMessages(snapshot.output)`

结论：**chat 主事实源是 `ConversationTurn[]`，不是 `ChatMessage[]` fallback。**

---

## 3.3 fallback `ChatMessage[]`

### 它是什么

- `src/message-parser.ts` 从 raw output 派生出的兼容消息
- 用于 bridge 结构化消息缺席时，仍能给 chat 视图一些可读内容

### 它不是什么

- 不是 Claude chat 的完整语义模型
- 不是 resume 判定依据
- 不是 tool/task/permission 的可信来源

### 使用边界

只在下面场景使用：

1. 历史老会话没有结构化 `messages`
2. bridge 暂时没产出结构化数据
3. 兼容非 Claude/旧格式会话

如果 `messages` 已存在，fallback 只能让位。

---

## 3.4 session lifecycle / status

### 主事实源
- `SessionLifecycleManager`
- `SessionRecord.status`
- `stopRequested` / `endedAt` / `archived` 等运行时字段

### 为什么不该以 DB 为主

状态变化是强时序信息：
- running -> waiting-input
- running -> exited
- idle -> archived

这些变化先发生在运行时，然后才异步持久化。DB 更像恢复快照，而不是在线判定主源。

### 前端对应
- sessions 列表从 `/api/sessions` 读取 status
- WS `status` / `ended` 事件会先局部更新，再由 `loadSessions()` 对齐

结论：**在线状态先信运行时；SQLite 是恢复来源，不是在线仲裁者。**

---

## 3.5 permission state

### 主事实源
- `record.pendingEscalation`
- `record.ptyPermissionBlocked`
- bridge 的 `permission.prompt` / `permission.resolved` 事件

### 为什么它必须是运行时真值

权限阻塞是交互中的短生命周期状态：
- 一旦 approve/deny，必须立即解除 blocked
- 如果等 DB / 轮询纠正，UI 会卡在错误状态

### 前端对应
- `src/web-ui/content/scripts.js:6891` WS `status` 处理 `permissionRequest` 与 `permissionBlocked`
- `src/web-ui/content/scripts.js:6968` `updateTaskDisplay()` 根据 selected session 的 blocked 状态决定展示授权区还是 task 区

### 不一致时如何处理

- 在线时优先信最新 WS/运行时状态
- 刷新恢复后再以 snapshot 补齐

结论：**permission state 不应由 parser fallback 或前端推测。**

---

## 3.6 current task

### 主事实源
- `ClaudePtyBridge` 检出的 task 事件
- `ProcessManager` 中的 `record.currentTask`

### 持久化地位

当前 task 更偏实时 UI 提示，不是长期审计核心字段。它可以随 snapshot 间接保存，但真正可信的是运行时事件流。

### 前端对应
- `src/web-ui/content/scripts.js:6884` WS `task`
- `src/web-ui/content/scripts.js:6998` `state.currentTask`

结论：**task 是实时展示状态，不应用于恢复核心业务判断。**

---

## 3.7 `claudeSessionId`

### 主事实源
- `ClaudePtyBridge.captureSessionId()` 捕获后写入运行时 session

### 但它不是单独充分条件

单有 `claudeSessionId` 还不够。当前代码里已经有一整套围绕最小对话信号的判定函数，其真实意图是：

- 不能因为看见一个 session id 就默认这会话可 resume
- 必须结合 `messages` 中是否存在真实 user+assistant 对话

### 为什么

Claude 可能在：
- 启动早期
- 恢复半途中
- 只输出环境信息时

就出现 session id，但这不代表会话已经形成可恢复的真实对话。

结论：**`claudeSessionId` 是 resume 的必要条件，不是充分条件。**

---

## 3.8 resume 关系

### 主事实源
- `claudeSessionId`
- `ConversationTurn[]` 中的最小真实对话信号
- Claude history `.jsonl` 文件中的磁盘证据

### 三层角色分工

1. **运行时 messages**：判断当前 session 是否已形成真实对话
2. **运行时 / SQLite 中的 `claudeSessionId`**：做会话关联键
3. **Claude history 扫描结果**：证明这个 Claude 会话在磁盘上确实存在并含真实记录

### 不应该怎么做

- 不该只看前端是否显示了“resume”按钮
- 不该只看 DB 里有没有 session id
- 不该只看磁盘上有同名 jsonl 就直接允许 resume

结论：**resume 的事实源是复合规则，不是单字段。**

---

## 4. UI 视角的一句话规则

为了减少以后讨论时的歧义，前端两大主视图可以直接用下面两句话定义：

### terminal 视图
> 只依赖 raw output；WebSocket 增量优先，REST 快照用于初始化和补齐。

### chat 视图
> 优先依赖 `ConversationTurn[]`；只有在结构化消息缺席时才 fallback 到 `parseMessages(output)`。

这两句话如果说不清，说明边界又开始混了。

---

## 5. 当前最容易混淆的点

### 混淆点 1：chat 视图里 fallback 看起来“也能用”
这会让人误以为 fallback 与 `ConversationTurn[]` 平级。其实不是。fallback 只是兼容视图，不适合承载 tool block、resume、permission 之类语义。

### 混淆点 2：SQLite 里也有 output/messages，所以它像主真值
不是。SQLite 是恢复快照；在线状态变化先发生在内存和 WS。

### 混淆点 3：前端 `state.sessions` 像全局真值
它只是浏览器侧缓存。真正真值来自服务端运行时状态与显式快照接口。

---

## 6. 对后续 Phase B / C 的直接约束

后续收敛与重构都应遵守下面几条：

1. **不要让 fallback parser 继续扩权**
   - 它应该收缩，而不是承担更多在线语义判断。

2. **不要让 polling 和 WS 平级写同一份状态却没有优先级规则**
   - 应明确：WS 增量优先，REST/polling 负责补快照与恢复。

3. **不要把日志文件当在线业务判断主源**
   - 日志是审计与排障证据。

4. **不要把 `claudeSessionId` 单独当作 resume 开关**
   - 必须和真实对话信号绑定。

---

## 7. 完成定义

A4 真正完成时，应满足：

1. 能一句话说清 terminal 和 chat 各自的事实源
2. 知道 permission / task / lifecycle 谁是在线真值
3. 知道 SQLite 和日志在系统里的地位是“恢复/审计”，不是在线仲裁
4. 知道 fallback parser 只是兼容路径
5. 后续改代码时，碰到状态不一致能先判断“该信哪一层”
