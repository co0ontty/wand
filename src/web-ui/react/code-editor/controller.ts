import { wandOverlay } from "../overlay-controller";
import {
  clampCodeEditorFontSize,
  defaultCodeEditorFontSize,
} from "./model";
import { httpCodeEditorRepository } from "./repository";
import type {
  CodeEditorCommand,
  CodeEditorDiscardReason,
  CodeEditorFile,
  CodeEditorLoadResult,
  CodeEditorRepository,
  CodeEditorRuntimeAdapter,
  CodeEditorSnapshot,
  CodeEditorTab,
  WandCodeEditorController,
} from "./types";
import type { FilePreviewFailure } from "../file-preview/types";

type Listener = () => void;

export interface CodeEditorModuleOptions {
  repository: CodeEditorRepository;
  runtime?: CodeEditorRuntimeAdapter;
}

interface CodeEditorStore {
  subscribe(listener: Listener): () => void;
  getSnapshot(): CodeEditorSnapshot;
}

export interface CodeEditorModule {
  controller: WandCodeEditorController;
  store: CodeEditorStore;
  configureRuntime(adapter: CodeEditorRuntimeAdapter): () => void;
}

function initialSnapshot(revision = 0): CodeEditorSnapshot {
  return {
    open: false,
    revision,
    activePath: null,
    tabs: [],
    file: null,
    status: "idle",
    failure: null,
    saving: false,
    fontSize: defaultCodeEditorFontSize(),
    wrap: false,
  };
}

function unknownFailure(error: unknown, fallback: string): FilePreviewFailure {
  return {
    message: error instanceof Error && error.message ? error.message : fallback,
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function discardCopy(reason: CodeEditorDiscardReason): { title: string; message: string } {
  if (reason === "switch") {
    return {
      title: "切换文件？",
      message: "当前文件有未保存的改动，切换后会丢失。",
    };
  }
  if (reason === "replace") {
    return {
      title: "关闭编辑器？",
      message: "当前文件有未保存的改动，关闭后会丢失。",
    };
  }
  return {
    title: "关闭文件？",
    message: "当前文件有未保存的改动，关闭后会丢失。",
  };
}

const defaultRuntime: CodeEditorRuntimeAdapter = {
  async confirmDiscard(reason, path): Promise<boolean> {
    const copy = discardCopy(reason);
    const result = await wandOverlay.dialog({
      title: copy.title,
      description: copy.message,
      tone: "warning",
      actions: [
        { label: "继续编辑", value: false, kind: "secondary", autoFocus: true },
        { label: "放弃修改", value: true, kind: "danger" },
      ],
      dismissable: true,
    });
    void path;
    return result.dismissed === false && result.action === true;
  },

  notify(message, tone): void {
    wandOverlay.toast(message, { tone });
  },

  onSaved(): void {},
};

export function createCodeEditorModule(options: CodeEditorModuleOptions): CodeEditorModule {
  const listeners = new Set<Listener>();
  let snapshot = initialSnapshot();
  let runtime = options.runtime ?? defaultRuntime;
  let loadSequence = 0;
  let activeAbort: AbortController | null = null;

  /** Files cache keyed by path so switching tabs is instant. */
  const files = new Map<string, CodeEditorFile>();

  function publish(patch: Partial<CodeEditorSnapshot>): void {
    snapshot = { ...snapshot, ...patch, revision: snapshot.revision + 1 };
    for (const listener of listeners) listener();
  }

  function tabsFromFiles(activePath: string | null): CodeEditorTab[] {
    const tabs: CodeEditorTab[] = [];
    for (const file of files.values()) {
      tabs.push({ path: file.path, name: file.name, dirty: file.dirty });
    }
    // Map 保留插入顺序，与 VS Code 一样按用户打开顺序排列标签。
    void activePath;
    return tabs;
  }

  function syncSnapshot(fileOverride?: CodeEditorFile | null): void {
    publish({
      tabs: tabsFromFiles(snapshot.activePath),
      file: fileOverride !== undefined ? fileOverride : (snapshot.activePath ? files.get(snapshot.activePath) ?? null : null),
    });
  }

  async function confirmDiscard(reason: CodeEditorDiscardReason): Promise<boolean> {
    const active = snapshot.activePath ? files.get(snapshot.activePath) : null;
    if (!active || !active.dirty) return true;
    try {
      return await runtime.confirmDiscard(reason, active.path);
    } catch (error) {
      runtime.notify(unknownFailure(error, "无法确认是否放弃修改。").message, "error");
      return false;
    }
  }

  async function load(path: string): Promise<boolean> {
    activeAbort?.abort();
    const abort = new AbortController();
    activeAbort = abort;
    const sequence = ++loadSequence;
    publish({
      open: true,
      activePath: path,
      status: "loading",
      file: null,
      failure: null,
    });

    try {
      const outcome: CodeEditorLoadResult = await options.repository.load(path, { signal: abort.signal });
      if (sequence !== loadSequence || abort.signal.aborted || !snapshot.open) return false;
      activeAbort = null;
      if (outcome.ok === false || !outcome.file) {
        publish({ status: "error", failure: outcome.failure ?? { message: "打开文件失败" } });
        return false;
      }
      files.set(path, outcome.file);
      publish({
        status: "ready",
        file: outcome.file,
        failure: null,
        tabs: tabsFromFiles(path),
      });
      return true;
    } catch (error) {
      if (sequence !== loadSequence || abort.signal.aborted || isAbort(error) || !snapshot.open) return false;
      activeAbort = null;
      publish({ status: "error", failure: unknownFailure(error, "打开文件失败") });
      return false;
    }
  }

  async function execute(command: CodeEditorCommand): Promise<boolean> {
    switch (command.type) {
      case "close": {
        if (snapshot.saving) return false;
        const targetPath = command.path ?? snapshot.activePath;
        if (!targetPath) return true;
        const target = files.get(targetPath);
        if (target?.dirty) {
          const wasActive = snapshot.activePath === targetPath;
          if (wasActive && !await confirmDiscard("close")) return false;
        }
        files.delete(targetPath);
        const remaining = tabsFromFiles(null).filter((tab) => tab.path !== targetPath);
        if (remaining.length === 0) {
          publish(initialSnapshot(snapshot.revision + 1));
          return true;
        }
        const nextActive = snapshot.activePath === targetPath ? remaining[0].path : snapshot.activePath;
        publish({
          activePath: nextActive,
          file: nextActive ? files.get(nextActive) ?? null : null,
          tabs: remaining,
          status: nextActive ? "ready" : "idle",
        });
        return true;
      }
      case "activate": {
        if (snapshot.saving) return false;
        if (snapshot.activePath === command.path) return true;
        const next = files.get(command.path) ?? null;
        publish({
          activePath: command.path,
          file: next,
          status: next ? "ready" : "loading",
          failure: null,
        });
        if (!next) {
          return load(command.path);
        }
        return true;
      }
      case "change": {
        if (!snapshot.activePath || snapshot.saving) return false;
        const active = files.get(snapshot.activePath);
        if (!active) return false;
        const updated: CodeEditorFile = { ...active, draft: command.value, dirty: command.value !== active.baseline };
        files.set(active.path, updated);
        syncSnapshot(updated);
        return true;
      }
      case "revert": {
        if (!snapshot.activePath) return false;
        const active = files.get(snapshot.activePath);
        if (!active) return false;
        const reverted: CodeEditorFile = { ...active, draft: active.baseline, dirty: false };
        files.set(active.path, reverted);
        syncSnapshot(reverted);
        return true;
      }
      case "save": {
        if (!snapshot.activePath || snapshot.saving) return false;
        const active = files.get(snapshot.activePath);
        if (!active) return false;
        if (!active.dirty) {
          runtime.notify("没有改动", "info");
          return true;
        }
        publish({ saving: true, failure: null });
        try {
          const outcome = await options.repository.save(active.path, active.draft);
          const current = files.get(active.path) ?? null;
          if (!current) return false;
          if (outcome.ok === false) {
            publish({ saving: false, failure: outcome.failure });
            runtime.notify(outcome.failure.message, "error");
            return false;
          }
          const saved: CodeEditorFile = {
            ...current,
            // 只把这次真正写入磁盘的内容设为 baseline；即使未来允许保存中继续
            // 编辑，也不会把尚未落盘的新 draft 误标成已保存。
            baseline: active.draft,
            draft: current.draft,
            dirty: current.draft !== active.draft,
            size: outcome.result.size,
          };
          files.set(active.path, saved);
          const activeFile = snapshot.activePath ? files.get(snapshot.activePath) ?? null : null;
          publish({ saving: false, file: activeFile, failure: null, tabs: tabsFromFiles(snapshot.activePath) });
          runtime.notify("已保存", "success");
          try { await runtime.onSaved?.(active.path); } catch { /* best-effort refresh */ }
          return true;
        } catch (error) {
          publish({ saving: false, failure: unknownFailure(error, "保存失败：网络错误") });
          runtime.notify(unknownFailure(error, "保存失败：网络错误").message, "error");
          return false;
        }
      }
      case "wrap.toggle":
        publish({ wrap: !snapshot.wrap });
        return true;
      case "font.adjust":
        publish({ fontSize: clampCodeEditorFontSize(snapshot.fontSize + command.delta) });
        return true;
    }
  }

  const controller: WandCodeEditorController = {
    async open(path): Promise<boolean> {
      const trimmed = path.trim();
      if (!trimmed || snapshot.saving) return false;
      // If already open, just activate.
      if (files.has(trimmed)) {
        if (snapshot.activePath === trimmed) {
          publish({ open: true });
          return true;
        }
        return execute({ type: "activate", path: trimmed });
      }
      // 未保存内容留在原标签中；切换/打开新文件不应像关闭那样要求丢弃。
      return load(trimmed);
    },

    execute,

    closeAll(): void {
      files.clear();
      activeAbort?.abort();
      activeAbort = null;
      publish(initialSnapshot(snapshot.revision + 1));
    },

    isActive(): boolean {
      return snapshot.open && snapshot.activePath !== null;
    },

    hasDirty(): boolean {
      for (const file of files.values()) {
        if (file.dirty) return true;
      }
      return false;
    },
  };

  return {
    controller,
    store: {
      subscribe(listener): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSnapshot(): CodeEditorSnapshot {
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

const singleton = createCodeEditorModule({ repository: httpCodeEditorRepository });

export const codeEditorController = singleton.controller;
export const codeEditorStore = singleton.store;
const configureCodeEditorRuntime = singleton.configureRuntime;
