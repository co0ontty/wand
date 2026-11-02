/** Codex currently reports writer conflicts as -32600 without a dedicated error kind. */
export function codexRpcError(
  method: string,
  error: { code?: unknown; message?: unknown },
  threadId?: string | null,
): Error & { definiteRejection: true; retryForbidden?: boolean } {
  const message = typeof error.message === "string" && error.message ? error.message : "Codex RPC rejected";
  // Only the resume RPC's explicit refusal for this exact thread is an ownership conflict.
  // Never infer it from assistant text, stderr, transport failures or another thread's events.
  const writerConflict = method === "thread/resume" && error.code === -32600 && !!threadId
    && (message === `thread ${threadId} already has an active writer`
      || message === `thread ${threadId} already has a live local writer`);
  return Object.assign(new Error(writerConflict
    ? `该 Codex 历史会话正被另一个 Codex 进程占用（桌面应用即使没有正在回复，也可能继续持有写入锁）。请先在占用它的应用中释放该会话，再回到 Wand 继续。历史已保留，本次输入尚未交给 Codex 执行。\n原始错误：${message}`
    : message), { definiteRejection: true as const, ...(writerConflict ? { retryForbidden: true } : {}) });
}
