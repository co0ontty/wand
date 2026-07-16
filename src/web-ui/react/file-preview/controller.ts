import { wandOverlay } from "../overlay-controller";
import {
  clampFilePreviewFontSize,
  defaultFilePreviewFontSize,
  nextFilePreviewSibling,
  normalizeFilePreviewRequest,
  shellQuoteFilePath,
} from "./model";
import { httpFilePreviewRepository } from "./repository";
import type {
  FilePreviewCommand,
  FilePreviewDiscardReason,
  FilePreviewFailure,
  FilePreviewOpenRequest,
  FilePreviewRepository,
  FilePreviewRuntimeAdapter,
  FilePreviewSnapshot,
  WandFilePreviewController,
} from "./types";

type Listener = () => void;

export interface FilePreviewModuleOptions {
  repository: FilePreviewRepository;
  runtime?: FilePreviewRuntimeAdapter;
}

export interface FilePreviewStore {
  subscribe(listener: Listener): () => void;
  getSnapshot(): FilePreviewSnapshot;
}

export interface FilePreviewModule {
  controller: WandFilePreviewController;
  store: FilePreviewStore;
  configureRuntime(adapter: FilePreviewRuntimeAdapter): () => void;
}

function initialSnapshot(revision = 0): FilePreviewSnapshot {
  return {
    open: false,
    revision,
    request: null,
    status: "idle",
    file: null,
    failure: null,
    editing: false,
    draft: "",
    baseline: "",
    dirty: false,
    saving: false,
    wrap: false,
    fontSize: defaultFilePreviewFontSize(),
    imageZoomed: false,
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

function defaultDiscardCopy(reason: FilePreviewDiscardReason): { title: string; message: string } {
  if (reason === "exit-edit") {
    return {
      title: "放弃未保存的修改？",
      message: "当前文件有未保存的改动，退出编辑后会丢失。",
    };
  }
  if (reason === "replace") {
    return {
      title: "切换预览文件？",
      message: "当前文件有未保存的改动，切换后会丢失。",
    };
  }
  return {
    title: "放弃未保存的修改？",
    message: "当前文件有未保存的改动，关闭后会丢失。",
  };
}

const defaultRuntime: FilePreviewRuntimeAdapter = {
  async confirmDiscard(reason): Promise<boolean> {
    const copy = defaultDiscardCopy(reason);
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
    return result.dismissed === false && result.action === true;
  },

  async copyText(text): Promise<void> {
    if (!globalThis.navigator?.clipboard?.writeText) throw new Error("当前环境无法访问剪贴板。");
    await globalThis.navigator.clipboard.writeText(text);
  },

  appendToComposer(): boolean {
    return false;
  },

  notify(message, tone): void {
    wandOverlay.toast(message, { tone });
  },

  onSaved(): void {},
};

export function createFilePreviewModule(options: FilePreviewModuleOptions): FilePreviewModule {
  const listeners = new Set<Listener>();
  let snapshot = initialSnapshot();
  let runtime = options.runtime ?? defaultRuntime;
  let loadSequence = 0;
  let activeAbort: AbortController | null = null;

  function publish(patch: Partial<FilePreviewSnapshot>): void {
    snapshot = { ...snapshot, ...patch, revision: snapshot.revision + 1 };
    for (const listener of listeners) listener();
  }

  function closeNow(): void {
    activeAbort?.abort();
    activeAbort = null;
    loadSequence += 1;
    snapshot = initialSnapshot(snapshot.revision + 1);
    for (const listener of listeners) listener();
  }

  async function confirmDiscard(reason: FilePreviewDiscardReason): Promise<boolean> {
    if (!snapshot.dirty || !snapshot.request) return true;
    try {
      return await runtime.confirmDiscard(reason, snapshot.request.path);
    } catch (error) {
      runtime.notify(unknownFailure(error, "无法确认是否放弃修改。").message, "error");
      return false;
    }
  }

  async function load(request: FilePreviewOpenRequest): Promise<boolean> {
    activeAbort?.abort();
    const abort = new AbortController();
    activeAbort = abort;
    const sequence = ++loadSequence;
    publish({
      open: true,
      request,
      status: "loading",
      file: null,
      failure: null,
      editing: false,
      draft: "",
      baseline: "",
      dirty: false,
      saving: false,
      wrap: false,
      fontSize: defaultFilePreviewFontSize(),
      imageZoomed: false,
    });

    try {
      const outcome = await options.repository.load(request.path, { signal: abort.signal });
      if (sequence !== loadSequence || abort.signal.aborted || !snapshot.open) return false;
      activeAbort = null;
      if (outcome.ok === false) {
        publish({ status: "error", failure: outcome.failure });
        return false;
      }
      const baseline = outcome.file.kind === "text" ? outcome.file.content ?? "" : "";
      publish({
        status: "ready",
        file: outcome.file,
        failure: null,
        draft: baseline,
        baseline,
      });
      return true;
    } catch (error) {
      if (sequence !== loadSequence || abort.signal.aborted || isAbort(error) || !snapshot.open) return false;
      activeAbort = null;
      publish({ status: "error", failure: unknownFailure(error, "加载预览失败") });
      return false;
    }
  }

  async function copy(text: string, successMessage: string): Promise<boolean> {
    try {
      await runtime.copyText(text);
      runtime.notify(successMessage, "success");
      return true;
    } catch (error) {
      runtime.notify(unknownFailure(error, "复制失败。").message, "error");
      return false;
    }
  }

  async function execute(command: FilePreviewCommand): Promise<boolean> {
    if (!snapshot.open) return false;
    switch (command.type) {
      case "close": {
        if (snapshot.saving) return false;
        // Keep the clean path synchronous. Competing business overlays can
        // replace a clean preview in one React commit without briefly stacking
        // two modal surfaces while an already-resolved Promise is awaited.
        if (!snapshot.dirty) {
          closeNow();
          return true;
        }
        if (!await confirmDiscard("close")) return false;
        closeNow();
        return true;
      }
      case "navigate": {
        if (snapshot.editing || snapshot.saving) return false;
        const sibling = nextFilePreviewSibling(snapshot.request, command.direction);
        if (!sibling || !snapshot.request) return false;
        return load({ ...snapshot.request, path: sibling.path });
      }
      case "edit.enter": {
        if (snapshot.status !== "ready" || snapshot.file?.kind !== "text" || snapshot.saving) return false;
        const baseline = snapshot.file.content ?? "";
        publish({ editing: true, draft: baseline, baseline, dirty: false, failure: null });
        return true;
      }
      case "edit.change": {
        if (!snapshot.editing || snapshot.saving) return false;
        publish({ draft: command.value, dirty: command.value !== snapshot.baseline, failure: null });
        return true;
      }
      case "edit.revert": {
        if (!snapshot.editing || snapshot.saving) return false;
        publish({ draft: snapshot.baseline, dirty: false, failure: null });
        return true;
      }
      case "edit.exit": {
        if (!snapshot.editing || snapshot.saving) return false;
        if (!await confirmDiscard("exit-edit")) return false;
        publish({ editing: false, draft: snapshot.baseline, dirty: false, failure: null });
        return true;
      }
      case "edit.save": {
        if (!snapshot.editing || snapshot.saving || snapshot.file?.kind !== "text" || !snapshot.request) return false;
        if (snapshot.draft === snapshot.baseline) {
          runtime.notify("没有改动", "info");
          return true;
        }
        const path = snapshot.request.path;
        const draft = snapshot.draft;
        publish({ saving: true, failure: null });
        try {
          const outcome = await options.repository.save(path, draft);
          if (!snapshot.open || snapshot.request?.path !== path) return false;
          if (outcome.ok === false) {
            publish({ saving: false, failure: outcome.failure });
            runtime.notify(outcome.failure.message, "error");
            return false;
          }
          const currentFile = snapshot.file;
          publish({
            saving: false,
            file: currentFile ? { ...currentFile, content: draft, size: outcome.result.size } : currentFile,
            baseline: draft,
            draft,
            dirty: false,
            failure: null,
          });
          runtime.notify("已保存", "success");
          try { await runtime.onSaved(path); } catch { /* Refresh is best-effort. */ }
          return true;
        } catch (error) {
          if (!snapshot.open || snapshot.request?.path !== path) return false;
          const failure = unknownFailure(error, "保存失败：网络错误");
          publish({ saving: false, failure });
          runtime.notify(failure.message, "error");
          return false;
        }
      }
      case "copy.path":
        return snapshot.file ? copy(snapshot.file.path, "已复制路径") : false;
      case "copy.content":
        return snapshot.file?.kind === "text" ? copy(snapshot.file.content ?? "", "已复制内容") : false;
      case "composer.path": {
        if (!snapshot.file) return false;
        const appended = runtime.appendToComposer(snapshot.file.path);
        runtime.notify(appended ? "已粘贴到输入框" : "无法粘贴到输入框", appended ? "success" : "error");
        return appended;
      }
      case "composer.cat": {
        if (!snapshot.file) return false;
        const appended = runtime.appendToComposer(`cat -- ${shellQuoteFilePath(snapshot.file.path)}`);
        runtime.notify(appended ? "命令已粘贴到输入框" : "无法粘贴到输入框", appended ? "success" : "error");
        return appended;
      }
      case "view.wrap.toggle":
        if (snapshot.file?.kind !== "text" || snapshot.editing) return false;
        publish({ wrap: !snapshot.wrap });
        return true;
      case "view.font.adjust":
        if (snapshot.file?.kind !== "text" || snapshot.editing) return false;
        publish({ fontSize: clampFilePreviewFontSize(snapshot.fontSize + command.delta) });
        return true;
      case "view.image.zoom.toggle":
        if (snapshot.file?.kind !== "image" || snapshot.editing) return false;
        publish({ imageZoomed: !snapshot.imageZoomed });
        return true;
    }
  }

  const controller: WandFilePreviewController = {
    async open(input): Promise<boolean> {
      const request = normalizeFilePreviewRequest(input);
      if (!request) return false;
      if (snapshot.open && snapshot.request?.path === request.path && !snapshot.dirty) {
        publish({ request });
        return true;
      }
      if (snapshot.open && snapshot.dirty && !await confirmDiscard("replace")) return false;
      return load(request);
    },

    execute,

    closeIfOpen(): boolean {
      if (!snapshot.open) return false;
      void execute({ type: "close" });
      return true;
    },

    closeTopmost(): boolean {
      return this.closeIfOpen();
    },

    isOpen(): boolean {
      return snapshot.open;
    },
  };

  return {
    controller,
    store: {
      subscribe(listener): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSnapshot(): FilePreviewSnapshot {
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

const singleton = createFilePreviewModule({ repository: httpFilePreviewRepository });

export const filePreviewController = singleton.controller;
export const filePreviewStore = singleton.store;
export const configureFilePreviewRuntime = singleton.configureRuntime;

declare global {
  interface Window {
    __wandReactFilePreview?: WandFilePreviewController;
  }
}
