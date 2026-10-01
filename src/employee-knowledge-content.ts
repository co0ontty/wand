import { EMPLOYEE_KNOWLEDGE_MAX_CHARS } from "./employee-knowledge-types.js";

/** Recognize direct memory requests only, never quoted/conditional mentions or ordinary task prompts. */
export function explicitEmployeeMemoryContent(input: string): string | null {
  const raw = input.trim();
  const match = /^(?:(?:请|麻烦|你|帮我|帮忙)\s*){0,3}(?:记一下|记住|记下|(?:记录|保存|存)到(?:你(?:的)?|自己(?:的)?)?知识库)\s*[:：,，]?\s*([\s\S]+)$/u.exec(raw)
    ?? /^(?:please\s+)?remember\s+(?:this\s*)?:\s*([\s\S]+)$/i.exec(raw);
  return match?.[1]?.trim() || null;
}

/** Explicit notes may contain useful URLs/paths; reject credentials instead of silently losing content. */
export function normalizeEmployeeKnowledge(content: string): string {
  const text = content.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim();
  if (!text) throw new Error("知识内容不能为空。");
  if (text.length > EMPLOYEE_KNOWLEDGE_MAX_CHARS) throw new Error("每条知识最多 4000 个字符，请分条记录。");
  if (/-----BEGIN[^\n]*PRIVATE KEY-----|\b(?:sk[-_]|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{12,}|\beyJ[\w-]+\.[\w-]+\.[\w-]+/i.test(text)
    || /(?:password|passwd|api[ _-]?key|(?:access[ _-]?|app[ _-]?)?token|secret|authorization|connection[ _-]?code|密码|密钥|连接码)\s*[:=：]\s*\S+/i.test(text)
    || /\bBearer\s+[A-Za-z0-9._-]{16,}/i.test(text)
    || /(?:https?|wss?):\/\/[^\s/]+:[^\s/]+@/i.test(text)) {
    throw new Error("知识库不保存密码、密钥或连接凭据；请去掉敏感内容后再记。");
  }
  return text;
}
