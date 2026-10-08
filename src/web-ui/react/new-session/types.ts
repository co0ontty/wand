import type { ProviderId } from "../../provider-identity";

export type NewSessionProvider = ProviderId;

export type NewSessionKind = "structured" | "pty" | "shell";
export type NewSessionPreferenceKind = Exclude<NewSessionKind, "shell">;

export type NewSessionMode =
  | "default"
  | "full-access"
  | "auto-edit"
  | "native"
  | "managed";

export interface NewSessionConfig {
  defaultProvider: NewSessionProvider;
  defaultSessionKind: NewSessionPreferenceKind;
  defaultMode: NewSessionMode;
  defaultCwd: string;
  /**
   * 默认执行引擎；只对 pi 有意义：`sdk` = Wand Agent（进程内 SDK），缺省 / `cli` = Pi CLI。
   * 它跟 provider 一起构成「上次用的执行工具」，用户选过 Wand Agent 下次要能沿用。
   */
  defaultEngine?: "cli" | "sdk";
}

export interface NewSessionPath {
  path: string;
  name: string;
}

export interface NewSessionDefaults {
  config: NewSessionConfig;
  recentPaths: readonly NewSessionPath[];
}

export interface NewSessionForm {
  provider: NewSessionProvider;
  /**
   * 执行引擎；只有 pi 有两种：`cli`（Pi CLI，缺省）与 `sdk`（Wand Agent，进程内 SDK）。
   * 其他 provider 不设这个字段。
   */
  engine?: "cli" | "sdk";
  employeeId?: string;
  /** 选中的 AI 团队：走直发路由，不建会话（§5.1 修正 B8）。 */
  teamId?: string;
  kind: NewSessionKind;
  cwd: string;
  mode: NewSessionMode;
  worktreeEnabled: boolean;
  /** 用户为这个 provider 选定的模型；空串表示跟随服务端配置的默认模型。 */
  model: string;
  /** 是否显式指定了 CLI 和模型（在员工会话下；false 表示走员工默认派发流程） */
  specifiedCli?: boolean;
  workspaceId?: string;
  workspaceTaskId?: string;
}

export interface NewSessionPreferencePatch {
  defaultProvider?: NewSessionProvider;
  defaultSessionKind?: NewSessionPreferenceKind;
  defaultMode?: NewSessionMode;
  /** 只对 pi 有意义的默认引擎；与 defaultProvider 一起记住上次用的执行工具。 */
  defaultEngine?: "cli" | "sdk";
  defaultTaskWorktree?: boolean;
}

export interface NewSessionRuntimeContext {
  effectiveCwd: string;
  selectedModels?: Partial<Record<NewSessionProvider, string>>;
  thinkingEffort?: string;
}

export interface NewSessionTerminalDimensions {
  cols?: number;
  rows?: number;
}

interface NewSessionCreateRequestBase {
  cwd: string;
  mode: NewSessionMode;
  worktreeEnabled: boolean;
  sessionSource: "interactive";
  workspaceId?: string;
  workspaceTaskId?: string;
}

interface StructuredNewSessionCreateRequest extends NewSessionCreateRequestBase {
  kind: "structured";
  provider: NewSessionProvider;
  runner: string;
  /** 仅 pi：`sdk` 表示 Wand Agent（进程内 SDK），不传是 Pi CLI。 */
  engine?: "cli" | "sdk";
  model?: string;
  thinkingEffort?: string;
  employeeId?: string;
  overrideCli?: boolean;
}

interface PtyNewSessionCreateRequest extends NewSessionCreateRequestBase {
  kind: "pty";
  provider: NewSessionProvider;
  command: string;
  /** PTY 会话同样按模型启动 CLI（服务端 processCommandForMode 注入 --model）。 */
  model?: string;
  cols?: number;
  rows?: number;
}

interface ShellNewSessionCreateRequest extends NewSessionCreateRequestBase {
  kind: "shell";
  shell: true;
  cols?: number;
  rows?: number;
}

export type NewSessionCreateRequest =
  | StructuredNewSessionCreateRequest
  | PtyNewSessionCreateRequest
  | ShellNewSessionCreateRequest;

export interface NewSessionCreated {
  id: string;
  [key: string]: unknown;
}

export interface NewSessionLoadOptions {
  signal?: AbortSignal;
}

/**
 * Network seam for the complete new-session workflow. The HTTP adapter owns
 * endpoint selection, response validation, and preference-write ordering.
 */
export interface NewSessionRepository {
  load(options?: NewSessionLoadOptions): Promise<NewSessionDefaults>;
  savePreferences(patch: NewSessionPreferencePatch): Promise<void>;
  suggestPaths(query: string, options?: NewSessionLoadOptions): Promise<readonly NewSessionPath[]>;
  create(request: NewSessionCreateRequest): Promise<NewSessionCreated>;
}

/**
 * Seam back into the streaming legacy shell. React owns the form and HTTP
 * workflow; this adapter hides terminal preparation and session activation.
 */
export interface NewSessionRuntimeAdapter {
  onOpen(): void;
  onClose(): void;
  getContext(): NewSessionRuntimeContext;
  /** 用户在对话框里选了模型：写回按 provider 的记忆，下次打开默认沿用。 */
  rememberModel(provider: NewSessionProvider, model: string): void;
  prepareCreate(kind: NewSessionKind): Promise<NewSessionTerminalDimensions>;
  completeCreate(request: NewSessionCreateRequest, created: NewSessionCreated): Promise<void>;
}
