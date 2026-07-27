export type FilePreviewKind = "text" | "image" | "pdf" | "video" | "audio" | "binary";

export interface FilePreviewSibling {
  path: string;
  name?: string;
  type?: "file" | "dir";
}

export interface FilePreviewDownload {
  path: string;
  name: string;
  url: string;
  size?: number;
}

export interface FilePreviewFile extends FilePreviewDownload {
  kind: FilePreviewKind;
  ext: string;
  mime?: string;
  lang?: string;
  content?: string;
  rawUrl: string;
}

export interface FilePreviewFailure {
  message: string;
  status?: number;
  size?: number;
  maxSize?: number;
  download?: FilePreviewDownload;
}

export type FilePreviewLoadResult =
  | { ok: true; file: FilePreviewFile }
  | { ok: false; failure: FilePreviewFailure };

export interface FilePreviewSaveResult {
  path: string;
  size: number;
  mtime?: string;
}

export type FilePreviewSaveOutcome =
  | { ok: true; result: FilePreviewSaveResult }
  | { ok: false; failure: FilePreviewFailure };

export interface FilePreviewLoadOptions {
  signal?: AbortSignal;
}

/** Remote-owned seam: production HTTP and deterministic memory adapters share this Interface. */
export interface FilePreviewRepository {
  load(path: string, options?: FilePreviewLoadOptions): Promise<FilePreviewLoadResult>;
  save(path: string, content: string): Promise<FilePreviewSaveOutcome>;
}

export interface FilePreviewOpenRequest {
  path: string;
  siblings?: ReadonlyArray<FilePreviewSibling>;
}

export type FilePreviewDiscardReason = "close" | "exit-edit" | "replace";
export type FilePreviewNoticeTone = "success" | "error" | "info" | "warning";

export interface FilePreviewRuntimeAdapter {
  confirmDiscard(reason: FilePreviewDiscardReason, path: string): Promise<boolean>;
  copyText(text: string): Promise<void>;
  appendToComposer(text: string): boolean;
  notify(message: string, tone: FilePreviewNoticeTone): void;
  onSaved(path: string): void | Promise<void>;
}

export type FilePreviewStatus = "idle" | "loading" | "ready" | "error";

export interface FilePreviewSnapshot {
  open: boolean;
  revision: number;
  request: FilePreviewOpenRequest | null;
  status: FilePreviewStatus;
  file: FilePreviewFile | null;
  failure: FilePreviewFailure | null;
  editing: boolean;
  draft: string;
  baseline: string;
  dirty: boolean;
  saving: boolean;
  wrap: boolean;
  fontSize: number;
  imageZoomed: boolean;
}

export type FilePreviewCommand =
  | { type: "close" }
  | { type: "navigate"; direction: -1 | 1 }
  | { type: "edit.enter" }
  | { type: "edit.change"; value: string }
  | { type: "edit.revert" }
  | { type: "edit.exit" }
  | { type: "edit.save" }
  | { type: "copy.path" }
  | { type: "copy.content" }
  | { type: "composer.path" }
  | { type: "composer.cat" }
  | { type: "view.wrap.toggle" }
  | { type: "view.font.adjust"; delta: number }
  | { type: "view.image.zoom.toggle" };

export interface WandFilePreviewController {
  open(request: FilePreviewOpenRequest | string): Promise<boolean>;
  execute(command: FilePreviewCommand): Promise<boolean>;
  closeIfOpen(): boolean;
  closeTopmost(): boolean;
  isOpen(): boolean;
}
