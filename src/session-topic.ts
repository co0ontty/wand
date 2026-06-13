import { runClaudePrint } from "./claude-sdk-runner.js";

const TOPIC_TIMEOUT_MS = 45_000;
const MAX_PROMPT_LENGTH = 12_000;

export interface SessionTopic {
  title: string;
  description: string;
}

function cleanTopicText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function parseTopic(raw: string): SessionTopic | null {
  const json = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { title?: unknown; description?: unknown };
    const title = cleanTopicText(parsed.title, 40);
    const description = cleanTopicText(parsed.description, 120);
    return title && description ? { title, description } : null;
  } catch {
    return null;
  }
}

export async function generateSessionTopic(
  userMessage: string,
  cwd?: string,
  language?: string,
): Promise<SessionTopic> {
  const input = userMessage.trim().slice(0, MAX_PROMPT_LENGTH);
  const outputLanguage = language?.trim() || "与用户消息相同的语言";
  const prompt = [
    "请总结下面这条用户发给编码助手的首条消息，用于会话列表展示。",
    `使用${outputLanguage}输出。`,
    "只输出一个 JSON 对象，不要 Markdown、解释或额外文字。",
    '格式：{"title":"不超过20个字的具体主题标题","description":"不超过60个字的一句话任务描述"}',
    "标题避免使用“关于”“请求”“任务”等空泛词，描述保留最重要的目标和对象。",
    "",
    "用户消息：",
    input,
  ].join("\n");
  const raw = await runClaudePrint(prompt, { cwd, timeoutMs: TOPIC_TIMEOUT_MS, language });
  const topic = parseTopic(raw);
  if (!topic) throw new Error("模型返回的会话主题格式无效。");
  return topic;
}
