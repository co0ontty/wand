# 重构路线图

这份路线图的目标不是一次性把系统“重写干净”，而是把高风险问题拆成几个可执行阶段，优先降低排障成本和回归风险。

---

## 阶段 0：只补证据，不改核心行为

### 目标
在不大改逻辑的前提下，先确认哪些问题是真正高频、哪些只是设计隐患。

### 建议动作
1. 给会话恢复链路补耗时与失败原因统计
2. 给权限检测补识别日志与误判样本收集
3. 给 WebSocket / polling 补事件时序日志
4. 给持久化补轻量耗时与失败统计
5. 建一个 PTY 输出样本集，用于解析器回放验证

### 产出
- 问题画像从“猜测”变成“有证据”
- 能明确下一阶段该先动哪一条链路

---

## 阶段 1：低风险收敛

### 目标
不大拆架构，先降低脆弱性和重复状态。

### 建议动作
1. 明确消息模型优先级
   - `ConversationTurn[]` 为 chat 主表示
   - raw output 为 terminal 主表示
   - fallback parser 仅保留兜底角色

2. 收缩权限/确认 regex 边界
   - 删除明显过宽的自然语言匹配
   - 只在明确上下文下启用

3. 收敛前端数据同步主通道
   - 把 WebSocket 定义成实时主通道
   - polling 降级为兜底同步

4. 明确 source of truth
   - DB、日志、内存分别负责什么

### 产出
- 更稳定的 chat/terminal 一致性
- 更低的误判与竞态概率
- 后续拆分前先把行为边界固定住

---

## 阶段 2：拆分运行时核心

### 目标
把最危险的大文件/大对象从“什么都管”拆成职责更清楚的模块。

### 优先拆分对象

#### 2.1 `ProcessManager`
建议拆成至少四块：
- `pty-session-runner`
- `resume-discovery` / `resume-policy`
- `escalation-manager`
- `session-persistence`

#### 2.2 `server.ts`
先按路由职责拆：
- auth routes
- settings/system routes
- sessions routes
- claude history routes
- file routes

### 注意事项
- 先拆 registration 和 service 接口，不改外部 API
- 拆分后保持 `server.ts` 仍作为装配根

### 产出
- 文件职责清晰
- 单点改动影响面下降
- 更容易分别测试恢复、权限、持久化

---

## 阶段 3：治理解析与恢复模型

### 目标
降低对 Claude PTY 文本细节的脆弱依赖。

### 建议动作
1. 建立解析样本回放测试
2. 收敛双解析器
3. 把“会话能否恢复”的判定逻辑变成单一策略模块
4. 把 Claude 历史扫描改成更可控的异步/限流流程

### 产出
- Claude 升级后更容易快速发现兼容性问题
- 恢复逻辑更可维护
- 解析问题能更快定位

---

## 阶段 4：前端状态与壳层能力治理

### 目标
降低 `scripts.js` 大状态对象带来的维护成本。

### 建议动作
1. 把前端状态分层：
   - transport state
   - session store
   - terminal state
   - modal/ui state
   - file browser state
2. 明确 render 的最小刷新单元
3. 审计 Service Worker 与页面刷新机制
4. 审计 reconnect 与消息队列行为

### 产出
- session 切换与断线重连更稳定
- UI 问题更容易定位到具体状态域

---

## 推荐执行顺序

### 最应该先做
1. 解析样本与恢复链路观测
2. 前端 WS / polling 数据流时序梳理
3. `ProcessManager` 内部职责映射

### 第二批再做
1. regex 收敛
2. source-of-truth 明确化
3. 低风险 route/service 拆分

### 最后再做
1. 结构性大拆分
2. 前端状态体系重构
3. 配置系统统一化

---

## 风险控制原则

1. 每次只动一条主链路
2. 先有样本和回归场景，再重构
3. 对恢复、权限、消息解析三条链路保持额外谨慎
4. 拆文件不等于完成治理，重点是边界清晰而不是文件数变多

---

## 最终目标

最终希望系统达到：

- `server.ts` 只做装配，不承担过多业务判断
- `ProcessManager` 不再是所有运行时职责的唯一容器
- chat / terminal / restore / permission 都有清晰的事实源与测试样本
- 前端同步机制减少、状态边界明确
- 排障时可以快速判断问题落在：解析、同步、持久化、恢复还是 UI 层
