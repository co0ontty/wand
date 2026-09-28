# 子 Agent（subagent）在聊天里的显示口径

范围：父会话派发子 Agent（Claude/Qoder 的 `Task`、Pi 的 `Pi/subagent`）后，聊天里那张
「Agent Run 卡」怎么显示。打标契约见 `src/structured-client-protocol.ts`
（`deriveSubagentMeta` / `stampDerivedSubagents`）与 `src/structured-session-manager.ts`
（`tagSubagentBlocks`）；聚合与状态在 `src/web-ui/browser/agent-runs.ts`，渲染在
`chat-render.ts` 的 `renderAgentRun*`，样式在 `content/styles.css` 的 `.agent-run*` 区段。
证据与截图：`.wand-team/run_46c0a39145b3/`（`3-m_ca82f853.md` 为改前权威复核，
`assets/` 为改前、`assets/after/` 为改后）。

## 1. 改前的怪点（全部已修，除注明外）

1. 标题三连「Agent 运行 / N 个 Agent / 子 Agent」不携带信息；任务名缩在小字。
2. rail 每行都写 `general-purpose`——同批次并行子 Agent 的类型天然相同，等于没写。
3. 摘要「最新」行塞报告正文，且按裸 markdown 渲染（`_ready_` 变斜体、本机路径混进正文）。
4. 运行/中断口径依赖「是不是最新一个 run」，分页截断的历史 run 被误报「已中断」。
5. 展开后 43~83 个 block 全铺，结论被挤到几十屏之下；rail 与详情互相挤（长结论把
   rail 压成 0 宽，只剩两个点）。
6. Pi 异步派发**回执**被当成结论：标绿「已完成 / 最终结果」并渲染 markdown。
   （按形状判据真正修掉是在 §6 那一轮——第一版判据在 271 条真实样本上命中 0，等于没修。）
7. 结果体先 `replace(/\s+/g," ")` 压平才渲染，换行与段落全丢。
8. 同一个状态词一屏出现 5 处（摘要、rail 行、详情头、结论标签、图标 title）。
9. 动效不合规：`styles.css` 写死 `0.2s`，收起用 `display:none` 硬切。
10. 并行身份色种子用 `agentType`，四个 Agent 撞成同一个颜色。
11. `agent-runs.ts` 里 `if (!selectedAgent || ...)` 的死条件分支。

## 2. Web 现在的结构（设计 A–G）

**收起态一行**（`chat-render.ts:1678 agentRunTitle`、`:1690 agentRunTopicText`、
`:1706 agentRunLastActionText`）：状态图标 + 标题 + `N 个子 Agent` + 类型 chip
（只在整卡单一类型且非默认时）+ 状态文字（只在 运行中/失败/中断/后台/未完成 时）+ chevron。
单 Agent 标题 = taskDescription → agentType → `子 Agent`；多 Agent = `N 个子 Agent` ·
主 Agent 的 taskDescription。副行只有「最后一步动作」，纯文本单行 ellipsis，不渲染 markdown。

**展开态先结论后过程**（`:1843 renderAgentRunAgentBody`）：详情头 = taskDescription +
类型小字（只在能区分时）+ 同色状态点（`role=img` + aria-label，不再重复状态词）；
结论块 = 最终 `tool_result` **原文**（保留换行、走 markdown，`:1801`），失败写失败原因；
过程默认收起为一行「过程 · N 步」（`:1821`，原生 `<details>`，运行中例外自动展开）。
单 Agent 不套 rail、不套 tab/tabpanel（`:1854`）。Pi 异步回执走
`:1780 renderAgentRunReceiptHtml`：中性说明 + 后台任务 id + 输出文件路径，不标绿、不当结论。

**状态口径**（`agent-runs.ts:325 getAgentRunStatusSummary` + `:373 agentRunInLatestWindow`
+ `:416 lastUserTextIndex`）三条事实缺一不可：有没有最终 `result`、会话在不在跑、
这个 run 是否落在**最后一条真人文本轮**之后（子 Agent 回传的 user 消息不算文本轮）。
优先级 `failed > running > background > interrupted > pending > completed`：

| 有 result | 在最新窗口 | 会话在跑 | 显示 |
| --- | --- | --- | --- |
| 否 | 是 | 是 | 运行中 |
| 否 | 是 | 否 | 已中断 |
| 否 | 否 | 任意 | 未完成（分页截断的历史轮，不误报中断） |
| 是（回执） | — | — | 后台运行中 / 已转后台 |
| 是 | — | — | 已完成 / 失败 |

运行中不再依赖「是不是最新 run」；`_currentLatestAgentRunId` 已删除。
这与 Android `collectSubagentActivities`（`ChatBlocks.kt:1627`，`lastHumanTurn` /
`inLatestWindow` / `running` / `interrupted` / `pending`）是同一语义。

**派发回执识别**（`agent-runs.ts:172 parseAsyncDispatchReceipt`）：否决层 → 形状层（pi /
qoder）→ 疑似后台兜底层，三层顺序不可调换，`Output:` 只参与字段提取不参与判定。
形状表、条数与判据分层见 §6（本节下面这段旧描述已作废：「以 `Run fan-out:` 开头且同时含
`Async:` 与 `Output:` 才算回执」在 271 条真实样本上命中 **0**，因为真实回执根本没有 `Output:` 行）。

**计数口径**：「过程 · N 步」的 N 是**渲染出来的步骤数**，不是 `agent.blocks.length`。
`agent.blocks` 不含 dispatch 与 result（实测 836fa860 各 Agent 为 20~83，含 dispatch+result
为 22~85；d1b5464f 为 46 / 48），而 `tool_result`、空 thinking、空 text 这些不占步骤位，
所以同一 Agent 常见 30 块 → 10 步。两个数都对，别混用。

**动效**（`styles.css:3927` 起）：时长与曲线只取 `--motion-fast / --morph` + ease token；
展开/收起是 `grid-template-rows: 0fr ⇄ 1fr` 的行高变形（收起即倒放），触发摘要行位置尺寸不变；
切换 Agent 用新面板就地淡入；`prefers-reduced-motion` 下位移/缩放退化瞬时。
契约测试锁死了「`.agent-run*` 区段不许出现字面毫秒」「不许 `display:none` 硬切」。

## 3. Android 对齐结果（已落地）

实现全在 `android/app/src/main/java/com/wand/app/ui/screens/ChatBlocks.kt`（单文件），
行号为落地后位置。

| # | Web 口径 | Android 改成什么 | 状态 |
| --- | --- | --- | --- |
| 1 | 单 Agent 标题 taskDescription → agentType → `子 Agent`；多 Agent = `N 个子 Agent` + 主 Agent 描述（`agentRunTitle` / `agentRunTopicText`） | `agentBubbleTitle`（`:824`）按同一优先级取名（「猫猫」品牌前缀只保留在**类型兜底**上，用户写的任务描述不加前缀）；`subagentCardTitle`（`:831`）多 Agent 出计数，`subagentCardTopic`（`:844`）补主 Agent 描述；`subagentTypeChip`（`:861`）+ `isDefaultSubagentType`（`:855`）与 Web `AGENT_RUN_DEFAULT_TYPES`（`chat-render.ts:1619`）取**完全相同**的四个值（`general` / `general-purpose` / `generalist` / `default`；Android 曾多一个 `general_purpose`，本轮删掉——它让下划线变体的类型漏掉 chip，两端不一致） | ☑ |
| 2 | 状态六态 `failed > running > background > interrupted > pending > completed` | `SubagentStatus`（`:1473`）+ `SubagentActivity`（`:1565`）新增 `pending`（窗口外且无 result）与 `background`（回执），旧代码会把窗口外无结果静默判成完成 | ☑ |
| 3 | `lastUserTextIndex` 只认**没有 subagent 标记的非空 Text**；回执用 `parseAsyncDispatchReceipt` | `collectSubagentActivities`（`:1627`）的 `lastHumanTurn` 同口径（子 Agent 回传的 user 文本不再把窗口前移）；`parseAsyncDispatchReceipt`（`:1531`）与 Web（`agent-runs.ts:172`）**同构的三层判据**（§6）：否决层（首行 5 个前缀）→ 形状层（pi 首行 `Run fan-out: N/N used` + 其后 24 行内行首 `Async:` / `Async workflow`；qoder 首行 `Async agent launched successfully.` + 行首 `agentId:` / 小写 `output_file:`）→ 疑似后台兜底层（两个字段留空）。`Output:` 只提取不判定；`isError` 的结果不进判据 | ☑ |
| 4 | 身份色按 taskId 派生 + **卡内去重**（`agentRunAccent` 线性探测） | `dedupeAgentLogoVariants`（`:806`）在 5 个 palette 槽位内线性探测去重，`collectSubagentActivities` 统一算好后写回每个 activity 的 `logoVariant`，`agentIdentityColor`（`:1329`）与 `GeneratedAgentLogo`（`:1172`）读同一个值 | ☑ |
| 5 | 收起态一行 = 图标 + 标题 + 计数 + 状态词（完成态只图标 + aria-label），副行只有「最后一步动作」纯文本单行 | `SubagentSummaryRow`（`:670`）：`SubagentStatusIcon`（`:1354`）+ 标题 + `· 主题` + 类型 chip + 状态词（`subagentStatusNeedsText` `:1619`，完成态不占字位，状态只进 `stateDescription`）；副行 `subagentLastAction`（`:872`）倒扫跳过 `ToolResult`，取最近一次工具名 + 摘要或文本预览，单行 ellipsis，不渲染 markdown。**顺序与 Web `agentRunLastActionText` 一致**：先扫过程块，只有子 Agent 一句话都还没说（块里什么都没有）时才用回执文案 | ☑ |
| 6 | 展开态结论在前、过程折叠在后，结论体保留换行 | `SubagentActivityPage`（`:1872`）：`SubagentConclusionSection`（`:2058`）先出「最终结论 / 失败原因」原文（`MarkdownText`，不再压平空白），其后才是「过程 · N 步」折叠；`subagentStepCount`（`:2178`）与 Web 同口径——数**渲染出来的步骤**，跳过 dispatch 与 result | ☑ |
| 7 | Pi 回执渲染成「已转后台 + 后台任务 id + 输出路径」，不标绿、不当结论 | `SubagentReceiptSection`（`:2100`）中性底色 + **图标 + 说明同一行** + 两行 `后台任务` / `输出文件`，不走 markdown；**头部不再重复状态词**（见 §3 末「状态词只说一次」），会话在跑 / 已结束的差别只在摘要行与 `stateDescription`；**两个字段都空时回落渲染正文 markdown**（对应 §6 兜底层，不出现空卡） | ☑ |
| 8 | 动效只取 token、收起是展开的倒放、触发位置不变 | `SubagentActivityDock`（`:514`）读 `reduceMotionEnabled()`：开启时 pager 用 `scrollToPage`、展开面板与 chevron 走 `snap()` 瞬时；关闭时统一取 `WandMotion.morph()` 等 token，页面不写字面时长。摘要行常驻，展开/收起只改自身高度，不跳页不位移 | ☑ |

**状态词只说一次（`background` 分支的同类残留，双端同改）**：展开一条派发回执时，
「后台运行中」原本在摘要行与回执块头部各出现一次（怪点 8 的同族，只是只剩两处而不是五处）。
定稿口径是**状态词归摘要行**，回执头部只留「图标 + 说明文字」——图标负责「什么状态」，
那句话负责「所以别当结论」。两端同一批改：Web `chat-render.ts:1791` 去掉
`agentRunStatusLabel(...)`（连带 `statusWord` 局部量与已无用的 `activity` 形参），
Android `ChatBlocks.kt:2100` 去掉 `Text(statusLabel)`（连带 `statusLabel` 形参与传参），
说明文字两端统一成与 Web zh 逐字相同的一句
（「这只是派发回执，不是最终结论；子 Agent 仍在后台执行，结果会另行送达。」），
i18n 英文值同步补齐成等义（原先少了「结果会另行送达」那半句，状态词一走就没人说结果会回来了）。
守卫在 `tests/web-native-contracts.test.ts` 的 `receipt headers carry icon + note, not a second status word`：
正反两向都锁（回执头部必须没有状态词、摘要行必须有），所以「去重」不会被做成「去没」。

## 4. 参考客户端对照

一手材料（官方文档 / 上游 issue / 论坛原帖），每条标注来源性质：

- **Claude Code 官方文档**（官方文档）：子 Agent 以「派发的任务」为单位呈现，transcript 里
  一行就是 `名字 (简短任务描述)`，例如 `code-improver (Suggest code improvements)`；
  任务列表与 transcript 用颜色字段区分不同子 Agent。
  <https://code.claude.com/docs/en/sub-agents>
  → 可复用原则：**标题必须是任务本身**（对应 §3 第 1 项），**并行身份要能一眼区分**（第 4 项）。
- **Claude Code 折叠态一行摘要**（上游 issue）：收起后一行给出步数与耗时
  `Done (10 tool uses · 45.6k tokens · 2m 2s)`，中间步骤不铺满主屏。
  <https://github.com/anthropics/claude-code/issues/66646>
  → 可复用原则：**过程折叠、结论回主线，副行只给「现在在做什么」**（§3 第 5、6 项）。
- **Codex `/agents` 紧凑行**（上游 issue ×2）：一行优先展示 状态 / 任务 / 模型，
  诉求是「一眼看到每个子 Agent 当前在做什么」。
  <https://github.com/openai/codex/issues/23594>、<https://github.com/openai/codex/issues/36058>
  → 可复用原则：**状态是卡的属性，不是正文里的第 N 个词——一屏只说一次**（§3 第 2、5 项）。
- **Cursor 层级可折叠子 Agent 卡**（官方论坛原帖 + 设计综述）：子 Agent 挂在父计划下，
  summary + 就地展开，不跳走。
  <https://forum.cursor.com/t/hierarchical-ui-concurrency-view-for-multi-agent-workflows-in-agents-window/171765>、
  <https://www.aydesign.ai/blog/multi-agent-system-ux-design-guide-2026>
  → 可复用原则：**就地展开、不跳页不位移**（§3 第 8 项，也是 `docs/motion-design.md` 的硬要求）。

## 5. 自测

- `tests/web-ui-agent-runs.test.ts`：标题取名、状态口径、最新窗口判定（含「带 `__subagent` 戳的
  user 文本不算真人轮」）、§6 的三条真实回执形状 + 状态查询/转录/完成事件否决 + 疑似后台兜底、
  两态标签、结论体保留换行（含**多段** content 之间必须是 `\n`）vs 摘要压平、身份色种子。
- `tests/web-native-contracts.test.ts`：卡结构契约、rail 不收缩/不等高、动效 token 与
  不用 `display:none`；**时长正则同时覆盖 `transition` 与 `animation`**（只查 `transition` 时
  spin 的 `2.4s` 会从底下漏掉），且必须是**前缀匹配**
  `/(?:transition|animation)(?:-[a-z]+)?:…/`——只认 `animation:` 简写的话
  `animation-duration: 2.4s` / `transition-duration: 120ms` 这类长写法能整条溜过去（实测旧正则漏，
  新正则红）；收起态必须用 `visibility` 且延迟到动画结束（step-end）/
  展开即时（step-start），否则折叠卡里的 `role="tab"` 与 `<summary>` 仍吃 Tab 焦点；
  同时锁 Android 侧 `ChatBlocks.kt` 的契约锚点
  （`LaunchedEffect(refreshToken)` 尾随、`Agent:` 选择器、rail/摘要行）。
- `android/app/src/test/.../HistoryPresentationTest.kt`：`pending` / `background` 两态、
  §6 三层判据的**真实 fixture**（pi 单发 / pi 工作流 / qoder ack / `Status target:` /
  `Transcript target:` / `Steering queued` / `Revived async subagent` / 疑似后台兜底 /
  `isError` 排除 / `Preflight:` 计划表内派发行仍取到 runId / 方括号类型名不抢 runId /
  回执副行让位给真实过程步）+ 271 条真实语料的离线全量回放（一次性探针，验证两端命中数
  一致后不留进测试——它依赖 `/tmp` 语料文件）、标题优先级、多 Agent 计数与 chip、
  状态词何时上屏、最后一步动作、卡内身份色去重、过程步数口径。
- 真实数据截图：Web 见 `.wand-team/run_46c0a39145b3/assets/after/`（改前同条件在 `assets/`）；
  Android 真机（模拟器 `wand_pixel_8_api_36` + 已安装服务）见
  `assets/android-after/01-collapsed-dock.png`（收起态一行）、
  `02-expanded-conclusion-first.png`（结论在前）、
  `05-receipt-background-realdata.png`（qoder 派发回执照 §6 判成 `background` 中性块，
  输出文件路径已打码）。
  **`03-expanded-process-collapsed.png` / `04-process-expanded.png` 不算「过程 · N 步」证据**：
  两帧实测只有 0.038% 像素不同（同一帧），且都没有那一行——可达会话的 dock 里全是
  `stepCount == 0` 的异步派发 Agent，按 §3 第 6 项口径「N=渲染出来的步骤数」为 0 时本就不渲染，
  所以那两张既没拍到折叠也没拍到展开。**第 16 步仍未补到**（`06-` / `07-` 不存在）：
  设备侧 `HomeActivity` 未导出，`am start --es open_session_id …` 是
  `SecurityException: … not exported from uid`，走不到指定会话；
  Web 侧替代证据也拿不到，因为**本机已安装服务下发的仍是本改造前的 bundle**
  （抓页面资产核实：`agent-run-process` 命中 `false`、`agent-run-count` 命中 `true`，
  而本工作树 `src/web-ui/content/scripts.js` 里 `agent-run-process` 有命中），
  拿它拍只会得到一张改前的图。复现与补拍步骤见
  `.wand-team/run_46c0a39145b3/16-m_e19e7dee.md` §d。

### 已知遗留

- **回执判据已双端一致**：Web `src/web-ui/browser/agent-runs.ts:172` 与 Android
  `ChatBlocks.kt:1531` 现在是同一套三层判据（§6）。271 条真实语料两端都是
  **head 71 / 回执 71 / 带 runId 71 / 兜底 0**，旧判据命中 **0**。
  qoder 的 `Async agent launched successfully.` + `agentId:` + `output_file:` 形状
  两端都判 `background`，pi 回执两端都认。
- **展开态状态词重复已双端修掉**（第 16 步）：回执头部不再重复「后台运行中」，
  状态词只归摘要行；两端同一批改、断言也正反两向锁，详见 §3 末「状态词只说一次」。
- **「过程 · N 步」折叠/展开仍缺证据**（`03`/`04` 是同一帧且没有那一行，`06`/`07` 没拍到）：
  设备侧 `HomeActivity` 未导出，adb 进不去指定会话；
  **Web 侧替代证据被一件更大的事挡住——本机已安装服务跑的还是本改造前的 bundle**，
  也就是说这批 Web 改动目前只存在于工作树，尚未经过任何真机 / 已安装服务的视觉验收。
  接手的人要先让已安装服务用上本树构建，再照 §5 的三步补拍。
- **`Revived async subagent` 这条 fixture 只有 Android 锁住**：它是 271 条里唯一一条
  「否决层独立起作用」的样本（去掉否决层，Android 测试会红；Web 侧同一条语料目前
  没有对应断言）。下一轮把同一 fixture 补进 `tests/web-ui-agent-runs.test.ts`。
- 「猫猫」品牌前缀只加在**类型兜底**标题上（沿用既有已提交的产品决定），用户写的任务描述不加。
- 回执的 `runId` 只从正文取。pi 的 provider 日志里其实有结构化 `details.mode/runId/asyncId`，
  但 `src/structured-pi-adapter.ts:153` 构造 tool_result 时不带 `details`，
  `structured-client-protocol.ts` 也没有该字段 → Web 侧拿不到结构化 id，只能靠正文正则。
  要根治得在 adapter 与协议两处一起加字段，不在本轮范围。

## 6. 派发回执 / 状态查询 / 真报告的形状表与判据分层

判据在 `src/web-ui/browser/agent-runs.ts`（`parseAsyncDispatchReceipt` 及其上方常量）。
**这张表来自 271 条真实 `Pi/subagent` toolResult 的全量聚类**（取证过程见
`.wand-team/run_46c0a39145b3/8-m_ca82f853.md`），不是照猜写的：旧判据在这 271 条上
命中 **0**，所以「回执被标成最终结论」这个怪点其实一直没被真正修掉过。

| 首行形状 | 条数 | 还有 | 应该判 | 说明 |
| --- | --- | --- | --- | --- |
| `Run fan-out: N/N used, N remaining` + 后续 `Async: <name> [uuid]` | 22 | **无** `Output:` 行 | 回执（`background`） | pi 单发派发；`[uuid]` 取该行**最后一个**方括号段 |
| 同上 + 后续 `Async workflow [uuid]` | 49 | 无 `Output:` | 回执（`background`） | pi 工作流派发；71 条回执里有 **14 条**的派发行不在第二行（中间插了整段 `Preflight:` 计划表，最远一条在第 15 行），所以派发行不能写死「第二行」 |
| `Status target: run <uuid>` | 130 | 正文里**同时**含 `Run fan-out:` 与 `Output: …/output-N.log` | **真结果**（按结论渲染） | 状态查询的答复。合取判据的killer：任何「放宽成含 `Output:` 就算回执」的方向都会把它吞成回执 |
| `Transcript target: run <uuid>` | 12 | `Output: …_output.md` | **真结果** | 转录/报告，是本轮最该显示的东西 |
| `Steering queued for async run <id>` | 4 | — | 真结果 | 管理动作回执，不是派发 |
| `Revived async subagent from <id>.` | 2 | — | 真结果 | 同上 |
| `Background task completed: **<agent>**` | — | — | 真结果（完成事件） | 子 Agent 的完成事件**不在 tool_result 里**，是一条独立 `custom_message` |
| `Async agent launched successfully.` + `agentId: <非 uuid>` + 小写 `output_file:` | — | 无 `Run fan-out:` | 回执（`background`） | qoder 形状；id 从 `agentId:` 行取（`ageneral-purpose-ca16580eee0d40fb` 这种不是 uuid） |

判据分三层，**顺序不可调换**（Web `agent-runs.ts:172`，Android `ChatBlocks.kt:1531`，
两端同构；Android 于第 13 轮移植，此前仍是旧合取判据）：

1. **否决层**：首行命中 `Status target:` / `Transcript target:` / `Steering queued` /
   `Revived async subagent` / `Background task completed` → 直接不判回执。
2. **形状层**：pi（`Run fan-out: N/N used` 开头 + 其后 24 行内 `Async:` / `Async workflow`
   —— 中间可能插整段 `Preflight:` 计划表，真实语料里 57 条派发行在第 2 行、9 条在第 7 行、
   最远一条在第 15 行，所以窗口不能写成「第二行」也不能太窄），
   qoder（`Async agent launched successfully.` + `agentId:`）。
3. **疑似后台兜底层**：都不命中但正文明确说已交后台
   （`detached and running in the background` / `is working in the background` /
   `will be notified automatically when it completes`）→ 判**中性** `background`，
   两个字段留空，渲染侧回落到正文 markdown。

### 为什么 `Output:` / `.jsonl` 不能当判据条件

真实派发回执**根本没有** `Output:` 行（pi 的 22 条单发与 49 条工作流一条都没有），
而**状态查询和真报告反而都有**
自己的 `Output:` 字段。也就是说 `Output:` 与「这是回执」在真实语料里是**负相关**的：
拿它当条件，等于把最该显示结论的两类内容判成回执、把真正的回执全漏掉。
所以它现在只出现在字段提取里（有就填 `outputPath`，没有就是空串），不参与任何一层的判定。

### 为什么必须有第 3 层

provider 的回执文案会变（pi 与 qoder 已经完全不同形），白名单必然漏新形状。
漏的时候有两种错法：判 `completed` → 谎称「已完成 / 最终结果」（就是原来的 6 号怪点）；
或返回 `null` 又因为字段空而渲染一张什么都没有的卡。兜底层选第三条路：
**判中性「后台运行中」并把正文照常渲染**——宁可不够精确，也不能误报完成或丢信息。
配套的硬约束：`is_error === true` 的结果**不进判据**（含后台措辞的错误结果不能被洗成 background），
以及 `agentRun.receipt` 两字段可空时 `renderAgentRunReceiptHtml` 回落 `renderMarkdown(正文)`
（Android 同一条：`ChatBlocks.kt:2102 SubagentReceiptSection(receipt, statusLabel, body)`
两字段皆空时回落 `SelectionContainer { MarkdownText(body) }`，不渲染空卡）。

### pi 的 `workflowScript` 派发（50 条）本轮不成卡

`deriveSubagentMeta` 对 pi 只认 `{agent, task}` 这一种输入，所以
`{workflowScript}` / `{workflowScriptPath}` 这 50 条工作流派发全部返回 `null` → 不成卡，
它们的 49 条 `Async workflow [uuid]` 回执也因此无处挂（回执要挂在派发块上）。
**本轮刻意不去扩这个判据**，因为按真实语料查下来没有可用的命名来源：

| 候选来源 | 命中 | 结论 |
| --- | --- | --- |
| 顶层 `label` / `name` / `title` / `description` / `task` 字符串 | **0/50** | 没有 |
| `preflight.lanes[].key` 或 `.decision`（结构化） | 15/50 | 覆盖不到 35 条 |
| `mission.title` | 1/50 | 基本没有 |
| 刮 `workflowScript` 文本里的 `label:'…'` / `runs.run('…')` / `key:'…'` | 35/50 只能靠它 | 不采用 |

不刮脚本除了覆盖率，还有语义问题：**一次 workflow 派发 ≠ 一个子 Agent**，它是 N 条 lane
（`runs.all([{key:'web'…},{key:'macos'…}])`），用正则抓到的第一个名字给整张卡命名，
比「不显示」更容易误导，而且 provider 脚本一改正则就碎。

**下一轮的正确修法**（不在本轮范围）：把 pi provider 日志里已有的结构化
`details`（`mode` / `runId` / `asyncId` / `asyncDir`）透出来——
需要同时改 `src/structured-pi-adapter.ts:153`（构造 tool_result 时带上 `details`）与
`src/structured-client-protocol.ts`（打标时读它），Web 与 Android 再按 lane 数聚合成
**一张多 Agent 卡**（复用现成的 rail + 详情切换），名字取 lane 的 `key`，
回执 `runId` 直接取 `details.asyncId` 而不是正文正则。
