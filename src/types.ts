export type SessionKind = "pty" | "structured";
export type SessionProvider = "claude" | "codex" | "opencode" | "grok" | "qoder" | "pi";
export type CommitAiSource = "cli" | "api";
export type SessionRunner = "claude-cli" | "claude-cli-print" | "claude-sdk" | "codex-cli-exec" | "opencode-cli-run" | "grok-cli-headless" | "qoder-cli-print" | "pi-cli-json" | "pty";
export type SessionSource = "interactive" | "automation" | "startup";

export type ExecutionMode = "assist" | "agent" | "agent-max" | "default" | "auto-edit" | "full-access" | "native" | "managed";

export type AutonomyPolicy = "assist" | "agent" | "agent-max";
export type ApprovalPolicy = "ask-every-time" | "approve-once" | "remember-this-turn";
export type EscalationScope = "write_file" | "run_command" | "network" | "outside_workspace" | "dangerous_shell" | "unknown";
export type EscalationRunner = "json" | "pty";
export type EscalationResolution = "approve_once" | "approve_turn" | "deny" | "fallback_manual";
export type EscalationSource = "tool_permission_request" | "sandbox_hard_block" | "workspace_policy_limit" | "cli_capability_limit" | "unknown";

/** WebSocket / ProcessManager event envelope used throughout the app. */
export interface ProcessEvent {
  type: "output" | "status" | "started" | "ended" | "usage" | "task" | "notification";
  sessionId: string;
  data?: unknown;
  /** Monotonic per-session sequence stamped by the WS broadcast layer for
   *  output events. Lets clients spot gaps caused by backpressure drops. */
  seq?: number;
}

export type ProcessEventHandler = (event: ProcessEvent) => void;

export interface EscalationRequest {
  requestId: string;
  scope: EscalationScope;
  runner: EscalationRunner;
  source: EscalationSource;
  resolution?: EscalationResolution;
  target?: string;
  reason: string;
}

export interface TurnRequest {
  message: string;
  autonomyPolicy?: AutonomyPolicy;
  approvalPolicy?: ApprovalPolicy;
  allowedScopes?: EscalationScope[];
}

export interface CommandPreset {
  label: string;
  command: string;
  mode?: ExecutionMode;
}

export interface StructuredChatPersonaRoleConfig {
  name?: string;
  avatar?: string;
}

export interface StructuredChatPersonaConfig {
  user?: StructuredChatPersonaRoleConfig;
  assistant?: StructuredChatPersonaRoleConfig;
}

export interface CardExpandDefaults {
  /** Edit/Write/MultiEdit diff cards (default: false) */
  editCards?: boolean;
  /** Read/Glob/Grep/WebFetch/WebSearch inline tools (default: false) */
  inlineTools?: boolean;
  /** Bash terminal output (default: false) */
  terminal?: boolean;
  /** Thinking blocks (default: false) */
  thinking?: boolean;
  /** Tool groups (default: false) */
  toolGroup?: boolean;
}

export interface AndroidApkConfig {
  enabled?: boolean;
  apkDir?: string;
  currentApkFile?: string;
}

export interface MacosDmgConfig {
  enabled?: boolean;
  dmgDir?: string;
  currentDmgFile?: string;
}

export interface IosIpaConfig {
  enabled?: boolean;
  ipaDir?: string;
  currentIpaFile?: string;
}

export interface WandConfig {
  host: string;
  port: number;
  /** Enable HTTPS with self-signed certificate (default: false) */
  https?: boolean;
  /**
   * 可选：使用用户自备的 TLS 证书/私钥（PEM 格式）。配了 `certPath` + `keyPath`
   * 且文件可读时，将跳过自签证书生成。用 mkcert/Let's Encrypt 等签的证书时，
   * 浏览器可直接信任 HTTPS 连接。
   */
  tls?: {
    certPath?: string;
    keyPath?: string;
  };
  password: string;
  /** 新建会话时默认使用的 Provider。 */
  defaultProvider?: SessionProvider;
  /** 新建会话时默认使用的承载类型。 */
  defaultSessionKind?: SessionKind;
  defaultMode: ExecutionMode;
  shell: string;
  defaultCwd: string;
  startupCommands: string[];
  allowedCommandPrefixes: string[];
  commandPresets: CommandPreset[];
  structuredChatPersona?: StructuredChatPersonaConfig;
  /** Max total size (bytes) for shortcut interaction logs per session (default: 10 MB). Set 0 to disable logging. */
  shortcutLogMaxBytes?: number;
  /** Preferred response language for Claude (e.g. "中文", "English"). Empty string means no override. */
  language?: string;
  /** Per-instance secret for app connection code encryption. Auto-generated on first run. */
  appSecret?: string;
  android?: AndroidApkConfig;
  macos?: MacosDmgConfig;
  ios?: IosIpaConfig;
  /** Default expand/collapse state for card types in structured chat view */
  cardDefaults?: CardExpandDefaults;
  /** 新建会话时默认使用的 Claude 模型（别名或完整 ID）。留空则不传 --model，由 claude 自行决定。 */
  defaultModel?: string;
  /** 新建 Codex 会话时默认使用的模型。留空则不传 --model，由 codex 自行决定。 */
  defaultCodexModel?: string;
  /** 新建 OpenCode 会话时默认使用的 provider/model。留空则由 opencode 自行决定。 */
  defaultOpenCodeModel?: string;
  /** 新建 Grok 会话时默认使用的模型。留空则不传 --model，由 grok 自行决定。 */
  defaultGrokModel?: string;
  /** 新建 Qoder 会话时默认使用的模型层级。留空则由 qodercli 自行决定。 */
  defaultQoderModel?: string;
  /** 新建 Pi 会话时默认使用的 provider/model pattern。 */
  defaultPiModel?: string;
  /** 快捷提交生成 commit message / tag 时使用的 CLI。 */
  commitCli?: SessionProvider;
  /** 快捷提交专用模型。留空则跟随所选 CLI 的默认模型。 */
  commitModel?: string;
  /** 快捷提交生成 commit message / tag 时使用 CLI 或直连 API。 */
  commitAiSource?: CommitAiSource;
  /** Wand 自身轻量 AI 功能与 Commit 直连模式复用的 API 配置。 */
  systemAi?: SystemAiConfig;
  /** 新建会话时默认使用的思考深度。 */
  defaultThinkingEffort?: ThinkingEffort;
  /** 结构化会话使用的 runner: "cli"（默认，spawn claude -p）或 "sdk"（@anthropic-ai/claude-agent-sdk）。 */
  structuredRunner?: "cli" | "sdk";
  /**
   * 启动 PTY / 结构化子进程时是否继承父进程的环境变量（process.env）。默认 true。
   * 关闭后子进程仅获得最小可用环境（PATH/HOME/SHELL/LANG/LC_ALL/TERM 等）外加 WAND_* 控制变量，
   * 用于隔离敏感凭据或避免 API key 泄漏到子命令。
   */
  inheritEnv?: boolean;
}

export type SystemAiProtocol = "openai" | "anthropic";
export type SystemAiAuthHeader = "bearer" | "x-api-key";

export interface SystemAiConfig {
  /** 设置页路由的稳定标识，用于重排后安全地关联已保存密钥。 */
  id?: string;
  enabled: boolean;
  protocol: SystemAiProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  authHeader?: SystemAiAuthHeader;
  /** 自动导入时记录来源，仅用于设置页说明。 */
  source?: "claude" | "codex" | "opencode" | "grok" | "custom";
  /**
   * 其余可直连 API，按数组顺序依次尝试。保留顶层字段作为首选项，
   * 以兼容已有配置与手工编辑入口。
   */
  fallbacks?: SystemAiConfig[];
}

export type ClaudeModelSource = "builtin" | "configured" | "verified-cache" | "models-api";
export type ClaudeModelAvailability = "default" | "candidate" | "verified" | "stale";

export interface ClaudeModelInfo {
  /** 传给 --model 的值（别名或完整模型 ID） */
  id: string;
  /** UI 显示的友好标签 */
  label: string;
  /** 可选备注：例如 "当前默认"、"最新" */
  note?: string;
  /** 是否为别名（opus/sonnet 等）；完整 ID 为 false */
  alias?: boolean;
  /** Claude 候选的来源；Codex / OpenCode 动态结果通常不提供。 */
  source?: ClaudeModelSource;
  /** Claude Code 默认、候选、已验证或版本/时限过期的验证记录。 */
  availability?: ClaudeModelAvailability;
  /** 最近一次由 Claude Code CLI 成功验证的时间。 */
  lastVerifiedAt?: string;
  /** 完成最近一次验证时的 Claude Code CLI 版本。 */
  verifiedWithClaudeVersion?: string;
  /** Codex 模型声明的可用推理档位；Claude 模型通常不提供。 */
  reasoningEfforts?: ReasoningEffortInfo[];
  /** Codex 模型的默认推理档位。 */
  defaultReasoningEffort?: string;
}

export interface ReasoningEffortInfo {
  effort: string;
  description?: string;
}

/**
 * 旧的四档值需要继续兼容已有会话。Codex 动态档位加 provider 前缀，
 * 避免 `max`（旧值代表 xhigh）与 Codex 新增的原生 max 档位冲突。
 */
export type ThinkingEffort = "off" | "standard" | "deep" | "max" | `codex:${string}`;

export interface WorktreeInfo {
  branch: string;
  path: string;
  /** Git ref each task worktree was created from. */
  baseRef?: string;
  /** Main checkout root, used by task review without rediscovering it. */
  repoRoot?: string;
}

export interface WorktreeMergeInfo {
  targetBranch?: string;
  mergedAt?: string;
  mergeCommit?: string;
  cleanupDone?: boolean;
  lastError?: string;
  conflict?: boolean;
}

export interface WorktreeMergeCommit {
  hash: string;
  shortHash: string;
  subject: string;
}

export interface WorktreeMergeCheckResult {
  ok: boolean;
  sourceBranch: string;
  targetBranch: string;
  worktreePath: string;
  repoRoot: string;
  hasUncommittedChanges: boolean;
  aheadCount: number;
  hasConflicts: boolean;
  recommendedAction: "merge" | "noop" | "resolve-conflict";
  reason?: string;
  /** Newest-first commit preview for project-level worktree review. */
  commits: WorktreeMergeCommit[];
}

export interface WorktreeMergeResult {
  ok: boolean;
  sourceBranch: string;
  targetBranch: string;
  repoRoot: string;
  mergeCommit?: string;
  mergedAt?: string;
  cleanupDone: boolean;
  conflict: boolean;
  errorCode?: string;
  reason?: string;
}

export interface GitStatusFileEntry {
  path: string;
  /** Two-char porcelain status (e.g. " M", "MM", "??", "A ") */
  status: string;
  /** True 当条目是 submodule（来源于 porcelain v2 的 sub 字段第一位为 S）。 */
  isSubmodule?: boolean;
  /** submodule 子状态：指针是否变化 / 内部是否 dirty / 是否有未跟踪文件。 */
  submoduleState?: {
    commitChanged: boolean;
    hasTrackedChanges: boolean;
    hasUntracked: boolean;
  };
}

export interface GitStatusResult {
  isGit: boolean;
  branch?: string;
  /** Number of files with any change (modified / added / deleted / untracked). */
  modifiedCount?: number;
  files?: GitStatusFileEntry[];
  head?: string;
  repoRoot?: string;
  /** Truthy when the repo has no commits yet (initial state). */
  initialCommit?: boolean;
  /** Upstream tracking branch (e.g. `origin/main`). Absent when none is configured. */
  upstream?: string;
  /** Number of local commits not yet on upstream. Only meaningful when `upstream` is set. */
  ahead?: number;
  /** Number of upstream commits not yet locally. Only meaningful when `upstream` is set. */
  behind?: number;
  /** HEAD commit subject + short hash (handy for "tag the current commit" UX). */
  lastCommit?: { hash: string; shortHash: string; subject: string };
  /** Most recent tag reachable from HEAD (`git describe --tags --abbrev=0`), if any. */
  latestTag?: string;
  /** True 当仓库声明了 submodule（任一改动条目为 submodule）。前端据此决定是否渲染 Submodule 球。 */
  hasSubmodule?: boolean;
  error?: string;
}

export interface QuickCommitResult {
  ok: boolean;
  commit?: { hash: string; message: string };
  tag?: { name: string };
  pushed?: boolean;
  /** commit 已成功但 push 失败时填入；前端用它显示"已提交但 push 失败"。 */
  pushError?: string;
  /**
   * 父仓库 commit 之前，先在 submodule 内单独提交的记录。仅包含 internal dirty
   * 或 untracked 触发的 submodule 提交；纯指针变化（commitChanged）不会进来。
   */
  submoduleCommits?: { path: string; hash: string }[];
}

export interface TagHeadResult {
  ok: boolean;
  tag: { name: string; commit: string };
  pushed?: boolean;
  pushError?: string;
}

export interface PushResult {
  ok: boolean;
  pushedCommits: boolean;
  pushedTags: boolean;
  /** Either operation failed — the other may still have succeeded. */
  error?: string;
}

export interface CommandRequest {
  command?: string;
  /** Start the configured login shell without launching a provider CLI. */
  shell?: boolean;
  provider?: SessionProvider;
  cwd?: string;
  mode?: ExecutionMode;
  initialInput?: string;
  worktreeEnabled?: boolean;
  /** 模型（别名或完整 ID）。留空则按 provider 回落到服务端默认模型。 */
  model?: string;
  /** 创建会话时由前端测得的真实列数。后端用它直接 spawn PTY，避免"先 120 列再 resize"的早期错位。 */
  cols?: number;
  /** 创建会话时由前端测得的真实行数。 */
  rows?: number;
  /** 思考深度。null/缺省 视为 off（不启用思考）。 */
  thinkingEffort?: ThinkingEffort | null;
  /** 创建会话时绑定到的工作空间 ID（多标签 / 分屏项目）。 */
  workspaceId?: string;
  /** 创建会话时绑定到的工作空间任务 ID（任务 = 独立 worktree + 一组标签）。 */
  workspaceTaskId?: string;
}

export interface InputRequest {
  input?: string;
  /**
   * Structured sessions normally keep the HTTP request open until the whole
   * turn finishes. Native clients can opt into an accepted snapshot instead
   * and continue receiving progress through the existing event stream.
   */
  respondImmediately?: boolean;
  /** PTY input can request a small acknowledgement instead of a full session detail payload. */
  responseMode?: "snapshot" | "accepted";
  /** Current UI view: "chat" or "terminal". Chat view uses PTY-derived structured messages. */
  view?: "chat" | "terminal";
  autonomyPolicy?: AutonomyPolicy;
  approvalPolicy?: ApprovalPolicy;
  allowedScopes?: EscalationScope[];
  turn?: TurnRequest;
  /** Shortcut key name that triggered this input (e.g. "enter", "yes", "ctrl_c"). Used for interaction logging in managed/full-access modes. */
  shortcutKey?: string;
}

export interface ResizeRequest {
  cols?: number;
  rows?: number;
}

export interface PathSuggestion {
  path: string;
  name: string;
  isDirectory: boolean;
}

export interface GitFileStatus {
  staged?: 'modified' | 'added' | 'deleted' | 'renamed';
  unstaged?: 'modified' | 'deleted';
  untracked?: boolean;
}

export interface FileEntry {
  path: string;
  name: string;
  type: 'dir' | 'file';
  gitStatus?: GitFileStatus;
  /** File size in bytes; absent for directories. */
  size?: number;
  /** ISO timestamp of the last modification. */
  mtime?: string;
}

export interface DirectoryListing {
  items: FileEntry[];
  /** True when the result was capped before all entries were returned. */
  truncated: boolean;
  /** Total number of entries in the directory (before truncation). */
  total: number;
}

export type FilePreviewKind =
  | "text"
  | "image"
  | "pdf"
  | "video"
  | "audio"
  | "binary";

export interface FilePreviewResponse {
  kind: FilePreviewKind;
  path: string;
  name: string;
  ext: string;
  size: number;
  mime?: string;
  /** Detected language for text/code; only present when kind === "text". */
  lang?: string;
  /** File content; only present when kind === "text". */
  content?: string;
}

// ── Structured chat message types derived from PTY output ──

/**
 * Meta marker attached to blocks emitted by a Task-spawned subagent. Present
 * on every block (text / thinking / tool_use / tool_result) whose origin is a
 * subagent's stream rather than the main assistant. Drives the multi-persona
 * chat rendering ("third cat joining the conversation").
 *
 * `taskId` is the parent Task tool_use id (= SDK's `parent_tool_use_id`).
 * The parent Task tool_use block itself is NOT marked — it lives in the
 * main assistant's stream.
 */
export interface SubagentMeta {
  taskId: string;
  agentType?: string;
  taskDescription?: string;
}

export interface TextBlock {
  type: "text";
  text: string;
  __subagent?: SubagentMeta;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  __subagent?: SubagentMeta;
}

export interface StructuredQuestionOption {
  label: string;
  description?: string;
}

export interface StructuredQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: StructuredQuestionOption[];
}

export interface StructuredTaskItem {
  id: string;
  content: string;
  status: string;
  activeForm?: string;
}

/**
 * Wand-owned semantic projection of provider-specific tools. Clients should
 * render this field and treat `name` / `input` as a legacy fallback only.
 */
export type ToolUseSemantic =
  | { kind: "question_request"; questions: StructuredQuestion[] }
  | { kind: "task_list"; items: StructuredTaskItem[] };

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  description?: string;
  input: Record<string, unknown>;
  semantic?: ToolUseSemantic;
  __subagent?: SubagentMeta;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: string; [key: string]: unknown }>;
  is_error?: boolean;
  /** When true, content has been truncated for transport. Client should fetch full content via API. */
  _truncated?: boolean;
  __subagent?: SubagentMeta;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

export interface ConversationTurn {
  role: "user" | "assistant";
  content: ContentBlock[];
  /** Optional usage metadata when available from the underlying tool. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    /** codex 专属：reasoning_output_tokens（GPT-5 等带思考模型，per-turn 计费）。 */
    reasoningOutputTokens?: number;
    totalCostUsd?: number;
    /** True while the live value is estimated; omitted once the provider reports final usage. */
    estimated?: boolean;
  };
}

export interface StructuredSessionState {
  provider?: SessionProvider;
  runner: SessionRunner;
  model?: string;
  lastError: string | null;
  inFlight: boolean;
  activeRequestId: string | null;
}

export interface SessionSnapshot {
  id: string;
  /** 会话创建来源。旧数据和缺省值按 interactive 处理。 */
  sessionSource?: SessionSource;
  /** 自动化创建会话时关联的自动化任务 ID。 */
  automationId?: string;
  /** 所属工作空间 ID（多标签 / 分屏项目）。会话在该工作空间窗口内作为一个标签。 */
  workspaceId?: string;
  /** 所属工作空间任务 ID；任务独占一个 worktree，其下所有会话共享该 worktree 目录。 */
  workspaceTaskId?: string;
  sessionKind?: SessionKind;
  provider?: SessionProvider;
  /** True while the provider CLI owns the PTY; false after it returns to the persistent shell. */
  providerCliActive?: boolean;
  /** Provider CLI exit status; separate from exitCode, which belongs to the persistent PTY shell. */
  providerCliExitCode?: number | null;
  runner?: SessionRunner;
  command: string;
  cwd: string;
  mode: ExecutionMode;
  worktreeEnabled?: boolean;
  worktree?: WorktreeInfo | null;
  worktreeMergeStatus?: "ready" | "checking" | "merging" | "merged" | "failed";
  worktreeMergeInfo?: WorktreeMergeInfo | null;
  autonomyPolicy?: AutonomyPolicy;
  approvalPolicy?: ApprovalPolicy;
  allowedScopes?: EscalationScope[];
  status: "idle" | "running" | "exited" | "failed" | "stopped";
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  output: string;
  archived: boolean;
  archivedAt: string | null;
  /** Backward-compatible derived flag from pendingEscalation */
  permissionBlocked?: boolean;
  pendingEscalation?: EscalationRequest | null;
  lastEscalationResult?: {
    requestId: string;
    resolution: EscalationResolution;
    reason: string;
  } | null;
  /** Native resume id for every provider (Claude UUID, Codex thread, OpenCode ses_*, …). Wire alias: providerSessionId. */
  claudeSessionId: string | null;
  /** Structured conversation messages derived from PTY output. */
  messages?: ConversationTurn[];
  /** Pending structured user inputs queued while an assistant response is in flight. */
  queuedMessages?: string[];
  /** Per-message Claude Agent SDK skill allowlists aligned with queuedMessages. */
  queuedMessageSkills?: string[][];
  structuredState?: StructuredSessionState;
  /** 此会话是从哪个 Wand 会话恢复而来 */
  resumedFromSessionId?: string | null;
  /** 服务器重启时是否自动恢复 */
  autoRecovered?: boolean;
  /** 是否启用自动批准权限 */
  autoApprovePermissions?: boolean;
  /** 自动批准统计（按类别分） */
  approvalStats?: { tool: number; command: number; file: number; total: number };
  /** 会话摘要：从首条用户消息或当前任务提取 */
  summary?: string;
  /** 由模型根据全部用户消息生成的短标题。 */
  title?: string;
  /** 由模型根据全部用户消息生成的一句话描述。 */
  description?: string;
  /** 会话标题正在根据最新消息重新生成；仅用于实时展示，重启时强制清空。 */
  titleGenerating?: boolean;
  /** 当前正在执行的任务标题（用于进度展示，不作为会话标题） */
  currentTaskTitle?: string;
  /** 用户为此会话选定的 Claude 模型（别名或完整 ID）。结构化会话下次 spawn 时使用；PTY 会话仅用于展示。 */
  selectedModel?: string | null;
  /**
   * 用户选定的思考深度。
   *   - off:      不覆盖默认思考深度（SDK: 不传 thinking；Claude CLI: auto/default；Codex: 使用模型默认值）
   *   - standard: 标准（SDK: budget 4096；Claude CLI: low；Codex: low）
   *   - deep:    深度（SDK: budget 16000；Claude CLI: medium；Codex: medium）
   *   - max:     旧版最深档（SDK: budget 31999；Claude CLI: max；Codex: xhigh）
   *   - codex:*: Codex CLI 动态声明的原生推理档位
   */
  thinkingEffort?: ThinkingEffort | null;
  /** 当前 PTY 列宽，由最近一次 resize 决定。前端用它来判断本端 fit 是否需要校准。 */
  ptyCols?: number;
  /** 当前 PTY 行数，由最近一次 resize 决定。 */
  ptyRows?: number;
  /** terminal host 已处理并原子持久化的最后一个输出块序号；不进入客户端传输。 */
  ptyOutputSeq?: number;
  /** Internal shell-wrapper marker needed to keep parsing a daemon-owned PTY after reattach. */
  ptyLaunchMarkerToken?: string | null;
}

// ── Workspace（多标签 / 分屏项目，参考 Orca）──

/** 工作空间默认 IDE；新建 Agent 标签时缺省回落到该 provider。 */
export type WorkspaceDefaultProvider = SessionProvider;

/** 工作空间内一个标签页：会话（IDE/终端）/ 编辑器 / 预览。 */
export type PaneTab =
  | { id: string; kind: "session"; sessionId: string }
  | { id: string; kind: "editor"; path: string }
  | { id: string; kind: "preview"; path: string };

/**
 * 标签 / 分屏布局树。叶子是 tabset（一组标签），内部节点是二分屏。
 * `split.ratio` 为左/上子节点占比（0~1），由前端 allotment 回写持久化。
 */
export type LayoutNode =
  | { type: "pane"; tabs: PaneTab[]; active: number }
  | { type: "split"; dir: "h" | "v"; ratio: number; children: [LayoutNode, LayoutNode] };

/** 顶部一个工作窗口 Tab；内部可以包含一棵终端分屏树。 */
export interface WorkWindowLayout {
  id: string;
  layout: LayoutNode;
  activeTabId?: string;
}

/** 任务级窗口集合：顶部 Tab 与 windows 一一对应。 */
export interface TaskWindowLayout {
  type: "windows";
  windows: WorkWindowLayout[];
  activeWindowId: string | null;
}

/** 项目 / 工作空间。锚定一个目录（如 wand 仓库），内含多个并行「任务」。 */
export interface Workspace {
  id: string;
  name: string;
  cwd: string;
  defaultProvider?: WorkspaceDefaultProvider;
  /**
   * 工作空间级的布局占位（保留字段）。标签 / 分屏布局实际挂在 Task 上
   * （见 WorkspaceTask.layout），因为每个任务独占一个 worktree 与一组标签。
   */
  layout: LayoutNode | null;
  createdAt: string;
  lastOpenedAt: string | null;
}

/** 任务所属 worktree 信息（复用 WorktreeInfo）；非 git 目录时为 null（退化为直接在项目目录运行）。 */
export type WorkspaceTaskWorktree = WorktreeInfo;

export type WorkspaceTaskStatus = "active" | "done";

/**
 * 工作空间内的一个「任务」：命名、独立 worktree 隔离、自带一组标签（LayoutNode）。
 * 一个工作空间下可有多个任务，任务在侧栏列表里单独展示；每个任务的会话共享该任务的 worktree。
 */
export interface WorkspaceTask {
  id: string;
  workspaceId: string;
  name: string;
  worktree: WorkspaceTaskWorktree | null;
  /** 该任务的工作窗口 Tabs；每个窗口内部可含一棵分屏树。 */
  layout: TaskWindowLayout | null;
  status: WorkspaceTaskStatus;
  createdAt: string;
  lastOpenedAt: string | null;
}

// ── Session Event (PTY Bridge Output) ──

/** Unified event type emitted by ClaudePtyBridge for WebSocket broadcast */
export type SessionEventType =
  | "output.raw"          // Raw PTY output for terminal view
  | "output.chat"         // Structured chat content update
  | "chat.turn"           // Conversation turn completed
  | "permission.prompt"   // Permission request detected
  | "permission.resolved" // Permission resolved
  | "session.id"          // Claude session ID captured
  | "task"                // Task info update
  | "ended";              // Session ended

export interface SessionEvent {
  type: SessionEventType;
  sessionId: string;
  timestamp: number;
  data?: unknown;
}

// Event-specific data payloads

export interface RawOutputData {
  chunk: string;
  /** Full accumulated output for terminal view */
  output: string;
}

export interface ChatOutputData {
  /** Current messages array */
  messages: ConversationTurn[];
  /** Index of the message being streamed */
  streamingIndex?: number;
  /** Whether assistant is currently responding */
  isResponding: boolean;
}

export interface ChatTurnData {
  /** The completed turn */
  turn: ConversationTurn;
  /** Full messages array */
  messages: ConversationTurn[];
}

export interface PermissionPromptData {
  /** Detected prompt text */
  prompt: string;
  /** Inferred scope */
  scope: EscalationScope;
  /** Target if detected */
  target?: string;
}

export interface SessionIdData {
  /** Claude CLI session UUID */
  claudeSessionId: string;
}

export interface SessionEndData {
  exitCode: number | null;
}
