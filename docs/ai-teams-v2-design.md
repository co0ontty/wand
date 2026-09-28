# AI 团队 v2 设计文档

> 状态：设计稿 v2-r4（按 `review.md` 修订为 r2，按 `review-round2.md` 消除 R1–R5，按 `review-round3.md` 消除 N1–N5）。
> 现状引用带「路径:行号」，权威依据是 `.wand-team/run_369a2e9244fe/design/survey.md` 与本轮复核。
> 实施时若行号漂移，以符号名（函数/字段名）为准重新定位。

## §0 一句话方案

成员从「单个执行配置」升级为「有序的多个候选执行配置」（工具+模型+思考深度），**在事件驱动循环里观察到启动失败后按候选降级，且每次降级新开一个步骤**（与既有格式重试惯例同构）；团队可在任务卡之外直接开跑（服务端原子建「团队任务卡」，工作目录必须解析自明确 workspace）；侧栏、工作区欢迎页、看板都能选团队；运行详情面板改为「群聊 | 时间线 | 按成员」三视图、群聊默认、交叉淡入淡出、降级在群聊同步落 notice；Android 补齐全套团队页面。

## §1 目标与非目标

### 目标

- **A 多候选降级**：每成员 = 名字 + 职责 + 1–4 份候选执行配置（有序）；启动失败按候选自动降级；降级可观测（步骤留痕 + 群聊 notice + 署名用实际候选）。
- **B 按职责分派**：可选 `role` 标注 + duty 文本双通道进提示词；「实现≠验收」错派以群聊 notice 提示（不拒绝）。
- **C 编辑体验**：成员卡片内多候选增删/上下移动排序，列表内展开不跳页。
- **D 入口适配**：侧栏新建任务、工作区欢迎页（项目上下文）、团队页「直接开工」支持选团队。
- **E 群聊面板**：三视图同一位置交叉淡入淡出，群聊默认。
- **F Android**：Web 先做；Android 同批设计、随后落地（团队定义与多候选**可编辑**，见 §11-Q6）。
- **H 兼容**：旧单 agent 数据、旧运行快照（`team_json`）无损兼容；SQLite 只加不删。

### 非目标（修正 B4）

- ~~团队全部跑在 structured 会话上~~ **错误表述已删除**。现状：`dispatchAgentForTask` 有 `agent.kind === "pty"` 分支（`src/agent-dispatch.ts:55-65`），`stepOutcome` 有 PTY 专属判定（`src/ai-team-runner.ts:582`），`completeStep` 手动收尾（`:340-347`）与 v1 文档 §9.5 的 PTY 成员重跑都依赖它。**v2 保留 PTY 成员**，边界见 §3.4「PTY 候选的降级规则」。
- 不做 iOS / macOS 团队界面（DTO 预留）。
- 不做登录/额度的事前探测（survey §2：无可靠信号）；只用「启动失败即降级 + 事后错误分类」。
- 不做成员间直接对话、不自动重跑业务失败步骤（失败仍交回 Leader）。
- 不改 render / terminald；不新增 WS 消息类型（复用 `ai-team-run` 通知 + 会话事件）。

## §2 现有基线（v1 事实，含复核修正）

| 事实 | 证据 |
| --- | --- |
| 成员单个 `agent: WandTaskAgent`；字段名 `isLeader`（不是 `leader`） | `src/ai-team-types.ts:17-18`；校验 `src/server-ai-team-routes.ts:71` |
| 派发直接用 `member.agent`，且 `dispatchStep` 是同步栈：标 running → `ops.open` → 同步 catch | `src/ai-team-runner.ts:819-831` |
| 会话是否 failed 由事件驱动观察：`ingest`→`evaluate`→`stepOutcome`，5s `startSweep` 兜底 | `:438-454/:563-603/:477`（survey §1） |
| 既有的「换配置再跑」惯例 = **新建一个步骤**（Leader 格式重试） | `:652-657`（`createLeaderStep` 新 seq → 新 `reportPath`） |
| `step.sessionId` 单值列（`storage.ts:1008` session_id，本轮复核）；`reportPath = aiTeamReportPath(run.id, seq, kind, memberId)` 不含候选维度 | `src/storage.ts:1008`、`ai-team-runner.ts:685/785` |
| 启动失败交回路径：`stepOutcome` 返回 `{kind:"failed", sessionError:true}`；work 失败不再派步、交回 Leader；Leader 出错直接 waiting_user | `:593-598/:710/:632-640` |
| 运行强绑任务卡：objective 拼装、`task_id TEXT NOT NULL`（**storage.ts:984**，本轮 grep 复核；第一轮复核的 :982 是 `id` 行，错值已回正）、唯一启动路由 | `ai-team-runner.ts:248-260`、`storage.ts:984`、`server-ai-team-routes.ts:146-155` |
| 运行携带团队快照 `team_json`，`refreshTeam` 会整体替换活对象 | `ai-team-types.ts:53-54`、`storage.ts:2831+`（mapAiTeamRunRow）、`ai-team-runner.ts:838-844` |
| `resolveTaskDispatchTarget` 目录兜底链：worktree → group.cwd → workspace.cwd → **`config.defaultCwd`** | `src/agent-dispatch.ts:25-34` |
| `model: "default"` 合法（服务端解析默认模型）；effort 有 `provider:level` 原生格式 | `src/task-types.ts:81`、`agent-dispatch.ts:53-54`、`task-types.ts:16-17` |
| `ConversationTurn` **没有消息 id 字段**（role/content/author/notice/createdAt/completedAt/usage） | `src/types.ts:577-599` |
| 群聊 relay 会话：`registerRelay`（:1363，本轮复核）前缀 `ai-team-chat:`，`sendMessage` 命中 relay 即转 `chatInput` 不起 CLI | `ai-team-runner.ts:49/:139`、`structured-session-manager.ts:1363/1411-1416` |
| 群聊署名 provider 恒取 `member.agent.provider` | `ai-team-runner.ts:144-153`（chatAuthor :150） |
| awaiting_approval 时短语表把「好的/可以/ok」当批准 | `ai-team-runner.ts:51`（APPROVE_REPLY） |
| 读端兑底点在 storage（**不存在 normalizeAiTeam**）：`mapAiTeamRow` / `mapAiTeamRunRow` | `storage.ts:2817-2830/:2831+` |
| 团队路由无 per-route 鉴权，靠全局 `app.use("/api", requireAuth)`（注册点须在其后） | `server.ts:665/:802` |
| 团队 CRUD 只有 GET 列表/POST/PUT/DELETE，**无 `GET /api/ai-teams/:id`** | `server-ai-team-routes.ts:105-134` |
| `aiTeamsRepository.list()` 已存在（无缓存） | `src/web-ui/react/ai-teams/repository.ts:26-28` |
| 时长 token 只在 Android `WandMotion`（press110/fast150/normal240/morph200/indicator260/quickExit90）；**Web 侧无时长 token**，只有 `--*-ease` 缓动变量；Web reduce-motion 判定是 `stretch-tabs.tsx` 私有函数 | `docs/motion-design.md:22-27`、`content/styles.css:163-167`、`src/web-ui/react/ui/stretch-tabs.tsx:18` |
| Android 团队 0 实现；`ConversationTurn`（Kotlin）无 author/notice | survey §6 |
| 成员数 2–8、`isLeader` 校验、报告稳定窗口 1.5s | `ai-team-types.ts:4-5`、`server-ai-team-routes.ts:53-71`、`ai-team-runner.ts:44` |

## §3 数据模型与迁移（需求 A、B、H）

### 3.1 成员多候选：`agents: WandTaskAgent[]`

`src/ai-team-types.ts` 的 `AiTeamMember`（现状 :10-21）：

```ts
export type TeamMemberRole = "plan" | "work" | "verify" | "any";   // 新增，定义在本文件

export interface AiTeamMember {
  id: string;
  name: string;
  duty: string;
  /** v2：有序候选执行配置，第一个优先；至少 1 个。 */
  agents: WandTaskAgent[];
  /** 兼容字段：始终等于 agents[0]，供未升级读端使用（见 3.6 读点清单）。 */
  agent: WandTaskAgent;
  role?: TeamMemberRole;   // 缺省视同 "any"
  avatar?: string;
  isLeader: boolean;       // 字段名不变
}
```

- ~~成员级 `instructions?`~~ **删除**（复核 1.2#7：代码与文档都没用它；协作指令是团队级 `AiTeam.instructions`，`ai-team-types.ts:31`）。
- **保存约定**：写路径校验 `agents` 后强制 `agent = agents[0]`（不信任客户端）。
- **读路径兑底（修正 B10，不存在 normalizeAiTeam）**：`ai-team-types.ts` 新增导出纯函数
  `memberAgents(member: AiTeamMember): WandTaskAgent[]`（`agents` 缺失/空 → `[member.agent]`；有则原样返回）。
  所有读端一律经它取候选，共三处入口保证覆盖：
  1. `storage.ts` `mapAiTeamRow`（:2817，团队定义 `members_json`）——map 时逐成员 `agents = memberAgents(m)` 归一；
  2. `storage.ts` `mapAiTeamRunRow`（:2831，**运行快照 `team_json`**）——旧运行的快照成员只有 `agent`，同样逐成员归一。`refreshTeam`（`ai-team-runner.ts:838-844`）替换后的新快照天然带 `agents`；
  3. 兜底：`memberAgents` 对未归一的裸对象也能工作（纯函数），runner/prompts 内只经它读候选。
- `src/server-ai-team-routes.ts` `parseMembers`（:44-75）：接受 `agents: WandTaskAgent[]`（每项走现有 `parseTaskAgent`）或旧 `{ agent }` 单对象。

### 3.2 SQLite 迁移

沿用 `ensureAiTeamSchema` 风格（`src/storage.ts:1021-1031`，PRAGMA + ALTER ADD COLUMN）：

- `ai_teams` 不加列（JSON 字段演进，3.1 双写）。
- `ai_team_steps` 加 `dispatch_info_json TEXT NOT NULL DEFAULT '{}'`：

```ts
export interface StepDispatchInfo {
  usedCandidate: number;                     // 本步实际派发用的候选下标
  skipped: Array<{                           // 本步之前（含历史 step 链上）跳过的候选
    candidate: number;
    agent: WandTaskAgent;
    reason: string;                          // summarizeError 式清洗后的人类文案（runner:158-162）
    errorKind: CandidateFailureKind;
  }>;
}
```

- `ai_team_runs` 加 `run_state_json TEXT NOT NULL DEFAULT '{}'`：run 级黑名单（3.4）与未来 run 级状态；旧行默认 `{}` 零回填。
- **迁移测试（采纳 S8）**：新增用例「以旧 schema（无这两列、成员 JSON 只有 `agent`）的 SQLite 文件打开库 → `ensureAiTeamSchema` 加列 → `mapAiTeamRow`/`mapAiTeamRunRow` 归一后 `memberAgents` 返回单元素数组、旧行可读可写」。放在 `tests/storage-ai-team-migration.test.ts`（新建，非既有同名文件），runner 级测试覆盖不到历史库文件。

### 3.3 角色标注（需求 B）

| 方案 | 利 | 弊 |
| --- | --- | --- |
| 纯 duty 文本（现状） | 零 schema 变更 | 团队大时 Leader 靠猜；UI 无法约束 |
| 可选 `role: "plan"|"work"|"verify"|"any"` | 决策可引用结构化角色；UI 可提示；缺省 any 向后兼容 | 多一个概念 |

**推荐：可选 role + duty 文本都进提示词**。`memberLine`（`src/ai-team-prompts.ts:45-49`）在名字与 duty 之间插中文角色标签（plan→「制定计划」、work→「干活实现」、verify→「验收测试」、any/缺省不显示）。服务端**不做职责硬校验**（`parseLeaderDecision` 只校验成员存在，`ai-team-prompts.ts:261-264`），但**兑现错派提示（修正 B13）**：`postLeaderDecision`（`ai-team-runner.ts:900+`）里若被指派成员 `role==="verify"` 且该成员在本次运行已有 `done` 的 work 步骤 → `postNotice`「「X」既做过实现又被安排验收，介意的话在群里说一句让负责人调整」，不拒绝不拦截。落点在 T3b。

### 3.4 可用性判定与降级（需求 A 核心，重写）

survey §2 结论不变：**无事前可靠可用性信号**，口径为——

> **启动失败即降级（事后为主）**：只有一处事前检查（model-unknown，且「拿不准就放行」）；其余全部由事件驱动循环观察到会话失败后分类决定。**会话启动成功之后的业务失败、格式错误、被 stop 绝不降级。**

#### 触发点与代码结构（修正 B1：不放进 dispatchStep 调用栈）

`dispatchStep`（`ai-team-runner.ts:798-832`）保持同步栈语义，两个触发点分别落在它本就存在的位置：

1. **同步派发异常**：`dispatchStep` 的 catch（:829-831）。现状直接 `finishStep(failed)`；改为先 `classifyCandidateFailure(getErrorMessage(error), …)`：可降级且还有下一候选 → 走「降级开新步」（下述），不再直接把步骤记 failed。`model-unknown` 的 opportunistic 事前跳过也在此前选候选时做（判定条件见下「model-unknown 的边界」；留痕方式见同节末「事前跳过的留痕」）。
2. **异步启动失败**（主通道）：落 **`finishStep` 的 work 分支入口、且在 `run.stepsUsed += 1`（`ai-team-runner.ts:613`，本轮复核）之前**（R4 修正：判定若晚于该行，首个失败候选仍会扣 1 步预算，与 §9.10「降级步不占 stepsUsed」矛盾）。`stepOutcome` 返回 `{kind:"failed", sessionError:true}` 已有（:593-598），finishStep 在进入函数、递增 stepsUsed 之前先判
   `isDegradableWorkFailure(run, step, outcome)` = `step.kind==="work" && outcome.sessionError && 无报告文件产出 && classify(...) ∈ {spawn-missing, startup-timeout} && usedCandidate < agents.length-1 && 下一候选不在黑名单`。
   - **startup-timeout 判据**：`snapshot.status==="failed"`（isSessionGone :164-166）且 `snapshot.messages` 无 assistant 回复且 `now - startedAt < STARTUP_WINDOW_MS`（常量 45_000，runner 模块顶部；采纳 S13/Q7：**不开 config 口子**，常量 + 注释即可，AGENTS.md 新配置项文档义务不适用）。超过窗口或已有输出 → `runtime-failure`，不降级。
   - 检测的及时性不靠新定时器：`ingest`（status/ended 事件 :438-454）与 5s `startSweep`（:477）已经驱动 `evaluate`→`stepOutcome`，降级判定复用同一条链。
3. 与 `runId` promise 链的关系：降级全程在 `enqueue(runId, …)` 串行化内部完成（finishStep 本来就跑在链上），不引入并发窗口；`advance` 的 `busyMembers` 同成员串行约束保证同成员同时只有一个新步在跑。**注意（N1）：`enqueue` 只保证跨调用串行，挡不住同一栈内 `advance` 旧快照的重复派发——所以降级不得整轮 advance，见下述不变式。**

#### 降级动作 = 开新步骤（修正 B2：孤儿会话与报告撞车）

**不在同步栈里覆写 `step.sessionId`、不在原步骤内换候选**。与既有格式重试惯例（`ai-team-runner.ts:652-657` 新建 `createLeaderStep`）同构：

```
degradeWorkStep(run, step, failure):
  1. if (step.sessionId && this.ops.snapshot(step.sessionId) && !isSessionGone(snapshot))
       try { this.ops.stop(step.sessionId); } catch (e) { console.error(…); }
                                              // 安全阀：防误判「启动失败」而旧 CLI 实际还活着，
                                              // 两个 CLI 并发写同一工作目录。
                                              // **必须包 try/catch 只记日志**（照 stop 路径先例
                                              // `ai-team-runner.ts:356-360`）：stop 抛错若不做兜底，
                                              // 会让「旧步记 skipped + 新步创建 + 重指向 + 黑名单」整段中断，
                                              // 步骤卡在 running（N5）
  2. 旧 step：status="skipped"，report=「候选 N 不可用：<reason>」，
     dispatchInfo.skipped 追加本次记录 → saveStep（不走 finishStep 记 failed，不占 stepsUsed）
  3. 新建同 memberId/title/instructions **且继承旧 step.dependsOn** 的 queued work step
     （nextSeq → reportPath 天然不同，不与上一候选的半截报告文件同路径；上一候选遗留文件留在原地，
     新候选的提示词只写自己的 reportPath。继承 dependsOn 不影响正确性——旧步能被派发说明其依赖全 done，
     但保证时间线可读与重排后的指向一致，N5）
  4. **依赖重指向**：把本 run 所有 `status==="queued"` 且 dependsOn 含旧 step.id 的步骤，
     改写为指向新 step.id（逐条 saveStep，全程在同一 enqueue 链内）
  5. 黑名单记账（见下）→ **只对新建的 A′ 直接调 `dispatchStep(run, newStep, …, proceed)`**
     （同成员、继承旧步 dependsOn、重指向后依赖必然已满足，不需要 advance 的调度判断），
     **不整轮 `advance()`**；其余步骤的推进交回调用方既有的 `proceed` 语义
     （异步：`evaluate` :546 `finishStep(…, false)` → :550 `advance` 推进一次；
     同步：外层 `advance` 循环自身的 :737 收尾）——N1 收口
    ※ 上面的 `proceed` **原样透传调用方传进来的值**（`advance` 循环内必为 `false`，见 :732），
    **不得写死 `true`**：写死会让新步的同步失败再走一次 `finishStep(…, true)` → advance，重新制造嵌套。
```

- **不变式（N1，必须写进实现）：同栈过期快照不得二次派发。** `advance` 在进入派发循环时一次性快照
  `queued`（`ai-team-runner.ts:711`）、`byId`（:718）、`busyMembers`（:719），循环内以 `proceed=false` 调
  `dispatchStep`（:732），而 `dispatchStep` 的同步 catch（:830）把 `proceed` 原样透传给 `finishStep`。
  因此若 `degradeWorkStep` 内部改调整轮 `advance`，就会出现**嵌套派发**：内层 advance 用当时的新鲜状态把
  同轮其它 queued 步派发掉，返回后外层继续拿着**已过期的 `queued`/`byId` 快照**迭代，:722 的 `busyMembers`
  只登记了降级成员本身（:726 是先 add 再派发，但外层那份快照也是旧的）、:723 的 `byId` 看不到新状态，
  于是对同一步**二次 `dispatchStep`**——命中 `liveSessionFor` 就重复发一条提示词，没命中就再开一个 CLI 会话
  并覆写 `step.sessionId`，正是本节红线（两个 CLI 并发写同一工作目录）。
  反向也不成立：把第 5 步的推进整个删掉同样错——同步路径下外层循环的 `queued` 快照里没有 A′，循环走完后
  :737 发现「没有任何 running 步骤」→ `startLeaderRound`（:738）把 A′ 连同其余 queued 一起标 skipped
  （:753-754），候选切换被静默吞掉。所以结论是「**degrade 只直接派 A′，不整轮 advance；推进次数由调用方保证**」。
- 两条触发路径的推进方式（各自恰好推进一次）：
  - **异步主通道**（`stepOutcome` → `finishStep` → 降级）：`degradeWorkStep` 直接派出 A′（A′ 变 running），
    返回后 `evaluate` :550 的 `advance` 再跑一次；此时 A′ 已 running，:708/:737 早退，无害。
  - **同步派发异常**（外层 `advance` 循环内 `dispatchStep` catch → 降级）：`degradeWorkStep` 直接派出 A′，
    不再进入 advance；外层循环继续迭代它的旧快照时，A′ 不在旧 `queued` 里不会被重复派发，循环结束后
    :737 用 `listAiTeamSteps` 的**新鲜列表**看到 A′ running → 直接 return，不会误触发 Leader 重排。
  - **级联**（新候选同步派发也失败，再降级）：递归深度以候选上限 4 为界（每降一级 `usedCandidate` +1），
    不会无限展开；每一层同样只直接派下一个新步。

- **依赖链语义（R1，唯一结论＝重指向新步）**：`advance` 只认 `dependsOn.every(status === "done")`（`ai-team-runner.ts:723`，本轮复核），而 `startLeaderRound` 会把**全部 queued 步骤作废成 skipped**（:753-754）。不处理则 A 降级后旧 A 变 skipped、依赖它的排队步 B 永远不满足 → 队列空转触发 Leader 重排 → 同轮其余排队步 C/D 一并作废，整轮计划被降级误伤。三方案权衡：
  - **新步继承旧步 id**：不可行——旧步要保留为历史留痕载体（skipped + dispatchInfo），且新 reportPath 依赖新 seq/新主键。
  - **skipped 视为依赖已解除**：不可行——`skipped` 还被 `startLeaderRound` 重排作废（:754）与 `stop`（:362）复用；判为满足会让被 Leader 作废的旧计划下游抢跑，且「没做完」的降级步放行其验收步。
  - **重指向新步（采用）**：语义精确＝B 等的仍是「这件事做完」，只是换了承载候选的新步骤；A′ done 后 B 正常派出。
  - 边界：多级依赖 A→B→C 只重写对旧 A 的直接引用（B/C 的 id 与 C→B 依赖不动）；running/done 步骤的 dependsOn 不改写（历史不可变）；Leader 重排后生成的新 queued 集天然指向届时最新的步；与 `busyMembers` 无冲突（新步在派发时才入 busy，B 属不同成员则并行、同成员则按既有串行等待）。**修正**此前表述：「skipped 不触发 `failedSinceLeader`（:710）交回 Leader」仍成立，但**必须配合第 4 步重指向**，否则有依赖链的场景不成立。

- 候选链上下文：新 step 的 `dispatchInfo.usedCandidate = 旧+1`，`skipped` 从旧 step 复制累计。`dispatchStep` 选 agent 改为 `memberAgents(member)[step.dispatchInfo.usedCandidate ?? 0]`。
- **PTY 候选的降级规则（修正 B4）**：`agent.kind === "pty"` 的候选只在触发点 1（同步派发异常，`processes.start` ENOENT）参与降级；`stepOutcome` 的异步 failed 对 PTY 会话**一律不分类不降级**（PTY 无 `structuredState.lastError`/messages 语义，「无输出」判据不可靠），维持 v1 行为（交回 Leader / `completeStep` 手动收尾 :340-347 保留）。model-unknown 事前检查只适用于 structured 候选。

#### 错误分类（`src/ai-team-availability.ts` 新文件，纯函数）

```ts
export type CandidateFailureKind =
  | "spawn-missing"      // ENOENT/CLI 缺失（文案源 structured-session-manager.ts:2378-2381、
                         //   git-quick-commit.ts:571-572、claude-sdk-runner.ts:213-214）→ 该降级，provider 级拉黑
  | "host-disabled"      // structured/processes 未启用（agent-dispatch.ts:48-49）→ 该降级，进程级：整个 run 停止降级
  | "model-unknown"      // 仅由**事前**快照比对产生（opportunistic 跳过，五元组拉黑）；事后不判定此类别，见下
  | "startup-timeout"    // 45s 窗口内 failed 且无输出 → 该降级，五元组级计数拉黑（2 次）
  | "runtime-failure"    // 有输出后失败 / 窗口外失败 → 不降级
  | "format-error"       // Leader JSON 解析失败 → 不降级（既有 ≤2 次重试 :47/645-657）
  | "user-stop";         // stop/reject → 不降级
```

无法归类的启动期错误 → `runtime-failure` 对待（不降级），宁失败交回 Leader。

#### model-unknown 的边界（修正 B3：`default` 与冷启动）

事前跳过**仅当同时满足**：该 provider 的 `ModelCatalogService` 快照存在、`models` 非空（目录已就绪），且 `agent.model !== "default"`（`task-types.ts:81` 的合法值，`agent-dispatch.ts:53-54` 会解析成服务端默认模型）且模型名不在快照清单（精确匹配失败）。以下情形**一律放行派发**，交给事后降级：

- 快照缺失/为空/该 provider 从未刷新成功（冷启动）；
- `model === "default"`；
- effort 用 `provider:level` 原生格式（`task-types.ts:16-17`，不校验）。

方向明确为「**拿不准就放行**」：事前检查只是省一次启动的 opportunistic 优化，不是准入闸。**事后不设 `model-unknown` 判定（R4 修正，二选一的结论）**：六个 provider 的「模型不存在」错误文案各异且无稳定样例串可判定，事后一律并入 `runtime-failure` **不降级**；代价是「快照未就绪时放行的坏模型」只能靠 `startup-timeout`（窗口内 failed 且无输出）兜住，窗口后才报错的则交回 Leader 人工决定——这是有意的保守取舍，避免用不可靠文案匹配制造误降级。事前跳过的候选（快照就绪时）计入五元组拉黑。

- **事前跳过的留痕（N3 写死）**：`model-unknown` 的事前跳过**同样走 `degradeWorkStep`**（errorKind=`model-unknown`），
  因此留下 skipped 步 + `dispatchInfo.skipped` 记录 + 群聊「已切换到候选 N」notice + 时间线「备用候选」可展开，
  与 §9.2 的两条可观测性断言一致；差别仅在于它由事前快照比对触发、**不经过 `isDegradableWorkFailure`**（该函数只收
  事后 `{spawn-missing, startup-timeout}`）。实现者不得在 `dispatchStep` 里静默挑下一个候选——那样 §9.2 必红。

#### run 级黑名单（修正 B12：两层键值）

存 `run_state_json`：

```ts
interface RunBlacklist {
  providers: SessionProvider[];              // spawn-missing → provider 级：同 provider 的全部候选直接跳过
  agents: string[];                          // 五元组 key（provider|model|effort|mode|kind）：model-unknown、
                                             //   startup-timeout 累计 2 次的候选
  hostDisabled?: "structured" | "pty";       // host-disabled → 对应 kind 的候选全部跳过
}
```

- 只影响本次运行，不写回团队定义。`host-disabled` 若把全部剩余候选封死 → 同「候选耗尽」。
- **候选耗尽 / 全盲的统一出口（修正 B13 死循环边界，采纳 S13）**：
  - work 成员候选耗尽 → `degradeWorkStep` 退化点：最后一候选也失败 → 步骤记 failed（现有路径），`advance` 交回 Leader（:710/738）——Leader 会看到「X 的所有候选不可用」的报告行并自行决定 ask/finish；不另设 waiting_user 捷径。
  - **Leader 自己的候选不可用** → 唯一出口是既有 `:632-640`（`outcome.sessionError` → waiting_user + 换模型提示），优先级最高；Leader 全候选拉黑时在同处把提示文案升级为「所有候选均不可用（逐个原因），请到团队页调整」。不新增第二条 waiting_user 路径。
  - `dispatchStep` 事前发现某成员全部候选已拉黑 → 不派发，步骤直接 `failed` 写原因，仍交回 Leader，不循环。

### 3.5 `WandTaskAgent` 与候选身份

`src/task-types.ts:78-87` 五元组（provider/model/thinkingEffort/mode/kind）不改。候选身份 = 五元组精确匹配（`agentKey()` 工具函数放 ai-team-types.ts，黑名单与保存期去重共用；去重比较时 `model:"default"` 与具体默认模型名**不做等价归一**，按字面量去重即可）。保存禁止重复候选（400）。

### 3.6 兼容读点清单（`member.agent` 永久兼容字段，复核 §9.3）

以下**五个现存读点**在实现时必须明确口径，写进对应任务：

| 读点 | 位置 | v2 口径 |
| --- | --- | --- |
| 看板派工 | `src/web-ui/react/issues/task-board-agent.ts:32-45` | 继续读 `agent`（=首选），不改 |
| 群聊署名 | `ai-team-runner.ts:150` chatAuthor | **改为传入实际候选的 provider**（T3b） |
| 会话复用比对 | `ai-team-runner.ts:847-860` liveSessionFor | 比对基准改为该成员**最近一步实际使用的候选**（读最近 step 的 `dispatchInfo.usedCandidate`；无记录则首选），避免降级后每次判定不匹配另开会话（T3） |
| 提示词成员行 | `ai-team-prompts.ts:45-49` memberLine | 只渲染首选（§4.3），仍可读 `agent` |
| 未升级 Android | survey §6 | 只读 `agent`，靠双写兼容 |

## §4 服务端 API 契约

### 4.1 团队 CRUD（改）

- `POST/PUT /api/ai-teams*`：members 接受 `agents`（1–4 个）或旧 `agent`；服务端强制 `agent = agents[0]`。
- 校验（前端同口径）：成员 2–8（`ai-team-types.ts:4-5` 既有常量）、**恰好 1 个 `isLeader: true`**（修正 B9，字段名 `isLeader`，`ai-team-types.ts:18`）、每成员 ≥1 候选、候选五元组不重复。
- **新增 `GET /api/ai-teams/:id`**（修正 B14，现不存在）：返回团队对象 + 该团队 run 列表摘要，404 走 `sendTeamError` 风格；落 T5。`GET /api/ai-teams` 不变。

### 4.2 直接开工路由（需求 D，修正 B5/B8）

两方案对比结论不变（方案②需把 `ai_team_runs.task_id TEXT NOT NULL`（`storage.ts:984`）改可空，违反只加不删）。**采用方案①**，收口如下：

```
POST /api/ai-teams/:id/runs
  body: { note: string(≤4000), workspaceId: string }     // workspaceId 必填；【无 cwd 入参】
  202: { run, steps, memberStates, taskId }
```

- **工作目录硬约束（R2 收口）**：`storage.getWorkspace(workspaceId)` 不存在 → 400「请选择工作项目」；**`workspace.kind === "global"` 一律 400 拒绝**（「AI 团队不能在全局暂存工作区运行，请先选择或创建一个项目」）。理由：global 工作区的 `cwd = <configDir>/scratch`（`storage.ts:1395-1407`，本轮核实 `ensureGlobalWorkspace`）非空，能通过「cwd 非空」校验，但它不是用户的代码仓库，多成员并发写 scratch 无意义且危险；§9.7 的「绝不落全局目录」判定以此成立。另注意真正的 scratch 兜底位置（**N2 按实测回正归因**）：`createWandTask`（`storage.ts:1769-1777`）在 `workspaceId` 缺省时**不兜底**，写的是 `input.workspaceId ?? null`（存 NULL）；`ensureGlobalWorkspace()` 的兜底在 `updateWandTask`（`storage.ts:1784`，仅在 `workspaceTaskId` 非空时同步 `workspace_tasks`/`command_sessions`）与**团队派发链路真正会走到的 `wand-task-sync.ts:133`**（`ensureWorkspaceTaskForBoardTask`：`card.workspaceId ? getWorkspace(...) : ensureGlobalWorkspace()`，由 `resolveTaskDispatchTarget` 调用）。也就是说：**NULL/缺省 workspaceId 的卡不会在建卡时报错，而是在派发时静默落到 `<configDir>/scratch`**——所以校验必须放在入口，T5 必须显式传已校验的非 global workspaceId，绝不允许省略入参（r3 把它归到 `createWandTask` 是错记）。不接受客户端任意 cwd（目录越界面）；`resolveTaskDispatchTarget` 的 `config.defaultCwd` 兜底链（`agent-dispatch.ts:25-34`）对本路由不可达（workspace 存在且 cwd 非空即止步）。
- 原子性：先 `storage.createWandTask({ workspaceId, title: note 首行（task-title 既有截断规则）, description: note, labels: ["team_direct"], status: "processing", agent: 首选 })`（`storage.ts:1769`），再 `runner.start({ teamId, taskId, note })`（现有签名，runner 零改动）；**start 抛错 → `storage.deleteWandTask(taskId)` 回滚刚建的卡**（`storage.ts:1794`；回滚自身失败只记日志），错误原样 `sendTeamError` 映射，不留空卡。
- 团队直发卡归属：`labels_json` 放 `team_direct` 标记（createWandTask 支持 `labels` 入参，:1769；复核 §4.6 落定，不再留未决）；迭代按 AGENTS.md 写路径规则落默认迭代（惰性创建失败即建卡失败即整体 400，无半成品）。
- 去重语义：**服务端不做跨卡去重**（每次点击 = 一张新卡一个新 run；:253-254 的「同任务唯一活跃运行」以 task 为键，对新卡天然失效）。防连点靠前端：按钮 submitting 期间禁用 + 原位反馈。写进 T5 验收（采纳 S11）。
- **入口上下文区分（修正 B8）**：已处于某任务上下文的欢迎页**不显示团队选项**（会冗余建卡）；只有「项目欢迎页（无任务）」与侧栏新建任务、团队页走本路由。
- 旧路由 `POST /api/wand-tasks/:id/team-runs`（:146-155）不动，任务卡片内指派继续走它。

### 4.3 提示词变更（需求 B）

`src/ai-team-prompts.ts`：

- `memberLine`（:45-49）：渲染 `id、name、role 标签、duty` + **仅首选候选**一行 `provider/model/effort`，并写明「执行配置由系统按候选顺序自动降级，你只按成员能力分派，不操心模型可用性」。
- `leaderSystemPrompt`（:75-95）工作方式段（:85-90，保留 :88/:89 原文）追加两条：
  - 「派工优先按角色：制定计划给 plan 成员，实现给 work 成员，验收给 verify 成员；没标角色的成员视为 any。」
  - 「同一成员同一时间只有一个步骤；互不相干的步骤并行派出，有先后关系的用 after 声明。」
- 回复格式要求（:91-95 附近）追加：「实现步骤的 instructions 必须列出允许改动的文件/目录范围；验收步骤的 instructions 必须以『验收标准』清单收尾。」文件不重叠靠此约束 + Leader 自律，服务端不做文件级校验（§11-Q2）。
- 成员 system 提示追加一句：「你的发言会以群聊气泡出现，署名是你的名字；报告仍写进报告文件。」

### 4.4 运行详情（改）

- `detail(runId)`（`ai-team-runner.ts:405-416`）响应扩展 `AiTeamRunDetail`（`ai-team-types.ts:104-109`）：
  - `steps[i].dispatchInfo`（解析 `dispatch_info_json`）；
  - `chatTurns: ConversationTurn[]`：从 relay 会话 `ops.snapshot(run.chatSessionId).messages` 透传，**截尾 200 条**；`chatSessionId` 为 null 的旧运行返回 `[]`。面板截尾视图与「打开群聊」完整会话内容不一致是预期行为（§9.7 有对应检查项）。
- 不新增 WS 事件类型：`ai-team-run` 通知（`server.ts:456-460/:1027-1029`）驱动面板重拉 detail。

### 4.5 鉴权与错误（修正 S1）

- 团队路由现状**没有 per-route 中间件**（`server-ai-team-routes.ts:102+` 全文无 requireAuth）；安全性来自 `src/server.ts:665` 的全局 `app.use("/api", requireAuth)`，且 `registerAiTeamRoutes` 注册点（`server.ts:802`）在其后。新路由同样注册在该全局中间件之后即受保护；**T9 回写 v1 文档时修正 docs/ai-teams.md §4.8 的错误表述**。
- 409/404/400 沿用 `sendTeamError`（:23-27）。
- `reason`/报告字段经 `summarizeError` 式头尾截断（runner:158-162）；全链路不写连接码/token/home 路径。

## §5 Web 交互与页面（需求 C、D、E）

### 5.1 入口矩阵（修正 B8/S2）

| 入口 | 现状（survey §3） | v2 目标 | 走什么 |
| --- | --- | --- | --- |
| 看板·新建任务 / 详情指派 | ✅ | 成员卡片换多候选（§5.2）；指派不变 | 现路由 |
| 侧栏「新建任务」picker | ❌ 只有 6 CLI+shell（`workspace-agent-picker.tsx:17-31` 固定 7 项） | ✅ picker 选项加分组「AI 团队」，**仅在「已选中已有项目」态可选**（R2）：对话框里项目常在提交时才创建（手输目录 → `repository.create` 于 `workspaces/host.tsx:207-211`；不选目录 → 合成 `kind:"global"`，:227-232），团队分支拿不到「提交前已存在的 workspaceId」→ 手输目录/无项目态下团队选项**禁用**并原位说明「AI 团队需要先选择已有项目」。选中团队后隐藏「会话类型/模型」fieldset，提交用所选项目的既有 id | `POST /api/ai-teams/:id/runs` |
| 工作区欢迎页·**项目（无任务）** | ❌（`shell-main-content.tsx:131-150`，`WorkspaceWelcomeChooser` :220+） | ✅ 同 picker 团队分组，workspaceId 用当前项目 id，且**当前项目 `kind === "global"` 时不显示团队选项** | 同上 |
| 工作区欢迎页·**任务上下文** | 同上（`workspaceTask` 分支 :132-140） | ❌ **不加团队选项**（已有任务卡上下文，走方案①会冗余建卡）→ 用户想组队干活从看板卡片指派 | 旧路由 |
| 团队页「直接开工」 | — | ✅ 每团队卡片原位展开 note 输入（§7 要求 1/3）；开工表单含**已有项目选择器**（只列 `kind!=="global"` 的项目，缺省最近一个；一个都没有时原位提示先创建项目） | 新路由 |
| 「新对话」对话框 | ❌（`new-session/host.tsx:350-382`） | 不做（§11-Q1） | — |
| composer-config | ❌ | 不做（会话不挂团队） | — |

- **picker 改造影响面**（修正 B8，此前严重低估）：`WorkspaceSessionTarget = WorkspaceProvider | "shell"`（`workspaces/types.ts:9`）不 widening——团队作为 picker 的独立 `teamId` 选择态（`WorkspaceAgentPicker` 内新增 state 分支），`onStart`/提交链路按「会话 or 团队」分叉；`WorkspaceWelcomeChooser.onStart` 签名（:235）不改，新增可选 `onStartTeam?(teamId, workspaceId)` 旁路。`workspaces/types.ts` 补进 T7 白名单。
- **成功后导航（修正 B8）**：看板/团队页有 `onOpenSession`（`task-board-host.tsx:436` 同款），欢迎页路径没有 → 统一改为：成功后 dispatch shell 的会话选择动作选中 `chatSessionId`；若欢迎页拿不到该能力，退化为跳转「团队页-该运行」面板（实现时二选一并写进验收记录，不允许静默停在原地）。
- **团队数据**（修正 S2）：`aiTeamsRepository.list()` 已存在（`repository.ts:26-28`，无缓存）。T7 只加轻缓存：picker 打开时 fetch 一次 + `ai-team-run` 通知不失效它（团队定义变更由团队页保存后主动 invalidate），不做 shell 预取。

### 5.2 团队编辑页多候选（需求 C）

`src/web-ui/react/ai-teams/teams-page.tsx` MemberCard（:255-263 现单 `AgentFields`）改为候选列表容器：

- 每候选一行，复用 `src/web-ui/react/issues/agent-fields.tsx` 的 `AgentFields`（:49-104）。行尾：↑ 上移、↓ 下移、✕ 删除（仅剩 1 候选禁用）；底部「+ 添加候选」（上限 4，达到禁用并 title 说明）。第一候选标「首选」，其余「备用 2/3/4」。不做拖拽。
- 校验与 §4.1 同口径（**isLeader** 恰 1）；错误显示在对应卡片/行原位，不 Toast。
- 看板任务详情的 `AgentFields`（`task-board-host.tsx:1326-1336`）只读展示首选，不改。

### 5.3 群聊式运行面板（需求 E，修正 B6/B15/S6/S7）

**消息模型**：不新建表、不新建会话类型；继续用 run 的 relay 会话（`chatSessionId`）。

**数据与去重（B6：ConversationTurn 没有 id，不能用消息 id 做键）**：
- 群聊视图是**全量替换模型**：detail 重拉 → `chatTurns` 整段替换，不做增量合并，不需要稳定 key（React key 用 `createdAt+index` 仅防告警）。
- 用户插话乐观显示：本地临时行（React state，`{local: true}`），发送 resolve 后保留到下一次 `ai-team-run`/会话事件触发的重拉，重拉内容含该 turn 文本（按 `createdAt` 晚于发送时刻 + role=user 粗匹配）即移除临时行；重拉失败（网络）则临时行保留并显示「未确认」。

**署名与实际候选（B15）**：`chatAuthor`（`ai-team-runner.ts:144-153`）增加参数取**该步骤实际使用候选**的 provider（由 postNotice/postTurn 调用方传入 step.dispatchInfo.usedCandidate 对应 agent；Leader/无步骤场景回退首选）。降级发生处同时 `postNotice` 一行：「⚠️ <成员名> 的首选配置不可用（<原因>），已切换到候选 <N>」——服务端一处改动、群聊默认视图下需求 A 的可观测性不被时间线挡住（落 T3b）。

**渲染边界**：
- 完整聊天页（legacy `chat-render.ts`）**不改**，「打开群聊」按钮保留（`team-run-panel.tsx:273-276`）。
- 面板内嵌群聊 = 新 React 组件 `src/web-ui/react/ai-teams/team-chat-view.tsx`（进 ai-teams chunk）。不复用 chat-render（DOM 命令式渲染绑 legacy 会话状态机）。只读渲染 `chatTurns`，气泡/notice 样式在 `ai-teams/styles.ts` 用既有类名与 token 对齐 `teamAuthorAvatar`（chat-render.ts:1891-1908）的视觉，不复制色值。
- **输入框调用路径（S7 + R5，端点名定）**：客户端往 relay 会话发消息走 **`POST /api/structured-sessions/:id/messages`**（路由在 `src/server-session-routes.ts:764`，内部调 `structured.sendMessage`（:783）→ relay 拦截 `structured-session-manager.ts:1411-1416` → `runner.chatInput`）——**HTTP 端点，不是 WS 帧，不自造端点**。`awaiting_approval` 状态时输入框上方显示引导语「回复『批准』即开工，其他内容会作为修改意见转给负责人」（短语表 APPROVE_REPLY 会把「好的/可以/ok」当批准，`ai-team-runner.ts:51`）。`running` 时提示「将作为插话，负责人下一轮看到」（pendingNotes 路径 :389-396）。

**视图切换**：
- `RUN_VIEWS`（:208-211）扩为「**群聊** | 时间线 | 按成员」，群聊默认（§11-Q4）。tabs 复用 `WandStretchTabs`（不自造指示条，S5/要求 5）。
- 三视图同容器叠放，交叉淡入淡出；**禁止 `key={view}` remount**（退场元素被卸载就无淡出，S6）；用两个持久子容器 + 可见性类切换。
- ≤760px 窄屏：三 tabs 保持，视图容器退回单栏自然高度（绝对定位叠放在窄屏改为隐藏非当前视图 + 静态流式，避免高度互相覆盖）；在 T8 验收里窄屏过一遍。
- 时间线视图：StepRow 卡片内若 `dispatchInfo.skipped` 非空，原位「备用候选 N」chevron 展开被跳原因（要求 7）；群聊视图靠 B15 的 notice 行可见。

### 5.4 Bundle 预算

team-chat-view 进 ai-teams 懒加载 chunk（`scripts/ai-teams-chunk.js` / `chunk-entry.ts` / `lazy.tsx:36-64` 借模块注册表逐名同步）；主包 `npm run check:bundle-budget` 应零增量。

## §6 Android（需求 F）

Web 先行合入并验收后开工；服务端契约（T1–T5）冻结后 Android 不再需要服务端二次改动。

### 6.1 协议镜像 + repository（A1）

- `android/app/src/main/java/com/wand/app/data/WandModels.kt`（ConversationTurn :346-354）补 `author`（镜像 `src/types.ts:564-575`）、`notice: Boolean?`，全部带默认值容错旧服务端。
- `data/WandApi.kt`（手写 OkHttp，:27，照 :514-549 模式，不引 Retrofit）新增：`GET /api/ai-teams`、`GET /api/ai-teams/:id`（**依赖 T5 新增，已补**，B14）、`GET /api/ai-team-runs/:id`、`POST /api/ai-teams/:id/runs`、动作 POST（approve/reject/reply/continue/stop，`server-ai-team-routes.ts:177-184` 既有）。
- 新 `data/AiTeamModels.kt`：AiTeam/AiTeamMember（`agents: List<AgentSpec>` + `agent` 兼容）/AiTeamRun/AiTeamStep/StepDispatchInfo。

### 6.2 页面与导航（A2/A3/A4）

- `ui/AppNav.kt:10-48` 增 `AiTeams`、`AiTeamDetail(teamId)`、`AiTeamRun(runId)`；同步 `WandApp.kt:460-597` when 穷举、`AppNav.kt:195-204` 转场 saver——穷举分支不得用 else 吞新目的地。
- 新 Screen（`ui/screens/`）：`AiTeamsScreen.kt`（列表 + ＋ 展开模板面板）、`AiTeamDetailScreen.kt`（成员 + 候选只读行，首选高亮；顶栏「编辑」进编辑器；「直接开工」底部弹 note，**必选 workspace**——对齐 §4.2 无 cwd 自由度）、`AiTeamEditorScreen.kt`（新建 / 编辑同屏，见 §11-Q6）、`AiTeamRunScreen.kt`（TabRow「群聊 | 时间线」，群聊默认，交叉淡入）、`AiTeamChatPanel.kt`（author 气泡 + notice 居中行 + 输入走既有会话消息通道，镜像 §5.3 的批准引导语）。
- 复用：`ChatBlocks.kt:188-250` TurnView 结构（assistant 头换成员署名）；`ThinkingEfforts.kt:29-47` 目录消费用于首选展示。
- `NewTaskComposerScreen.kt:146-177` provider 下拉加「AI 团队」组（走同一直发路由）。

### 6.3 真机验收（A5）

1. `cd android && SKIP_INSTALL=1 APK_DIST_DIR="$HOME/.wand/android" ./debug.sh`；
2. 版本基数 `git tag --list 'v[0-9]*' --sort=-v:refname | head -1`，产物 `X.Y.Z-debug.MMDDHHMM`；禁未带版本 apk；
3. `adb install -r -d <apk>`，连接信息读本机私密文件（不入库、不入日志/截图）；
4. 过 §9 Android 清单；
5. `/api/android-apk-update?currentVersion=0.0.0&channel=beta` 返回新版本且可下载。

## §7 动效（需求 G，修正 B11：不留裸字面量）

规范源 `docs/motion-design.md`。现状事实：**时长 token 只在 Android `WandMotion`**（`android/app/.../ui/theme/Theme.kt`，值表见 motion-design.md:22-27）；Web 侧没有时长 token（`styles.css:163-167` 只有缓动变量），reduce-motion 判定只有 `ui/stretch-tabs.tsx:18` 私有函数。因此：

- **Android**：一切时长/曲线取 `WandMotion`（指示条 `indicator()` 260ms + trail 70ms、图标 `morph()` 200ms、退场 `quickExit` 90ms、展开 `normal` 240ms）。
- **Web（T6 建立的最小 token 清单，采纳复核「同一提交增补规范」）**：在 `src/web-ui/content/styles.css` 的 `:root` 高级缓动块旁新增，并同步 `docs/motion-design.md` 的 token 表补一列 Web 变量名（T9 完成）：

  | token | 值 | 对齐 WandMotion |
  | --- | --- | --- |
  | `--motion-press` | 110ms | press |
  | `--motion-fast` | 150ms | fast |
  | `--motion-normal` | 240ms | normal |
  | `--motion-morph` | 200ms | morph |
  | `--motion-indicator` | 260ms | indicator |
  | `--motion-quick-exit` | 90ms | quickExit |
  | `--motion-dwell-sent` | 720ms | `SEND_SENT_DWELL_MS`（motion-design.md:63） |
  | `--motion-dwell-failed` | 1500ms | `SEND_FAILED_DWELL_MS`（同上） |

  dwell 两项是「结果停留」常量而非 transition 时长，同样收进 token 表统一管理，页面不得另取秒值。**R5：Web dwell 定死沿用 Android 现值**（720/1500ms），不在最长动画 token（260ms）里硬凑。

  **读取机制（N4 二选一的结论：走 (i) 集中常量文件，不从 CSS 反读）**：dwell 用在 JS 计时器里（`setTimeout` 的毫秒数），CSS 变量对它没有直接作用，`getComputedStyle(…).getPropertyValue("--motion-dwell-sent")` 这种反读既慢又要在 CSS 缺值时兜底，**不采用**。定死为：新建 `src/web-ui/react/ui/motion-tokens.ts`（已并入 T6 白名单）导出 `MOTION_DWELL_SENT_MS = 720` / `MOTION_DWELL_FAILED_MS = 1500`，JS 侧只从该模块取值；CSS 侧仍定义 `--motion-dwell-*` 两行**只供样式表引用**（如停留期的 `animation-duration`），两边同值由 T6 的 `[T6]` 用例断言常量数字，不做跨层读取。模块顶部注释指向 `docs/motion-design.md:63`，与 Android 同名常量对齐。

  页面/组件的 transition 声明只引用 `var(--motion-*)`，不写字面毫秒。
- **Web reduce-motion**：新 `src/web-ui/react/ui/reduce-motion.ts` 导出 `reduceMotion()`（把 `stretch-tabs.tsx:18` 的私有实现上移共用，stretch-tabs 改引它——同属 T6 白名单 `ui/` 小改），CSS 侧对应用 `@media (prefers-reduced-motion: reduce)` 归零。真值下位移/缩放/淡入全部退化瞬时。**dwell 在 reduce-motion 下不归零（N4 随修）**：720/1500ms 是「读结果的等待」而不是位移动画，归零会让成功态一闪而过、AGENTS.md 的瞬时化要求针对的是位移/缩放/淡入，不含读结果的停留；实现时不要把 `reduceMotion()` 套到 `MOTION_DWELL_*` 上。
- **交叉淡入**（三视图）：进场 `--motion-normal` + `--ease-in-out-smooth`、退场 `--motion-quick-exit`（退场快于进场，符合 token 表「旧内容退场 quickExit 比进场快」的原始语义；**废弃此前的 200/140ms 裸写**）。
- 八条逐条：
  1. 搜索原位展开：团队页现状合规不改；「直接开工」note 从按钮原位展开成输入、光标自动聚焦（按钮形变出输入框，本体不位移）。
  2. 加号原位展开：「+ 添加候选」新行原位高度 0→auto + 淡入（`--motion-normal`）；删除是倒放。
  3. 提交后原位反馈：加载→完成→结果同位依次显示，不 Toast；**完成态停留（dwell）后再导航**：Web 取 `MOTION_DWELL_SENT_MS`（720ms）/`MOTION_DWELL_FAILED_MS`（1500ms）（`ui/motion-tokens.ts`，CSS 侧同名 `--motion-dwell-*` 仅供样式引用），Android 取同名 `SEND_SENT_DWELL_MS`/`SEND_FAILED_DWELL_MS`（motion-design.md:63）——两端同值，不即兴；失败原因原位红字。
  4. 成对图标连贯变形（采纳 S5）：沿用 v1 已确立的「＋ 旋转成 ✕」（开工 ⇄ 收起、添加候选 ⇄ 收起表单态）；**↑↓ 移动与 ✕ 删除候选**同样 morph/位移衔接（禁用态降为透明度变化），不许硬切。
  5. 指示条：`WandStretchTabs`/`stretch-indicator.ts` 既有实现（先拉向新位、前缘先走），**不自造**（S5/要求 5）。
  6. 数量选择器：不适用。
  7. 「备用候选」详情在当前步骤卡下方原位展开、其余下移，不跳转。
  8. 视图切换交叉淡入淡出，不整屏重入场；禁止 remount（§5.3）。
- 关闭路径：note 输入、添加候选、开工反馈各有 Esc / 点外部 / 收起按钮三条路径，收起是展开的倒放。

## §8 任务拆解（v2-r2 重排）

角色代号：后端=甲，前端=乙，安卓=丙，验收成员=与实现者不同的另一名成员（表内指名，采纳 S12）。**合并顺序即串行约束**：同一文件只属于链条上相邻任务，后一任务必须等前一任务合入后开工。

文件归属总表（消除并行冲突，修正 7.1/7.2）：

| 文件 | 唯一所有者（串行链） |
| --- | --- |
| `src/ai-team-runner.ts` | T3 → T3b（串行，T5 不再触碰） |
| `src/storage.ts` | T1 → T3/T3b（T1 先合） |
| `src/server-ai-team-routes.ts` | T1 → T4（prompts 无交集，T4 只动 prompts）→ T5 |
| `src/server.ts` / `src/agent-dispatch.ts` | 仅 T3 |
| `teams-page.tsx`、`ai-teams/styles.ts` | T6 → T7 → T8（W1 严格串行） |
| `src/web-ui/react/ui/reduce-motion.ts`、`ui/motion-tokens.ts` | 仅 T6（新建，T7/T8 只读引用） |
| `tests/web-ui-ai-teams.test.ts` | T6/T7/T8 各加带 `[T6]/[T7]/[T8]` 用例名前缀的独立段，按上述串行顺序追加 |

### T1 类型与存储迁移（后端·甲）

- 依赖：无。白名单：`src/ai-team-types.ts`（`agents`/`role`/`TeamMemberRole`/`memberAgents`/`agentKey`）、`src/storage.ts`（两新列 + `mapAiTeamRow`/`mapAiTeamRunRow` 成员归一，:2817/:2831）、`src/server-ai-team-routes.ts`（parseMembers 双格式、`agent=agents[0]`、**isLeader** 校验、重复候选 400）、`tests/server-ai-team-routes.test.ts`（扩展）、`tests/storage-ai-team-migration.test.ts`（新建，S8 旧 schema 文件用例）。
- 产出：§3.1、§3.2、§4.1 校验。
- 验收（执行人：前端·乙，他不写后端）：`node --test --import tsx tests/server-ai-team-routes.test.ts`、`node --test --import tsx tests/storage-ai-team-migration.test.ts`；旧库（members_json 无 agents、team_json 快照旧格式）读出 `memberAgents` 单元素数组。
- 实现提醒（R4c）：`agents` 在类型上定为必填后，`mapAiTeamRow`/`mapAiTeamRunRow` 从 `members_json`/`team_json` 解析出的裸 JSON **不满足**新类型（旧数据没有 `agents`）——必须先按 `unknown`/宽松旧形解析，经 `memberAgents` 归一补齐后再当 `AiTeamMember` 用；禁止直接类型断言。
- 禁止：不动 `ai_team_runs` 既有列（尤其 `task_id`，`storage.ts:984`）；不 DROP；不动 `src/task-types.ts`。

### T2 失败分类纯函数（后端·甲）

- 依赖：T1。白名单：`src/ai-team-availability.ts`（新建）、`tests/ai-team-availability.test.ts`（新建）。
- 产出：§3.4 分类 + `isDegradableWorkFailure` 判定核（输入 snapshot/classify 结果，纯函数可单测）。
- 验收（乙）：`node --test --import tsx tests/ai-team-availability.test.ts`；用例覆盖 ENOENT/「未启用结构化」/`model:"default"` 放行/空快照放行/窗口外 failed 不降级/PTY 一律不降级。
- 禁止：不接 runner、不读全局状态。

### T3 降级主链接线（后端·甲）

- 依赖：T1、T2。白名单：`src/ai-team-runner.ts`（dispatchStep 同步 catch、finishStep 入口在 `stepsUsed += 1`（:613）之前的降级判定、degradeWorkStep 含 **queued 步 dependsOn 重指向新步**、`liveSessionFor` 比对基准 :847-860、`AiTeamRunnerOptions` 加 `models?: () => …` 快照 getter）、`src/server.ts`（在 :457 的 `createAiTeamRunner` 构造点直接注入 catalog getter——`ModelCatalogService` 构造在 **`server.ts:421`，早于 runner**（本轮 grep 复核；:1143 只是 `onChanged` 订阅点，第一轮 r2 的「晚于、需调整构造顺序」是错记，**不要动 server.ts 构造顺序**，B7/R3）、`src/agent-dispatch.ts`（若分类需要复用 `resolveTaskDispatchTarget`/错误文案则只读引用，不改行为）、`tests/ai-team-runner.test.ts`（扩展）。
- 产出：§3.4 降级时序全部（开新 step、stop 旧会话安全阀（含 try/catch 只记日志）、**queued dependsOn 重指向**、新步继承旧步 dependsOn、**降级只直接派 A′ 不整轮 advance**（同栈过期快照不变式）、两层黑名单 `run_state_json`、startup window 常量 45s、候选耗尽交回 Leader 的唯一出口、Leader 出错路径 :632-640 优先级）、`model-unknown` 的**事前跳过（快照就绪时）走 `degradeWorkStep` 留痕**（不经 `isDegradableWorkFailure`）。
- 验收（乙）：`node --test --import tsx tests/ai-team-runner.test.ts`——注入假 `ops.open`（`AiTeamSessionOps` 可整体替换，接口 `ai-team-runner.ts:58-71`，本轮 grep 复核）抛 ENOENT / 假 snapshot status=failed 无 messages，断言：旧步 skipped、新步 queued→派发候选 2、新 reportPath 不同、stop 被调用、黑名单生效；**降级判定在 stepsUsed 之前**：首个候选失败降级后 `run.stepsUsed` 不变（R4a）；**依赖链用例（R1）**：Leader 派 A→B（B after A），A 触发降级 → 断言 B.dependsOn 已重指向新 A′、A′ done 后 B 正常派出，且**同轮其余 queued 步未被 `startLeaderRound` 批量作废**（反例断言：降级后 queued 集合只少了 B 的重指向变化，没有出现意外 skipped）；**同栈过期快照用例（N1，必测）**：Leader 同轮派 A(m1)+S2(m2)，注入假 `ops.open` 让 A 的派发**同步**抛 ENOENT 触发降级 → 断言 `ops.open` 对 S2 只被调用**一次**、A′ 与 S2 各只有一个会话、没有出现第二个 A 会话（这条直接挡住 degrade 内整轮 advance 造成的二次派发）；45s startup window 用注入假 `now` 时钟做确定性用例（runner 构造器接受 `ops`/`resolveCwd`/`now`，`FakeOps` 见 `tests/ai-team-runner.test.ts:28`）。**降级验收一律用注入假 ops/snapshot，不在已装服务上卸载 CLI/改 PATH（采纳 S10）**。
- 禁止：不加定时器/await 轮询；不覆写同 step 的 sessionId；stop/reject/format-error 路径不得触发降级；PTY 异步失败不降级。

### T3b 可观测性与署名（后端·甲）

- 依赖：T3（同文件串行）。白名单：`src/ai-team-runner.ts`（chatAuthor 实际候选 provider、degrade 处 postNotice 群聊降级行、`postLeaderDecision` :900+ 的 verify 错派 notice、`detail()` 扩展 dispatchInfo）、`src/ai-team-types.ts`（`StepDispatchInfo`、`AiTeamRunDetail.chatTurns` 类型）、`src/structured-session-manager.ts`（如需只读取 relay messages——优先不改）、`tests/ai-team-runner.test.ts`（扩展）。
- 产出：§4.4 detail（chatTurns 截尾 200、旧运行 null → []）、§3.3 错派 notice、§5.3 署名/群聊降级 notice 的服务端部分、§3.6 五读点中 chatAuthor/liveSessionFor 的最终口径。
- 验收（乙）：`node --test --import tsx tests/ai-team-runner.test.ts`（断言降级 notice 出现在 relay turns、chatTurns 长度上限、错派 verify 出 notice 不拦截）；`npm run check`。
- 禁止：不新增 WS 事件；不改 `chat-render.ts`。

### T4 提示词（后端·甲）

- 依赖：T1；可与 T2/T3 并行（文件不相交）。白名单：`src/ai-team-prompts.ts`、`tests/ai-team-prompts.test.ts`（扩展）。
- 产出：§4.3 全部文案（memberLine 角色 + 仅首选候选、leader 两条工作方式、instructions 文件清单/验收标准格式要求、成员群聊意识一句）。
- 验收（乙）：`node --test --import tsx tests/ai-team-prompts.test.ts` 断言新文案与「Leader 提示词不含非首选候选」。
- 禁止：`parseLeaderDecision` 不加职责硬校验、不改成员存在性校验。

### T5 直发路由 + 团队详情端点（后端·甲）

- 依赖：T1（T4 合入后动 routes，见归属表）。**白名单只有 `src/server-ai-team-routes.ts` + `tests/server-ai-team-routes.test.ts`（扩展）——runner 零改动（start 现有签名）**。
- 产出：§4.2 `POST /api/ai-teams/:id/runs`（workspaceId 必填校验、getWorkspace 不存在/**kind==="global"**/cwd 为空均 400、建卡显式传非 global workspaceId（scratch 兜底不在 `createWandTask`，在派发侧 `wand-task-sync.ts:133`，缺省 workspaceId 的卡会在派发时静默落 `<configDir>/scratch`——N2 归因回正）、start 失败 `deleteWandTask` 回滚、`team_direct` label、202 带 taskId、无 cwd 入参、无跨卡去重）+ §4.1 `GET /api/ai-teams/:id`（B14，404 映射）。
- 验收（前端·乙）：`node --test --import tsx tests/server-ai-team-routes.test.ts`；curl 隔离实例（`npm run build && node dist/cli.js web -c /tmp/wand-dev/config.json`）：缺 workspaceId→400、**global workspaceId→400（R2）**、正常→202 且返回 taskId、start 失败场景（不存在的团队 id 变体/成员被删）不留卡；连点两次=两个 run 两张卡（判定明确即为过）。
- 禁止：不改旧路由；不动 runner/storage 代码（只调用）；不接受 cwd。

### T6 编辑页多候选 + Web 动效 token（前端·乙）

- 依赖：T1。白名单：`src/web-ui/react/ai-teams/teams-page.tsx`、`src/web-ui/react/ai-teams/styles.ts`、`src/web-ui/react/issues/agent-fields.tsx`（只加可选 props）、`src/web-ui/content/styles.css`（`:root` 加 §7 Web token 八变量，含两个 `--motion-dwell-*` 仅供样式引用）、`src/web-ui/react/ui/reduce-motion.ts`（新建）、`src/web-ui/react/ui/motion-tokens.ts`（新建，导出 `MOTION_DWELL_SENT_MS = 720`/`MOTION_DWELL_FAILED_MS = 1500`，dwell 的唯一 JS 读法，N4）、`src/web-ui/react/ui/stretch-tabs.tsx`（私有 reduceMotion 换引用，行为不变）、`tests/web-ui-ai-teams.test.ts`（扩展 `[T6]` 段）。
- 产出：§5.2 全部 + §7 Web token 基础设施（`styles.css` 八变量 + `ui/reduce-motion.ts` + `ui/motion-tokens.ts` 两个 dwell 常量）。
- 验收（后端·甲）：`npm run check && node --test --import tsx tests/web-ui-ai-teams.test.ts`（`[T6]` 段断言 `MOTION_DWELL_SENT_MS === 720`、`MOTION_DWELL_FAILED_MS === 1500`；reduce-motion 下 dwell **不归零**）；浏览器隔离实例：加第 2 候选→上移→删除→保存→GET agents 顺序一致；仅剩 1 候选删除禁用；重复候选前端拦截 + 后端 400 原位显示；`rg -- "--motion-" src/web-ui/content/styles.css` 有定义、新改动 CSS 无裸毫秒（本任务引入的 transition 全走 var）；`rg "720|1500" src/web-ui/react` 无裸毫秒写死（dwell 只从 `ui/motion-tokens.ts` 取）。
- 禁止：禁改生成物（`content/scripts.js`、`embedded-assets.ts`、`vendor/*`、`dist/`）；不做拖拽排序；不改 stretch-tabs 动画行为。

### T7 入口适配（前端·乙）

- 依赖：T5、T6（teams-page/styles 串行在后）。白名单：`src/web-ui/react/workspaces/workspace-agent-picker.tsx`、`src/web-ui/react/workspaces/types.ts`、`src/web-ui/react/workspaces/host.tsx`、`src/web-ui/react/ai-teams/repository.ts`（startDirect + list 轻缓存）、`src/web-ui/react/ai-teams/teams-page.tsx`（直接开工按钮）、`src/web-ui/react/shell/shell-main-content.tsx`（项目欢迎页旁路 onStartTeam；任务上下文分支不加团队）、`tests/web-ui-ai-teams.test.ts`（`[T7]` 段）。
- 产出：§5.1 三入口（侧栏新建任务、项目欢迎页、团队页开工按钮）；**侧栏手输目录/无项目态团队选项禁用+原位说明；项目欢迎页与团队页项目选择器过滤 `kind==="global"`（R2，对齐 workspaces/host.tsx:207-232 提交时才建项目/合成 global 的现实）**；团队选中隐藏 kind/model fieldset；成功后会话选择或退化跳运行面板（§5.1 二选一写明）；原位反馈含 dwell 后导航（§7 要求 3）。
- 验收（后端·甲）：`npm run check`；浏览器：三入口各起一次 run，看板出现 `team_direct` 卡，落到群聊/运行面板不静默；**无已选项目时团队选项不可用**；任务上下文欢迎页确认无团队选项；连点开工按钮无双 run。
- 禁止：不动 `new-session/*`、composer-config；不改 `WorkspaceSessionTarget` 联合类型（团队走独立态）；不跳页。

### T8 群聊面板（前端·乙）

- 依赖：T3b（detail/chatTurns）、T6；在 T7 之后合（W1 串行）。白名单：`src/web-ui/react/ai-teams/team-chat-view.tsx`（新建）、`src/web-ui/react/ai-teams/chunk-entry.ts`、`src/web-ui/react/ai-teams/lazy.tsx`、`src/web-ui/react/ai-teams/styles.ts`、`scripts/ai-teams-chunk.js`、`src/web-ui/react/issues/team-run-panel.tsx`、`tests/web-ui-ai-teams.test.ts`（`[T8]` 段）。
- 产出：§5.3 全部：三视图 tabs（WandStretchTabs）、群聊默认、持久容器交叉淡入（禁止 key remount）、窄屏策略、乐观临时行、批准引导语/插话提示、时间线「备用候选」原位展开、reduce-motion 瞬时。
- 验收（后端·甲）：`npm run check && npm run build && npm run check:bundle-budget`（主包零增量）；`node --test --import tsx tests/web-ui-ai-teams.test.ts`（chunk 注册表逐名）；浏览器：降级 run 的群聊里有「已切换候选 N」notice 行且气泡署名是实际 provider；tabs 切换无整屏重刷（devtools 断言容器节点未被卸载：切换前后同一 DOM 节点）；`git diff --name-only` 不含 `chat-render.ts`；≤760px 三视图不叠字。
- 禁止：不新建 WS 事件/端点；不复制色值；不自造指示条。
- 实现提示（免一次调试）：群聊输入走 `POST /api/structured-sessions/:id/messages`（`server-session-routes.ts:764`，本轮实测），**请求体字段是 `input`，不是 `text`**（`:765` `String(req.body?.input ?? "")`），另有可选 `interrupt`（:766）、`preserveQueue`（:769）、`idempotencyKey`（:770）；插话不带 `interrupt`，走 relay 分支进 `chatInput`。

### T9 文档回写（后端·甲）

- 依赖：T3b、T5、T6–T8。白名单：`docs/ai-teams.md`、`docs/motion-design.md`（Web token 列）、`AGENTS.md`（Runtime Map 增 ai-team v2 行、新列/新路由；采纳 S12）、本文档状态行。
- 产出：v1 文档同步 + **必改清单（验收门槛）**：§4.2 类型表补 instructions/avatar/planApproved/chatSessionId/pendingNotes/dependsOn/agents/role；§4.3 `dispatchAgentForTask` 签名（去 recordIteration、加 systemPrompt）；§4.6 报告稳定窗口口径；§4.7 方法名 `getRunningAiTeamStepBySession`；**§4.8 鉴权表述改为「全局 /api requireAuth + 注册顺序」**（S1）；§6 Android 状态更新。survey §8 的 6 条出入全修。
- 验收（前端·乙）：对照 survey §8 与本清单逐条勾。

### T10 Web 端到端独立验收（验收成员，非甲/乙）

- 依赖：T1–T9。白名单：不改产品代码；缺陷回给对应实现者。
- 验收：§9 Web 清单逐条（含隔离冒烟 + 按 AGENTS.md 用本机已安装服务与私密连接码的最终验收）；`npm test`、`npm run check`、`npm run build`、`npm run check:bundle-budget` 全量绿；产出验收记录文件。

### A1–A4 Android 实现（丙）

- A1 协议镜像 + API（依赖 T5；白名单：`WandModels.kt`、`WandApi.kt`、`AiTeamModels.kt` 新建）——验收（甲）：`cd android && ./gradlew :app:assembleDebug`；连旧版服务端不崩（默认值容错）。
- A2 导航三屏幕骨架（依赖 A1；白名单：`AppNav.kt`、`WandApp.kt`、三个新 Screen）——验收（甲）：真机走通列表→详情→开工→run 屏。
- A3 群聊渲染 + 候选只读（依赖 A2；白名单：`AiTeamChatPanel.kt` 新建、`ChatBlocks.kt`、`AiTeamDetailScreen.kt`）——验收（甲）：署名/notice/高亮/tabs 淡入，全取 WandMotion token。
- A4 新建任务入口（依赖 A1；白名单：`NewTaskComposerScreen.kt`、`WorkspaceTargetSheet.kt`、`WorkspaceRequestBodies.kt`）——验收（甲）：真机选团队开工跳群聊。

### A5 beta APK + Android 独立验收（验收成员，非丙）

- 依赖：A1–A4。不改产品代码。执行 §6.3 五步 + §9 Android 清单；产出验收记录。

### 并行/串行总览

```
W2: T1 → T2 → T3 → T3b ─┐
    T4（∥）              ├→ T9 → T10
    T5（T1/T4 后 ∥）     ┘
W1（T1 后开工，严格串行）: T6 → T7 → T8（T8 另需 T3b）
Android（Web 验收后）: A1 → A2 → A3；A4（A1 后）；A5
```

## §9 端到端验收清单（修正版）

Web：

1. 旧团队（仅 agent 数据）编辑页显示 1 候选可保存；旧运行详情（无 dispatchInfo、`team_json` 旧快照）正常展示不报错。
2. **集成层降级**（采纳 S10，不卸载 CLI）：单测/隔离实例把首选模型改成目录不存在名（真实降级，无需动 PATH）→ 自动用候选 2，时间线「备用候选」原位展开、群聊出现「已切换候选」notice、气泡署名=实际 provider；**事前跳过（快照就绪时 model 不在清单）同样留下 skipped 步 + notice，不得静默换候选**（N3）；`model:"default"` 候选不被事前跳过。
3. 冷启动（catalog 快照为空）起 run → 候选照常派发（拿不准放行），不因事前检查阻断（B3）。
4. PTY 成员：异步失败不降级、`completeStep` 手动收尾可用（B4 回归）。
5. 降级期间旧会话被 stop：注入慢失败假 ops 断言 `ops.stop` 被调；无两个 automationId 会话同时 running 同 cwd。
6. 职责分派：plan/verify 团队跑多步任务，计划→plan、验收→verify（抽查角色倾向，允许偶发偏离）；verify 成员已实现过又被派验收 → 群聊出提示 notice 不拦截。
7. 三入口（侧栏/项目欢迎/团队页开工）各起一次 run；任务上下文欢迎页无团队选项；**侧栏手输目录/无项目态团队选项禁用且原位说明；传 `kind:"global"` 的 workspaceId 被服务端 400 拒绝**（R2）；run.cwd 判定：既不等于 `config.defaultCwd` 也不等于 `<configDir>/scratch`，恒为所选项目目录（隔离实例直接验证）。
8. 直发连点两次的行为=两个 run 两张卡被判定为预期；按钮 dwell 反馈后才跳转。
9. 群聊默认视图、tabs 交叉淡入（DOM 节点不被卸载）、窄屏不叠字、reduce-motion 瞬时；面板群聊截尾 200 与「打开群聊」全量内容差异符合预期（「打开群聊」按钮在）；awaiting_approval 输入框有批准引导语。
10. stop/reject 不触发任何降级；同成员并发仍串行（busyMembers 回归）；`stepsUsed` 不被 skipped 降级步占用；**同轮多成员派发中有一步同步降级时，其它成员的步只被 `open` 一次（N1 二次派发回归）**。
11. `npm test`、`npm run check`、`npm run build`、`npm run check:bundle-budget` 全绿；`rg` 断言（T3 口径，采纳 S9）：runner 内 `member.agent` 直读仅剩 §3.6 名单中的合法兼容点（memberLine 首选渲染、chatAuthor 回退、liveSessionFor 回退），其余候选读取都经 `memberAgents(...)`。

Android（A5，真机）：列表→详情（候选只读、首选高亮）→开工（必选 workspace）→run 屏 tabs 群聊/时间线→插话→批准/停止；beta APK 五步（§6.3）；旧服务端连接不崩。

## §10 风险、回滚、兼容

- 数据兼容：双写 agent/agents；两新列带 DEFAULT 零回填；运行快照与团队定义两条读路都归一（§3.1）。回滚代码不需要回滚 schema。
- 误降级防护：分类失败不降级；startup window 45s 常量 + 两次才拉黑；降级 stop 旧会话安全阀；黑名单仅当次 run 生效。
- 自动建卡污染：`team_direct` label + 默认迭代；刷屏严重→前端隐藏团队选项段即回滚（路由保留）。
- chatTurns 体积：200 条截尾；reason 走 summarizeError 清洗；无凭据/路径入档。
- 兼容读点：§3.6 五读点同批改口径（T3/T3b/T4），看板与未升级 Android 只依赖 `agent` 双写不受影响。
- 鉴权：新路由处于全局 requireAuth 之后（server.ts:665/802），不新增凭面。
- submodule 纪律：Android 按 AGENTS.md 子仓库流程；本轮实施不做 git 操作。

## §11 未决问题（复核后逐条确认）

| # | 问题 | 推荐 | 复核确认 |
| --- | --- | --- | --- |
| Q1 | 「新对话」对话框要不要支持团队 | 不做（与侧栏入口重复） | 成立；需用户确认 |
| Q2 | 「实现≠验收」服务端硬校验 | 不硬校验，仅 notice 提示（T3b 已实现提示，B13 闭环） | 成立 |
| Q3 | 团队直发卡的可见性/归属/清理 | **已落定不留白**：`labels_json` 的 `team_direct`、默认迭代、看板可见；暂不做清理界面 | 成立 |
| Q4 | 默认视图群聊 vs 时间线 | 群聊（降级 notice 已同步进群聊，B15 闭环后可放心默认） | 成立，验收后复确认 |
| Q5 | 候选上限 4 | 4（1 首选 + 3 备用） | 成立 |
| Q6 | Android 多候选编辑 | **已推翻**：Android 现与 Web 同权——`AiTeamsScreen` 的 ＋ 按模板新建、列表卡与详情顶栏的「编辑」进 `AiTeamEditorScreen`，成员增删 / 名字 / 职责 / 负责人 / 候选（加删移）都能改；仍不编辑头像与 `role`，但 PUT 时原样回写。契约与测试见 `docs/ai-teams.md` §6 | 本条已按新需求更新（原「本期只读，编辑留 Web」） |
| Q7 | startup window 是否 config 可配 | **改为不可配**：常量 45s + 注释（避免新配置项文档负担与误调） | 本条表述已按此更新 |
| Q8 | 直发运行的工作目录 | **已落定**：workspaceId 必填、无 cwd 入参、拒绝 defaultCwd 兜底（B5）；**`kind:"global"` 工作区同样服务端 400 拒绝，前端只在已有非 global 项目时开放团队（R2）**；「无上下文时缺省最近工作区」不再提供——缺上下文就在 UI 上要求先选/建项目 | 本条已从「待定」升级为契约（§4.2/§5.1） |

---

*实施顺序：T1 →（T2 ∥ T4）→ T3 → T3b →（T5 ∥ W1 的 T6）→ T7 → T8 → T9 → T10 → A1 →（A2→A3 ∥ A4）→ A5。*
