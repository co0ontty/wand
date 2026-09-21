export type QuickCommitAction =
  | "commit"
  | "commit-tag"
  | "commit-push"
  | "commit-tag-push";

export interface QuickCommitOpenContext {
  sessionId: string;
}

interface QuickCommitSubmoduleState {
  commitChanged: boolean;
  hasTrackedChanges: boolean;
  hasUntracked: boolean;
}

export interface QuickCommitFile {
  path: string;
  status: string;
  isSubmodule: boolean;
  submoduleState?: QuickCommitSubmoduleState;
}

export interface QuickCommitStatus {
  isGit: boolean;
  branch: string;
  modifiedCount: number;
  files: readonly QuickCommitFile[];
  head: string;
  ahead: number;
  behind: number;
  lastCommit?: {
    hash: string;
    shortHash: string;
    subject: string;
  };
  latestTag: string;
  hasSubmodule: boolean;
  error?: string;
}

export interface QuickCommitSuggestion {
  message: string;
  suggestedTag: string;
  /** 这条 message 是依据什么生成的：迭代提示词（默认）还是完整 diff。 */
  contextSource: QuickCommitContextMode;
  /** 真正用到的迭代提示词条目；UI 用它告诉用户「省掉了读代码」。 */
  entryIds: readonly string[];
}

/** AI 生成 commit message 的输入源：iteration = 只用本轮提示词（默认，省 token）；diff = 读完整改动。 */
export type QuickCommitContextMode = "iteration" | "diff";

export interface QuickCommitIterationEntry {
  id: string;
  title: string;
  detail: string;
  createdAt: string;
  /** 已经被上一轮提交用掉：仍可选，但默认不选。 */
  consumed: boolean;
  consumedCommit: string;
  source: string;
}

export interface QuickCommitIterationContext {
  iteration: { id: string; name: string; isDefault: boolean };
  /** 可用的历史条目，新的在前。 */
  entries: readonly QuickCommitIterationEntry[];
  /** 默认勾选：上次提交以来的提示词。 */
  defaultEntryIds: readonly string[];
  selectableIds: readonly string[];
  truncated: boolean;
  /** 默认输入源（有未提交提示词就是 iteration）。 */
  effectiveMode: QuickCommitContextMode;
  /** 用户上次选的输入源。 */
  mode: QuickCommitContextMode;
}

/** 生成 / 提交时回传给服务端的选择：模式 + 本次算作已提交的条目。 */
export interface QuickCommitSelection {
  mode: QuickCommitContextMode;
  entryIds: readonly string[];
}

export interface QuickCommitInput {
  autoMessage: boolean;
  customMessage: string;
  tag: string;
  autoTag: boolean;
  push: boolean;
  submodule: boolean;
  /** 生成 message 的输入源；不传则用服务端记住的偏好。 */
  mode?: QuickCommitContextMode;
  /** 本次当作已提交的迭代条目（提交成功后由服务端标记）。 */
  entryIds?: readonly string[];
  /** 迭代模式下仍附上完整 diff。 */
  includeDiff?: boolean;
}

export interface QuickCommitResponse {
  ok: boolean;
  commit?: { hash: string; message: string };
  tag?: { name: string };
  pushed: boolean;
  pushError: string;
  submoduleCommits: readonly { path: string; hash: string }[];
  /** 生成 message 用的输入源与条目；手写 message 时为 null。 */
  commitContext: { source: QuickCommitContextMode; entryIds: readonly string[] } | null;
}

export interface QuickCommitPushInput {
  pushCommits: boolean;
  pushTags: boolean;
  submodule: boolean;
  tag: string;
}

export interface QuickCommitPushResponse {
  ok: boolean;
  pushedCommits: boolean;
  pushedTags: boolean;
  error: string;
}

export interface QuickCommitLoadOptions {
  signal?: AbortSignal;
}

/** HTTP boundary for the complete quick-commit workflow. */
export interface QuickCommitRepository {
  loadStatus(
    sessionId: string,
    options?: QuickCommitLoadOptions,
  ): Promise<QuickCommitStatus>;
  /** 本轮迭代的提示词清单（面板默认勾选项）。 */
  loadContext(
    sessionId: string,
    options?: QuickCommitLoadOptions,
  ): Promise<QuickCommitIterationContext>;
  /** 记住用户选的输入源。 */
  saveContextMode(sessionId: string, mode: QuickCommitContextMode): Promise<QuickCommitContextMode>;
  generate(
    sessionId: string,
    options?: QuickCommitLoadOptions & { selection?: QuickCommitSelection; includeDiff?: boolean },
  ): Promise<QuickCommitSuggestion>;
  commit(sessionId: string, input: QuickCommitInput): Promise<QuickCommitResponse>;
  push(sessionId: string, input: QuickCommitPushInput): Promise<QuickCommitPushResponse>;
}

type QuickCommitToastTone = "success" | "error" | "info";

/** Bridge back to the legacy shell without exposing its DOM or state to React. */
export interface QuickCommitRuntimeAdapter {
  onOpen(context: QuickCommitOpenContext): void;
  onClose(context: QuickCommitOpenContext): void;
  /** 与顶栏徽章共用单调递增的取数时刻，保证同毫秒请求和时钟回拨时仍能排除旧响应。 */
  nextStatusRequestTime(): number;
  /**
   * 面板自己拉到的 git 状态。顶栏快捷提交徽章是同一份数据的另一个视图，
   * 握手给宿主即可让它同步更新，不必再发一次同样的请求。
   *
   * `requestedAt` 是这次取数的发起时刻，宿主用它排掉「晚到的旧响应」。
   */
  onStatusLoaded(sessionId: string, status: QuickCommitStatus, requestedAt: number): void;
  toast(message: string, tone: QuickCommitToastTone): void;
}

export interface QuickCommitForm {
  message: string;
  tag: string;
  tagEdited: boolean;
}

export interface QuickCommitOutcome {
  action: QuickCommitAction;
  includeSubmodule: boolean;
  pushed: boolean;
  pushError: string;
  commitHash: string;
  commitMessage: string;
  tagName: string;
  oldTag: string;
  oldCommitHash: string;
  oldCommitSubject: string;
  submoduleCount: number;
}
