import { wandOverlay } from "../overlay-controller";
import { copyTextToPlatformClipboard } from "../file-preview/platform-adapter";
import { httpFileExplorerRepository } from "./repository";
import type {
  FileExplorerCommand,
  FileExplorerEntry,
  FileExplorerNodeState,
  FileExplorerRepository,
  FileExplorerRuntimeAdapter,
  FileExplorerSnapshot,
  WandFileExplorerController,
} from "./types";
import type { FilePreviewFailure } from "../file-preview/types";

type Listener = () => void;
type ExpandedMap = Map<string, FileExplorerNodeState>;

export interface FileExplorerModuleOptions {
  repository: FileExplorerRepository;
  runtime?: FileExplorerRuntimeAdapter;
}

export interface FileExplorerStore {
  subscribe(listener: Listener): () => void;
  getSnapshot(): FileExplorerSnapshot;
}

export interface FileExplorerModule {
  controller: WandFileExplorerController;
  store: FileExplorerStore;
  configureRuntime(adapter: FileExplorerRuntimeAdapter): () => void;
}

function unknownFailure(error: unknown, fallback: string): FilePreviewFailure {
  return { message: error instanceof Error && error.message ? error.message : fallback };
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function parentOf(inputPath: string): string {
  const normalized = inputPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized || normalized === "/") return "/";
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "/";
  return normalized.slice(0, index);
}

const defaultRuntime: FileExplorerRuntimeAdapter = {
  openFile(): void {},
  notify(message, tone): void {
    wandOverlay.toast(message, { tone });
  },
  async copyText(text): Promise<boolean> {
    try {
      await copyTextToPlatformClipboard(text);
      return true;
    } catch {
      return false;
    }
  },
  async confirmDelete(path, isDir): Promise<boolean> {
    const result = await wandOverlay.dialog({
      title: "确认删除",
      description: `确定要删除${isDir ? "文件夹" : "文件"}「${path}」吗？此操作不可撤销。`,
      tone: "warning",
      actions: [
        { label: "取消", value: false, kind: "secondary", autoFocus: true },
        { label: "删除", value: true, kind: "danger" },
      ],
      dismissable: true,
    });
    return result.dismissed === false && result.action === true;
  },
  async promptForName(title, defaultValue): Promise<string | null> {
    const result = await wandOverlay.dialog<string>({
      title,
      input: { value: defaultValue, label: "名称" },
      actions: [
        { label: "取消", value: "", kind: "secondary" },
        { label: "确认", value: "confirm", kind: "primary", autoFocus: true },
      ],
      dismissable: true,
    });
    if (result.dismissed === true) return null;
    if (result.action !== "confirm") return null;
    const value = (result.inputValue ?? "").trim();
    return value || null;
  },
};

export function createFileExplorerModule(options: FileExplorerModuleOptions): FileExplorerModule {
  const listeners = new Set<Listener>();
  let snapshot: FileExplorerSnapshot = {
    revision: 0,
    root: "",
    activeDir: "",
    expanded: new Map() as ReadonlyMap<string, FileExplorerNodeState>,
    searchQuery: "",
    searchResults: null,
    searching: false,
    busy: false,
  };
  let runtime = options.runtime ?? defaultRuntime;
  const abortByDir = new Map<string, AbortController>();
  let searchAbort: AbortController | null = null;

  function publish(patch: Partial<FileExplorerSnapshot>): void {
    snapshot = { ...snapshot, ...patch, revision: snapshot.revision + 1 };
    for (const listener of listeners) listener();
  }

  function publishExpanded(expanded: ExpandedMap): void {
    publish({ expanded: new Map(expanded) as ReadonlyMap<string, FileExplorerNodeState> });
  }

  function failureMessage(failure: FilePreviewFailure | undefined, fallback: string): string {
    return failure?.message || fallback;
  }

  async function loadDir(dirPath: string): Promise<void> {
    const previous = abortByDir.get(dirPath);
    previous?.abort();
    const abort = new AbortController();
    abortByDir.set(dirPath, abort);
    const expanded = new Map(snapshot.expanded as ExpandedMap);
    expanded.set(dirPath, { entries: [], status: "loading" });
    publishExpanded(expanded);
    try {
      const result = await options.repository.list(dirPath, abort.signal);
      if (abort.signal.aborted) return;
      const next = new Map(snapshot.expanded as ExpandedMap);
      if (result.ok && result.entries) {
        next.set(dirPath, { entries: result.entries, status: "loaded" });
      } else {
        next.set(dirPath, {
          entries: [],
          status: "error",
          error: failureMessage(result.failure, "读取目录失败"),
        });
      }
      publishExpanded(next);
    } catch (error) {
      if (abort.signal.aborted || isAbort(error)) return;
      const next = new Map(snapshot.expanded as ExpandedMap);
      next.set(dirPath, {
        entries: [],
        status: "error",
        error: unknownFailure(error, "读取目录失败").message,
      });
      publishExpanded(next);
    } finally {
      abortByDir.delete(dirPath);
    }
  }

  function refreshExpanded(dirPath: string, entries: FileExplorerEntry[]): void {
    const next = new Map(snapshot.expanded as ExpandedMap);
    next.set(dirPath, { entries, status: "loaded" });
    publishExpanded(next);
  }

  function ensureRoot(root: string): void {
    if (!root) return;
    if (snapshot.root !== root) {
      publish({ root, activeDir: root });
    }
    if (!snapshot.expanded.has(root)) {
      void loadDir(root);
    }
  }

  async function runSearch(query: string): Promise<void> {
    searchAbort?.abort();
    if (!query.trim() || !snapshot.root) {
      publish({ searchQuery: query, searchResults: null, searching: false });
      return;
    }
    const abort = new AbortController();
    searchAbort = abort;
    publish({ searchQuery: query, searching: true });
    try {
      const result = await options.repository.search(query.trim(), snapshot.root, abort.signal);
      if (abort.signal.aborted) return;
      publish({
        searching: false,
        searchResults: result.ok && result.results ? result.results : [],
      });
    } catch (error) {
      if (abort.signal.aborted || isAbort(error)) return;
      publish({ searching: false, searchResults: [] });
    }
  }

  function joinPath(dir: string, name: string): string {
    const trimmedName = name.trim();
    if (!trimmedName) return dir;
    const base = dir.replace(/\/+$/, "");
    return `${base}/${trimmedName}`;
  }

  function refreshAffected(affectedPath: string): void {
    // Refresh the parent directory of the affected path, plus root if distinct.
    const parent = parentOf(affectedPath);
    const toRefresh = new Set<string>();
    if (parent && snapshot.expanded.has(parent)) toRefresh.add(parent);
    if (snapshot.root && snapshot.expanded.has(snapshot.root)) toRefresh.add(snapshot.root);
    // Also refresh the affected dir itself if it is expanded (e.g. after rename).
    if (snapshot.expanded.has(affectedPath)) toRefresh.add(affectedPath);
    for (const dir of toRefresh) void loadDir(dir);
  }

  async function execute(command: FileExplorerCommand): Promise<boolean> {
    switch (command.type) {
      case "setRoot": {
        ensureRoot(command.root);
        return true;
      }
      case "navigate": {
        if (!command.dir) return false;
        runtime.openDirectory?.(command.dir);
        return true;
      }
      case "toggle": {
        const expanded = new Map(snapshot.expanded as ExpandedMap);
        const existing = expanded.get(command.dir);
        if (existing) {
          expanded.delete(command.dir);
          publishExpanded(expanded);
          return true;
        }
        await loadDir(command.dir);
        return true;
      }
      case "expand": {
        await loadDir(command.dir);
        return true;
      }
      case "refresh": {
        const target = command.dir ?? snapshot.root;
        if (!target) return false;
        await loadDir(target);
        return true;
      }
      case "search.start": {
        await runSearch(command.query);
        return true;
      }
      case "search.clear": {
        searchAbort?.abort();
        publish({ searchQuery: "", searchResults: null, searching: false });
        return true;
      }
      case "create.file": {
        const target = joinPath(command.dir, command.name);
        publish({ busy: true });
        try {
          const result = await options.repository.createFile(target);
          if (result.ok) {
            runtime.notify("已创建文件", "success");
            refreshAffected(command.dir);
            runtime.openFile(target);
          } else {
            runtime.notify(failureMessage(result.failure, "创建文件失败"), "error");
          }
          return result.ok;
        } finally {
          publish({ busy: false });
        }
      }
      case "create.dir": {
        const target = joinPath(command.dir, command.name);
        publish({ busy: true });
        try {
          const result = await options.repository.createDir(target);
          if (result.ok) {
            runtime.notify("已创建文件夹", "success");
            refreshAffected(command.dir);
          } else {
            runtime.notify(failureMessage(result.failure, "创建文件夹失败"), "error");
          }
          return result.ok;
        } finally {
          publish({ busy: false });
        }
      }
      case "rename": {
        publish({ busy: true });
        try {
          const result = await options.repository.rename(command.from, command.to);
          if (result.ok) {
            runtime.notify("已重命名", "success");
            refreshAffected(parentOf(command.from));
          } else {
            runtime.notify(failureMessage(result.failure, "重命名失败"), "error");
          }
          return result.ok;
        } finally {
          publish({ busy: false });
        }
      }
      case "delete": {
        const isDir = snapshot.expanded.has(command.path)
          || (snapshot.activeDir === command.path);
        // Detect dir from cached entries if possible.
        const parentEntries = snapshot.expanded.get(parentOf(command.path))?.entries ?? [];
        const node = parentEntries.find((entry) => entry.path === command.path);
        const detectedIsDir = node?.type === "dir" || isDir;
        const confirmed = await runtime.confirmDelete(command.path, detectedIsDir);
        if (!confirmed) return false;
        publish({ busy: true });
        try {
          const result = await options.repository.delete(command.path);
          if (result.ok) {
            runtime.notify("已删除", "success");
            refreshAffected(parentOf(command.path));
          } else {
            runtime.notify(failureMessage(result.failure, "删除失败"), "error");
          }
          return result.ok;
        } finally {
          publish({ busy: false });
        }
      }
    }
  }

  const controller: WandFileExplorerController = {
    setRoot(root): void {
      ensureRoot(root);
    },
    execute,
  };

  return {
    controller,
    store: {
      subscribe(listener): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSnapshot(): FileExplorerSnapshot {
        return snapshot;
      },
    },
    configureRuntime(adapter): () => void {
      const previous = runtime;
      runtime = adapter;
      return () => {
        if (runtime === adapter) runtime = previous;
      };
    },
  };
}

const singleton = createFileExplorerModule({ repository: httpFileExplorerRepository });

export const fileExplorerController = singleton.controller;
export const fileExplorerStore = singleton.store;
export const configureFileExplorerRuntime = singleton.configureRuntime;
