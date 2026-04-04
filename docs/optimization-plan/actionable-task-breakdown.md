# 执行版任务拆解

这份文档把“优化与排查计划”进一步拆成可以直接开工的任务列表。目标是让后续执行时，不需要再从大段分析中提炼动作，而是可以按优先级、依赖关系和验收标准逐项推进。

---

## 1. 使用方式

建议按下面顺序执行：

1. 先完成 **阶段 A：证据与观测补齐**
2. 再进入 **阶段 B：低风险收敛**
3. 最后做 **阶段 C：结构性重构**

每个任务都包含：

- 目标
- 涉及文件
- 前置依赖
- 输出物
- 验收标准
- 风险提示

---

## 2. 总体节奏

| 阶段 | 目标 | 原则 |
|---|---|---|
| A | 先把问题看清楚 | 不改核心行为，优先补证据 |
| B | 先降低脆弱性 | 小步收敛、减少竞态与重复状态 |
| C | 再拆结构 | 在证据和边界清晰后再重构 |

---

# 阶段 A：证据与观测补齐

## A1. 梳理 `ProcessManager` 职责地图

### 目标
把 `ProcessManager` 当前承担的职责拆成清晰的责任区，作为后续拆分基础。

### 涉及文件
- `src/process-manager.ts`
- 参考：`src/storage.ts`, `src/session-lifecycle.ts`, `src/session-logger.ts`, `src/claude-pty-bridge.ts`

### 前置依赖
- 无

### 输出物
- 一份职责映射表：入口方法 -> 子流程 -> 依赖模块 -> 写入状态
- 一份内部字段归属表：每个字段属于哪类职责

### 验收标准
- 能回答每个公共入口（如 start/sendInput/stop/delete/approve/resume）分别触发哪些子流程
- 能把内部职责至少拆成 4 类：PTY 编排 / 恢复发现 / 权限审批 / 持久化日志

### 风险提示
- 这个任务不应直接改代码结构
- 重点是建立“后续拆分的证据链”

---

## A2. 建立 Claude PTY 输出样本集

### 目标
为聊天解析、权限检测、session id 捕获、resume 判定建立可回放样本。

### 涉及文件
- `src/claude-pty-bridge.ts`
- `src/message-parser.ts`
- `src/process-manager.ts`

### 前置依赖
- A1 完成后更容易理解关键场景，但不是硬依赖

### 输出物
- 样本分类清单：
  - 普通问答
  - 工具调用
  - 权限请求
  - resume
  - 异常退出
- 每类样本对应的预期解析结果

### 验收标准
- 同一份样本可以同时用于验证：
  - raw output
  - `ConversationTurn[]`
  - fallback `ChatMessage[]`
- 样本命名和来源清晰，后续 Claude 升级时可重复回放

### 风险提示
- 样本应尽量来自真实运行输出，而不是手工拼接文本

---

## A3. 梳理前端同步通道与竞态点

### 目标
确认前端哪些数据来自 REST、哪些来自 polling、哪些来自 WebSocket，并找出覆盖关系与竞态点。

### 涉及文件
- `src/web-ui/content/scripts.js`
- `src/ws-broadcast.ts`
- `src/server.ts`

### 前置依赖
- 无

### 输出物
- 数据源矩阵：UI 区域 -> 数据来源 -> 刷新方式
- 时序图：首屏恢复、切换 session、断线重连、长输出流

### 验收标准
- 能明确指出 polling 与 WS 哪些场景会同时更新同一块状态
- 能列出最容易发生覆盖/闪回的 3 个点

### 风险提示
- 不要急着删 polling 或强推 WS，先把边界梳理清楚

---

## A4. 明确 source of truth

### 目标
回答“同一份信息到底以哪里为准”。

### 涉及文件
- `src/storage.ts`
- `src/session-logger.ts`
- `src/process-manager.ts`
- `src/claude-pty-bridge.ts`
- `src/web-ui/content/scripts.js`

### 前置依赖
- A1, A2, A3

### 输出物
- 一张真值来源表：
  - raw output
  - messages
  - lifecycle
  - permission state
  - task title
  - claudeSessionId
  - resume 关系

### 验收标准
- 发生不一致时，能明确知道应该先看哪里
- 前端 terminal/chat 两个视图分别依赖什么，必须可以一句话说清楚

### 风险提示
- 这里要先写规则，不一定立刻改实现

---

# 阶段 B：低风险收敛

## B1. 收缩权限/确认 regex 检测边界

### 目标
降低误判普通文本为权限 prompt 的概率。

### 涉及文件
- `src/process-manager.ts`
- `src/claude-pty-bridge.ts`

### 前置依赖
- A2 样本集

### 输出物
- 正则风险分级表
- 一版收缩后的启发式策略

### 验收标准
- 高风险宽泛匹配（如自然语言句式）被替换或加上下文门槛
- 样本回放中不出现新增误判

### 风险提示
- 改太猛可能导致真正的权限请求被漏检

---

## B2. 明确 chat/terminal 主模型

### 目标
把 raw output、`ConversationTurn[]`、fallback `ChatMessage[]` 的主次关系固定下来。

### 涉及文件
- `src/claude-pty-bridge.ts`
- `src/message-parser.ts`
- `src/server.ts`
- `src/web-ui/content/scripts.js`

### 前置依赖
- A2, A4

### 输出物
- 一份数据模型约定
- fallback 触发范围收缩方案

### 验收标准
- terminal 只依赖 raw output
- chat 优先依赖 `ConversationTurn[]`
- fallback parser 只在明确兼容场景下触发

### 风险提示
- 不要一次删掉 fallback，先缩小作用面

---

## B3. 收敛前端同步主通道

### 目标
降低 polling 与 WebSocket 平级竞争同一状态的复杂度。

### 涉及文件
- `src/web-ui/content/scripts.js`
- `src/ws-broadcast.ts`
- `src/server.ts`

### 前置依赖
- A3, A4

### 输出物
- 主同步策略说明
- polling 降级为兜底后的场景定义

### 验收标准
- 首屏、断线重连、长输出流三类路径下，数据来源优先级明确
- 不再出现“旧快照覆盖新 WS 增量”的已知路径

### 风险提示
- 需要谨慎验证离线、断线和浏览器挂后台恢复场景

---

## B4. 降低同步 IO 与热路径重复写入

### 目标
降低大文件扫描、频繁写日志/DB 带来的事件循环压力。

### 涉及文件
- `src/process-manager.ts`
- `src/storage.ts`
- `src/session-logger.ts`
- `src/server.ts`

### 前置依赖
- A1, A4

### 输出物
- 热路径 IO 清单
- 哪些路径需要 async 化 / 节流 / 限流的方案

### 验收标准
- 能识别出最重的同步 IO 点
- 给出明确替换顺序，不一口气全改

### 风险提示
- IO 优化容易改变时序，必须结合恢复和会话退出场景回归

---

# 阶段 C：结构性重构

## C1. 拆分 `ProcessManager`

### 目标
把运行时超级对象拆成职责明确的协作模块。

### 建议拆分方向
- `pty-session-runner`
- `resume-discovery` / `resume-policy`
- `escalation-manager`
- `session-persistence`

### 涉及文件
- `src/process-manager.ts`
- 配套涉及：`src/storage.ts`, `src/session-lifecycle.ts`, `src/session-logger.ts`, `src/claude-pty-bridge.ts`

### 前置依赖
- A1, A4, B1, B4

### 输出物
- 模块边界定义
- 拆分后的依赖图

### 验收标准
- 旧 API 行为不变
- 恢复、权限、输入输出、删除链路回归通过

### 风险提示
- 这是最高风险的结构改动，必须放在证据充分之后

---

## C2. 拆分 `server.ts`

### 目标
把装配层与业务路由职责拆开。

### 建议拆分方向
- auth routes
- settings/system routes
- sessions routes
- claude history routes
- file routes

### 涉及文件
- `src/server.ts`
- `src/middleware/*`
- `src/ws-broadcast.ts`
- `src/pwa.ts`

### 前置依赖
- A3, B3

### 输出物
- route -> service 分层结构

### 验收标准
- 所有 `/api/*` 接口兼容
- 启动流程与 WebSocket 装配不变

### 风险提示
- 不要把“拆文件”当成目的，重点是边界清晰

---

## C3. 收敛前端状态对象

### 目标
把 `scripts.js` 的单个大状态对象拆成更清楚的状态域。

### 建议状态域
- transport state
- session store
- terminal state
- ui/modal state
- file browser state
- claude history state

### 涉及文件
- `src/web-ui/content/scripts.js`

### 前置依赖
- A3, B3

### 输出物
- 前端状态分层方案
- 关键渲染路径刷新边界说明

### 验收标准
- session 切换、断线重连、terminal/chat 切换不再依赖全局大状态的隐式副作用

### 风险提示
- 前端状态改造容易引入 UI 回归，要优先做在 shell 和 transport 边界清晰之后

---

# 3. 建议先开的第一批任务

如果现在就要开始执行，建议先开这 5 个任务：

1. **A1**：ProcessManager 职责地图
2. **A2**：Claude PTY 样本集
3. **A3**：前端同步通道矩阵
4. **A4**：source of truth 表
5. **B1**：权限 regex 风险分级

这 5 个任务完成后，后面的优化优先级基本就不会跑偏。

---

# 4. 完成定义（Definition of Done）

只有同时满足下面几条，才算这轮治理真的进入可执行状态：

1. 有样本、有时序图、有 source-of-truth 表
2. 恢复、权限、消息解析三条链路都能讲清楚
3. 能明确指出哪些改动是低风险收敛，哪些是结构性重构
4. 每个重构任务都有对应回归场景
5. 不再需要靠“重新通读整个文件”才能理解某个问题在哪一层

---

# 5. 一句话建议

现在最值得做的不是立刻重构，而是：

**先把核心链路证据化、样本化、可回放化。**

这样后面无论是收敛 regex、减少同步 IO、还是拆 `ProcessManager`，都不会变成盲改。
