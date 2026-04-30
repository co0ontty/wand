import { execFile } from "node:child_process";

const CLAUDE_TIMEOUT_MS = 60_000;
const MAX_INPUT_LENGTH = 8000;

interface ClaudeError extends Error {
  code?: string;
  stderr?: string;
}

export class PromptOptimizeError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "PromptOptimizeError";
  }
}

function callClaudeText(prompt: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "claude",
      ["-p", "--output-format", "text"],
      {
        cwd: cwd && cwd.length > 0 ? cwd : undefined,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: CLAUDE_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (error) {
          const e = error as ClaudeError;
          if (e.code === "ENOENT") {
            reject(new PromptOptimizeError("未找到 claude CLI。", "CLAUDE_CLI_MISSING"));
            return;
          }
          if (e.code === "ETIMEDOUT") {
            reject(new PromptOptimizeError("Claude 优化超时，请稍后重试。", "CLAUDE_TIMEOUT"));
            return;
          }
          const msg = (stderr || "").trim() || e.message || "claude 调用失败";
          reject(new PromptOptimizeError(`Claude CLI 失败：${msg}`, "CLAUDE_CLI_FAILED"));
          return;
        }
        resolve((stdout || "").trim());
      },
    );
    child.stdin?.end(prompt);
  });
}

function buildOptimizePrompt(userInput: string, language: string): string {
  const lang = (language || "").trim() || "中文";
  return [
    `你是一名提示词优化助手。请把用户写给编码 AI 的「原始提示词」改写得更清晰、结构化、可执行，便于 AI 理解并完成任务。`,
    `要求：`,
    `1. 保留用户原意和所有关键信息（文件路径、变量名、技术名词、数字、约束等），不要删减事实，也不要新增臆测的需求。`,
    `2. 必要时拆分为「目标 / 上下文 / 约束 / 验收标准」几个部分；如果原文很短或很简单，则只做语句润色，不要硬塞结构。`,
    `3. 用${lang}输出。语气克制专业，不寒暄、不解释你做了什么。`,
    `4. 只输出优化后的提示词正文，不要包裹在代码块或引号里，不要加任何前后缀（比如「优化后：」之类）。`,
    ``,
    `原始提示词：`,
    userInput,
  ].join("\n");
}

export async function optimizePrompt(rawText: string, language: string, cwd?: string): Promise<string> {
  const text = (rawText || "").trim();
  if (!text) {
    throw new PromptOptimizeError("请先输入要优化的内容。", "EMPTY_INPUT");
  }
  if (text.length > MAX_INPUT_LENGTH) {
    throw new PromptOptimizeError(
      `输入过长（${text.length} 字符），请缩短到 ${MAX_INPUT_LENGTH} 以内。`,
      "INPUT_TOO_LONG",
    );
  }
  const prompt = buildOptimizePrompt(text, language);
  const raw = await callClaudeText(prompt, cwd);
  const cleaned = raw
    .replace(/^```[a-zA-Z]*\n?/, "")
    .replace(/\n?```$/, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
  if (!cleaned) {
    throw new PromptOptimizeError("Claude 返回了空结果。", "EMPTY_RESULT");
  }
  return cleaned;
}
