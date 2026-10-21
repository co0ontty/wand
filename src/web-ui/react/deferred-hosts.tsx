import * as React from "react";
import { deferredFeature } from "./deferred-feature";
import { piExecutionController } from "./pi-execution/controller";
import { settingsController, settingsStore } from "./settings/controller";
import { codeEditorController, codeEditorStore } from "./code-editor/controller";
import { taskBoardController, taskBoardStore } from "./issues/task-board-controller";
import { newSessionController, newSessionStore } from "./new-session/controller";
import { folderPickerController, folderPickerStore } from "./folder-picker/controller";
import { quickCommitController, quickCommitStore } from "./quick-commit/controller";
import { worktreeMergeController, worktreeMergeStore } from "./worktree-merge/controller";
import { filePreviewController, filePreviewStore } from "./file-preview/controller";
import { localPreviewController } from "./local-preview/controller";
import { imageViewerController } from "./image-viewer/controller";
import { missionsController, missionsStore } from "./missions/controller";
import { workspacesController, workspacesStore } from "./workspaces/controller";
import { githubIssuesController, githubIssuesStore } from "./issues/controller";
import { composerAttachmentsController } from "./composer-attachments/controller";

export const ComposerAttachmentsHost = deferredFeature(
  () => import("./composer-attachments/host").then(module => module.ComposerAttachmentsHost),
  composerAttachmentsController,
  snapshot => snapshot.mounts.length > 0,
  { title: "附件", close: () => {}, renderPending: () => <></> },
);

export const PiExecutionHost = deferredFeature(
  () => import("./pi-execution/host").then(module => module.PiExecutionHost), piExecutionController,
  snapshot => snapshot !== null, { title: "执行详情", close: () => piExecutionController.close() },
);

export const SettingsHost = deferredFeature(
  () => import("./settings/host").then(module => module.SettingsHost), settingsStore,
  (snapshot, props) => snapshot.open || props.presentation === "page",
  { title: "设置", page: true, close: () => settingsController.close(), dismissable: props => props.presentation !== "page" },
);
export const CodeEditorHost = deferredFeature(
  () => import("./code-editor/host").then(module => module.CodeEditorHost), codeEditorStore,
  snapshot => snapshot.open, { title: "文件编辑器", page: true, close: () => { void codeEditorController.execute({ type: "close" }); } },
);
export const TaskBoardHost = deferredFeature<import("./issues/task-board-host").TaskBoardHostProps, ReturnType<typeof taskBoardStore.getSnapshot>>(
  () => import("./issues/task-board-host").then(module => module.TaskBoardHost), taskBoardStore,
  snapshot => snapshot.open && snapshot.page !== "teams" && snapshot.page !== "teamchat",
  { title: "任务看板", page: true, close: () => taskBoardController.close() },
);
export const NewSessionHost = deferredFeature(
  () => import("./new-session/host").then(module => module.NewSessionHost), newSessionStore,
  snapshot => snapshot.open, { title: "新建会话", page: true, close: () => newSessionController.close(),
    renderPending: status => <section aria-label="新建会话加载" style={{ position: "absolute", inset: 0, zIndex: 8, background: "var(--bg-primary)", padding: "var(--wand-page-inset)" }}>{status}</section> },
);
export const FolderPickerHost = deferredFeature(
  () => import("./folder-picker/host").then(module => module.FolderPickerHost), folderPickerStore,
  snapshot => snapshot.open, { title: "选择目录", close: () => folderPickerController.close() },
);
export const QuickCommitHost = deferredFeature(
  () => import("./quick-commit/host").then(module => module.QuickCommitHost), quickCommitStore,
  snapshot => snapshot.open, { title: "快速提交", close: () => quickCommitController.close() },
);
export const WorktreeMergeHost = deferredFeature(
  () => import("./worktree-merge/host").then(module => module.WorktreeMergeHost), worktreeMergeStore,
  snapshot => snapshot.open, { title: "合并工作树", close: () => worktreeMergeController.close() },
);
export const FilePreviewHost = deferredFeature(
  () => import("./file-preview/host").then(module => module.FilePreviewHost), filePreviewStore,
  snapshot => snapshot.open, { title: "文件预览", close: () => { void filePreviewController.execute({ type: "close" }); } },
);
export const LocalPreviewHost = deferredFeature(
  () => import("./local-preview/host").then(module => module.LocalPreviewHost), localPreviewController,
  snapshot => snapshot.open, { title: "本地预览", close: () => localPreviewController.close() },
);
export const ImageViewerHost = deferredFeature(
  () => import("./image-viewer/host").then(module => module.ImageViewerHost), imageViewerController,
  snapshot => snapshot.open, { title: "图片", close: () => imageViewerController.close() },
);
export const MissionsHost = deferredFeature(
  () => import("./missions/host").then(module => module.MissionsHost), missionsStore,
  snapshot => snapshot.open, { title: "任务", close: () => missionsController.close() },
);
export const WorkspacesHost = deferredFeature(
  () => import("./workspaces/host").then(module => module.WorkspacesHost), workspacesStore,
  snapshot => snapshot.open, { title: "工作区", close: () => workspacesController.close() },
);
export const GithubIssuesHost = deferredFeature(
  () => import("./issues/host").then(module => module.GithubIssuesHost), githubIssuesStore,
  snapshot => snapshot.open, { title: "GitHub Issues", close: () => githubIssuesController.close() },
);
