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
 * 判定「这一轮输入没有被接受」。这是候选降级（换模型 / 换执行工具）的唯一闸门：
 * 只有确认 provider 根本没开始干活，重放才不会重复执行工具、重复改文件、重复计费。
 *
 * 判定只用原生事实，不看任何面向用户的文案：
 *
 *   硬否定（任一条成立就不可能是「未接受」）
 *     1. 用户/看门狗主动中断（signal）——有独立出口，且可能已经干了一半；
 *     2. 进程没起来（spawnError）——由 spawn 分支处理，不需要走这里；
 *     3. stdout 有无法解析的字节——CLI 干了什么我们没看见；
 *     4. 本轮有任何可观察产出（内容块 / result / usage / 适配器上报的 progress）。
 *
 *   在以上都不成立时，满足任一「未开始」证据即可判为未接受：
 *     A. provider 在协议里亲自回了错误（`protocolError`）——最强的拒绝证据；
 *     B. 适配器明确报告「本轮一个协议事件都没收到」（`noProtocolEvent === true`），
 *        且进程以非零码退出、没有建立新的原生会话——CLI 在跟 provider 建立任何会话之前
 *        就失败了（ENOENT、参数错误、鉴权/额度被拒后直接退出）。
 *        这一条必须由适配器显式声明；没声明的旧调用方继续按「送达未知」处理，不自动重放。
 *
 * 其余情况（超时被杀、daemon 掉线、协议解析失败、已经跑过东西）一律保持 unknown/accepted，
 * 宁可交回用户核对，也不自动重放已经执行过的轮次。
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
  /** 进程退出码；用于识别「CLI 在执行前就失败退出」。 */
  exitCode?: number | null;
  /** 本轮开始前的原生会话 id；相等即说明本轮没有新建原生会话。 */
  previousSessionId?: string | null;
  /**
   * 适配器能确认「本轮一个协议事件都没收到」。只有显式为 true 才启用退出码判据；
   * 缺省表示调用方没提供这个事实，继续按送达未知处理。
   */
  noProtocolEvent?: boolean;
}): StructuredCliUnacceptedFacts {
  if (input.signal || input.spawnError || input.unparsedStdout) return {};
  if (input.progressed ?? hasStructuredExecutionProgress(input.state)) return {};
  // 本轮没有新建原生会话：沿用旧 id 或压根没有 id，都说明没走到「provider 接管这一轮」。
  const noNewNativeSession = !input.state.sessionId || input.state.sessionId === input.previousSessionId;
  const failedBeforeStart = input.noProtocolEvent === true && noNewNativeSession
    && typeof input.exitCode === "number" && input.exitCode !== 0;
  if (!input.protocolError && !failedBeforeStart) return {};
  // 传输层失败（连接断了、超时、本地网络错误）说明请求可能已经送达，只是我们没收到答复；
  // 这类只能算「送达未知」，绝不能当「拒绝」去换候选重放。provider 明确回的状态码
  // （如 503 service_unavailable）不算传输失败：它确实拒绝了这一轮且什么都没执行。
  if (isTransportFailure(input.primaryError)) return {};
  // 拒绝类别只用于日志与展示分级；分不出来时按 model-unavailable 授权换候选。
  return { inputAccepted: false, rejection: classifyProviderRejection(input.primaryError) ?? "model-unavailable" };
}

/**
 * 无法归因给 provider 的失败：请求可能已经送达，只是答复没回来。
 * 这类失败一律保持送达未知，不授权换候选重放。
 */
export function isTransportFailure(message: string | null | undefined): boolean {
  const text = message?.trim() ?? "";
  if (!text) return false;
  return /\bfetch failed\b|\bECONN\w*|socket hang up|\bnetwork error\b|\btimed?\s*out\b|\b408\b|\b409\b/i.test(text);
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

/**
 * 只对 provider 自己回的协议错误调用，绝不用助手正文、stderr 或捕获到的传输错误。
 * 返回 null 表示「这次失败不属于可重放的执行前拒绝」，调用方不得据此换候选。
 */
export function classifyProviderRejection(message: string | null | undefined): ProviderRejectionKind | null {
  const text = message?.trim() ?? "";
  if (!text || /\b(?:408|409|5\d\d)\b|fetch failed|timed?\s*out|ECONN\w*|socket|network error/i.test(text)) return null;
  if (/insufficient[_ -](?:quota|credits|balance)|quota[_ -](?:exceeded|exhausted)|credit balance is too low|(?:usage|spending) limit (?:has been )?(?:reached|exceeded)|you have hit your usage limit/i.test(text)
    // CLI 常把额度耗尽写成「You've reached your daily usage limit」，不带固定搭配。
    || /\b(?:daily|monthly|weekly|hourly)?\s*(?:usage|message|request|chat)\s+limit\b[^\n]{0,40}\b(?:reached|exceeded|exhausted|used up)\b/i.test(text)
    || /\b(?:reached|exceeded|hit)\b[^\n]{0,40}\b(?:usage|message|request|chat)\s+limit\b/i.test(text)
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
  // 适配器自己说了「接受/拒绝」时，它的原生事实优先；只有适配器什么都没说的旧实现
  // 才回退到「看过 stdout 或有原生会话 id 就算送达不确定」的保守启发。
  const adapterSpoke = result.inputAccepted !== undefined || !!result.rejection;
  const uncertainOutput = !adapterSpoke
    && (observed.output || (!result.spawnError && !!result.state.sessionId));
  const rejected = !progressed && !uncertainOutput && (result.inputAccepted === false || !!result.spawnError);
  const kind = result.signal || result.stopReason ? "cancelled" : result.rejection
    ?? (result.spawnError ? "spawn" : result.inputAccepted === false ? "preflight" : "runtime");
  return { kind, delivery: progressed ? "accepted" : rejected ? "rejected" : "unknown",
    retryable: rejected && kind !== "cancelled" && !result.retryForbidden };
}
