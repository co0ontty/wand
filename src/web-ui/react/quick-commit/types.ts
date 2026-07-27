export type QuickCommitAction =
  | "commit"
  | "commit-tag"
  | "commit-push"
  | "commit-tag-push";

export interface QuickCommitOpenContext {
  sessionId: string;
}

export interface QuickCommitSubmoduleState {
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
}

export interface QuickCommitInput {
  autoMessage: boolean;
  customMessage: string;
  tag: string;
  autoTag: boolean;
  push: boolean;
  submodule: boolean;
}

export interface QuickCommitResponse {
  ok: boolean;
  commit?: { hash: string; message: string };
  tag?: { name: string };
  pushed: boolean;
  pushError: string;
  submoduleCommits: readonly { path: string; hash: string }[];
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
  generate(
    sessionId: string,
    options?: QuickCommitLoadOptions,
  ): Promise<QuickCommitSuggestion>;
  commit(sessionId: string, input: QuickCommitInput): Promise<QuickCommitResponse>;
  push(sessionId: string, input: QuickCommitPushInput): Promise<QuickCommitPushResponse>;
}

export type QuickCommitToastTone = "success" | "error" | "info";

/** Bridge back to the legacy shell without exposing its DOM or state to React. */
export interface QuickCommitRuntimeAdapter {
  onOpen(context: QuickCommitOpenContext): void;
  onClose(context: QuickCommitOpenContext): void;
  onRepositoryChanged(sessionId: string): void;
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
