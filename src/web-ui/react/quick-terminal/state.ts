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

export class QuickTerminalUnavailableError extends Error {
  constructor(readonly sessionId: string) { super("原终端已不存在，可以新建终端继续使用。"); }
}

// Do not automatically retry a creation POST: a failed response may have created a shell.
export async function resolveQuickTerminal(
  sessionId: string, cwd: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; cwd: string; status: string; navigationChanged: boolean }> {
  const response = await fetchImpl(sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}` : "/api/sessions", sessionId
    ? { credentials: "same-origin" }
    : { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "pty", shell: true, cwd: cwd || "~", sessionSource: "quick-terminal" }) });
  if (!response.ok) {
    if (sessionId && (response.status === 404 || response.status === 410)) throw new QuickTerminalUnavailableError(sessionId);
    throw new Error(!sessionId
      ? "创建终端未确认，已暂停重复创建，避免产生多个进程。刷新页面不会自动重试。"
      : response.status === 401 ? "登录已失效，请重新登录后连接原终端。"
      : response.status === 403 ? "没有访问原终端的权限，请检查当前连接账号。"
      : "暂时无法连接原终端，请检查网络后重新连接；不会自动新建进程。");
  }
  let value = await response.json();
  if (!value || typeof value.id !== "string" || !value.id || value.sessionKind !== "pty" || value.provider) {
    throw new Error("终端响应无效，请重新连接；不会自动重复创建。");
  }
  if (sessionId && value.id !== sessionId) throw new Error("原终端引用不一致，请重新连接。");
  let navigationChanged = !sessionId;
  if (sessionId && value.sessionSource !== "quick-terminal") {
    // Claim only this client's saved reference. A missing claim route is not
    // evidence that the original shell disappeared and must never permit a new POST.
    const claimed = await fetchImpl(`/api/sessions/${encodeURIComponent(sessionId)}/quick-terminal`, { method: "PUT", credentials: "same-origin" });
    if (!claimed.ok) throw new Error("原终端仍保留，但无法更新快捷终端标记，请重新连接。");
    value = await claimed.json();
    if (value?.id !== sessionId || value.sessionKind !== "pty" || value.provider || value.sessionSource !== "quick-terminal") {
      throw new Error("快捷终端标记未确认，请重新连接；不会自动新建进程。");
    }
    navigationChanged = true;
  }
  return { id: value.id, cwd: typeof value.cwd === "string" ? value.cwd : cwd, status: value.status, navigationChanged };
}
