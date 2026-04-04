# 前端同步通道矩阵

这份文档对应任务拆解里的 A3。目标是把前端到底依赖 **REST、WebSocket、还是 polling** 说清楚，并标出哪些路径当前存在覆盖关系或时序竞态。

---

## 1. 先给结论

当前前端不是单一同步通道，而是三套机制并存：

1. **REST 快照拉取**：首屏、切换会话、显式操作后的刷新
2. **WebSocket 增量事件**：运行中会话的实时 output / status / task / ended / notification
3. **polling 兜底**：WebSocket 不可用时，用 `refreshAll()` 周期拉全量 sessions 列表

设计意图其实已经偏向：

- **WebSocket = 实时主通道**
- **polling = 断线兜底**
- **REST = 初始化与补快照**

但当前实现里，这三者仍会在若干路径同时写同一块状态，所以“主次”还没有彻底固化。

---

## 2. 通道总览矩阵

| UI/状态区域 | 主数据 | 首次加载 | 增量更新 | 兜底/补偿 | 当前事实源 |
|---|---|---|---|---|---|
| sessions 列表 | `SessionSnapshot[]` | `GET /api/sessions` | `started/ended/status/output` 先局部写，再 `loadSessions()` 回补 | polling `refreshAll()` | 内存 `state.sessions`，来源混合 |
| 当前 terminal 输出 | `output` / `chunk` | `GET /api/sessions/:id` + WS `init` | WS `output.chunk` | 选中会话后 `loadOutput()` 全量替换 | 运行时以 WS 为主 |
| 当前 chat 视图 | `messages` 优先，fallback parse 次之 | `GET /api/sessions/:id` | WS `output.messages` / `ended.messages` | `scheduleChatRender()` 内 fallback parse | `state.currentMessages` + selected session |
| permission UI | `pendingEscalation` / `permissionBlocked` | sessions 列表快照 | WS `status` | `loadSessions()` 覆盖修正 | `state.sessions` 中当前 session |
| task 标题 | `currentTask` | 无专门初始化，依赖 selected session 和 WS | WS `task` | `updateSessionSnapshot()` 间接保留 | `state.currentTask` + selected session |
| 会话完成通知 | ended event | 无 | WS `ended` | 无 | WS |
| Claude history | 历史扫描结果 | `GET /api/claude-history` | 无 | 手动重新加载 | REST |
| 配置/登录态 | `/api/config` | `restoreLoginSession()` | 无 | 页面刷新 | REST |

---

## 3. 启动与首屏时序

对应 `src/web-ui/content/scripts.js:234` 的 `restoreLoginSession()`：

```text
页面加载
  -> GET /api/config
  -> render({ skipShellChrome: true })
  -> startPolling()
       -> 优先 initWebSocket()
       -> 失败才 setInterval(refreshAll)
  -> refreshAll()
       -> loadSessions()
       -> GET /api/sessions
  -> requestNotificationPermission()
  -> loadClaudeHistory()（默认展开时）
```

### 这里的关键点

1. `startPolling()` 名字叫 polling，但实际先建 WS
2. 即使 WS 可用，首屏仍然会立刻执行一次 `refreshAll()`
3. 所以启动阶段天然就是：
   - 一次 REST sessions 快照
   - 外加一个可能很快到达的 WS `init` / `output` / `status`

### 这意味着

首屏不是单通道初始化，而是：

- `config` 走 REST
- sessions 列表走 REST
- 当前选中会话的实时状态可能马上切到 WS

这本身不是 bug，但会让“谁覆盖谁”变得敏感。

---

## 4. 会话切换时序

对应 `src/web-ui/content/scripts.js:3484` 的 `selectSession(id)`：

```text
selectSession(id)
  -> selectedId = id
  -> 清空 currentMessages / render tracking
  -> updateSessionsList()
  -> switchToSessionView(id)
  -> loadOutput(id)
       -> GET /api/sessions/:id
       -> updateSessionSnapshot(data)
       -> state.currentMessages = data.messages || []
       -> syncTerminalBuffer(id, data.output, { mode: "replace" })
       -> renderChat(false)
```

### 额外还有一个并行通道

- WS 连接打开时只会自动订阅 `state.selectedId`
- 新建会话成功后会显式 `ws.send({ type: "subscribe", sessionId: data.id })`
- 普通 `selectSession(id)` 本身仍主要依赖 `loadOutput(id)` 拉当前快照

### 现状结论

会话切换时，**详情主通道仍是 REST**，WS 更像切换后的实时增量补丁，而不是唯一来源。

---

## 5. 运行中输出链路

### 5.1 服务端

`src/server.ts:1260`

```text
ProcessManager emits "process" event
  -> WsBroadcastManager.emitEvent(event)
  -> output 事件做 16ms debounce
  -> 广播到已连接客户端
```

`src/ws-broadcast.ts` 的行为很关键：

- 只要客户端订阅了某个 session，就会收到该 session 的：
  - `init`
  - `output`
  - `status`
  - `task`
  - `ended`
  - `notification`
- `output` 会 debounce，并尽量合并 `chunk`
- `subscribe` 时会立即推一次 `init` 快照

### 5.2 前端

`src/web-ui/content/scripts.js:6762` 的 `handleWebSocketMessage(msg)`：

#### `output`
- 更新 `state.sessions` 中对应 snapshot
- 若是当前选中 session：
  - `messages` 存在则更新 `state.currentMessages`
  - terminal 优先走 `chunk` 直写，避免整屏 reset
  - 无 `chunk` 时再走 full output fallback

#### `status`
- 更新 `permissionBlocked` / `pendingEscalation`
- 若当前选中，则同步刷新顶部 task/permission UI

#### `task`
- 更新 `state.currentTask`

#### `ended`
- 先局部更新 session status
- 再清空本地 queued inputs
- 最后 `loadSessions()` 回拉列表，并对当前选中会话 `loadOutput(id)` 补全终态

### 现状结论

运行中会话的实时体验主要靠 WS；其中 terminal 甚至已经明显按“增量流”优化，而不是只靠 REST 轮询。

---

## 6. polling 的真实角色

对应 `src/web-ui/content/scripts.js:6694`：

```text
startPolling()
  -> stopPolling()
  -> initWebSocket()
  -> 如果 WS 成功：直接返回
  -> 如果 WS 失败：setInterval(refreshAll, 1600)
```

所以 polling 不是主更新手段，而是：

- 浏览器不支持 WS 时兜底
- WS 握手失败时兜底
- 长时间断线期间维持最基本 sessions 列表同步

这和变量/函数命名有一点错位：`startPolling()` 实际上是 “startTransportSync()”。

---

## 7. REST 快照仍负责哪些事

REST 并没有退场，它仍承担三类关键职责。

### 7.1 首屏装配
- `/api/config`
- `/api/sessions`
- `/api/claude-history`

### 7.2 选中会话的当前快照
- `/api/sessions/:id`
- 负责页面刷新后恢复 terminal/chat 的完整基线

### 7.3 显式动作后的收敛
例如：
- stop 后 `refreshAll()`
- delete 后 `refreshAll()`
- resume / start 后依赖返回 snapshot + 可能的订阅补全

所以 REST 的真实角色不是实时通道，而是：

- **初始化**
- **切换时补基线**
- **操作后重新收敛**

---

## 8. 当前最容易发生覆盖/闪回的 3 个点

## 8.1 旧 sessions 快照覆盖新 WS 局部状态

`src/web-ui/content/scripts.js:3328` 的 `loadSessions()` 会把服务器返回的 sessions 列表整体写入 `state.sessions`，只对 output 长度做了有限保护：

- 如果本地 output 比服务端长，就保留本地 session
- 但对 `pendingEscalation`、`currentTask`、`messages` 等并没有同等级别的保护

风险：
- WS 刚推来新的 blocked/task 状态
- 紧接着一次 REST 列表快照仍是旧状态
- 浏览器把新状态覆盖回旧状态

## 8.2 会话切换时 REST replace 与 WS init/output 交错

`selectSession(id)` 会立即 `loadOutput(id)`，而 WS 订阅后也可能很快收到：

- `init`
- `output`

虽然 `syncTerminalBuffer()` 已经对“更短快照”做了忽略处理（`src/web-ui/content/scripts.js:2935`、`2944`），但 chat/messages 侧没有同样强的版本控制。

风险：
- terminal 相对稳定
- chat 区可能出现先清空、再回填、再被 fallback parse 覆盖的闪动

## 8.3 ended 后同时触发局部更新、列表刷新、详情刷新

`handleWebSocketMessage('ended')` 里会：

1. 先本地 `updateSessionSnapshot(endedSnapshot)`
2. 清空队列
3. `loadSessions()`
4. 若当前选中，再 `loadOutput(msg.sessionId)`

这意味着 ended 时至少存在三次状态收敛动作。

风险：
- sessions 列表、顶部状态、terminal/chat 最终一致性依赖调用时序
- 如果其中某一步返回的是旧快照，UI 可能短暂倒退

---

## 9. 为什么 terminal 比 chat 更稳定

从现有实现看，terminal 已经有更清楚的优先级规则：

- WS `chunk` 优先直接写终端
- `syncTerminalBuffer()` 会拒绝“更短的旧快照”
- session 切换或显式 replace 时才整屏 reset

而 chat 侧仍是混合策略：

- 有 `messages` 时直接用
- 没有时 fallback parse
- `scheduleChatRender()` 在一些边界场景还会重新从 selected session output 派生消息

所以当前同步问题里，**chat 比 terminal 更脆弱**。

---

## 10. 建议固化的主次关系

这部分不是直接改代码，而是为 B3 提供判定规则。

### 10.1 sessions 列表
- 主来源：REST `/api/sessions`
- WS 只做局部临时更新
- 但局部高时效字段（permission/task/running status）不应被明显更旧的快照回滚

### 10.2 当前选中会话的 terminal
- 主来源：WS `output.chunk` / `output.output`
- REST `GET /api/sessions/:id` 只用于初始化、切换、重连补基线

### 10.3 当前选中会话的 chat
- 主来源：WS/REST 提供的 `ConversationTurn[]`
- fallback parse 只在结构化 messages 缺席时触发
- 不能让 fallback 在已有结构化消息时反向覆盖它

### 10.4 permission / task
- 主来源：WS `status` / `task`
- REST 列表快照是恢复与校正来源，不应抢实时主导权

---

## 11. B3 实施时应优先看的代码点

- `src/web-ui/content/scripts.js:234` `restoreLoginSession()`
- `src/web-ui/content/scripts.js:3328` `loadSessions()`
- `src/web-ui/content/scripts.js:3461` `loadOutput(id)`
- `src/web-ui/content/scripts.js:3484` `selectSession(id)`
- `src/web-ui/content/scripts.js:5243` `flushPendingMessages()`
- `src/web-ui/content/scripts.js:6694` `startPolling()`
- `src/web-ui/content/scripts.js:6706` `initWebSocket()`
- `src/web-ui/content/scripts.js:6762` `handleWebSocketMessage(msg)`
- `src/web-ui/content/scripts.js:7064` `updateTerminalOutput()`
- `src/ws-broadcast.ts:97` `emitEvent()`
- `src/server.ts:1255` WebSocket 装配与 `processes.on("process")`

---

## 12. 完成定义

A3 真正完成时，至少要满足：

1. 能明确指出每个 UI 区域主要靠哪条通道更新
2. 能说清首屏、切换会话、断线重连、长输出流四条时序
3. 能指出当前最容易覆盖/闪回的 3 个点
4. 能给 B3 一个明确目标：**不是删掉所有通道，而是先固化优先级**
