import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function includesAll(relativePath: string, contracts: ReadonlyArray<string>): void {
  const contents = source(relativePath);
  for (const contract of contracts) {
    assert.ok(
      contents.includes(contract),
      `${relativePath} must preserve native WebView contract: ${contract}`,
    );
  }
}

function assertOrdered(relativePath: string, before: string, after: string): void {
  const contents = source(relativePath);
  const beforeIndex = contents.indexOf(before);
  const afterIndex = contents.indexOf(after);
  assert.ok(
    beforeIndex >= 0 && afterIndex > beforeIndex,
    `${relativePath} must preserve native WebView ordering: ${before} before ${after}`,
  );
}

test("web entry preserves native URL, viewport, and global bridge contracts", () => {
  includesAll("src/web-ui/index.ts", [
    "viewport-fit=cover",
    "interactive-widget=resizes-content",
  ]);
  includesAll("src/web-ui/browser/state.ts", [
    'url.searchParams.get("session")',
    'url.searchParams.delete("session")',
  ]);
  includesAll("src/web-ui/browser/main.ts", [
    "/WandApp\\//",
    "/WandPlatform\\/iOS/",
    "/WandPlatform\\/Android/",
    'params.get("embed") === "terminal"',
    'params.get("nativeInput") === "1"',
    'params.get("passthrough") === "1"',
    "__wandNativeBackHooked",
  ]);
  includesAll("src/web-ui/browser/notifications.ts", ["handleNativeBack"]);
  includesAll("src/web-ui/react/settings/repository.ts", ["_onNativePermissionResult"]);
});

test("web source preserves native events, safe-area variables, and selector hooks", () => {
  includesAll("src/web-ui/browser/render.ts", [
    "wand-android-resume",
    "wand-android-network",
    "wand-ime-state",
    'id="output"',
    'id="terminal-scale-down-top"',
    'id="terminal-scale-label-top"',
    'id="terminal-scale-up-top"',
    'id="page-refresh-btn"',
  ]);
  includesAll("src/web-ui/browser/viewport.ts", [
    "wand-ios-ime-state",
    "--app-viewport-top",
    "--app-viewport-height",
  ]);
  includesAll("src/web-ui/browser/input.ts", [
    "shouldLockNativeInputTerminalIme",
    "lockNativeInputTerminalIme",
    "installNativeInputImeGuard",
    "is-wand-native-input",
    "is-wand-terminal-passthrough",
  ]);
  includesAll("src/web-ui/content/styles.css", [
    "--app-inset-top",
    "--app-inset-bottom",
    "--app-inset-left",
    "--app-inset-right",
    "--wand-safe-top",
    "--wand-safe-bottom",
    "--wand-safe-left",
    "--wand-safe-right",
    ".is-wand-app-native-insets",
    ".is-wand-embed-terminal :is(",
    ".file-side-panel, .file-panel-backdrop",
    ".is-wand-embed-terminal .terminal-scroll-wrap",
    ".is-wand-embed-terminal.is-wand-native-input .input-panel",
    ".terminal-container { background: var(--bg-terminal",
  ]);
});

test("Android native terminal consumes Render snapshots over the PTY websocket", () => {
  const screen = "android/app/src/main/java/com/wand/app/ui/screens/PtyTerminalScreen.kt";
  const terminal = "android/app/src/main/java/com/wand/app/ui/terminal/NativePtyTerminal.kt";
  const socket = "android/app/src/main/java/com/wand/app/data/WandSocket.kt";
  includesAll(screen, [
    // 参数名从 onTap 改成 onTerminalTap、行为改成直接拉起键盘（安卓直连输入那批改动）；
    // 契约本身（可点 → 进输入路径）没变，这里跟着新 API 断言。
    "NativePtyTerminalSurface(",
    "onTerminalTap = { requestDirectKeyboard() }",
    'ptyComposerSubmitChunks(text, "terminal")',
  ]);
  includesAll(terminal, [
    "TerminalEmulatorFactory.create(",
    // 点终端 → 交给调用方（安卓直连输入那批：拉起键盘而不是打开输入抽屉）。
    "onTerminalTap = onTerminalTap,",
    // 字号/字体现在是可缩放 + 资产字体（appica 终端重构），不再是写死的 14sp：
    // 断言「参数化了 + 走统一 typeface 工厂」，而不是旧字面量。
    "initialFontSize = fontSize,",
    "val typeface = remember { terminalTypeface(context.assets) }",
    "replayTerminalSnapshot(emulator, data.terminalState, data.output, data.ptyCols, data.ptyRows)",
    // 输出帧必须同步写进 emulator 后才 ACK；变量名从 it 改成 chunk 只是写法调整。
    "emulator.writeInput(chunk.toByteArray(Charsets.UTF_8))",
    "socket.acknowledgePty(event.ptyBytes ?: 0)",
  ]);
  // 字体回退链在 TerminalAppearance.kt：资产字体优先、系统 mono 兜底。
  includesAll("android/app/src/main/java/com/wand/app/ui/terminal/TerminalAppearance.kt", [
    "Typeface.CustomFallbackBuilder(FontFamily.Builder(font).build())",
    '"sans-serif"',
    "Typeface.MONOSPACE",
  ]);
  includesAll(socket, [
    '.put("ptyAck", ptyAck)',
    '.put("type", "pty_input")',
    '.put("type", "pty_resize")',
    '.put("type", "pty_ack")',
    '"resync_required" -> {',
    "requestResync()",
  ]);
  assertOrdered(terminal, "replayTerminalSnapshot(", "socket.acknowledgePty(event.ptyBytes ?: 0)");
  assert.ok(!source(screen).includes("WebView"), "Android PTY must not mount WebView");
});

test("Apple clients preserve native terminal, IME, replay and transport contracts", () => {
  includesAll("ios/Wand/NativeTerminal.swift", [
    "import SwiftTerm",
    "TerminalView, TerminalViewDelegate",
    "data.terminalState?.isReplayable != false",
    "terminal.resize(cols: cols, rows: rows)",
    "guard !restoring, !suppressingInput",
    "buildTerminalPasteSequence(text, bracketed: bracketed)",
    "func clipboardRead(source: TerminalView) -> Data? { nil }",
    "socket.subscribe(sessionId: sessionId, ptyAck: true)",
    "socket.acknowledgePty(bytes: event.ptyBytes ?? 0)",
  ]);
  includesAll("ios/Wand/WandSocket.swift", [
    "WandEndpoint.webSocketURL(baseURL: baseURL)",
    '"capabilities": ["ptyAck": ptyAck]',
    '"type": "pty_input"',
    '"type": "pty_resize"',
    '"type": "pty_ack"',
    'case "resync_required":',
    "awaitingSnapshot",
    "gen == self.generation",
    "sendQueue.removeAll()",
    "task?.cancel(with: .goingAway, reason: nil)",
  ]);
  includesAll("ios/Wand/PtyInputProtocol.swift", [
    'PtyInputChunk(input: text, view: view, shortcutKey: "enter_text")',
    'PtyInputChunk(input: "\\r", view: view, shortcutKey: "enter_text")',
  ]);
  assert.doesNotMatch(source("ios/Wand/SessionDestinationView.swift"), /WebContainerView|terminalWebModel|evaluateJavaScript/);
  assertOrdered("ios/Wand/NativeTerminal.swift", "terminal.feedOutput(text)", "socket.acknowledgePty(bytes:");
  includesAll("ios/Wand/NativeComposer.swift", [
    "IMEAwareComposerTextView",
    "markedTextRange",
    "composerShouldApplyExternalText",
    "composerShouldSubmitReturn",
    "composerDraftIsSendable",
  ]);
  includesAll("ios/Wand/ChatView.swift", [
    "IMEAwareComposerTextView",
    "composerIsComposing",
  ]);
  includesAll("ios/Wand/SessionDestinationView.swift", [
    "IMEAwareComposerTextView",
    "composerIsComposing",
    "terminal.terminal.blurTerminal()",
    "NativeTerminalSurface",
  ]);
  includesAll("macos/Wand/NativeTerminalView.swift", [
    "import SwiftTerm",
    "TerminalView, TerminalViewDelegate",
    "terminal.resize(cols: cols, rows: rows)",
    "func clipboardRead(source: TerminalView) -> Data? { nil }",
  ]);
  includesAll("macos/Wand/PtyTerminalStore.swift", [
    "PtyTerminalSnapshot",
    "socket.subscribe(sessionId: sessionId, ptyAck: true)",
    "terminal.restore(data)",
    "terminal.feedOutput(chunk)",
    "socket.acknowledgePty(bytes: event.ptyBytes ?? 0)",
  ]);
  includesAll("macos/Wand/WandSocket.swift", [
    '"type": "pty_input"',
    '"type": "pty_resize"',
    '"type": "pty_ack"',
    'payload["shortcutKey"] = "enter_text"',
  ]);
  includesAll("macos/Wand/MainShellView.swift", [
    "if session?.isStructured == false",
    "SessionHeaderView(",
    "PtySessionView(sessionId: sessionId, api: api)",
  ]);
  includesAll("macos/Wand/ChatView.swift", [
    "NativeTerminalSurface(terminal: store.terminal)",
    "store.terminal.clearScrollback()",
    "IMEAwareComposerTextView",
    "doCommandBy commandSelector",
    "textView.hasMarkedText()",
    "textView.unmarkText()",
    "composerIsComposing",
  ]);
  assert.doesNotMatch(source("macos/Wand/ChatView.swift"), /WebContainerView|terminalWebModel|evaluateJavaScript/);
});

test("task board create sheets only assign agents from the doing column", () => {
  // 语义：待办列的新建只创建任务；进行中列的新建创建后立刻派 Agent。
  // 三端 + Web 必须一致，否则同一个面板在不同端会做出不同的事。
  includesAll("android/app/src/main/java/com/wand/app/ui/screens/TaskBoardScreen.kt", [
    'internal fun boardCreateDispatches(status: String): Boolean = status == "doing"',
    "onCreateForStatus: (String) -> Unit",
    'BoardSectionHeader(',
    'onAdd = onCreateForStatus,',
    "contentDescription = boardGroupAddTaskDescription(status)",
  ]);
  includesAll("android/app/src/main/java/com/wand/app/ui/screens/CreateBoardTaskDialog.kt", [
    "initialStatus: String",
    "var status by remember { mutableStateOf(initialStatus) }",
    "val dispatches = boardCreateDispatches(status)",
    "else boardCreateActionLabel(teamTarget != null, dispatches, description.trim().isNotEmpty(),",
    "else title.isNotBlank() || description.isNotBlank()",
    "只创建任务，稍后再开始",
    "WandFormDialog(",
    "WorkspaceDirectoryPicker(",
  ]);
  // 派工门槛：两个条件都得成立，且必须是 `&&`。Kotlin 把这条 if 写成多行（teamId/retriedTaskId
  // 在第一行，boardCreateDispatches/description 在第二行），所以断言只容忍换行与缩进，不容忍语义变化。
  assert.match(
    source("android/app/src/main/java/com/wand/app/ui/screens/TaskBoardScreen.kt"),
    /if \([\s\S]{0,80}?boardCreateDispatches\(status\)\s*&&\s*description\.isNotBlank\(\)\s*\)\s*\{/,
    "android/app/src/main/java/com/wand/app/ui/screens/TaskBoardScreen.kt must preserve native WebView contract:" +
      " if (boardCreateDispatches(status) && description.isNotBlank())",
  );
  // 分组＋的可访问性文案已抽成纯函数；按钮必须调用它，避免退回无引号的歧义读法。
  includesAll("android/app/src/main/java/com/wand/app/ui/screens/TaskBoardPresentation.kt", [
    'internal fun boardGroupAddTaskDescription(status: String): String =',
    '"在「${boardTaskStatusLabel(status)}」中新建任务"',
  ]);
  // 主按钮文案已抽成纯函数 boardCreateActionLabel（子仓库 23ee050），断言跟着搬到它的真源：
  // 只有「进行中」列 + 描述非空才写「创建并指派」，其余一律「创建任务」。
  includesAll("android/app/src/main/java/com/wand/app/ui/screens/TaskBoardPresentation.kt", [
    'busy -> "创建中…"',
    '!teamSelected && dispatches && hasDescription -> "创建并指派"',
    'else -> "创建任务"',
  ]);
  assert.doesNotMatch(
    source("android/app/src/main/java/com/wand/app/ui/screens/TaskBoardScreen.kt"),
    /if \(description\.isNotBlank\(\)\) \{\s*runCatching \{ api\.dispatchBoardTask/,
    "Android must not dispatch on create from every column",
  );

  includesAll("ios/Wand/TaskBoardView.swift", [
    'func wandBoardCreateDispatches(status: String) -> Bool { status == "doing" }',
    "initialStatus: String = \"todo\"",
    "_status = State(initialValue: initialStatus)",
    "private var dispatches: Bool { wandBoardCreateDispatches(status: status) }",
    "if wandBoardCreateDispatches(status: status),",
    "private func openCreate(_ status: String)",
    "openCreate(status)",
    "dispatches && !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? \"创建并指派\" : \"创建任务\"",
    "描述（只创建任务）",
  ]);
  assert.equal(
    (source("ios/Wand/TaskBoardView.swift").match(/if !description\.trimmingCharacters\(in: \.whitespacesAndNewlines\)\.isEmpty \{/g) ?? []).length,
    0,
    "iOS must not dispatch on create from every column",
  );

  // macOS 4.72 把新建面板拆成 TaskBoardCreateView，派发判定下沉到 TaskBoardModels。
  includesAll("macos/Wand/TaskBoardModels.swift", [
    'func wandBoardCreateDispatches(status: String) -> Bool { status == WandBoardStatus.doing.rawValue }',
  ]);
  includesAll("macos/Wand/TaskBoardCreateView.swift", [
    "initialStatus: String = WandBoardStatus.todo.rawValue",
    "initial.status = initialStatus",
    "private var dispatches: Bool { wandBoardCreateDispatches(status: draft.status) }",
    "private var hasDescription: Bool {",
    "!draft.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty",
    '(dispatches && hasDescription ? "创建并指派" : "创建任务")',
    "添加描述…（只创建任务，不指派 Agent）",
  ]);
  includesAll("macos/Wand/TaskBoardView.swift", [
    "private func openCreate(_ status: String)",
    "initialStatus: createStatus,",
    "if wandBoardCreateDispatches(status: draft.status) && !prompt.isEmpty {",
  ]);
  assert.equal(
    (source("macos/Wand/TaskBoardCreateView.swift").match(/if !draft\.description\.trimmingCharacters\(in: \.whitespacesAndNewlines\)\.isEmpty \{/g) ?? []).length,
    0,
    "macOS must not dispatch on create from every column",
  );
});

test("subagent execution surfaces stay compact, avatar-free, and follow the newest content", () => {
  includesAll("src/web-ui/browser/chat-render.ts", [
    'class="agent-run-summary"',
    'aria-expanded="\' + (expanded ? "true" : "false") + \'"',
    'data-status="\' + summary.status + \'"',
    "var expanded = shouldAgentRunStartExpanded(summary.status, persisted);",
    'class="agent-run-rail"',
    'class="agent-run-agent',
    'class="agent-run-detail-panel',
    'class="agent-run-result',
    "renderAgentRunAgentBody(agent, agentStatus, activity, role, toolResults, messageKey)",
    'class="agent-run-process"',
    'class="agent-run-body-inner"',
    'class="agent-run-receipt"',
    "role=\"tabpanel\"",
    'onkeydown="__agentRunSelect(event, this)"',
    'aria-controls="\' + escapeHtml(panelId) + \'"',
    // 类型小字与身份色都要「能区分才算数」：整卡同类型的 general-purpose
    // 不许每行重复，一卡之内也不许两个 Agent 撞同一个颜色。
    "function agentRunTypesCarryInfo(run)",
    "var rowType = showType && agentType && agentType !== typeChip ? agentType : \"\";",
    "taken.indexOf(other)",
    "for (var shift = 0; shift < n && taken.indexOf(slot) >= 0; shift++) slot = (slot + 1) % n;",
  ]);
  includesAll("src/web-ui/browser/events.ts", [
    "(window as any).__agentRunToggle",
    '(window as any).__agentRunSelect',
    'applyExpandedState(run, "agent-run", expanded)',
    'persistElementExpandState(run, "agent-run")',
    "setPersistedAgentSelection(runId, taskId)",
    "ArrowLeft",
    "ArrowRight",
  ]);
  includesAll("src/web-ui/browser/chat-scroll.ts", [
    'case "agent-run":',
    "AGENT_RUN_SELECTION_STORAGE_KEY",
    "export function getPersistedAgentSelection",
    "export function setPersistedAgentSelection",
  ]);
  includesAll("src/web-ui/react/chat/presentation.tsx", [
    'projection.kind === "agent"',
    'projection.kind === "agent-rail"',
    'projection.kind === "agent-process"',
    'projection.kind === "agent-timeline"',
    '<Card size="small"',
    '<Collapse size="small"',
    '<Timeline items=',
    'destroyOnHidden={false}',
    'classNames={{ header: "agent-run-process-summary" }}',
    'seed.style.getPropertyValue("--agent-color")',
    '.agent-run-body[aria-hidden="true"]',
  ]);
  assert.doesNotMatch(
    source("src/web-ui/browser/chat-render.ts"),
    /\.subagent-panel|\.subagent-reply|multi-agent/,
    "Web subagent rendering must not fall back to the legacy multi-role bubble",
  );
  assert.doesNotMatch(
    source("src/web-ui/content/styles.css"),
    /\.subagent-panel|\.subagent-reply|\.chat-message-segment/,
    "Web subagent styling must not keep legacy subagent chrome",
  );
  assert.doesNotMatch(
    source("src/web-ui/react/chat/presentation.tsx"),
    /\.agent-run-body\s*\{[^}]*height:\s*\d+px/s,
    "Web Agent Run body stays in the conversation flow instead of a fixed-height nested scroller",
  );
  assert.doesNotMatch(
    source("src/web-ui/react/chat/presentation.tsx"),
    /status === "running" \? "loading"/,
    "Tool timeline rows must not spin: the compact summary owns the only running mark",
  );
  assert.match(
    source("src/web-ui/react/chat/presentation.tsx"),
    /\.chat-activity\.is-command-running \.chat-process-summary-dot[\s\S]{0,320}?color:var\(--accent\)/,
    "The compact summary keeps its running mark whether or not the timeline is expanded",
  );
  assert.doesNotMatch(
    source("src/web-ui/react/chat/presentation.tsx"),
    /icon=\{live \? <Spin/,
    "The running mark is the business nine-dot mark, not a library spinner",
  );
  // Disclosure, keyboard state, selected identity, reading geometry and reduced
  // motion are exercised with production Ant components by antd-chat-browser.
  // A retired hand-maintained grid animation is not the observable contract.

  includesAll("ios/Wand/ChatView.swift", [
    "private let subagentWindowContentHeight: CGFloat = 280",
    "ScrollViewReader { proxy in",
    "subagentTailRefreshToken(items)",
    "proxy.scrollTo(tailAnchorID, anchor: .bottom)",
  ]);
  assert.ok(
    !source("ios/Wand/ChatView.swift").includes("avatar(running: running(items))"),
    "iOS subagent window must not keep the detached left avatar",
  );

  includesAll("android/app/src/main/java/com/wand/app/ui/screens/ChatBlocks.kt", [
    "collectSubagentActivities",
    "SubagentActivityDock",
    "AgentBubbleRail",
    "SubcomposeLayout",
    "StackedAgentCluster",
    "GeneratedAgentLogo",
    "agentLogoVariant",
    "Agent:",
    "WandIcons.agent",
    "Brush.linearGradient",
    "正在运行",
    "HorizontalPager",
    "key = { page -> activities.getOrNull(page)?.id",
    "pagerState.settledPage",
    "val motionEnabled = !reduceMotionEnabled()",
    "segmentScope = \"sub-${activity.id}\"",
    "showSubagentTags = false",
    "snapshotFlow { scrollState.maxValue }",
    "LaunchedEffect(refreshToken)",
    "scrollState.scrollTo(maxValue)",
    "SubagentActivityPage(activity)",
  ]);
  includesAll("android/app/src/main/java/com/wand/app/ui/screens/ChatScreen.kt", [
    "showActivityDock",
    "SubagentActivityDock(",
    ".align(Alignment.BottomCenter)",
  ]);

  includesAll("macos/Wand/ChatView.swift", [
    "splitAssistantContentBySubagent(turn.content)",
    "private let subagentWindowContentHeight: CGFloat = 280",
    "subagentTailRefreshToken(items)",
    "proxy.scrollTo(tailAnchorID, anchor: .bottom)",
  ]);
});

// 怪点 8 的 background 分支同类残留：展开一条派发回执时，「后台运行中」原本
// 在摘要行与回执块头部各说一次。状态词归摘要行，回执头部只留图标 + 说明。
// 这是**双端**契约，两端必须同批改，所以断言也放在同一处。
test("receipt headers carry icon + note, not a second status word", () => {
  const fnBody = (file: string, head: string, next: string): string => {
    const text = source(file);
    const start = text.indexOf(head);
    assert.ok(start >= 0, `${file} must define ${head}`);
    const end = text.indexOf(next, start + head.length);
    return end > start ? text.slice(start, end) : text.slice(start);
  };

  const webReceipt = fnBody(
    "src/web-ui/browser/chat-render.ts",
    "function renderAgentRunReceiptHtml(",
    "\n      function ",
  );
  assert.match(webReceipt, /agentRunStatusIcon\(/,
    "Web receipt header must keep its status icon");
  assert.match(webReceipt, /agentRun\.receipt\.note/,
    "Web receipt header must keep the dispatch-receipt note");
  assert.doesNotMatch(webReceipt, /agentRunStatusLabel\(/,
    "Web receipt header must not repeat the status word — the summary row owns it");
  // 反向保险：状态词不能两端一起丢，摘要行必须还在说它。
  assert.match(
    fnBody("src/web-ui/browser/chat-render.ts", "function renderAgentRunDetailHtml(", "\n      function "),
    /agentRunStatusLabel\(/,
    "Web summary/detail header must still render the status word",
  );

  const androidReceipt = fnBody(
    "android/app/src/main/java/com/wand/app/ui/screens/ChatBlocks.kt",
    "private fun SubagentReceiptSection(",
    "\n@Composable\n",
  );
  assert.match(androidReceipt, /SubagentStatusIcon\(SubagentStatus\.Background/,
    "Android receipt header must keep its status icon");
  assert.match(androidReceipt, /这只是派发回执，不是最终结论/,
    "Android receipt header must keep the dispatch-receipt note (same wording as Web zh)");
  assert.doesNotMatch(androidReceipt, /statusLabel/,
    "Android receipt header must not repeat the status word — the summary row owns it");
  assert.match(
    fnBody("android/app/src/main/java/com/wand/app/ui/screens/ChatBlocks.kt",
      "private fun SubagentSummaryRow(", "\n@Composable\n"),
    /statusLabel/,
    "Android summary row must still render the status word",
  );
});

test("tool activity summaries stay consecutive and split when prose arrives", () => {
  includesAll("src/web-ui/browser/chat-render.ts", [
    "flushPendingActivity(false)",
    "flushPendingActivity(true)",
    "opts.isTrailing",
    "isFoldableActivityBlock",
    'class="chat-process-summary"',
    'class="chat-activity-menu"',
    "__activityEntryToggle",
  ]);
  assert.doesNotMatch(
    source("src/web-ui/browser/chat-render.ts"),
    /正文在上、活动状态条在下/,
    "Web must not collect every activity run under all prose",
  );

  includesAll("android/app/src/main/java/com/wand/app/ui/screens/ChatBlocks.kt", [
    "fun collapseActivityItems(",
    "ToolActivitySummary(",
    "isLastTurn && isResponding",
  ]);
  includesAll("android/app/src/main/java/com/wand/app/ui/screens/ToolActivitySummary.kt", [
    "toolActivityCategories(",
    "fetchToolDetail(sessionId, use.id)",
    "ToolActivityEntryRow(",
    "ToolActivitySingleDetail(",
  ]);
  includesAll("android/app/src/main/java/com/wand/app/data/WandSocket.kt", [
    '.put("compactTools", true)',
  ]);

  includesAll("ios/Wand/ChatView.swift", [
    "collapseActivityItems(",
    "summarizeActivityItems",
  ]);
  includesAll("ios/Wand/ChatActivityTimeline.swift", [
    "struct ActivityFoldCard",
    // Android/iOS 共用时序语义；自动展开服从网络偏好，用户手动收放后不再覆盖。
    "group.newest && automaticTimeline",
    "if !userToggled",
    "activityTimelineOrder",
    "ActivityTimelineEntry",
    "api.fetchToolContent",
    "pinned && inspecting.isEmpty",
  ]);
  assert.doesNotMatch(source("ios/Wand/ChatView.swift"), /thinking:.*hashValue/, "streamed thinking must keep a stable identity");

  includesAll("macos/Wand/ChatView.swift", [
    "struct ActivityFoldCard",
    "_expanded = State(initialValue: activityGroup.newest)",
    "summarizeActivityItems",
  ]);
});

test("embedded passthrough terminal pins its width so fit cannot shrink it", () => {
  // 直通输入模式下原生壳把 .terminal-scroll-wrap 从 absolute 改成 relative，好让
  // .xterm-helpers 里的透明输入层有尺寸参照。但 .terminal-container.active 是 row
  // 方向的 flex 容器：wrap 落回文档流后是 flex-grow: 0 的收缩型 flex item，宽度会被
  // xterm 自身网格宽度反向决定，而 FitAddon 又按这个宽度反算列数 —— 自反馈会让终端
  // 每 fit 一次就更窄一点（表现为右侧铺不满并逐渐缩小）。两处都必须钉死宽度。
  const rulePattern = /\.is-wand-terminal-passthrough\s+\.terminal-scroll-wrap\s*\{[^}]*\}/;
  for (const file of ["src/web-ui/content/styles.css"]) {
    const rule = source(file).match(rulePattern);
    assert.ok(rule, `${file} must keep the passthrough .terminal-scroll-wrap rule`);
    assert.match(rule[0], /width:\s*100%/, `${file} must pin the passthrough wrap width`);
    assert.match(rule[0], /min-width:\s*0/, `${file} must let the passthrough wrap shrink`);
  }
});

test("terminal fit geometry ignores the unused overview ruler reserve", () => {
  // @xterm/addon-fit 只要 scrollback > 0 就固定预留 14px 给 overview ruler，而 Wand
  // 从未启用 overviewRuler（ruler 画布根本不会创建）。终端 fit 必须走
  // terminal-fit.ts 的 proposeTerminalDimensions，把这条白扣的宽度补回来。
  includesAll("src/web-ui/browser/terminal-fit.ts", [
    "proposeTerminalDimensions",
    ".xterm-decoration-overview-ruler",
  ]);
  for (const file of [
    "src/web-ui/browser/terminal.ts",
    "src/web-ui/browser/viewport.ts",
    "src/web-ui/browser/terminal-pool.ts",
    "src/web-ui/browser/file-browser.ts",
  ]) {
    const contents = source(file);
    assert.ok(
      contents.includes("fitTerminalToContainer"),
      `${file} must fit terminals through terminal-fit.ts`,
    );
    assert.doesNotMatch(
      contents,
      /\b(?:state\.)?terminalFitAddon\.fit\(\)|fitAddon\.fit\(\)/,
      `${file} must not call FitAddon.fit() directly (it reserves 14px for an unused ruler)`,
    );
  }
});
