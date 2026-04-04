# ProcessManager 职责地图

这份文档把 `src/process-manager.ts` 按“外部入口 -> 内部子流程 -> 依赖模块 -> 状态写入点”拆开，目的是为后续 Phase C 的拆分提供精确地图，而不是继续凭感觉重构。

---

## 1. 对外入口总表

| 入口 | 作用 | 主要子流程 | 主要依赖 | 主要写入 |
|---|---|---|---|---|
| `constructor(config, storage, configDir)` | 初始化运行时内核 | 加载历史会话、初始化 logger/lifecycle、自动恢复准备 | `WandStorage`, `SessionLogger`, `SessionLifecycleManager` | 内存 `sessions`、定时器、缓存 |
| `start(command, cwd, mode, initialInput, opts)` | 启动新会话 | 校验命令、创建 PTY、绑定 bridge、注册 onData/onExit | `node-pty`, `ClaudePtyBridge`, `storage`, `logger`, `lifecycle` | `SessionRecord`, DB, log, WS 事件 |
| `get(id)` | 读取会话快照 | 归档检查、输出补齐 | `sessions` map | 可能回填 `record.output` |
| `list()` | 返回会话列表 | 归档检查、排序/映射 | `sessions` map | 无 |
| `sendInput(id, input, view, shortcutKey)` | 向会话发送输入 | 运行态校验、更新 lifecycle、bridge 跟踪、写入 PTY、持久化 | `ClaudePtyBridge`, `SessionLifecycleManager`, `SessionLogger`, `WandStorage` | PTY、snapshot、shortcut log |
| `resize(id, cols, rows)` | 调整 PTY 尺寸 | clamp -> resize | `node-pty` | PTY |
| `stop(id)` | 停止运行会话 | 清定时器、kill 子进程/PTY、清 bridge、归档、持久化 | `node-pty`, `SessionLifecycleManager`, `WandStorage` | status, endedAt, DB, log |
| `delete(id)` | 删除会话 | 停止运行中会话、清 timers、删 DB、删日志 | `WandStorage`, `SessionLogger` | sessions map, DB, log dir |
| `approvePermission(id)` | 同意权限一次 | 委托 `resolvePermission()` | bridge / PTY | escalation state |
| `denyPermission(id)` | 拒绝权限 | 委托 `resolvePermission()` | bridge / PTY | escalation state |
| `resolveEscalation(id, requestId, resolution)` | 带 requestId 的权限决策 | 参数校验、决策落地、清 blocked、持久化 | bridge / PTY / storage | pendingEscalation, lastEscalationResult |
| `listClaudeHistorySessions()` | 扫描 Claude 历史会话 | 读项目目录、解析 JSONL、缓存 | 文件系统 | history cache |
| `deleteClaudeHistoryFiles(sessions)` | 删除 Claude 历史文件 | UUID 校验、unlink、失效缓存 | 文件系统 | history cache |
| `runStartupCommands()` | 启动配置内后台会话 | 读取 config.startupCommands 并启动 | config + start() | 新 sessions |

---

## 2. 关键内部子流程

## 2.1 启动链路 `start()`

### 步骤
1. 解析/标准化 command 与 cwd
2. 校验命令前缀是否允许
3. 推断是否是 Claude 会话
4. 创建 `SessionRecord`
5. 创建 `ClaudePtyBridge`
6. 启动 `node-pty`
7. 绑定：
   - `onData`
   - `onExit`
   - bridge event handler
8. 注册 lifecycle
9. 做首轮持久化
10. 发出 `started` 事件

### 写入点
- 内存：`sessions.set(id, record)`
- DB：`saveSession()` 或 metadata 持久化
- 文件日志：metadata / messages / pty log
- WS：`started`, `output`, `status`, `task`

### 依赖边界
- 进程执行：`node-pty`
- 语义解析：`ClaudePtyBridge`
- 生命周期：`SessionLifecycleManager`
- 存储：`WandStorage`
- 诊断日志：`SessionLogger`

---

## 2.2 PTY 输出链路 `onData -> handleBridgeEvent`

### 原始链路
```text
PTY onData(chunk)
  -> bridge.processChunk(chunk)
    -> output.raw / output.chat / permission.prompt / session.id / chat.turn ...
  -> ProcessManager.handleBridgeEvent(...)
  -> emitEvent(...) to ws-broadcast
  -> schedulePersist(record)
```

### 这里同时发生的事
- 更新 raw output
- 更新结构化 messages
- 检测 permission blocked
- 抓取 Claude session id
- 更新 current task
- 写 pty log
- debounce 持久化

### 这是后续最适合拆分的地方
因为它同时包含：
- IO 路径
- 语义路径
- UI 状态路径
- 持久化路径

---

## 2.3 权限决策链路

### 入口
- `approvePermission()`
- `denyPermission()`
- `resolveEscalation()`
- `resolvePermission()`

### 过程
1. 从 `record.pendingEscalation` 读取当前请求
2. 可选校验 `requestId`
3. 写入 `lastEscalationResult`
4. 如果是 `approve_turn`，记录 remembered scopes/targets
5. 通过 bridge 或 PTY 直接写入确认输入
6. 清理 `pendingEscalation` / blocked 状态
7. persist

### 依赖边界
- bridge 在 Claude 会话中是主执行器
- 没有 bridge 时退回直接 PTY write

### 后续拆分建议
独立为 `escalation-manager`，让权限记忆、blocked 状态与审计结果从 `ProcessManager` 中抽离。

---

## 2.4 恢复与历史扫描链路

### 当前涉及职责
- 从 snapshot 判断是否可恢复
- 从 Claude 项目历史文件判断是否存在真实对话
- 扫描 `.jsonl` 文件并识别 session id
- 构造 resume command
- 启动新的 resumed session

### 当前问题
恢复逻辑分布在：
- `process-manager.ts` 的一组判定函数
- `ClaudePtyBridge` 的 session id 捕获
- `storage.ts` 的 `getLatestSessionByClaudeSessionId()`
- `server.ts` 的 `/resume` 路由

### 后续拆分建议
- `resume-policy.ts`：负责能否恢复
- `resume-discovery.ts`：负责磁盘扫描与候选发现
- `resume-launch.ts`：负责真正启动 resumed session

---

## 3. 内部字段归属表

| 字段 | 归属职责 | 说明 |
|---|---|---|
| `ptyProcess` | PTY 编排 | 实际运行的终端进程 |
| `childProcess` | 兼容执行/历史保留 | 当前代码中更多是兼容位 |
| `messages` | chat 语义状态 | bridge 派生出的结构化消息 |
| `storedOutput` | 恢复兼容 | 启动时从 DB 带回的旧输出 |
| `pendingEscalation` | 权限审批 | 当前等待用户处理的 escalation |
| `lastEscalationResult` | 审计/历史 | 最近一次权限处理结果 |
| `rememberedEscalationScopes` | 权限审批策略 | approve_turn 的 turn 内记忆 |
| `rememberedEscalationTargets` | 权限审批策略 | approve_turn 的 target 记忆 |
| `currentTask` | UI 展示 | 当前工具任务标题 |
| `taskDebounceTimer` | UI 节流 | task 更新防抖 |
| `claudeTaskDiscoveryTimer` | 恢复发现 | Claude 可恢复任务发现重试 |
| `knownClaudeTaskIds` | 恢复发现 | 启动前已知任务 ID |
| `knownClaudeProjectMtimes` | 恢复发现 | 启动前文件时间戳 |
| `confirmWindow` | 旧权限/确认启发式 | 仅 bridge 缺席时的兼容逻辑 |
| `lastAutoConfirmAt` | 权限审批策略 | 自动确认节流 |
| `autoApprovePermissions` | 权限审批策略 | 当前会话是否自动审批 |
| `stopRequested` | 运行生命周期 | stop 与异步 exit 协调 |

---

## 4. 建议拆分顺序

### 第一批（低风险）
1. 抽 `resume-policy`
2. 抽 `escalation-manager`
3. 抽 `session-persistence`

### 第二批（中风险）
4. 抽 `pty-session-runner`
5. 抽 Claude history discovery

### 第三批（高风险）
6. 收敛 `SessionRecord` 结构
7. 减少 `ProcessManager` 对全部字段的直接写权限

---

## 5. 这个文档的用途

后续动 `ProcessManager` 时，必须先回答两个问题：

1. 这次改动动的是哪一类职责？
2. 它会不会顺带影响恢复、权限、持久化或聊天语义？

如果不能快速回答，说明改动边界还没有划清，不应该直接重构。
