import { callConfiguredAiText, type QuickCommitAiOptions } from "./git-quick-commit.js";

/** 任务标题留空时由描述自动生成；面板上显示得下，也不至于截断成半句话。 */
export const TASK_TITLE_MAX_LENGTH = 40;

const DESCRIPTION_HINT_MAX = 2_000;

function clip(value: string, maxLength = TASK_TITLE_MAX_LENGTH): string {
  if (value.length <= maxLength) return value;
  const sliced = value.slice(0, maxLength);
  const lastSpace = sliced.lastIndexOf(" ");
  if (lastSpace >= Math.floor(maxLength * 0.55)) return sliced.slice(0, lastSpace);
  return sliced;
}

function firstMeaningfulLine(description: string): string {
  const lines = description
    .split(/\r?\n/)
    .map((line) => line
      // Markdown 列表 / 标题 / 引用符不能变成标题的一部分。
      .replace(/^\s*(?:[-*+>]+|\d+[.)]|#{1,6})\s*/, "")
      .replace(/\s+/g, " ")
      .trim())
    .filter(Boolean);
  const line = lines.find((candidate) => candidate.length >= 2) ?? lines[0] ?? "";
  return line.replace(/[：:；;，,。.]+$/, "").trim();
}

/**
 * 描述已经到达客户端之后立刻可用的标题：不依赖模型，也不等网络。
 * 后台自动生成成功后再覆盖它；失败或超时就保留这个兜底。
 */
export function provisionalTaskTitleFromDescription(description: string): string {
  return clip(firstMeaningfulLine(description));
}

/** 模型输出可能带引号、代码块或「标题：」前缀，逐层剥掉再按单行裁剪。 */
export function parseGeneratedTaskTitle(raw: string): string {
  return clip(stripGeneratedTitle(raw));
}

function stripGeneratedTitle(raw: string): string {
  const withoutFences = raw.trim().replace(/^```(?:json|text)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const firstLine = withoutFences.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  const withoutLabel = firstLine.replace(/^(?:任务)?标题\s*[:：]\s*/, "");
  const unquoted = withoutLabel.replace(/^["'`“”『「]+|["'`“”』」]+$/g, "").trim();
  return unquoted.replace(/[。.]+$/, "").trim();
}

/**
 * CLI 把 provider 自己的报错（模型不可用、限流、鉴权失败）当成功结果返回时，
 * 整句话会原样变成任务标题。这些字符串一律不能当标题落库。
 */
const TITLE_REJECT_PATTERNS: RegExp[] = [
  /\b(?:i(?:'| a)?m )?sorry\b/i,
  /\bthere(?:'| i)?s?\s+an?\s+issue\b/i,
  /\b(?:api|model|provider|authentication|rate)[ _-]?(?:error|limit|key|quota)\b/i,
  /\b(?:invalid|missing|expired)\b[^.]{0,24}\b(?:key|token|api|model|credential)\b/i,
  /\b(?:unauthorized|forbidden|permission denied|quota exceeded|not found|timed? ?out)\b/i,
  /\b(?:error|exception|failed|failure)\s*[:：]/i,
  /^(?:检索|抱歉|对不起|无法|不能|错错|错误|失败|请求超时|服务不可用)/,
];

/** 识别“这不像标题”的输出：报错文案、整段句子、多行解释。 */
export function isPlausibleTaskTitle(value: string): boolean {
  const title = value.replace(/\s+/g, " ").trim();
  if (!title) return false;
  // 超过一行标题的长度上限就不再是标题，而是解释。
  if (title.length > TASK_TITLE_MAX_LENGTH) return false;
  if (TITLE_REJECT_PATTERNS.some((pattern) => pattern.test(title))) return false;
  // 标题是一行短语：出现句末标点，或长句里带逗号分号，都说明这是解释而不是标题。
  if (/[。！？!?]/.test(title)) return false;
  if (title.length > 24 && /[，,；;]/.test(title)) return false;
  return true;
}

/** 由任务描述总结一个标题；模型的输出永远只作为候选，由调用方决定是否落库。 */
export async function generateWandTaskTitle(
  description: string,
  cwd: string,
  language = "",
  ai: QuickCommitAiOptions = {},
): Promise<string> {
  const input = description.trim().slice(0, DESCRIPTION_HINT_MAX);
  if (!input) throw new Error("没有可总结的任务描述。");
  const outputLanguage = language.trim() || "与描述相同的语言";
  const prompt = [
    "根据下面的任务描述，写一个用于任务列表的具体标题。",
    `使用${outputLanguage}输出。`,
    "只输出标题本身：一行纯文本，不要引号、不要 Markdown、不要编号、不要「标题：」这类前缀、不要任何解释。",
    "不超过 20 个字，必须点出描述里的具体对象或动作，不要使用「任务」「待办」「关于」「请求」等空泛词。",
    "",
    "任务描述：",
    input,
  ].join("\n");
  const raw = await callConfiguredAiText(prompt, cwd || process.cwd(), language, ai);
  const stripped = stripGeneratedTitle(raw);
  // 拿到报错文案 / 整段解释时宁可保留占位标题，也不能把垃圾写进看板。
  // 先判可信度再裁剪：截断过的长句看起来就像标题，会绕过长度检查。
  if (!isPlausibleTaskTitle(stripped)) throw new Error("模型返回的任务标题不可用。");
  return clip(stripped);
}
