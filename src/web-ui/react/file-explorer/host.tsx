import * as React from "react";
import { useSyncExternalStore } from "react";
import { wandOverlay } from "../overlay-controller";
import { WandButton, WandMenuItem, WandSearchField } from "../ui";
import { copyTextToPlatformClipboard } from "../file-preview/platform-adapter";
import { codeEditorController, codeEditorStore } from "../code-editor/controller";
import { fileExplorerController, fileExplorerStore } from "./controller";
import { MoveEntryDialog, type MoveEntryRequest } from "./move-dialog";
import { explorerParentOf as parentOf, isPathWithin, joinExplorerPath as joinPath } from "./paths";
import { fileExplorerStyles } from "./styles";
import type {
  FileExplorerEntry,
  FileExplorerNodeState,
  FileExplorerSnapshot,
} from "./types";

type ExplorerIconName =
  | "folder" | "folderOpen" | "file" | "image" | "code" | "media" | "archive"
  | "pdf" | "markdown" | "newFile" | "newFolder" | "refresh";

// Monochrome stroke glyphs — replace the old per-type emoji map with a small,
// currentColor set so the explorer reads like a minimal IDE tree, not a wall of
// colored emoji.
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico", "heic", "heif"]);
const MEDIA_EXT = new Set(["mp4", "webm", "mov", "mkv", "m4v", "ogv", "mp3", "wav", "ogg", "m4a", "flac", "aac", "opus"]);
const ARCHIVE_EXT = new Set(["zip", "tar", "gz", "tgz", "bz2", "7z", "rar", "xz"]);
const MARKDOWN_EXT = new Set(["md", "markdown", "mdx"]);
const TEXT_EXT = new Set(["txt", "log"]);
const PDF_EXT = new Set(["pdf"]);
const CODE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
  "py", "rb", "go", "rs", "java", "c", "cpp", "h", "hpp", "cs", "swift", "kt", "scala", "php", "sh", "bash",
  "zsh", "fish", "lua", "sql", "graphql", "proto", "vue", "svelte", "html", "htm", "xml", "css", "scss", "less",
  "diff", "patch",
]);

function iconForEntry(entry: FileExplorerEntry, isOpen: boolean): ExplorerIconName {
  if (entry.type === "dir") return isOpen ? "folderOpen" : "folder";
  const name = entry.name.toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 && dot < name.length - 1 ? name.slice(dot + 1) : "";
  if (IMAGE_EXT.has(ext)) return "image";
  if (MEDIA_EXT.has(ext)) return "media";
  if (ARCHIVE_EXT.has(ext)) return "archive";
  if (PDF_EXT.has(ext)) return "pdf";
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  if (TEXT_EXT.has(ext)) return "file";
  if (CODE_EXT.has(ext)) return "code";
  return "file";
}

function ExplorerIcon({ name, size = 16 }: { name: ExplorerIconName; size?: number }) {
  const common = {
    className: "wand-fe-icon",
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "folder": return <svg {...common}><path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2z"/></svg>;
    case "folderOpen": return <svg {...common}><path d="M6 14l1.5-3A2 2 0 0 1 9.2 10H20a2 2 0 0 1 1.9 2.5l-1.5 6A2 2 0 0 1 18.4 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v2"/></svg>;
    case "file": return <svg {...common}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>;
    case "image": return <svg {...common}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4.5-4.5L5 21"/></svg>;
    case "code": return <svg {...common}><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>;
    case "media": return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/></svg>;
    case "archive": return <svg {...common}><path d="M4 4h16v4H4z"/><path d="M5 8v12h14V8"/><path d="M12 12v4"/></svg>;
    case "pdf": return <svg {...common}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M8 13h5M8 17h8"/></svg>;
    case "markdown": return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15V9l3 4 3-4v6"/></svg>;
    case "newFile": return <svg {...common}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 12v6M9 15h6"/></svg>;
    case "newFolder": return <svg {...common}><path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2z"/><path d="M12 11v6M9 14h6"/></svg>;
    case "refresh": return <svg {...common}><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>;
  }
}

function gitBadge(entry: FileExplorerEntry): { text: string; className: string } | null {
  const g = entry.gitStatus;
  if (!g) return null;
  if (g.staged === "added") return { text: "A", className: "git-added" };
  if (g.staged === "modified") return { text: "M", className: "git-modified" };
  if (g.staged === "deleted") return { text: "D", className: "git-deleted" };
  if (g.staged === "renamed") return { text: "R", className: "git-renamed" };
  if (g.unstaged === "modified") return { text: "M", className: "git-modified" };
  if (g.unstaged === "deleted") return { text: "D", className: "git-deleted" };
  if (g.untracked) return { text: "?", className: "git-untracked" };
  return null;
}

interface ContextMenuState {
  x: number;
  y: number;
  entry: FileExplorerEntry | null;
  dir: string;
}

interface PendingCreate {
  dir: string;
  kind: "file" | "dir";
}

const TreeItemsContext = React.createContext<Map<string, HTMLDivElement> | null>(null);

function ExplorerRow({
  entry,
  depth,
  snapshot,
  activePath,
  onToggle,
  onFileActivate,
  onContextMenu,
  renameState,
  setRenameState,
  onCreateChild,
  pendingCreate,
  setPendingCreate,
}: {
  entry: FileExplorerEntry;
  depth: number;
  snapshot: FileExplorerSnapshot;
  activePath: string | null;
  onToggle(dir: string): void;
  onFileActivate(path: string): void;
  onContextMenu(state: ContextMenuState): void;
  renameState: { path: string } | null;
  setRenameState(state: { path: string } | null): void;
  onCreateChild(dir: string, kind: "file" | "dir"): void;
  pendingCreate: PendingCreate | null;
  setPendingCreate(state: PendingCreate | null): void;
}) {
  const treeItems = React.useContext(TreeItemsContext);
  const isDir = entry.type === "dir";
  const nodeState: FileExplorerNodeState | undefined = isDir ? snapshot.expanded.get(entry.path) : undefined;
  const isOpen = Boolean(nodeState);
  // Only hide the disclosure once we actually know the directory is empty.
  // `!hasChildren` used to fold "collapsed / loading / failed" into `empty`,
  // so expandable folders rendered without a chevron and looked like files.
  const isEmptyDir = Boolean(
    isDir && isOpen && nodeState?.status === "loaded" && nodeState.entries.length === 0,
  );
  const showChevron = isDir && !isEmptyDir;
  const isActiveFile = !isDir && activePath === entry.path;
  const badge = gitBadge(entry);

  const [renameDraft, setRenameDraft] = React.useState(entry.name);
  React.useEffect(() => {
    if (renameState?.path === entry.path) setRenameDraft(entry.name);
  }, [renameState?.path, entry.name]);

  const commitRename = async () => {
    const newName = renameDraft.trim();
    setRenameState(null);
    if (!newName || newName === entry.name) return;
    const target = joinPath(parentOf(entry.path), newName);
    if (target === entry.path) return;
    await fileExplorerController.execute({ type: "rename", from: entry.path, to: target });
  };

  const isCreatingHere = pendingCreate?.dir === entry.path;
  const isRenaming = renameState?.path === entry.path;

  if (isRenaming) {
    return (
      <div className="wand-explorer-row editing" style={{ paddingLeft: 8 + depth * 12 }}>
        <span className="wand-explorer-rename">
          <span className="wand-explorer-icon"><ExplorerIcon name={iconForEntry(entry, false)}/></span>
          <input
            value={renameDraft}
            autoFocus
            spellCheck={false}
            onChange={(event) => setRenameDraft(event.currentTarget.value)}
            onClick={(event) => event.stopPropagation()}
            onBlur={() => void commitRename()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setRenameState(null);
              }
            }}
          />
        </span>
      </div>
    );
  }

  return (
    <>
      <div
        className={`wand-explorer-row${isActiveFile ? " active" : ""}`}
        ref={(node) => {
          if (node) treeItems?.set(entry.path, node);
          else treeItems?.delete(entry.path);
        }}
        style={{ paddingLeft: 8 + depth * 12 }}
        role="treeitem"
        tabIndex={0}
        aria-label={entry.name}
        aria-level={depth + 1}
        aria-expanded={isDir ? isOpen : undefined}
        aria-selected={isActiveFile}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            onContextMenu({ x: bounds.left + 12, y: bounds.bottom, entry, dir: parentOf(entry.path) });
          } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && treeItems) {
            event.preventDefault();
            const rows = [...treeItems.values()].filter((node) => node.isConnected);
            rows.sort((left, right) => {
              if (left === right) return 0;
              return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
            });
            const index = rows.indexOf(event.currentTarget);
            let next = index + (event.key === "ArrowDown" ? 1 : -1);
            if (event.key === "Home") next = 0;
            if (event.key === "End") next = rows.length - 1;
            rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (isDir) onToggle(entry.path);
            else onFileActivate(entry.path);
          } else if (isDir && ((event.key === "ArrowRight" && !isOpen) || (event.key === "ArrowLeft" && isOpen))) {
            event.preventDefault();
            onToggle(entry.path);
          }
        }}
        title={entry.path}
        onClick={() => {
          if (isDir) onToggle(entry.path);
          else onFileActivate(entry.path);
        }}
        onDoubleClick={() => {
          if (isDir) {
            void fileExplorerController.execute({ type: "navigate", dir: entry.path });
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu({ x: event.clientX, y: event.clientY, entry, dir: parentOf(entry.path) });
        }}
      >
        <span className={`wand-explorer-chevron${isOpen ? " open" : ""}${showChevron ? "" : " empty"}`} aria-hidden="true">
          {showChevron ? "▸" : ""}
        </span>
        <span className="wand-explorer-icon" aria-hidden="true"><ExplorerIcon name={iconForEntry(entry, isOpen && isDir)}/></span>
        <span className="wand-explorer-name">{entry.name}</span>
        {badge && <span className={`wand-explorer-git ${badge.className}`} title={entry.path}>{badge.text}</span>}
      </div>
      {isDir && isOpen && (
        <div className="wand-explorer-children">
          {nodeState?.status === "loading" && (
            <div className="wand-explorer-row" style={{ paddingLeft: 8 + (depth + 1) * 12, color: "var(--text-muted, #999)" }}>
              <span className="wand-explorer-chevron empty"/>
              <span className="wand-explorer-name">加载中…</span>
            </div>
          )}
          {nodeState?.status === "error" && (
            <div className="wand-explorer-row" style={{ paddingLeft: 8 + (depth + 1) * 12, color: "#c0392b" }}>
              <span className="wand-explorer-chevron empty"/>
              <span className="wand-explorer-name">{nodeState.error || "读取失败"}</span>
            </div>
          )}
          {nodeState?.status === "loaded" && nodeState.entries.length === 0 && (
            <div className="wand-explorer-row" style={{ paddingLeft: 8 + (depth + 1) * 12, color: "var(--text-muted, #999)" }}>
              <span className="wand-explorer-chevron empty"/>
              <span className="wand-explorer-name">（空目录）</span>
            </div>
          )}
          {isCreatingHere && pendingCreate && (
            <CreateInput
              depth={depth + 1}
              kind={pendingCreate.kind}
              onCancel={() => setPendingCreate(null)}
              onSubmit={async (name) => {
                const dir = pendingCreate.dir;
                setPendingCreate(null);
                if (!name) return;
                await fileExplorerController.execute({
                  type: pendingCreate.kind === "file" ? "create.file" : "create.dir",
                  dir,
                  name,
                });
              }}
            />
          )}
          {nodeState?.status === "loaded" && nodeState.entries.map((child) => (
            <ExplorerRow
              key={child.path}
              entry={child}
              depth={depth + 1}
              snapshot={snapshot}
              activePath={activePath}
              onToggle={onToggle}
              onFileActivate={onFileActivate}
              onContextMenu={onContextMenu}
              renameState={renameState}
              setRenameState={setRenameState}
              onCreateChild={onCreateChild}
              pendingCreate={pendingCreate}
              setPendingCreate={setPendingCreate}
            />
          ))}
        </div>
      )}
      {!isDir && isCreatingHere && pendingCreate && (
        <CreateInput
          depth={depth + 1}
          kind={pendingCreate.kind}
          onCancel={() => setPendingCreate(null)}
          onSubmit={async (name) => {
            const dir = pendingCreate.dir;
            setPendingCreate(null);
            if (!name) return;
            await fileExplorerController.execute({
              type: pendingCreate.kind === "file" ? "create.file" : "create.dir",
              dir,
              name,
            });
          }}
        />
      )}
    </>
  );
}

function CreateInput({
  depth,
  kind,
  onCancel,
  onSubmit,
}: {
  depth: number;
  kind: "file" | "dir";
  onCancel(): void;
  onSubmit(name: string): void;
}) {
  const [value, setValue] = React.useState("");
  return (
    <div className="wand-explorer-row editing" style={{ paddingLeft: 8 + depth * 12 }}>
      <span className="wand-explorer-rename">
        <span className="wand-explorer-icon"><ExplorerIcon name={kind === "file" ? "file" : "folder"}/></span>
        <input
          value={value}
          autoFocus
          placeholder={kind === "file" ? "文件名（回车创建，Esc 取消）" : "文件夹名（回车创建，Esc 取消）"}
          spellCheck={false}
          onChange={(event) => setValue(event.currentTarget.value)}
          onClick={(event) => event.stopPropagation()}
          onBlur={() => (value.trim() ? onSubmit(value) : onCancel())}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onSubmit(value);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            }
          }}
        />
      </span>
    </div>
  );
}

function ContextMenu({
  state,
  onClose,
  onAction,
}: {
  state: ContextMenuState;
  onClose(): void;
  onAction(action: string): void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const buttons = React.useRef(new Map<string, HTMLButtonElement>());
  const focusOrigin = React.useRef(document.activeElement);
  React.useEffect(() => {
    const handle = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const scroll = () => onClose();
    window.addEventListener("mousedown", handle, true);
    window.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("mousedown", handle, true);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [onClose]);

  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const vh = typeof window !== "undefined" ? window.innerHeight : 768;
  const left = Math.min(state.x, vw - 184);
  const top = Math.min(state.y, vh - 320);

  const entry = state.entry;
  const isDir = entry?.type === "dir";
  const targetDir = isDir && entry ? entry.path : state.dir;

  const item = (label: string, action: string, opts: { danger?: boolean; disabled?: boolean } = {}) => (
    <WandMenuItem
      label={label}
      tone={opts.danger ? "danger" : "default"}
      autoFocus={action === "newFile"}
      ref={(node) => {
        if (node) buttons.current.set(action, node);
        else buttons.current.delete(action);
      }}
      className={`wand-explorer-context-item${opts.danger ? " danger" : ""}`}
      disabled={opts.disabled}
      onClick={() => { onAction(action); }}
    />
  );

  return (
    <div
      ref={ref}
      className="wand-explorer-context-menu"
      style={{ left: Math.max(8, left), top: Math.max(8, top) }}
      role="menu"
      aria-label="文件操作"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          if (focusOrigin.current instanceof HTMLElement) focusOrigin.current.focus();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const items = [...buttons.current.values()].filter((item) => !item.disabled);
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = index + (event.key === "ArrowDown" ? 1 : -1);
          items[(next + items.length) % items.length]?.focus();
        }
      }}
    >
      {item("新建文件", "newFile", { disabled: !targetDir })}
      {item("新建文件夹", "newDir", { disabled: !targetDir })}
      <div className="wand-explorer-context-divider"/>
      {entry ? (
        <>
          {isDir ? item("进入此目录", "navigate") : item("打开", "open")}
          {item("复制完整路径", "copyPath")}
          {item("复制相对路径", "copyRelative")}
          {!isDir && item("下载文件", "download")}
          <div className="wand-explorer-context-divider"/>
          {item("重命名", "rename")}
          {item("移动到…", "move")}
          {item("删除", "delete", { danger: true })}
        </>
      ) : (
        <>
          {item("刷新", "refresh")}
          {item("复制目录路径", "copyPath")}
        </>
      )}
    </div>
  );
}

export function FileExplorerHost({ root }: { root: string }) {
  const treeItems = React.useRef(new Map<string, HTMLDivElement>());
  const snapshot = useFileExplorerSnapshot();
  const editor = useSyncExternalStore(codeEditorStore.subscribe, codeEditorStore.getSnapshot, codeEditorStore.getSnapshot);
  const activePath = editor.open ? editor.activePath : null;
  const dispatch = fileExplorerController;
  const [contextMenu, setContextMenu] = React.useState<ContextMenuState | null>(null);
  const [renameState, setRenameState] = React.useState<{ path: string } | null>(null);
  const [pendingCreate, setPendingCreate] = React.useState<PendingCreate | null>(null);
  const [moveRequest, setMoveRequest] = React.useState<MoveEntryRequest | null>(null);
  const [searchInput, setSearchInput] = React.useState(snapshot.searchQuery);

  React.useEffect(() => {
    if (root) dispatch.setRoot(root);
  }, [root, dispatch]);

  React.useEffect(() => {
    setSearchInput(snapshot.searchQuery);
  }, [snapshot.searchQuery]);

  const rootNode = snapshot.root ? snapshot.expanded.get(snapshot.root) : undefined;
  const showingSearch = snapshot.searchQuery.trim().length > 0 && snapshot.searchResults !== null;

  const handleAction = async (action: string) => {
    const ctx = contextMenu;
    setContextMenu(null);
    if (!ctx) return;
    const entry = ctx.entry;
    if (action === "newFile") { setPendingCreate({ dir: ctx.entry?.type === "dir" ? ctx.entry.path : ctx.dir, kind: "file" }); return; }
    if (action === "newDir") { setPendingCreate({ dir: ctx.entry?.type === "dir" ? ctx.entry.path : ctx.dir, kind: "dir" }); return; }
    if (action === "navigate" && entry) { void dispatch.execute({ type: "navigate", dir: entry.path }); return; }
    if (action === "open" && entry) { codeEditorController.open(entry.path); return; }
    if (action === "rename" && entry) { setRenameState({ path: entry.path }); return; }
    if (action === "move" && entry) {
      setMoveRequest({ from: entry.path, initialDir: parentOf(entry.path), isDir: entry.type === "dir" });
      return;
    }
    if (action === "delete" && entry) { void dispatch.execute({ type: "delete", path: entry.path }); return; }
    if (action === "refresh") { void dispatch.execute({ type: "refresh", dir: ctx.dir }); return; }
    if (action === "copyPath" && entry) {
      const ok = await copyText(entry.path);
      notify(ok ? "已复制路径" : "复制失败", ok ? "success" : "error");
      return;
    }
    if (action === "copyRelative" && entry && snapshot.root) {
      const rel = relativePath(entry.path, snapshot.root);
      const ok = await copyText(rel);
      notify(ok ? "已复制相对路径" : "复制失败", ok ? "success" : "error");
      return;
    }
    if (action === "download" && entry) {
      const a = document.createElement("a");
      a.href = `/api/file-raw?download=1&path=${encodeURIComponent(entry.path)}`;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }
  };

  return (
    <TreeItemsContext.Provider value={treeItems.current}>
      <style id="wand-file-explorer-styles">{fileExplorerStyles}</style>
      <div className="wand-file-explorer" onContextMenu={(event) => {
        // background context menu (empty area)
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        setContextMenu({ x: event.clientX, y: event.clientY, entry: null, dir: snapshot.activeDir || snapshot.root });
      }}>
        <div className="wand-file-explorer-toolbar">
          <span className="wand-file-explorer-title">资源管理器</span>
          <button
            type="button"
            className="wand-file-explorer-btn"
            title="新建文件"
            aria-label="新建文件"
            disabled={!snapshot.root || snapshot.busy}
            onClick={() => setPendingCreate({ dir: snapshot.activeDir || snapshot.root, kind: "file" })}
          ><ExplorerIcon name="newFile" size={15}/></button>
          <button
            type="button"
            className="wand-file-explorer-btn"
            title="新建文件夹"
            aria-label="新建文件夹"
            disabled={!snapshot.root || snapshot.busy}
            onClick={() => setPendingCreate({ dir: snapshot.activeDir || snapshot.root, kind: "dir" })}
          ><ExplorerIcon name="newFolder" size={15}/></button>
          <button
            type="button"
            className="wand-file-explorer-btn"
            title="刷新"
            aria-label="刷新"
            disabled={!snapshot.root || snapshot.busy}
            onClick={() => void dispatch.execute({ type: "refresh" })}
          ><ExplorerIcon name="refresh" size={15}/></button>
        </div>
        <div className="wand-file-explorer-search">
          <WandSearchField
            value={searchInput}
            label="搜索文件"
            placeholder="搜索文件…"
            disabled={!snapshot.root}
            onValueChange={setSearchInput}
            onSearch={(query) => void dispatch.execute({ type: "search.start", query })}
          />
          {snapshot.searching && <span aria-hidden="true">…</span>}
        </div>
        <div className="wand-file-explorer-tree" role="tree" aria-label="文件树">
          {!snapshot.root && (
            <div className="wand-file-explorer-empty">尚未选择工作目录。</div>
          )}
          {snapshot.root && rootNode?.status === "loading" && !rootNode.entries.length && (
            <div className="wand-file-explorer-empty">加载中…</div>
          )}
          {snapshot.root && rootNode?.status === "error" && (
            <div className="wand-file-explorer-empty">{rootNode.error || "读取目录失败"}</div>
          )}
          {snapshot.searchError ? <div className="wand-file-explorer-empty" role="alert">
            <p>{snapshot.searchError}</p>
            <WandButton kind="ghost" size="small" onClick={() => void dispatch.execute({ type: "search.start", query: searchInput })}>重试搜索</WandButton>
          </div> : showingSearch ? (
            snapshot.searchResults && snapshot.searchResults.length > 0 ? (
              snapshot.searchResults.map((entry) => (
                <ExplorerRow
                  key={entry.path}
                  entry={entry}
                  depth={0}
                  snapshot={snapshot}
                  activePath={activePath}
                  onToggle={(dir) => void dispatch.execute({ type: "toggle", dir })}
                  onFileActivate={(path) => void codeEditorController.open(path)}
                  onContextMenu={(state) => setContextMenu(state)}
                  renameState={renameState}
                  setRenameState={setRenameState}
                  onCreateChild={(dir, kind) => setPendingCreate({ dir, kind })}
                  pendingCreate={pendingCreate}
                  setPendingCreate={setPendingCreate}
                />
              ))
            ) : (
              <div className="wand-file-explorer-empty">没有找到匹配的文件</div>
            )
          ) : (
            rootNode?.status === "loaded" && rootNode.entries.length > 0 && (
              <>
                {pendingCreate && pendingCreate.dir === snapshot.root && (
                  <CreateInput
                    depth={0}
                    kind={pendingCreate.kind}
                    onCancel={() => setPendingCreate(null)}
                    onSubmit={async (name) => {
                      const dir = pendingCreate.dir;
                      setPendingCreate(null);
                      if (!name) return;
                      await dispatch.execute({
                        type: pendingCreate.kind === "file" ? "create.file" : "create.dir",
                        dir,
                        name,
                      });
                    }}
                  />
                )}
                {rootNode.entries.map((entry) => (
                  <ExplorerRow
                    key={entry.path}
                    entry={entry}
                    depth={0}
                    snapshot={snapshot}
                    activePath={activePath}
                    onToggle={(dir) => void dispatch.execute({ type: "toggle", dir })}
                    onFileActivate={(path) => void codeEditorController.open(path)}
                    onContextMenu={(state) => setContextMenu(state)}
                    renameState={renameState}
                    setRenameState={setRenameState}
                    onCreateChild={(dir, kind) => setPendingCreate({ dir, kind })}
                    pendingCreate={pendingCreate}
                    setPendingCreate={setPendingCreate}
                  />
                ))}
              </>
            )
          )}
        </div>
      </div>
      {contextMenu && (
        <ContextMenu
          state={contextMenu}
          onClose={() => setContextMenu(null)}
          onAction={(action) => void handleAction(action)}
        />
      )}
      <MoveEntryDialog
        request={moveRequest}
        onDismiss={() => setMoveRequest(null)}
        onSubmit={async (from, to) => {
          const request = moveRequest;
          if (!request) return false;
          if (to === from) {
            notify("目标位置与当前位置相同。", "warning");
            return false;
          }
          // A folder cannot land inside itself or one of its own descendants:
          // reject both the folder itself and any path underneath it.
          if (request.isDir && isPathWithin(to, from)) {
            notify("不能把文件夹移动到它自己或它的子目录中。", "warning");
            return false;
          }
          const moved = await dispatch.execute({ type: "move", from, to });
          if (moved) setMoveRequest(null);
          return moved;
        }}
      />
    </TreeItemsContext.Provider>
  );
}

function useFileExplorerSnapshot(): FileExplorerSnapshot {
  return useSyncExternalStore(
    fileExplorerStore.subscribe,
    fileExplorerStore.getSnapshot,
    fileExplorerStore.getSnapshot,
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await copyTextToPlatformClipboard(text);
    return true;
  } catch {
    return false;
  }
}

function notify(message: string, tone: "success" | "error" | "info" | "warning"): void {
  wandOverlay.toast(message, { tone });
}

function relativePath(target: string, base: string): string {
  if (!target.startsWith(base)) return target;
  const rel = target.slice(base.length).replace(/^\/+/, "");
  return rel || ".";
}
