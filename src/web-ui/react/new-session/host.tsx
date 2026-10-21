import * as React from "react";
import { NewSessionHeader, NewSessionHeaderProvided } from "./header";
import { Sender } from "@ant-design/x";
import { Alert, AutoComplete, Flex, Spin, Typography } from "antd";
import { DEFAULT_EMPLOYEE_ID } from "../../../ai-team-types.js";
import { normalizeWandTaskAgentMode, type WandTaskAgent } from "../../../task-types.js";
import { agentToolDisplayName } from "../../provider-identity.js";
import { useSiliconEmployees } from "../agents/employee-repository";
import { EmployeeAvatar } from "../agents/employee-avatar";
import { teamChatComposer } from "../ai-teams/composer-bridge";
import { aiTeamPickerOption, aiTeamsRepository, useAiTeamList } from "../ai-teams/repository";
import { taskBoardController } from "../issues/task-board-controller";
import { ConversationExecutionSelectors } from "../conversations/execution-preference";
import type { ConversationExecutionPreference } from "../../../conversation-execution-preference.js";
import { ConversationMorphIcon, ConversationSubmitButton } from "../conversations/controls";
import { conversationDraftKey } from "../conversations/state";
import { useEditorExpansion } from "../composer-sender/editor-expansion";
import { ComposerAttachmentList } from "../composer-attachments/host";
import { UnifiedExecutionSubjectPicker } from "../workspaces/unified-execution-subject-picker";
import { httpWorkspacesRepository } from "../workspaces/repository";
import { usableTeamWorkspaceId } from "../workspaces/workspace-agent-model";
import type { Workspace } from "../workspaces/types";
import { notifyTasksChanged } from "../task-changes";
import { WandButton, WandInput, WandIcon, WandIconButton, WandPopover, WandTabs } from "../ui";
import { useWandModelCatalog } from "../use-model-catalog";
import { installChatComposerStyles } from "../chat-composer-styles";
import { installConversationHomeStyles } from "../conversations/home-styles";
import { describeError } from "../errors";
import { newSessionController, newSessionStore } from "./controller";
import { buildCreateRequest, httpNewSessionRepository, safeMode } from "./repository";
import { resolveNewSessionTask } from "./task-creation";
import { NewSessionTaskField } from "./task-field";
import type { NewSessionCreated, NewSessionCreateRequest, NewSessionDefaults, NewSessionForm, NewSessionKind, NewSessionRepository } from "./types";
import { installNewWorkStyles } from "./start-styles";
import { hasAutomaticPermissions, modeHint } from "./permission-summary";

export interface NewSessionHostProps { repository?: NewSessionRepository; }

/** All creation entry points project one pending work; resource creation starts only on submit. */
export function NewSessionHost(props: NewSessionHostProps): React.ReactElement | null {
  const controller = React.useSyncExternalStore(newSessionStore.subscribe, newSessionStore.getSnapshot, newSessionStore.getSnapshot);
  const ready = React.useSyncExternalStore(teamChatComposer.subscribeReady, teamChatComposer.ready, () => false);
  const headerProvided = React.useContext(NewSessionHeaderProvided);
  return controller.open ? <>{!headerProvided && <NewSessionHeader/>}{ready ? <NewWorkPage key={controller.revision} {...props}/> : <Flex align="center" justify="center" flex={1} role="status"><Spin/><span>正在准备输入服务…</span></Flex>}</> : null;
}

function NewWorkPage({ repository = httpNewSessionRepository }: NewSessionHostProps): React.ReactElement {
  const controller = newSessionStore.getSnapshot();
  const [defaults, setDefaults] = React.useState<NewSessionDefaults | null>(null);
  const [form, setForm] = React.useState<NewSessionForm | null>(null);
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [submitting, setSubmitting] = React.useState(false);
  const [unknown, setUnknown] = React.useState(() => newSessionController.getUnknownCreation(controller.workspaceTaskId || controller.workspaceId || "standalone")?.message || "");
  const accepted = React.useRef<{ request: NewSessionCreateRequest; created: NewSessionCreated } | null>(null);
  const lock = React.useRef(false);
  const mounted = React.useRef(true);
  const [directoryOpen, setDirectoryOpen] = React.useState(false);
  const [subjectOpen, setSubjectOpen] = React.useState(false);
  const [titleDirectoryOpen, setTitleDirectoryOpen] = React.useState(false);
  const [titleSubjectOpen, setTitleSubjectOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [suggestions, setSuggestions] = React.useState<readonly { path: string; name: string }[]>([]);
  const sender = React.useRef<React.ComponentRef<typeof Sender>>(null);
  const files = React.useRef<HTMLInputElement>(null);
  const { employees, loading: employeesLoading, error: employeesError } = useSiliconEmployees({ enabled: true });
  const teams = useAiTeamList(!controller.workspaceTaskId && !controller.newTask);
  const [projects, setProjects] = React.useState<Workspace[]>([]);
  React.useEffect(() => {
    let active = true;
    void httpWorkspacesRepository.list().then(items => { if (active) setProjects(items); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const catalog = useWandModelCatalog(true);
  // 新建工作每次打开都是新实例（按 revision 重挂载），临时执行配置随实例丢弃，不跨打开或跨界面共用。
  const [preference, setPreference] = React.useState<ConversationExecutionPreference | undefined>(undefined);
  const key = conversationDraftKey(`new-work:${controller.workspaceTaskId || controller.workspaceId || "standalone"}`, null);
  const revision = React.useCallback(() => teamChatComposer.revision(key), [key]);
  React.useSyncExternalStore(teamChatComposer.subscribe, revision, revision);
  const draft = teamChatComposer.read(key);
  const editor = useEditorExpansion(key, () => sender.current?.inputElement as HTMLTextAreaElement | null);
  React.useLayoutEffect(() => { installChatComposerStyles(); installConversationHomeStyles(); installNewWorkStyles(); }, []);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  React.useEffect(() => {
    const abort = new AbortController();
    void repository.load({ signal: abort.signal }).then(loaded => {
      if (abort.signal.aborted) return;
      setDefaults(loaded);
      const context = newSessionStore.getRuntime()?.getContext();
      setForm({ provider: loaded.config.defaultProvider, engine: loaded.config.defaultEngine, model: "default",
        kind: controller.initialKind || "structured", employeeId: controller.initialEmployeeId || undefined,
        mode: safeMode(loaded.config.defaultProvider, loaded.config.defaultMode),
        cwd: controller.initialCwd || context?.effectiveCwd || loaded.config.defaultCwd, worktreeEnabled: false,
        workspaceId: controller.workspaceId || undefined, workspaceTaskId: controller.workspaceTaskId || undefined,
        taskName: controller.newTask ? "" : undefined });
    }).catch(cause => { if (!abort.signal.aborted) setError(describeError(cause, "配置读取失败，请重新打开新建。")); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [repository]);
  // Wait for the real directory, then use the default companion only when no entry selected an identity.
  React.useEffect(() => {
    if (!form || employeesLoading || form.kind !== "structured" || form.employeeId || form.teamId) return;
    const employee = employees.find(item => item.id === DEFAULT_EMPLOYEE_ID) ?? employees[0];
    if (employee) setForm(current => current ? { ...current, employeeId: employee.id } : current);
  }, [!!form, employeesLoading]);
  React.useEffect(() => {
    if ((!directoryOpen && !titleDirectoryOpen) || !form) return;
    const abort = new AbortController();
    const timeout = window.setTimeout(() => {
      void repository.suggestPaths(form.cwd, { signal: abort.signal }).then(items => { if (!abort.signal.aborted) setSuggestions(items); }).catch(() => {});
    }, 120);
    return () => { abort.abort(); clearTimeout(timeout); };
  }, [directoryOpen, titleDirectoryOpen, form?.cwd, repository]);
  const employee = employees.find(item => item.id === form?.employeeId);
  const team = teams?.find(item => item.id === form?.teamId);
  const matchedProject = projects.find(project => project.cwd.replace(/\/+$/, "") === form?.cwd.trim().replace(/\/+$/, ""));
  const teamWorkspaceId = controller.workspaceTaskId || controller.newTask ? "" : usableTeamWorkspaceId(form?.workspaceId || matchedProject?.id, matchedProject?.kind);
  const base: WandTaskAgent | undefined = employee?.agents[0] ?? (form ? { provider: form.provider, engine: form.engine,
    model: form.model || "default", thinkingEffort: "off", mode: normalizeWandTaskAgentMode(form.provider, form.mode), kind: "structured" } : undefined);
  const runtimeAgent = base && preference ? { ...base, ...preference } : base;
  const disabled = submitting || !!unknown || !!accepted.current;
  const executionForm = form && preference && form.kind !== "shell" ? {
    ...form,
    provider: preference.provider,
    engine: form.kind === "pty" ? "cli" as const : preference.engine,
    model: preference.model,
    mode: normalizeWandTaskAgentMode(preference.provider, base?.mode || form.mode),
    specifiedCli: true,
  } : form;
  const permission = executionForm && { ...executionForm,
    provider: executionForm.specifiedCli || !employee ? executionForm.provider : runtimeAgent?.provider || executionForm.provider,
    engine: executionForm.specifiedCli || !employee ? executionForm.engine : runtimeAgent?.engine || executionForm.engine,
    mode: safeMode(executionForm.specifiedCli || !employee ? executionForm.provider : runtimeAgent?.provider || executionForm.provider,
      executionForm.specifiedCli || !employee ? executionForm.mode : runtimeAgent?.mode || executionForm.mode) };
  const invalidReason = !form || !defaults ? "工作配置未就绪，请重新打开新建。"
    : !form.cwd.trim() ? "请先选择运行目录。"
    : form.taskName !== undefined && !form.taskName.trim() ? "请先输入任务名称，或选择默认任务。"
    : form.kind === "structured" && !draft.text.trim() && !draft.attachments.length ? "请输入工作内容或添加附件。"
    : form.kind === "structured" && form.employeeId && !employee ? "当前员工不可用，请重新选择员工或执行工具。"
    : form.kind === "structured" && employee && !employee.agents.length ? "当前员工没有执行配置，请更换员工或配置候选工具。"
    : form.kind === "structured" && !employee && !team && !form.specifiedCli ? "请先选择员工、团队或执行工具。"
    : form.teamId && !teamWorkspaceId ? "团队工作需要已有项目，请更换运行目录。"
    : form.teamId && draft.attachments.length ? "团队工作暂不支持附件，请先移除附件。" : "";
  const valid = !invalidReason;
  const submitStatus = unknown || (accepted.current ? "工作已创建，请打开已创建的工作；不要重复提交。" : "")
    || (submitting ? "正在创建工作，请勿重复提交。" : "");
  const submitReason = submitStatus || invalidReason;
  const submitStatusId = React.useId();
  const chooseKind = (kind: NewSessionKind): void => {
    setSubjectOpen(false); setDirectoryOpen(false); setSettingsOpen(false); setMoreOpen(false);
    setTitleSubjectOpen(false); setTitleDirectoryOpen(false);
    setForm(current => current ? { ...current, kind, teamId: undefined,
      employeeId: kind === "structured" ? employee?.id || employees.find(item => item.id === DEFAULT_EMPLOYEE_ID)?.id || employees[0]?.id : undefined,
      mode: current.mode === "full-access" ? "default" : current.mode,
      engine: kind === "pty" ? "cli" : current.engine } : current);
  };
  const markUnconfirmedCreation = (cause: unknown): void => {
    const status = (cause as { status?: number })?.status;
    if (status && status < 500 && status !== 408 && status !== 409) return;
    const message = "创建结果未确认，请先核对任务和会话列表，不要重复创建；本页输入保留。";
    newSessionController.markUnknownCreation({ scope: controller.workspaceTaskId || controller.workspaceId || "standalone", message });
    // Unlike ordinary empty-session creation, a team start includes the note.
    // It may already be executing: preserve it only in the owning page's memory.
    if (form?.teamId) teamChatComposer.edit(key, { text: draft.text, expectedRevision: draft.revision, persist: false });
    setUnknown(message);
  };
  const submit = async (): Promise<void> => {
    const scope = controller.workspaceTaskId || controller.workspaceId || "standalone";
    const unresolved = newSessionController.getUnknownCreation(scope);
    if (unresolved) { setUnknown(unresolved.message); return; }
    if (!form || !defaults || lock.current || !!unknown || !valid) return;
    const runtime = newSessionStore.getRuntime();
    if (!runtime) { setError("运行环境未就绪，请刷新页面后重试；草稿保留。"); return; }
    lock.current = true; setSubmitting(true); setError(""); setSubjectOpen(false); setDirectoryOpen(false); setSettingsOpen(false); setMoreOpen(false);
    setTitleSubjectOpen(false); setTitleDirectoryOpen(false);
    newSessionController.setDismissable(false);
    try {
      if (form.teamId) {
        if (draft.attachments.length) throw new Error("团队新工作暂不支持附件，请先移除附件后开工。");
        if (!teamWorkspaceId) throw new Error("团队工作需要已存在的项目，请更换运行目录后重试。");
        const result = await aiTeamsRepository.startDirect(form.teamId, { workspaceId: teamWorkspaceId, note: draft.text })
          .then(result => {
            if (!result?.run?.id) throw new Error("服务端未返回团队运行 ID。");
            return result;
          }).catch(cause => { markUnconfirmedCreation(cause); throw cause; });
        await aiTeamsRepository.settle("success");
        teamChatComposer.edit(key, { acknowledgeRevision: draft.revision });
        newSessionController.close();
        if (result.run.chatSessionId) taskBoardController.open("", "", "teamchat", result.run.id);
        else taskBoardController.open("", "", "teams");
        notifyTasksChanged(); return;
      }
      const bound = await resolveNewSessionTask(form, form.cwd, httpWorkspacesRepository);
      if (bound !== form) { setForm(bound); notifyTasksChanged(); }
      if (!accepted.current) {
        const manual = preference && bound.kind !== "shell";
        const selected = manual ? { ...bound, provider: executionForm!.provider, engine: executionForm!.engine,
          model: executionForm!.model, mode: executionForm!.mode, specifiedCli: true } : bound;
        const context = { ...runtime.getContext(), thinkingEffort: manual ? preference.thinkingEffort : base?.thinkingEffort || "off" };
        const request = buildCreateRequest(selected, defaults.config, context);
        const dimensions = await runtime.prepareCreate(request.kind, request);
        if (request.kind !== "structured") Object.assign(request, dimensions);
        let created: NewSessionCreated;
        try { created = await repository.create(request); }
        catch (cause) {
          markUnconfirmedCreation(cause);
          throw cause;
        }
        accepted.current = { request, created };
      }
      const { request, created } = accepted.current;
      await runtime.completeCreate(request, created, draft.text || draft.attachments.length ? { key, revision: draft.revision } : undefined);
      newSessionController.close();
    } catch (cause) {
      if (form.teamId) await aiTeamsRepository.settle("error");
      if (mounted.current) setError(describeError(cause, "创建未完成，输入已保留。"));
    } finally {
      lock.current = false; newSessionController.setDismissable(true);
      if (mounted.current) setSubmitting(false);
    }
  };
  const placeholder = form?.kind === "shell" ? "输入启动后要执行的命令（可选）…" : form?.kind === "pty" ? "输入要交给 CLI 的内容（可选）…" : "随心输入，描述你想完成的事…";
  const projectName = matchedProject?.name || form?.cwd.trim().split("/").filter(Boolean).at(-1) || "Wand";
  const permissionLabel = permission?.kind === "shell" ? "系统 Shell" : ({ managed: "托管执行", "full-access": "完全访问", "auto-edit": "自动编辑", native: "原生模式", default: "标准权限" } as const)[permission?.mode || "default"];

  const directoryPickerContent = defaults && form ? (
    <Flex vertical gap={12} className="new-work-paths"><Typography.Text strong>运行目录</Typography.Text>
      <AutoComplete value={form.cwd} options={suggestions.map(item => ({ value: item.path }))} onChange={cwd => setForm({ ...form, cwd, workspaceId: undefined })}>
        <WandInput autoFocus aria-label="新工作运行目录路径" placeholder="输入目录路径" onKeyDown={event => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            setDirectoryOpen(false);
            setTitleDirectoryOpen(false);
          }
        }}/>
      </AutoComplete>
      {defaults.recentPaths.map(item => <WandButton key={item.path} kind="ghost" title={item.path} onClick={() => {
        setForm({ ...form, cwd: item.path, workspaceId: undefined });
        setDirectoryOpen(false);
        setTitleDirectoryOpen(false);
      }}>{item.path}</WandButton>)}
      <WandButton onClick={() => { setDirectoryOpen(false); setTitleDirectoryOpen(false); }}>完成</WandButton>
    </Flex>
  ) : null;

  const subjectPickerContent = (
    <div className="new-work-subject"><UnifiedExecutionSubjectPicker selectedSubject={form?.teamId ? { type: "team", id: form.teamId } : form?.specifiedCli && !form.employeeId ? { type: "cli", id: form.provider, engine: form.engine } : { type: "employee", id: form?.employeeId || "" }}
      kind="structured" model="default" showKind={false} showModel={false} teams={teams?.map(aiTeamPickerOption)} teamWorkspaceId={teamWorkspaceId}
      onKindChange={chooseKind} onModelChange={() => {}} onSubjectChange={subject => {
        if (subject.type !== "cli") setPreference(undefined);
        if (subject.type === "cli" && subject.id !== "shell") setPreference({
          provider: subject.id as WandTaskAgent["provider"], engine: subject.engine, model: "default", thinkingEffort: "off",
        });
        setForm(current => current ? subject.type === "employee" ? { ...current, employeeId: subject.id, teamId: undefined, specifiedCli: false }
          : subject.type === "team" ? { ...current, teamId: subject.id, employeeId: undefined, specifiedCli: false }
          : { ...current, employeeId: undefined, teamId: undefined, specifiedCli: true, kind: subject.id === "shell" ? "shell" : current.kind,
            provider: subject.id === "shell" ? current.provider : subject.id as NewSessionForm["provider"], engine: subject.engine,
            mode: current.mode === "full-access" ? "default" : current.mode } : current);
        setSubjectOpen(false);
        setTitleSubjectOpen(false);
      }}/></div>
  );

  return <section className="new-work-page conversation-root" aria-label="新建工作">
    {loading || employeesLoading ? <Flex align="center" justify="center" flex={1}><Spin/><span>正在读取工作配置…</span></Flex> : form && defaults ? <>
      <div className="new-work-context">
        <h1>{form.kind === "structured" ? <>
          今天你想与
          <WandPopover ariaLabel="选择新工作员工" side="bottom" open={titleSubjectOpen} onOpenChange={setTitleSubjectOpen}
            trigger={<button type="button" disabled={disabled} className="new-work-inline-trigger new-work-inline-avatar"
              title={`当前：${employee?.name || team?.name || "选择员工"}，点击更换`}
              aria-label={`选择员工：当前为 ${employee?.name || team?.name || "默认伙伴"}`}>
              {employee ? <EmployeeAvatar employee={employee} size="sm"/> : <span className="new-work-inline-avatar-fallback"><WandIcon name="spark"/></span>}
              <WandIcon name="chevronDown" size={12} className="new-work-inline-arrow"/>
            </button>}>
            {subjectPickerContent}
          </WandPopover>
          在
          <WandPopover ariaLabel="选择新工作运行目录" side="bottom" open={titleDirectoryOpen} onOpenChange={setTitleDirectoryOpen}
            trigger={<button type="button" disabled={disabled || !!form.workspaceTaskId} className="new-work-inline-trigger new-work-inline-directory"
              title={form.cwd} aria-label={`选择运行目录：当前为 ${projectName}`}>
              <span>{projectName}</span>
              <WandIcon name="chevronDown" size={12} className="new-work-inline-arrow"/>
            </button>}>
            {directoryPickerContent}
          </WandPopover>
          的
          <NewSessionTaskField form={form} initialName={controller.taskName} disabled={disabled || !!controller.workspaceTaskId} cwd={form.cwd} onChange={setForm} inline/>
          中创造些什么？
        </> : form.kind === "pty" ? "从这里开始 CLI 工作" : "从这里打开空白终端"}</h1>
        {controller.workspaceTaskId ? <Typography.Text type="secondary">当前任务使用既有工作目录</Typography.Text> : null}
        {form.kind !== "structured" ? <NewSessionTaskField form={form} initialName={controller.taskName} disabled={disabled || !!controller.workspaceTaskId} cwd={form.cwd} onChange={setForm}/> : null}
      </div>
      <div className="conversation-composer new-work-composer">
        {submitStatus ? <Flex vertical gap={4} className="new-work-submit-status" id={submitStatusId}>
          <Typography.Text type={unknown ? "warning" : "secondary"} role="status">{submitStatus}</Typography.Text>
        </Flex> : null}
        <div className="new-work-context-bar">
          <div className="new-work-location">
          <WandPopover ariaLabel="新工作运行目录" side="top" open={directoryOpen} onOpenChange={setDirectoryOpen}
            trigger={<WandButton kind="ghost" disabled={disabled || !!form.workspaceTaskId} className="new-work-directory" title={form.cwd}><WandIcon name="folder"/><span>{projectName}</span><WandIcon name="chevronDown" size={12}/></WandButton>}>
            {directoryPickerContent}
          </WandPopover>
          </div>
          {form.kind === "structured" ? <><WandPopover ariaLabel="新工作执行对象" side="top" open={subjectOpen} onOpenChange={setSubjectOpen}
            trigger={<WandButton kind="ghost" disabled={disabled} className="new-work-person">{employee ? <EmployeeAvatar employee={employee} size="sm"/> : <WandIcon name="spark"/>}<span className="new-work-person-name" title={employee?.name || team?.name}>{employee?.name || team?.name || (form.specifiedCli ? agentToolDisplayName(form.provider, form.engine) : "选择员工")}</span><WandIcon name="chevronDown" size={14}/></WandButton>}>
            {subjectPickerContent}
          </WandPopover></> : null}
          <WandPopover ariaLabel="新工作界面设置" side="top" open={settingsOpen} onOpenChange={setSettingsOpen} trigger={<WandIconButton aria-label="新工作设置" disabled={disabled}><WandIcon name="gear"/></WandIconButton>}>
            <Flex vertical gap={12}><Typography.Text strong>工作类型</Typography.Text>
              <WandTabs ariaLabel="工作类型" value={form.kind} onValueChange={value => chooseKind(value as NewSessionKind)}
                tabs={[{ value: "structured", label: "对话", content: null, disabled }, { value: "pty", label: "CLI 终端", content: null, disabled }, { value: "shell", label: "空白终端", content: null, disabled }]}/>
            </Flex>
          </WandPopover>
        </div>
        {employeesError ? <Alert type="error" title={employeesError}/> : null}
        {error ? <Alert type="error" role="alert" title={error}/>: null}
        {accepted.current && error ? <WandButton onClick={() => {
          const captured = accepted.current!;
          void newSessionStore.getRuntime()?.completeCreate(captured.request, captured.created).then(() => newSessionController.close())
            .catch(cause => setError(describeError(cause, "打开工作失败，请从会话列表重试。")));
        }}>打开已创建的工作（本页草稿保留）</WandButton> : null}
        <div className="conversation-input-wrap" data-composer-expanded="true" data-editor-expanded={editor.expanded}>
          <Sender ref={sender} className="conversation-sender" value={draft.text} readOnly={disabled} placeholder={placeholder} suffix={false}
            autoSize={{ minRows: 2, maxRows: editor.expanded ? 24 : 4 }} onChange={text => teamChatComposer.edit(key, { text })} onSubmit={() => void submit()}
            submitType="enter"
            onKeyDown={event => {
              // suffix 关掉后，发送器内部的提交开关不会随输入更新，默认回车会被吃掉。
              // 这里自己提交；中文输入法确认候选、Shift 换行都不算开工。
              if (event.nativeEvent.isComposing || event.keyCode === 229) return false;
              if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return undefined;
              event.preventDefault();
              void submit();
              return false;
            }}
            header={draft.attachments.length ? <ComposerAttachmentList items={draft.attachments.map((item, index) => ({ index, name: item.name, sizeLabel: `${item.size} B`, previewUrl: item.previewUrl || null }))} onRemove={index => teamChatComposer.edit(key, { removeAttachment: index })}/> : null}
            footer={<Flex justify="space-between" align="center" className="conversation-action-row"><Flex gap={4} align="center" className="new-work-actions">
              <WandPopover ariaLabel="新工作更多选项" side="top" open={moreOpen} onOpenChange={setMoreOpen} trigger={<WandIconButton aria-label="更多新工作选项" disabled={disabled}><ConversationMorphIcon active={moreOpen} from="plus" to="close"/></WandIconButton>}>
                <Flex vertical gap={12}>
                  <WandButton disabled={disabled || form.kind === "shell"} onClick={() => { setMoreOpen(false); files.current?.click(); }}><WandIcon name="paperclip"/>添加附件</WandButton>
                  {permission ? <Typography.Text type="secondary">{modeHint(permission)}</Typography.Text> : null}
                  {preference ? <WandButton disabled={disabled} onClick={() => { setPreference(undefined); setMoreOpen(false); }}>恢复员工默认执行配置</WandButton> : null}
                </Flex>
              </WandPopover>
              <span className="new-work-permission" data-automatic={!form.teamId && permission && hasAutomaticPermissions(permission)} title={form.teamId ? "团队成员分别使用各自的执行配置" : permission ? modeHint(permission) : undefined}><WandIcon name="shield" size={14}/>{form.teamId ? "团队配置" : permissionLabel}</span>
              <span className="composer-edit-action">{editor.control}</span>
            </Flex><Flex gap={4} align="center" className="new-work-send-actions">
            {form.kind !== "shell" && runtimeAgent && !form.teamId ? <div className="conversation-runtime-summary"><ConversationExecutionSelectors agent={form.kind === "pty" ? { ...runtimeAgent, engine: "cli" } : runtimeAgent} catalog={catalog} disabled={disabled} cliOnly={form.kind === "pty"} onChange={setPreference}/></div> : null}
            <ConversationSubmitButton stops={false} phase={submitting ? "sending" : error ? "failed" : "idle"} label={form.kind === "structured" ? "开始工作" : "打开终端"} disabled={disabled || !valid} disabledReason={submitReason} descriptionId={submitStatus ? submitStatusId : undefined} onClick={() => void submit()}/></Flex></Flex>}/>
        </div>
        <input ref={files} hidden type="file" multiple onChange={event => {
          for (const file of Array.from(event.currentTarget.files || [])) teamChatComposer.edit(key, { addAttachment: { file, name: file.name, size: file.size } });
          event.currentTarget.value = "";
        }}/>
      </div>
    </> : <Alert type="error" title={error || "配置未就绪，请重新打开新建。"}/ >}
  </section>;
}
