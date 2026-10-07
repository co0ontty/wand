import { Alert, Flex, Form, Space, Typography } from "antd";
import { FolderPickerOptions } from "../folder-picker/options";
import "../issues/library-layout";
import { TaskForm } from "../issues/form-controls";
import { WandInput } from "../ui";
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
import { failureMessage } from "../errors";

export interface FolderPickerHostProps {
  repository?: FolderPickerRepository;
}

const NAVIGATION_KEYS = new Set<FolderPickerNavigationKey>([
  "ArrowDown",
  "ArrowUp",
  "Home",
  "End",
]);

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
          setError(failureMessage(loadError, "无法读取该目录。"));
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
      setError(failureMessage(selectionError, "无法读取该目录。"));
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
      setError(failureMessage(selectionError, "无法读取该目录。"));
    } finally {
      folderPickerController.setDismissable(true);
      setChoosing(false);
    }
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    // 组字期的回车/方向键属于候选词，不能让文件夹选择框提前提交或跳条目。
    if (event.nativeEvent.isComposing) return;
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
      className="wand-task-library-dialog wand-folder-picker-library-dialog"
      closeLabel="关闭工作目录选择器"
      testId="folder-picker-dialog"
      dismissable={!choosing}
    >
      <TaskForm noValidate aria-busy={loading || choosing} onSubmit={(event) => void submit(event)}>
        <Flex vertical gap={16}>
        <Space wrap aria-label="快捷目录">
          <WandButton size="small" onClick={() => navigate("/tmp")}>临时目录 /tmp</WandButton>
          <WandButton size="small" onClick={() => navigate("/")}>根目录 /</WandButton>
          <WandButton
            size="small"
            disabled={!parent || loading}
            onClick={() => { if (parent) navigate(parent.path); }}
          >
            返回上级
          </WandButton>
        </Space>
        <Form.Item label="工作目录" htmlFor="wand-folder-picker-input">
          <WandInput
            id="wand-folder-picker-input"
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
        </Form.Item>
        <FolderPickerOptions id="wand-folder-picker-options" optionPrefix="wand-folder-picker-option"
          items={listing?.items} loading={loading} error={error} activeIndex={activeIndex}
          itemRefs={itemRefs} onActivate={activateItem} onActiveIndex={setActiveIndex}/>

        {error ? <Alert type="error" showIcon role="alert" title={error}/> : null}

        <Flex justify="space-between" align="center" gap={12} wrap>
          <Typography.Text type="secondary" ellipsis style={{ minWidth: 0, flex: 1 }} title={listing?.currentPath ?? path}>{listing?.currentPath ?? path}</Typography.Text>
          <WandButton kind="primary" type="submit" disabled={loading || choosing || !path.trim()}>
            {choosing ? "正在应用…" : "使用此目录"}
          </WandButton>
        </Flex>
        </Flex>
      </TaskForm>
    </WandDialogSurface>
  );
}
