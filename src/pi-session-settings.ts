/** Shared, data-only contract for per-session Pi settings. */
export const PI_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export type PiBuiltinTool = typeof PI_BUILTIN_TOOLS[number];
/**
 * pi-goal 注册的工具名。Pi 的 `--tools` 是白名单（会替换默认集合），所以 CLI 会话要开启目标模式
 * 必须逐个点名；名字与 `core-extension-host.ts` 的排除列表保持同一份。
 */
export const PI_GOAL_TOOLS = ["create_goal", "get_goal", "update_goal"] as const;
export interface PiSessionSettings {
  codemode: "off" | "on" | "only";
  /** Optional per-session CLI override; omitted means Pi's own CodeMode setting. */
  codemodeOverride?: "off" | "on" | "only";
  globalTools: boolean;
  goalMode: boolean;
  tools: PiBuiltinTool[];
  localDecision: boolean;
  autoCompaction: boolean;
  /** Omitted on legacy sessions = existing Pi discovery; present = exact, opt-in resources. */
  resources?: PiResourceSelection;
  /** Skill IDs whose current on/off state automatic selection must preserve. Manual edits remain allowed. */
  lockedSkills?: string[];
  /** Explicit opt-in: select unlocked skills per prompt; preserve skill locks and manual MCP selections. */
  autoResources?: boolean;
}

export type PiSessionSettingsPatch = Omit<Partial<PiSessionSettings>, "codemodeOverride"> & {
  codemodeOverride?: "off" | "on" | "only" | null;
};

export interface PiResourceSelection {
  skills: string[];
  mcpServers: string[];
}

export type PiSkillMode = "off" | "on" | "locked";

export function piSkillMode(settings: PiSessionSettings, id: string): PiSkillMode {
  return !settings.resources?.skills.includes(id) ? "off" : settings.lockedSkills?.includes(id) ? "locked" : "on";
}

/** A single manual gesture changes selection and lock atomically, never mutating its snapshot. */
export function piSkillModePatch(settings: PiSessionSettings, id: string, mode: PiSkillMode): PiSessionSettingsPatch {
  const resources = settings.resources ?? { skills: [], mcpServers: [] };
  const locks = settings.lockedSkills ?? [];
  return {
    resources: { ...resources, skills: mode === "off" ? resources.skills.filter((value) => value !== id)
      : [...new Set([...resources.skills, id])] },
    lockedSkills: mode === "locked" ? [...new Set([...locks, id])] : locks.filter((value) => value !== id),
  };
}

export interface PiResourceSelectionNotice {
  status: "selecting" | "selected" | "fallback" | "cancelled";
  label: string;
  skills: string[];
  mcpServers: string[];
  codemode?: { mode: "off" | "on" | "only" | "follow"; source: "manual" | "automatic" | "uncertain" | "fallback" };
}

export interface PiResourceItem {
  id: string;
  name: string;
  description: string;
  source: string;
}

export interface PiResourceRecommendation {
  selection: PiResourceSelection;
  resources: Array<{ id: string; kind: "skills" | "mcpServers";
    status: "recommended" | "unmatched" | "uncertain" | "unassessed"; source: "explicit" | "local" }>;
  calls: number;
  experimental: true;
}

export interface PiResourceCatalog {
  skills: PiResourceItem[];
  mcpServers: PiResourceItem[];
  /** Listing does not connect to any server or evaluate credentials. */
  supported: boolean;
  reason: string;
}

export function patchPiResourceSelection(raw: unknown): PiResourceSelection {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("请选择有效的 Skills / MCP 列表。");
  const item = raw as Record<string, unknown>;
  if (Object.keys(item).some((key) => key !== "skills" && key !== "mcpServers")) {
    throw new Error("资源选择不能包含路径、命令或其他设置。");
  }
  const ids = (key: string): string[] => {
    const value = item[key];
    if (!Array.isArray(value) || value.length > 64 || new Set(value).size !== value.length
      || value.some((id) => typeof id !== "string" || !/^(?:skill-[a-f0-9]{24}|mcp-[a-f0-9]{24})$/.test(id))) {
      throw new Error("资源选择必须是无重复的已安装资源 ID（每类最多64项）。");
    }
    return [...value];
  };
  return { skills: ids("skills"), mcpServers: ids("mcpServers") };
}

export function defaultPiSessionSettings(autoCompaction = true): PiSessionSettings {
  return { codemode: "off", globalTools: false, goalMode: false,
    tools: ["read", "bash", "edit", "write"], localDecision: true, autoCompaction };
}

/**
 * CLI 会话的出厂默认：完全跟随 Pi 自身配置（默认工具 + 已安装的全局扩展 + codemode），
 * 与直接在终端里跑 `pi` 一致——用户已经装好的子代理、待办、CodeMode 不该因为从 Wand 启动就消失。
 * 想逐项挑选工具时再关掉「全局扩展工具」，会话就切到 Wand 托管的 `--tools` 白名单。
 * 进程内 SDK 会话仍用 `defaultPiSessionSettings`：员工会话不静默继承用户的全局扩展。
 */
export function defaultPiCliSessionSettings(autoCompaction = true): PiSessionSettings {
  return { ...defaultPiSessionSettings(autoCompaction), globalTools: true,
    resources: { skills: [], mcpServers: [] }, autoResources: false };
}

/** Strict partial updates: an invalid/unknown field never silently enables a capability. */
export function patchPiSessionSettings(current: PiSessionSettings, raw: unknown): PiSessionSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Pi 设置必须是对象。");
  const next = { ...current, tools: [...current.tools] };
  for (const [key, value] of Object.entries(raw)) {
    if (key === "codemodeOverride") {
      if (value === null) delete next.codemodeOverride;
      else if (value === "off" || value === "on" || value === "only") next.codemodeOverride = value;
      else throw new Error("CodeMode 请选择跟随 Pi、关闭、启用或仅 CodeMode。");
    } else if (key === "resources") {
      next.resources = patchPiResourceSelection(value);
    } else if (key === "lockedSkills") {
      if (!Array.isArray(value) || value.length > 64 || new Set(value).size !== value.length
        || value.some((id) => typeof id !== "string" || !/^skill-[a-f0-9]{24}$/.test(id))) {
        throw new Error("锁定技能必须是无重复的已安装 Skill ID（最多64项）。");
      }
      next.lockedSkills = [...value];
    } else if (key === "codemode") {
      if (value !== "off" && value !== "on" && value !== "only") throw new Error("CodeMode 必须是 off、on 或 only。");
      next.codemode = value;
    } else if (key === "tools") {
      if (!Array.isArray(value) || value.length > PI_BUILTIN_TOOLS.length
        || value.some((tool) => !PI_BUILTIN_TOOLS.includes(tool)) || new Set(value).size !== value.length) {
        throw new Error("基础工具必须是无重复的 Pi 工具列表。");
      }
      next.tools = [...value] as PiBuiltinTool[];
    } else if (key === "globalTools" || key === "goalMode" || key === "localDecision" || key === "autoCompaction" || key === "autoResources") {
      if (typeof value !== "boolean") throw new Error(`${key} 必须是是否启用（boolean）。`);
      next[key] = value;
    } else {
      throw new Error(`未知 Pi 设置：${key}`);
    }
  }
  return next;
}

/**
 * CLI 会话的工具选择策略。
 *
 * Pi CLI 的 `--tools` 是**白名单**：一旦给出，未列出的工具（含扩展工具、codemode、目标工具）
 * 都不在注册表里；不给出时才用 Pi 自身的 `defaultTools` + 全部扩展工具。因此只有两条真实可表达的路径：
 *
 * - `allowlist`：Wand 逐项接管——只启用勾选的基础工具，CodeMode / 目标模式按开关把工具名追加进白名单。
 * - `config`：`globalTools` 打开时完全跟随 Pi 自身配置（默认工具 + 已安装的全局扩展），
 *   逐项开关在该模式下不参与启动参数，UI 会如实说明而不是伪造生效。
 */
export interface PiToolSelection {
  mode: "allowlist" | "config";
  names: string[];
}

/**
 * `codemode: "only"`（连声明都藏起来、只从脚本调用）由 Pi 的 `codemode.mode` 设置决定，
 * 没有对应的 CLI 开关：CLI 会话一律按「启用」处理，读取时也归一到 `on`，不谎报模式。
 */
export function cliCodemode(codemode: PiSessionSettings["codemode"]): "off" | "on" {
  return codemode === "off" ? "off" : "on";
}

/** 会话设置在该引擎下真正生效的形态（目前只有 CLI 的 CodeMode 需要归一）。 */
export function effectivePiSessionSettings(settings: PiSessionSettings, engine: "core" | "cli"): PiSessionSettings {
  return engine === "cli" ? { ...settings, codemode: cliCodemode(settings.codemode) } : settings;
}

export function piToolSelection(settings: PiSessionSettings): PiToolSelection {
  if (settings.globalTools) return { mode: "config", names: [] };
  const names: string[] = [...settings.tools];
  const codemode = settings.codemodeOverride ?? cliCodemode(settings.codemode);
  if (codemode !== "off") names.push("codemode");
  if (settings.goalMode) names.push(...PI_GOAL_TOOLS);
  return { mode: "allowlist", names };
}

export interface PiSettingsResponse {
  settings: PiSessionSettings;
  available: boolean;
  reason: string;
  engine: "core" | "cli";
  /** CLI Pi 支持的基础工具 allowlist；core/SDK 专属开关仍由 available 表示。 */
  toolsAvailable: boolean;
  goalAvailable: boolean;
  globalExtensions: string[];
  localDecisionAvailable: boolean;
  /**
   * 逐项可用性由服务端裁决；客户端只按这里禁用，不再自己推断引擎。
   * 早期服务端不带这个字段，客户端必须用 `piSettingsControls()` 退回它当时的真实能力，
   * 不能假装开关可用（写了也不会生效）。
   */
  controls?: PiSettingsControls;
  /** Absent on older servers. Never contains file paths, URLs, commands, env or credentials. */
  resourceCatalog?: PiResourceCatalog;
  /** Read-only recommendation; applying remains a separate, explicit settings update. */
  recommendationAvailable?: boolean;
  recommendationReason?: string;
  autoResourcesAvailable?: boolean;
  autoResourcesReason?: string;
  /** Older automatic-resource servers do not infer CodeMode. */
  autoCodemodeAvailable?: boolean;
  /** Absent on older servers; clients must not pretend skill locks are supported. */
  skillLocksAvailable?: boolean;
}

export interface PiSettingsControls {
  tools: boolean;
  codemode: boolean;
  /** 是否提供「仅 CodeMode」（只有进程内 SDK 会话能表达）。 */
  codemodeOnly: boolean;
  /** Per-turn bridge supports exact off/on/only, independent of globalTools. */
  codemodeOverride?: boolean;
  globalTools: boolean;
  goalMode: boolean;
  localDecision: boolean;
  autoCompaction: boolean;
}

export const NO_PI_SETTINGS_CONTROLS: PiSettingsControls = Object.freeze({
  tools: false, codemode: false, codemodeOnly: false, globalTools: false,
  goalMode: false, localDecision: false, autoCompaction: false,
});

/**
 * 面板逐项可用性。新服务端直接给 `controls`；没有这个字段的旧服务端按它当时的语义退回：
 * SDK 原生开关看 `available`，CLI 只开放基础工具列表，其余一律不可改。
 */
export function piSettingsControls(response: Partial<PiSettingsResponse> | null | undefined): PiSettingsControls {
  if (!response) return NO_PI_SETTINGS_CONTROLS;
  if (response.controls) return response.controls;
  const sdk = response.available === true;
  return {
    tools: sdk || response.toolsAvailable === true,
    codemode: sdk,
    codemodeOnly: sdk,
    globalTools: sdk,
    goalMode: sdk && response.goalAvailable === true,
    localDecision: sdk && response.localDecisionAvailable === true,
    autoCompaction: sdk,
  };
}

/** CLI 会话能表达的设置字段；其余字段只对进程内 SDK 会话有意义。 */
export const PI_CLI_SETTING_KEYS = ["tools", "codemode", "globalTools", "goalMode", "localDecision", "resources", "lockedSkills", "codemodeOverride", "autoResources"] as const;

/**
 * CLI 会话的写入裁决：无法表达的字段/取值直接拒绝，不能存下一条永远不会生效的设置。
 * 返回拒绝原因，允许时返回 null。
 */
export function cliPiSettingsRejection(raw: unknown, next: PiSessionSettings): string | null {
  const keys = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw) : [];
  const unsupported = keys.filter((key) => !(PI_CLI_SETTING_KEYS as readonly string[]).includes(key));
  if (unsupported.length) {
    return `Pi CLI 会话不支持这些设置：${unsupported.join("、")}（仅原生 SDK 可用）。`;
  }
  if (keys.includes("codemode") && next.codemode === "only") {
    return "「仅 CodeMode」需要原生 SDK；CLI 会话只能选择启用或关闭。";
  }
  return null;
}

/** Only settings commands, never paths, extension commands, or ordinary slash-prefixed text. */
export function isPiSettingsDraft(text: string): boolean {
  const value = text.trim();
  return value === "/" || ["/settings", "/codemode", "/tools", "/goal-mode"].some((command) =>
    value.length > 1 && command.startsWith(value));
}
