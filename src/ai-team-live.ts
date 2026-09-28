import { AI_TEAM_LIVE_TEXT_MAX_CHARS } from "./ai-team-types.js";
import type { ConversationTurn } from "./types.js";

/**
 * 运行中步骤的 live 文本渲染结果。`omittedChars` > 0 表示前面被截掉的字数，
 * 客户端据此显示「已省略前面 N 字」。
 */
export interface LiveStepText {
  text: string;
  omittedChars: number;
}

/** tool_use 行的 description 单行截断长度。 */
const TOOL_DESCRIPTION_MAX_CHARS = 60;

/** CSI + OSC + 两字节转义，覆盖 PTY 输出里常见的控制序列。 */
const ANSI_PATTERN = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[ @-Z\\-_])/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/** 行尾空白清掉；连续空行（≥2 个）压成一个换行，单个空行保留，段落还在。 */
function collapseBlankLines(text: string): string {
  return text.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n");
}

/**
 * 把切点往前挪一个 code unit，避开「半个 emoji」。
 * `slice` 按 UTF-16 code unit 切，切点正好落在代理对中间（前一个是高代理、这一个是低代理）时，
 * 尾巴会以一个孤立低代理开头 —— 下游渲染成 1 个 U+FFFD。往**前**挪（丢掉这一对的后半截，
 * 整对归到被省略的前缀里）而不是往后挪，才能保证 `text.length <= AI_TEAM_LIVE_TEXT_MAX_CHARS`。
 * 起点是 0（没切）或 `start - 1` 不是高代理时原样返回。
 */
function skipOrphanSurrogate(text: string, start: number): number {
  if (start <= 0 || start >= text.length) return start;
  const previous = text.charCodeAt(start - 1);
  const current = text.charCodeAt(start);
  const splitPair = previous >= 0xD800 && previous <= 0xDBFF && current >= 0xDC00 && current <= 0xDFFF;
  return splitPair ? start + 1 : start;
}

function takeTail(text: string): LiveStepText {
  if (text.length <= AI_TEAM_LIVE_TEXT_MAX_CHARS) return { text, omittedChars: 0 };
  const start = skipOrphanSurrogate(text, text.length - AI_TEAM_LIVE_TEXT_MAX_CHARS);
  const tail = text.slice(start);
  return { text: tail, omittedChars: text.length - tail.length };
}

/**
 * output 回落的截窗宽度：只要保留上限的 8 倍。转义序列通常远少于正文，窗内可见文本一般仍 ≥
 * AI_TEAM_LIVE_TEXT_MAX_CHARS，此时窗内显示的文本与「全量剥完再截尾」逐字相同；极端全是转义的
 * 输出只会让显示的比全量少一截，省略字数仍按截窗点如实计入（是估算值，见 `outputTailText`）。
 */
const LIVE_OUTPUT_WINDOW_CHARS = AI_TEAM_LIVE_TEXT_MAX_CHARS * 8;

/**
 * 截窗点最多往前回退这么多字符去找转义序列的起点（ESC）。
 * 宽度按能装下最长的常见序列给：OSC 标题/超链接可以横跨几 K（`ESC ] 0; <长标题> BEL`），
 * 只回退 64 字会把这种序列从中间切开，残留裸 BEL 和标题片段当正文显示。
 */
const LIVE_OUTPUT_ESCAPE_LOOKBACK = 4096;

/**
 * 把截窗点挪到一个安全边界上：
 * 1. 回退范围内有 ESC → 从该序列的起点开始，剥 ANSI 就能整条剥掉；
 * 2. 退一步到最近的换行之后 → 至少不显示半行的残片；
 * 3. 两者都找不到（超长转义负载里既没 ESC 也没换行）就不兜底，照原切点显示。
 * 只在 `[start - LOOKBACK, start)` 这段里搜，不对整串（能到几 MB）跑 lastIndexOf。
 */
function safeTailStart(output: string, start: number): number {
  const from = Math.max(0, start - LIVE_OUTPUT_ESCAPE_LOOKBACK);
  const window = output.slice(from, start);
  const esc = window.lastIndexOf("\x1B");
  if (esc >= 0) return from + esc;
  const newline = window.lastIndexOf("\n");
  return newline >= 0 ? from + newline + 1 : start;
}

/**
 * 终端原始输出的尾部：先按尾部截窗，再剥 ANSI / 换行归一 / 压缩空行 / 截尾。
 * live 每 500ms 就可能算一遍，而 PTY 的 output 能长到几 MB —— 顺序反过来等于每半秒对全量
 * 跑一遍正则。丢掉的前缀计入 omittedChars，是**估算值（可能偏大也可能偏小，用于量级提示）**：
 * 按截窗点的原始字数计，含 ANSI 与控制字符，不精确到账。三条边界写进 docs/ai-teams.md。
 */
function outputTailText(output: string): LiveStepText {
  const rawStart = Math.max(0, output.length - LIVE_OUTPUT_WINDOW_CHARS);
  const start = rawStart > 0 ? skipOrphanSurrogate(output, safeTailStart(output, rawStart)) : 0;
  const stripped = collapseBlankLines(stripAnsi(output.slice(start)).replace(/\r\n?/g, "\n")).trim();
  // 窗内全是转义序列时 stripped 为空，但窗外的正文确实被丢了，省略字数照 start 记，不报 0。
  const tail = takeTail(stripped);
  return start > 0 ? { text: tail.text, omittedChars: tail.omittedChars + start } : tail;
}

/** 压成一行并截断到 max 字（省略号算在长度内）。 */
function oneLine(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1)}…`;
}

/**
 * 渲染「成员此刻干到哪儿了」的紧凑文本，给固定尺寸、内部滚动的 live 卡片用。
 * 口径：从最后一条 user turn（没有就取最后一条 assistant turn）渲染到末尾；
 * text 原样保留，tool_use 压成一行 `▸ 名称[ · 描述]`，tool_result 与 thinking 不渲染；
 * 尾部保留最多 AI_TEAM_LIVE_TEXT_MAX_CHARS 字；渲染结果为空时回落原始 output 尾部
 * （先按尾部截窗再剥 ANSI、同样截尾，见 `outputTailText`），保证 PTY 会话也有内容可显示。
 * 纯函数、无 IO。
 *
 * `preferOutput`：以终端 output 尾部为唯一来源，完全不看 `messages`。给「PTY 但没有人把
 * 流式输出解析成 messages」的会话用（判定在调用方，见 `ai-team-runner.ts` 的 `liveStep`）——
 * 这类会话的 `messages` 在流式期不增长，里面若留着上一条 turn，按上面的口径会一直渲染那段
 * 旧文本，卡片停在过期内容上。此时 output 为空也照实返回空串，不拿旧 messages 凑数。
 */
export function renderLiveStepText(
  messages: ConversationTurn[],
  output: string,
  options: { preferOutput?: boolean } = {},
): LiveStepText {
  if (options.preferOutput === true) return outputTailText(output);
  let start = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === "user") {
      start = index;
      break;
    }
  }
  if (start < 0) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]!.role === "assistant") {
        start = index;
        break;
      }
    }
  }
  const fragments: string[] = [];
  for (const turn of start >= 0 ? messages.slice(start) : []) {
    for (const block of turn.content) {
      if (block.type === "text") {
        const text = block.text?.trim();
        if (text) fragments.push(text);
      } else if (block.type === "tool_use") {
        const description = block.description?.trim();
        fragments.push(description
          ? `▸ ${block.name} · ${oneLine(description, TOOL_DESCRIPTION_MAX_CHARS)}`
          : `▸ ${block.name}`);
      }
    }
  }
  const rendered = collapseBlankLines(fragments.join("\n")).trim();
  if (rendered) return takeTail(rendered);
  return outputTailText(output);
}
