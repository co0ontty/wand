import type {
  QuickCommitInput,
  QuickCommitLoadOptions,
  QuickCommitPushInput,
  QuickCommitPushResponse,
  QuickCommitRepository,
  QuickCommitResponse,
  QuickCommitStatus,
  QuickCommitSuggestion,
} from "./types";

export interface MemoryQuickCommitSeed {
  status: QuickCommitStatus;
  suggestion?: QuickCommitSuggestion;
  commitResponse?: QuickCommitResponse;
  pushResponse?: QuickCommitPushResponse;
}

/** Deterministic adapter for unit tests, stories, and offline UI development. */
export class MemoryQuickCommitRepository implements QuickCommitRepository {
  readonly calls: Array<
    | { operation: "loadStatus" | "generate"; sessionId: string }
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

  async generate(
    sessionId: string,
    options: QuickCommitLoadOptions = {},
  ): Promise<QuickCommitSuggestion> {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    this.calls.push({ operation: "generate", sessionId });
    return structuredClone(this.seed.suggestion ?? { message: "", suggestedTag: "" });
  }

  async commit(sessionId: string, input: QuickCommitInput): Promise<QuickCommitResponse> {
    this.calls.push({ operation: "commit", sessionId, input: structuredClone(input) });
    return structuredClone(this.seed.commitResponse ?? {
      ok: true,
      commit: { hash: "0000000", message: input.customMessage },
      pushed: input.push,
      pushError: "",
      submoduleCommits: [],
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
