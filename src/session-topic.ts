import { callConfiguredAiText, type QuickCommitAiOptions } from "./git-quick-commit.js";
import type { ConversationTurn } from "./types.js";

const MAX_PROMPT_LENGTH = 12_000;

/**
 * PTY 终端视图里，只有底部输入框整段提交（shortcutKey=enter_text）才总结标题。
 * 逐键 pty_input / 方向键 / 单独回车不能触发，避免把按键当主题。
 */
export function shouldGenerateSessionTopicFromPtyInput(
  view?: "chat" | "terminal",
  shortcutKey?: string,
): boolean {
  return view !== "terminal" || shortcutKey === "enter_text";
}

export interface SessionTopic {
  title: string;
  description: string;
}

export interface SessionTopicRequest {
  messages?: readonly ConversationTurn[];
  input: string;
  cwd?: string;
  language?: string;
  ai?: QuickCommitAiOptions;
  onGenerating(generating: boolean): void;
  onTopic(topic: SessionTopic): void;
  onError(error: unknown): void;
}

interface PendingTopicState {
  revision: number;
  running: boolean;
  userMessages: string[];
  request: SessionTopicRequest;
}

const TITLE_MAX_LENGTH = 24;
const DESCRIPTION_MAX_LENGTH = 120;

function cleanTopicText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeComparableTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function isSameSessionTitle(left: string, right: string): boolean {
  const first = normalizeComparableTitle(left);
  const second = normalizeComparableTitle(right);
  return Boolean(first && second && first === second);
}

/** Parent task / directory names must not become a terminal's displayed title. */
export function collectSessionTopicBlocklist(input: {
  taskName?: string | null;
  workspaceName?: string | null;
  cwd?: string;
}): string[] {
  const cwd = (input.cwd ?? "").replace(/[\\/]+$/, "");
  return [...new Set(
    [input.taskName, input.workspaceName, cwd.split(/[\\/]/).pop()]
      .map((value) => value?.replace(/\s+/g, " ").trim() ?? "")
      .filter(Boolean),
  )];
}

export function shouldAcceptGeneratedSessionTitle(
  title: string,
  blockedTitles: readonly string[] = [],
): boolean {
  const cleaned = title.replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned === "会话") return false;
  return !blockedTitles.some((blocked) => isSameSessionTitle(cleaned, blocked));
}

function clipTitle(value: string, maxLength = TITLE_MAX_LENGTH): string {
  if (value.length <= maxLength) return value;
  const sliced = value.slice(0, maxLength);
  const lastSpace = sliced.lastIndexOf(" ");
  if (lastSpace >= Math.floor(maxLength * 0.55)) return sliced.slice(0, lastSpace);
  return sliced;
}

/** Immediate title from the user's command, without waiting for the model. */
export function summarizeSessionTitleFromInput(
  input: string,
  options: { blockedTitles?: readonly string[] } = {},
): string {
  const blockedTitles = options.blockedTitles ?? [];
  const lines = input
    .split(/\r?\n/)
    .map((part) => part.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const fallback = clipTitle(lines[0] ?? "");
  for (const line of lines) {
    const title = clipTitle(line);
    if (shouldAcceptGeneratedSessionTitle(title, blockedTitles)) return title;
  }
  return fallback;
}

export function summarizeSessionDescriptionFromInput(input: string): string {
  return cleanTopicText(input, DESCRIPTION_MAX_LENGTH);
}

export function provisionalSessionTopic(
  input: string,
  blockedTitles: readonly string[] = [],
): SessionTopic | null {
  const title = summarizeSessionTitleFromInput(input, { blockedTitles });
  if (!title) return null;
  return {
    title,
    description: summarizeSessionDescriptionFromInput(input) || title,
  };
}

export function sessionTopicBlocklistForSnapshot(
  snapshot: { cwd?: string; workspaceTaskId?: string },
  storage: {
    getWorkspaceTask(id: string): { name: string; workspaceId: string } | null;
    getWorkspace(id: string): { name: string } | null;
  },
): string[] {
  const task = snapshot.workspaceTaskId ? storage.getWorkspaceTask(snapshot.workspaceTaskId) : null;
  const workspace = task ? storage.getWorkspace(task.workspaceId) : null;
  return collectSessionTopicBlocklist({
    taskName: task?.name,
    workspaceName: workspace?.name,
    cwd: snapshot.cwd,
  });
}

function parseTopic(raw: string): SessionTopic | null {
  const json = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { title?: unknown; description?: unknown };
    const title = cleanTopicText(parsed.title, TITLE_MAX_LENGTH);
    const description = cleanTopicText(parsed.description, DESCRIPTION_MAX_LENGTH);
    return title && description ? { title, description } : null;
  } catch {
    return null;
  }
}

function turnText(turn: ConversationTurn): string {
  return turn.content
    .filter((block) => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** Collect every completed user turn plus the newly submitted input in order. */
export function collectSessionTopicMessages(
  messages: readonly ConversationTurn[] | undefined,
  input: string,
): string[] {
  const collected = (messages ?? [])
    .filter((turn) => turn.role === "user")
    .map(turnText)
    .filter(Boolean);
  const next = input.trim();
  if (next) collected.push(next);
  return collected;
}

function topicConversationInput(userMessages: readonly string[]): string {
  const sections = userMessages.map((message, index) => `第 ${index + 1} 轮：\n${message.trim()}`);
  const kept: string[] = [];
  let remaining = MAX_PROMPT_LENGTH;
  for (let index = sections.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const section = sections[index];
    const value = section.length <= remaining ? section : section.slice(section.length - remaining);
    kept.unshift(value);
    remaining -= value.length + 2;
  }
  return kept.join("\n\n");
}

export async function generateSessionTopic(
  userMessages: readonly string[],
  cwd?: string,
  language?: string,
  ai: QuickCommitAiOptions = {},
): Promise<SessionTopic> {
  const input = topicConversationInput(userMessages);
  if (!input) throw new Error("没有可总结的用户消息。");
  const outputLanguage = language?.trim() || "与用户消息相同的语言";
  const prompt = [
    "请综合总结下面这段用户与编码助手对话中的所有用户消息，用于单个终端/会话的列表标题。",
    `使用${outputLanguage}输出。`,
    "只输出一个 JSON 对象，不要 Markdown、解释或额外文字。",
    '格式：{"title":"不超过20个字的具体主题标题","description":"不超过60个字的一句话任务描述"}',
    "标题必须概括该会话用户命令自己的具体工作，不要复述项目名、目录名或上级任务标题，也不要使用“关于”“请求”“任务”等空泛词。",
    "描述保留当前整体目标、关键对象和新增要求。",
    "后续轮次与前面目标有关时必须共同概括；发生目标切换时优先反映最新目标，同时保留仍有效的上下文。",
    "",
    "按发送顺序排列的用户消息：",
    input,
  ].join("\n");
  const raw = await callConfiguredAiText(prompt, cwd ?? process.cwd(), language ?? "", ai);
  const topic = parseTopic(raw);
  if (!topic) throw new Error("模型返回的会话主题格式无效。");
  return topic;
}

/**
 * Coalesces title refreshes per session. A newer user message invalidates an
 * in-flight result and is summarized together with every earlier user turn.
 */
export class SessionTopicCoordinator {
  private readonly states = new Map<string, PendingTopicState>();
  private disposed = false;

  constructor(
    private readonly generate: typeof generateSessionTopic = generateSessionTopic,
  ) {}

  request(sessionId: string, request: SessionTopicRequest): void {
    if (this.disposed) return;
    const input = request.input.trim();
    if (!input) return;
    let state = this.states.get(sessionId);
    if (!state) {
      state = {
        revision: 0,
        running: false,
        userMessages: collectSessionTopicMessages(request.messages, input),
        request,
      };
      this.states.set(sessionId, state);
    } else {
      state.userMessages.push(input);
      state.request = request;
    }
    state.revision += 1;
    if (!state.running) {
      state.running = true;
      request.onGenerating(true);
      void this.run(sessionId, state);
    }
  }

  clear(): void {
    this.disposed = true;
    this.states.clear();
  }

  private async run(sessionId: string, state: PendingTopicState): Promise<void> {
    const revision = state.revision;
    const request = state.request;
    const userMessages = state.userMessages.slice();
    try {
      const topic = await this.generate(
        userMessages,
        request.cwd,
        request.language,
        request.ai,
      );
      if (!this.disposed && this.states.get(sessionId) === state && state.revision === revision) {
        state.request.onTopic(topic);
      }
    } catch (error) {
      if (!this.disposed && this.states.get(sessionId) === state && state.revision === revision) {
        state.request.onError(error);
      }
    }

    if (this.disposed || this.states.get(sessionId) !== state) return;
    if (state.revision !== revision) {
      await this.run(sessionId, state);
      return;
    }
    state.running = false;
    state.request.onGenerating(false);
  }
}
