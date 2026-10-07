import { callConfiguredAiText, type QuickCommitAiOptions } from "./git-quick-commit.js";
import { employeeCliAvailable } from "./silicon-employee-dispatch.js";
import { SESSION_PROVIDERS, isSessionProvider } from "./session-provider.js";
import { isThinkingEffort } from "./structured-provider-common.js";
import {
  DEFAULT_WAND_TASK_AGENT_KIND,
  DEFAULT_WAND_TASK_AGENT_MODE,
  normalizeWandTaskAgentMode,
} from "./task-types.js";
import { clipAtWordBoundary } from "./text-utils.js";
import { agentKey, type SiliconEmployeeDraft } from "./ai-team-types.js";
import type { AiTextRequest } from "./types.js";
import type { WandTaskAgent } from "./task-types.js";
import type { SessionProvider } from "./types.js";

export class SiliconEmployeeDraftError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = "SiliconEmployeeDraftError";
  }
}

const NAME_MAX = 40;
const DUTY_MAX = 200;
const PROMPT_MAX = 20_000;
const EXPECTATION_MAX = 4_000;

/** 只用于提示词的 CLI 人话名；执行候选本身仍用 provider id。 */
const PROVIDER_LABELS: Record<SessionProvider, string> = {
  claude: "Claude Code",
  codex: "OpenAI Codex CLI",
  opencode: "OpenCode CLI",
  grok: "Grok Build CLI",
  qoder: "Qoder CLI",
  pi: "Pi coding agent",
  gemini: "Gemini CLI",
};

/** 硅基员工只能跑结构化会话；候选沿用看板的「跟随服务端默认」。 */
export function employeeAgentFor(provider: SessionProvider): WandTaskAgent {
  return {
    provider,
    model: "default",
    thinkingEffort: "off",
    mode: normalizeWandTaskAgentMode(provider, DEFAULT_WAND_TASK_AGENT_MODE),
    kind: DEFAULT_WAND_TASK_AGENT_KIND,
  };
}

/**
 * 已安装的 CLI：默认 provider 优先，其余按全局顺序；
 * 都没装时返回空数组，由调用方决定退回到哪一个首选。
 */
export function availableEmployeeProviders(
  preferred: SessionProvider = "claude",
  isAvailable: (agent: WandTaskAgent) => boolean = employeeCliAvailable,
): SessionProvider[] {
  const order: SessionProvider[] = [preferred, ...SESSION_PROVIDERS];
  const seen = new Set<SessionProvider>();
  const available: SessionProvider[] = [];
  for (const provider of order) {
    if (seen.has(provider)) continue;
    seen.add(provider);
    if (isAvailable(employeeAgentFor(provider))) available.push(provider);
  }
  return available;
}

function stripFences(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

/** 从模型输出里取第一个 JSON 对象，容忍前后夹带解释文字。 */
export function extractDraftJson(raw: string): Record<string, unknown> {
  const text = stripFences(raw);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new SiliconEmployeeDraftError("AI 没有返回可用的员工配置，请换个说法再试。", "DRAFT_INVALID_JSON");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new SiliconEmployeeDraftError("AI 返回的员工配置无法解析，请重试。", "DRAFT_INVALID_JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SiliconEmployeeDraftError("AI 返回的员工配置无法解析，请重试。", "DRAFT_INVALID_JSON");
  }
  return parsed as Record<string, unknown>;
}

function oneLine(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 解析一个执行候选。员工候选只允许结构化会话，provider 必须在允许集合内；
 * 模型只接受字符串（空即 "default"，跟随服务端默认），不静默改成别的资源。
 */
function parseEmployeeCandidate(raw: unknown, allowed: SessionProvider[]): WandTaskAgent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SiliconEmployeeDraftError("执行候选必须是对象。", "DRAFT_INVALID_AGENT", "agents");
  }
  const body = raw as Record<string, unknown>;
  const provider = stringValue(body.provider).toLowerCase();
  if (!isSessionProvider(provider)) {
    throw new SiliconEmployeeDraftError("请选择有效的执行工具。", "DRAFT_INVALID_PROVIDER", "provider");
  }
  if (allowed.length && !allowed.includes(provider)) {
    throw new SiliconEmployeeDraftError(
      `执行工具「${provider}」不在当前允许的候选集合（${allowed.join("、")}）里，请重新选择。`,
      "DRAFT_PROVIDER_NOT_ALLOWED", "provider",
    );
  }
  const model = stringValue(body.model) || "default";
  if (model.length > 128) {
    throw new SiliconEmployeeDraftError("模型名称过长。", "DRAFT_MODEL_TOO_LONG", "model");
  }
  const effort = stringValue(body.thinkingEffort) || "off";
  if (!isThinkingEffort(effort)) {
    throw new SiliconEmployeeDraftError("思考深度无效。", "DRAFT_INVALID_THINKING", "thinkingEffort");
  }
  const engine = stringValue(body.engine);
  if (engine && engine !== "cli" && engine !== "sdk") {
    throw new SiliconEmployeeDraftError("执行引擎无效。", "DRAFT_INVALID_ENGINE", "engine");
  }
  if (engine === "sdk" && provider !== "pi") {
    throw new SiliconEmployeeDraftError("SDK 执行引擎仅支持 Pi 结构化会话。", "DRAFT_INVALID_ENGINE", "engine");
  }
  return {
    provider,
    model,
    thinkingEffort: effort,
    mode: normalizeWandTaskAgentMode(provider, body.mode ?? DEFAULT_WAND_TASK_AGENT_MODE),
    kind: DEFAULT_WAND_TASK_AGENT_KIND,
    ...(engine === "sdk" ? { engine: "sdk" as const } : {}),
  };
}

export interface EmployeeDraftNormalizeOptions {
  allowedProviders?: SessionProvider[];
  fallbackProvider?: SessionProvider;
  existingNames?: string[];
  /** 结构化输入（HR 草稿 / API 直传）走严格模式：非法资源直接拒绝，不静默兜底。 */
  strict?: boolean;
}

/**
 * 唯一的草稿规范化/校验入口：模型输出与结构化草稿都经过这里。
 * 名字 / 角色设定缺失即视为不可用；strict=false 时 provider 不在允许集合内按候选顺序兜底，
 * strict=true 时拒绝并提示选择，避免把非法或越费用边界的资源悄悄换成别的。
 */
export function normalizeSiliconEmployeeDraft(
  record: Record<string, unknown>,
  options: EmployeeDraftNormalizeOptions = {},
): SiliconEmployeeDraft {
  const name = clipAtWordBoundary(oneLine(record, "name"), NAME_MAX);
  if (!name) throw new SiliconEmployeeDraftError("AI 没有给出员工名字，请重试。", "DRAFT_MISSING_NAME", "name");
  const duty = clipAtWordBoundary(oneLine(record, "duty"), DUTY_MAX);
  const prompt = typeof record.prompt === "string" ? record.prompt.trim().slice(0, PROMPT_MAX) : "";
  if (!prompt) {
    throw new SiliconEmployeeDraftError(
      options.strict ? "员工草稿缺少角色设定。" : "AI 没有给出员工角色设定，请重试。",
      "DRAFT_MISSING_PROMPT", "prompt",
    );
  }
  const duplicate = (options.existingNames ?? []).some(
    (existing) => existing.trim().toLowerCase() === name.toLowerCase(),
  );
  if (duplicate) {
    throw new SiliconEmployeeDraftError(
      `已有名叫「${name}」的员工，请换个名字。`, "DRAFT_DUPLICATE_NAME", "name",
    );
  }

  const allowed = options.allowedProviders?.length ? options.allowedProviders : [...SESSION_PROVIDERS];
  let candidates: WandTaskAgent[];
  if (Array.isArray(record.agents) && record.agents.length > 0) {
    candidates = record.agents.map((raw) => parseEmployeeCandidate(raw, allowed));
    if (new Set(candidates.map(agentKey)).size !== candidates.length) {
      throw new SiliconEmployeeDraftError("执行候选存在重复。", "DRAFT_DUPLICATE_AGENT", "agents");
    }
  } else if (record.agent !== undefined && record.agent !== null) {
    candidates = [parseEmployeeCandidate(record.agent, allowed)];
  } else if (options.strict) {
    if (!stringValue(record.provider)) {
      throw new SiliconEmployeeDraftError("员工草稿缺少执行候选。", "DRAFT_MISSING_AGENT", "provider");
    }
    candidates = [parseEmployeeCandidate(
      { provider: record.provider, model: record.model, thinkingEffort: record.thinkingEffort, mode: record.mode },
      allowed,
    )];
  } else {
    const requested = oneLine(record, "provider").toLowerCase();
    const provider = isSessionProvider(requested) && allowed.includes(requested)
      ? requested
      : options.fallbackProvider && allowed.includes(options.fallbackProvider)
        ? options.fallbackProvider
        : allowed[0]!;
    candidates = [employeeAgentFor(provider)];
  }
  return { name, duty, prompt, agent: candidates[0]!, candidates };
}

/**
 * 校验并收敛模型输出（宽松路径：非法 provider 在允许集合内按候选顺序兜底，
 * 不让员工带着跑不起来的 CLI 落库）。
 */
export function parseSiliconEmployeeDraft(
  raw: string,
  options: { allowedProviders?: SessionProvider[]; fallbackProvider?: SessionProvider; existingNames?: string[] } = {},
): SiliconEmployeeDraft {
  return normalizeSiliconEmployeeDraft(extractDraftJson(raw), options);
}

/** HR / 客户端已给出完整结构化草稿时走同一校验，不再调用模型。 */
export function validateStructuredEmployeeDraft(
  input: unknown,
  options: Omit<EmployeeDraftNormalizeOptions, "strict"> = {},
): SiliconEmployeeDraft {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SiliconEmployeeDraftError("员工草稿必须是对象。", "DRAFT_INVALID_DRAFT");
  }
  return normalizeSiliconEmployeeDraft(input as Record<string, unknown>, { ...options, strict: true });
}

/** 规则走系统提示，用户的期望走用户消息；一次性调用沿用系统 AI 通道。 */
export function buildEmployeeDraftPrompt(
  expectation: string,
  providers: SessionProvider[],
  existingNames: string[] = [],
): AiTextRequest {
  const list = providers.length ? providers : [...SESSION_PROVIDERS];
  const lines = [
    "你正在帮用户创建一位「硅基员工」：一个长期负责某类工作的 AI 角色，之后会以结构化会话执行任务。",
    "根据用户对这位员工的期望，设计一份配置，只输出一个 JSON 对象（不要 Markdown 代码块，不要任何解释）：",
    '{"name":"员工名字","duty":"一句话职责","prompt":"角色设定","provider":"执行工具"}',
    "",
    "字段要求：",
    "- name：2-8 个中文，具体、好记、体现职能（如「前端小匠」「接口守夜人」）；不要「助手」「AI」这类空泛词，不要带标点。",
    "- duty：一句话职责，15-40 个字，说清它负责什么、交付什么，会显示在侧栏和消息署名里。",
    "- prompt：角色设定（系统提示），用第二人称「你」写给这位员工，分点写清专业能力、工作要求、交付标准与协作习惯，300-600 字；不要复述用户原话，不要写具体项目或文件名。",
    `- provider：执行工具，只能取 ${list.map((provider) => `"${provider}"（${PROVIDER_LABELS[provider]}）`).join("、")} 之一，挑最适合这项工作的。`,
  ];
  if (existingNames.length) {
    lines.push(`- 不要与已有员工重名：${existingNames.slice(0, 20).join("、")}。`);
  }
  return { system: lines.join("\n"), prompt: `用户对这位员工的期望：\n${expectation}` };
}

/** 按自然语言期望生成员工配置；调用方负责随后落库。 */
export async function generateSiliconEmployeeDraft(
  expectation: string,
  ai: QuickCommitAiOptions = {},
  options: {
    cwd?: string;
    language?: string;
    existingNames?: string[];
    preferredProvider?: SessionProvider;
    isProviderAvailable?: (agent: WandTaskAgent) => boolean;
  } = {},
): Promise<SiliconEmployeeDraft> {
  const trimmed = expectation.trim();
  if (!trimmed) {
    throw new SiliconEmployeeDraftError("先说说你对这位员工的期望吧。", "EMPTY_EXPECTATION");
  }
  if (trimmed.length > EXPECTATION_MAX) {
    throw new SiliconEmployeeDraftError(
      `期望描述太长了（${trimmed.length} 字），请精简到 ${EXPECTATION_MAX} 字以内。`,
      "EXPECTATION_TOO_LONG",
    );
  }
  const available = availableEmployeeProviders(options.preferredProvider, options.isProviderAvailable);
  const providers = available.length ? available : [options.preferredProvider ?? "claude", ...SESSION_PROVIDERS];
  const request = buildEmployeeDraftPrompt(trimmed, providers, options.existingNames);
  try {
    return await callConfiguredAiText(request, options.cwd || process.cwd(), options.language ?? "", ai,
      (raw) => parseSiliconEmployeeDraft(raw, {
        allowedProviders: providers, fallbackProvider: providers[0], existingNames: options.existingNames,
      }));
  } catch (error) {
    if (error instanceof SiliconEmployeeDraftError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new SiliconEmployeeDraftError(message || "AI 生成员工配置失败。", "DRAFT_AI_FAILED");
  }
}
