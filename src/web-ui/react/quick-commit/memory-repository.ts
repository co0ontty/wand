import type {
  QuickCommitContextMode,
  QuickCommitInput,
  QuickCommitIterationContext,
  QuickCommitLoadOptions,
  QuickCommitPushInput,
  QuickCommitPushResponse,
  QuickCommitRepository,
  QuickCommitResponse,
  QuickCommitSelection,
  QuickCommitStatus,
  QuickCommitSuggestion,
} from "./types";

export interface MemoryQuickCommitSeed {
  status: QuickCommitStatus;
  suggestion?: QuickCommitSuggestion;
  context?: QuickCommitIterationContext;
  commitResponse?: QuickCommitResponse;
  pushResponse?: QuickCommitPushResponse;
}

/** 未注入种子时的空上下文：默认迭代、没有任何提示词记录。 */
export const EMPTY_QUICK_COMMIT_CONTEXT: QuickCommitIterationContext = {
  iteration: { id: "iteration-default", name: "默认迭代", isDefault: true },
  entries: [],
  defaultEntryIds: [],
  selectableIds: [],
  truncated: false,
  effectiveMode: "diff",
  mode: "iteration",
};

/** Deterministic adapter for unit tests, stories, and offline UI development. */
export class MemoryQuickCommitRepository implements QuickCommitRepository {
  readonly calls: Array<
    | { operation: "loadStatus" | "loadContext" | "generate"; sessionId: string }
    | { operation: "saveContextMode"; sessionId: string; input: QuickCommitContextMode }
    | { operation: "commit"; sessionId: string; input: QuickCommitInput }
    | { operation: "push"; sessionId: string; input: QuickCommitPushInput }
  > = [];

  constructor(public seed: MemoryQuickCommitSeed) {}

  async loadStatus(
    sessionId: string,
    options: QuickCommitLoadOptions = {},
  ): Promise<QuickCommitStatus> {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    this.calls.push({ operation: "loadStatus", sessionId });
    return structuredClone(this.seed.status);
  }

  async loadContext(
    sessionId: string,
    options: QuickCommitLoadOptions = {},
  ): Promise<QuickCommitIterationContext> {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    this.calls.push({ operation: "loadContext", sessionId });
    return structuredClone(this.seed.context ?? EMPTY_QUICK_COMMIT_CONTEXT);
  }

  async saveContextMode(
    sessionId: string,
    mode: QuickCommitContextMode,
  ): Promise<QuickCommitContextMode> {
    this.calls.push({ operation: "saveContextMode", sessionId, input: mode });
    if (this.seed.context) this.seed.context = { ...this.seed.context, mode };
    return mode;
  }

  async generate(
    sessionId: string,
    options: QuickCommitLoadOptions & { selection?: QuickCommitSelection; includeDiff?: boolean } = {},
  ): Promise<QuickCommitSuggestion> {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    this.calls.push({ operation: "generate", sessionId });
    // 与 HTTP 实现对齐：来源与条目 id 总有值，面板不用区分两种后端。
    const seed = this.seed.suggestion ?? { message: "", suggestedTag: "" };
    return structuredClone({
      contextSource: "diff" as const,
      entryIds: [],
      ...seed,
    });
  }

  async commit(sessionId: string, input: QuickCommitInput): Promise<QuickCommitResponse> {
    this.calls.push({ operation: "commit", sessionId, input: structuredClone(input) });
    const contextIds = [...(input.entryIds ?? [])];
    return structuredClone(this.seed.commitResponse ?? {
      ok: true,
      commit: { hash: "0000000", message: input.customMessage },
      pushed: input.push,
      pushError: "",
      submoduleCommits: [],
      commitContext: contextIds.length > 0
        ? { source: input.mode ?? "iteration", entryIds: contextIds }
        : null,
    });
  }

  async push(sessionId: string, input: QuickCommitPushInput): Promise<QuickCommitPushResponse> {
    this.calls.push({ operation: "push", sessionId, input: structuredClone(input) });
    return structuredClone(this.seed.pushResponse ?? {
      ok: true,
      pushedCommits: input.pushCommits,
      pushedTags: input.pushTags,
      error: "",
    });
  }
}
