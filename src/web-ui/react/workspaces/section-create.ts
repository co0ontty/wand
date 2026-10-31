import { wandOverlay } from "../overlay-controller";
import { httpWorkspacesRepository } from "./repository";
import type { TaskDirectoryGroup } from "./types";

export async function createWorkspaceSection(group: TaskDirectoryGroup, sessionId?: string): Promise<boolean> {
  const answer = await wandOverlay.dialog({
    title: sessionId ? "新建分区并移入" : "新建分区",
    description: `在 ${group.workspaceName} 中整理会话，不创建任务卡。`,
    input: { label: "分区名称", placeholder: "例如：功能开发" },
    actions: [{ label: "取消", value: false }, { label: "创建", value: true, autoFocus: true }],
  });
  if (answer.dismissed === true) return false;
  if (!answer.action) return false;
  const name = answer.inputValue?.trim();
  if (!name) throw new Error("请输入分区名称。");
  await httpWorkspacesRepository.createSection({ name, cwd: group.workspaceCwd,
    ...(!group.synthetic && !group.global ? { workspaceId: group.workspaceId } : {}), sessionId });
  return true;
}
