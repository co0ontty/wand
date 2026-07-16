import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { WandButton, WandDialogSurface } from "../ui";
import { folderPickerController, folderPickerStore } from "./controller";
import { nextFolderPickerIndex, type FolderPickerNavigationKey } from "./model";
import { httpFolderPickerRepository } from "./repository";
import type { FolderPickerItem, FolderPickerListing, FolderPickerRepository } from "./types";

export interface FolderPickerHostProps {
  repository?: FolderPickerRepository;
}

const NAVIGATION_KEYS = new Set<FolderPickerNavigationKey>([
  "ArrowDown",
  "ArrowUp",
  "Home",
  "End",
]);

function presentError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "无法读取该目录。";
}

export function FolderPickerHost({ repository = httpFolderPickerRepository }: FolderPickerHostProps) {
  const controller = useSyncExternalStore(
    folderPickerStore.subscribe,
    folderPickerStore.getSnapshot,
    folderPickerStore.getSnapshot,
  );
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<FolderPickerListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!controller.open) return;
    setPath(controller.initialPath);
    setListing(null);
    setLoading(false);
    setChoosing(false);
    setError("");
    setActiveIndex(-1);
  }, [controller.open, controller.revision, controller.initialPath]);

  useEffect(() => {
    if (!controller.open) return;
    const requestedPath = path.trim();
    if (!requestedPath) {
      setListing(null);
      setLoading(false);
      setError("请输入工作目录。");
      setActiveIndex(-1);
      return;
    }

    const abort = new AbortController();
    setLoading(true);
    setError("");
    setActiveIndex(-1);
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
          setError(presentError(loadError));
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [controller.open, path, repository]);

  useEffect(() => {
    if (activeIndex < 0) return;
    itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  function navigate(pathToOpen: string): void {
    setPath(pathToOpen);
    setListing(null);
    setError("");
    setActiveIndex(-1);
  }

  async function choose(pathToChoose: string): Promise<void> {
    if (choosing) return;
    folderPickerController.setDismissable(false);
    setChoosing(true);
    setError("");
    try {
      const applied = await folderPickerController.choose(pathToChoose);
      if (!applied) setError("无法应用工作目录，请刷新页面后重试。");
    } catch (selectionError) {
      setError(presentError(selectionError));
    } finally {
      folderPickerController.setDismissable(true);
      setChoosing(false);
    }
  }

  function activateItem(item: FolderPickerItem): void {
    if (item.type === "parent") {
      navigate(item.path);
      return;
    }
    void choose(item.path);
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const requestedPath = path.trim();
    if (!requestedPath || choosing) {
      if (!requestedPath) setError("请输入工作目录。");
      return;
    }
    folderPickerController.setDismissable(false);
    setChoosing(true);
    setError("");
    try {
      const validated = await repository.list(requestedPath);
      const applied = await folderPickerController.choose(validated.currentPath);
      if (!applied) setError("无法应用工作目录，请刷新页面后重试。");
    } catch (selectionError) {
      setError(presentError(selectionError));
    } finally {
      folderPickerController.setDismissable(true);
      setChoosing(false);
    }
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
    if (event.key !== "Enter" || activeIndex < 0) return;
    const activeItem = listing?.items[activeIndex];
    if (!activeItem) return;
    event.preventDefault();
    activateItem(activeItem);
  }

  const parent = listing?.items.find((item) => item.type === "parent") ?? null;

  return (
    <WandDialogSurface
      open={controller.open}
      onOpenChange={(open) => { if (!open) folderPickerController.close(); }}
      title="选择工作目录"
      description="输入路径或从目录建议中选择，后续新会话会从该目录启动。"
      className="wand-folder-picker-dialog"
      overlayClassName="wand-folder-picker-overlay"
      titleClassName="wand-folder-picker-title"
      descriptionClassName="wand-folder-picker-description"
      headerClassName="wand-folder-picker-header"
      closeLabel="关闭工作目录选择器"
      testId="folder-picker-dialog"
      dismissable={!choosing}
    >
      <form className="wand-folder-picker-form" aria-busy={loading || choosing} onSubmit={(event) => void submit(event)}>
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

        <label className="wand-folder-picker-field" htmlFor="wand-folder-picker-input">
          <span>工作目录</span>
          <input
            id="wand-folder-picker-input"
            className="wand-folder-picker-input"
            data-wand-autofocus
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-invalid={error ? "true" : "false"}
            aria-controls="wand-folder-picker-options"
            aria-activedescendant={activeIndex >= 0 ? `wand-folder-picker-option-${activeIndex}` : undefined}
            value={path}
            onChange={(event) => setPath(event.currentTarget.value)}
            onKeyDown={handleInputKeyDown}
          />
        </label>

        <div
          id="wand-folder-picker-options"
          className="wand-folder-picker-options"
          role="listbox"
          aria-label="目录建议"
        >
          {loading ? (
            <div className="wand-folder-picker-state" role="status">正在加载目录…</div>
          ) : listing && listing.items.length > 0 ? (
            listing.items.map((item, index) => (
              <button
                key={`${item.type}:${item.path}`}
                ref={(element) => { itemRefs.current[index] = element; }}
                id={`wand-folder-picker-option-${index}`}
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
          <span>{listing?.currentPath ?? path}</span>
          <WandButton kind="primary" type="submit" disabled={loading || choosing || !path.trim()}>
            {choosing ? "正在应用…" : "使用此目录"}
          </WandButton>
        </div>
      </form>
    </WandDialogSurface>
  );
}
