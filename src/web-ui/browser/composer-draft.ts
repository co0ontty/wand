// composer 草稿的「提交后回填」判定。
//
// 背景：发送消息时 composer 会在第一处 await 之前同步清空（内存草稿 + localStorage），
// 请求失败才回填。但「请求失败」有两种性质完全不同的情况：
//
//   · 明确未送达：服务端返回了 4xx/5xx（HTTP 响应到手，说明应用层没有接收这条消息），
//     或本地前置条件不成立（WS 断开、会话已切换、会话未就绪）。回填并持久化草稿是
//     安全的，也是用户期望的「别弄丢我刚写的字」。
//   · 送达未知：传输层失败（fetch abort / network error）。请求可能已经被服务端接收，
//     只是响应没回来 —— 刷新页面、切前后台、原生壳回收 WebView 都会让在途 fetch 被 abort。
//     此时把这条消息重新写进 localStorage 草稿，刷新后它会「重新出现在输入框里」，用户
//     一按回车就会把同一条消息发第二遍。所以这种情况只回填到内存（当前页面可见，
//     用户能立刻重试或改写），不落 localStorage。
//
// 这里只放判定，副作用留在 session-engine / input。
export interface ComposerSubmissionFailureLike {
  httpStatus?: unknown;
  errorCode?: unknown;
  message?: unknown;
  /** structured 发送路径对「传输层失败」打的标记（见 postStructuredInput）。 */
  "__wandAmbiguousDelivery"?: unknown;
}

/**
 * 一次草稿写入是否落 localStorage。三态语义（调用点见 session-engine）：
 *   false     —— 永不落盘（发送结果未知的回填），只留内存；
 *   true      —— 显式要求落盘，页面卸载中也要写（明确失败的回填、切会话时存草稿）；
 *   undefined —— 普通写入，页面卸载时跳过，避免在途消息被写成草稿。
 */
export function shouldPersistComposerDraft(persist: boolean | undefined, pageUnloading: boolean): boolean {
  if (persist === false) return false;
  if (persist === true) return true;
  return !pageUnloading;
}

/** 失败是否属于「消息可能已经送达」的不确定状态。 */
export function isAmbiguousComposerSubmissionFailure(error: unknown): boolean {
  if (!error) return false;
  var failure = error as ComposerSubmissionFailureLike;
  if (failure.__wandAmbiguousDelivery === true) return true;
  // 后端识别出的重复投递：这条消息其实已经被接收（正在处理 / 已经排队），
  // 只是被幂等拦下来了。必须排在 httpStatus 判定之前 —— 这类错误同样带 409，
  // 按「服务端明确回错误码 = 没送达」处理会让它被写成持久草稿，刷新后
  // 再次出现在输入框里。
  //   duplicate_idempotency_key —— WebView 底层重发的副本，第一次请求已处理；
  //   duplicate_queued_message   —— 同一条文本已经在服务端排队里。
  if (failure.errorCode === "duplicate_idempotency_key" || failure.errorCode === "duplicate_queued_message") {
    return true;
  }
  // 服务端明确回了一个错误码，说明这条消息没有被接收。
  if (typeof failure.httpStatus === "number") return false;
  var message = failure.message == null ? "" : String(failure.message);
  if (!message) return false;
  return /failed to fetch|networkerror|load failed|network connection was lost|aborted|aborterror|err_network|err_connection/i
    .test(message);
}

/**
 * 跨会话排队项在启动失败后回填队首时，是否把队首写回 localStorage。
 *
 * 与草稿同一套「送达未知」取舍：页面正在卸载说明这次 `/api/commands` 是被
 * abort 的，服务端可能已经建好了会话并把 initialInput 发出去。此时把它写回
 * localStorage，刷新后队列会被自动 flush，同一条消息就会二次发送（多出一个
 * 会话）。留在内存里用户仍能看到、能用「立即发送」重试，刷新即放弃。
 */
export function shouldPersistQueueItemRestore(pageUnloading: boolean): boolean {
  return !pageUnloading;
}
