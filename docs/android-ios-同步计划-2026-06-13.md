# Android 同步 iOS 近期改动 — 计划与优先级

> 生成日期：2026-06-13
> 背景：iOS 端 6 月 13 日提交了 `e9c9e7b`（停止任务二次确认）与 `f0aaf23`（语音/输入框/性能等一组体验优化）。本计划对照 Android 端实现，找出可复用项并按优先级排序，等评审后再动手。
> 范围：`android/` 子模块（独立 git 仓库，本仓库只持有指针）。`ios/` 与 `android/` 是 `co0ontty/wand-ios`、`co0ontty/wand-android` 两个独立子仓库，子模块指针在主仓库里。

---

## 0. 一句话结论

iOS 这两个提交一共动了 8 个点。其中 **1 项已同步**（停止任务二次确认，Android 提交 `00a4640` 同步到位），**3 项可直接复用**到 Android（P0：断线提示条 / 发送后保持焦点；P1：语音按住阈值下调），**2 项已用更粗粒度方案覆盖**（语音预热、列表轮询），**2 项不适用**（iOS 端 NSFormatter 复用、QR 摄像头 deinit 兜底，对应 Android API 不存在该问题）。

按工作量从低到高，**P0 约 0.5 人天，P1 约 0.2 人天，整体可在 1 人天内闭环**。

---

## P0 — 必做（用户可感知，建议本迭代内）

### P0-1　聊天页断线提示条 ⭐ 最高优先

- **问题**：Android 端 `ChatStore.connected`（[ChatStore.kt:59](/vol1/1000/yolo-claude/wand/android/app/src/main/java/com/wand/app/ui/ChatStore.kt:59)）是 WebSocket 连接状态的唯一来源，由 `socket.onConnectionChange` 维护（[ChatStore.kt:101](/vol1/1000/yolo-claude/wand/android/app/src/main/java/com/wand/app/ui/ChatStore.kt:101)），但 **UI 层从无任何展示**。后台 Wand 重启 / 切到休眠网络 / 服务器维护期间，用户看到的是「上一条消息停留在屏幕上，毫无征兆」，只能干等或猜测是否需要手动刷新。
- **iOS 对应改动**（[ChatView.swift:128-148](/vol1/1000/yolo-claude/wand/ios/Wand/ChatView.swift:128)）：在聊天页顶部叠一条 `connectionBanner`，`!store.connected` 时显示红底 `wifi.slash` + 「连接已断开，正在重连…」，配套 0.2s easeInOut 动画。
- **证据（Android 侧）**：
  - `grep -rn "store.connected" app/src/main/java/` 无任何匹配，**确实没消费**。
  - `WandSocket.kt` 已具备指数退避重连（[WandSocket.kt:36](/vol1/1000/yolo-claude/wand/android/app/src/main/java/com/wand/app/data/WandSocket.kt:36) `reconnectDelayMs`、40s 看门狗）—— 状态真实可靠，可以直接展示。
- **动作**：
  1. 在 `ChatScreen.kt` 的 `Scaffold` 顶部加 `if (!store.connected) { … }` 渲染一条玻璃质感顶部条（与现有 `WandColors.danger` + `WandGlass.regular` 对齐）。
  2. 文本：「连接已断开，正在重连…」（与 iOS 文案一致）。
  3. 用 `AnimatedVisibility` + `slideInVertically` 做进出动画，0.2s 即可。
  4. 同样在 `SessionListScreen` 顶部加一条，避免「列表看着正常，点进去发现连不上」的挫败感。
- **风险**：低。纯展示层改动，不动 socket 状态机；`connected` 默认值是 `true`，未触发重连前不会闪烁。
- **收益**：消除「无响应 = 卡死」的误判；与 iOS 体验对齐；为后续把断线时的禁用发送/重发队列等行为打底。

### P0-2　发送后主动保持输入框焦点

- **问题**：Android 端输入框在 `permission card` / `todo progress bar` 插入或移除时，`FocusRequester` 会丢焦点、键盘收起；用户连续发消息时每发一条都得再点一次输入框，iOS 已修（[ChatView.swift:678-686](/vol1/1000/yolo-claude/wand/ios/Wand/ChatView.swift:678)），Android 端 `onSend` 回调（[ChatScreen.kt:343-348](/vol1/1000/yolo-claude/wand/android/app/src/main/java/com/wand/app/ui/screens/ChatScreen.kt:343)）清空 draft + 贴底后**没有再聚焦**。
- **证据（Android 侧）**：
  - `InputBar` 内已存在 `focusRequester`（[ChatScreen.kt:1055](/vol1/1000/yolo-claude/wand/android/app/src/main/java/com/wand/app/ui/screens/ChatScreen.kt:1055)），但只在 `voiceMode → false` 退出时拉一次焦点（[ChatScreen.kt:1059-1064](/vol1/1000/yolo-claude/wand/android/app/src/main/java/com/wand/app/ui/screens/ChatScreen.kt:1059)）。
  - `onSend` lambda（[ChatScreen.kt:343](/vol1/1000/yolo-claude/wand/android/app/src/main/java/com/wand/app/ui/screens/ChatScreen.kt:343)）只 `draft = ""` + `followsLatest = true` + `store.send(text)`。
- **动作**：
  1. 在 `InputBar` 内部定义 `var refocusAfterSend by remember { mutableStateOf(false) }`。
  2. 把 `onSend` 改为 `() -> Unit` 同时新增参数 `onRequestRefocus: () -> Unit`；发送后调用方把 `refocusAfterSend = true`。
  3. `LaunchedEffect(refocusAfterSend, voiceMode, store.sessionEnded)`：`refocusAfterSend == true && !voiceMode && !store.sessionEnded` 时 `focusRequester.requestFocus()` 并复位。
- **风险**：低。`runCatching` 包裹 `requestFocus()` 即可，焦点请求失败不致命。
- **收益**：连续对话体验对齐 iOS；输入药丸/权限卡/todo bar 的插入不再让键盘闪烁。

---

## P1 — 建议（细节体验，低风险）

### P1-1　语音按住阈值 300ms → 180ms

- **问题**：iOS 把「轻点 vs 长按」分界从 0.3s 调到 0.18s（[ChatView.swift:780-781](/vol1/1000/yolo-claude/wand/ios/Wand/ChatView.swift:780)），Android 仍是 `private const val VOICE_HOLD_THRESHOLD_MS = 300L`（[ChatScreen.kt:1258](/vol1/1000/yolo-claude/wand/android/app/src/main/java/com/wand/app/ui/screens/ChatScreen.kt:1258)）。
- **动作**：常量改为 `180L`，并在常量上方留一行说明为何选 0.18s（与 iOS 同款理由）。仅改 1 行，附 comment。
- **风险**：极低。识别框出现更快、用户感知的「按下去没反应」窗口更短；误判为「轻点」的概率在 0.18s 仍可忽略。
- **收益**：与 iOS 行为对齐；用户能更快进入录音。

---

## P2 — 可选锦上添花

### P2-1　会话列表轮询与可见性联动

- **现状**：`SessionListScreen` 顶部一个 `LaunchedEffect(Unit) { while (true) { delay(10_000); state.load(...) } }`（[SessionListScreen.kt:192-198](/vol1/1000/yolo-claude/wand/android/app/src/main/java/com/wand/app/ui/screens/SessionListScreen.kt:192)）。
- **iOS 做法**：用 `listVisible` 状态（`onAppear` / `onDisappear` 切换），仅在可见时才跑 10s 轮询。
- **Android 现状行为**：`nav.push(Screen.Chat(...))` 时 `SessionListScreen` 离开 composition，`LaunchedEffect(Unit)` 协程被 cancel；返回时重新 composition 又会 restart → 重新跑一次完整 `state.load`。比 iOS 多了一次「回列表即重拉」的开销。
- **可选项 A（与 iOS 完全对齐）**：把轮询提升到 `ReadyContent`（WandApp.kt:128 那个永驻 composable），用 `derivedStateOf` / `nav.current is Screen.SessionList` 判定是否在列表页，仅在 true 时跑轮询。
- **可选项 B（接受现状）**：保持现状，依赖 composition 生命周期自然 cancel；记录这一点为「已知行为」，未来真要压电再回头改。
- **风险**：A 改动需小心 `listState.remember` 边界（`SessionListState` 当前在 `ReadyContent` 已 hoist，OK），但要确认 chat 页回到列表页时 `lazyListState` 滚动位置仍能保留（[WandApp.kt:131](/vol1/1000/yolo-claude/wand/android/app/src/main/java/com/wand/app/ui/WandApp.kt:131) 已 hoist `listState`，不丢滚动位置）。
- **建议**：**先 B 留着**，与 P0/P1 一起回归；如果后续电量/流量 profiling 暴露明显浪费，再走 A。

---

## 不适用项 — 已在 Android 等价处理或平台层无此问题

| iOS 改动 | Android 状态 | 说明 |
|---|---|---|
| 语音识别预热（`speech.prewarm()` on 切语音模式） | **已覆盖** | `VoiceInputController` 构造时（[VoiceInputController.kt:50-52](/vol1/1000/yolo-claude/wand/android/app/src/main/java/com/wand/app/speech/VoiceInputController.kt:50)）就调用 `SherpaSpeechEngine.warmUp(context)`，粒度比 iOS 略粗（进聊天页即热），但效果等价。 |
| QR Scanner 摄像头 deinit 兜底 | **不适用** | Android 用 `BarcodeView` + `Activity` 生命周期，`onResume`/`onPause` 已正确管理；iOS 的 `UIViewControllerRepresentable` + `viewWillDisappear` 极端时序问题在 Android 不存在。 |
| `ISO8601DateFormatter` / `RelativeDateTimeFormatter` 静态缓存 | **不适用** | Android 用 `DateUtils.getRelativeTimeSpanString`（[SessionListScreen.kt:822-833](/vol1/1000/yolo-claude/wand/android/app/src/main/java/com/wand/app/ui/screens/SessionListScreen.kt:822)），系统 API 无构造开销，iOS 那种 `NSFormatter` 复用诉求在 Android 不存在。 |

---

## 验证

按 `AGENTS.md` 的「Validation Guidelines」做：

1. `npm run check` 在主仓库通过（本次计划只动 android 子模块，不影响主仓库 TS；提醒：android 子模块自检走 `./gradlew :app:assembleDebug`）。
2. 用 `/tmp/wand-dev/config.json` + 模拟器跑通：登录 → 会话列表 → 新建/进入会话 → 触发断线（`kill` 服务器进程）→ 看 P0-1 banner；连续发 2 条消息验证 P0-2 焦点不丢；按住麦克风验证 P1-1 识别更跟手。
3. 截屏存到 `docs/screenshots/android-sync-from-ios-2026-06-13/`（按需新建子目录），方便评审回看。
4. 提交规范：按主仓库 `Commit & Pull Request Guidelines` 用中文祈使句，先在 android 子仓库 commit + push，再回主仓库 bump 子模块指针。

---

## 待确认 / 评审要点

- [ ] P0-1 的文案「连接已断开，正在重连…」是否需要本地化（与 i18n 字典对齐）？当前 iOS 是硬编码中文。
- [ ] P0-1 在 `SessionListScreen` 是否也加一条，还是只在 `ChatScreen` 加？建议两处都加。
- [ ] P0-2 的「发送后聚焦」是否要在 `sessionEnded == true` 时禁用？（iOS 行为是禁用；建议对齐。）
- [ ] P1-1 的 0.18s 在老款/低端 Android 设备上是否仍有足够容错？建议先小流量灰度或保留 0.22s 折中。
- [ ] P2 是否要本迭代做？默认按 P2 跳过。
