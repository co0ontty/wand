import * as React from "react";
import { Suggestion } from "@ant-design/x";
import { Typography } from "antd";
import { usePopupDismiss } from "./ui/popup-lifecycle.js";
import { useImeGuard } from "./composer-sender/ime-guard.js";
import { quoteTerminalPath } from "../browser/pty-paste.js";

interface Entry { path: string; name: string; type: "file" | "dir"; }
interface Token { start: number; end: number; query: string; }
function pathToken(input: HTMLTextAreaElement): Token | null {
  if (input.selectionStart !== input.selectionEnd) return null;
  const end = input.selectionStart;
  const match = /(?:^|\s)@(?:"([^"\n]*)|([^\s"@]*))$/.exec(input.value.slice(0, end));
  return match ? { start: end - match[0].length + (match[0].startsWith("@") ? 0 : 1), end, query: match[1] ?? match[2] ?? "" } : null;
}

/** Read-only server-local discovery; edits still go through the original composer's input owner. */
export function FilePathSuggestions({ cwd = "", identity, terminal = false, children }: {
  cwd?: string; identity?: string; terminal?: boolean; children: React.ReactNode;
}): React.ReactElement {
  const host = React.useRef<HTMLDivElement>(null);
  const input = React.useRef<HTMLTextAreaElement | null>(null);
  const [token, setToken] = React.useState<Token | null>(null);
  const [items, setItems] = React.useState<Entry[]>([]);
  const [open, setOpen] = React.useState(false);
  const highlighted = React.useRef(0);
  const directorySelection = React.useRef(false);
  const [status, setStatus] = React.useState("");
  const snapshot = React.useRef("");
  const dismissed = React.useRef("");
  const ime = useImeGuard();
  const close = (): void => {
    const element = input.current;
    dismissed.current = element ? `${element.value}\0${element.selectionStart}` : "";
    setToken(null); setOpen(false);
  };
  usePopupDismiss(open, close);
  const update = (element: HTMLTextAreaElement): void => {
    input.current = element;
    snapshot.current = element.value;
    if (`${element.value}\0${element.selectionStart}` !== dismissed.current) setToken(pathToken(element));
  };
  React.useLayoutEffect(() => { close(); }, [identity, cwd]);
  React.useEffect(() => {
    if (!token) { setItems([]); setOpen(false); return; }
    const abort = new AbortController();
    setItems([]); setOpen(true); setStatus("正在查找本机文件…");
    const timer = window.setTimeout(() => {
      const query = token.query;
      const slash = query.lastIndexOf("/");
      const listing = !query || slash >= 0;
      const parent = slash >= 0 ? query.slice(0, slash + 1) : cwd;
      const directory = parent.startsWith("/") ? parent : [cwd, parent].filter(Boolean).join("/");
      const params = listing ? new URLSearchParams({ q: directory }) : new URLSearchParams({ q: query, cwd, limit: "30" });
      void fetch(`/api/${listing ? "directory" : "file-search"}?${params}`, { credentials: "same-origin", signal: abort.signal })
        .then(async response => {
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "无法读取本机文件");
          if (abort.signal.aborted) return;
          const prefix = query.slice(slash + 1).toLocaleLowerCase();
          const entries: Entry[] = (listing ? data.items : data.results) ?? [];
          const matches = entries.filter(entry => (entry.type === "file" || entry.type === "dir") && (!listing || entry.name.toLocaleLowerCase().startsWith(prefix))).slice(0, 30);
          highlighted.current = 0;
          setItems(matches); setStatus(matches.length ? "" : "没有匹配文件（本机服务目录）");
        }).catch(error => { if (!abort.signal.aborted) { setItems([]); setStatus(error.message); } });
    }, 150);
    return () => { window.clearTimeout(timer); abort.abort(); };
  }, [token, cwd]);
  const select = (path: string): void => {
    const element = input.current;
    const entry = items.find(item => item.path === path);
    if (!element || element.readOnly || element.disabled || !token || !entry || element.value !== snapshot.current || pathToken(element)?.start !== token.start || element.selectionStart !== token.end) return;
    const replacement = entry.type === "dir" ? `@"${path}/` : `${terminal ? quoteTerminalPath(path) : JSON.stringify(path)} `;
    const next = element.value.slice(0, token.start) + replacement + element.value.slice(token.end);
    // Use the native setter so React-controlled Sender inputs receive a real edit as well.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(element, next);
    element.focus({ preventScroll: true });
    element.setSelectionRange(token.start + replacement.length, token.start + replacement.length);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    if (entry.type === "dir") update(element);
    else close();
  };
  return <Suggestion open={open} onOpenChange={next => { if (next) setOpen(true); else if (directorySelection.current) { directorySelection.current = false; } else close(); }} block onSelect={path => { directorySelection.current = items.some(item => item.path === path && item.type === "dir"); select(path); }}
    items={items.length ? items.map(entry => ({ value: entry.path, label: <span title={entry.path}>{entry.type === "dir" ? "📁 " : ""}{entry.name}</span>, extra: <Typography.Text type="secondary" ellipsis style={{ maxWidth: 240 }}>{entry.path}</Typography.Text> }))
      : [{ value: "", label: status, disabled: true }] }>
    {({ onKeyDown }) => <div ref={host}
      onInputCapture={event => { if (event.target instanceof HTMLTextAreaElement && !(event.nativeEvent as InputEvent).isComposing) update(event.target); }}
      onCompositionStartCapture={ime.onCompositionStart}
      onCompositionEndCapture={event => { ime.onCompositionEnd(); if (event.target instanceof HTMLTextAreaElement) update(event.target); }}
      onSelect={event => { if (event.target instanceof HTMLTextAreaElement) update(event.target); }}
      onBlurCapture={event => { if (!host.current?.contains(event.relatedTarget as Node | null)) close(); }}
      onKeyDownCapture={event => {
        if (!open) return;
        if (ime.shouldIgnore(event)) { event.stopPropagation(); return; }
        if (event.key === "Tab") { close(); event.stopPropagation(); return; }
        if (["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(event.key)) {
          if (event.key === "Enter") {
            event.preventDefault();
            if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && items[highlighted.current]) select(items[highlighted.current]!.path);
          } else {
            if (items.length && (event.key === "ArrowUp" || event.key === "ArrowDown")) highlighted.current = (highlighted.current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
            onKeyDown(event);
          }
          event.stopPropagation();
        }
      }}>{children}</div>}
  </Suggestion>;
}
