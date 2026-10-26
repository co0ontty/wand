import * as React from "react";
import { Alert, AutoComplete, Flex, Form, Spin, Typography } from "antd";
import { DEFAULT_WAND_TASK_PRIORITY, type WandTaskPriority, type WandTaskStatus } from "../../../task-types";
import { useSiliconEmployees } from "../agents/employee-repository";
import { EmployeeAvatar } from "../agents/employee-avatar";
import { aiTeamsRepository, type AiTeam } from "../ai-teams/repository";
import { teamChatComposer } from "../ai-teams/composer-bridge";
import { conversationDraftKey } from "../conversations/state";
import { ConversationSubmitButton } from "../conversations/controls";
import { ComposerAttachmentList } from "../composer-attachments/host";
import { useImeGuard } from "../composer-sender/ime-guard";
import { useEditorExpansion } from "../composer-sender/editor-expansion";
import { installChatComposerStyles } from "../chat-composer-styles";
import { installConversationHomeStyles } from "../conversations/home-styles";
import { NewWorkComposer, type NewWorkComposerHandle } from "../new-session/composer";
import { NewWorkIntent } from "../new-session/intent";
import { newSessionController, newSessionStore, type NewSessionControllerSnapshot } from "../new-session/controller";
import { httpNewSessionRepository } from "../new-session/repository";
import { installNewWorkStyles } from "../new-session/start-styles";
import { type NewSessionDefaults } from "../new-session/types";
import { httpWorkspacesRepository } from "../workspaces/repository";
import { notifyTasksChanged } from "../task-changes";
import { updatePageRoute } from "../../page-route";
import { describeError } from "../errors";
import { wandOverlay } from "../overlay-controller";
import { WandButton, WandIcon, WandInput, WandPopover, WandSelect, WandSwitch } from "../ui";
import { PopupOwnerProvider } from "../ui/portal-context";
import { MilestonePicker } from "../milestones/picker";
import { defaultMilestone, useDefaultMilestone, usePreselectMilestone } from "../milestones/default-iteration";
import { milestonesStore } from "../milestones/controller";
import { useWandModelCatalog } from "../use-model-catalog";
import { sortProviderOptions, useProviderUsage } from "../provider-usage";
import { AgentField, AgentFields } from "./agent-fields";
import { TaskDatePicker } from "./date-picker";
import { taskBoardController } from "./task-board-controller";
import { taskBoardRepository, type IssueWorkspace, type WandTaskListed } from "./task-board-repository";
import { ISSUE_AGENT_TARGETS, ISSUE_COLUMNS, ISSUE_NO_PARENT, ISSUE_PRIORITIES, issueAgentLabel, issueParentOptions, issueWorkspaceIdFromSelect, issueWorkspaceOptions, issueWorkspaceSelectValue } from "./task-board-agent";
import { readIssueAssignment, resolveIssueAssignment, writeIssueAssignment } from "./task-board-assignment";
import { buildTaskDispatchPrompt, taskDispatchConfiguration } from "./task-dispatch-preview";
import { taskCreationRequest, unknownTaskCreation, type TaskCreationDraft } from "./task-create-state";
import "./library-layout";

// Metadata survives Back within this page lifetime. Text stays in the shared composer owner.
const taskDrafts = new Map<string, TaskCreationDraft>();
const acceptedTasks = new Map<string, WandTaskListed>();

function normalizedPath(path: string): string { return path.trim().replace(/\/+$/, "") || "/"; }
function workspaceMilestone(workspaceId: string): string {
  return defaultMilestone(milestonesStore.getSnapshot().items, workspaceId || null)?.id || "";
}

/** One task creator for the board, workspace, welcome page and task selector. */
export function TaskCreationPage({ options }: { options: NewSessionControllerSnapshot }): React.ReactElement {
  const initialScope = `${options.taskDraft?.workspaceId || options.workspaceId || options.initialCwd || "global"}:${options.taskDraft?.parentTaskId || "root"}`;
  const composerKey = options.taskDraft?.draftKey || conversationDraftKey(`new-work:task:${initialScope}`, null);
  const scope = options.taskDraft?.scope || `task:${composerKey}`;
  const revision = React.useCallback(() => teamChatComposer.revision(composerKey), [composerKey]);
  React.useSyncExternalStore(teamChatComposer.subscribe, revision, revision);
  const textDraft = teamChatComposer.read(composerKey);
  const sender = React.useRef<NewWorkComposerHandle>(null);
  const editor = useEditorExpansion(composerKey, () => sender.current?.inputElement);
  const [draft, setDraft] = React.useState<TaskCreationDraft | null>(() => {
    const saved = taskDrafts.get(scope);
    if (!saved) return null;
    if (!options.taskDraft?.draftKey) {
      // A fresh entry may target another board column while reusing the same written draft.
      const initial = options.taskDraft;
      return { ...saved,
        ...(initial?.status !== undefined ? { status: initial.status } : {}),
        ...(initial?.priority !== undefined ? { priority: initial.priority } : {}),
        ...(initial?.milestoneId !== undefined ? { milestoneId: initial.milestoneId } : {}),
        ...(initial?.parentTaskId !== undefined ? { parentTaskId: initial.parentTaskId } : {}) };
    }
    // Returning from immediate work carries its latest execution and directory choices.
    const workspaceId = options.taskDraft.workspaceId ?? options.workspaceId ?? saved.workspaceId;
    const moved = workspaceId !== saved.workspaceId || (options.initialCwd && normalizedPath(options.initialCwd) !== normalizedPath(saved.cwd));
    const subject = options.taskDraft.executionSubject ?? saved.subject;
    return { ...saved, workspaceId, cwd: options.initialCwd || saved.cwd, subject,
      agent: options.taskDraft.agent ?? saved.agent, employeeOverride: !!subject.agentOverride,
      ...(moved ? { parentTaskId: "", milestoneId: workspaceMilestone(workspaceId) } : {}) };
  });
  const resumedDraft = React.useRef(taskDrafts.has(scope));
  const [workspaces, setWorkspaces] = React.useState<IssueWorkspace[]>([]);
  const [tasks, setTasks] = React.useState<WandTaskListed[]>([]);
  const [teams, setTeams] = React.useState<AiTeam[]>([]);
  const [defaults, setDefaults] = React.useState<NewSessionDefaults | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [unknown, setUnknown] = React.useState(() => newSessionController.getUnknownCreation(`draft:${composerKey}`)?.message || newSessionController.getUnknownCreation(scope)?.message || "");
  const [accepted, setAccepted] = React.useState(() => acceptedTasks.get(scope) ?? null);
  const acceptedWork = newSessionController.getAcceptedCreation(composerKey);
  const [saveAndDispatch, setSaveAndDispatch] = React.useState(false);
  const [rememberDefaults, setRememberDefaults] = React.useState(false);
  const [createMore, setCreateMore] = React.useState(false);
  const [propertiesOpen, setPropertiesOpen] = React.useState(false);
  const [directoryOpen, setDirectoryOpen] = React.useState(false);
  const [subjectOpen, setSubjectOpen] = React.useState(false);
  const [titleSubjectOpen, setTitleSubjectOpen] = React.useState(false);
  const [titleDirectoryOpen, setTitleDirectoryOpen] = React.useState(false);
  const [titlePropertiesOpen, setTitlePropertiesOpen] = React.useState(false);
  const [suggestions, setSuggestions] = React.useState<readonly { path: string; name: string }[]>([]);
  const lock = React.useRef(false);
  const alive = React.useRef(true);
  const initializedAssignment = React.useRef(!!draft);
  const { employees, loading: employeesLoading, error: employeesError } = useSiliconEmployees({ enabled: true });
  const catalog = useWandModelCatalog(true);
  const providerUsage = useProviderUsage(true);
  const providerOptions = sortProviderOptions(ISSUE_AGENT_TARGETS, providerUsage || {}, item => item.provider)
    .map(item => ({ value: item.value, label: item.label }));
  const directoryIme = useImeGuard();
  React.useLayoutEffect(() => { installChatComposerStyles(); installConversationHomeStyles(); installNewWorkStyles(); }, []);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  React.useEffect(() => { if (draft) taskDrafts.set(scope, draft); }, [draft, scope]);
  React.useEffect(() => {
    const abort = new AbortController();
    void Promise.all([taskBoardRepository.workspaces(), taskBoardRepository.list(), aiTeamsRepository.list(),
      taskBoardRepository.agentDefaults(), httpNewSessionRepository.load({ signal: abort.signal })])
      .then(([projects, taskList, teamList, agent, config]) => {
        if (abort.signal.aborted) return;
        setWorkspaces(projects); setTasks(taskList); setTeams(teamList); setDefaults(config);
        setDraft(current => {
          if (current) {
            const matched = !current.workspaceId && current.cwd.trim() ? projects.find(item => normalizedPath(item.cwd) === normalizedPath(current.cwd)) : undefined;
            return matched ? { ...current, workspaceId: matched.id, milestoneId: workspaceMilestone(matched.id) } : current;
          }
          const initial = options.taskDraft;
          const workspaceId = initial?.workspaceId || options.workspaceId || "";
          const cwd = projects.find(item => item.id === workspaceId)?.cwd || options.initialCwd
            || (initial && "workspaceId" in initial ? "" : newSessionStore.getRuntime()?.getContext().effectiveCwd || config.config.defaultCwd);
          const project = projects.find(item => normalizedPath(item.cwd) === normalizedPath(cwd));
          const selectedAgent = initial?.agent || agent;
          return { workspaceId: workspaceId || project?.id || "", cwd, title: initial?.title || "",
            status: initial?.status || "backlog", priority: initial?.priority || DEFAULT_WAND_TASK_PRIORITY,
            dueDate: "", labels: "", milestoneId: initial?.milestoneId || "", parentTaskId: initial?.parentTaskId || "",
            agent: selectedAgent, subject: initial?.executionSubject || (options.initialEmployeeId ? { type: "employee", id: options.initialEmployeeId } : { type: "cli", id: selectedAgent.provider }),
            employeeOverride: !!initial?.executionSubject?.agentOverride };
        });
        const initialText = teamChatComposer.read(composerKey);
        if (!options.taskDraft?.draftKey && initialText.revision === 0 && !initialText.text && options.taskDraft?.description) teamChatComposer.edit(composerKey, { text: options.taskDraft.description });
      }).catch(cause => { if (!abort.signal.aborted) setError(describeError(cause, "任务配置读取失败，请重新打开新建。")); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, []);
  React.useEffect(() => {
    if (!draft || loading || employeesLoading || initializedAssignment.current) return;
    initializedAssignment.current = true;
    if (options.initialEmployeeId || options.taskDraft?.executionSubject) {
      const employee = draft.subject.type === "employee" ? employees.find(item => item.id === draft.subject.id) : undefined;
      if (employee?.agents[0] && !draft.employeeOverride) setDraft(current => current ? { ...current, agent: employee.agents[0]! } : current);
      return;
    }
    const recent = readIssueAssignment();
    const assignment = resolveIssueAssignment({}, recent?.subject.type === "cli" ? null : recent, draft.agent, {
      employees: employeesError ? null : employees, teams,
    });
    const employee = assignment.subject.type === "employee" ? employees.find(item => item.id === assignment.subject.id) : undefined;
    setDraft(current => current ? { ...current, subject: assignment.subject, agent: employee?.agents[0] ?? assignment.agent } : current);
  }, [draft, loading, employeesLoading, employeesError, employees, teams, options]);
  React.useEffect(() => {
    if ((!directoryOpen && !titleDirectoryOpen) || !draft) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      void httpNewSessionRepository.suggestPaths(draft.cwd, { signal: abort.signal })
        .then(items => { if (!abort.signal.aborted) setSuggestions(items); }).catch(() => {});
    }, 120);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [directoryOpen, titleDirectoryOpen, draft?.cwd]);
  const presetMilestone = useDefaultMilestone(draft?.workspaceId || null, !loading);
  usePreselectMilestone(!loading && !resumedDraft.current, presetMilestone, id => setDraft(current => current && !current.milestoneId ? { ...current, milestoneId: id } : current));

  const edit = (patch: Partial<TaskCreationDraft>): void => { if (!disabled) setDraft(current => current ? { ...current, ...patch } : current); };
  const employee = draft?.subject.type === "employee" ? employees.find(item => item.id === draft.subject.id) : undefined;
  const team = draft?.subject.type === "team" ? teams.find(item => item.id === draft.subject.id) : undefined;
  const disabled = busy || !!unknown || !!accepted || !!acceptedWork;
  const markUnknown = (cause: unknown): void => {
    if (!unknownTaskCreation(cause)) return;
    const message = "创建结果未确认，请先核对任务列表，不要重复创建；本页草稿保留。";
    newSessionController.markUnknownCreation({ scope, message });
    newSessionController.markUnknownCreation({ scope: `draft:${composerKey}`, message });
    teamChatComposer.edit(composerKey, { text: textDraft.text, expectedRevision: textDraft.revision, persist: false });
    setUnknown(message);
  };
  const openCreated = (created: Pick<WandTaskListed, "id" | "workspaceId">): void => {
    acceptedTasks.delete(scope);
    newSessionController.close();
    taskBoardController.open(created.workspaceId || "");
    updatePageRoute({ task: created.id });
  };
  const submit = async (): Promise<void> => {
    const unresolved = newSessionController.getUnknownCreation(`draft:${composerKey}`) || newSessionController.getUnknownCreation(scope);
    if (unresolved) { setUnknown(unresolved.message); return; }
    if (!draft || lock.current || disabled || loading || employeesLoading || (!draft.title.trim() && !textDraft.text.trim())) return;
    if (saveAndDispatch && !textDraft.text.trim()) { setError("创建并开始执行需要填写本次交付目标。"); return; }
    if (textDraft.attachments.length) { setError("任务计划暂不保存附件。请切回开始工作，附件与输入会一并保留。"); return; }
    if (draft.subject.type === "employee" && !employee) { setError("所选员工不可用，请重新选择。"); return; }
    if (draft.subject.type === "team" && !team) { setError("所选团队不可用，请重新选择。"); return; }
    if (saveAndDispatch && employee && !employee.agents.length) { setError("所选员工尚未配置执行工具，请更换员工。"); return; }
    lock.current = true; setBusy(true); setError(""); newSessionController.setDismissable(false);
    let captured = draft;
    try {
      if (saveAndDispatch) {
        const answer = await wandOverlay.dialog({ title: "确认创建并开始执行", description: `将创建任务并新建一次执行。\n${draft.title.trim()}\n${textDraft.text.trim()}\n${taskDispatchConfiguration(draft.agent, draft.employeeOverride ? undefined : employee)}\n${team?.name || ""}\n主目标约束：${tasks.find(item => item.id === draft.parentTaskId)?.description || "无父任务"}\n确认后沿用已有权限与费用边界。`, actions: [{ label: "取消", value: false, autoFocus: true }, { label: "创建并开始执行", value: true, kind: "primary" }] });
        if (answer.dismissed === true || answer.action !== true) return;
      }
      if (!captured.workspaceId && captured.cwd.trim()) {
        const current = await taskBoardRepository.workspaces();
        let project = current.find(item => normalizedPath(item.cwd) === normalizedPath(captured.cwd));
        if (!project) {
          try {
            project = await httpWorkspacesRepository.create({ name: captured.cwd.trim().split("/").filter(Boolean).at(-1) || "工作目录", cwd: captured.cwd.trim() });
            if (!project?.id) throw Object.assign(new Error("服务端未返回项目 ID，请核对目录列表。"), { status: 200 });
          }
          catch (cause) { markUnknown(cause); throw cause; }
        }
        captured = { ...captured, workspaceId: project.id, cwd: project.cwd };
        taskDrafts.set(scope, captured); setDraft(captured);
      }
      const request = taskCreationRequest(captured, textDraft.text, rememberDefaults);
      const subject = request.executionSubject;
      const created = await taskBoardRepository.create(request)
        .then(result => { if (!result?.id) throw Object.assign(new Error("服务端未返回任务 ID，请核对任务列表。"), { status: 200 }); return result; })
        .catch(cause => { markUnknown(cause); throw cause; });
      acceptedTasks.set(scope, created); setAccepted(created);
      let dispatchError = "";
      if (saveAndDispatch) {
        try {
          await taskBoardRepository.dispatch(created.id, subject.type === "cli" || captured.employeeOverride ? captured.agent : null, {
            subject, prompt: buildTaskDispatchPrompt(created, tasks.find(item => item.id === created.parentTaskId), textDraft.text), workspaceId: created.workspaceId,
          });
          writeIssueAssignment({ agent: captured.agent, subject });
        } catch (cause) { dispatchError = describeError(cause, "任务已创建，但启动执行失败。请在任务详情中核对执行记录。"); }
      }
      teamChatComposer.edit(composerKey, { acknowledgeRevision: textDraft.revision });
      taskDrafts.delete(scope); notifyTasksChanged();
      if (dispatchError) { setError(`任务已创建。${dispatchError} 请打开已创建的任务，不要重复创建。`); return; }
      acceptedTasks.delete(scope);
      if (createMore) {
        const next = { ...captured, title: "" };
        taskDrafts.set(scope, next); setDraft(next); setAccepted(null);
        wandOverlay.toast(`已创建任务「${created.title}」`, { tone: "success" });
      } else openCreated(created);
    } catch (cause) {
      if (alive.current) setError(describeError(cause, "创建未完成，草稿已保留。"));
    } finally {
      lock.current = false; newSessionController.setDismissable(true);
      if (alive.current) setBusy(false);
    }
  };

  if (loading || employeesLoading) return <Flex align="center" justify="center" flex={1} role="status"><Spin/><span>正在读取任务配置…</span></Flex>;
  if (!draft) return <Alert type="error" title={error || "任务配置未就绪，请重新打开新建。"}/>;
  const project = workspaces.find(item => item.id === draft.workspaceId);
  const directoryLabel = project?.name || draft.cwd.split("/").filter(Boolean).at(-1) || "选择目录";
  const subjectLabel = employee?.name || team?.name || issueAgentLabel(draft.agent.provider, draft.agent.engine);
  const label = saveAndDispatch ? "创建并开始执行" : "仅创建任务";
  const changeDirectory = (cwd: string): void => {
    const matched = workspaces.find(item => normalizedPath(item.cwd) === normalizedPath(cwd));
    const workspaceId = matched?.id || "";
    edit({ cwd, workspaceId, ...(workspaceId === draft.workspaceId ? {} : { parentTaskId: "", milestoneId: workspaceMilestone(workspaceId) }) });
  };
  const directoryPickerContent = (
    <Flex vertical gap={12} className="new-work-paths"><Typography.Text strong>运行目录</Typography.Text>
      <AutoComplete value={draft.cwd} options={suggestions.map(item => ({ value: item.path }))} onChange={changeDirectory}><WandInput autoFocus aria-label="新工作运行目录路径" placeholder="输入目录路径"
        onCompositionStart={directoryIme.onCompositionStart} onCompositionEnd={directoryIme.onCompositionEnd}
        onKeyDown={event => { if (directoryIme.shouldIgnore(event)) return; if (event.key === "Enter") { event.preventDefault(); setDirectoryOpen(false); setTitleDirectoryOpen(false); } }}/></AutoComplete>
      {defaults?.recentPaths.map(item => <WandButton kind="ghost" key={item.path} title={item.path} onClick={() => { changeDirectory(item.path); setDirectoryOpen(false); setTitleDirectoryOpen(false); }}>{item.path}</WandButton>)}
      <WandButton onClick={() => { setDirectoryOpen(false); setTitleDirectoryOpen(false); }}>完成</WandButton>
    </Flex>
  );
  const properties = <PopupOwnerProvider owner="task-create-properties"><Form layout="vertical" component={false}>
    <Flex vertical gap={12} className="task-board-create-library-dialog new-work-paths">
      <Typography.Text strong>任务属性</Typography.Text>
      <Form.Item label="任务标题（可选）" style={{ marginBottom: 0 }}><WandInput autoFocus className="task-board-create-title-input" aria-label="任务标题" value={draft.title} maxLength={240} disabled={disabled} placeholder="不填写则按描述自动生成" onChange={event => edit({ title: event.currentTarget.value.replace(/\n/g, "") })}/></Form.Item>
      <div className="task-board-create-properties">
        <AgentField label="项目目录"><WandSelect ariaLabel="指定项目目录" value={issueWorkspaceSelectValue(draft.workspaceId)} options={issueWorkspaceOptions(workspaces)} searchable searchPlaceholder="搜索项目" disabled={disabled}
          onValueChange={value => { const id = issueWorkspaceIdFromSelect(value) || ""; const next = workspaces.find(item => item.id === id); edit({ workspaceId: id, cwd: next?.cwd || "", ...(id === draft.workspaceId ? {} : { parentTaskId: "", milestoneId: workspaceMilestone(id) }) }); }}/></AgentField>
        <AgentField label="父任务"><WandSelect ariaLabel="归属父任务" value={draft.parentTaskId || ISSUE_NO_PARENT} options={issueParentOptions(tasks, draft.workspaceId || undefined, null, draft.parentTaskId)} searchable searchPlaceholder="搜索主任务编号或标题" disabled={disabled}
          onValueChange={value => { const parent = tasks.find(item => item.id === value); const next = workspaces.find(item => item.id === parent?.workspaceId); edit({ parentTaskId: parent?.id || "", ...(parent ? { workspaceId: parent.workspaceId || "", cwd: next?.cwd || draft.cwd, milestoneId: parent.milestoneId || (parent.workspaceId === draft.workspaceId ? draft.milestoneId : workspaceMilestone(parent.workspaceId || "")) } : {}) }); }}/></AgentField>
        <AgentField label="任务状态"><WandSelect ariaLabel="状态" value={draft.status} options={ISSUE_COLUMNS.map(item => ({ value: item.status, label: item.label }))} disabled={disabled} onValueChange={status => edit({ status: status as WandTaskStatus })}/></AgentField>
        <AgentField label="优先级"><WandSelect ariaLabel="优先级" value={draft.priority} options={ISSUE_PRIORITIES.map(item => ({ value: item.value, label: item.label }))} disabled={disabled} onValueChange={priority => edit({ priority: priority as WandTaskPriority })}/></AgentField>
        <AgentField label="截止日期"><TaskDatePicker ariaLabel="截止日期" value={draft.dueDate} popupOwner="task-create-properties" disabled={disabled} onValueChange={dueDate => edit({ dueDate })}/></AgentField>
        <AgentField label="迭代"><MilestonePicker value={draft.milestoneId || null} workspaceId={draft.workspaceId || null} disabled={disabled} onChange={milestoneId => edit({ milestoneId: milestoneId || "" })}/></AgentField>
        <AgentField label="标签"><WandInput aria-label="任务标签" value={draft.labels} placeholder="用逗号分隔" disabled={disabled} onChange={event => edit({ labels: event.currentTarget.value })}/></AgentField>
      </div>
      <WandSwitch checked={createMore} onCheckedChange={setCreateMore} ariaLabel="创建更多" label="创建后继续创建" disabled={disabled}/>
    </Flex>
  </Form></PopupOwnerProvider>;
  const subjects = <PopupOwnerProvider owner="task-create-subject"><Form layout="vertical" component={false}><Flex vertical gap={12} className="new-work-subject task-board-create-assign-controls">
    <Typography.Text strong>执行对象</Typography.Text>
    <AgentFields agent={draft.agent} catalog={catalog} providerOptions={providerOptions} ariaPrefix="任务" disabled={disabled}
      teams={teams} teamId={draft.subject.type === "team" ? draft.subject.id : ""} employees={employees} employeeId={draft.subject.type === "employee" ? draft.subject.id : ""} employeeOverride={draft.employeeOverride}
      onTeamChange={() => {}} onEmployeeChange={() => {}}
      onChange={(agent, subject, override) => { edit({ agent, subject: subject || draft.subject, employeeOverride: override === true }); }}/>
    {draft.subject.type === "cli" ? <>
      {draft.agent.mode === "full-access" ? <Alert type="warning" className="task-board-create-permission-note" title="完全访问：工具会自动确认权限请求。"/> : null}
      <WandSwitch checked={rememberDefaults} onCheckedChange={setRememberDefaults} ariaLabel="同时设为以后默认" label="同时设为以后默认" disabled={disabled}/>
      <Typography.Text type="secondary">创建成功后生效；不改变已有任务或会话。</Typography.Text>
    </> : null}
  </Flex></Form></PopupOwnerProvider>;
  return <section className="new-work-page conversation-root task-create-page" aria-label="新建工作">
    <div className="new-work-context">
      <NewWorkIntent task options={{ ...options, initialKind: options.initialKind || undefined, initialCwd: draft.cwd, workspaceId: draft.workspaceId,
        initialEmployeeId: draft.subject.type === "employee" ? draft.subject.id : "", taskDraft: { ...options.taskDraft,
          draftKey: composerKey, scope, title: draft.title, description: textDraft.text, workspaceId: draft.workspaceId,
          status: draft.status, priority: draft.priority, parentTaskId: draft.parentTaskId, milestoneId: draft.milestoneId,
          executionSubject: taskCreationRequest(draft, textDraft.text, false).executionSubject, agent: draft.agent } }} disabled={disabled}/>
      <h1>
        今天你想与
        <WandPopover ariaLabel="选择新工作员工" popupOwner="task-create-subject" side="bottom" open={titleSubjectOpen} onOpenChange={setTitleSubjectOpen}
          trigger={<button type="button" disabled={disabled} className="new-work-inline-trigger new-work-inline-avatar"
            title={`当前：${subjectLabel}，点击更换`} aria-label={`选择员工：当前为 ${subjectLabel}`}>
            {employee ? <EmployeeAvatar employee={employee} size="sm"/> : <span className="new-work-inline-avatar-fallback"><WandIcon name="spark"/></span>}
            <WandIcon name="chevronDown" size={12} className="new-work-inline-arrow"/>
          </button>}>
          {subjects}
        </WandPopover>
        在
        <WandPopover ariaLabel="选择新工作运行目录" side="bottom" open={titleDirectoryOpen} onOpenChange={setTitleDirectoryOpen}
          trigger={<button type="button" disabled={disabled} className="new-work-inline-trigger new-work-inline-directory"
            title={draft.cwd} aria-label={`选择运行目录：当前为 ${directoryLabel}`}>
            <span>{directoryLabel}</span><WandIcon name="chevronDown" size={12} className="new-work-inline-arrow"/>
          </button>}>
          {directoryPickerContent}
        </WandPopover>
        的
        <WandPopover ariaLabel="编辑新任务" popupOwner="task-create-properties" side="bottom" open={titlePropertiesOpen} onOpenChange={setTitlePropertiesOpen}
          trigger={<button type="button" disabled={disabled} className="new-work-inline-trigger new-work-inline-task"
            title={`任务标题：${draft.title || "新任务"}，点击编辑`} aria-label="任务标题">
            <WandIcon name="clipboard" size={14} className="new-work-inline-task-icon"/>
            <span className="new-work-inline-task-name">{draft.title || "新任务"}</span>
            <WandIcon name="chevronDown" size={12} className="new-work-inline-arrow"/>
          </button>}>
          {properties}
        </WandPopover>
        中创造些什么？
      </h1>
    </div>
    <div className="conversation-composer new-work-composer">
      <div className="new-work-context-bar">
        <div className="new-work-location"><WandPopover ariaLabel="新工作运行目录" side="top" open={directoryOpen} onOpenChange={setDirectoryOpen} trigger={<WandButton kind="ghost" disabled={disabled} className="new-work-directory" title={draft.cwd}><WandIcon name="folder"/><span>{directoryLabel}</span><WandIcon name="chevronDown" size={12}/></WandButton>}>
          {directoryPickerContent}
        </WandPopover></div>
        <WandPopover ariaLabel="新工作执行对象" popupOwner="task-create-subject" side="top" open={subjectOpen} onOpenChange={setSubjectOpen} trigger={<WandButton kind="ghost" disabled={disabled} className="new-work-person"><WandIcon name="spark"/><span className="new-work-person-name">{subjectLabel}</span><WandIcon name="chevronDown" size={14}/></WandButton>}>{subjects}</WandPopover>
        <WandPopover ariaLabel="任务属性" popupOwner="task-create-properties" side="top" open={propertiesOpen} onOpenChange={setPropertiesOpen} trigger={<WandButton kind="ghost" disabled={disabled} aria-label="任务属性"><WandIcon name="gear"/>属性</WandButton>}>{properties}</WandPopover>
      </div>
      {employeesError ? <Alert type="warning" title={employeesError}/> : null}
      {error ? <Alert type="error" role="alert" title={error}/> : null}
      {unknown ? <Alert type="warning" role="status" title={unknown}/> : null}
      {textDraft.attachments.length ? <Alert type="info" title="附件保留在开始工作中；任务计划只保存文字。"/> : null}
      {accepted ? <WandButton onClick={() => openCreated(accepted)}>打开已创建的任务</WandButton> : null}
      {acceptedWork ? <Alert type="info" title="此草稿已创建工作，请回到开始工作打开已有会话。" action={<WandButton onClick={() => newSessionController.open({ ...options, initialKind: options.initialKind || undefined, newTask: false, taskDraft: { ...options.taskDraft, draftKey: composerKey } })}>打开已创建的工作</WandButton>}/> : null}
      <NewWorkComposer ref={sender} expanded={editor.expanded} text={textDraft.text} onTextChange={text => { teamChatComposer.edit(composerKey, { text }); }} disabled={disabled}
        placeholder="随心输入，描述你想完成的事…" ariaLabel="任务描述" onSubmit={() => void submit()}
        header={textDraft.attachments.length ? <ComposerAttachmentList items={textDraft.attachments.map((item, index) => ({ index, name: item.name, sizeLabel: `${item.size} B`, previewUrl: item.previewUrl || null }))}
          onRemove={index => { if (!disabled) teamChatComposer.edit(composerKey, { removeAttachment: index }); }}/> : null}
        footer={<Flex justify="space-between" align="center" wrap gap={8} className="conversation-action-row task-board-create-footer">
          <Flex align="center" gap={8}><WandSwitch checked={saveAndDispatch} onCheckedChange={setSaveAndDispatch} ariaLabel="保存并派发" disabled={disabled}/><Typography.Text>{saveAndDispatch ? "创建并开始执行" : "仅创建任务"}</Typography.Text><span className="composer-edit-action">{editor.control}</span></Flex>
          <ConversationSubmitButton stops={false} phase={busy ? "sending" : unknown ? "unknown" : error ? "failed" : "idle"} label={label}
            disabled={disabled || !!textDraft.attachments.length || (!draft.title.trim() && !textDraft.text.trim()) || (saveAndDispatch && !textDraft.text.trim())}
            disabledReason={unknown || (textDraft.attachments.length ? "请回开始工作发送附件，或先移除附件。" : !draft.title.trim() && !textDraft.text.trim() ? "请填写任务标题或描述。" : "请填写本次交付目标。")}
            onClick={() => void submit()}/>
        </Flex>}/>
    </div>
  </section>;
}
