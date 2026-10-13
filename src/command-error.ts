/** Shared command failure shape; public legacy names/codes stay compatible. */
export type QuickCommitErrorCode =
  | "CWD_MISSING"
  | "NO_CWD"
  | "NOT_A_GIT_REPO"
  | "NO_COMMIT"
  | "NOTHING_TO_COMMIT"
  | "NOTHING_TO_PUSH"
  | "EMPTY_MESSAGE"
  | "EMPTY_TAG"
  | "EMPTY_AI_MESSAGE"
  | "AI_FALLBACK_FAILED"
  | "INVALID_AI_TAG"
  | "TAG_EXISTS"
  | "GIT_ADD_FAILED"
  | "GIT_DIFF_FAILED"
  | "GIT_COMMIT_FAILED"
  | "GIT_TAG_FAILED"
  | "CLAUDE_CLI_MISSING"
  | "CLAUDE_CLI_FAILED"
  | "CLAUDE_TIMEOUT";


export class QuickCommitError extends Error {
  constructor(message: string, public readonly code: QuickCommitErrorCode) {
    super(message);
    this.name = "QuickCommitError";
  }
}

