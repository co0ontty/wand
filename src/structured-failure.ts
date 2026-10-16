import type { StructuredRunnerResult, StructuredRunnerTurnState } from "./structured-runner.js";

export type ProviderRejectionKind = "quota" | "authentication" | "rate-limit" | "model-unavailable";
export interface StructuredFailure {
  kind: ProviderRejectionKind | "spawn" | "preflight" | "runtime" | "cancelled";
  delivery: "rejected" | "accepted" | "unknown";
  retryable: boolean;
}

/** Extra facts a CLI-backed adapter adds to its finalize() result. */
export type StructuredCliUnacceptedFacts = Pick<StructuredRunnerResult, "inputAccepted" | "rejection">;

/**
 * An in-band provider protocol error is the only evidence that lets a CLI adapter claim the input
 * was never taken: the reply arrived from the provider itself, this turn produced no block, usage
 * or cost, and stdout held nothing we could not account for as protocol traffic. Anything else —
 * unparsed stdout, a signal, a spawn failure or work already done — stays unknown/accepted so no
 * executed turn can be replayed on another candidate.
 */
export function cliUnacceptedFacts(input: {
  state: StructuredRunnerTurnState;
  primaryError: string | null;
  /** The provider reported this error inside its own protocol stream. */
  protocolError: boolean;
  /** Stdout carried bytes the adapter could not parse as protocol events. */
  unparsedStdout: boolean;
  signal: NodeJS.Signals | null;
  spawnError?: NodeJS.ErrnoException;
  /** Adapters whose protocol echoes the failure text into `result` state what really ran. */
  progressed?: boolean;
}): StructuredCliUnacceptedFacts {
  if (!input.protocolError || input.unparsedStdout || input.signal || input.spawnError || !input.primaryError?.trim()) return {};
  if (input.progressed ?? hasStructuredExecutionProgress(input.state)) return {};
  return { inputAccepted: false, rejection: classifyProviderRejection(input.primaryError) ?? "model-unavailable" };
}

/** Assemble common CLI exit fields while the adapter retains protocol/error observations. */
export function buildStructuredCliResult(
  input: Parameters<typeof cliUnacceptedFacts>[0] & Pick<StructuredRunnerResult, "exitCode" | "stderr">,
): StructuredRunnerResult {
  const { state, exitCode, signal, stderr, primaryError, spawnError } = input;
  return {
    state, exitCode, signal, stderr, primaryError,
    ...(spawnError ? { spawnError } : {}),
    ...cliUnacceptedFacts(input),
  };
}

/** Only call for a provider protocol error, never assistant text, stderr or a caught transport error. */
export function classifyProviderRejection(message: string | null | undefined): ProviderRejectionKind | null {
  const text = message?.trim() ?? "";
  if (!text || /\b(?:408|409|5\d\d)\b|fetch failed|timed?\s*out|ECONN\w*|socket|network error/i.test(text)) return null;
  if (/insufficient[_ -](?:quota|credits|balance)|quota[_ -](?:exceeded|exhausted)|credit balance is too low|(?:usage|spending) limit (?:has been )?(?:reached|exceeded)|you have hit your usage limit/i.test(text)
    || /^(?:错误[：:]\s*)?(?:积分|额度|余额)(?:已)?(?:耗尽|用尽|不足)(?:[，,：:。.!！\s].*)?$/.test(text)) return "quota";
  if (/\b(?:invalid_api_key|authentication_error|invalid api key|incorrect api key|unauthorized|forbidden)\b/i.test(text)) return "authentication";
  if (/\b(?:rate_limit_exceeded|rate_limit_error|rate limit exceeded|too many requests)\b/i.test(text)) return "rate-limit";
  if (/\b(?:model_not_found|model not found|unknown model)\b/i.test(text)) return "model-unavailable";
  return null;
}

/** Monotonic observations matter: a final error can replace earlier usage or content. */
export function hasStructuredExecutionProgress(state: StructuredRunnerTurnState): boolean {
  return !!state.result.trim() || state.blocks.some((block) => block.type === "text" ? !!block.text.trim()
    : block.type === "thinking" ? !!block.thinking.trim() : true)
    || Object.values(state.usage ?? {}).some((value) => typeof value === "number" && value > 0);
}

/** Shared by model groups, employee fallback and team startup facts. Missing facts never authorize replay. */
export function classifyStructuredFailure(
  result: StructuredRunnerResult,
  observed: { output?: boolean; progress?: boolean } = {},
): StructuredFailure | null {
  if (!result.spawnError && !result.primaryError && !result.signal && (result.exitCode === null || result.exitCode === 0)) return null;
  const progressed = observed.progress || hasStructuredExecutionProgress(result.state) || result.inputAccepted === true;
  // A verified provider rejection may include a native session ID and protocol/selection metadata.
  // Legacy adapters without this fact retain their stricter no-output/no-session retry boundary.
  const uncertainOutput = !result.rejection && (observed.output || (!result.spawnError && !!result.state.sessionId));
  const rejected = !progressed && !uncertainOutput && (result.inputAccepted === false || !!result.spawnError);
  const kind = result.signal || result.stopReason ? "cancelled" : result.rejection
    ?? (result.spawnError ? "spawn" : result.inputAccepted === false ? "preflight" : "runtime");
  return { kind, delivery: progressed ? "accepted" : rejected ? "rejected" : "unknown",
    retryable: rejected && kind !== "cancelled" && !result.retryForbidden };
}
