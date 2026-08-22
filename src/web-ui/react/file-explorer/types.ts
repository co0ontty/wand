import type { FilePreviewFailure } from "../file-preview/types";

export type FileExplorerEntryType = "file" | "dir";

export interface FileExplorerEntry {
  path: string;
  name: string;
  type: FileExplorerEntryType;
  size?: number;
  mtime?: string;
  gitStatus?: {
    staged?: "added" | "modified" | "deleted" | "renamed";
    unstaged?: "modified" | "deleted";
    untracked?: boolean;
  };
}

export interface FileExplorerListResult {
  ok: boolean;
  entries?: FileExplorerEntry[];
  truncated?: boolean;
  total?: number;
  failure?: FilePreviewFailure;
}

export interface FileExplorerSearchResult {
  ok: boolean;
  results?: FileExplorerEntry[];
  failure?: FilePreviewFailure;
}

export interface FileExplorerMutationResult {
  ok: boolean;
  failure?: FilePreviewFailure;
  /** Path that should be refreshed/revealed after a successful mutation. */
  affectedPath?: string;
}

export interface FileExplorerRepository {
  list(dirPath: string, signal?: AbortSignal): Promise<FileExplorerListResult>;
  search(query: string, cwd: string, signal?: AbortSignal): Promise<FileExplorerSearchResult>;
  createFile(path: string): Promise<FileExplorerMutationResult>;
  createDir(path: string): Promise<FileExplorerMutationResult>;
  rename(from: string, to: string): Promise<FileExplorerMutationResult>;
  delete(path: string): Promise<FileExplorerMutationResult>;
}

export type FileExplorerNodeStatus = "idle" | "loading" | "loaded" | "error";

export interface FileExplorerNodeState {
  entries: FileExplorerEntry[];
  status: FileExplorerNodeStatus;
  error?: string;
}

export interface FileExplorerSnapshot {
  revision: number;
  root: string;
  /** Expanded directory paths -> their listing state. */
  expanded: ReadonlyMap<string, FileExplorerNodeState>;
  /** The currently active (revealed) directory path within the tree. */
  activeDir: string;
  searchQuery: string;
  searchResults: FileExplorerEntry[] | null;
  searching: boolean;
  busy: boolean;
}

export type FileExplorerCommand =
  | { type: "setRoot"; root: string }
  | { type: "navigate"; dir: string }
  | { type: "toggle"; dir: string }
  | { type: "expand"; dir: string }
  | { type: "refresh"; dir?: string }
  | { type: "search.start"; query: string }
  | { type: "search.clear" }
  | { type: "create.file"; dir: string; name: string }
  | { type: "create.dir"; dir: string; name: string }
  | { type: "rename"; from: string; to: string }
  | { type: "delete"; path: string };

export type FileExplorerNoticeTone = "success" | "error" | "info";

export interface FileExplorerRuntimeAdapter {
  /** Called when a file is clicked — opens it in the editor. */
  openFile(path: string): void;
  /** Called when a directory is double-clicked — sets it as the active root. */
  openDirectory?(dir: string): void;
  notify(message: string, tone: FileExplorerNoticeTone): void;
  copyText(text: string): Promise<boolean>;
  /** Append a path string to the legacy composer input. Returns true if supported. */
  appendToComposer?(text: string): boolean;
  /** Confirm a destructive action (delete). */
  confirmDelete(path: string, isDir: boolean): Promise<boolean>;
  /** Prompt for a new name/path; returns trimmed input or null to cancel. */
  promptForName(title: string, defaultValue: string, label?: string): Promise<string | null>;
}

export interface WandFileExplorerController {
  setRoot(root: string): void;
  execute(command: FileExplorerCommand): Promise<boolean>;
}
