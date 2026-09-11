# Wand 优化与修复计划

最后更新：2026-09-10（代码已按本计划实施）。配套：`server-logic-analysis.md`、`client-logic-analysis.md`。

**状态：R01–R14 已落地并有针对性测试。** 后续又完成了 R09 的加密范围扩大（`notes`/`fields` 加密落盘）、R03 的 TUI/daemon client 字节流补漏、R11 的 layout revision / review 入队判定，以及议题看板从 vendor iframe 重写为 Wand 原生 React 面板（R01 收尾，vendor 链路已删除）。服务端简化后已跑 `npm run check` 与相关测试；未做真机验收。Android 未改代码，无需重打 APK。

## 0. 计划怎么读

旧计划把 2026-08-22 的切片 1–5、2026-08-23 的任务一级容器写成“已落地并验收”。那一轮的输入契约、DTO、原生任务根导航确实已经进代码；但文档随后没有跟上议题看板、GitHub、structured daemon 恢复、SDK 审批、任务/看板/Mission 三套实体并存。正文还把已消失的 `\n` 提交、macOS 不解析 title、Inbox 空壳等写成现状。

本文件只排**当前仍伤用户、会丢数据、或会让后续改动继续分叉**的工作。已完成项不再伪装成待办。历史切片保留在文末附录，方便对照，不作为新排期。

原则：

- 不合并 PTY / structured runner。
- 不在 PTY bridge 伪造 tool block。
- 不为原生复制 Web 分屏 `mode:add`。
- 不为 schema 删除 `claudeSessionId` / `resumed_to_session_id`。
- 不为 native 做 iOS 应用内装包。
- 不为密码库宣称“目录泄露后仍安全”。
- 不为 WorkspaceTask、Mission、WandTask 做强制 ID 合并；先把 seam 说清，再决定产品入口。

---

## 1. 本轮核对范围与限制

### 1.1 已覆盖的自有代码

| 范围 | 数量（git ls-files） | 核对方式 |
| --- | --- | --- |
| `src/` | 277 | 组合根、路由、两套 runner、WS、workspace、议题看板、GitHub、文件、更新 |
| `tests/` | 103 | 抽样跑契约、恢复、权限、文件、WS、GitHub、task 聚合 |
| `scripts/` | 10 | 构建/资产脚本存在性，未重跑全量 `npm run build` |
| `browser-extension/` | 13 | 登录、消息分派、passkey 去私钥、默认 URL |
| `.github/workflows/` | 8 | 未作为本轮修复对象 |
| Android Kotlin/Java | 110 + 15 | 任务根、输入、WS、更新、语音状态机 |
| iOS Swift | 59 | ChatStore、任务 API、WebView 注入、更新横幅 |
| macOS Swift | 43 | ChatStore mutation、任务 API、原生文件面板 |

### 1.2 明确未完成的验证

- 没有对全部 `tests/*.test.ts` 做全量回归；抽样 43 项，42 通过，1 失败（见 R14）。
- 没有启动真实 `wand web`、真实 GitHub、真实议题派发、真实 provider CLI。
- 没有真机/模拟器验收 Android、iOS、macOS。
- 没有对六种 provider 的每条 resume/权限路径做运行验证。
- 没有对 systemd/launchd 自更新、证书导入、扩展自动填充做运行验证。

因此：下列 **已复现** 项可以直接排修复；**静态确认 / 未复现** 项必须先补测试或隔离探针，再改产品代码。

---

## 2. 当前交互基线（不再当缺陷排期）

这些是代码里已经存在的行为，优化时必须当约束，不要再按 8 月文档回退：

1. 会话 DTO 含 `workspaceId` / `workspaceTaskId` / `queuedMessageSkills` / `titleGenerating` / `ptyBusy` / `providerSessionId`。
2. WS 接受 cookie 和 Bearer；原生多数仍先 login 拿 cookie。
3. Claude SDK structured 在 default 权限下走 `canUseTool`；HTTP 审批路由对 pending SDK 请求有效。
4. Structured CLI 可经 terminald 跨 web 重启领养；Claude SDK / 本进程 fallback 仍随 web 结束。
5. Inbox HTTP/CLI 已接线；Web 自动化入口仍是 Missions，不是 inbox。
6. `/api/tasks` 是 WorkspaceTask 聚合；独立任务走 global workspace。
7. Web / iOS / Android / macOS 任务内「＋」都能开 structured、PTY、shell。
8. 各端 composer 的 PTY 提交已是文本 + `\r` + `enter_text`；AskUser 的 PTY 路径同样拆包。
9. 原生 session-list 已处理 revision/unchanged；Android 任务聚合也用 revision。
10. 密码库 password、notes、fields 与 connector token 新写入都可加密（`enc:v1:`）；读取兼容旧明文。
11. Android 无参 APK 检查与下载默认 stable；beta 必须显式 `channel=beta`。
12. iOS 有 IPA 检查 + OTA manifest；未签名包不能当成可安装。
13. Web 侧栏同时有独立任务、项目、自动化和议题看板、GitHub。
14. 议题看板已是 `/api/wand-tasks` 的原生 React 看板（vendor iframe 已移除）。

---

## 3. 本轮问题清单

优先级：

- **P0**：已复现，会覆盖用户数据、错绑连接、或让新功能主路径失败。
- **P1**：已复现或静态确认，用户可踩到，但有绕路。
- **P2**：静态确认的协议/性能/产品分叉，修复前要先补测试。
- **P3**：文档、测试漂移、命名清理。

### P0

#### R01 — （已完成）看板绑定与指派失效

**原证据：** vendor 看板经 bridge 代理时，`POST /taskboard/api/wand/bindings` 读不到 `req.body`（当时 `/taskboard` 挂在全局 `express.json()` 之前），对合法 JSON 返回 400；指派脚本把「加载中…」留在 `<select>` 里且没有 generation 保护。

**已落地：** 整条 vendor 链路（`src/taskboard-bridge.ts`、`vendor/codex-taskboard`、iframe、postMessage 握手、注入脚本）已删除，议题看板重写为 Wand 原生 React 面板，直接读写 `/api/wand-tasks`：

1. 绑定走 `POST /api/wand-tasks/:id/sessions`，由常规 Express JSON parser 处理，不再有挂载顺序陷阱。
2. 派发走 `POST /api/wand-tasks/:id/dispatch`，服务端校验 provider / model / thinkingEffort 后才创建会话与绑定。
3. 前端切换 provider 时丢弃不在新目录里的模型；目录未加载时提交 `default`，不会带占位值启动 Agent。
4. 测试：`tests/server-task-routes.test.ts`（真实 HTTP 建/绑/派发、非法 provider、无工具拒绝）、`tests/web-ui-task-board.test.ts`（目录归一化、provider 切换、派发守卫）。

**验收：** 见上述两个测试文件；议题可绑定项目目录与 CLI 工具，派发后会话落在该目录并绑定回议题。

#### R04 — 文件编辑器保存会覆盖外部更新

**证据：** 预览打开后把磁盘改成 `external agent changes`，再 POST 旧草稿，`/api/file-write` 返回 200，磁盘变成 `stale editor draft`。服务端只做临时文件 + rename，没有 expected mtime/hash。客户端 repository 也不带条件。

**用户可见：** Agent 或另一标签刚改的文件被编辑器旧内容盖掉，且提示“已保存”。

**做法：**

1. `POST /api/file-write` 增加可选 `expectedMtime` / `expectedSize`（或内容 hash）。不匹配返回 409 和当前 stat，不写文件。
2. 打开预览时带上 mtime；保存带 expected；409 时 UI 提供“重新加载 / 仍要覆盖”。
3. 保存中继续输入时，baseline 只更新真正写入的那一版 draft（controller 已朝这个方向写，但缺少冲突分支）。
4. 测试：外部修改后旧草稿 409；匹配 mtime 的保存成功；目录/非文本仍失败。

**验收：** 复现探针改为 409 且磁盘仍是外部内容；用户明确覆盖后才替换。

**触及：** `src/server-file-routes.ts`、`src/web-ui/react/code-editor/{repository,controller,types}.ts`、`tests/server-file-routes.test.ts`、Web 编辑器测试。

#### R05 — GitHub 连接校验的晚到失败会撤销新连接

**证据：** 用假 fetch 让第一个 token 挂起，第二个 token 校验成功后 `connected:true`；再让第一个 401 返回，`connected` 变成 `false`，连接被删。`connectGithub` 在校验前就写入共享 connector，失败路径按“校验前快照”回滚。

**用户可见：** 后保存的有效 Token 消失，议题加载突然失败。

**做法：**

1. 连接操作带 generation / 单飞锁。一次只允许一个 in-flight connect；新请求取消或忽略旧请求的回滚。
2. 校验成功前不要把共享 token 当成已连接；失败只回滚**自己那一次**写入。
3. HTTP 请求加超时。
4. Issues UI：把已加载的 owner/repo 固定为 `loadedRepo`；创建/开关/绑定都用它。加载与创建用 generation 和 pending。
5. 测试：先慢失败、后成功，最终仍连接第二个 token；输入改 repo 后不能对旧列表发错仓库请求。

**验收：** 复现探针结束后仍 connected；UI 不会把 A 仓库的 issue 操作打到 B 仓库同号 issue。

**触及：** `src/github-connector.ts`、`src/server-github-routes.ts`、`src/web-ui/react/issues/host.tsx`、`tests/github-connector.test.ts`。

### P1

#### R03 — Structured CLI 输出按块 `toString()`，UTF-8 跨 chunk 会坏

**已修复：** 对 `startStructuredCli` 注入 mock child，把含中文/emoji 的 JSON 从多字节字符中间切开，解析到的行曾出现替换字符。已在 `structured-exec-pump.ts` 本进程 stdout/stderr、daemon 事件、daemon JSON 帧、`terminal-daemon-client` socket 帧与 TUI attach socket 统一改为有状态 `StringDecoder`，并以真实多字节切分测试锁定。

**用户可见：** 中文/emoji 流式回复出现替换字符；重启领养回放也可能从坏字节开始。这与 PTY 列宽“乱码”不是一类问题。

**做法：**

1. 在 **StructuredExecHost / pump 的字节流 seam** 做有状态 UTF-8 解码（`StringDecoder` 或等价），按行切之前先得到完整字符。
2. daemon 的 structured stdout/stderr 与 NDJSON 控制帧分开处理：控制协议仍是 UTF-8 JSON 行，但进程输出不能按 chunk 直接转字符串。
3. 单测必须用真实多字节切分，而不是只喂完整 ASCII 行。
4. 恢复回放路径用同一 decoder，避免“直播坏、回放更坏”。

**验收：** 跨 chunk 的多字节字符行完整；截断日志仍标记 `stdoutTruncated`，但不额外引入替换字符。

**触及：** `src/structured-exec-pump.ts`、`src/structured-exec-host.ts`、`src/terminal-daemon-server.ts`、`tests/structured-exec-daemon.test.ts`。

#### R08 — macOS 会话配置与部分队列回包缺少 generation

**证据：** `macos/Wand/ChatStore.swift` 的 `setModel` / `setThinkingEffort` 各自 `Task { apply(snapshot) }`。iOS 有 mutation 尾队列和 revision，Android 有 Mutex + generation。macOS 快速连点可以把旧成功回包盖到新选择上。删/清队列失败时直接恢复函数开始时的数组，可能盖掉期间 WS 已更新的队列。macOS structured send 丢弃 202 快照，只靠 resync。

**用户可见：** 模型选了 A 显示成 B；排队条闪回旧列表；偶发“已发送但 UI 仍转圈”。

**做法：**

1. 把“会话配置 mutation”收成与 iOS 同形状的 Interface：一次一个 in-flight，回包必须匹配 generation 才 apply。
2. 队列本地乐观更新以服务端/WS 为准，失败时重拉或按 generation 丢弃，不要无条件回滚整份旧数组。
3. structured send 对齐 iOS/Android：apply 202 或明确忽略过期 202。
4. 单测用纯 reducer 覆盖“先发 A 再发 B，A 后到”和“删队列期间来了 WS 新队列”。

**验收：** 连点模型最终与最后一次成功请求一致；队列失败不会盖掉更新的服务端队列。

**触及：** `macos/Wand/ChatStore.swift`、对应测试；必要时抽共享 reducer 思路，但不为三端再抄一份大 Store。

#### R10 — Git / worktree 操作的用户可见副作用大于按钮文案

**证据：** `generateCommitMessageOnly()` 先 `git add -A`。任务创建在 `worktree:true` 失败时仍建任务并降级到项目目录。删除隔离任务会 cascade 会话并 `cleanupWorktreeSync`（force remove）。这些是代码路径，不是猜测。

**用户可见：** 点“生成提交说明”后暂存区变了；以为建了隔离任务，实际改的是主工作区；删任务丢掉未合并文件。

**做法：**

1. 生成提交说明改为不修改 index；若必须看完整 diff，用 `git add -N` / 临进 tree 或明确“将暂存全部改动”的二次确认。
2. 创建任务：显式 `worktree:true` 失败应 4xx 或要求用户确认降级，不能静默 `isolated:false`。
3. 删除隔离任务/会话前，UI 写明会删会话、worktree、未提交改动。
4. 测试锁住：生成文案后 `git status` 无新 staged；`worktree:true` 在非 git 目录失败。

**验收：** 取消生成说明后工作区与点击前一致；强制隔离失败不会悄悄落到主目录。

**触及：** `src/git-quick-commit.ts`、`src/server-workspace-routes.ts`、Web/原生创建删除文案、对应测试。

### P2

#### R02 — （已完成）看板权限矩阵

**原风险：** vendor 子服务挂了会拖垮启动；非静态 `/taskboard/*` 只过 `requireAuth`，connected-app 可能打到本应 admin 的看板 API。

**已落地：** vendor 子服务整体移除后这些风险不再存在。议题看板 API 是 `/api/wand-tasks*`，全部走 `requireAdmin`（`registerTaskRoutes` 的 `guard`），与 GitHub 路由同一 principal。派发会产生真实会话，因此不接受 connected-app 调用。


**验收：** 人为让 vendor spawn 失败时 web 仍监听；未授权主体打敏感看板 API 得到 403；授权用户可打开 iframe。

#### R06 — WS 背压丢掉非 output 事件时没有 resync 信号

**静态确认：** 非 ACK 客户端在队列满时丢弃新业务事件，只把 `type==="output"` 记入 `pendingResyncSessions`。ended/status 被丢时，客户端可能一直 `isResponding`。

**做法：** 丢弃任何带 sessionId 的业务事件都记 pending resync；或 ended/status 永不丢，只丢可重建的 output。补“队列满时只投 ended、客户端必须停转圈”的测试。真实慢网络作为验收，不作为开工前置。

**触及：** `src/ws-broadcast.ts`、`tests/ws-broadcast.test.ts`、各端 reducer。

#### R07 — Structured 恢复窗口缺少并发与失败测试

**静态确认：** 恢复前快照会 idle + lastError；成功领养后清错误、重设 inFlight。未覆盖：恢复中再次 send、list 与 adopt 之间的半行输出、连续 web 重启、截断日志、SDK 中断提示被当成永久失败。

**做法：** 在 `StructuredExecHost` 这一个 seam 上补测试/fake：恢复成功、失败、截断、恢复期间 send、SDK 不恢复。客户端按 `inFlight` / lastError / 恢复完成事件显示三种文案。不要在 UI 上发明第三套状态机。

#### R09 — 密码库加密范围（已扩大并更正文档）

**已修复：** `password`、`notes`、`fields`（TOTP、卡、passkey 私钥所在 JSON）与 connector token 现都以同一把 vault 密钥 `enc:v1:` 加密；读取兼容旧明文行。扩展发给 content script 前仍会删 `privateKeyJwk`。

**剩余边界：** appSecret 与数据库同目录，单靠 at-rest 加密不能抵御整个数据目录泄露；不要把结论写成「目录被拖走也安全」。

#### R11 — 跨任务打开、布局保存、review 状态缺少条件更新

**已修复（服务端 + Web adapter）：** `openTask` 用 generation 丢弃过期详情；layout PUT 带 `layoutRevision`，冲突 409；Web adapter 保存时带当前 revision。Mission `sendReview` 只在 `sendMessage` 被接受后才标 sent，同步/微任务失败保持 pending。

**风险：** 快切任务 A→B，A 的详情回来覆盖 B；两端保存布局互相覆盖；review 发送失败仍显示已发送。

**做法：**

1. adapter/controller 为 openTask 增加 generation；过期详情不得 `setActiveWorkspaceContext` / `selectSession`。
2. layout 保存带 revision 或 `updatedAt`；冲突 409。
3. review 在 `sendMessage` 被接收后再标 sent，失败保持 pending。
4. 用假 repository 测 A→B 乱序；不要先改 UI 视觉。

#### R12 — 四套“任务”入口继续分叉

当前并存 WorkspaceTask、Missions、WandTask（任务管理），外加 GitHub issue。Web 底部同时有「任务」「自动化」「任务管理」「GitHub」。原生客户端已接入任务管理（`/api/wand-tasks*`，登录即可）。`wand_tasks` CRUD 已被看板消费。

**做法（产品决策，先文档后代码）：**

1. 用户可感知名称：侧栏容器叫“任务”（WorkspaceTask），看板叫“任务管理”，Missions 保持“自动化”。
2. 任务派发 Agent 的结果至少写入 `wand_task_sessions`；是否同时 bind WorkspaceTask 要单独决定，默认不要静默双写。
3. 若 React 不再使用 `/api/wand-tasks`，标明遗留 API，而不是继续加功能。
4. Inbox 若要进 UI，单独入口消费 `/api/inbox`，不要塞进 Missions 对话框。

未做决策前，只修 R01/R02 的正确性，不做信息架构大改。

#### R13 — 任务聚合与会话列表仍是全量拼装

**已修复（廉价 revision）：** `GET /api/tasks?revision=` 先用存储指纹 + slim 会话状态算 hash，unchanged 时不再拼 groups。Web 侧栏已接 revision。limit 仍是每 workspace 截断；iOS/macOS 是否接 revision 仍按端核对。

**做法：** 先给聚合一个廉价 revision（会话/任务表的更新计数或 max(updatedAt)），unchanged 时不要拼 groups。Web/iOS/macOS 接 `?revision=`。这是性能切片，放在 P0 契约之后。

### P3

#### R14 — Apple WebView 契约测试与实现漂移

**证据：** `tests/web-native-contracts.test.ts` 要求 `ios/Wand/WebContainerView.swift` 含 `.is-wand-embed-terminal .notification-bubble.update-card`。实现注入的是更宽的 `.notification-bubble` 隐藏。抽样测试因此失败。

**做法：** 先确认嵌入终端是否仍要隐藏全部通知气泡。若是，改测试匹配当前选择器；若更新卡片必须可见，再改注入 CSS。不要为了绿测试改回更窄选择器却让更新气泡挡住终端。

---

## 4. 建议实施顺序

```text
切片 A  正确性 / 数据丢失     R01, R04, R05, R03
切片 B  客户端状态机对齐       R08, R14, R06 的测试与最小修复
切片 C  Git / 恢复 / 布局      R10, R07, R11
切片 D  集成边界               R02, R09（加密扩大已落地）, R13
切片 E  产品入口               R12（需先确认信息架构）
```

A 可部分平行：R01（bridge）/ R04（file-write）/ R05（github）/ R03（字节流）文件冲突少。B 的 macOS ChatStore 不要和 A 抢同一原生发包窗口。C 动 git 与 workspace，避免与 A 的文件写入同时大改。D/E 不阻塞 A。

每个切片内部顺序：**先补失败测试或隔离探针 → 再改 Interface → 再改调用方 → 最后改文案**。不要先改 UI。

---

## 5. 每项的模块与验收

用 codebase-design 的话说：先加深已有 seam，不新加一层 store。

| 问题 | 应加深的 Interface | 不要做的事 |
| --- | --- | --- |
| R01 | （已完成）vendor 看板重写为 Wand 原生 React 看板 | 收尾验证 |
| R03 | StructuredExecHost 字节流 | 在 adapter 里对已损坏字符串做 replace |
| R04 | file-write 的条件保存 | 只在前端比 mtime、服务端仍无条件写 |
| R05 | `connectGithub` 的单次连接 attempt | UI 再加一份 token 缓存 |
| R06 | WsBroadcastManager 丢弃/resync 策略 | 客户端猜测 ended |
| R07 | `recoverDetachedRuns` / ExecHost.list+adopt | UI 轮询伪装恢复 |
| R08 | 原生会话 mutation 的 generation | 每个按钮自己 set 完再 apply |
| R10 | git-quick-commit / createTask 的副作用合同 | 文案说“不会改仓库”却继续 add -A |
| R11 | openTask/layout 的 generation | 再镜像一份 workspace store |
| R02 | startServer 对看板的降级 seam | 看板失败则整个 web 不起来 |

### 通用验证

服务端/Web 改动：

```bash
npm run check
# 先跑本切片相关 tests/*.test.ts，交付前 npm test
npm run build
```

会话/DTO/WS/权限再补 `session-transport`、`server-session-routes`、`ws-broadcast`、`structured-permission`。

Android 有 Kotlin 改动时，按仓库规则出 beta APK 到 `~/.wand/android/`，并验证 `/api/android-apk-update?currentVersion=0.0.0&channel=beta`。用户明确说跳过才可不构建。

iOS / macOS：模拟器走发送、模型切换、权限条、任务切换；嵌入终端确认通知/输入栏。

隔离冒烟：

```bash
npm run build && node dist/cli.js web -c /tmp/wand-dev/config.json
```

本计划验收不使用真实用户 `~/.wand/` 配置。

### 切片 A 最小复现（修复后应反过来失败/成功）

1. 议题绑定：POST `/api/wand-tasks/:id/sessions` JSON `{sessionId}` → 201。
2. 文件：打开后外部改文件，旧草稿保存 → 409。
3. GitHub：慢失败连接不能删掉已成功的新连接。
4. UTF-8：跨 chunk 的多字节字符行等于原 JSON。

---

## 6. 明确不做 / 延后

- 合并两套 runner，或让 PTY 聊天长出假 tool_use。
- 原生 Web 同款分屏订阅。
- 重命名数据库列 `claudeSessionId`。
- 把 WandTask（议题看板）、WorkspaceTask、Missions 合成一张表。
- 在未做权限矩阵前开放议题看板给所有 connected-app 当完整产品。
- 扩展默认 URL 常量清理（行为已用请求 origin；常量只留文档/fallback）。
- 以“文档写过已验收”为由跳过本计划的新测试。

---

## 7. 文档维护

本轮已把 server/client 分析改成 2026-09-10 基线。以后：

- 行为变化先改这两份分析，再改本计划状态。
- `task-first-rollout.md` 只保留 8 月任务一级容器史实，不再当当前 UX 真源。
- `taskboard-vendor.md`（议题看板）、`browser-extension.md` 继续写集成细节；与主分析冲突时以主分析 + 本计划为准。
- 不要在分析文末再堆一套与计划重复的 P0 表。

附录里的旧切片状态用于审计“当时做了什么”，不用于判断现在是否还要做。

---

## 附录 A — 2026-08-22/23 旧切片（历史）

当时声称完成、现已在代码中确认存在对应实现的部分：

- 切片 1：各端 PTY composer 拆包（现代码已对齐，不再列为缺陷）。
- 切片 2：macOS DTO 字段、Android 202+resync、PTY `responseMode=accepted`、isResponding 语义大部分已落地；macOS mutation generation 仍缺，见 R08。
- 切片 3：session-list revision/unchanged、Android 任务 revision；Web/iOS/macOS 任务聚合仍全量，见 R13。
- 切片 4：iOS 用 `canManageSettings` 隐藏服务端安装按钮；结构化 lastError toast 三端都有。其它端更新文案仍要按端核对。
- 切片 5/6 与 `task-first-rollout.md`：任务一级容器多端已落地；Missions 可关联 taskId；`/api/tasks` 有截断参数。

当时文档写错、现已更正的部分：

- Inbox 仍空、WS 不认 Bearer、DTO 丢 workspace 字段、file-search 锁 process.cwd()、SDK 无审批、iOS 无更新接口、任务内只能开 PTY、Android ChatStore 仍发 `\n`、macOS 不解析 title。

---

## 附录 B — 关键文件速查

| 主题 | 文件 |
| --- | --- |
| 组合根 / 鉴权挂载 | `src/server.ts` |
| 会话 HTTP | `src/server-session-routes.ts`、`src/session-transport.ts` |
| 两套 runner | `src/process-manager.ts`、`src/structured-session-manager.ts` |
| structured 字节流 / 恢复 | `src/structured-exec-pump.ts`、`src/structured-exec-host.ts`、`src/terminal-daemon-server.ts` |
| WS | `src/ws-broadcast.ts`、`src/web-ui/browser/websocket.ts` |
| 任务聚合 | `src/server-workspace-routes.ts`、`src/web-ui/react/workspaces/` |
| 议题看板 | `src/server-task-routes.ts`、`src/web-ui/react/issues/task-board-host.tsx` |
| GitHub | `src/github-connector.ts`、`src/web-ui/react/issues/host.tsx` |
| 文件 | `src/server-file-routes.ts`、`src/web-ui/react/code-editor/` |
| 原生会话 | `*/ChatStore.*`、`*/WandSocket.*`、`*/WandAPI.*` |
