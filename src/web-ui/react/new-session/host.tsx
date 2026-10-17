import * as React from "react";
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
import { WandBrandMark } from "../ui/brand-mark";
import { useEditorExpansion } from "../composer-sender/editor-expansion";
import { ComposerAttachmentList } from "../composer-attachments/host";
import { ComposerSpeechButton } from "../composer-voice/button";
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
  return controller.open ? ready ? <NewWorkPage key={controller.revision} {...props}/> : <Spin tip="正在准备输入服务…"/> : null;
}

function NewWorkPage({ repository = httpNewSessionRepository }: NewSessionHostProps): React.ReactElement {
  const controller = newSessionStore.getSnapshot();
  const [defaults, setDefaults] = React.useState<NewSessionDefaults | null>(null);
  const [form, setForm] = React.useState<NewSessionForm | null>(null);
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [submitting, setSubmitting] = React.useState(false);
  const [unknown, setUnknown] = React.useState(false);
  const accepted = React.useRef<{ request: NewSessionCreateRequest; created: NewSessionCreated } | null>(null);
  const lock = React.useRef(false);
  const mounted = React.useRef(true);
  const [directoryOpen, setDirectoryOpen] = React.useState(false);
  const [subjectOpen, setSubjectOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [voiceStatus, setVoiceStatus] = React.useState("");
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
    if (!directoryOpen || !form) return;
    const abort = new AbortController();
    const timeout = window.setTimeout(() => {
      void repository.suggestPaths(form.cwd, { signal: abort.signal }).then(items => { if (!abort.signal.aborted) setSuggestions(items); }).catch(() => {});
    }, 120);
    return () => { abort.abort(); clearTimeout(timeout); };
  }, [directoryOpen, form?.cwd, repository]);
  const employee = employees.find(item => item.id === form?.employeeId);
  const team = teams?.find(item => item.id === form?.teamId);
  const matchedProject = projects.find(project => project.cwd.replace(/\/+$/, "") === form?.cwd.trim().replace(/\/+$/, ""));
  const teamWorkspaceId = controller.workspaceTaskId || controller.newTask ? "" : usableTeamWorkspaceId(form?.workspaceId || matchedProject?.id, matchedProject?.kind);
  const base: WandTaskAgent | undefined = employee?.agents[0] ?? (form ? { provider: form.provider, engine: form.engine,
    model: form.model || "default", thinkingEffort: "off", mode: normalizeWandTaskAgentMode(form.provider, form.mode), kind: "structured" } : undefined);
  const runtimeAgent = base && preference ? { ...base, ...preference } : base;
  const disabled = submitting || unknown || !!accepted.current;
  const chooseKind = (kind: NewSessionKind): void => {
    setSubjectOpen(false); setDirectoryOpen(false); setSettingsOpen(false); setMoreOpen(false);
    setForm(current => current ? { ...current, kind, teamId: undefined,
      employeeId: kind === "structured" ? employee?.id || employees.find(item => item.id === DEFAULT_EMPLOYEE_ID)?.id || employees[0]?.id : undefined,
      engine: kind === "pty" ? "cli" : current.engine } : current);
  };
  const submit = async (): Promise<void> => {
    if (!form || !defaults || lock.current || unknown) return;
    if (form.kind === "structured" && !draft.text.trim() && !draft.attachments.length) return;
    const runtime = newSessionStore.getRuntime();
    if (!runtime) { setError("运行环境未就绪，请刷新页面后重试；草稿保留。"); return; }
    lock.current = true; setSubmitting(true); setError(""); setSubjectOpen(false); setDirectoryOpen(false); setSettingsOpen(false); setMoreOpen(false);
    newSessionController.setDismissable(false);
    try {
      if (form.teamId) {
        if (draft.attachments.length) throw new Error("团队新工作暂不支持附件，请先移除附件后开工。");
        if (!teamWorkspaceId) throw new Error("团队工作需要已存在的项目，请更换运行目录后重试。");
        const result = await aiTeamsRepository.startDirect(form.teamId, { workspaceId: teamWorkspaceId, note: draft.text });
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
        const selected = manual ? { ...bound, provider: preference.provider, engine: bound.kind === "pty" ? "cli" as const : preference.engine,
          model: preference.model, mode: normalizeWandTaskAgentMode(preference.provider, base?.mode || bound.mode), specifiedCli: true } : bound;
        const context = { ...runtime.getContext(), thinkingEffort: manual ? preference.thinkingEffort : base?.thinkingEffort || "off" };
        const request = buildCreateRequest(selected, defaults.config, context);
        const dimensions = await runtime.prepareCreate(request.kind, request);
        if (request.kind !== "structured") Object.assign(request, dimensions);
        let created: NewSessionCreated;
        try { created = await repository.create(request); }
        catch (cause) {
          const status = (cause as { status?: number }).status;
          if (!status || status >= 500 || status === 408 || status === 409) setUnknown(true);
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
  const permission = form && { ...form, provider: runtimeAgent?.provider || form.provider,
    engine: runtimeAgent?.engine || form.engine, mode: safeMode(runtimeAgent?.provider || form.provider, runtimeAgent?.mode || form.mode) };
  const permissionLabel = permission?.kind === "shell" ? "系统 Shell" : ({ managed: "托管执行", "full-access": "完全访问", "auto-edit": "自动编辑", native: "原生模式", default: "标准权限" } as const)[permission?.mode || "default"];
  return <section className="new-work-page conversation-root" aria-label="新建工作">
    <Flex align="center" justify="space-between" className="new-work-heading">
      <span className="new-work-page-label">{controller.taskName ? `新建工作 · ${controller.taskName}` : "新建会话"}</span>
      <WandButton kind="ghost" disabled={submitting} onClick={() => newSessionController.close()}>返回</WandButton>
    </Flex>
    {loading || employeesLoading ? <Flex align="center" justify="center" flex={1}><Spin/><span>正在读取工作配置…</span></Flex> : form && defaults ? <>
      <div className="new-work-context">
        <WandBrandMark style={{ width: 44, height: 44 }}/>
        <h1>{form.kind === "structured" ? <>你想让我们在 <span title={form.cwd}>{projectName}</span> 中完成什么？</> : form.kind === "pty" ? "从这里开始 CLI 工作" : "从这里打开空白终端"}</h1>
        {controller.workspaceTaskId ? <Typography.Text type="secondary">当前任务使用既有工作目录</Typography.Text> : null}
        {form.taskName !== undefined ? <NewSessionTaskField form={form} initialName={controller.taskName} disabled={disabled} cwd={form.cwd} onChange={setForm}/> : null}
      </div>
      <div className="conversation-composer new-work-composer">
        <div className="new-work-context-bar">
          <div className="new-work-location">
          <WandPopover ariaLabel="新工作运行目录" side="top" open={directoryOpen} onOpenChange={setDirectoryOpen}
            trigger={<WandButton kind="ghost" disabled={disabled || !!form.workspaceTaskId} className="new-work-directory" title={form.cwd}><WandIcon name="folder"/><span>{projectName}</span><WandIcon name="chevronDown" size={12}/></WandButton>}>
            <Flex vertical gap={12} className="new-work-paths"><Typography.Text strong>运行目录</Typography.Text>
              <AutoComplete value={form.cwd} options={suggestions.map(item => ({ value: item.path }))} onChange={cwd => setForm({ ...form, cwd, workspaceId: undefined })}>
                <WandInput autoFocus aria-label="新工作运行目录路径" placeholder="输入目录路径" onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); setDirectoryOpen(false); } }}/>
              </AutoComplete>
              {defaults.recentPaths.map(item => <WandButton key={item.path} kind="ghost" title={item.path} onClick={() => { setForm({ ...form, cwd: item.path, workspaceId: undefined }); setDirectoryOpen(false); }}>{item.path}</WandButton>)}
              <WandButton onClick={() => setDirectoryOpen(false)}>完成</WandButton>
            </Flex>
          </WandPopover>
          </div>
          {form.kind === "structured" ? <><WandPopover ariaLabel="新工作执行对象" side="top" open={subjectOpen} onOpenChange={setSubjectOpen}
            trigger={<WandButton kind="ghost" disabled={disabled} className="new-work-person">{employee ? <EmployeeAvatar employee={employee} size="sm"/> : <WandIcon name="spark"/>}<span className="new-work-person-name" title={employee?.name || team?.name}>{employee?.name || team?.name || (form.specifiedCli ? agentToolDisplayName(form.provider, form.engine) : "选择员工")}</span><WandIcon name="chevronDown" size={14}/></WandButton>}>
            <div className="new-work-subject"><UnifiedExecutionSubjectPicker selectedSubject={form.teamId ? { type: "team", id: form.teamId } : form.specifiedCli && !form.employeeId ? { type: "cli", id: form.provider, engine: form.engine } : { type: "employee", id: form.employeeId || "" }}
              kind="structured" model="default" showKind={false} showModel={false} teams={teams?.map(aiTeamPickerOption)} teamWorkspaceId={teamWorkspaceId}
              onKindChange={chooseKind} onModelChange={() => {}} onSubjectChange={subject => {
                if (subject.type === "cli" && subject.id !== "shell") setPreference({
                  provider: subject.id as WandTaskAgent["provider"], engine: subject.engine, model: "default", thinkingEffort: "off",
                });
                setForm(current => current ? subject.type === "employee" ? { ...current, employeeId: subject.id, teamId: undefined }
                  : subject.type === "team" ? { ...current, teamId: subject.id, employeeId: undefined }
                  : { ...current, employeeId: undefined, teamId: undefined, specifiedCli: true, kind: subject.id === "shell" ? "shell" : current.kind,
                    provider: subject.id === "shell" ? current.provider : subject.id as NewSessionForm["provider"], engine: subject.engine } : current);
                setSubjectOpen(false);
              }}/></div>
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
        {unknown ? <Typography.Text type="warning">创建结果未确认，请先从会话列表核对，不要重复创建；本页输入保留。</Typography.Text> : null}
        {voiceStatus ? <Typography.Text type="secondary" role="status">{voiceStatus}</Typography.Text> : null}
        <div className="conversation-input-wrap" data-composer-expanded="true" data-editor-expanded={editor.expanded}>
          <Sender ref={sender} className="conversation-sender" value={draft.text} readOnly={disabled} placeholder={placeholder} suffix={false}
            autoSize={{ minRows: 2, maxRows: editor.expanded ? 24 : 4 }} onChange={text => teamChatComposer.edit(key, { text })} onSubmit={() => void submit()}
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
            <ComposerSpeechButton ownerKey={key} revision={draft.revision} inputPlaceholder={placeholder} disabled={disabled || form.kind === "shell"} onStatus={setVoiceStatus}
              onCommit={(text, expectedRevision) => teamChatComposer.edit(key, { text: draft.text ? `${draft.text} ${text}` : text, expectedRevision, persist: true })}/>
            <ConversationSubmitButton stops={false} phase={submitting ? "sending" : error ? "failed" : "idle"} label={form.kind === "structured" ? "开始工作" : "打开终端"} disabled={disabled || !form.cwd.trim() || (form.kind === "structured" && (!draft.text.trim() && !draft.attachments.length || !!employee && !employee.agents.length || !employee && !team && !form.specifiedCli))} onClick={() => void submit()}/></Flex></Flex>}/>
        </div>
        <input ref={files} hidden type="file" multiple onChange={event => {
          for (const file of Array.from(event.currentTarget.files || [])) teamChatComposer.edit(key, { addAttachment: { file, name: file.name, size: file.size } });
          event.currentTarget.value = "";
        }}/>
      </div>
    </> : <Alert type="error" title={error || "配置未就绪，请重新打开新建。"}/ >}
  </section>;
}
