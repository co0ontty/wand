import assert from "node:assert/strict";
import test from "node:test";

import { renderLiveStepText } from "../src/ai-team-live.js";
import { AI_TEAM_LIVE_TEXT_MAX_CHARS } from "../src/ai-team-types.js";
import type { ConversationTurn } from "../src/types.js";

const user = (text: string): ConversationTurn => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (...blocks: ConversationTurn["content"]): ConversationTurn => ({
  role: "assistant", content: blocks,
});
const text = (value: string): ConversationTurn["content"][number] => ({ type: "text", text: value });
const toolUse = (name: string, description?: string): ConversationTurn["content"][number] => ({
  type: "tool_use", id: `t-${name}`, name, ...(description ? { description } : {}), input: {},
});
const toolResult = (content = "一大堆结果输出"): ConversationTurn["content"][number] => ({
  type: "tool_result", tool_use_id: "t-x", content,
});
const thinking = (value: string): ConversationTurn["content"][number] => ({ type: "thinking", thinking: value });

test("renders from the last user turn and keeps tool_use as one ▸ line", () => {
  const result = renderLiveStepText([
    user("很早以前的一条指令"),
    assistant(text("旧一轮的回复")),
    user("本轮提示词"),
    assistant(
      text("我先看两个文件"),
      toolUse("Read", "读取 src/ai-team-runner.ts 的调度器实现"),
      toolResult("文件内容……"),
      thinking("这里是不该露出的思考过程"),
      toolUse("Bash"),
      text("跑测试通过"),
    ),
  ], "");
  assert.ok(!result.text.includes("很早以前"), "更早的回合不渲染");
  assert.ok(!result.text.includes("旧一轮的回复"));
  assert.ok(result.text.includes("本轮提示词"));
  assert.ok(result.text.includes("▸ Read · 读取 src/ai-team-runner.ts 的调度器实现"));
  assert.ok(result.text.includes("▸ Bash"), "没有 description 时只有工具名");
  assert.ok(!result.text.includes("一大堆结果输出"), "tool_result 不渲染");
  assert.ok(!result.text.includes("不该露出"), "thinking 不渲染");
  assert.equal(result.omittedChars, 0);
  // 顺序即渲染顺序。
  const lines = result.text.split("\n");
  assert.ok(lines.indexOf("我先看两个文件") < lines.indexOf("▸ Bash"));
  assert.ok(lines.indexOf("▸ Bash") < lines.indexOf("跑测试通过"));
});

test("falls back to the last assistant turn when there is no user turn", () => {
  const result = renderLiveStepText([
    assistant(text("第一轮")),
    assistant(text("第二轮")),
  ], "");
  assert.equal(result.text, "第二轮");
});

test("long multi-line descriptions collapse to one 60-char line", () => {
  const description = `第一行\n第二行   连续空格被压掉  ${"很长的描述".repeat(30)}`;
  const result = renderLiveStepText([
    user("开工"),
    assistant(toolUse("Write", description)),
  ], "");
  const line = result.text.split("\n").find((item) => item.startsWith("▸ Write · "))!;
  assert.ok(line.length <= `▸ Write · `.length + 60, `整行截断: ${line.length}`);
  assert.ok(!line.includes("\n"));
  assert.match(line, /…$/);
});

test("consecutive blank lines collapse to a single newline, ends are trimmed", () => {
  const result = renderLiveStepText([
    user("提示词"),
    assistant(text("\n\n  第一段\n\n\n\n\n  第二段  \n\n")),
  ], "");
  assert.equal(result.text, "提示词\n第一段\n  第二段");
});

test("single blank line between paragraphs survives", () => {
  const result = renderLiveStepText([user("提示词"), assistant(text("报告标题\n\n正文一段"))], "");
  assert.ok(result.text.includes("报告标题\n\n正文一段"));
});

test("keeps the tail beyond the cap and reports the omitted prefix", () => {
  const long = "字".repeat(AI_TEAM_LIVE_TEXT_MAX_CHARS + 321);
  const result = renderLiveStepText([user("提示词"), assistant(text(long))], "");
  const total = `提示词\n${long}`;
  assert.equal(result.text.length, AI_TEAM_LIVE_TEXT_MAX_CHARS);
  assert.equal(result.omittedChars, total.length - AI_TEAM_LIVE_TEXT_MAX_CHARS);
  assert.equal(result.text, total.slice(-AI_TEAM_LIVE_TEXT_MAX_CHARS));
});

test("empty messages fall back to the ANSI-stripped output tail", () => {
  const raw = `\x1B[?25h\x1B[1;32m正在干活\x1B[0m\r\n第二行\r`;
  const result = renderLiveStepText([], raw);
  assert.equal(result.text, "正在干活\n第二行");
  assert.equal(result.omittedChars, 0);
});

test("output fallback also truncates to the tail", () => {
  const raw = `${"x".repeat(3000)}\x1b[K`;
  const result = renderLiveStepText([{ role: "user", content: [thinking("只有 thinking，没有可渲染文本")] }], raw);
  assert.equal(result.text.length, AI_TEAM_LIVE_TEXT_MAX_CHARS);
  assert.equal(result.omittedChars, 3000 - AI_TEAM_LIVE_TEXT_MAX_CHARS);
  assert.ok(!result.text.includes("\x1b"));
});

test("no messages and no output render empty", () => {
  assert.deepEqual(renderLiveStepText([], ""), { text: "", omittedChars: 0 });
});

// ── preferOutput：终端 output 尾部为唯一来源（R1，pty 非 claude）──

test("preferOutput renders the growing output tail and never the stale turn", () => {
  const stale = [
    user("上一轮的旧指令"),
    assistant(text("上一轮残留的旧回复")),
  ];
  const result = renderLiveStepText(stale, "\x1b[?25h正在装依赖\r\nnpm warn 已忽略\n第二行输出", { preferOutput: true });
  assert.equal(result.text, "正在装依赖\nnpm warn 已忽略\n第二行输出");
  assert.ok(!result.text.includes("上一轮"), "过期文本不能出现");
  assert.ok(!result.text.includes("\x1b"), "ANSI 序列要剥掉");
  assert.equal(result.omittedChars, 0);
});

test("preferOutput truncates to the tail and reports the omitted prefix", () => {
  const raw = "y".repeat(AI_TEAM_LIVE_TEXT_MAX_CHARS + 500);
  const result = renderLiveStepText([user("旧提示词")], raw, { preferOutput: true });
  assert.equal(result.text.length, AI_TEAM_LIVE_TEXT_MAX_CHARS);
  assert.equal(result.omittedChars, 500);
});

test("preferOutput with no output yet stays empty instead of recycling messages", () => {
  const result = renderLiveStepText([user("旧指令"), assistant(text("旧回复"))], "   ", { preferOutput: true });
  assert.deepEqual(result, { text: "", omittedChars: 0 });
});

test("without preferOutput the messages stay authoritative when output is growing", () => {
  // structured / claude PTY 的回归口径：messages 有可渲染文本时，终端原始输出不得插进来。
  const result = renderLiveStepText([user("提示词"), assistant(text("真实进度"))], "一堆原始终端噪声");
  assert.equal(result.text, "提示词\n真实进度");
});

test("a short output is processed whole, matching the pre-window behaviour", () => {
  // 截窗宽度是保留上限的 8 倍；输入没超窗时逐字等于「全量剥完再截尾」。
  const marker = "\x1b[31m";
  const raw = `${marker}${"旧".repeat(3000)}${marker}${"新".repeat(2600)}\r\n`;
  assert.ok(raw.length < AI_TEAM_LIVE_TEXT_MAX_CHARS * 8, "样例必须落在窗内");
  const whole = raw.replaceAll(marker, "").replace(/\r\n?/g, "\n").trim();
  const result = renderLiveStepText([], raw, { preferOutput: true });
  assert.equal(result.text, whole.slice(-AI_TEAM_LIVE_TEXT_MAX_CHARS));
  assert.equal(result.omittedChars, whole.length - AI_TEAM_LIVE_TEXT_MAX_CHARS);
});

test("a multi-megabyte output only renders the tail", () => {
  const stale = "旧输出".repeat(120_000);                     // 36 万字，远超截窗
  const fresh = "此刻在写安装章节".repeat(400);                // 3200 字，够填满保留上限
  const result = renderLiveStepText([], `${stale}\n${fresh}`, { preferOutput: true });
  assert.equal(result.text, fresh.slice(-AI_TEAM_LIVE_TEXT_MAX_CHARS));
  assert.ok(!result.text.includes("旧输出"), "截窗外的前缀不该进卡片");
  assert.ok(result.omittedChars >= stale.length - AI_TEAM_LIVE_TEXT_MAX_CHARS * 8, "丢掉的前缀计入省略字数");
});

test("the tail window snaps back to an escape-sequence start instead of showing its body", () => {
  // 让截窗点正好落在 `ESC [ 7 m` 中间：不回退就会把尾巴的 `m` 当正文显示。
  const head = "a".repeat(15_998);
  const tail = "z".repeat(15_999);
  const raw = `${head}\x1b[7m${tail}`;
  assert.equal(raw.length - AI_TEAM_LIVE_TEXT_MAX_CHARS * 8, 16_001, "截窗点要落在序列里");
  const result = renderLiveStepText([], raw, { preferOutput: true });
  assert.equal(result.text, "z".repeat(AI_TEAM_LIVE_TEXT_MAX_CHARS));
  assert.ok(!result.text.includes("["), "半截转义序列的尾巴不能漏成正文");
});

test("a long OSC crossing the cut leaves no bare BEL and no title fragment", () => {
  // 审查报告的反例：`ESC ] 0;` + 270 字标题 + BEL，截窗点距 ESC 104 字（旧回退上限 64 够不着）。
  const title = "TITLE-PAD".repeat(30);
  const head = "a".repeat(16_000);
  const tail = "z".repeat(15_829);
  const raw = `${head}\x1b]0;${title}\x07${tail}`;
  const cut = raw.length - AI_TEAM_LIVE_TEXT_MAX_CHARS * 8;
  assert.equal(cut - head.length, 104, "截窗点要在 OSC 负载里、距 ESC 起点 104 字");
  const result = renderLiveStepText([], raw, { preferOutput: true });
  assert.equal(result.text, "z".repeat(AI_TEAM_LIVE_TEXT_MAX_CHARS));
  assert.ok(!result.text.includes("\x07"), "残留裸 BEL 会被当成正文显示");
  assert.ok(!result.text.includes("TITLE"), "OSC 标题片段不该漏成正文");
  assert.ok(result.omittedChars > 0);
});

test("a window made entirely of escape sequences still reports the dropped prefix", () => {
  // 窗内一个可见字都没有：文本照实为空，但窗外的正文确实被丢了，省略字数不能报 0。
  const raw = `${"正文".repeat(9000)}${"\x1b[38;5;244m".repeat(2100)}`;
  const windowChars = raw.length - AI_TEAM_LIVE_TEXT_MAX_CHARS * 8;
  assert.ok(windowChars > 0, "样例要超出截窗");
  const result = renderLiveStepText([], raw, { preferOutput: true });
  assert.equal(result.text, "");
  // 切点只会为找序列起点往前挪（不超出回退范围），所以省略字数 ≥ 截窗点 - 4096。
  assert.ok(result.omittedChars >= windowChars - 4096, "全转义窗也要如实计入被丢掉的前缀");
});

test("the tail window renders verbatim what a whole-string pass would render", () => {
  // 回归：窗内可见文本与「全量剥 ANSI → 归一换行 → 压空行 → 截尾」逐字相同。
  const strip = (value: string) => value.replace(
    /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[ @-Z\\-_])/g, "",
  );
  const marks = ["\x1b[7m", "\x1b[38;5;244m", "\x1b[?1049h", "\x1b]0;标题\x07", "\x1bM", "\x1b[2K", "\x1b[1;32m"];
  for (let seed = 0; seed < 120; seed += 1) {
    const mark = marks[seed % marks.length]!;
    const lines = Array.from({ length: 400 + seed }, (_, index) => (
      index % 3 === 0 ? `${mark}第${index}行进度文本` : `第${index}行进度文本`
    ));
    const raw = [
      "旧".repeat(16_000 + seed),
      `${mark}噪声${"\r\n".repeat(4)}`,   // 连续空行，压不压要一致
      lines.join("\n"),
    ].join("");
    const reference = strip(raw).replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n").trim();
    const result = renderLiveStepText([], raw, { preferOutput: true });
    assert.equal(result.text, reference.slice(-AI_TEAM_LIVE_TEXT_MAX_CHARS), `样例 ${seed} 的窗内文本要逐字一致`);
  }
});

// MARK: - 尾部截断不切半个代理对

const MAX = AI_TEAM_LIVE_TEXT_MAX_CHARS;

test("an emoji straddling the tail cut is dropped whole instead of leaking U+FFFD", () => {
  // 切点（长度 - 保留上限）正好落在 😀 的高/低代理之间：旧实现把低半截留在开头。
  const raw = `${"a".repeat(505)}\u{1F600}${"b".repeat(MAX - 1)}`;
  assert.equal(raw.length - MAX, 506, "样例的切点要在代理对里");
  const result = renderLiveStepText([], raw, { preferOutput: true });
  assert.ok(!result.text.includes("\uFFFD"), "半个字符渲染出来就是 U+FFFD");
  assert.ok(!/[\uD800-\uDFFF]/.test(result.text), "窗口开头不该留落单的低代理");
  assert.equal(result.text, "b".repeat(MAX - 1));
  // 挪掉的那半个 code unit 计入省略字数，保留上限只减不增。
  assert.equal(result.omittedChars, raw.length - result.text.length);
  assert.ok(result.text.length <= MAX);
});

test("a complete pair at the tail cut stays intact", () => {
  // 同一位置往前挪一个单位：切点落在高代理上（整对都在窗口里），不该被挪走。
  const raw = `${"a".repeat(505)}\u{1F600}${"b".repeat(MAX - 2)}`;
  assert.equal(raw.length - MAX, 505, "切点要正好是高代理");
  const result = renderLiveStepText([], raw, { preferOutput: true });
  assert.equal(result.text, `\u{1F600}${"b".repeat(MAX - 2)}`);
  assert.equal(result.text.length, MAX);
  assert.ok(!result.text.includes("\uFFFD"));
});

test("the output window cut snaps off a split pair too, and still matches the whole-string tail", () => {
  // 超出截窗宽度：截窗点落在代理对里，且回退范围内既没 ESC 也没换行（safeTailStart 原样返回）。
  const head = "a".repeat(20_000);
  const escapes = "\x1bM".repeat(7_249);                            // 14498 个纯转义 code unit
  const raw = `${head}\u{1F600}${escapes}${"b".repeat(1_501)}`;
  assert.equal(raw.length - MAX * 8, 20_001, "截窗点要落在代理对里");
  const result = renderLiveStepText([], raw, { preferOutput: true });
  assert.ok(!/[\uD800-\uDFFF]/.test(result.text), "截窗切点也不该留下半截代理对");
  assert.equal(result.text, "b".repeat(1_501));
  const whole = raw.replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[ @-Z\\-_])/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n")
    .trim();
  assert.ok(whole.endsWith(result.text), "窗内文本仍是整串处理结果的尾巴");
  assert.ok(result.omittedChars > 0);
});
