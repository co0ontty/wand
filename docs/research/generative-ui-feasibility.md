# React Generative UI 在 Wand 中的可行性研究

## 结论

**有条件可行，建议推进一个 Web 优先、会话绑定、无业务副作用的 MVP；不建议照搬附件的独立应用架构。**

附件最值得保留的不是技术栈，而是：**模型只生成受限的声明式数据，Wand 负责校验、渲染、计算和授权。** 它适合做对话中的计算器、参数面板、结果摘要和有限的交互表单，不等于让 AI 任意生成 React 应用，也不能直接替代项目已有的任务、设置和员工管理界面。

- **技术可行性高**：项目已有 React 19、Ant Design 6、结构化会话、工具语义投影、WebSocket、SQLite 和模型候选调用设施。
- **直接移植可行性低**：Fastify/Vite/Zustand/PostgreSQL/SSE 都不是这项能力在 Wand 中的必要前置；另建服务与模型调用链会重复现有职责。
- **主要难点不在五个控件**：在 UI 与真实源会话绑定、历史版本、异步竞态、输入恢复、动作权限、消息裁剪及原生端兼容。
- **建议首版**：Text / Metric / Slider / Select / Button；Button 只做本地重置或明确保存参数，不触发任意业务工具；完整 Surface 替换，暂不做 Patch、图表和自由布局。
- **估算**：演示性原型约 3–5 人日；可在 Wand 中交付的 Web MVP 约 15–25 人日。都是单名熟悉仓库开发者的工程估算，不是实测工时或承诺，不包含三套原生交互渲染和所有 CLI 接入。

本轮只研究并新增文档；没有实施功能、重启服务、安装设备、调用真实生成模型或正式发布。

## 1. 研究基线与证据边界

研究输入：`.wand-uploads/1791636807442-2479e5a6-react-generative-ui-mvp.md`。

检查时主仓 HEAD 为 `ec13fef`，`package.json` 版本为 `4.89.5-debug.t10101604`。工作树并非该提交的纯净版本：199 个 M、2 个 D、68 个未跟踪条目，Android/iOS 子模块也有既有改动；macOS 当时干净。以下以**检查时工作树源码**为依据，未覆盖、提交或清理既有工作。并行工作可能继续改变基线。

已运行：

```bash
node --test --import tsx \
  tests/structured-client-protocol.test.ts \
  tests/chat-renderer-unification.test.ts \
  tests/long-session-transport.test.ts
```

结果 **14/14 通过**。日志留在 `output/generative-ui-feasibility/baseline-tests.log`。这些测试只证明现有相关基础回归通过，**不证明 Generative UI 已实现或完成端到端验收**。本轮未做真实浏览器/原生设备验收、全量 check/test/build 或真实模型生成成功率测量。

## 2. 附件与项目实际情况的对照

| 附件设计 | Wand 现状 / 核查入口 | 建议 |
| --- | --- | --- |
| 独立 React + Vite 应用 | `package.json`、`scripts/bundle-browser.js`：React 19 + esbuild；现有 Web Shell 与会话宿主并存 | 在 `src/web-ui/react/` 新增按需模块，不新建第二套应用 |
| 自写五类 HTML 控件 | `react/ui/button.tsx`、`react/ui/select.tsx`、`react/theme.tsx`；安装的 Ant 已导出 Slider / Statistic | 复用 WandButton、WandSelect、Ant Slider / Statistic / Typography 和主题 |
| Zustand 全局 store | `react/conversations/state.ts`、`activity-repository.ts`：既有 repository + subscribe / useSyncExternalStore 模式；无直接 Zustand 依赖 | 单一 Surface repository 管状态，无需仅为此引入 Zustand |
| Fastify API | `src/server.ts`：Express，已有认证和 sessions/files/admin scope | 新增受控 Express 路由，复用认证；动作还需自己的对象归属与能力校验 |
| 直接 OpenAI Responses | `core-runner.ts`、`system-employee.ts`、`silicon-employee-draft.ts`：会话模型和系统候选是既有能力 | 会话内生成沿用该会话；独立系统生成按现有配置选择候选，不硬绑 OpenAI |
| SSE 第二阶段 | `browser/websocket.ts` 已有订阅、seq、resync；`session-transport.ts` 有 DTO 投影 | 用现有 WS 通道传有界通知，HTTP 读取权威快照；不要另起 SSE 恢复体系 |
| PostgreSQL 第二阶段 | `storage.ts` 使用 `node:sqlite`，集中管理数据 | 首个可交付版就加入 SQLite 持久化，不换数据库 |
| Surface Schema 即消息 | `types.ts` 的 ContentBlock 当前只有 text/thinking/tool_use/tool_result；语义类型有 question_request/task_list/decision | 增加明确的、服务端认可的 Surface 引用；不是在 Markdown 中猜 JSON |
| React 渲染即可全端 | Android Compose；iOS/macOS 有 Swift 原生 ChatView 与 ContentBlock 解析 | 协议可共用，渲染代码不能直接共用；先保证文本降级，再独立实现原生控件 |

### 不能低估的三个现有结构

1. **主会话不是一个纯 React 消息列表。** `browser/chat-render.ts` 仍生成业务宿主，`react/chat/presentation.tsx` 用 `createRoot`、slots 和 OwnedNode 接管库外观。只在 `message.tsx` 新增一个组件，不会自动接通消息生命周期；需要稳定挂载、更新、卸载及焦点保护。
2. **私聊的新消息默认独立开工。** `react/conversations/session-preview.tsx` 展示带 `sessionLink` 的回复，正文是有界 Markdown 预览；`types.ts` 的 `ConversationSessionPreview` 目前只有 status/text。用户说“再加一个参数”若作为普通新消息发送，并不保证找到原 UI。必须通过“修改此面板 / 继续此工作”绑定精确源会话与 Surface，或让用户明确选择目标，不能按最近时间/标题猜。
3. **消息会被裁剪与分页。** `message-truncator.ts` 会压缩工具输入/结果；调用和结果可能跨页。Surface 不应只存在于一大段工具 JSON 中，更不能依赖每次完整转录都在客户端。

## 3. 推荐产品范围

### 首版该做什么

在一条执行回复中展示一个“交互面板”：有清楚的标题、来源和保存状态。滑块与选项即时改变指标；调整参数不调用模型。用户要求修改结构时，明确继续该会话，传递当前面板版本与已确认的输入快照。

首个例子继续使用附件的投资收益计算器，作为技术验收数据而非金融建议。再加一个 Wand 场景（例如容量/成本估算面板）检验协议不是为单个例子写死。

| 组件 | 现成实现 | 首版约束 |
| --- | --- | --- |
| Text | Ant Typography | 纯文本，无 HTML、脚本或任意属性 |
| Metric | Ant Statistic / Typography | 数值、单位和有限格式枚举；不接受模型提供的 formatter 函数 |
| Slider | Ant Slider | 数值类型、有限范围、正步长；键盘与可读 label |
| Select | 共享 WandSelect | 有限选项，沿用 Portal 所有权与关闭行为 |
| Button | 共享 WandButton | 枚举动作；先只开放 reset / save，不接受 URL、命令或工具名 |

首版采用有界的单列布局即可。以后需要分组/两列时，增加有限的应用布局语义，不开放任意 CSS、React props、组件 import 或 DOM 事件处理代码。

### 首版明确不做

- 任意 HTML / JSX / JavaScript 执行、动态装载 npm 包、用户可编程表达式。
- 自动调用删除、发布、重启、任意 shell 或通用“执行工具”动作。
- 图表、递归任意布局、UI Patch、多人实时协同。
- 对 PTY 文本流自动提取 JSON 并执行。
- 同时改写 Wand 全部业务页面或强行统一所有平台的布局。

如果真正目标是“AI 生成完整网站并预览”，这是另一种产品：仓库已有 `server-local-preview-routes.ts` 的本机服务预览通道。它与受限 Schema UI 不是同一种信任模型，不能混称本方案的安全实现。

## 4. 推荐架构与接入方式

```text
用户在具体会话提出需求
  → 该会话实际选择的 Agent / 模型
  → 专用 publish_surface 能力（待新增，受选择与权限控制）
  → SurfaceService：大小/结构/语义/归属校验
  → SQLite 原子保存不可变版本 + 最新版本指针
  → 工具结果的服务端语义引用 + 文本摘要
  → 现有 HTTP/WS 投影
  → SurfaceRepository
  → 共享 React SurfaceRenderer

参数调整 → 本地受控状态/计算，不调用模型
明确保存 → 带 schemaRevision + stateRevision 的持久化请求
修改面板 → 原源会话 + 精确 Surface + 输入快照 + baseRevision
```

### 4.1 先做一个可靠的生成入口，不许悄悄换引擎

优先在显式启用的 Wand Agent / core 会话中接入专用发布工具。`core-runner.ts` 的 `buildTools()` 已有进程内 `decision_evaluate` 的先例，可借鉴有界输入、错误结果和取消机制；但 **publish_surface 当前不存在**，仍需新增会话能力配置和服务注入。

不支持的 CLI 保留文本降级，不静默改用 Wand Agent 或 OpenAI。后续可以参照 `employee-knowledge.ts` 的会话绑定、可撤销访问方式提供受控 CLI 入口；普通 API 登录凭据不直接交给模型。只有用户启用了相应工具能力时才可用，不能把有 shell 权限当作新增全部 UI 动作权限的授权。

如产品另设“生成面板”独立入口，可以复用配置化文本生成设施及系统员工候选，但应明确这是独立调用、使用什么候选；不能替换用户当前会话选定的模型。多供应商不保证都支持同样的 strict JSON Schema，仍需本地严格校验及清楚的失败状态。

### 4.2 采用“可信引用”，不要把任意工具文本当成可执行 UI

建议首版扩展 Wand-owned tool semantic，例如 `kind: "surface"`，携带 `surfaceId`、`schemaRevision` 和纯文本摘要。名称只是建议，不是现有协议。

**服务端只根据成功落库的发布记录生成该引用**，并绑定 `sourceSessionId + toolCallId`；工具输入中的名称、JSON、链接或模型自称的权限都不能作为信任证据。完整 Surface 经认证读接口按需获取，避免历史帧重复携带大量 Schema。

需要核对的链路：

- `types.ts`、`structured-client-protocol.ts`、`session-transport.ts`：有界引用及投影。
- `message-truncator.ts`：输入/结果被压缩后仍保留必要引用，孤立结果也可读取。
- `browser/chat-render.ts` + React 宿主：通用会话稳定挂载；不能在每个 WS 更新时重建滑块/焦点。
- `react/conversations/activity.tsx`、`session-preview.tsx`、`ai-teams/team-chat-view.tsx`：不同入口投影同一 owner，不复制 Surface 状态或执行器。
- 旧客户端：仍能读标题/摘要；不能指望未知 semantic 自动渲染可交互面板。

这是应用层协议扩展，不应无故修改 Render/terminald 协议或合并其生命周期。是否需要递增 Wand 客户端协议版本，要依据最终兼容策略决定；Surface 自己必须有独立的 schemaVersion。

### 4.3 数据所有权

建议新增表或等价 storage 原子入口：

| 数据 | 权威 owner / 作用 |
| --- | --- |
| Surface 身份、源会话、发布工具调用、最新 schemaRevision | 服务端分配和校验，模型不可决定 |
| 不可变 Surface 版本 | 可重放历史；旧消息固定引用当时版本，不悄悄被新版本改写 |
| 用户已保存值 + stateRevision | 服务端权威快照；与 UI 结构版本分开 |
| 当前拖动值、焦点、请求阶段 | 前端 repository 临时状态，不放到聊天 composer |
| 后续业务动作记录 | 持久 requestId、目标版本、执行阶段、结果或未知状态 |

`surfaceId` 全局不重复；客户端缓存键至少包含服务端身份、sourceSessionId、surfaceId，避免切换服务器串状态。历史 UI 默认只读，至少禁止保存和业务动作；如允许本地试算，应明确“不修改历史”。旧版本的“继续修改”产生新版本，不能覆盖旧记录。

首版至少持久化 Schema 和明确保存的参数；浏览器切换会话时保留未提交本地编辑。跨设备/刷新只承诺恢复已保存值，不能把未保存草稿冒充已同步。若要自动保存，可在后续用 change-complete/有界防抖提交，而不是滑动每一帧写库。

归档、删除、取消应让迟到发布/写入失效；清理遵守现有保留和删除策略，不因新增功能扫描清除旧会话数据。

### 4.4 版本与并发

- Schema 更新使用 `baseRevision`，服务端事务 compare-and-swap；模型输出不携带权威 revision，新版本由服务端递增。
- 已保存值更新使用独立 `stateRevision`；结构 revision 不能承担每一次滑动的数据版本。
- 两端同时提交旧基线，一方成功、另一方收到可恢复冲突；保留其本地输入，不静默覆盖。
- UI 重新生成前捕获输入快照；响应到达时若期间有新编辑，只合并仍兼容的字段，不覆盖新输入。
- 字段兼容不仅是 `typeof`：要核对稳定字段身份、类型、单位/含义、范围、step 和选项。类型相同但含义变化不能保留旧值。
- 区分“保留用户编辑”和“按用户指令重置”。附件始终用 old 值覆盖新 default，会让“把本金改成 20 万”失效；必须有明确 reset/migration 语义。
- WS 只通知版本变更，断线后用权威快照补齐；完整 JSON 校验通过前不安装半截 UI。

## 5. 附件本身需要补齐的事项

以下是方案缺口，不是声称生产 Wand 当前已存在相同漏洞。

| 优先级 | 附件现象 / 复现入口 | 影响与必要调整 |
| --- | --- | --- |
| P0 | generate API 的身份、归属、版本、持久化都是 TODO | 骨架不能直接上线；服务端确定身份与事务提交 |
| P0 | Button 只提交 surfaceId/actionId，忽略 HTTP 结果 | 没有输入快照、版本、请求去重与未知状态；不得连接有副作用动作 |
| P0 | 表面 Schema 没定义允许 actions，只有节点中的 actionId | 不能认为存在 actionId 就有权限；仅选服务端注册的有限能力 |
| P0 | install 未拒绝低版本；两个生成响应乱序到达 | 新界面会回滚；版本校验必须前后端都有 |
| P0 | 同名 surfaceId 是 store 的唯一隔离键 | 两个会话/服务器复用该 ID 会混合；需要服务端身份和会话边界 |
| P1 | Slider 允许缺失 bind、min > max、初值超范围；Select 可引用无效值 | Zod 结构通过不代表可渲染；补语义校验与写入时校验 |
| P1 | computed 允许任意键；Metric 只读取 computed，计算器只取 state | state 指标/计算依赖链没有契约；首版明确只支持数值 state 入参，不支持递归依赖 |
| P1 | component id、选项值可重复，state/computed 名称可冲突 | React key、引用和含义不确定；必须唯一并区分命名空间 |
| P1 | fields/title/label/key 等多处无长度或数量上限 | 50 个节点不等于有界 payload；加总字节、条目数、字符串、数值与计算预算 |
| P1 | setValue 无存在性、类型和范围校验 | 客户端公开写入口同样需要校验；服务器不信任客户端计算结果 |
| P1 | install 只看 typeof 并始终保留 old | 范围缩小/选项删除/含义变化失效；用户明确改默认也可能被旧值盖掉 |
| P1 | 无 remount、网络失败、重连、旧版本历史和多设备定义 | 这些是可交付 MVP 的必要工作，而不是全部留到生产化 |
| P2 | chart/append/parentId 只在第二阶段示例出现 | 不属于当前协议；不能把趋势图当首版已有能力 |

校验必须分层：请求体预算 → 严格字段/类型 → 引用/范围/唯一性 → 权限/归属 → CAS 事务 → 客户端防御校验。采用 Map 或无原型字典和 own-property 判断，禁止保留键，不能依靠 `key in state` 判断用户定义字段。

计算白名单值得保留。为每个 operator 明确入参数量、单位、上下界和精度；结果必须有限。投资示例的 JS 浮点公式可以用于演示，若用于真实金额决策，应另定小数/舍入规则，不能把显示四舍五入当财务精度保证。

### OpenAI strict 输出还有一个兼容问题

官方 Structured Outputs 文档要求 strict 模式的对象设置 `additionalProperties: false`，属性为 required，且只支持 JSON Schema 的子集。附件的 `state: z.record(...)`、`computed: z.record(...)` 是开放键字典，**不能直接假定转换后就能用于 strict Responses Schema**。

建议：给模型的格式采用固定字段对象 + 有界数组，例如 `fields: [{id, type, defaultValue, ...}]`、`computed: [{id, operator, args}]`，校验唯一性后再转换成内部 Map。内部持久化协议与 provider-specific 输出 Schema 分层，但从同一契约派生，避免手写两份漂移。

还要单独处理 refusal、incomplete、超时、取消和无效 JSON。strict 输出保证的只是支持范围内的结构，不保证语义正确或业务授权。项目目前也没有直接 Zod 依赖：可选择新增明确版本的 Zod，或使用现有类型/验证设施；不要依赖传递依赖“碰巧安装了”。

官方依据：<https://platform.openai.com/docs/guides/structured-outputs>（本轮已检索并读取）。Ant Slider 键盘能力参考 <https://ant.design/components/slider/>，并已核对本机 Ant 的 Slider / Statistic 导出。

## 6. 有副作用的 Action 为什么应后置

只做计算 UI 的风险和“生成一个重启服务按钮”的风险不是一个等级。后者需要：

1. 会话/用户当前权限、资源归属、能力 allowlist；权限从服务端事实而非模型文案得出。
2. 服务端提供准确的动作对象和影响说明；删除、发布等仍需对应明确确认。
3. 参数使用本次提交的已校验快照；schemaRevision/stateRevision/请求标识绑定。
4. 重复点击和重连不得重复发起：持久化 requestId 与接收结果。
5. 下游外部副作用不因本地事务自动获得 exactly-once。崩溃/超时可能处于“未知”；需业务幂等键或事实核对，不能盲重放。
6. 若动作是继续 Agent，必须走现有输入/队列 owner；PTY 仍保持文本与 `\r` 两包，不另造发送链。
7. 原地加载→完成/结果，失败保留输入；不忽略 fetch 错误，不用 Toast 代替动作状态。

已有登录认证不自动解决这些问题；给 actionId 加白名单也不能替代对象级绑定和版本检查。

## 7. 多端路线与兼容性

| 端 | 已核查入口 | 首期策略 | 真正交互所需 |
| --- | --- | --- | --- |
| Web | browser/chat-render.ts、react/chat/presentation.tsx | 新增稳定宿主 + 共用 Renderer | 主题、键盘、Portal、旧宿主更新、按需分包 |
| Android | ui/screens/ChatBlocks.kt | 保留工具/文本摘要，不宣称 React 已覆盖 | Kotlin DTO/校验、Compose Renderer、会话级状态、回归与 Beta |
| iOS | Wand/WandModels.swift、Wand/ChatView.swift | 文本降级；不能因残留 WebView 代码就当作 Web 壳 | Swift 协议、SwiftUI 控件与状态恢复、构建验证 |
| macOS | Wand/WandModels.swift、Wand/ChatView.swift | 同上 | 原生控件、键盘操作、桌面布局与历史恢复 |

新协议发布前就要验证旧端收到它不会崩溃或整条消息消失。保持可读摘要，并在能力协商/版本投影上明确不支持的状态。完整三端交互可在 Web 协议稳定后安排，粗估另加 **15–30 人日**，不包含全部 CLI 的发布入口适配；未做原生 PoC，区间置信度低于 Web 估算。

不建议为了省原生 Renderer，默认将任意生成网页嵌到聊天 WebView；这引入另一套沙箱、鉴权、导航和可访问性成本，也改变附件不执行生成代码的安全前提。

## 8. 分阶段实施与停止条件

以下工时包含阶段内测试和必要整合，允许逐阶段决定是否继续。

| 阶段 | 范围与交付证据 | 估算 |
| --- | --- | --- |
| A：技术原型 | 硬编码 Schema、严格 validator、计算器、五类库控件；真实宿主中拖动/重渲染不丢焦点；无模型、无业务动作 | 3–5 人日 |
| B：会话与持久化 | 可信发布记录、Schema 版本、参数保存、语义引用、普通会话与私聊/群聊投影、分页/断线/旧端摘要 | 5–8 人日 |
| C：一个生成入口 | 显式启用的 core 发布工具，沿用实际模型；原会话修改 UI，结构/状态冲突与取消；真实模型验收需另行授权 | 4–6 人日 |
| D：交付硬化 | 受影响浏览器流程、窄屏/五套主题/reduced-motion、打包预算、安全测试、安装态验收与问题收尾 | 3–6 人日 |

合计 Web MVP 15–25 人日。通用有副作用 Actions、所有 CLI 接入、Patch/图表各自另行评估，不能视作这一区间的隐含承诺。原附件的 3–5 日可用于原型，不足以同时承诺 Wand 集成、历史恢复、多端和权限闭环。

停止/改路线条件：

- 如果第一阶段仍需频繁重建聊天 DOM，先修正挂载边界，再接模型；不能用丢焦点换 demo。
- 如果一个简单场景需要任意 JS 或几十个专属计算 operator，说明不适合该 MVP 抽象，应考虑真正的应用生成/预览路线。
- 若用户必须首发支持任意 CLI + 全原生交互，重新立项估算，不把 Web 原型当完整交付。
- 模型输出无效时保留最后一次有效 UI，返回清楚错误；不无限重试、静默换模型或继续扩大能力。

### 建议文件边界（均为拟新增，不表示已实现）

```text
src/generative-ui-protocol.ts          声明式类型与结构约束
src/generative-ui-validation.ts        引用、预算、范围与迁移校验
src/generative-ui-evaluate.ts          纯函数白名单计算
src/generative-ui-service.ts           会话归属、版本、发布、保存
src/server-generative-ui-routes.ts     已认证读写入口
src/web-ui/react/generative-ui/
  repository.ts                       单一客户端状态 owner
  renderer.tsx                        组件 registry 与共享控件
  host.tsx                            聊天宿主适配/生命周期
```

storage、协议投影和现有宿主只补明确接口，不新开 `apps/api`，不为这项功能重组整个仓库。生成模块按需加载；实际校验器/Ant 新增组件的加载成本须通过构建预算测量，当前不编造体积数字。

## 9. 验收矩阵

| 领域 | 最低验收 |
| --- | --- |
| 功能 | 示例计算器数值正确；拖动时模型调用次数为零；组件未知或引用无效被整体拒绝 |
| 状态 | 双 Surface、双会话、双服务端隔离；同类型不同含义不误保留；范围/选项变化可解释；主动 reset 生效 |
| 并发 | 旧响应、相同版本不同内容、跨设备 CAS 冲突、生成期间新输入、取消/删除后迟到结果 |
| 历史 | 消息分页、tool_use/tool_result 跨页、服务重启、WS 丢帧重连、旧版本只读、已保存参数恢复 |
| 来源 | 私聊/群聊指向真实成员/工作会话，不使用 relay 或“最近一个会话”猜目标 |
| 安全 | 超预算、原型键、伪造 source/action、未授权/已撤销发布、直接篡改参数、外部 URL/脚本字段 |
| UI | 复用主题与控件；滑块键盘、标签/焦点、触控；选择器搜索不误关父层，外点/Escape 正常；更新不抢滚动 |
| 动作 | 首版只本地/保存；后续业务动作需重复点击、响应丢失、接收后崩溃和未知送达测试 |
| 兼容 | 未升级原生端看见可读摘要、不崩溃；Web 正常/原生壳/相关 reactUi=0 回滚路径 |
| 交付 | 协议/存储变更跑全量 check/test/build；最终只在已安装 Wand 服务验收受影响流程，遵守 core 排空与 daemon 生命周期 |

真实模型成功率、延迟和费用仍未知。建议正式 PoC 授权后用固定的有效/无效/修改请求集，分别统计首次合法率、经语义校验通过率、可用结果率、耗时与 token；不把 API 的“结构化输出支持”当作这些指标的证据。

## 10. 剩余（待安排）与评审决策

### 实施前需要明确的产品取舍

建议默认选择 **Web 先行 + 一个显式 core 入口 + 无业务副作用 + 完整替换**。以下若要求不同，会实质改变范围：

1. 是否首发覆盖所有 CLI 和三个原生客户端？
2. 面板主要用于结果展示/试算，还是直接控制 Wand 业务？
3. 是否要求每次拖动都跨设备同步，还是明确保存后同步？
4. 新私聊消息修改 UI 是否允许要求先选择目标/继续原工作？不建议隐式猜测。

### 研究顺带发现的既有资料/实现漂移（未修改）

- **组件说明与代码不一致**：根 AGENTS.md 的 Select/Listbox 写“Ant Select”，但 `src/web-ui/react/ui/select.tsx` 实际使用 Ant Dropdown + WandButton / WandInput，仍有公共 Portal 所有权协议。影响：后续实施者可能误以为拥有 Ant Select 的全部原生 API。复现：对照上述两处。建议相关 owner 更新文档或明确适配能力；本研究以当前源码为准，不另造选择器。
- **provider 标签存在局部副本**：`src/silicon-employee-draft.ts` 定义局部 PROVIDER_LABELS（含 `Pi coding agent`），与根规则要求复用 `provider-catalog.ts` 的标签真源不一致。影响：生成类功能若直接复制该模块，可能延续标签漂移；不能据此断言现有运行引擎已被错误选择。复现：搜索两文件的 PROVIDER_LABELS。建议在独立标签清理工作中统一并验证，不在本次只读研究中动同期修改文件。

定点测试还输出 Node 的 `module.register()` 弃用警告及无 DOM 环境的 Ant XNotification 提示；测试仍全通过。本轮未据此推断产品通知功能故障，环境升级/测试 harness 维护可后续处理，复现入口即第 1 节命令。

**最终建议：值得做，但应把它定位成 Wand 现有会话系统中的受限交互产物能力，而不是再嵌入一套独立 Agent 应用。先证明“同一会话可靠生成、修改、恢复一个安全面板”，再扩展业务动作与多端。**
