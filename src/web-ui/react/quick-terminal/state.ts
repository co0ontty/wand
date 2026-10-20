export type TerminalDock = "right" | "bottom";
export const QUICK_TERMINAL_KEY = "wand.quick-terminal.v1";
export function terminalDock(value: unknown): TerminalDock {
  return value === "bottom" ? "bottom" : "right";
}
export interface QuickTerminalPreference { dock: TerminalDock; sessionId: string; creationPending?: boolean; }
export function readQuickTerminalPreference(storage: Pick<Storage, "getItem">): QuickTerminalPreference {
  try {
    const value = JSON.parse(storage.getItem(QUICK_TERMINAL_KEY) || "{}");
    return { dock: terminalDock(value?.dock), sessionId: typeof value?.sessionId === "string" ? value.sessionId : "", ...(value?.creationPending === true ? { creationPending: true } : {}) };
  } catch { return { dock: "right", sessionId: "" }; }
}
export function saveQuickTerminalPreference(storage: Pick<Storage, "setItem">, value: QuickTerminalPreference): boolean {
  try { storage.setItem(QUICK_TERMINAL_KEY, JSON.stringify(value)); return true; } catch { return false; }
}

/** Serialize creation in same-origin windows where the browser provides Web Locks. */
export async function withQuickTerminalLock<T>(action: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) return navigator.locks.request(QUICK_TERMINAL_KEY, action);
  return action();
}

// Do not automatically retry a creation POST: a failed response may have created a shell.
export async function resolveQuickTerminal(
  sessionId: string, cwd: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; cwd: string; status: string }> {
  const response = await fetchImpl(sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}` : "/api/sessions", sessionId
    ? { credentials: "same-origin" }
    : { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "pty", shell: true, cwd: cwd || "~", sessionSource: "interactive" }) });
  if (!response.ok) throw new Error(sessionId
    ? "无法连接原终端。请检查连接或在会话列表中确认它是否已结束；不会自动新建进程。"
    : "创建终端未确认。请先在会话列表中检查，避免重复创建。刷新页面不会自动重试。");
  const value = await response.json();
  if (!value || typeof value.id !== "string" || !value.id || value.sessionKind !== "pty" || value.provider) {
    throw new Error("终端响应无效，请在会话列表中确认；不会自动重复创建。");
  }
  return { id: value.id, cwd: typeof value.cwd === "string" ? value.cwd : cwd, status: value.status };
}
