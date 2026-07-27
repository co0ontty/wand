import type {
  QuickCommitAction,
  QuickCommitForm,
  QuickCommitInput,
  QuickCommitOutcome,
  QuickCommitResponse,
  QuickCommitStatus,
} from "./types";

export interface QuickCommitActionMeta {
  action: QuickCommitAction;
  label: string;
  verb: string;
  withTag: boolean;
  push: boolean;
}

const ACTIONS: Record<QuickCommitAction, QuickCommitActionMeta> = {
  commit: {
    action: "commit",
    label: "Commit",
    verb: "仅提交",
    withTag: false,
    push: false,
  },
  "commit-tag": {
    action: "commit-tag",
    label: "Commit + Tag",
    verb: "提交并打 Tag",
    withTag: true,
    push: false,
  },
  "commit-push": {
    action: "commit-push",
    label: "Commit + Push",
    verb: "提交并推送",
    withTag: false,
    push: true,
  },
  "commit-tag-push": {
    action: "commit-tag-push",
    label: "Commit + Tag + Push",
    verb: "提交、打 Tag 并推送",
    withTag: true,
    push: true,
  },
};

export const QUICK_COMMIT_ACTIONS = Object.values(ACTIONS);

export function normalizeQuickCommitAction(value: unknown): QuickCommitAction {
  return typeof value === "string" && value in ACTIONS
    ? value as QuickCommitAction
    : "commit";
}

export function quickCommitActionMeta(value: unknown): QuickCommitActionMeta {
  return ACTIONS[normalizeQuickCommitAction(value)];
}

export function actionFromOptions(withTag: boolean, push: boolean): QuickCommitAction {
  if (withTag && push) return "commit-tag-push";
  if (withTag) return "commit-tag";
  if (push) return "commit-push";
  return "commit";
}

export function buildQuickCommitInput(
  form: QuickCommitForm,
  action: QuickCommitAction,
  includeSubmodule: boolean,
): QuickCommitInput {
  const meta = quickCommitActionMeta(action);
  const message = form.message.trim();
  const tag = meta.withTag ? form.tag.trim() : "";
  return {
    autoMessage: !message,
    customMessage: message,
    tag,
    autoTag: meta.withTag && !tag,
    push: meta.push,
    submodule: includeSubmodule,
  };
}

export function hasQuickCommitChanges(status: QuickCommitStatus | null): boolean {
  return !!status && status.isGit && status.modifiedCount > 0;
}

export function buildQuickCommitOutcome(
  action: QuickCommitAction,
  includeSubmodule: boolean,
  form: QuickCommitForm,
  before: QuickCommitStatus,
  response: QuickCommitResponse,
): QuickCommitOutcome {
  return {
    action,
    includeSubmodule,
    pushed: response.pushed,
    pushError: response.pushError,
    commitHash: response.commit?.hash.slice(0, 7) ?? "",
    commitMessage: response.commit?.message || form.message.trim(),
    tagName: response.tag?.name ?? "",
    oldTag: before.latestTag,
    oldCommitHash: before.lastCommit?.shortHash || before.head.slice(0, 7),
    oldCommitSubject: before.lastCommit?.subject ?? "",
    submoduleCount: response.submoduleCommits.length,
  };
}

export interface QuickCommitStatusBadge {
  letter: string;
  tone: "added" | "modified" | "deleted" | "renamed" | "untracked" | "ignored" | "other";
  label: string;
}

export function quickCommitStatusBadge(status: string): QuickCommitStatusBadge {
  const trimmed = status.trim();
  if (trimmed === "??") return { letter: "U", tone: "untracked", label: "未跟踪" };
  if (trimmed === "!!") return { letter: "I", tone: "ignored", label: "已忽略" };
  const letter = [...status].find((character) => character !== "." && character !== " ")
    ?.toUpperCase() || trimmed[0]?.toUpperCase() || "?";
  const map: Record<string, Omit<QuickCommitStatusBadge, "letter">> = {
    A: { tone: "added", label: "新增" },
    M: { tone: "modified", label: "修改" },
    D: { tone: "deleted", label: "删除" },
    R: { tone: "renamed", label: "重命名" },
    C: { tone: "renamed", label: "复制" },
    T: { tone: "modified", label: "类型变更" },
    U: { tone: "deleted", label: "冲突" },
  };
  return { letter, ...(map[letter] ?? { tone: "other", label: "已更改" }) };
}
