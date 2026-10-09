import { useEffect, useSyncExternalStore } from "react";
import { newSessionController } from "../new-session/controller";
import { workspacesStore } from "./controller";
import type { WorkspacesRepository } from "./types";
import { httpWorkspacesRepository } from "./repository";

export interface WorkspacesHostProps {
  repository?: WorkspacesRepository;
}

/**
 * 新建任务已统一复用新建会话窗口（NewSessionHost），避免维护多套重复页面与表单。
 * 监听 workspacesController 并在触发时自动桥接转发至 newSessionController。
 */
export function WorkspacesHost({ repository: _repository = httpWorkspacesRepository }: WorkspacesHostProps) {
  const controller = useSyncExternalStore(
    workspacesStore.subscribe,
    workspacesStore.getSnapshot,
    workspacesStore.getSnapshot,
  );

  useEffect(() => {
    if (!controller.open) return;
    if (!newSessionController.isOpen()) newSessionController.open({ initialCwd: controller.initialCwd, newTask: controller.initialKind === "task" });
    workspacesStore.consumeOpen();
  }, [controller.initialCwd, controller.initialKind, controller.open]);

  return null;
}
