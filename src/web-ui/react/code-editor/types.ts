import type { FilePreviewFailure } from "../file-preview/types";

/** A single open file in the editor. */
export interface CodeEditorFile {
  path: string;
  name: string;
  ext: string;
  lang?: string;
  size: number;
  mime?: string;
  /** Latest saved content (baseline for dirty tracking). Empty for non-text files. */
  baseline: string;
  /** Current in-memory draft. */
  draft: string;
  /** True when draft differs from baseline. */
  dirty: boolean;
}

type CodeEditorStatus = "idle" | "loading" | "ready" | "error" | "unsupported";

export interface CodeEditorTab {
  path: string;
  name: string;
  dirty: boolean;
}

export interface CodeEditorSnapshot {
  /** True when the editor panel should overlay the main content area. */
  open: boolean;
  revision: number;
  activePath: string | null;
  tabs: readonly CodeEditorTab[];
  /** Full file object for the active tab (content, metadata). */
  file: CodeEditorFile | null;
  status: CodeEditorStatus;
  failure: FilePreviewFailure | null;
  saving: boolean;
  fontSize: number;
  wrap: boolean;
}

export interface CodeEditorLoadResult {
  ok: boolean;
  file?: CodeEditorFile;
  failure?: FilePreviewFailure;
}

interface CodeEditorSaveResult {
  path: string;
  size: number;
  mtime?: string;
}

export type CodeEditorSaveOutcome =
  | { ok: true; result: CodeEditorSaveResult }
  | { ok: false; failure: FilePreviewFailure };

export interface CodeEditorLoadOptions {
  signal?: AbortSignal;
}

/** Remote-owned seam: HTTP load/save adapter. */
export interface CodeEditorRepository {
  load(path: string, options?: CodeEditorLoadOptions): Promise<CodeEditorLoadResult>;
  save(path: string, content: string): Promise<CodeEditorSaveOutcome>;
}

export type CodeEditorCommand =
  | { type: "close"; path?: string }
  | { type: "activate"; path: string }
  | { type: "change"; value: string }
  | { type: "revert" }
  | { type: "save" }
  | { type: "wrap.toggle" }
  | { type: "font.adjust"; delta: number };

export type CodeEditorDiscardReason = "close" | "switch" | "replace";

export interface CodeEditorRuntimeAdapter {
  confirmDiscard(reason: CodeEditorDiscardReason, path: string): Promise<boolean>;
  notify(message: string, tone: "success" | "error" | "info" | "warning"): void;
  /** Called after a successful save so the file explorer can refresh. */
  onSaved?(path: string): void | Promise<void>;
}

export interface WandCodeEditorController {
  open(path: string): Promise<boolean>;
  execute(command: CodeEditorCommand): Promise<boolean>;
  closeAll(): void;
  isActive(): boolean;
  hasDirty(): boolean;
}
