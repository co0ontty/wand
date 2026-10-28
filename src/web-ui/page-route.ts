/** Shareable, same-origin navigation. Only explicit application state is copied. */
export const PAGE_ROUTE_EVENT = "wand:page-route";
export const PAGE_ROUTE_KEYS = new Set([
  "view", "session", "workspace", "workspaceTask", "window", "tab", "task", "run", "team", "settings", "range",
  "sidebar", "sidebarQuery", "workspaceView", "conversation", "conversationTask", "conversationRun",
  "chatFilter", "chatActivity", "chatQuery", "directoryTab", "directoryQuery",
  "boardView", "q", "directory", "sort", "filters",
  "scheduleView", "scheduleQuery", "scheduleFilter", "scheduleRange", "scheduleDate",
  "teamQuery", "teamFilter", "teamPage", "settingsNested",
  "knowledgeScope", "knowledgeOwner", "knowledgeDocument",
]);
/** Former URL state that is now a local preference. Old links are tolerated and cleaned on the next write. */
const LEGACY_KEYS = ["sidebarMode", "display", "zoom", "hideCompleted", "queue", "expandedTask", "boardCollapsed", "scheduleExpanded"];
/** Parameters owned by one page; leaving that page drops them so the address does not accumulate. */
const VIEW_SCOPED: Array<{ views: string[]; keys: string[] }> = [
  { views: ["knowledge"], keys: ["knowledgeScope", "knowledgeOwner", "knowledgeDocument"] },
  { views: ["taskboard", "issues"], keys: ["boardView", "q", "sort", "filters", "directory", "task"] },
  { views: ["teams", "teamchat"], keys: ["team", "teamQuery", "teamFilter", "teamPage", "run"] },
  { views: ["schedules", "calendar"], keys: ["scheduleView", "scheduleQuery", "scheduleFilter", "scheduleRange", "scheduleDate", "range"] },
  { views: ["chats", "contacts"], keys: ["conversation", "conversationTask", "conversationRun", "chatFilter", "chatActivity", "chatQuery", "directoryTab", "directoryQuery"] },
];
const COMPATIBILITY_KEYS = new Set([...LEGACY_KEYS, "embed", "reactUi", "nativeInput", "reactShell", "backToNative", "switchServer", "passthrough"]);

export function pageSearch(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}

export function subscribePageRoute(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("popstate", listener);
  window.addEventListener(PAGE_ROUTE_EVENT, listener);
  return () => { window.removeEventListener("popstate", listener); window.removeEventListener(PAGE_ROUTE_EVENT, listener); };
}

/** Values above this are state dumps, not links; they would only bloat the address bar. */
const MAX_VALUE_LENGTH = 256;
const TRAILING_DELAY_MS = 300;
let pending: Record<string, string | null> | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

/** Pure merge of a patch into a query string. */
export function mergePageSearch(search: string, patch: Record<string, string | null>): string {
  const params = new URLSearchParams(search);
  for (const key of LEGACY_KEYS) params.delete(key);
  const view = patch.view;
  if (view && view !== params.get("view")) {
    for (const group of VIEW_SCOPED) if (!group.views.includes(view)) for (const key of group.keys) if (!(key in patch)) params.delete(key);
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === "" || value.length > MAX_VALUE_LENGTH) params.delete(key);
    else params.set(key, value);
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

function writeRoute(patch: Record<string, string | null>, mode: "push" | "replace"): void {
  const url = new URL(window.location.href);
  url.search = mergePageSearch(url.search, patch);
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (next === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  window.history[mode === "push" ? "pushState" : "replaceState"](window.history.state, "", next);
  window.dispatchEvent(new Event(PAGE_ROUTE_EVENT));
}

/** Writes any coalesced high-frequency update now, so later pushes keep their order. */
export function flushPageRoute(): void {
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
  const patch = pending;
  pending = null;
  if (patch && typeof window !== "undefined") writeRoute(patch, "replace");
}

/** Typing-rate updates (search boxes): merged and written once as a single replace entry. */
export function scheduleReplacePageRoute(patch: Record<string, string | null>): void {
  if (typeof window === "undefined") return;
  pending = { ...pending, ...patch };
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(flushPageRoute, TRAILING_DELAY_MS);
}
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPageRoute);
}

/** Updates merge with the live URL, never a captured render. No auth material is added. */
export function updatePageRoute(patch: Record<string, string | null>, mode: "push" | "replace" = "push"): void {
  if (typeof window === "undefined") return;
  flushPageRoute();
  writeRoute(patch, mode);
}

/**
 * Already inside a workspace session: switching sessions replaces the current entry.
 * iOS edge-swipe then returns to the page that opened the session, not the previous session.
 * Entering a session from another page still pushes one entry.
 */
export function workspaceSessionHistoryMode(search: string, nextSessionId: string | null): "push" | "replace" {
  const params = new URLSearchParams(search);
  const current = params.get("session");
  if (params.get("view") === "workspace" && current && nextSessionId && nextSessionId !== current) return "replace";
  return "push";
}

/** One user intent, one history entry. The existing route restorer resolves task ownership. */
export function openSessionPage(sessionId: string): void {
  const id = sessionId.trim();
  if (!id) return;
  updatePageRoute({ view: "workspace", session: id, task: null, workspace: null, workspaceTask: null, window: null, tab: null });
}

export function hasPageRoute(search = pageSearch()): boolean {
  const params = new URLSearchParams(search);
  return [...params.keys()].some(key => PAGE_ROUTE_KEYS.has(key));
}

export function shareablePageUrl(href: string): string {
  const source = new URL(href);
  const url = new URL(source.pathname, source.origin);
  for (const [key, value] of source.searchParams) if (PAGE_ROUTE_KEYS.has(key)) url.searchParams.append(key, value);
  return url.href;
}

export function unknownPageParameters(search: string): string[] {
  return [...new Set(new URLSearchParams(search).keys())].filter(key => !PAGE_ROUTE_KEYS.has(key) && !COMPATIBILITY_KEYS.has(key));
}
