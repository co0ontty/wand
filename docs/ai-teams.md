# AI 团队：方案与施工单

> 读者：负责写代码的实现者。本文是 AI 团队功能的**唯一**依据，取代之前所有 `docs/ai-teams-*.md` 和工作区里未提交的 `team-*` 实现。
> 原则：**复用现有会话链路，不为任何 CLI 单独定制，改动尽量小。**

---

## 0. 一句话方案

团队 = 一组成员。每个成员有**名字、职责说明，以及一份和任务看板「指派 Agent」完全相同的执行配置**（CLI 工具 / 模型 / 思考深度 / 工作模式 / 结构化或 PTY）。

一次团队运行挂在一张任务卡上。服务端只做**传话**：
1. 把目标和成员名单发给 **Leader 成员**。Leader 用它自己的 CLI 会话决定「下一步派谁做什么」。
2. 服务端按 Leader 的安排，用**现有的派发链路**给对应成员开会话、发指令。
3. 成员做完后把报告写进约定文件。服务端把**上一批报告写成一个交接文件**，只把路径交给 Leader，Leader 决定下一步或宣布完成。

所有成员会话都是普通的 Wand 会话：自动出现在任务卡下面，可以打开、旁观、插话、处理权限弹窗、停止，和手动派发的会话没有区别。

---

## 1. 为什么推翻之前的方案

之前的实现（约 1.35 万行服务端 + 4 千行 Android，均未提交）另起了一整套执行栈：
- 自己的无工具推理进程（`team-inference-runner.ts`），只验证了 Pi 和 Qoder 的特定版本和三个模型名，Claude / Codex / OpenCode / Grok 都用不了。
- 模型不能改文件，只能输出 JSON，由自研的 file broker 代写。
- 另建了私有 worktree、运行存储（CAS、回执、事件序号、租约）和恢复逻辑。

这等于在 Wand 里再造一个 Wand。现有链路早已覆盖六个 CLI 的结构化会话和 PTY 会话、权限弹窗、断线恢复和会话展示。团队功能真正新增的只有「谁下一步做什么」的调度，这件事交给 Leader 成员自己决定，服务端只负责传递和记录。

| 维度 | 旧方案 | 新方案 |
| --- | --- | --- |
| 支持的 CLI | Pi、Qoder 各一个固定版本 | 六个 provider 全部支持，结构化 / PTY 都行 |
| 成员怎么执行 | 自研无工具推理 + 代写文件 | 普通 Wand 会话，CLI 自己改文件 |
| 权限控制 | 自研沙箱规则 | 成员的「工作模式」（标准 / 全限 / 托管），与任务派发一致 |
| 分工和计划 | 服务端校验的计划 DTO、依赖图、状态机 | Leader 每轮回复一小段 JSON，服务端只校验「派给的人是否存在」 |
| 新增代码量（估算） | 约 1.8 万行 | 服务端约 800 行，Web 约 700 行，测试约 500 行 |

---

## 2. 概念

| 概念 | 含义 |
| --- | --- |
| 团队 `AiTeam` | 名字 + 成员列表 + 少量开关，存在 SQLite |
| 成员 `AiTeamMember` | `id`、名字、职责说明、`agent`（**直接用现有的 `WandTaskAgent` 类型**）、是否 Leader |
| 运行 `AiTeamRun` | 某个团队在某张任务卡上的一次协作 |
| 步骤 `AiTeamStep` | 运行里的一条记录，有两种：`leader`（Leader 的一轮决策）和 `work`（某成员的一次工作）。步骤按顺序排列就是群聊时间线 |
| 报告文件 | 每个步骤约定的交付文件，是**所有 CLI 通用**的交接方式，见 §4.3 |

---

## 3. 第 0 步：清理旧实现

### 3.1 先备份（不可省略）

旧实现全部未提交，删了就找不回来。实现者先在仓库根执行备份：

```bash
ts=$(date +%Y%m%d-%H%M)
git diff > ~/wand-ai-teams-v1-$ts.tracked.patch
git ls-files --others --exclude-standard | grep -E 'team|ai-teams|\.pi/' \
  | tar -czf ~/wand-ai-teams-v1-$ts.untracked.tgz -T -
(cd android && git diff > ~/wand-ai-teams-v1-$ts.android.patch \
  && git ls-files --others --exclude-standard | grep -i team \
  | tar -czf ~/wand-ai-teams-v1-$ts.android-untracked.tgz -T -)
```

备份完成后再删。**不要**用 `git stash`、`git reset`、`git checkout --`：工作区里还有别人的无关改动（见 §3.3）。

### 3.2 要删的东西

未跟踪文件，直接删：
- `src/team-types.ts`、`team-validation.ts`、`team-definition-store.ts`、`team-definitions.ts`、`team-run-types.ts`、`team-run-store.ts`、`team-planning.ts`、`team-planning-control.ts`、`team-execution.ts`、`team-file-broker.ts`、`team-inference-runner.ts`、`server-team-routes.ts`
- `src/web-ui/react/teams/` 整个目录
- `tests/team-*.test.ts`、`tests/server-team-*.test.ts`、`tests/web-team-*.test.ts`、`tests/fixtures/team-contracts/`、`tests/fixtures/team-inference/`、`tests/fixtures/team-runs/`
- `docs/ai-teams-design.md`、`ai-teams-protocol.md`、`ai-teams-implementation-plan.md`、`ai-teams-acceptance.md`、`ai-teams-capability-audit.md`
- Android 子模块：`app/src/main/java/com/wand/app/data/{TeamDraftStore,TeamModels,TeamsApi,TeamsPort}.kt`、`ui/TeamsStore.kt`、`ui/screens/{TeamsPresentation,TeamsScreen}.kt` 及对应的 6 个测试文件

已跟踪文件里的团队部分，**只删团队相关的块**，同一文件里的其他改动不动：
- `src/server.ts`：删团队相关的 import、`TeamPlanningControl` / `TeamExecutionService` 的构造与 `recover()`、`registerTeamRoutes(...)`、`storage.teamRuns.setCommitListener(...)`
- `src/storage.ts`：删 `teamDefinitions` / `teamRuns` 的接线
- `src/ws-broadcast.ts`：删 `broadcastTeamUpdate`、`subscribe_team` / `unsubscribe_team` / `team_resync` / `team_subscribe_limit` 相关代码
- `src/web-ui/react/overlay-host.tsx`：删 `TeamsManagementHost`
- `src/web-ui/react/shell/shell-sidebar.tsx`：删 `teams-manage-button` 那个导航项
- `src/web-ui/content/styles.css`：删末尾 `/* ===== AI 团队模板管理（teams/*）===== */` 起的整段
- Android 子模块 `AppNav.kt`、`WandApp.kt`、`SettingsScreen.kt` 里指向 Teams 页面的入口（逐个 grep `Teams` 确认）

`.pi/agents/wand-team-*.md` 和 `.pi/subagents/ai-teams-foundation-workflow.js` 是开发者自己用的 agent 配置，不是产品代码。**不删、不提交**，由用户处理。

**数据库**：旧代码可能已经在本机 `~/.wand/wand.db` 里建了 `team_*` 表。按仓库约定只加不删，这些表留着不管；新表用 `ai_team_*` 前缀，不会冲突。

删完的验收：
```bash
rg -l "team-inference-runner|TeamPlanningControl|broadcastTeamUpdate|subscribe_team|teams-manage" src tests android/app/src
# 应无输出
npm run check && npm test
```

### 3.3 工作区里与团队无关的改动

以下不属于本功能，**不要混进团队的提交**，各自单独提交或交还原作者：
- provider 使用频率排序（`provider-usage*.ts` 及各选择器里的调用、`/api/sessions/provider-usage`）
- 快捷提交「归档关联任务」（`commit-task-archive.ts`、`quick-commit/*`、`docs/iteration.md` 的对应段落）
- bundle CSS 压缩（`scripts/browser-style-minification.js`、`scripts/bundle-browser.js`）
- Android termlib 手势补丁、`NativePtyTerminal.kt` 等。其中 `NativePtyTerminal.kt` 目前让 `tests/web-native-contracts.test.ts` 失败了一个用例，需要改它的人确认是恢复那一行还是更新契约。
- `package.json` 版本号改动

---

## 4. 服务端设计

### 4.1 新增和改动的文件

| 文件 | 类型 | 内容 |
| --- | --- | --- |
| `src/ai-team-types.ts` | 新 | 类型定义（§4.2） |
| `src/ai-team-prompts.ts` | 新 | Leader / 成员提示词模板、Leader 回复解析（§4.4、§4.5） |
| `src/ai-team-runner.ts` | 新 | 调度器 `AiTeamRunner`（§4.6） |
| `src/server-ai-team-routes.ts` | 新 | HTTP 路由（§4.8） |
| `src/agent-dispatch.ts` | 新，**从现有代码抽出** | 开会话 / 发消息的公共函数（§4.3） |
| `src/server-task-routes.ts` | 改 | `/dispatch` 改成调用 `agent-dispatch.ts`，行为不变 |
| `src/storage.ts` | 改 | 三张新表 + 读写方法（§4.7） |
| `src/server.ts` | 改 | 构造 runner、挂路由、把 ProcessEvent 转给 runner（和 `missions.ingest` 并列） |
| `src/server-file-routes.ts` | 改 | `ignoredDirectories` 加 `.wand-team` |

### 4.2 类型（`src/ai-team-types.ts`）

```ts
import type { WandTaskAgent } from "./task-types.js";

export interface AiTeamMember {
  id: string;            // 服务端生成，形如 "m_" + 8 位随机字母数字；团队内唯一
  name: string;          // 1–40 字符，团队内唯一（忽略大小写和首尾空格）
  duty: string;          // 职责说明，0–2000 字符，原样写进提示词
  agent: WandTaskAgent;  // 与任务看板派发完全相同
  isLeader: boolean;
}

export interface AiTeam {
  id: string;
  name: string;                  // 1–60 字符
  description: string;           // 0–500 字符
  members: AiTeamMember[];       // 2–8 人，恰好 1 个 isLeader
  requirePlanApproval: boolean;  // 默认 true
  maxSteps: number;              // 默认 30，范围 5–200；Leader 轮次 + 成员步骤合计
  createdAt: string;
  updatedAt: string;
}

export type AiTeamRunStatus =
  | "running"          // 有步骤在跑，或马上要派下一步
  | "awaiting_approval"// Leader 给出首个计划，等用户批准
  | "waiting_user"     // Leader 提问 / 步数用完 / Leader 回复多次格式错误
  | "done" | "failed" | "stopped";

export interface AiTeamRun {
  id: string;
  teamId: string;
  team: AiTeam;              // 启动时的团队快照；之后改团队不影响已开始的运行
  taskId: string;            // 绑定的任务卡 wand_tasks.id
  objective: string;         // 有单独输入时就是这次输入；否则是任务标题 + 描述
  cwd: string;
  status: AiTeamRunStatus;
  statusDetail: string;      // 给人看的一行说明，如 Leader 的提问、失败原因
  stepsUsed: number;
  stepLimit: number;         // 初始 = team.maxSteps，用户点「继续」时增加
  formatRetries: number;     // 当前这轮 Leader 回复格式错误的重试次数
  createdAt: string;
  updatedAt: string;
}

export type AiTeamStepKind = "leader" | "work";
export type AiTeamStepStatus = "queued" | "running" | "done" | "failed" | "skipped";

export interface AiTeamStep {
  id: string;
  runId: string;
  seq: number;               // 运行内从 1 递增，时间线顺序
  kind: AiTeamStepKind;
  memberId: string;
  title: string;             // work：Leader 给的标题；leader：固定为 "安排下一步" / "制定计划"
  instructions: string;      // 发给成员的具体指令（leader 步骤为发给 Leader 的输入）
  sessionId: string | null;  // 执行这一步的会话
  status: AiTeamStepStatus;
  report: string;            // work：成员报告；leader：Leader 给用户看的 message
  reportPath: string;        // 约定的报告文件，相对 cwd
  startedAt: string | null;
  endedAt: string | null;
}
```

### 4.3 抽出公共派发函数（`src/agent-dispatch.ts`）

现在 `/api/wand-tasks/:id/dispatch` 路由里有一段完整的逻辑：解析 cwd → 按 `agent.kind` 选 `processes.start(...)` 或 `structured.createSession(...)` → 绑定任务卡 → 记迭代提示词 → 结构化会话再 `sendMessage`。把它原样搬成两个函数，路由改成调用它们。**这一步只搬家，行为不变**，单独一个提交。

```ts
export interface AgentDispatchDeps {
  storage: WandStorage;
  config: WandConfig;
  structured: StructuredSessionManager | null;
  processes: ProcessManager | null;
}

/** 为任务卡开一个新会话并发送首条提示词。返回会话快照。 */
export async function dispatchAgentForTask(
  deps: AgentDispatchDeps,
  input: { task: WandTask; agent: WandTaskAgent; prompt: string; automationId: string; recordIteration: boolean },
): Promise<SessionSnapshot>;

/** 给已有会话追加一条消息。结构化走 sendMessage；PTY 先写文本、再单独写 "\r"。 */
export async function sendToAgentSession(
  deps: AgentDispatchDeps,
  sessionId: string,
  text: string,
): Promise<void>;
```

要点：
- `dispatchAgentForTask` 里的 cwd 解析、`ensureWorkspaceTaskForBoardTask`、`bindWandTaskSession`、`getDefaultModelForProvider` 全部照搬现有路由。团队运行传 `automationId = "ai-team:<runId>"`。
- 结构化会话的 `sendMessage` 返回的 promise 要 `.catch` 打日志，不 await：完成与否由 §4.6 的事件判断，和现有 dispatch 一样。
- `sendToAgentSession` 的 PTY 分支**必须**按 AGENTS.md 的输入契约拆成两次写入：`processes.sendInputConfirmed(id, text)`，再 `processes.sendInputConfirmed(id, "\r", undefined, "enter_text")`。不能写 `text + "\n"`。
- 路由改完后跑 `tests/` 里所有和 dispatch 相关的测试，必须原样通过。

### 4.4 报告文件：所有 CLI 通用的交接方式

每个步骤都有一个约定路径：

```
<cwd>/.wand-team/<runId>/<seq>-<leader|memberId>.<json|md>
```

- Leader 步骤写 `.json`（格式见 §4.5），成员步骤写 `.md`。
- 为什么用文件：六个 CLI 在结构化和 PTY 模式下都能写文件，这是唯一不需要按 CLI 定制的交接方式。PTY 会话拿不到可靠的「回复结束」信号（目前只有 Claude PTY 有 `ptyBusy`），但文件出现是确定的。
- 运行开始时，如果 cwd 在 git 仓库里，把 `.wand-team/` 追加到 `$(git rev-parse --git-common-dir)/info/exclude`（已存在就不重复加），避免报告文件进提交。拿不到 git 信息就跳过。
- 读取上限 64 KiB，超出部分截掉并在末尾注明「（已截断）」。

**交接文件（提示词不再内联报告）**：报告正文只在文件里，提示词只给路径。

```
<cwd>/.wand-team/<runId>/handoff-<seq>-<leader|work>.md
```

- Leader 轮：把「上一轮 Leader 之后结束的 work 步骤」的报告全文汇总进 `handoff-<leaderSeq>-leader.md`；
  提示词里只逐行列出 `第N步 · 成员 · 标题 · 状态 · 报告文件`（消息里的标签是 `上游交接文件：{path}`），
  「先读这个文件再决定下一步」这句规则写在**系统提示**的「交接文件」段里，不每轮重复进用户消息。
- 成员步骤：把它的依赖步骤（`dependsOn`）的报告汇总进 `handoff-<stepSeq>-work.md`，提示词里以
  `## 上游交接` 逐行给出各步报告文件与 `上游交接文件：{path}`；上游报告正文一律不进提示词。
  没有依赖的步骤不带这一段。读文件的规则同样只在系统提示里说一次。
- 写文件失败只记日志，不阻断派发；提示词里仍逐行给出各步报告文件路径。
- 这样做的原因：一批步骤的报告动辄数千字，全塞进提示词会撑爆上下文，也让 Leader 只看到「摘要」
  而看不到原文；改成读文件后，需要细节的人自己去读，提示词保持短而稳定。

**群聊续跑的上下文文件（同一个群聊里接着说）**：用户在一次运行结束后于群里再发一句，
服务端在**同一个群聊会话**上开新一轮（见 §4.6 的 `chatInput`）。新运行开始时先把「之前几轮的
步骤摘要 + 群聊原文」写进：

```
<cwd>/.wand-team/<runId>/chat-history.md
```

- 摘要逐行列出每轮的 `状态` 与 `第N步 · 成员 · 标题 · 状态`（上一轮被跳过 / 失败的步骤就靠它看见）；
  群聊原文只留最近的这一段（总预算 64 KiB，超了从最早处丢并注明省略了多少条）。
- 第一轮负责人（kickoff）与这一轮每个**新建会话**的成员提示词里只给这条路径
  （消息里的标签是 `本群聊之前的记录：{path}`，文件自己的标题就是 `# 本群聊之前的记录`），
  「先读完再动手：已经做完的不要重做、上一轮没做完的接着做」写在**系统提示**的「交接文件」段。
  会话复用时不重复贴（`fresh` 才带）。
- 文件名由运行 id 决定，所以库里不额外存列：「文件在不在」就是「是不是续跑」
  （`chatHistoryFor`），服务重启后同一路径依旧成立。
- 非续跑的运行（没有群聊会话、之前没有运行）提示词里不带这一段；写文件失败只记日志，不拦派发。
- 这样做的原因：负责人和成员每一轮都是新会话，没有这段交接，用户在群里接着说时团队会从零重来
  （重新调研、重复改同一批文件），用户感觉「没有接着上下文」。

### 4.5 提示词与 Leader 回复格式（`src/ai-team-prompts.ts`）

每条提示词拆成两段（`AiTeamPrompt`）：

| 段 | 内容 | 去哪 |
| --- | --- | --- |
| `system` | 角色、职责、成员名单、协作指令、工作方式、交接文件怎么读、回复 / 报告格式与标签 | 会话级系统提示：创建会话时交给 provider 自己的系统提示开关（`SessionSnapshot.systemPrompt`） |
| `message` | 目标（用户原话）、本步骤、报告 / 交接文件路径（只给路径与标签） | 普通用户消息 |

只有「这一轮才有」的东西进 `message`：目标、用户补充、上游步骤与文件路径、解析失败原因。
凡是每轮都一样的说明（怎么读交接文件、怎么写入报告、Leader 的 JSON 格式）一律进 `system`——
它们只在新会话时交一次，不会在团队面板的「发给负责人」里、也不会在群聊的用户气泡里出现。

这样规则不会伪装成用户发言（会话第一屏看不到那一大段说明，也不会被当成用户提示词记进迭代、拿去当会话标题），
也避免模型把目标原文里的口述笔误当成我们的错别字。系统提示通道：

| Provider | 开关 |
| --- | --- |
| Claude / Qoder / Pi | `--append-system-prompt` |
| Grok | `--rules` |
| Codex / OpenCode | 没有这个入口，退回把提示并在**首条**消息最前面（`promptWithSystemFallback`，只拼一次） |

会话是新建的时候才把目标再放进消息（`fresh`）：老会话的对话历史里已经有目标了。

**Leader 系统提示**（`leaderSystemPrompt`）：身份与职责 + 成员名单（`CLI: {provider}/{model}`）+ 协作指令 + 工作方式 + 交接文件规则 + 回复格式。

```
你是 AI 团队「{team.name}」的负责人（{leader.name}）。
你的职责：{leader.duty}

## 成员（只能把工作派给下列成员；id 必须原样使用）
- id: {m.id} | 名字: {m.name} | CLI: {provider}/{model} | 职责: {m.duty}
...（不含你自己，除非你的职责里写了你也要动手）

## 工作方式
- 你不直接改代码：你负责拆分任务、派工，并根据成员报告决定下一步。
- 每次只安排接下来要做的几步（1–5 步）…
- 目标与用户补充都是用户原话，可能带口述笔误（例如把 CLI 写成 ci），按用户意图理解。

## 交接文件（消息里出现下列标签时，先读文件再动手）
- 上游交接文件：上一批步骤的报告全文汇总，先读它再决定下一步；不要凭标题猜成员做了什么，也不要让他们把报告复述进消息里。
- 本群聊之前的记录：用户是在这个群聊里接着提要求；先读它，已经做完的不要重做，上一轮没做完的接着做。

## 回复方式（必须遵守）
每轮消息末尾都给出这一轮的报告文件（标签「本轮报告文件」）；把决定写成 JSON 写入该文件，写完只简短回复「已写入」，不要在消息里复述计划。
格式三选一：
{"action":"assign","message":"给用户看的一句话说明","steps":[{"member":"成员 id","title":"简短标题","instructions":"具体要做什么、做到什么程度"}]}
{"action":"ask","message":"要问用户的问题"}
{"action":"finish","message":"最终总结：完成了什么、改了哪些文件、验收结论、遗留问题"}

steps 里 `after` 写这一步要等哪几步完成（写本次 steps 内的序号，从 1 开始）：
- 省略 after：等上一步完成后开始（顺序执行）；
- "after": []：立刻开始，可以和别的成员并行；
- "after": [1, 2]：等第 1、2 步都做完再开始。
```

**Leader 首轮消息**（`buildLeaderKickoffPrompt(run, reportPath, fresh, chatHistoryPath)`）：

```
团队目标：{objective}

本群聊之前的记录：{chatHistoryPath}

本轮报告文件：{reportPath}
```

只有新建会话（`fresh`）才带「团队目标」；`chatHistoryPath` 只在同一个群聊续跑时有值。
目标本身也去过重：任务标题是描述开头被截断出来的前缀时（`mergeTaskTexts`）只留描述，不重复两段。

`after` 决定并行（系统提示里有同样的说明）：不写 = 等上一步做完（顺序）；`[]` = 立刻开始；
`[1, 2]` = 等本次第 1、2 步都做完。只能引用前面的序号，解析时换算成 `AiTeamStep.dependsOn`
（存的是步骤 id）。团队的「协作指令」（`AiTeam.instructions`，≤ 4000 字）以 `## 协作指令`
段落同时写进负责人和每位成员的**系统提示**。

**Leader 后续轮消息**（`buildLeaderFollowupPrompt(run, finished, reportPath, userNote, fresh, handoffPath, chatHistoryPath)`）：

```
## 已结束的步骤

- 第{seq}步 · {member.name} · {title} · {status} · 报告文件：{reportPath}
...

上游交接文件：{handoffPath}

## 用户补充
{userNote}

本轮报告文件：{reportPath}
```

报告正文在交接文件里，消息只列元信息与路径。格式重试轮同样只带解析失败原因与本轮报告文件。

**成员系统提示**（`memberSystemPrompt`）：身份与职责 + 协作指令 + 工作方式（只做本步骤、不 commit）
+ 交接文件规则 + 报告约定（首行 `状态: 完成|受阻|失败` 的 Markdown 报告）。

**成员消息**（`buildMemberPrompt(run, step, member, fresh, upstream, chatHistoryPath)`）：

```
团队目标：{objective}

本群聊之前的记录：{chatHistoryPath}

## 本步骤：{title}
{instructions}

## 上游交接

- 第{seq}步 · {member.name} · {title} · {status} · 报告文件：{reportPath}

上游交接文件：{handoffPath}

本轮报告文件：{reportPath}
```

「团队目标」「本群聊之前的记录」都只在新建会话时带；「上游交接」只在有依赖步骤时带；
读文件的规则在系统提示里，不在消息里重复。

同一个成员在同一次运行里第二次被派工时，发到他**已有的会话**里（上下文延续），消息省掉「团队目标」一段；
系统提示本来就只在新开会话时交一次，不重发。

**Leader 回复解析**（`parseLeaderDecision(text, team)`）：
1. 取文本中第一个 `{` 到与之配对的 `}`，`JSON.parse`。
2. 校验：
   - `action` 必须是三种之一。
   - `message` 必须是字符串，截到 2000 字符。
   - `assign` 时 `steps` 为 1–5 项。每项的 `member` 必须是快照里的成员 id；为了容错，也接受成员名字，忽略大小写。`title` 1–80 字符，`instructions` 1–8000 字符。
3. 返回 `{ ok: true, decision } | { ok: false, error: "中文说明" }`。

### 4.6 调度器（`src/ai-team-runner.ts`）

**核心原则：事件驱动，状态全在数据库。** 不在内存里 await 长时间的 promise，这样服务重启后能从数据库接着走。写法照 `Missions.ingest`。

```ts
export class AiTeamRunner {
  constructor(deps: AgentDispatchDeps & {
    sessions: SessionRegistry;
    notify: (runId: string, taskId: string) => void;   // 发 WS 通知，见 §4.9
  });

  start(input: { teamId: string; taskId: string; note: string; chatSessionId?: string }): Promise<AiTeamRun>;
  ingest(event: ProcessEvent): void;       // server.ts 里和 missions.ingest 并列调用
  reconcile(): void;                       // 服务启动时调一次
  chatInput(sessionId: string, text: string): Promise<void>; // 群里发的话，见下面的「群聊输入」
  approve(runId: string): Promise<AiTeamRun>;
  reject(runId: string, feedback: string): Promise<AiTeamRun>;
  reply(runId: string, text: string): Promise<AiTeamRun>;
  continueRun(runId: string, extraSteps: number): Promise<AiTeamRun>;
  completeStep(runId: string, stepId: string, report: string): Promise<AiTeamRun>; // 手动标记完成
  stop(runId: string): Promise<AiTeamRun>;
}
```

**串行化**：每个 runId 维护一个 promise 链（`Map<string, Promise<unknown>>`），`start` 之外的所有方法和 `evaluate(runId)` 都排进这条链。同一运行内不会并发推进，不需要 CAS。

**会话 → 步骤的查找**：`ingest` 收到事件后，用 `storage.getAiTeamStepBySession(sessionId)` 找到**正在运行**的步骤，没找到就直接返回（绝大多数事件都是这种情况，必须廉价）。只处理 `status`、`ended`、`task`、`output` 四类事件。`output` 事件按 sessionId 做 1 秒防抖。

**步骤是否结束**（`stepOutcome(step, snapshot)`），按顺序判断：
1. 报告文件存在，且 mtime 晚于 `step.startedAt` → **结束**，报告取文件内容。
2. 会话 `status` 是 `exited` / `failed` / `stopped` → **结束**。有报告文件按 1 处理，没有就算 `failed`，报告写会话的 `lastError` 摘要（头尾截断）或「会话已结束，未交付报告」。`failed` 会话的最后一条 assistant 回复往往就是错误本身（如 API 503），**不能**当报告或 Leader 决定。
3. 结构化会话：`structuredState.inFlight === false`、`queuedMessages` 为空，且最后一条消息是 `startedAt` 之后的 assistant 消息 → **结束**。
   - 成员步骤：报告取最后一条 assistant 消息的文本，状态按 `done` 处理。成员没写文件时，用他的回复顶上。
   - Leader 步骤：对最后一条 assistant 文本做 `parseLeaderDecision`。Leader 可能把 JSON 直接回复在对话里，所以这也是一条合法路径。
4. 其他情况 → **未结束**，继续等。PTY 会话主要靠第 1 条；非 Claude 的 PTY 成员没写文件时，用户可以在界面上点「标记完成」（`completeStep`）。

**步骤结束后**（`afterStep`）：
- **work 步骤结束**：记报告，`stepsUsed++`，然后 `advance`：
  - 派出所有「依赖都已 done、且该成员当前没有在跑的步骤」的 queued 步骤——**不同成员并行，同一成员串行**（同一成员复用同一个会话）。
  - 本步失败时不再派新步骤，依赖它的步骤标 `skipped`；等其他在跑的成员结束。
  - 没有任何步骤在跑、也没有可派的步骤 → 把「上次 Leader 轮之后结束的 work 步骤」汇总，开一个 Leader 步骤（后续轮提示词）。Leader 轮只在没有成员在跑时开始。
- **leader 步骤结束**：`stepsUsed++`，解析决策。
  - 解析失败：`formatRetries < 2` 时，往 Leader 会话里发一条「上次回复格式不对：{error}。请按格式重新写入 {新 reportPath}」，同时新建一个 leader 步骤，`formatRetries++`；已经重试 2 次 → `waiting_user`，`statusDetail = "Leader 回复格式多次不正确"`。
  - 解析成功，`formatRetries` 清零：
    - `assign`：Leader 的 `message` 写进本步骤的 `report`，按顺序插入 `queued` 的 work 步骤（带 `dependsOn`）。如果这是**本次运行的第一个 assign**，且 `requirePlanApproval` 为真 → `awaiting_approval`，等用户；否则 `advance`。
    - `ask`：`waiting_user`，`statusDetail = message`。
    - `finish`：`done`，`statusDetail = message`。任务卡状态不自动改，由用户决定是否拖到「完成」。
- **每次准备派下一步之前**检查 `stepsUsed >= stepLimit` → `waiting_user`，`statusDetail = "已达到步数上限"`。

**派发一个步骤**（`dispatchStep`）：
- 该成员在本运行里已经有会话，且会话还活着（`sessions.getLatest(id)` 存在，状态不是 exited / failed / stopped）→ `sendToAgentSession`。
- 否则 → `dispatchAgentForTask`，`recordIteration` 只在 Leader 首轮为 true，避免把每一步都记进迭代提示词。
- 先把步骤标成 `running`、写好 `startedAt` 和 `sessionId`，**再**发送。发送抛错 → 步骤 `failed`，报告写错误信息，走 `afterStep`。
- 会话的权限弹窗、提问**不需要特殊处理**：成员会话会停在那里，用户在会话里处理，处理完会话继续，事件驱动自然接上。界面上用现有的 `activityState` 逻辑（`missions.ts` 里那个，**抽成导出函数复用**）显示「等待授权 / 等待回答」。

**用户操作**：
- `approve`：只在 `awaiting_approval` 时有效 → `running`，派第一个 queued 步骤。
- `reject(feedback)`：只在 `awaiting_approval` 时有效 → 所有 queued 步骤改为 `skipped`；开新 leader 步骤，提示词为「用户没有批准这个计划，意见：{feedback}。请重新安排。」。重新安排后仍需批准（仍视为首个计划）。
- `reply(text)`：只在 `waiting_user` 时有效。普通提问等状态 → 开新 leader 步骤，交给负责人用户的话及本轮报告。若因步数上限暂停，先增加运行预算（至少 10 步，若团队定义已调高则至少升到新上限）；纯「继续」保持 queued 计划并继续派发，包含新要求的回复则交回负责人重新安排。
- `continueRun(n)`：只在 `waiting_user` 且原因是步数上限时有效 → `stepLimit` 至少加 n（n 取 5–50），团队定义已调高时至少升到新的 `maxSteps`；派下一个 queued 步骤，没有 queued 步骤就开 leader 步骤。其他等待原因不可用此接口绕过负责人提问。
- `completeStep(stepId, report)`：只对 `running` 的 work 步骤有效。report 为空时用「用户手动标记完成」。
- `stop`：只要不是 done / failed / stopped 都有效 → 调现有停止路径（与 `/api/sessions/:id/stop` 同样按 `ownerOf` 分派到 `structured.stop` / `processes.stop`）停掉 `running` 步骤的会话；running 和 queued 步骤改为 `skipped`，run 改为 `stopped`。**会话本身不删**，用户还能翻看。

**群聊输入**（`chatInput(sessionId, text)`，经 `registerRelay` 从前缀 `ai-team-chat:<runId>` 的转发会话路由过来，转发会话不起 CLI）：
- 按群聊找到**最近一次**运行（`storage.getLatestAiTeamRunByChat`），再按它的状态分流：
  `awaiting_approval` → 「批准」类短语（`APPROVE_REPLY`）走 `approve`，其余当修改意见走 `reject`；
  `waiting_user` → `reply`（步数用完时单发「继续」会加预算并保留未执行计划）；`running` → 记进 `pendingNotes`（负责人下一轮一起看到，并回一条 notice）；
  已经结束（done / failed / stopped） → 按团队**当前定义**在同一张任务卡、**同一个群聊会话**上开新一轮（团队已删则报错）。
- 任何状态下发「停止」都直接叫停（`STOP_REPLY`）。
- 这些路径都带 `{ echo: false }`：参数里的话已经由转发会话落成用户回合，服务端不再重复回显。
- 开新一轮时会把之前几轮写成一个上下文文件交给负责人与成员（§4.4 的「群聊续跑」），
  并在群里落一条 notice「接着这个群聊里上一轮的进度继续；交给负责人和成员的记录见 <路径>」
  （第一轮才是「团队「X」接手了这个任务：…」），否则每一轮都是全新会话，团队会从零重来。
- Web 群聊页也按 chat 会话跟随新运行（§5.2）。

**启动恢复**（`reconcile`）：对所有 `running` / `awaiting_approval` / `waiting_user` 的运行：
- `running` 且有 `running` 步骤：会话已不存在（`sessions.getLatest` 为 null）→ 步骤 `failed`，报告「服务重启后会话丢失」，走 `afterStep`；会话存在 → 调一次 `evaluate`。结构化会话由 `recoverDetachedRuns()` 接回，之后的事件会继续驱动。
- `running` 但没有 running 步骤（重启发生在两步之间）→ 调 `afterStep` 的派发逻辑。
- 其余两种状态不动，等用户。

**同一张任务卡同时只能有一个未结束的运行**（状态不是 done / failed / stopped）。`start` 时检查，违反就报错「这张任务已经有进行中的团队运行」。

### 4.7 存储（`src/storage.ts`）

按现有写法加三张表（`CREATE TABLE IF NOT EXISTS`，只加不删）：

```sql
CREATE TABLE IF NOT EXISTS ai_teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  members_json TEXT NOT NULL,
  require_plan_approval INTEGER NOT NULL DEFAULT 1,
  max_steps INTEGER NOT NULL DEFAULT 30,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_team_runs (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  team_json TEXT NOT NULL,
  objective TEXT NOT NULL,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL,
  status_detail TEXT NOT NULL DEFAULT '',
  steps_used INTEGER NOT NULL DEFAULT 0,
  step_limit INTEGER NOT NULL,
  format_retries INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_team_runs_task ON ai_team_runs (task_id, created_at);
CREATE INDEX IF NOT EXISTS ai_team_runs_status ON ai_team_runs (status);
CREATE TABLE IF NOT EXISTS ai_team_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  member_id TEXT NOT NULL,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL,
  report TEXT NOT NULL DEFAULT '',
  report_path TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  UNIQUE (run_id, seq)
);
CREATE INDEX IF NOT EXISTS ai_team_steps_session ON ai_team_steps (session_id, status);
```

方法（命名照现有的 `saveMission` / `getMission` 风格）：`listAiTeams`、`getAiTeam`、`saveAiTeam`、`deleteAiTeam`（只删团队定义，已有运行保留快照不受影响）、`saveAiTeamRun`、`getAiTeamRun`、`listAiTeamRuns({ taskId?, statuses? })`、`saveAiTeamStep`、`listAiTeamSteps(runId)`、`getRunningAiTeamStepBySession(sessionId)`。

删除任务卡时，其团队运行不删，只是在列表里查不到（按 taskId 查）。与现有 mission 的处理保持一致。

### 4.8 HTTP（`src/server-ai-team-routes.ts`）

所有路由挂 `requireAuth`，与任务看板路由相同。Android 能派发 Agent，就能批准团队计划，不做额外的主体区分。

| 方法 | 路径 | 请求体 | 返回 |
| --- | --- | --- | --- |
| GET | `/api/ai-teams` | — | `AiTeam[]` |
| POST | `/api/ai-teams` | `{ name, description?, members, requirePlanApproval?, maxSteps? }` | `AiTeam` |
| PUT | `/api/ai-teams/:id` | 同上（整体替换） | `AiTeam` |
| DELETE | `/api/ai-teams/:id` | — | `{ ok: true }` |
| POST | `/api/wand-tasks/:id/team-runs` | `{ teamId, note? }` | `202 { run, steps }` |
| GET | `/api/wand-tasks/:id/team-runs` | — | 该任务的运行列表（新的在前，不含 steps） |
| GET | `/api/ai-team-runs/:id` | — | `{ run, steps, memberStates }` |
| GET | `/api/ai-team-runs/:id/live` | — | `{ runId, steps: AiTeamLiveStep[] }`（运行中步骤的实时文本，§4.9） |
| POST | `/api/ai-team-runs/:id/approve` | — | `{ run, steps }` |
| POST | `/api/ai-team-runs/:id/reject` | `{ feedback }` | 同上 |
| POST | `/api/ai-team-runs/:id/reply` | `{ text }` | 同上 |
| POST | `/api/ai-team-runs/:id/continue` | `{ extraSteps }` | 同上 |
| POST | `/api/ai-team-runs/:id/steps/:stepId/complete` | `{ report? }` | 同上 |
| POST | `/api/ai-team-runs/:id/stop` | — | 同上 |

- 成员校验：POST / PUT 时，成员的 `agent` 字段**直接用现有的 `parseTaskAgent`** 解析（它已经处理了 provider、模型、思考深度、模式和 kind 的合法性）；成员 `id` 缺失时由服务端生成；其余按 §4.2 的约束校验，出错返回 400 和中文消息。
- `memberStates`：`Record<sessionId, "working" | "needs_permission" | "needs_input" | "done" | "failed">`，用 §4.6 抽出的 `activityState` 实时算，给界面显示「等待授权」等状态。
- **群聊回合用的什么模型**：`ConversationAuthor`（`src/types.ts`）除 provider 外带可选 `model` / `thinkingEffort`，填的是**这条发言对应步骤实际使用的候选**（`actualAgent(member, step)`，降级换候选后跟着变；负责人发言或取不到步骤时回退首选候选），值就是候选上的真值——provider 原生 model id（`"default"` = 跟随该 provider 的服务端默认模型）与思考深度档位（`off/standard/deep/max` 或 `provider:<原生档>`）。服务端不生成中文标签，展示文案归客户端。**取不到就不填**（字段缺省），且**老数据的 `author` 根本没有这两个字段**，读端必须能在只有 provider 时正常显示。填充点全在 `chatAuthor(...)`：成员步骤报告（✅/❌）、负责人发言与派工清单、负责人出错提示、「某某开始…」与降级切换这几类带署名的回合；没有署名的纯系统提示（`author === undefined`，如「团队已停止」「等你批准计划」）不编造模型。
- 状态不允许的操作（比如非 `awaiting_approval` 时 approve）返回 409 和中文消息。界面据此刷新，不重试。
- 错误处理用现有的 `sendRouteError`。

### 4.9 实时通知

不新增 WS 消息类型。复用现有的系统通知：

```ts
wsManager.emitEvent({ type: "notification", sessionId: "__system__", data: { kind: "ai-team-run", runId, taskId } });
```

runner 在每次写 run 或 step 之后调用 `notify`。客户端收到后，如果正在看这个 run 就重新 GET 一次。成员会话本身的输出照常走现有会话事件，不用额外处理。

### 4.9.1 live 文本（群聊固定卡片的「此刻在干什么」）

给 Web/移动端的固定尺寸气泡卡片供文本。真源在 `src/ai-team-live.ts`（纯函数渲染）与 `AiTeamRunner.live()`（取数），形状是 `AiTeamLiveStep`（`ai-team-types.ts`）：`{ stepId, seq, memberId, memberName, provider, model?, thinkingEffort?, sessionId, state, text, omittedChars, updatedAt }`。`GET /live` 直接返回 `runner.live()`，不另挑字段——类型、`live()`、路由三者逐字段一致。

- **只覆盖 running 且有会话的步骤**（按 seq 升序）；快照拿不到的步骤跳过不抛。`state` 复用 `activityState(snapshot)`。
- **`model` / `thinkingEffort`**：与该步**实际使用候选**同源（同一个 `actualAgent(member, step)`，和 `provider` 一起降级换候选后一起变；成员查不到时两者都取不到）。值是真值——`model` 是候选上的 model id（`"default"` 表示跟随服务端默认模型），`thinkingEffort` 是 `off/standard/deep/max` 或 `provider:<原生档>`；取不到就不填（缺省）。中文标签、`default` 怎么显示都由客户端决定，服务端不翻译。
- **文本口径**（`renderLiveStepText(messages, output, { preferOutput })`）：默认从最后一条 user turn（没有则最后一条 assistant turn）渲染到末尾；text 原样保留，tool_use 压成一行 `▸ 名称[ · 描述单行截 60 字]`，tool_result 与 thinking 不渲染；连续空行压成一个换行、首尾 trim；尾部保留最多 `AI_TEAM_LIVE_TEXT_MAX_CHARS = 2000` 字，超长回报 `omittedChars`（客户端显示「已省略前面 N 字」）；渲染为空时回落原始 `output` 尾部，PTY 会话因此也有内容。
- **output 回落先截窗再剥 ANSI**（`outputTailText`）：先取末尾 `AI_TEAM_LIVE_TEXT_MAX_CHARS * 8` 字，再剥 ANSI / 归一换行 / 压缩空行 / 截尾。顺序反过来等于每 500ms 对几 MB 终端输出跑一遍全局正则，是白烧的 CPU。
  - **`omittedChars` 是估算值（可能偏大也可能偏小，用于量级提示）**：按截窗点的**原始字数**计，含 ANSI 与控制字符，不精确到账。ANSI 密集时偏大（转义也计成字），切点为找序列起点往前挪时偏小。客户端只显示「已省略前面 N 字」，不要拿它做精确对账。
  - **切点要落在安全边界上**（`safeTailStart`）：只在 `[切点 - 4096, 切点)` 这一小段里搜（不对整串跑 `lastIndexOf`），依次退到 ① 最近的 `ESC` 起点 —— 所以横跨切点的长 OSC（`ESC ] 0; <几百字标题> BEL`）会被整条剥掉，不留裸 BEL 和标题片段；② 找不到 ESC 就退到该段内最近的换行之后；③ 连换行也没有（超长转义负载）就不兜底，照原切点显示。
  - **窗内全转义时文本为空，省略字数照旧计入**：`stripped` 为空不提前返回，仍按切点字数回报 `omittedChars`，不会出现「丢了几万字却报 0」。
  - 输入没超窗、或窗内可见文本足够填满 2000 字上限时，**窗内显示的文本与「全量剥完再截尾」逐字相同**（有 120 组随机样例的回归单测）；窗内几乎全是转义序列的极端输出，显示的会比全量少一截，这是有意的取舍。
- **`preferOutput`（终端形态的过期文本）**：`preferOutput: true` 时**只**看 `output` 尾部，完全不采纳 `messages`（哪怕里面有文本；`output` 还没东西就照实返回空串，客户端显示占位）。判定在 `AiTeamRunner.liveStep`，因为只有它拿得到 owner、provider 与会话快照：
  `ownerOf(sessionId) === "pty" && !(provider === "claude" && snapshot.providerCliActive === true)`。
  依据是 pty bridge 只给「claude 且 CLI 已激活」的会话挂载（`src/process-manager.ts` 的 `initializeClaudeBridge` 首行 `record.provider !== "claude" || !record.providerCliActive` 即早退），其余 PTY——包括没激活的 claude PTY——在流式期 `messages` 根本不增长，以「渲染是否为空」当唯一判据的话卡片会永远锚在上一条 turn 的残留文本上。只有 claude PTY（bridge 在跑）与 structured（一律有流式 messages）走默认口径。
- **推送（Web）**：`ingest` 的四类事件（`output` / `status` / `task` / `ended`）都会为所属 run 挂一个**独立于 evaluate 的** `LIVE_NOTIFY_DEBOUNCE_MS = 500` 去抖计时器（同一 run 每 500ms 至多算一遍），到点算一遍 live 列表调 `notifyLive({ runId, taskId, steps })`；挂到 `status` / `task` 上是因为权限框、提问这类变化本来就是这两类事件带进来的，只挂 output 芯片就不会动。去重指纹是 **`stepId + text + omittedChars + state`**，四项全同不重复推，`state` 单独变化（working → needs_permission / needs_input）也要推一次，否则 Web 的状态芯片要等下一轮 `ai-team-run` 重拉才更新。`finishStep` 成功落地后与 `stop` 后各补推一次（可能是空数组），让卡片收尾。server.ts 把它转成同一条系统通知通道：

  ```ts
  wsManager.emitEvent({ type: "notification", sessionId: "__system__",
    data: { kind: "ai-team-step-live", runId, taskId, steps } });
  ```

  不新增 WS 消息类型，也不改 `ai-team-run` 的既有语义。
- **拉取（移动端）**：`GET /api/ai-team-runs/:id/live` 返回同一个 `{ runId, steps }`，轮询它即可，不需要 WS。分工：Web 走推送，移动端走这个端点。
- **兜底巡检对账**：`startSweep` 的 `SWEEP_INTERVAL_MS = 5000` 巡检里，每个 running 的 run 在 evaluate 之前先 `pushLive(runId)` 对账一次。事件通道是尽力而为的：registry 内部状态静默翻转（没有 `status` / `task` / `output` 事件进来）时，卡片只能等客户端下一次重拉才更新，巡检负责把它补齐。仍然走同一个指纹，状态真变了才推，没变就一个字都不发。间隔与 evaluate 的行为都不因此改动。
- **终态清指纹**：`setStatus` 进 `AI_TEAM_TERMINAL_RUN_STATUSES`（`done` / `failed` / `stopped`）时 `delete` 该 run 的 `lastLiveKey`；`pushLive` 发现 run 已是终态，收尾那一次推送之后也只 `delete` 不 `set`。留着终态指纹没有意义（不会再有变化），长跑的服务会按 run 数线性攒字符串（`dispose()` 只在进程退出时清）。

---

## 5. Web 界面

### 5.1 团队页：侧栏「任务看板」下的「AI 团队」

团队配置有独立页面（`react/ai-teams/teams-page.tsx`），不在设置里。它和任务看板共用
`task-board-controller` 与路由：`?view=teams`（`TaskBoardPage = "board" | "teams"`），
看板与团队页互切用 `replace`，返回键行为一致。侧栏入口 `#ai-teams-button` 带角标，
数的是「运行中但停下来等你处理」的运行（`useAiTeamAttentionCount`）。

- 左列：搜索（团队名/成员名）+ 全部 / 运行中 / 待你处理 筛选 + 团队卡（头像叠放、成员、CLI）。
- 右侧详情两个标签：
  - **成员与设置**：负责人在上、成员在下的组织图。成员卡点击**原位展开**（动效第 7 条），
    展开后编辑名字、头像、职责和 CLI 配置（复用 `issues/agent-fields.tsx` 的 `AgentFields`），
    可「设为负责人」「移除」；虚线卡添加成员（最多 8 人）。下面是团队名、步数上限、简介、
    协作指令、计划批准开关；保存按钮原位显示保存中 → 已保存 / 失败。
  - **运行记录**：`GET /api/ai-team-runs?teamId=` 列出该团队的运行（带任务标题），点一行原位展开完整运行视图。
- 新建团队：右上「新建团队」（＋ 旋转成 ✕）先给模板——开发三人组、修 Bug 二人组、调研加评审、空白团队，选完进入编辑，保存前都能改。
- 头像（`react/ai-teams/avatar.tsx`）：像素猫，8 种毛色；`avatar` 为空按成员 id 哈希取色，
  `cat:n` 指定毛色，也可上传图片（前端缩到 96px JPEG data URL，服务端限制 `AI_TEAM_AVATAR_MAX_CHARS`）。
  头像带负责人皇冠、CLI 角标，运行中按成员状态加色环（工作中 / 等你 / 失败 / 完成）。
- 窄屏（≤ 760px）列表和详情只显示一个，详情顶部有返回按钮。

### 5.2 派发：团队就是「CLI 工具」里的一个选项

不单独做「交给团队」按钮。任务详情的指派区和新建任务弹窗里，「CLI 工具」下拉在 6 个 CLI 后面追加
「团队 · {name}」（值为 `team:<id>`，见 `agentTargetOptions` / `agentTargetTeamId`）。选中团队后
模型、思考深度、工作模式、会话形态隐藏，改为显示成员头像；按钮文字变「交给团队」。
指派框不会预填任务卡描述；这次输入的提示词就是团队本轮要做的事，旧描述不会再静默拼进去。
只有创建任务后立刻交给团队、且没有另写提示词时，才用任务标题和描述当目标；
标题是描述开头被截断出来的前缀时（自动标题常见）只留描述，不把同一段话在目标里重复两遍。

任务详情的「团队进度」（`issues/team-run-panel.tsx`，只显示该任务最近一次运行）：
- 头部：团队、状态、步数；成员花名册（头像 + 已完成/总步数），点头像只看该成员的步骤。
- 横幅：`statusDetail`，以及按状态出现的 批准 / 驳回 / 回复 / 再给 10 步 / 停止。
- 视图切换「群聊 / 时间线 / 按成员」（`WandStretchTabs`），默认群聊。每步显示头像、`成员 · #seq`、标题、状态、报告预览，
  排队中的步骤显示「等待 #n」；点击原位展开完整指令与报告、「打开会话」、running 步骤的「标记完成」。
- 群聊（`ai-teams/team-chat-view.tsx`）按 IM 群聊分层，主任务与子任务不再长得一样：
  - 顶部钉住「主任务」公告位（运行目标，超过 3 行折叠，可原位展开）；
  - 负责人的决策是公告卡：品牌底色 + 「负责人」徽标，文本里的派工清单渲染成 `@成员 + 标题 + 等待说明` 的任务条目；
  - 成员发言是子任务块：左侧导轨按状态（进行中 / 完成 / 失败）着色，头部是头像 + 成员名 + provider +
    `✅/❌ 标题` 状态芯片；报告超过 6 行或 420 字默认折叠，点「展开全文」原位长高（收起是倒放，reduce-motion 下瞬时）；
  - 系统 notice（如「成员 开始「T1」」）是居中弱化的小行；用户发言仍是右侧气泡。
- 刷新：打开时 GET 一次，之后只响应 `ai-team-run` 通知。**不轮询。**

### 5.2.1 正在输出的成员（live 气泡卡）

`ai-team-run` 只说「步骤开始了」，成员真正在打什么字要靠 §4.9.1 的 live 通道。渲染落在
`ai-teams/team-chat-view.tsx`（任务详情面板与独立群聊页共用同一个视图），样式在
`ai-teams/styles.ts` 的「正在输出的成员」块：

- **数据**：`running` 时进入 `TeamChatView` 才 GET 一次 `/live` 取初值，之后只吃 `ai-team-step-live`
  推送（`websocket.ts` 分发 → `repository` 的订阅口 → 视图）。换运行、或运行不再是 `running`
  立刻清空列表——收工那一步会由 `ai-team-run` 重拉进 `chatTurns`，不需要 live 再留着。
  chunk 借不到 `lazy.tsx` 注册表里的新名字，所以拉取与订阅都挂在 `aiTeamsRepository` 对象上。
- **位置与形状**：行追加在 `chatTurns` 之后、乐观临时行之前，按 `seq` 升序、按 `stepId` 去重。
  头部是像素头像 + 成员名（可点，进成员会话）+ 署名 + `#seq 标题` 步骤芯片 + 状态芯片
  （取 `detail.memberStates[sessionId]`，映射「工作中 / 等待回答 / 等待授权」）+ 时刻。
  卡片 `max-width: 560px`、**高度固定 200px**（窄屏也不变），文本在卡内滚（`overscroll-behavior-y: contain`）、
  等宽字体；`omittedChars > 0` 时顶部一行「已省略前面 N 字」，文本为空显示「已开始，等待第一段输出…」。
- **署名（`agentSignatureLabel`）**：群聊三处（live 卡头部、成员步骤行、负责人行）原来只有 provider 的位置，
  现在统一是「CLI · 模型 · 思考深度」，例如 `Qoder · Qwen3.8-Flash · 最大`。真值来自 §4.8 / §4.9.1 的
  `provider` / `model` / `thinkingEffort`（实际使用候选，不是人设上的配置）。文案表两端同源：CLI 名走
  `ISSUE_AGENT_PROVIDERS`（Android `boardTaskProviderLabel`）、四档思考深度走 `ISSUE_AGENT_EFFORTS`
  的「关闭 / 标准 / 深入 / 最大」（Android `boardTaskEffortLabel`），CLI 自报的原生档位（`qoder:high` 这类）
  走 `compactThinkingLabel`。`model` 等于 `ISSUE_AGENT_DEFAULT_MODEL`（`"default"`，含义是「跟随服务端默认」）
  时**整段不显示**，与 Android 团队详情候选行同口径。哪一段缺就少一段：老服务端只有 provider 时显示
  `Claude`，三样都没有时连芯片都不渲染——不会出现 `undefined`、空串或悬空的「 · 」。
- **不抢滚动**：贴尾判定只有 `isFollowingTail`（阈值 `LIVE_TAIL_PX = 24`）一处，卡片内滚与外层
  `task-board-team-chat-list` 都用它。外层列表原先在任何行数变化（含 live 行插入 / 摘除）时无条件
  `scrollTop = scrollHeight`，会把正在上翻看历史的人拽回尾部；现在只有「上一次滚动他自己就贴底」
  才跟随（`listPinnedRef`），发自己那句话算一次明确的回到底部意图（同 §9 活动窗口口径）。
  `listPinnedRef` **按 `run.id` 重置为跟随**：换一次运行就是一页新内容，上一轮里的上滚不该让这一轮
  一进来就不贴尾（与 Android `remember(runId)` 同口径）。阈值单位是 **CSS px**（`scrollTop/scrollHeight/clientHeight`
  三者同单位），Web 侧不存在 Android 那个 dp/px 换算问题：移动端滚动几何是设备像素，阈值改记 dp
  （`TeamChatPresentation.kt` 的 `LIVE_TAIL_DP = 24`，经 `liveTailThresholdPx(density)` 换算，并与卡片
  内滚共用同一个换算函数）。
- **动效**：**两段式进场**，与 Android 同拍——头像 + 名字行先长出（`--motion-fast` / `--ease-out-expo`），
  气泡卡片隔一拍再长出（`--motion-normal` + `animation-delay: var(--motion-fast)`，`both` 填充让延迟期间不露白卡），
  不再整行同帧原子插入。收工后整行原位倒放收回（`--motion-quick-exit` + `reverse`，退场快于进场，§7 要求 7）；
  `mergeLiveRows` 的排序**只看 `seq`，与这一行是否在退场无关**（同一 `stepId` 只留一行，active 覆盖 leaving）：
  把没播完的退场行搬到尾部会触发 DOM move，动画重播一次并且位置跳动，所以退场行一律留在原位。
  退场行的摘除有两个入口，走同一个幂等函数：① 该行自己的 `animationend`（`mergeLiveRows` 不再把上一批
  退场行丢掉，也不向第三次传递，「又来一批文本」不会把收工动画腰斩）；② 一行一个**等长定时器兜底**——
  后台标签页不播 CSS 动画，`animationend` 可能永远不来。时长从 `--motion-quick-exit` 这个动效 token
  现读（`parseMotionDurationMs`，页面不写字面毫秒，改了 CSS 兜底跟着变），按每行的退场起算时刻倒计时，
  不被新推送续命；回到可见（`visibilitychange`）再补一次 `pruneExpiredLeaving` 清理隐藏期间攒下的过期行。
  时长与延迟全部取 token；reduce-motion 下全局规则把时长压到近零、`animation-delay` 在样式表里归零，
  两段都瞬时，但动画照常派发事件，退场行仍能撤掉。
  卡片尺寸与位置不随文本增长变化（§0 总则 2）。
- **点击**：整卡 `role="button" tabIndex={0}`，Enter / Space 与点击同一条路径 `onOpenSession(step.sessionId)`；
  有文字选区（复制正文）或按下与松开之间有 >6px 位移（卡内拖动滚动）时不跳转。卡片带 `aria-label`
  （「打开{成员名}正在输出的会话」），读屏只报动作，不把 200 字滚动的正文整段念出来。
- **Android 同口径**（`ui/screens/TeamChatPresentation.kt` + `AiTeamChatScreen.kt`）：`mergeLiveRows` 与 Web 一样
  **只按 `seq` 排、与 leaving 无关**，两端各守两条断言——「退场行前面还有 active 行时不被搬走」「同一批内
  不会因新一轮推送交换位置」。贴尾阈值记 **dp**（`LIVE_TAIL_DP = 24`，`liveTailThresholdPx(density)` 换算，
  外层列表与卡片内滚共用），并且外层列表的距底要**扣掉 `contentPadding.bottom`**：布局与判定用同一个
  `TeamChatListBottomPadding`（14dp）常量，否则 density 2.625 的屏上「手动拖到底」那一次会被判成不跟随
  （条目底离视口底正好差 37px > 旧的 24px），即「滚到底反而不跟新增的 live 行」。
  退场摘除两端机制不同但等效：Compose 不派发 `animationend`，`TeamLiveStepRow` 按 `WandMotion.fast`
  （与它自己的 `tweenExit` 同档）计时后调 `onRetire`——**本来就是等长定时器兜底，不是动画回调**，
  所以 Web 那种「后台标签页事件不来、退场行攒着」的问题在端上不存在，无需再加可见性清理；
  页面不可见（`resumed = false`）时整体推成退场，回到可见仍由行自己的计时摘。唯一残留差异：行滚出可视区
  后不在 composition 里、计时随之取消，那条退场行会留在列表里（不可见、也不会重复显示）直到滚回来才摘，
  数量有界于本次运行的步骤数。

独立群聊页（`ai-teams/team-chat-page.tsx`，侧栏群聊条目 / 开工首屏，`?view=teamchat&run=`）复用同一个群聊视图，
额外两件事：
- **按 chat 会话跟随，不按运行钉死**：用户在群里接着说一句会让服务端在同一个群聊上开新一轮，
  页面的 `load()` 除了重拉当前运行，还查一次同一 `chatSessionId` 上更新的运行（`aiTeamsRepository.runsForChat`），
  有就 `taskBoardController.open("", "", "teamchat", newRunId)` 原地切过去（地址栏 replace，返回键仍一步回原会话）；
  订阅也要按 `taskId` 收通知，否则新一轮的 runId 不同、页面根本不重拉。不跟随的话状态条、工作任务和
  步骤报告会停在旧的一轮，新一轮的对话和步骤都看不见。
- 输入框引导语：`awaiting_approval` / `running` 各有提示，运行已结束（完成 / 停止 / 失败）时显示
  「发消息会接着这一轮的进度开新一轮」（服务端真会这么做，见 §4.4 的群聊续跑上下文文件）。
- **停止**：未结束的运行（`running` / `awaiting_approval` / `waiting_user`）可以叫停整次团队。
  独立群聊页头部有一枚「停止」（滚动看消息时也在）；输入栏与普通会话同一位置——空草稿时发送按钮变成停止，
  有草稿时停止排在发送左侧。两端都走 `POST /api/ai-team-runs/:id/stop`（Android `TeamRunAction.Stop`）。

### 5.3 样式与预算

- 团队页（`ai-teams/teams-page.tsx`）、任务运行面板（`issues/team-run-panel.tsx`）及其样式（`ai-teams/styles.ts`）
  **不进首载的 `scripts.js`**，打成按需脚本 `content/ai-teams.js`（`scripts/ai-teams-chunk.js`，入口
  `ai-teams/chunk-entry.ts`），首次打开团队页或任务详情时由 `ai-teams/lazy.tsx` 下载，
  服务端路由 `GET /assets/ai-teams.js?v=<hash>`（hash 经 `getScriptContent` 注入，同 configPath）。
  下载中显示占位，失败可重试。
- chunk 里引到的其他 `src/web-ui/react` 模块和 `react` 一律向主包借（`lazy.tsx` 的 `AI_TEAMS_HOST`
  注册表），不能各带一份，否则 `taskBoardController`、仓储、React 会出现两份实例。
  **chunk 文件新增 import 时必须同步补注册表**，`tests/web-ui-ai-teams.test.ts` 会逐个名字核对。
- 主包仍带的只有头像（`avatar.tsx`）、CLI 下拉的团队选项（`agent-fields.tsx`）、仓储，
  以及 `styles/features.ts` 里的 `aiTeamsStyles`（头像、指派面板团队预览、侧栏角标、加载占位）。
  字号、间距、动效只用现有 token，**不要**写进 `content/styles.css`。
- 主包 `scripts.js` 通过 `/assets/app.js?v=<内容指纹>` 单独缓存；构建/CI 固定 `.nvmrc` 的 Node 版本，
  预算按实际首载（HTML + JS/CSS + vendor）、复访 HTML 与按需 chunk 分开核算，不再用旧的
  「内联 JS ≤512 KiB」门槛。live 通道进主包的只有 `websocket.ts` 的一个分发分支与
  `repository.ts` 的拉取/订阅口，ai-teams chunk 里的卡片与样式不占首载预算。

---

## 6. Android（第二阶段）

服务端 API 做完后，Android 的最小接入：
- 任务详情页加「团队进度」：状态、时间线（点击展开报告）、批准 / 驳回 / 回复 / 停止。成员会话本来就挂在任务下，点击直接打开现有的会话页（Chat 或 PTY）。
- 群聊：独立 `AiTeamChatScreen` 是主入口（侧栏点带 `teamChat` 标记的会话行）。顶栏停止图标与输入栏发送 ⇄ 停止变形
  都走 `actOnTeamRun(..., Stop)`；空草稿且运行未结束时发送按钮变成停止，有草稿时左侧再放一枚停止，口径同 Web 与普通会话。
  团队的 relay 会话也可以当普通结构化会话打开旁观/插话。
  `ConversationTurn` 已解析服务端的 `author`（名字 / 负责人 / provider）与 `notice`：负责人发言用品牌底色 +「负责人」徽标，
  成员发言显示成员名与 provider，notice 走居中弱化小行 —— 这样主任务与子任务能分开看，不再是一串没有署名的「Wand」回复。
- 团队定义在 Web 与 Android 两端都可编辑（共享同一套 `POST / PUT / DELETE /api/ai-teams` 契约）：
  - 列表页（`AiTeamsScreen`）顶栏 `＋` 原地展开模板面板（开发三人组 / 修 Bug 二人组 / 调研加评审 / 空白团队，文案与 Web `TEMPLATES` 同源），选完进编辑器；
  - 卡片上的「编辑」与团队详情顶栏的「编辑」都进同一个编辑器（`AiTeamEditorScreen`，新建 / 编辑同屏）；
  - 编辑器支持团队名、简介、协作指令、步数上限（− / N / ＋，5–200）、计划批准开关，以及成员增删、名字 / 职责、设负责人、每成员 1–4 个执行候选的加 / 删 / 上移 / 下移；
  - 校验与 `parseAiTeamInput` 同口径（名字 trim 后判长度、去重忽略大小写、恰好一位负责人、候选五元组不重复），错误原位列出，保存按钮原位显示保存中 → 已保存；有未保存改动时返回先确认；删除团队带确认。
  - PUT 是整体替换，所以 Android 不编辑的 `avatar` / `role` 必须原样回写（`AiTeamMember.toJson()`），否则一次改名就抹掉 Web 上选好的头像与职责标注。
- 收尾按 AGENTS.md：子模块提交并 push → 主仓库更新指针 → 编译带版本号的 beta APK 部署到 `~/.wand/android/` → 验证 `/api/android-apk-update?currentVersion=0.0.0&channel=beta`。

---

## 7. 测试

新建 `tests/ai-team-runner.test.ts`。用内存或临时 SQLite，`AgentDispatchDeps` 用假对象：记录「开了哪些会话 / 发了什么消息」，并能手动推送 ProcessEvent 和修改快照。需要覆盖：

1. 首轮：`start` 开一个 Leader 会话，提示词里包含所有成员的 id、名字和职责。
2. Leader 写入 assign（通过报告文件）→ `requirePlanApproval` 为真时进入 `awaiting_approval`；`approve` 后给第一个成员开会话。
3. Leader 把 JSON 直接回复在结构化对话里（没有文件）→ 同样能解析。
4. 成员 A 做完 → 派成员 B（提示词只给 A 的报告文件与交接文件路径，不内联正文）；B 做完且队列空 → 开 Leader 后续轮，提示词只列出各步报告文件与 `handoff-<seq>-leader.md`。
5. 同一成员第二次被派工 → 发到原会话（`sendToAgentSession`），不新开会话。
6. PTY 成员：只有报告文件出现才算结束；`completeStep` 能手动结束。
7. Leader 格式错误两次 → 第三次进 `waiting_user`；中间的修正消息发到了 Leader 原会话。
8. 派给不存在的成员 → 按格式错误处理。
9. `ask` → `waiting_user`；`reply` 后 Leader 收到用户原话。
10. 步数上限 → `waiting_user`；`continue` 后继续。
11. `stop`：调用了会话停止；running 和 queued 步骤变成 skipped。
12. `reconcile`：running 步骤的会话不存在 → 步骤 failed 并开 Leader 轮；会话存在且已结束 → 正常推进。
13. 同一任务卡上重复 `start` → 报错。
14. 状态不允许的操作 → 抛出冲突错误（路由转 409）。

另外：
- `tests/agent-dispatch.test.ts`：PTY 分支是「文本 + 单独的 `\r`」两次写入。
- `tests/ai-team-prompts.test.ts`：`parseLeaderDecision` 的合法 / 非法输入、成员名容错、长度截断。
- `tests/server-ai-team-routes.test.ts`：成员校验（人数、唯一名字、恰好一个负责人、`parseTaskAgent` 拒绝非法 provider）、409 映射。
- 现有 dispatch 相关测试在抽函数后全部原样通过。

---

## 8. 提交顺序

每个提交都要单独通过 `npm run check && npm test`。

1. 备份后删除旧团队实现（§3）。这个提交只有删除。
2. 抽出 `src/agent-dispatch.ts`，`/dispatch` 路由改用它，行为不变。
3. 从 `missions.ts` 导出 `activityState`（`hasUnansweredQuestion` 一并导出）。只移动、不改逻辑。
4. 存储：三张表 + 方法 + 单测。
5. `ai-team-types.ts` + `ai-team-prompts.ts` + 单测。
6. `ai-team-runner.ts` + 单测（§7 的 1–14）。
7. 路由 + `server.ts` 接线 + `ignoredDirectories` + 路由测试。
8. Web：抽出 `agent-fields.tsx`（看板行为不变）。
9. Web：侧栏「AI 团队」页 + CLI 工具下拉里的团队选项。
10. Web：任务详情的「交给团队」和团队进度面板。
11. Android（第二阶段）。

---

## 9. 最终验收（本机已安装的 Wand 服务）

连接信息读 `~/.wand/acceptance-connection.json`，**不要**写进仓库、日志或截图。先 `npm run build`，再按现有流程更新已安装的服务。

1. 侧栏 AI 团队 → 新建团队（模板「开发三人组」），改成「负责人 Claude（结构化）/ 实现 Codex（结构化）/ 验收 Pi（结构化）」，换一个头像，保存，刷新后配置不变。
2. 在一个测试仓库建任务卡「给 README 加一段安装说明」→ CLI 工具选「团队 · …」→ 交给团队 → 看到 Leader 会话出现在任务下 → 进入「等待批准」，时间线里能看到计划。
3. 驳回并写意见 → Leader 重新安排 → 批准。
4. 实现成员的会话出现并改文件 → 验收成员的会话出现并给出结论 → Leader 宣布完成。时间线每一步都能展开看到报告，「打开会话」能跳到对应会话。
5. 把实现成员改成 **Qoder（PTY）**，重跑一次：PTY 成员写完报告文件后流程自动继续。
6. 实现成员设为「标准」模式：出现权限弹窗时，团队进度显示「等待授权」；在会话里批准后流程继续。
7. 运行中重启 Wand 服务：重启后流程继续，或者进入明确的状态（步骤失败并交回 Leader），不会卡死在「运行中」。
8. 运行中点「停止」：成员会话停止，时间线显示已跳过，会话仍可翻看。
9. `git status` 看测试仓库：没有 `.wand-team/` 出现在未跟踪文件里，也没有自动提交。
10. 另开一个浏览器标签，看到的状态和第一个标签一致，不需要手动刷新。
11. 用「调研加评审」模板跑一次：两个调研员的会话同时出现（并行），负责人等两人都结束后才开始汇总。团队页「运行记录」里能看到这次运行。

---

## 10. 明确不做（首版）

- 各成员独立 worktree 再合并。成员可以并行（`after`），但都在任务的同一个工作目录里改，分工要由负责人避免冲突。
- 自动 commit / push / 部署。
- 成员之间直接对话。所有交流都经过 Leader。
- 团队定义的版本历史。运行开始时存一份快照就够了。
- 按 CLI 定制的任何逻辑。如果某个 CLI 表现异常，修的是它在现有会话链路里的 adapter，不在团队代码里打补丁。
