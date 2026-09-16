import {
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import * as React from "react";
import { WandButton, WandDialogSurface } from "../ui";
import { httpFolderPickerRepository } from "../folder-picker/repository";
import { nextFolderPickerIndex, type FolderPickerNavigationKey } from "../folder-picker/model";
import type {
  FolderPickerItem,
  FolderPickerListing,
  FolderPickerRepository,
} from "../folder-picker/types";
import { explorerBaseName, joinExplorerPath } from "./paths";
import { failureMessage } from "../errors";

export interface MoveEntryRequest {
  /** Absolute path being moved. */
  from: string;
  /** Directory the entry currently lives in; used as the initial location. */
  initialDir: string;
  /** Whether the moved entry is a directory (affects the copy only). */
  isDir: boolean;
}

export interface MoveEntryDialogProps {
  request: MoveEntryRequest | null;
  /** Resolves true when the move was applied; keeps the dialog open otherwise. */
  onSubmit(from: string, to: string): Promise<boolean>;
  onDismiss(): void;
  repository?: FolderPickerRepository;
}

const NAVIGATION_KEYS = new Set<FolderPickerNavigationKey>(["ArrowDown", "ArrowUp", "Home", "End"]);

/**
 * "移动到…" dialog for the file explorer. Browses directories through the
 * shared folder repository and hands the resolved destination back to the
 * caller — unlike the working-directory picker it never mutates the cwd.
 */
export function MoveEntryDialog({
  request,
  onSubmit,
  onDismiss,
  repository = httpFolderPickerRepository,
}: MoveEntryDialogProps) {
  const open = request !== null;
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<FolderPickerListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!request) return;
    setPath(request.initialDir);
    setListing(null);
    setLoading(false);
    setMoving(false);
    setError("");
    setActiveIndex(-1);
  }, [request]);

  useEffect(() => {
    if (!open) return;
    const requestedPath = path.trim();
    if (!requestedPath) {
      setListing(null);
      setLoading(false);
      setError("请输入目标目录。");
      setActiveIndex(-1);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    setError("");
    setActiveIndex(-1);
    // Debounced listing so typing a path never floods the API.
    const timer = window.setTimeout(() => {
      void repository.list(requestedPath, { signal: abort.signal })
        .then((result) => {
          if (abort.signal.aborted) return;
          setListing(result);
          setError("");
        })
        .catch((loadError) => {
          if (abort.signal.aborted) return;
          setListing(null);
          setError(failureMessage(loadError, "无法读取该目录。"));
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    }, 140);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [open, path, repository]);

  useEffect(() => {
    if (activeIndex < 0) return;
    itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!request) return null;

  const targetDir = listing?.currentPath ?? path.trim();

  function navigate(pathToOpen: string): void {
    setPath(pathToOpen);
    setListing(null);
    setError("");
    setActiveIndex(-1);
  }

  async function commit(dirPath: string): Promise<void> {
    if (!request || moving) return;
    const destination = joinExplorerPath(dirPath, explorerBaseName(request.from));
    if (destination === request.from) {
      setError("目标位置与当前位置相同。");
      return;
    }
    setMoving(true);
    setError("");
    try {
      const applied = await onSubmit(request.from, destination);
      if (!applied) setError("移动失败，请检查目标目录后重试。");
    } catch (submitError) {
      setError(failureMessage(submitError, "无法读取该目录。"));
    } finally {
      setMoving(false);
    }
  }

  // Clicking an entry browses into it (or walks up via the ".." row) — the move
  // only happens when the user confirms with 「移动到此处」or presses Enter.
  // Committing straight from the list made a single misclick relocate the file.
  function activateItem(item: FolderPickerItem): void {
    navigate(item.path);
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (NAVIGATION_KEYS.has(event.key as FolderPickerNavigationKey)) {
      event.preventDefault();
      setActiveIndex((current) => nextFolderPickerIndex(
        current,
        listing?.items.length ?? 0,
        event.key as FolderPickerNavigationKey,
      ));
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (activeIndex >= 0) {
      const activeItem = listing?.items[activeIndex];
      if (activeItem) activateItem(activeItem);
      return;
    }
    void commit(targetDir);
  }

  const parent = listing?.items.find((item) => item.type === "parent") ?? null;
  const entryName = explorerBaseName(request.from);

  return (
    <WandDialogSurface
      open={open}
      onOpenChange={(nextOpen) => { if (!nextOpen) onDismiss(); }}
      title={`移动${request.isDir ? "文件夹" : "文件"}`}
      description={`为「${entryName}」选择目标目录，确认后立即移动。`}
      className="wand-folder-picker-dialog wand-move-dialog"
      overlayClassName="wand-folder-picker-overlay"
      titleClassName="wand-folder-picker-title"
      descriptionClassName="wand-folder-picker-description"
      headerClassName="wand-folder-picker-header"
      closeLabel="关闭移动对话框"
      testId="move-entry-dialog"
      dismissable={!moving}
    >
      <form noValidate
        className="wand-folder-picker-form"
        aria-busy={loading || moving}
        onSubmit={(event) => { event.preventDefault(); void commit(targetDir); }}
      >
        <div className="wand-folder-picker-quick" aria-label="快捷目录">
          <WandButton size="small" onClick={() => navigate("/tmp")}>临时目录 /tmp</WandButton>
          <WandButton size="small" onClick={() => navigate("/")}>根目录 /</WandButton>
          <WandButton
            size="small"
            disabled={!parent || loading}
            onClick={() => { if (parent) navigate(parent.path); }}
          >
            返回上级
          </WandButton>
        </div>

        <label className="wand-folder-picker-field" htmlFor="wand-move-input">
          <span>目标目录</span>
          <input
            id="wand-move-input"
            className="wand-folder-picker-input"
            data-wand-autofocus
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-invalid={error ? "true" : "false"}
            aria-controls="wand-move-options"
            aria-activedescendant={activeIndex >= 0 ? `wand-move-option-${activeIndex}` : undefined}
            value={path}
            onChange={(event) => setPath(event.currentTarget.value)}
            onKeyDown={handleInputKeyDown}
          />
        </label>

        <div id="wand-move-options" className="wand-folder-picker-options" role="listbox" aria-label="目录建议">
          {loading ? (
            <div className="wand-folder-picker-state" role="status">正在加载目录…</div>
          ) : listing && listing.items.length > 0 ? (
            listing.items.map((item, index) => (
              <button
                key={`${item.type}:${item.path}`}
                ref={(element) => { itemRefs.current[index] = element; }}
                id={`wand-move-option-${index}`}
                type="button"
                role="option"
                aria-selected={activeIndex === index}
                className={`wand-folder-picker-option${activeIndex === index ? " active" : ""}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => activateItem(item)}
              >
                <span aria-hidden="true">{item.type === "parent" ? "↩" : "▸"}</span>
                <span>{item.type === "parent" ? "..（返回上级目录）" : item.name}</span>
                <code>{item.path}</code>
              </button>
            ))
          ) : error ? null : (
            <div className="wand-folder-picker-state">当前目录没有子目录。</div>
          )}
        </div>

        {error ? <p className="wand-folder-picker-error" role="alert">{error}</p> : null}

        <div className="wand-folder-picker-footer">
          <span>{targetDir || "请输入目标目录"}</span>
          <WandButton kind="primary" type="submit" disabled={loading || moving || !targetDir}>
            {moving ? "正在移动…" : "移动到此处"}
          </WandButton>
        </div>
      </form>
    </WandDialogSurface>
  );
}
