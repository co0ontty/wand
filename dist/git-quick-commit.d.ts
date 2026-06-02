import { GitStatusResult, PushResult, QuickCommitResult, TagHeadResult } from "./types.js";
export type QuickCommitErrorCode = "CWD_MISSING" | "NO_CWD" | "NOT_A_GIT_REPO" | "NO_COMMIT" | "NOTHING_TO_COMMIT" | "NOTHING_TO_PUSH" | "EMPTY_MESSAGE" | "EMPTY_TAG" | "EMPTY_AI_MESSAGE" | "INVALID_AI_TAG" | "TAG_EXISTS" | "GIT_ADD_FAILED" | "GIT_DIFF_FAILED" | "GIT_COMMIT_FAILED" | "GIT_TAG_FAILED" | "CLAUDE_CLI_MISSING" | "CLAUDE_CLI_FAILED" | "CLAUDE_TIMEOUT";
export declare function getGitStatus(cwd: string): GitStatusResult;
interface QuickCommitOptions {
    cwd: string;
    language: string;
    autoMessage: boolean;
    customMessage?: string;
    tag?: string;
    /** When `tag` is empty, ask Claude to generate one based on the diff + commit message. */
    autoTag?: boolean;
    push?: boolean;
    /**
     * 是否把 commit / tag / push 递归进入各 submodule 内部。默认 false：
     * 只处理父仓库自身（含已变化的 submodule 指针），不碰 submodule 内部 dirty。
     */
    submodule?: boolean;
}
export declare class QuickCommitError extends Error {
    readonly code: QuickCommitErrorCode;
    constructor(message: string, code: QuickCommitErrorCode);
}
export interface GenerateCommitMessageResult {
    message: string;
    /** AI-suggested next tag derived from the staged diff and the latest existing tag. */
    suggestedTag?: string;
}
export declare function generateCommitMessageOnly(cwd: string, language: string): Promise<GenerateCommitMessageResult>;
interface TagHeadOptions {
    cwd: string;
    language: string;
    /** Explicit tag name. If empty and `autoTag` is true, ask Claude to generate one. */
    tag?: string;
    autoTag?: boolean;
    /** Push only this tag to its upstream remote after creating it. */
    push?: boolean;
}
export declare function runTagHead(opts: TagHeadOptions): Promise<TagHeadResult>;
interface PushOptions {
    cwd: string;
    pushCommits?: boolean;
    pushTags?: boolean;
    /** 是否同时把各 submodule 的 HEAD（+ 同名 tag）分别推送到各自远端分支。 */
    submodule?: boolean;
    /** `submodule` + `pushTags` 时，要连带推送到 submodule 的同名 tag。 */
    tagName?: string;
}
export declare function runPush(opts: PushOptions): Promise<PushResult>;
export declare function runQuickCommit(opts: QuickCommitOptions): Promise<QuickCommitResult>;
export {};
