import * as React from "react";
import { Flex, Typography } from "antd";
import { WandButton, WandIcon } from "../ui";
import { AddWorkspaceButton } from "./create-workspace";
import { SidebarRowMenu } from "./sidebar-row-menu";
import { WandDialogSurface } from "../ui/dialog";
const WorkspaceWorktreeDialog = React.lazy(() => import("./workspace-worktree-dialog").then(module => ({ default: module.WorkspaceWorktreeDialog })));
import { workspacesStore } from "./controller";
import { conversationUi, useConversationUi } from "../conversations/state";
import type { TaskDirectoryGroup, Workspace } from "./types";
import type { WorkspaceMergeAgentBrief } from "./workspace-worktree-model";

export function worktreeDirectoryEntries(groups: readonly TaskDirectoryGroup[]) {
  const entries = new Map<string, { path: string; name: string; branch: string; parentId: string }>();
  for (const group of groups) {
    if (group.worktree?.parentWorkspaceId) entries.set(group.worktree.path, { ...group.worktree, parentId: group.worktree.parentWorkspaceId });
    for (const task of group.tasks) if (task.worktree && !task.archived) {
      const tree = task.worktree;
      const parent = groups.find(item => !item.synthetic && !item.global && item.workspaceCwd === (tree.repoRoot || group.workspaceCwd));
      if (parent) entries.set(tree.path, { path: tree.path, name: tree.path.split("/").filter(Boolean).at(-1) || tree.branch, branch: tree.branch, parentId: parent.workspaceId });
    }
  }
  return [...entries.values()];
}

function WorktreeDirectoryRow({ name, path, branch, onMerge }: { name: string; path: string; branch: string; onMerge(): void }) {
  const ui = useConversationUi();
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLElement>(null);
  return <SidebarRowMenu title={name} label={`Worktree ${name} 的操作`} open={open} onOpenChange={setOpen} rowRef={ref}
    row={<WandButton kind={ui.listWorktree === path ? "soft" : "ghost"} className="worktree-directory-option" aria-pressed={ui.listWorktree === path}
      title={`${path}\n分支：${branch}`} onClick={() => conversationUi.worktree(path)}><WandIcon name="branch" size={14}/><span>{name}</span></WandButton>}
    menu={{ items: [{ key: "filter", label: ui.listWorktree === path ? "取消 Worktree 筛选" : "筛选此 Worktree 的会话", icon: <WandIcon name="search"/> },
      { key: "merge", label: "合并到工作区分支…", icon: <WandIcon name="merge"/> }], onClick: ({ key }) => {
      setOpen(false); if (key === "merge") onMerge(); else conversationUi.worktree(path);
    } }}/ >;
}

/** The active sidebar's directory selector shares the same hierarchy and merge dialog as the workspace tree. */
export function WorktreeDirectoryPicker({ groups, query, onSelect, selected, onMerge }: {
  groups: readonly TaskDirectoryGroup[]; query: string; selected(value: string): boolean; onSelect(value: string): void; onMerge(workspace: Workspace, sourcePath: string): void;
}) {
  const trees = worktreeDirectoryEntries(groups).filter(tree => groups.some(group => group.userAdded && group.workspaceCwd === tree.path));
  const roots = groups.filter(group => group.userAdded && !group.synthetic && !group.global);
  const match = (value: string) => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  return <>
    {roots.map(group => {
      const children = trees.filter(tree => tree.parentId === group.workspaceId && (match(group.workspaceName) || match(tree.name) || match(tree.branch)));
      if (!match(group.workspaceName) && !children.length) return null;
      const workspace: Workspace = { id: group.workspaceId, name: group.workspaceName, cwd: group.workspaceCwd, layout: null, createdAt: "", lastOpenedAt: null };
      return <Flex vertical key={group.workspaceId} className="worktree-directory-project">
        <WandButton kind={selected(`id:${group.workspaceId}`) ? "soft" : "ghost"} aria-pressed={selected(`id:${group.workspaceId}`)} onClick={() => onSelect(`id:${group.workspaceId}`)}><WandIcon name="folder" size={15}/>{group.workspaceName}</WandButton>
        {children.length ? <div className="workspace-worktree-children">{children.map(tree => <WorktreeDirectoryRow key={tree.path} {...tree} onMerge={() => onMerge(workspace, tree.path)}/>)}</div> : null}
      </Flex>;
    })}
    {!roots.some(group => match(group.workspaceName)) && !trees.some(tree => match(tree.name) || match(tree.branch)) ? <Typography.Text type="secondary">没有匹配的工作区</Typography.Text> : null}
    <AddWorkspaceButton onCreated={workspace => onSelect(`id:${workspace.id}`)}/>
  </>;
}


export function WorkspaceWorktreeLaunchDialog({ workspace, sourcePath, onDismiss }: { workspace: Workspace; sourcePath: string; onDismiss(): void }) {
  const startMerge = async (brief: WorkspaceMergeAgentBrief) => {
    const rt = workspacesStore.getRuntime();
    if (!rt) throw new Error("工作区尚未就绪，请刷新后重试。");
    await rt.startWorktreeMergeAgent({ workspaceId: workspace.id, cwd: brief.targetCwd || workspace.cwd,
      systemPrompt: brief.system, prompt: brief.message, sourcePaths: brief.sourcePaths, sourceBranches: brief.sourceBranches,
      targetBranch: brief.targetBranch, employeeId: brief.employeeId, agent: brief.agent, requestId: brief.requestId });
  };
  return <React.Suspense fallback={<WandDialogSurface open title="合并 Worktree" onOpenChange={open => { if (!open) onDismiss(); }}><Typography.Text role="status">正在读取合并设置…</Typography.Text></WandDialogSurface>}><WorkspaceWorktreeDialog open workspace={workspace} sourcePath={sourcePath} onStartAgent={startMerge} onDismiss={onDismiss}/></React.Suspense>;
}
