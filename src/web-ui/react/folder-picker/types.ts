export type FolderPickerItemType = "parent" | "dir";

export interface FolderPickerItem {
  path: string;
  name: string;
  type: FolderPickerItemType;
}

export interface FolderPickerListing {
  currentPath: string;
  items: ReadonlyArray<FolderPickerItem>;
}

export interface FolderPickerRepositoryOptions {
  signal?: AbortSignal;
}

/** Remote folder discovery seam. HTTP and memory adapters share this interface. */
export interface FolderPickerRepository {
  list(
    path: string,
    options?: FolderPickerRepositoryOptions,
  ): Promise<FolderPickerListing>;
}

/** Narrow adapter used by the React overlay to update the legacy shell runtime. */
export interface FolderPickerRuntimeAdapter {
  getInitialPath(): string;
  applySelection(path: string): void | Promise<void>;
  onOpen?(): void;
  onClose?(): void;
}
