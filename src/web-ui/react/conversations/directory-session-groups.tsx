import * as React from "react";
import { Alert, Flex, Spin, Typography } from "antd";
import { WandButton, WandIcon } from "../ui";
import { WandDialogSurface } from "../ui/dialog";
import { SidebarRowMenu } from "../workspaces/sidebar-row-menu";
import { newSessionController } from "../new-session/controller";
import { readDirectory, inspectDirectoryMerge, mergeDirectory, type WorkspaceDirectory, type DirectoryMergeInspection } from "../workspaces/directory-repository";
import { describeError } from "../errors";
import type { UnifiedSidebarEntry, UnifiedSidebarModel } from "./unified-sidebar-model";
import { isSessionAttention } from "../workspaces/sidebar-display-mode";
import { isSessionNeedsConfirmation } from "./runtime-filter";

function DirectoryHeading({ title, detail, count, open, onToggle, onMerge, branch = false }: {
  title: string; detail?: string; count?: string; open: boolean; onToggle(): void; onMerge?(): void; branch?: boolean;
}) {
  const [menu, setMenu] = React.useState(false);
  const row = <button type="button" className="session-directory-heading" aria-expanded={open} onClick={onToggle}>
    <WandIcon name={open ? "chevronDown" : "chevron"} size={12}/><WandIcon name={onMerge || branch ? "branch" : "folder"} size={15}/>
    <span className="session-directory-label"><strong>{title}</strong>{detail ? <span>{detail}</span> : null}</span>
    {count ? <span className="session-directory-count">{count}</span> : null}
  </button>;
  return onMerge ? <SidebarRowMenu row={row} title={title} label={`${title} 的操作`} open={menu} onOpenChange={setMenu}
    menu={{ items: [{ key: "merge", label: "合并到项目分支…", icon: <WandIcon name="merge"/> }], onClick: () => { setMenu(false); onMerge(); } }}/> : row;
}

function DirectoryMergeDialog({ workspaceId, path, onClose, onChanged }: { workspaceId: string; path: string; onClose(): void; onChanged(): void }) {
  const [inspection, setInspection] = React.useState<DirectoryMergeInspection | null>(null);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [finished, setFinished] = React.useState(false);
  const [revision, setRevision] = React.useState(0);
  const lock = React.useRef(false);
  React.useEffect(() => {
    const abort = new AbortController(); setInspection(null); setError("");
    void inspectDirectoryMerge(workspaceId, path, abort.signal).then(value => { if (!abort.signal.aborted) setInspection(value); })
      .catch(cause => { if (!abort.signal.aborted) setError(describeError(cause, "无法检查合并状态。")); });
    return () => abort.abort();
  }, [workspaceId, path, revision]);
  const merge = async () => {
    if (!inspection?.ok || lock.current || finished) return;
    lock.current = true; setBusy(true);
    try { await mergeDirectory(inspection); setFinished(true); onChanged(); }
    catch (cause) { setError(describeError(cause, "合并结果尚未确认，请刷新检查，勿重复提交。")); setInspection(null); onChanged(); }
    finally { lock.current = false; setBusy(false); }
  };
  return <WandDialogSurface open title="合并 Worktree" dismissable={!busy} onOpenChange={open => { if (!open) onClose(); }}>
    <Flex vertical gap={16}>
      {!inspection && !error ? <Spin tip="正在检查来源与目标…"><div role="status">正在检查来源与目标…</div></Spin> : null}
      {inspection ? <><Typography.Text strong style={{ overflowWrap: "anywhere" }}>{inspection.sourceBranch} → {inspection.targetBranch}</Typography.Text>
        <Typography.Text type="secondary">{inspection.aheadCount} 个待合并提交 · {inspection.targetDirty || inspection.hasUncommittedChanges ? "存在未提交改动" : "无未提交改动"} · {inspection.hasConflicts ? "有冲突风险" : "无冲突风险"}</Typography.Text>
        <Alert type={finished ? "success" : inspection.ok ? "info" : "warning"} showIcon title={finished ? "已合并并清理 Worktree。" : inspection.ok ? "检查通过。确认后合并并清理来源 Worktree 和任务分支，会话历史保留。" : inspection.reason || "无法一键合并，可交给 Agent 分析处理。"}/></> : null}
      {error ? <Alert type="error" title={error} role="alert"/> : null}
      <Flex gap={8} justify="flex-end" wrap>
        <WandButton disabled={busy} onClick={onClose}>{finished ? "关闭" : "取消"}</WandButton>
        {!busy && !finished && error ? <WandButton onClick={() => setRevision(value => value + 1)}>重新检查</WandButton> : null}
        {inspection && !finished ? <WandButton kind="primary" disabled={!inspection.ok || busy} onClick={() => void merge()}>{busy ? "正在合并…" : "确认合并并清理"}</WandButton> : null}
        {inspection?.agentAllowed && !finished ? <WandButton kind="primary" disabled={busy} onClick={() => {
          const opened = newSessionController.open({ initialCwd: inspection.targetCwd, workspaceId, initialText: inspection.agentPrompt,
            taskDraft: { draftKey: `merge:${workspaceId}:${path}:${crypto.randomUUID()}` } });
          if (opened) onClose(); else setError("新建会话暂不可用，请稍后重试。");
        }}>交给 Agent 合并</WandButton> : null}
      </Flex>
    </Flex>
  </WandDialogSurface>;
}

const within = (cwd: string, root: string) => cwd === root || cwd.startsWith(`${root.replace(/\/$/, "")}/`);
export function DirectorySessionGroups({ model, renderRow, selectedId }: {
  model: UnifiedSidebarModel; renderRow(entry: UnifiedSidebarEntry): React.ReactNode; selectedId?: string | null;
}) {
  const projects = model.groups.filter(group => group.userAdded && !group.synthetic && !group.global);
  const key = projects.map(group => `${group.workspaceId}:${group.workspaceCwd}`).join("|");
  const [directories, setDirectories] = React.useState<Record<string, WorkspaceDirectory>>({});
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [refresh, setRefresh] = React.useState(0);
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => {
    try { return new Set(JSON.parse(sessionStorage.getItem("wand.sessionDirectories.collapsed") || "[]")); } catch { return new Set(); }
  });
  const [merge, setMerge] = React.useState<{ workspaceId: string; path: string } | null>(null);
  React.useEffect(() => {
    const abort = new AbortController(); let next = 0;
    const load = async () => { while (next < projects.length && !abort.signal.aborted) {
      const project = projects[next++];
      try { const value = await readDirectory(project.workspaceId, abort.signal); if (!abort.signal.aborted) {
        setDirectories(current => ({ ...current, [project.workspaceId]: value })); setErrors(current => ({ ...current, [project.workspaceId]: "" }));
      } } catch (cause) { if (!abort.signal.aborted) setErrors(current => ({ ...current, [project.workspaceId]: describeError(cause, "暂不可用") })); }
    } };
    void Promise.all(Array.from({ length: Math.min(3, projects.length) }, load));
    return () => abort.abort();
  }, [key, refresh]);
  React.useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden) setRefresh(value => value + 1); }, 30000);
    return () => window.clearInterval(timer);
  }, []);
  const toggle = (id: string) => setCollapsed(current => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id);
    try { sessionStorage.setItem("wand.sessionDirectories.collapsed", JSON.stringify([...next])); } catch { /* optional preference */ } return next; });
  const owner = (entry: UnifiedSidebarEntry) => {
    const cwd = entry.session.worktree?.path || entry.task?.worktree?.path || entry.session.cwd || entry.group.workspaceCwd;
    return projects.filter(project => project.workspaceId === entry.group.workspaceId || entry.group.worktree?.parentWorkspaceId === project.workspaceId
      || within(cwd, project.workspaceCwd) || directories[project.workspaceId]?.worktrees.some(tree => within(cwd, tree.path)))
      .sort((a, b) => b.workspaceCwd.length - a.workspaceCwd.length)[0];
  };
  const selectedOwner = model.entries.find(entry => entry.session.id === selectedId);
  React.useEffect(() => {
    if (!selectedOwner) return;
    const project = owner(selectedOwner);
    if (project) setCollapsed(current => new Set([...current].filter(id => !id.startsWith(project.workspaceId))));
  }, [selectedId]);
  const searching = Boolean(model.query.trim());
  const unassigned = model.orderedRows.filter(entry => !owner(entry));
  return <>
    {projects.map(project => {
      const directory = directories[project.workspaceId];
      const rows = model.orderedRows.filter(entry => owner(entry)?.workspaceId === project.workspaceId);
      if (!rows.length && (searching || model.facets.workspace !== "all" || model.facets.employee !== "all" || model.facets.runtime !== "all")) return null;
      const open = searching || !collapsed.has(project.workspaceId);
      const attention = rows.filter(entry => isSessionAttention(entry.session) || isSessionNeedsConfirmation(entry.session)).length;
      const trees = directory?.worktrees ?? [];
      const treeFor = (entry: UnifiedSidebarEntry) => { const cwd = entry.session.worktree?.path || entry.task?.worktree?.path || entry.session.cwd || entry.group.workspaceCwd;
        return trees.filter(tree => within(cwd, tree.path)).sort((a, b) => b.path.length - a.path.length)[0]; };
      return <section className="session-directory" key={project.workspaceId}>
        <DirectoryHeading title={project.workspaceName} detail={errors[project.workspaceId] ? "分支与 Worktree 暂不可用" : !directory ? "正在读取目录…" : directory.isGit ? `${directory.branch || "detached HEAD"} · ${trees.length} 个 Worktree` : "非 Git 目录"}
          count={attention ? `${attention} 待处理` : undefined} open={open} onToggle={() => toggle(project.workspaceId)}/>
        {errors[project.workspaceId] ? <WandButton kind="ghost" size="small" onClick={() => setRefresh(value => value + 1)}>重新读取目录</WandButton> : null}
        {open ? <div className="session-directory-children">
          {trees.length ? <DirectoryHeading branch title="主分支" detail={directory?.branch || "detached HEAD"} open={!collapsed.has(`${project.workspaceId}:main`) || searching}
            onToggle={() => toggle(`${project.workspaceId}:main`)} count={`${rows.filter(entry => !treeFor(entry)).length} 个会话`}/> : null}
          {(!trees.length || searching || !collapsed.has(`${project.workspaceId}:main`)) ? <div className={`session-directory-sessions${trees.length ? "" : " session-directory-sessions-direct"}`}>{rows.filter(entry => !treeFor(entry)).map(renderRow)}</div> : null}
          {trees.map(tree => {
            const matches = rows.filter(entry => treeFor(entry)?.path === tree.path);
            if (searching && !matches.length && !`${tree.name} ${tree.branch}`.toLowerCase().includes(model.query.trim().toLowerCase())) return null;
            const id = `${project.workspaceId}:${tree.path}`, expanded = searching || !collapsed.has(id);
            return <section key={tree.path} className="session-worktree-group"><DirectoryHeading title={tree.name} detail={tree.branch || "detached HEAD"} count={`${matches.length} 个会话`} open={expanded}
              onToggle={() => toggle(id)} onMerge={() => setMerge({ workspaceId: project.workspaceId, path: tree.path })}/>
              {expanded ? <div className="session-directory-sessions">{matches.length ? matches.map(renderRow) : <Typography.Text type="secondary">暂无匹配会话</Typography.Text>}</div> : null}</section>;
          })}
        </div> : null}
      </section>;
    })}
    {unassigned.length ? <section><DirectoryHeading title="其他会话" open={searching || !collapsed.has("other")} count={`${unassigned.length} 个会话`} onToggle={() => toggle("other")}/>
      {searching || !collapsed.has("other") ? <div className="session-directory-sessions">{unassigned.map(renderRow)}</div> : null}</section> : null}
    {merge ? <DirectoryMergeDialog {...merge} onClose={() => setMerge(null)} onChanged={() => { setRefresh(value => value + 1); model.refresh(); }}/ > : null}
  </>;
}
