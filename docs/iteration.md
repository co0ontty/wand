# 迭代（里程碑）与 commit 生成

本文说明「迭代」这条链路：概念、数据模型、提示词记录、窗口语义、commit 生成模式、
HTTP 契约与前端接线。相关代码：`src/iteration-log.ts`、`src/milestone-scope.ts`、
`src/git-quick-commit.ts`、`src/storage.ts`、`src/server-{task,workspace,session}-routes.ts`、
`src/web-ui/react/quick-commit/*`。

## 概念

**迭代就是里程碑**：没有第二张表、第二套路由。用户看到的下拉（看板、新建任务、
派发任务）里选的就是迭代，只是 UI 文案沿用「里程碑」。在此基础上加了两条规则：

1. **默认迭代**：全局唯一一行（`is_default = 1`、`workspace_id = NULL`，名字
   `默认迭代`），用户没选迭代时一切新建都落到它这里。所以「每个任务都属于一个迭代」
   在任何入口都成立——看板建卡、侧栏新建会话、派发任务、以及只 PATCH `workspaceId`
   的原生客户端。
2. **迭代提示词**：用户在这一轮迭代里发过的提示词标题会被记下来，生成 commit message
   时默认拿它当输入，不必每次都让模型读代码（省 token、也更快）。

默认迭代是惰性创建的：`ensureDefaultWandMilestone()` 在第一次需要它时建行。如果用户
自己建过同名「默认迭代」，直接把它提升为默认，不重复建行。

## 不变式

- **历史行不搬家**：库里 `wand_tasks.milestone_id IS NULL` 仍然表示「没单独指定」，
  历史数据不动。只在**读路径**（DTO）用 `resolvedMilestoneFields()` 兑成默认迭代，
  **写路径**（POST / PATCH / `createTaskForWorkspace`）开始落默认迭代 id，新数据不再
  产生 NULL。
- **默认迭代不可删、不可改挂工作区**：`DELETE /api/wand-milestones/:id` 对默认迭代回
  400「默认迭代不能删除…」，`PATCH` 忽略 `workspaceId`。否则「没选迭代」就无处可落。
- **迁移只加不删**：`wand_tasks.is_default` 列与 `wand_iteration_prompts` 表都是
  `CREATE TABLE / ALTER TABLE ... ADD COLUMN IF NOT EXISTS` + `ensureIterationPromptSchema()`
  两份（老库走 ensure，新库走 INIT_SQL）。
- **记录按仓库隔离**：`repoKey = git rev-parse --path-format=absolute --git-common-dir`。
  同一仓库的 worktree 共享同一个 key（并行 worktree 的改动不会被算成两个项目），
  别的项目的历史不会混进这次 commit message。拿不到仓库身份时不按仓库过滤——
  宁可多给几条，也不给一个空面板。

## 提示词记录

`recordIterationPrompt()` 挂在用户提交输入的热路径上（`process-manager` 与
`structured-session-manager` 的 `maybeGenerateSessionTopic`），因此：

- **零额外成本**：先同步过滤没信息量的输入（`shouldGenerateSessionTopicFromInput`，
  与会话标题共用同一把尺子），不合格直接 return，一次 IO 都不做；标题是本地取的
  提示词首行（`iterationPromptTitle`），不调模型。
- **不阻塞、不抛错**：真正的写入排进模块级串行队列（`writeChain`），失败只打日志。
  测试用 `whenIterationPromptsSettled()` 等队列落地。
- **去重**：同一会话 2 分钟内标题与详情都相同的记录直接丢弃（重复粘贴、重发）。
- **归属**：会话绑定的看板任务 → 它所属侧栏任务的迭代 → 都没有就落到默认迭代。
- 没有会话输入的入口（派发任务、任务建卡）走 `recordIterationPromptForTask()`，
  用任务标题当记录。

`source` 取值 `session | task | dispatch`，用于区分记录从哪来。

## 窗口语义：未消费 = 上次提交以来

一条记录只有两个状态：未消费（`consumed_at IS NULL`）和已消费（记住
`consumed_commit`）。提交成功时路由调用 `markIterationPromptsConsumed(ids, hash)`
把**本次用到的条目**标记掉，于是「未消费集合」天然就是「上次提交以来的变更」，
不需要按时间窗猜。

- 两种模式都消费：提交是仓库事实，跟 message 是谁写的无关。用户在面板里手写 message
  也消费选中的集合。
- 切到「完整 diff」模式也消费：否则切一次模式就会把这一轮改动留到下一轮。

## commit 生成：两种输入源

| 模式 | 输入 | 何时自动回落 |
| --- | --- | --- |
| `iteration`（默认） | 本轮提示词清单（标题 + 详情，12 000 字符预算）+ 工作树文件清单 | 选中的条目为 0 |
| `diff` | 完整 diff（原逻辑） | — |

- 偏好存 SQLite `pref:commitContextMode`，非法值回落 `iteration`。
- `iterationPromptDigest()` 时间正序，从最新往回装；预算不够时**丢最早的**，最后一条
  再长也保留（宁可多一行，也不丢最新的改动）。标题是详情前缀时只输出详情，避免同一句
  话重复两遍。已消费条目标注「（上一轮已提交）」。
- 迭代模式仍然会带上 `git diff HEAD --stat` 级的文件清单（`collectWorkingTreeSummary`，
  4 000 字符上限），只给文件不给内容；`includeDiff: true` 时才额外附完整 diff 兜底。
- 用户手写 message 时完全不读任何输入（`commitMessageFromIteration`）。

## HTTP 契约

```text
GET  /api/sessions/:id/iteration-context[?milestoneId=&mode=]
  → { iteration{id,name,isDefault}, repoKey, entries[], defaultEntryIds[], selectableIds[],
      truncated, effectiveMode, mode }
  entries 新的在前，每条 { id, title, detail, createdAt, consumed, consumedCommit, source,
  sessionId, taskId }；defaultEntryIds 是「上次提交以来」；selectableIds 允许提交的 id 全集
  （比 entries 宽，用于校验回传的勾选）。
POST /api/sessions/:id/iteration-context  body { mode }
  → { ok: true, mode }   # 只存偏好；非法 mode 400，会话不存在 404

POST /api/sessions/:id/generate-commit-message
POST /api/sessions/:id/quick-commit
  body ... { mode?, entryIds?, includeDiff? }
  → 回 { commitContext: { source, entryIds, iteration } }，quick-commit 另有
    iterationEntriesConsumed
```

`entryIds` 只会匹配 `selectableIds`（这个迭代 + 同仓库），前端传错、传了别的迭代也不会
串味。不传 `entryIds` 就等于默认的「上次提交以来」。服务端只校验、不信前端。

## Web UI

- `react/quick-commit/iteration-panel.tsx`：快捷提交弹层里的「本次变更输入」区——
  模式切换、条目复选（默认勾上「上次提交以来」）、全选/清空/回到上次提交以来、
  「同时附上完整 diff」开关。生成后用一行灰字告诉用户 message 是依据 N 条提示词生成的
  （还是读了 diff）：省 token 这件事要看得见。
- `react/quick-commit/{repository,model,host}.tsx`：`loadContext` / `saveContextMode` 走上面
  两个接口；`buildQuickCommitInput(form, action, submodule, selection?, includeDiff?)`
  只在真有时才带上相关字段，没选过就交给服务端用记住的偏好兜底。提交成功后重新拉一次
  上下文（刚提交的条目变成「已提交」，默认勾选随之清空）。
- `react/milestones/default-iteration.ts`：`useDefaultMilestone()` 取当前工作区可见的默认
  迭代，`usePreselectMilestone()` 在每个面板**打开时预选一次**（用 ref，用户清空后不回填）。
  三个新建入口（看板建卡、侧栏新建会话、派发任务）都接上了它。
- `react/milestones/picker.tsx`：默认迭代带「默认」徽标；选中默认迭代时「清除」的语义是
  「回到默认」。

## 原生客户端

刻意没有改 `android/` `ios/` `macos/` 子模块。服务端读路径已经把 NULL 兑成默认迭代
（`taskDto` 同时给 `milestoneId` 和 `milestone{id,name,isDefault}`），所以老客户端显示的
是真实归属，不需要跟着改；它们不传 `milestoneId` 时，新建任务照样落到默认迭代。

## 验证

```bash
node --test --import tsx tests/iteration-log.test.ts
node --test --import tsx tests/server-iteration-context-routes.test.ts
node --test --import tsx tests/git-quick-commit-ai.test.ts
node --test --import tsx tests/web-ui-quick-commit.test.ts
node --test --import tsx tests/web-ui-iteration-context.test.ts
node --test --import tsx tests/wand-milestones.test.ts
npm run check && npm test && npm run build   # build 末尾跑包体预算
```

手工验收入口：登录 → 建任务（不选迭代，看面板/看板是否显示默认迭代）→ 在会话里发几条
提示词 → 快捷提交（看默认勾选、生成来源提示、提交后条目变成「已提交」）→ 切到「完整
diff」再切回来（偏好要记住）→ 换一个仓库的会话（不应看到上一个仓库的提示词）。
