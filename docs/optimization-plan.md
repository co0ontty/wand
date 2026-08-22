# Wand 跨端优化计划

依据 `docs/server-logic-analysis.md` 与 `docs/client-logic-analysis.md`。服务端 P0–P3 契约修复已完成；本计划只处理**还在伤用户、或明显拖慢/分叉**的部分。

**状态（2026-08-22）：切片 1–5 已落地并验收。** Android beta APK `4.44.0-debug.08221242` 已分发到 `~/.wand/android/`。

原则：先对齐输入与 DTO（用户能感知），再削轮询/重绘（性能），最后补产品缺口。不合并两套 runner，不在 PTY bridge 里伪造 tool block。

---

## 现状（不再列入）

- 会话 DTO 已带 `workspaceId` / `workspaceTaskId` / `queuedMessageSkills` / `titleGenerating` / `providerSessionId`
- 密码库 at-rest 加密、扩展 `serverUrl`、WS Bearer、scope 名单、file-search cwd、APK 默认通道
- Inbox HTTP/CLI 已接线；Web 侧栏「任务」仍是 Missions，不是 inbox

---

## 切片 1 — PTY 输入契约（优先，正确性）

**问题：** 服务端与 Web / iOS PTY 页 / Android PTY 页约定「文本 + 单独 `\r` + `shortcutKey=enter_text`」。仍有旧路径发 `text+"\n"`：

| 位置 | 现状 |
| --- | --- |
| Android `ChatStore.send` | PTY 分支 `trimmed + "\n"`，`view=chat` |
| iOS AskUser 在 PTY 上提交 | `answerText + "\n"` |
| macOS `ChatStore.send` PTY 聊天 | 同样 `\n` |

Android 聊天页名义上只开 structured，这条多半是死代码，但 AskUser / 误入 PTY 仍会「回车没提交」。

**做法：**

1. 抽/复用各端已有 helper（iOS `ptyInputSubmission`、Web `getTerminalSubmitChunks`）。
2. 所有「用户提交一行」走两包：文本 → 30ms → `\r` + `enter_text`。
3. AskUser 在 PTY 上同样走两包，不要 `\n`。
4. Android `ChatStore.send` 的 else 分支：要么删掉（聊天只 structured），要么改成与 `PtyTerminalScreen` 相同。
5. 单测：iOS `PtyInputProtocol`、Android `ChatStore` / reducer、macOS 对应测试。

**验收：** 任意端聊天或 AskUser 提交 PTY，服务端收到的是两段 input，而不是带 `\n` 的一条。

**触及：**  
`android/.../ChatStore.kt`、`ios/Wand/ChatStore.swift`、`macos/Wand/ChatStore.swift`、相关 test。

---

## 切片 2 — 原生 DTO / 发送语义对齐

**问题：** 服务端已出的字段，macOS 模型没解析；iOS/Android 发送后处理不一致。

| 缺口 | 影响 |
| --- | --- |
| macOS `SessionSnapshot` 无 `title` / `description` / `titleGenerating` / `workspaceId` / `workspaceTaskId` | 标题不闪、聊天顶栏绑不上任务 |
| Android structured 发送后不 `apply(202)`、不 `requestResync` | WS 丢首帧时卡在乐观 loading |
| macOS 两包 input 都解码整份 snapshot | 比 iOS `responseMode=accepted` 重 |
| iOS `isResponding` 含 PTY running；Android/macOS 只看 `inFlight` | 输入栏转圈语义不一致 |
| Android 建 structured 时 qoder/pi 不传 `runner` | 依赖服务端默认，和 iOS 不对称 |

**做法：**

1. macOS `WandModels.swift` 补字段；`displayTitle` 跟 iOS 一样用服务端 title。
2. Android structured send 对齐 iOS：apply 202 + `socket.requestResync()`。
3. macOS PTY 第二包改 `responseMode=accepted`（或专用 chunk API）。
4. 统一 `isResponding`：structured = `inFlight`；PTY 聊天用 `providerCliActive` / status，不要混。
5. Android `WandApi` 创建时始终传 `structuredRunner`（含 qoder/pi）。

**验收：** 三端同一会话标题一致；structured 发送后断 WS 再连，不会永久「回复中」。

**触及：**  
`macos/Wand/WandModels.swift`、`macos/Wand/ChatStore.swift`、`android/.../ChatStore.kt`、`android/.../WandApi.kt`、`ios/Wand/WandModels.swift`（只核对，少改）。

---

## 切片 3 — 列表与实时性能

**问题：** 多端叠加重刷。

- Web：WS 活着仍在部分路径 `loadSessions()`（`started`/`ended`）；`mergeServerSession` 每条比 output/messages 长度。
- iOS/Android/macOS：`GET /api/session-list` **每 10s 全量轮询**，即使 revision 没变。
- Android 另有未订阅全局 WS（`SessionWatcher`）再刷通知。
- Web 分屏才 `mode:add`；原生永远单订阅，切会话就整表换。

**做法（由轻到重）：**

1. 原生列表：若 `revision` 未变，10s 轮询只打 `?offset=0&limit=1&revision=` 或加 `HEAD`/`If-None-Match`；不变则不重绘。现有 409 语义可复用。
2. Web：`started`/`ended` 只补那一条，不要每次 `GET /api/sessions` 全量。
3. `mergeServerSession`：列表 slim 已无 messages/output，缩短合并分支；详情合并与列表分开。
4. 不做原生 `mode:add` 多订阅（分屏是 Web 专属），避免扩大协议面。

**验收：** 空闲时原生 10s 一轮若无变更，不触发列表 diff/重组；Web 新建会话不再整表闪一下。

**触及：**  
`ios/Wand/SessionListStore.swift`、Android 列表 store、`src/web-ui/browser/session-engine.ts`、`websocket.ts`、可选 `GET /api/session-list` 加弱 ETag。

---

## 切片 4 — 权限与更新对用户说实话

**问题：**

- iOS 对 structured 仍打 `POST .../escalations/:id/resolve`，服务端已 404。
- 原生用 connected-app，点「更新服务端」会 403，横幅却还在。
- Structured 重启后有 `lastError=服务重启，上一轮已中断`，客户端未必展示。

**做法：**

1. 原生：`sessionKind==structured` 不画 PTY 批准条、不打 escalation。
2. 服务端更新横幅：connected-app 只提示「请在网页/本机终端更新」，或干脆不展示 install 按钮。
3. 三端 structured `lastError` 展示一条可关闭的中断提示（队列还在可继续发）。

**触及：**  
iOS/Android/macOS ChatStore UI、`GET /api/config` 的 `canManageSettings`（已有）驱动按钮显隐。

---

## 切片 5 — 产品缺口（可选，单独排期）

按需做，不阻塞 1–4。

| 项 | 说明 |
| --- | --- |
| Web inbox | 侧栏「任务」仍是 Missions；若要收件箱，单独入口打 `GET /api/inbox` |
| Android 工作空间 | 补建项目、worktree 总览、合并（对齐 iOS，不要另起交互） |
| 工作空间「+」开 structured | 现在 `startSessionInCwd` 只 `POST /api/commands`（PTY） |
| 文档 | 旧 `CLAUDE.md` 写的 macOS 纯 WebView 表述已随文件删除移除；壳结构以 `MainShellView` 为准 |

---

## 明确不做

- 合并 PTY / structured runner
- 在 Claude PTY 刮字结果上合成假 `tool_use`
- 为原生做 Web 同款分屏 `mode:add`
- 改 schema 删 `resumed_to_session_id` / 重命名 `claudeSessionId` 列
- iOS 应用内装包更新（系统限制）

---

## 建议实施顺序

```
切片 1（PTY 回车） → 切片 2（DTO/202） → 切片 4（权限/更新文案） → 切片 3（轮询） → 切片 5
```

1 和 2 可平行（Android 输入 vs macOS 模型几乎不撞文件）。3 动列表热路径，放在契约稳定之后。

每片验收：

- 服务端 / 共享 TS：`npm test` 里相关文件 + `npx tsc --noEmit -p tsconfig.json`
- Android：改 Kotlin 后按仓库规则出 beta APK（除非用户说跳过）
- iOS / macOS：模拟器或真机走一遍发送、标题、权限条

---

## 关键文件

| 切片 | 文件 |
| --- | --- |
| 1 | `android/.../ui/ChatStore.kt`、`ios/Wand/ChatStore.swift`、`ios/Wand/PtyInputProtocol.swift`、`macos/Wand/ChatStore.swift` |
| 2 | `macos/Wand/WandModels.swift`、`android/.../data/WandApi.kt`、`android/.../ui/ChatStore.kt` |
| 3 | `ios/Wand/SessionListStore.swift`、Android 列表 store、`src/web-ui/browser/session-engine.ts`、`websocket.ts` |
| 4 | 各端权限 UI、`src/web-ui/react/settings`、`GET /api/config` 的 `canManageSettings` |
| 5 | `src/web-ui/react/missions`、`android/.../workspaces/`、`AGENTS.md` |
