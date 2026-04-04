# 系统审计与优化总计划

这份文档基于当前代码的真实实现，整理出 **最不合理、最脆弱、最值得优先排查** 的部分，并给出后续优化的详细计划。目标不是先改代码，而是先明确：

1. 哪些问题最值得优先投入
2. 它们为什么会出问题
3. 影响范围在哪里
4. 应该如何排查
5. 后续怎样低风险落地优化

---

## 一、总体判断

当前项目最大的问题不是“少几个工具函数”或者“某个页面写得丑”，而是以下几类 **跨模块结构性问题**：

1. **运行时核心职责过载**
   - `src/process-manager.ts` 和 `src/server.ts` 承担了过多职责
   - 单个文件里同时混合会话编排、恢复、权限、持久化、日志、API、更新、PWA 等逻辑

2. **对 PTY 文本启发式解析依赖过重**
   - `src/claude-pty-bridge.ts` 与 `src/message-parser.ts` 都在从终端文本中推导更高层语义
   - session id、权限请求、回复完成、消息边界都依赖正则/文本模式

3. **状态同步通道过多且边界不清**
   - 前端同时依赖 REST、WebSocket、polling、PWA/Service Worker
   - 后端同时保留 raw output、`ConversationTurn[]`、降级 `ChatMessage[]`
   - 容易产生竞态、重复刷新和视图不一致

4. **持久化与日志层次复杂**
   - SQLite、文件日志、内存状态三套表示并行存在
   - 恢复逻辑还额外依赖 Claude 自己的项目文件

5. **部分路径有同步 IO 和隐式契约问题**
   - 某些关键运行路径包含同步文件读取/解析、同步写文件、宽泛错误吞掉
   - 很多前后端契约靠“约定字段存在”而不是显式边界来维持

---

## 二、优先级矩阵

| 优先级 | 主题 | 核心文件 | 主要风险 |
|---|---|---|---|
| P0 | 运行时核心过载 | `src/process-manager.ts`, `src/server.ts` | 维护成本高、修改一处影响全局、排障困难 |
| P0 | PTY 启发式解析脆弱 | `src/claude-pty-bridge.ts`, `src/message-parser.ts` | Claude 输出变动即可能失效、权限/消息边界误判 |
| P1 | 同步通道与状态重复 | `src/web-ui/content/scripts.js`, `src/ws-broadcast.ts`, `src/server.ts` | polling/WS 竞态、terminal/chat 数据不一致 |
| P1 | 持久化与恢复边界复杂 | `src/storage.ts`, `src/session-logger.ts`, `src/process-manager.ts` | 恢复失败、历史会话异常、定位复杂 |
| P1 | 配置与运行期数据边界不清 | `src/config.ts`, `src/storage.ts` | 配置重写副作用、来源不透明 |
| P2 | 安全与运维治理 | `src/auth.ts`, `src/cert.ts`, `src/pwa.ts` | token 生命周期、证书策略、更新体验不稳 |

---

## 三、详细问题清单

## P0-1. `ProcessManager` 职责过重，已经是运行时“超级对象”

### 涉及文件
- `src/process-manager.ts`
- 间接耦合：`src/claude-pty-bridge.ts`, `src/storage.ts`, `src/session-lifecycle.ts`, `src/session-logger.ts`

### 当前现象
`ProcessManager` 同时负责：

- 启动与停止 PTY
- 会话注册与删除
- Claude 恢复判断与恢复启动
- 权限审批状态管理
- 自动批准策略
- 日志写入
- 生命周期状态更新
- SQLite 持久化
- 任务标题/工具状态追踪
- Claude 历史扫描

### 为什么不合理
这是典型的“业务中枢 + 状态中枢 + 流程中枢 + IO 中枢”混合体，带来几个问题：

1. 任意需求都容易继续往里面塞
2. 单元测试边界很难切
3. 一个小改动可能连带影响：恢复、权限、聊天视图、日志、数据库
4. 很多判断函数只是名字不同，本质在重复包装同一语义，后续极易漂移

### 风险
- 新功能和修复成本持续上升
- 某些线上异常只能靠“通读整个文件”定位
- 未来重构代价越来越大

### 排查计划
1. 统计当前 `ProcessManager` 的外部入口（start/sendInput/stop/delete/approve/resolve...）
2. 画出每个入口触发的子流程
3. 找出真正的四类职责边界：
   - PTY 编排
   - 恢复/历史扫描
   - 权限/审批策略
   - 持久化/日志同步
4. 确认哪些内部字段只属于某一类职责

### 优化建议
- 第一阶段不拆文件，先做“内部职责标记”和方法分组
- 第二阶段抽离：
  - `resume-policy` / `resume-discovery`
  - `escalation-manager`
  - `session-persistence`
  - `pty-session-runner`

### 验证方式
- 拆分后保持现有 API 行为不变
- 恢复、权限审批、输入输出、删除会话四条核心链路逐条回归

---

## P0-2. Claude 输出解析高度依赖启发式文本模式，脆弱性高

### 涉及文件
- `src/claude-pty-bridge.ts`
- `src/message-parser.ts`
- `src/process-manager.ts` 中的 prompt 检测正则

### 当前现象
系统依赖 PTY 输出文本来推断：

- assistant 回复边界
- 会话 session UUID
- 权限请求及 scope
- 当前任务标题
- 是否可以 resume

并且项目里有两套解析路径：

- `ClaudePtyBridge` -> `ConversationTurn[]`
- `message-parser.ts` -> `ChatMessage[]`

### 为什么不合理
1. Claude CLI 只要改一点输出样式，解析器就可能错
2. 权限与消息解析共用同一文本流，互相干扰的可能性高
3. 双解析器天然会漂移
4. `process-manager.ts` 中还有一套宽泛正则辅助判断 prompt，容易误伤普通文本

### 风险
- chat 视图与 terminal 视图不一致
- 权限卡片误触发 / 不触发
- 恢复按钮出现条件错误
- 某些回复被截断、拼接错位、落错 turn

### 排查计划
1. 采集真实 PTY 输出样本，按场景分类：
   - 普通问答
   - 工具调用
   - 权限请求
   - resume
   - 异常退出
2. 用样本回放验证：
   - `ClaudePtyBridge` 输出是否稳定
   - `message-parser.ts` 是否与 Bridge 保持一致
3. 整理所有正则与启发式条件，标记：
   - 高风险（宽泛）
   - 中风险（结构性）
   - 低风险（固定协议）

### 优化建议
- 明确 `ConversationTurn[]` 为主表示，`ChatMessage[]` 只做兼容兜底
- 把权限检测与消息检测的文本上下文分开
- 收缩宽泛 prompt regex，仅在明确上下文下启用
- 建立解析快照测试样本集

### 验证方式
- 同一份 PTY 样本输入，terminal/raw、Bridge turn、fallback message 三者结果可比对
- Claude 升级后只需跑样本集即可发现兼容性问题

---

## P0-3. `server.ts` 依旧是过载的装配根文件

### 涉及文件
- `src/server.ts`
- `src/middleware/*`
- `src/ws-broadcast.ts`
- `src/pwa.ts`

### 当前现象
`server.ts` 负责：

- Express app 初始化
- 登录/登出/设置密码
- config/settings 更新
- 证书上传
- npm 更新检查与安装
- 会话列表/详情/恢复/删除
- Claude history 扫描/删除/隐藏
- 文件浏览/文件预览/收藏/最近路径/搜索
- PWA 端点
- WebSocketServer 装配

### 为什么不合理
虽然部分逻辑已拆到 `middleware`、`ws-broadcast`、`pwa`，但从工程边界看，它依旧是一个“大而全的入口文件”。

### 风险
- 加任何新 API 都很自然地往这里堆
- 很难把“路由层”和“服务层”分开排查
- 某些同步操作/外部命令执行藏在请求处理路径里，不容易统一治理

### 排查计划
1. 给路由按职责分组：auth / settings / sessions / claude-history / files / system
2. 标记每个路由是否：
   - 读数据库
   - 写数据库
   - 启动子进程
   - 读文件系统
   - 写文件系统
   - 调外部命令
3. 找出最适合先抽离为 service 的两组路由

### 优化建议
- 第一阶段先拆 route registration，不改行为
- 第二阶段再抽 service 层
- 更新检查、Claude history 与文件浏览建议优先拆出

### 验证方式
- 所有 `/api/*` 行为保持兼容
- WebSocket 装配不受影响

---

## P1-1. 前端状态过于集中，且同步通道重复

### 涉及文件
- `src/web-ui/content/scripts.js`
- `src/ws-broadcast.ts`
- `src/server.ts`

### 当前现象
浏览器端维护一个巨大的 `state` 对象，包含：

- 登录状态
- session 选择
- terminal 实例
- polling / websocket 状态
- modal 状态
- 文件浏览状态
- Claude history 状态
- drafts
- notification / offline / install prompt

并且登录恢复后会同时：

- `startPolling()`
- `refreshAll()`
- 建立 WS 连接

### 为什么不合理
1. 一个状态对象承载过多关注点
2. 很容易出现“轮询刷新覆盖 WebSocket 新数据”的竞态
3. 某些 UI 异常可能不是 UI 本身，而是数据同步顺序问题

### 风险
- session 切换后视图错乱
- 终端输出、消息列表、任务状态更新时序不一致
- 重连后状态闪烁或回退

### 排查计划
1. 梳理前端所有数据来源：
   - 首屏 REST
   - 定时 polling
   - WebSocket init
   - WebSocket 增量事件
2. 标记每个 UI 区域分别依赖哪个数据源
3. 重点核查：
   - selectedId 切换
   - reconnect 后 init + output 的先后顺序
   - chat/terminal 视图切换是否共享同一事实来源

### 优化建议
- 建立最小会话事实源（snapshot store）
- 让 polling 只兜底，不再与 WS 平级争抢主导权
- 拆分前端 state：transport / ui / terminal / file-panel / claude-history

### 验证方式
- 断线重连、快速切换 session、长输出流三类场景回归

---

## P1-2. chat 与 terminal 的数据源边界仍然复杂

### 涉及文件
- `src/claude-pty-bridge.ts`
- `src/message-parser.ts`
- `src/server.ts`
- `src/web-ui/content/scripts.js`

### 当前现象
项目同时维护：

- raw output
- `ConversationTurn[]`
- fallback `ChatMessage[]`

### 为什么不合理
这三者虽然有各自用途，但没有被严格定义为“主源 / 派生 / 兜底”，长期会增加排障复杂度。

### 风险
- 接口返回的消息和实时 WS 的消息结构不一致
- 历史会话与实时会话渲染效果不同
- 某些 session 只在一种视图下正常

### 排查计划
1. 列出所有读取 `output` 的地方
2. 列出所有读取 `messages` 的地方
3. 列出 fallback 触发条件
4. 找出所有“同一页面上，某个模块可能同时依赖 output 与 messages”的情况

### 优化建议
- 在文档与代码中明确：
  - raw output 只服务 terminal
  - `ConversationTurn[]` 只服务 chat
  - fallback parser 只作为迁移兼容层
- 后续逐步减少 fallback parser 触发面

---

## P1-3. 持久化与日志层的 source of truth 不够明确

### 涉及文件
- `src/storage.ts`
- `src/session-logger.ts`
- `src/process-manager.ts`

### 当前现象
会话相关数据会同时出现在：

- 内存 `SessionRecord`
- SQLite `command_sessions`
- 文件日志目录下的 `pty-output.log`, `messages.json`, `metadata.json`

### 为什么不合理
虽然三层并行有其价值，但目前更像是“都存一份”，而不是“每层各自承担清晰职责”。

### 风险
- 发生不一致时不清楚谁是准的
- 恢复与排障要同时看三处
- 后续如果改消息结构，三处都要同步迁移

### 排查计划
1. 明确每类数据的 authoritative source：
   - output
   - messages
   - lifecycle
   - task
   - permission state
2. 找出现在哪些时机会先写日志、后写 DB，或反之
3. 分析异常中断时可能出现的三层不一致情形

### 优化建议
- 规定：数据库用于 API/恢复；日志用于诊断；内存用于实时运行
- 减少热路径重复写入
- 对关键字段增加一致性检查工具（后续实现）

---

## P1-4. `config.ts` 与 `storage.ts` 对“配置”的边界不透明

### 涉及文件
- `src/config.ts`
- `src/storage.ts`
- `src/server.ts`

### 当前现象
有些配置在 `config.json`：
- host / port / shell / defaultMode / defaultCwd / https

有些偏好和覆盖值在 SQLite `app_config`：
- password
- favorite_paths
- recent_paths
- hidden Claude session ids

### 为什么不合理
从使用者角度，“配置”被拆成了两套系统；而从维护者角度，排查“值从哪里来的”并不直观。

另外 `ensureConfig()` 会读取、merge、规范化后写回文件，也可能让人误以为配置文件被系统“自动改了”。

### 风险
- 设置页修改后来源难追踪
- 密码实际取值优先级不透明
- 配置文件可能被规范化重写，引起误解

### 排查计划
1. 列出所有 config 来源及优先级
2. 标记哪些字段是“启动配置”，哪些是“运行期应用数据”
3. 记录哪些字段可以通过 CLI 改，哪些只能通过 API 改

### 优化建议
- 文档上先明确边界
- 后续实现上区分：
  - static config
  - runtime preferences
  - secure secrets / auth state
- 减少 `ensureConfig()` 的自动写回频率

---

## P2-1. token、证书与 PWA 的安全/运维治理需要补齐

### 涉及文件
- `src/auth.ts`
- `src/cert.ts`
- `src/pwa.ts`
- `src/web-ui/content/scripts.js`

### 当前现象
- token 生命周期是内存 + SQLite 双层
- 自签证书支持 openssl 与 fallback 生成
- PWA Service Worker 由后端动态生成，前端通过 fetch + register 注册

### 为什么不合理
这些功能并不是“实现错误”，但缺少一份明确的治理与排查方案：

- token 清理和恢复策略是否足够清楚
- 自签证书是否足够兼容，出现浏览器异常时如何定位
- Service Worker 版本与页面 reload 时机是否足够稳定

### 风险
- 本地环境偶发 HTTPS / SW 异常难排查
- 登录态重启后行为不符合预期
- 页面升级体验不稳定

### 排查计划
1. 审计 token 生成、校验、过期与持久化恢复路径
2. 审计证书生成、加载、替换、文件权限与浏览器兼容路径
3. 审计 SW 缓存、激活、reload 机制

### 优化建议
- 补充运维级文档和故障排查步骤
- 在关键节点增加更可读的日志与状态提示

---

## 四、优先排查顺序

建议不要平均用力，而是按下面顺序推进：

### 第一阶段：证据收集与定位
1. `ProcessManager` 运行职责分解
2. Claude PTY 解析样本采集与回放验证
3. 前端 polling / WS 数据流与竞态梳理
4. 持久化 source-of-truth 边界梳理

### 第二阶段：低风险收敛
1. 缩减宽泛 regex 检测
2. 明确主消息模型
3. 收敛前端同步入口
4. 减少同步 IO 与热路径重复写入

### 第三阶段：结构性拆分
1. 拆 `ProcessManager`
2. 拆 `server.ts` 的 route/service 边界
3. 把恢复/权限/持久化抽成独立模块
4. 收敛前端大状态对象

---

## 五、实施原则

1. **先补观察，再动核心逻辑**
   - 没证据时不要先重构最核心路径

2. **先统一事实源，再优化展示层**
   - 先解决状态和数据表示，再动 UI

3. **先做低风险边界收敛，再拆大文件**
   - 否则容易在重构中引入新回归

4. **所有优化都必须能对应到回归场景**
   - 新建会话
   - 普通聊天
   - 工具调用
   - 权限审批
   - 恢复会话
   - 长时间输出
   - 断线重连

---

## 六、预期交付结果

如果按这份计划推进，最终应该达到：

- 能清楚回答某个状态/消息/权限/恢复信息到底以哪里为准
- 能快速定位 terminal/chat 不一致到底卡在哪一层
- Claude 输出变化时能通过样本测试快速发现兼容性问题
- 前后端同步路径更少、更清晰
- 核心运行时从“大对象 + 大文件”逐步过渡到职责更清晰的结构
