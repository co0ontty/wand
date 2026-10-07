import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const screen = (name: string): string => readFileSync(new URL(
  `../android/app/src/main/java/com/wand/app/ui/screens/${name}.kt`, import.meta.url), "utf8");

test("Android activity drawer uses full width and keeps its bounded vertical viewport", () => {
  const source = screen("ToolActivitySummary");
  assert.doesNotMatch(source, /ACTIVITY_DRAWER_WIDTH_FRACTION|fillMaxWidth\(0\./);
  assert.match(source, /\.fillMaxWidth\(\)\s*\.heightIn\(max = activityPanelMaxHeight\(activityPanelViewportHeight\(\)\)\)/);
  assert.match(source, /TOOL_ACTIVITY_TIMELINE_HEIGHT = 240\.dp/);
  assert.match(source, /isFirst = index == 0,\s*isLast = index == timeline\.lastIndex,/);
  assert.match(source, /activityTimelineRailBounds\(size\.height, dotCenterY\.toPx\(\), isFirst, isLast\)/);
});

test("Android activity details do not nest another tool card and file actions never prefetch on expansion", () => {
  const source = screen("ToolActivitySummary");
  assert.doesNotMatch(source, /\b(?:ToolCard|DiffCard|TerminalCard|ToolActivityLoadedCard)\s*\(/);
  assert.match(source, /if \(toolActivityOpensFile\(use\)\) \{\s*ToolActivityFileAction\(use, open\)\s*return/);
  const action = screen("ToolActivityDetail");
  assert.match(action, /Text\("查看文件"/);
  assert.match(action, /if \(request == 0\) return@LaunchedEffect/);
  assert.match(action, /if \(!open\) \{\s*request = 0/);
  assert.match(action, /fetchToolDetail\(sessionId, use\.id\)/);
  assert.match(action, /LocalChatWorkingDirectory\.current/);
  assert.doesNotMatch(action, /\.activity\?\.fileKey|\.activity\?\.label/);
});

test("Android thinking keeps a real start clock and five-line preview with in-place full text", () => {
  const source = screen("ChatBlocks");
  const thinking = source.slice(source.indexOf("internal const val THINKING_VISIBLE_LINES"),
    source.indexOf("// MARK: - 权限审批卡片"));
  assert.match(thinking, /THINKING_VISIBLE_LINES = 5/);
  assert.match(thinking, /SelectionContainer/);
  assert.match(thinking, /maxLines = thinkingTextMaxLines\(expanded\)/);
  assert.match(thinking, /if \(expanded\) Int\.MAX_VALUE else THINKING_VISIBLE_LINES/);
  // 时钟优先读本轮的服务端观察时间，旧历史才回落到所属回复的开始时间。
  assert.match(thinking, /thinkingEventClock\(occurredAt \?: LocalChatTurnCreatedAt\.current\)/);
  assert.match(source, /occurredAt = block\.occurredAt/);
  assert.match(source, /LocalChatTurnCreatedAt provides turn\.createdAt/);
  assert.match(thinking, /rememberFoldOverrideCode\(foldKey\)/);
  assert.match(thinking, /animateContentSize\(WandMotion\.respectMotion/);
  assert.doesNotMatch(thinking, /深度思考|FoldableCardBody|CardChevronSlot|take\(\d+\)/);
  const timeline = screen("ToolActivitySummary");
  assert.doesNotMatch(timeline, /深度思考/);
  assert.doesNotMatch(timeline, /ThinkingBlock\(/);
  // 缩略统计行是全段唯一的动态 loading：展开也不让位，时间线行只用状态色。
  assert.match(timeline, /ToolActivityMark\(running = true, color = WandColors\.brand\)/);
  assert.doesNotMatch(timeline, /running = live && menuOpen|running = !menuOpen/);
  assert.match(timeline, /live = liveRow != null && activityRowIsLive\(liveRow, row\)/);
  assert.match(timeline, /fun activityLiveRow\(items: List<DisplayItem>, groupRunning: Boolean\)/);
  assert.match(timeline, /ToolActivityReveal\(open && menuOpen\)/);
  assert.match(timeline, /else SelectionContainer/);
  assert.match(timeline, /minLines = 1, maxLines = 1/);
  // 每轮推理是时间线里独立且紧凑的一行，不沿用调用的两行骨架。
  assert.match(timeline, /ACTIVITY_THINKING_ROW_MIN_HEIGHT = 44\.dp/);
  assert.match(timeline, /ACTIVITY_CALL_ROW_MIN_HEIGHT = 78\.dp/);
  assert.match(timeline, /heightIn\(min = if \(compact\) ACTIVITY_THINKING_ROW_MIN_HEIGHT else ACTIVITY_CALL_ROW_MIN_HEIGHT\)/);
  assert.match(timeline, /if \(tool != null\) ToolActivityExcerpt\(toolResultCardPreview\(tool\.result\)/);
  assert.match(timeline, /round = roundByPosition\[row\.position\]/);
  assert.match(timeline, /from: Alignment.Vertical = Alignment.Top/);
  assert.match(timeline, /ToolActivityReveal\(menuOpen, from = Alignment.Top\)/);
  assert.doesNotMatch(timeline, /then\(if \(tool != null\) Modifier\.clickable/);
  assert.match(timeline, /onClickLabel = if \(open\) "收起\$label" else "查看\$label"/);
});

test("Android Back navigates directly and is independent of all inline chat card expansions", () => {
  const screenSource = screen("ChatScreen");
  assert.match(screenSource, /WandDetailBackButton\(\s*onClick = onBack/);
  assert.doesNotMatch(screenSource, /rememberChatBackAction|dispatchChatBack|onBackPressedDispatcher/);
  for (const name of ["ToolActivitySummary", "ChatBlocks", "ChatActionBlocks", "ToolActivityDetail", "TaskBoardScreen"]) {
    assert.doesNotMatch(screen(name), /\b(?:BackHandler|PredictiveBackHandler|onBackPressedDispatcher)\b/);
  }
  const taskList = screen("TaskListScreen");
  assert.doesNotMatch(taskList, /BackHandler\(enabled = state\.hasTemporaryExpansion/);
  assert.match(taskList, /BackHandler\(enabled = terminalMenuKey != null\)/);
  const timeline = screen("ToolActivitySummary");
  assert.match(timeline, /menuOpen = !menuOpen\s*drawerManuallyToggled = true/);
  assert.match(timeline, /open = !open/);
  const blocks = screen("ChatBlocks");
  assert.match(blocks, /foldOverride = foldToggleCode\(foldOverride, derivedDefault = false\)/);
  const app = readFileSync(new URL("../android/app/src/main/java/com/wand/app/ui/WandApp.kt", import.meta.url), "utf8");
  assert.match(app, /BackHandler\(enabled = nav\.stack\.size > 1\) \{ nav\.pop\(\) \}/);
});
