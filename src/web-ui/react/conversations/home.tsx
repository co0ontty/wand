import * as React from "react";
import { Sender } from "@ant-design/x";
import { Alert, Descriptions, Flex, Spin, Typography } from "antd";
import { DEFAULT_EMPLOYEE_ID, AI_TEAM_ACTIVE_RUN_STATUSES } from "../../../ai-team-types.js";
import type { ConversationDetail, ConversationTarget } from "../../../conversation-types.js";
import { conversationLeaderMention, conversationMentionToken } from "../../../conversation-mentions.js";
import type { Workspace } from "../../../types.js";
import { useSiliconEmployees } from "../agents/employee-repository";
import { EmployeeAvatar } from "../agents/employee-avatar";
import { ConversationGroupAvatar } from "./avatar";
import { ConversationMessages, formatConversationAttachments } from "../ai-teams/lazy";
import { teamChatComposer } from "../ai-teams/composer-bridge";
import { subscribeAiTeamRunChanges } from "../ai-teams/repository";
import { ComposerAttachmentList } from "../composer-attachments/host";
import { ComposerSpeechButton } from "../composer-voice/button";
import { requestJson } from "../http-adapter";
import { SidebarToggleIcon } from "../shell/sidebar-toggle-icon";
import { SidebarProjectionSwap } from "../workspaces/sidebar-projection-swap";
import { WandButton, WandIcon, WandIconButton, WandInput, WandSelect } from "../ui";
import { MOTION_DWELL_FAILED_MS, MOTION_DWELL_RESULT_SENTENCE_MS, MOTION_DWELL_SENT_MS } from "../ui/motion-tokens";
import { ConversationApprovalButton, ConversationMorphIcon, ConversationPanel, ConversationSubmitButton, type ConversationSubmitPhase } from "./controls";
import { employeeProfile } from "../agents/employee-profile";
import { ConversationDirectory } from "./directory";
import { conversationScrollRecord, storedConversationScroll } from "./presentation";
import { ConversationTaskPanel } from "./task-panel";
import { ConversationTaskPreview } from "./task-preview";
import { ConversationSessionReply } from "./session-preview";
import { useConversationActivity } from "./activity";
import { GroupEditor } from "./group-editor";
import { conversationsRepository, notifyConversationChanges, UnconfirmedConversationError } from "./repository";
import { conversationDraftKey, conversationUi, useConversationUi } from "./state";
import { useUserProfile } from "../user-profile-repository";

const runLabel = { running: "进行中", awaiting_approval: "等你批准计划", waiting_user: "等你回复", done: "已完成", failed: "失败", stopped: "已停止" };

/** 当前成员 + 历史轮次成员：@ 名单与员工头像映射共用同一份（私聊没有名单）。 */
function conversationRoster(detail: ConversationDetail | null) {
  if (detail?.kind !== "group") return [];
  return [...(detail.team?.members ?? []), ...detail.runDetails.flatMap(run => run.run.team.members)];
}
export interface ConversationHomeProps {
  visible: boolean; sidebarOpen: boolean; onOpenSidebar?(): void; onOpenSession(id: string): void;
}
export function ConversationHome(props: ConversationHomeProps): React.ReactElement {
  const ready = React.useSyncExternalStore(teamChatComposer.subscribeReady, teamChatComposer.ready, () => false);
  return ready ? <ReadyConversationHome {...props}/> : <section className="conversation-root" hidden={!props.visible} aria-label="正在读取聊天输入服务"/>;
}

function ReadyConversationHome({ visible, sidebarOpen, onOpenSidebar, onOpenSession }: ConversationHomeProps): React.ReactElement {
  const ui = useConversationUi();
  // 老数据没有 dissolvedBy 时按当前资料署名，不让群解散提示永远写死「我」。
  const selfName = useUserProfile().name || "我";
  const { employees, loading, error: directoryError } = useSiliconEmployees({ enabled: visible, includeArchived: true });
  const id = ui.selectedId;
  const [detail, setDetail] = React.useState<ConversationDetail | null>(null);
  const [loadError, setLoadError] = React.useState("");
  const [phase, setPhase] = React.useState<ConversationSubmitPhase>("idle");
  const [feedback, setFeedback] = React.useState("");
  const [voiceStatus, setVoiceStatus] = React.useState("");
  const [feedbackAction, setFeedbackAction] = React.useState("");
  const [unknown, setUnknown] = React.useState<{ id: string; clearRevision: number | null } | null>(null);
  const [layer, setLayer] = React.useState<"closed" | "menu" | "task">("closed");
  const [taskOptionsOpen, setTaskOptionsOpen] = React.useState(false);
  const [members, setMembers] = React.useState(false);
  const [invite, setInvite] = React.useState(false);
  const [taskDetails, setTaskDetails] = React.useState(false);
  const taskTrigger = React.useRef<HTMLButtonElement>(null);
  const [title, setTitle] = React.useState("");
  const [projectId, setProjectId] = React.useState("");
  const [projects, setProjects] = React.useState<Workspace[]>([]);
  const [projectsLoading, setProjectsLoading] = React.useState(false);
  const [projectsError, setProjectsError] = React.useState("");
  const [continueTaskId, setContinueTaskId] = React.useState("");
  const [capturedVersion, setCapturedVersion] = React.useState(1);
  const [chatCwd, setChatCwd] = React.useState("");
  const sender = React.useRef<React.ComponentRef<typeof Sender>>(null);
  const inputFiles = React.useRef<HTMLInputElement>(null);
  const toolsAnchor = React.useRef<HTMLDivElement>(null);
  const toolsTrigger = React.useRef<HTMLButtonElement>(null);
  const membersAnchor = React.useRef<HTMLDivElement>(null);
  const membersTrigger = React.useRef<HTMLButtonElement>(null);
  const inviteAnchor = React.useRef<HTMLDivElement>(null);
  const inviteTrigger = React.useRef<HTMLButtonElement>(null);
  const scroll = React.useRef<HTMLDivElement>(null);
  const loadEpoch = React.useRef(0);
  const pendingDetail = React.useRef<{ id: string; promise: Promise<void>; dirty: boolean } | null>(null);
  const projectsEpoch = React.useRef(0);
  const selected = detail?.id === id ? detail : null;
  const target = ui.targets[id] ?? null;
  const filter = ui.filters[id] ?? "";
  const draftKey = conversationDraftKey(id, target);
  const revision = React.useCallback(() => teamChatComposer.revision(draftKey), [draftKey]);
  React.useSyncExternalStore(teamChatComposer.subscribe, revision, revision);
  const draft = teamChatComposer.read(draftKey);
  const scope = `${id}:${target?.runId ?? "talk"}:${layer === "task" ? "dispatch" : "message"}`;
  const current = React.useRef({ scope, visible, id, key: draftKey }); current.current = { scope, visible, id, key: draftKey };
  const employee = employees.find(e => e.id === selected?.peerEmployeeId || id === `dm_${e.id}`);
  const leader = selected?.team?.members.find(m => m.isLeader);
  const selectedRun = selected?.runDetails.find(d => d.run.id === target?.runId);
  const mention = selected?.kind === "group" ? conversationLeaderMention(draft.text,
    layer !== "task" && selectedRun ? selectedRun.run.team.members : selected.team?.members ?? []) : null;
  const mentionedLeader = mention && !("error" in mention) ? mention : null;
  const activeRun = selectedRun && AI_TEAM_ACTIVE_RUN_STATUSES.includes(selectedRun.run.status) ? selectedRun : null;
  const stops = !!activeRun && !draft.text.trim() && !draft.attachments.length && layer !== "task";
  const busy = phase === "sending";
  const receiver = layer === "task" ? `${continueTaskId ? "继续此任务" : "派新任务"} · ${selected?.kind === "group" ? selected.title : employee?.name ?? "尚未选择"}`
    : target && selectedRun ? `${selectedRun.run.status === "awaiting_approval" ? "计划意见" : selectedRun.run.status === "waiting_user" ? "回复任务" : "补充任务"} · ${selected?.tasks.find(t => t.task.id === target.taskId)?.task.title} · 第 ${selectedRun.run.roundNumber ?? 1} 轮 · 发给负责人 ${selectedRun.run.team.members.find(m => m.isLeader)?.name ?? "未配置"}`
      : selected?.kind === "group" ? mentionedLeader ? `@${mentionedLeader.name} · 本轮负责人` : "群内沟通 · @成员指定负责人" : `发给 ${employee?.name ?? "当前员工"} · 开始新工作`;
  const load = React.useCallback(async () => {
    if (!id || !visible || ui.directory) return;
    if (pendingDetail.current?.id === id) { pendingDetail.current.dirty = true; return pendingDetail.current.promise; }
    const epoch = ++loadEpoch.current;
    const promise = (async () => {
      do {
        if (pendingDetail.current?.id === id) pendingDetail.current.dirty = false;
        try { const next = await conversationsRepository.detail(id); if (epoch === loadEpoch.current && current.current.id === id) { setDetail(next); setLoadError(""); } }
        catch (cause) { if (epoch === loadEpoch.current) setLoadError(cause instanceof Error ? cause.message : "读取对话失败。"); }
        // A notification during a GET needs one fresh read after it, not another concurrent GET.
      } while (epoch === loadEpoch.current && pendingDetail.current?.dirty);
    })().finally(() => { if (pendingDetail.current?.promise === promise) pendingDetail.current = null; });
    pendingDetail.current = { id, promise, dirty: false };
    return promise;
  }, [id, visible, ui.directory]);
  const loadProjects = React.useCallback(async () => {
    const epoch = ++projectsEpoch.current;
    setProjectsLoading(true); setProjectsError("");
    try { const next = await requestJson<Workspace[]>("/api/workspaces"); if (epoch === projectsEpoch.current) setProjects(next); }
    catch (cause) { if (epoch === projectsEpoch.current) setProjectsError(cause instanceof Error ? cause.message : "工作项目读取失败，请重试。"); }
    finally { if (epoch === projectsEpoch.current) setProjectsLoading(false); }
  }, []);
  const activity = useConversationActivity({ detail: selected, active: visible && !ui.directory, target, onRefresh: load });
  React.useEffect(() => {
    if (!visible || ui.directory || loading || id) return;
    const fallback = employees.find(e => e.id === DEFAULT_EMPLOYEE_ID && !e.archivedAt && e.agents.length);
    if (fallback) conversationUi.select(`dm_${fallback.id}`);
  }, [visible, ui.directory, loading, employees, id]);
  React.useEffect(() => {
    if (!visible || ui.directory) return;
    void load(); const unsubscribe = subscribeAiTeamRunChanges(() => { if (!document.hidden) void load(); });
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 3000);
    const resume = (): void => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", resume);
    return () => { ++loadEpoch.current; pendingDetail.current = null; unsubscribe(); clearInterval(timer); document.removeEventListener("visibilitychange", resume); };
  }, [load, visible, ui.directory]);
  React.useEffect(() => {
    if (!visible || layer !== "task") return;
    void loadProjects();
    return () => { ++projectsEpoch.current; };
  }, [visible, layer, loadProjects]);
  React.useEffect(() => { setLayer("closed"); setMembers(false); setInvite(false); setTaskDetails(false);
    setPhase("idle"); setFeedbackAction(""); setFeedback(""); setUnknown(null); }, [id, target?.runId, visible]);
  React.useEffect(() => {
    if (!target || !selectedRun || AI_TEAM_ACTIVE_RUN_STATUSES.includes(selectedRun.run.status) || (feedbackAction === "approve" && phase !== "idle")) return;
    const talkKey = conversationDraftKey(id, null);
    if (!teamChatComposer.transfer(draftKey, talkKey, draft.revision) && (draft.text || draft.attachments.length)) {
      setFeedback("本轮已结束；当前任务草稿保留，选择群内沟通前请核对草稿。");
      return;
    }
    conversationUi.target(id, null); setFeedback("本轮已结束，输入已回到群内沟通。");
  }, [id, target?.runId, selectedRun?.run.status, feedbackAction, phase]);
  const scrollScope = `messages:${id}:${filter}`;
  // 渲染期就记下当前会话：换会话时 React 先按新会话把列表清空、再跑上一次 effect 的清理，
  // 那时读到的 scrollTop 已经是空列表的 0。只有作用域没变，读到的位置才属于这个会话。
  const boundScrollScope = React.useRef(scrollScope);
  boundScrollScope.current = scrollScope;
  React.useLayoutEffect(() => {
    const element = scroll.current;
    if (!element || !visible) return;
    const bound = scrollScope;
    element.scrollTop = storedConversationScroll(ui.scrolls[bound]) ?? element.scrollHeight;
    return () => {
      if (boundScrollScope.current !== bound) return;
      conversationUi.scroll(bound, conversationScrollRecord(element));
    };
  }, [scrollScope, visible]);
  React.useLayoutEffect(() => {
    const request = ui.focusRequest;
    if (!visible || ui.directory || !request || request.id !== id) return;
    // Successful creation is explicit desktop input intent, never a mobile startup keyboard request.
    if (window.matchMedia("(max-width: 639px)").matches) { conversationUi.consumeFocus(request.revision); return; }
    const element = sender.current?.nativeElement;
    if (!element) return;
    const expectedRevision = teamChatComposer.revision(draftKey);
    const focusWhenLaidOut = (): void => {
      const latest = conversationUi.getSnapshot();
      if (latest.focusRequest?.revision !== request.revision || conversationUi.selectionRevision() !== request.revision
        || latest.selectedId !== request.id || !current.current.visible || latest.directory
        || teamChatComposer.revision(draftKey) !== expectedRevision) return;
      const input = element.querySelector<HTMLTextAreaElement>("textarea");
      if (!input?.getClientRects().length || input.closest("[inert],[hidden]")) return;
      input.focus({ preventScroll: true }); conversationUi.consumeFocus(request.revision);
    };
    const frame = requestAnimationFrame(focusWhenLaidOut);
    const observer = new ResizeObserver(focusWhenLaidOut); observer.observe(element);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [id, visible, ui.directory, ui.focusRequest?.revision, draftKey]);
  const select = (next: string, focusComposer = false): void => { setLayer("closed"); setMembers(false); setInvite(false); conversationUi.select(next, focusComposer); notifyConversationChanges(); };
  const taskMode = (taskId = ""): void => {
    setProjectsLoading(true); setProjectsError("");
    setCapturedVersion(selected?.memberVersion ?? 1); setContinueTaskId(taskId);
    const task = selected?.tasks.find(t => t.task.id === taskId)?.task;
    setTitle(task?.title ?? draft.text.trim().split(/\r?\n/)[0].replace(/^\s*[-*#>]+\s*/, "").slice(0, 200));
    if (task) { setProjectId(task.workspaceId ?? ""); if (!draft.text.trim()) teamChatComposer.edit(draftKey, { text: task.description || task.title }); }
    setTaskOptionsOpen(true); setLayer("task");
  };
  const addFiles = (files: FileList): void => {
    if (draft.attachments.length + files.length > 5) { setFeedback("最多添加 5 个附件。"); return; }
    for (const file of Array.from(files)) teamChatComposer.edit(draftKey, { addAttachment: {
      file, name: file.name, size: file.size, previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    } });
  };
  const settle = async (next: ConversationSubmitPhase, message: string, capturedScope: string, action = ""): Promise<void> => {
    if (current.current.scope !== capturedScope) return;
    setPhase(next); setFeedback(message);
    if (next !== "unknown") { await new Promise(resolve => setTimeout(resolve, next === "failed" ? MOTION_DWELL_FAILED_MS : MOTION_DWELL_SENT_MS));
      if (current.current.scope !== capturedScope) return;
      if (next === "sent" && action === "approve") {
        setPhase("result");
        await new Promise(resolve => setTimeout(resolve, MOTION_DWELL_RESULT_SENTENCE_MS));
      }
      if (current.current.scope === capturedScope) {
        setPhase("idle"); setFeedbackAction("");
        if (next === "sent") setFeedback("");
      } }
  };
  const act = async (action: string): Promise<void> => {
    if (!target || busy || unknown || (feedbackAction && phase !== "idle")) return;
    const captured = scope; setFeedbackAction(action); setPhase("sending");
    try { const receipt = await conversationsRepository.post(`/api/conversations/${encodeURIComponent(id)}/actions`, { target, action });
      void load();
      await settle(receipt.error ? "failed" : "sent", receipt.error || "操作已接受", captured, action);
    } catch (cause) { await failed(cause, captured, draftKey, false, action); }
  };
  const failed = async (cause: unknown, captured: string, key: string, submission = false, action = ""): Promise<void> => {
    if (current.current.scope !== captured) return;
    if (cause instanceof UnconfirmedConversationError) {
      const snapshot = teamChatComposer.read(key);
      setUnknown({ id: cause.requestId, clearRevision: !submission || snapshot.recovery ? null : snapshot.revision });
      await settle("unknown", cause.message, captured, action);
    } else await settle("failed", cause instanceof Error ? cause.message : "操作失败，草稿保留。", captured, action);
  };
  const send = async (): Promise<void> => {
    if (busy || unknown || (feedbackAction === "approve" && phase !== "idle") || !id || !selected || selected.unavailableReason || (!draft.text.trim() && !draft.attachments.length)) return;
    if (mention && "error" in mention) { setFeedback(mention.error); return; }
    if (layer === "task" && (projectsLoading || projectsError)) { setFeedback(projectsLoading ? "工作项目仍在加载，请稍候。" : "请先重试读取工作项目，任务草稿已保留。"); return; }
    if (layer === "task" && (!projectId || capturedVersion !== selected.memberVersion)) { setFeedback("请选择工作项目并核对当前群成员版本。"); return; }
    if (target && !activeRun && layer !== "task") { setFeedback("本轮已结束，请明确切回群内沟通。"); return; }
    const captured = scope, key = draftKey, isTask = layer === "task";
    const originalId = id, originalTarget: ConversationTarget = target;
    const metadata = { title, workspaceId: projectId, memberVersion: selected.kind === "group" ? capturedVersion : undefined, continueTaskId: continueTaskId || undefined };
    const cwd = isTask ? projects.find(p => p.id === projectId)?.cwd : chatCwd || undefined;
    setFeedbackAction(""); setPhase("sending"); setFeedback("");
    try {
      const receipt = await teamChatComposer.submit(key, draft.text, async payload => {
        let text = payload.text;
        if (payload.attachments.length) {
          const channel = await conversationsRepository.post(`/api/conversations/${encodeURIComponent(originalId)}/channel`, { cwd });
          if (!channel.sessionId) throw new UnconfirmedConversationError(channel.requestId);
          const form = new FormData(); payload.attachments.forEach(a => form.append("files", a.file));
          const uploaded = await requestJson<{ files: Array<{ savedPath: string }> }>(`/api/sessions/${encodeURIComponent(channel.sessionId)}/upload`, { method: "POST", body: form });
          text = await formatConversationAttachments(uploaded.files, text);
        }
        return conversationsRepository.post(`/api/conversations/${encodeURIComponent(originalId)}/${isTask ? "tasks" : "messages"}`,
          isTask ? { ...metadata, description: text } : { input: text, target: originalTarget, cwd });
      });
      if (current.current.scope !== captured || !current.current.visible) { notifyConversationChanges(); return; }
      void load();
      await settle(receipt.error ? "failed" : "sent", receipt.error || (receipt.taskId ? "任务已接受" : "已发送"), captured);
      if (current.current.scope !== captured) return;
      setLayer("closed"); void load();
      if (selected.kind === "group" && (isTask || (receipt.taskId && receipt.runId && !originalTarget)) && !teamChatComposer.read(key).text && !teamChatComposer.read(key).attachments.length) {
        select(receipt.conversationId);
        conversationUi.target(receipt.conversationId, receipt.taskId && receipt.runId ? { taskId: receipt.taskId, runId: receipt.runId } : null);
      }
    } catch (cause) { await failed(cause, captured, key, true); }
  };
  const reconcile = async (): Promise<void> => {
    if (!unknown) return;
    try { const receipt = await conversationsRepository.reconcile(unknown.id);
      if (receipt.state === "pending") { setFeedback("仍未确认，请勿重复提交。"); return; }
      if (receipt.state === "accepted" && unknown.clearRevision !== null) teamChatComposer.edit(draftKey, { acknowledgeRevision: unknown.clearRevision });
      if (receipt.state === "accepted") teamChatComposer.edit(draftKey, { forgetRecovery: true });
      setUnknown(null); void load();
      await settle(receipt.error || receipt.state === "rejected" ? "failed" : "sent", receipt.error || (receipt.state === "accepted" ? "已核对：请求已接受" : "未接受，草稿保留"), scope, feedbackAction);
    } catch (cause) { setFeedback(cause instanceof Error ? cause.message : "核对失败。"); }
  };
  const taskLabels = Object.fromEntries(selected?.tasks.map(t => [t.task.id, t.task.title]) ?? []);
  const roster = conversationRoster(selected);
  const turns = selected?.messages.filter(t => !filter || t.conversationTarget?.taskId === filter || t.conversationLink?.taskId === filter) ?? [];
  // Only a genuinely empty conversation gets a first-use cue; never clear real history.
  const emptyNotice = turns.length || loadError ? "" : !selected
    ? directoryError || (loading ? "正在加载联系人…" : id ? "正在加载对话…" : "")
    : filter ? "此任务暂无消息" : selected.kind === "dm" ? "把要完成的事发给我；也可以从通讯录选择员工。" : "";
  const toggleMembers = (trigger: HTMLButtonElement): void => {
    membersTrigger.current = trigger; setMembers(!members); setInvite(false);
  };
  const toolsOpen = layer === "menu" || layer === "task" && taskOptionsOpen;
  const primaryLabel = phase === "sending" ? "发送中" : phase === "sent" ? "已接受" : phase === "failed" ? "操作失败" : phase === "unknown" ? "送达未确认" : stops ? "停止本轮" : layer === "task" ? continueTaskId ? "确认继续此任务" : "派发任务" : "发送消息";
  return <section className="conversation-root" aria-label="聊天首页" hidden={!visible} inert={!visible}>
    <Flex vertical className="conversation-chat-surface" data-active={!ui.directory} inert={ui.directory} style={{ height: "100%", minHeight: 0 }}>
      <Flex ref={membersAnchor} align="center" justify="space-between" gap={8} className="conversation-heading" style={{ position: "relative", flexShrink: 0 }}>
        <Flex align="center" gap={8} style={{ minWidth: 0 }}>
          {onOpenSidebar ? <WandIconButton style={{ width: 44, height: 44 }} aria-label={sidebarOpen ? "关闭列表" : "打开列表"} onClick={onOpenSidebar}><SidebarToggleIcon open={sidebarOpen}/></WandIconButton> : null}
          {employee ? <WandIconButton className="conversation-avatar-button" aria-label={`查看${employee.name}的资料`} onClick={event => employeeProfile.open(employee, event.currentTarget)}><EmployeeAvatar employee={employee} size="chat"/></WandIconButton> : selected?.team ? <WandIconButton className="conversation-avatar-button" aria-label="查看群资料" aria-expanded={members} aria-controls="conversation-members-panel" onClick={event => toggleMembers(event.currentTarget)}><ConversationGroupAvatar title={selected.title} size={40}/></WandIconButton> : null}
          <div className="conversation-heading-copy">
            <WandButton kind="ghost" className="conversation-heading-title" title={selected?.title ?? employee?.name} aria-expanded={selected?.kind === "group" ? members : undefined} aria-controls={selected?.kind === "group" ? "conversation-members-panel" : undefined} onClick={event => employee ? employeeProfile.open(employee, event.currentTarget) : toggleMembers(event.currentTarget)}>{selected?.title ?? employee?.name ?? "选择一位员工，开始聊天"}</WandButton>
            <Typography.Text type="secondary" className="conversation-heading-context">{selected?.kind === "group" ? `群聊 · 我 + ${selected.team?.members.length ?? 0} 位员工` : employee ? `私聊${employee.id === DEFAULT_EMPLOYEE_ID ? " · 默认伙伴" : ""}` : "选择接收对象后发送"}</Typography.Text>
          </div>
        </Flex>
        {selected?.kind === "group" ? <WandButton aria-expanded={members} aria-controls="conversation-members-panel" onClick={event => toggleMembers(event.currentTarget)}>成员</WandButton> : null}
        <ConversationPanel open={members} owner="conversation-members-panel" anchorRef={membersAnchor} triggerRef={membersTrigger} onClose={() => { setMembers(false); setInvite(false); }}>
          <Typography.Text strong>当前群成员：我 + {selected?.team?.members.length ?? 0} 位员工</Typography.Text>
          {selected?.sourceTemplateId ? <Typography.Paragraph type="secondary">来自团队模板 · {selected.team?.name}</Typography.Paragraph> : null}
          {selected?.team?.members.map(m => <Flex key={m.id} vertical gap={4} style={{ paddingBlock: 8 }}>
            <Flex gap={8} align="center">{m.employeeId ? <WandIconButton className="conversation-avatar-button" aria-label={`查看${m.name}的资料`} onClick={event => { setMembers(false); employeeProfile.open({ id: m.employeeId!, name: m.name, avatar: m.avatar }, event.currentTarget); }}><EmployeeAvatar employee={{ id: m.employeeId, name: m.name, avatar: m.avatar }} size="chat"/></WandIconButton> : null}<Typography.Text strong>{m.name}{m.isLeader ? " · 负责人" : ""}</Typography.Text></Flex><Typography.Text>{m.duty}</Typography.Text>
            <Typography.Text type="secondary">加入版本 {selected.joinedVersions[m.employeeId ?? `${m.legacyTemplateId}:${m.legacyMemberId}`]} · {selected.memberUnavailableReasons[m.id] || "后续新派工可用"}</Typography.Text>
            <Flex gap={8} wrap><WandButton size="small" aria-label={`@${m.name} 负责本轮`}
              disabled={busy || !!target || !!selected.memberUnavailableReasons[m.id]} onClick={() => {
                teamChatComposer.edit(draftKey, { text: `${conversationMentionToken(m, selected.team!.members)} ${mentionedLeader?.body ?? draft.text}` });
                setMembers(false); setInvite(false); sender.current?.focus({ cursor: "end" });
              }}>@负责本轮</WandButton>
              {m.employeeId ? <WandButton onClick={() => select(`dm_${m.employeeId}`)}>和此员工私聊</WandButton> : null}</Flex>
            {activeRun ? <Typography.Text type="secondary">本轮执行名单 {activeRun.run.team.members.some(old => old.id === m.id) ? "包含此成员" : "不包含此成员，新派工生效"}</Typography.Text> : null}
          </Flex>)}
          <Flex ref={inviteAnchor} style={{ position: "relative" }}><WandButton ref={inviteTrigger} aria-expanded={invite} onClick={() => setInvite(!invite)}>
            <ConversationMorphIcon from="plus" to="close" active={invite}/>邀请</WandButton>
            <ConversationPanel open={invite} owner="conversation-invite-panel" anchorRef={inviteAnchor} triggerRef={inviteTrigger} onClose={() => setInvite(false)}>
              <GroupEditor open={invite} owner="conversation-invite-panel" inviteTo={selected?.kind === "group" ? selected : undefined}
                onCancel={() => setInvite(false)} onCreated={() => { setInvite(false); void load(); }}/>
            </ConversationPanel>
          </Flex>
        </ConversationPanel>
      </Flex>
      {selected?.kind === "group" ? <Flex align="center" gap={8} className="conversation-task-index">
        <WandButton ref={taskTrigger} aria-expanded={taskDetails} onClick={() => setTaskDetails(true)}>群任务 · {selected.tasks.length}</WandButton>
        <Typography.Text type="secondary" ellipsis>{selected.dissolvedAt ? "群聊已解散 · 执行记录" : selected.tasks.some(t => t.task.status !== "archived" && ["waiting_user", "awaiting_approval"].includes(t.runs[0]?.status))
          ? "有任务需要你确认" : selected.tasks.some(t => t.task.status !== "archived" && t.runs[0]?.status === "running") ? "任务进行中" : "进度与执行记录"}</Typography.Text>
        {filter ? <WandButton onClick={() => conversationUi.filter(id, "")} title={taskLabels[filter]}>正在查看任务 · 返回全部消息</WandButton> : null}
      </Flex> : null}
      <ConversationTaskPanel detail={selected} open={taskDetails && visible && !ui.directory} filter={filter}
        onClose={() => { setTaskDetails(false); taskTrigger.current?.focus({ preventScroll: true }); }}
        onFilter={value => conversationUi.filter(id, value)} onReply={value => { setLayer("closed"); conversationUi.target(id, value); }}
        onContinue={taskMode} onOpenSession={onOpenSession}/>
      <div ref={scroll} className="conversation-message-scroll">
        {loadError ? <Typography.Paragraph type="danger">{loadError}<WandButton onClick={() => void load()}>只读重试</WandButton></Typography.Paragraph> : null}
        {emptyNotice ? <Typography.Paragraph type={!selected && directoryError ? "danger" : "secondary"} className="conversation-empty" role="status">
          {emptyNotice}
        </Typography.Paragraph> : null}
        <SidebarProjectionSwap value={`${id}:${filter}`}><ConversationMessages key={`${id}:${filter}`} ready={!!selected} active={visible && !ui.directory} group={selected?.kind === "group"} restoreScroll={storedConversationScroll(ui.scrolls[scrollScope])} turns={turns} taskLabels={taskLabels}
          mentionNames={[...new Set(roster.map(member => member.name).filter(Boolean))]}
          employeeIds={Object.fromEntries(roster.filter(member => member.employeeId).flatMap(member => [[member.id, member.employeeId!], [member.employeeId!, member.employeeId!]]))}
          renderSessionPreview={(turn, index) => <ConversationSessionReply turn={turn} active={visible && !ui.directory}
            onOpen={() => onOpenSession(turn.sessionLink!.sessionId)}>{activity.renderActivity(turn, index)}</ConversationSessionReply>}
          renderTaskPreview={turn => <ConversationTaskPreview turn={turn} active={visible && !ui.directory} onOpen={() => {
            if (turn.conversationLink) conversationUi.openTask(turn.conversationLink.conversationId, turn.conversationLink.taskId,
              turn.taskPreview?.runId && ["running", "awaiting_approval", "waiting_user"].includes(turn.taskPreview.status) ? turn.taskPreview.runId : null);
          }}/>}
          renderActivity={activity.renderActivity} onOpenEmployee={(identity, trigger) => employeeProfile.open(identity, trigger)} onOpenConversation={select} onOpenSession={onOpenSession}/></SidebarProjectionSwap>
      </div>
      {activity.controls}
      {selected?.dissolvedAt ? <div className="conversation-dissolved" role="status">
        <span>{new Date(selected.dissolvedAt).toLocaleString([], { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })} · {selected.dissolvedBy || selfName}解散了群聊</span>
        <WandButton kind="ghost" className="conversation-restore-link" disabled={busy} onClick={() => {
          void conversationsRepository.updateListState(id, { dissolved: false }).then(() => load()).catch(cause => setFeedback(cause instanceof Error ? cause.message : "恢复失败，请重试。"));
        }}>恢复群聊</WandButton>{feedback ? <Typography.Text type="danger">{feedback}</Typography.Text> : null}
      </div> : null}
      {target && selectedRun ? <Flex vertical gap={8} className="conversation-task-context" role="region" aria-label="当前回复任务">
        <Flex justify="space-between" align="center" gap={8}><Typography.Text strong>{taskLabels[target.taskId]} · {runLabel[selectedRun.run.status]}</Typography.Text>
          <WandButton onClick={() => { setLayer("closed"); conversationUi.target(id, null); }}>返回群内沟通</WandButton></Flex>
        <Typography.Text type="secondary">{selectedRun.run.statusDetail || "你发送的补充内容将交给本轮负责人。"}</Typography.Text>
        {activeRun?.run.status === "awaiting_approval" || (feedbackAction === "approve" && phase !== "idle") ? <ConversationApprovalButton
          phase={feedbackAction === "approve" ? phase : "idle"} disabled={busy || !!unknown || (feedbackAction === "approve" && phase !== "idle")} onClick={() => void act("approve")}/> : null}
        {activeRun?.run.status === "waiting_user" && activeRun.run.statusDetail.includes("步数上限") ? <WandButton className="conversation-approval" disabled={busy || !!unknown} onClick={() => void act("continue")}>明确增加本轮步数</WandButton> : null}
      </Flex> : null}
      <div className="conversation-composer" hidden={!!selected?.dissolvedAt}>
        <Flex align="center" justify="space-between" gap={8}><Typography.Text className="conversation-receiver" title={receiver}>{receiver}</Typography.Text>{layer === "task" ? <WandButton size="small" onClick={() => setLayer("closed")}>取消派发</WandButton> : null}</Flex>
        {selected?.kind === "dm" && layer !== "task" ? <Typography.Text type="secondary" className="conversation-input-hint">新消息开始新工作；补充上一项请打开对应会话。</Typography.Text> : null}
        {chatCwd && layer !== "task" && !target ? <Typography.Text type="secondary" className="conversation-cwd-summary">临时目录：{chatCwd} · 本页聊天共用</Typography.Text> : null}
        <div className="conversation-feedback" hidden={!feedback && !selected?.unavailableReason && !unknown && !draft.recovery && activeRun?.run.status !== "awaiting_approval" && !(feedbackAction === "approve" && phase !== "idle") && !(id && !draft.text && !draft.attachments.length && teamChatComposer.read(conversationDraftKey("", null)).text)} role="status" aria-live="polite"><Typography.Text type={phase === "failed" || phase === "unknown" || selected?.unavailableReason ? "danger" : "secondary"}>
          {feedback || selected?.unavailableReason || ""}</Typography.Text>{unknown ? <WandButton size="small" onClick={() => void reconcile()}>核对请求</WandButton> : null}
          {draft.recovery ? <WandButton size="small" onClick={() => teamChatComposer.edit(draftKey, { recoverCapture: true })}>恢复本次未发送草稿</WandButton> : null}
          {id && !draft.text && !draft.attachments.length && teamChatComposer.read(conversationDraftKey("", null)).text ? <WandButton size="small" onClick={() => {
            const unaddressed = conversationDraftKey("", null); teamChatComposer.transfer(unaddressed, draftKey, teamChatComposer.read(unaddressed).revision);
          }}>采用尚未选择的草稿</WandButton> : null}
        </div>
        {draft.attachments.length ? <ComposerAttachmentList items={draft.attachments.map((a, index) => ({ index, name: a.name, sizeLabel: `${a.size} B`, previewUrl: a.previewUrl ?? null }))}
          onRemove={index => teamChatComposer.edit(draftKey, { removeAttachment: index })}/> : null}
        {voiceStatus ? <Typography.Text type="secondary" role="status" aria-live="polite" ellipsis>{voiceStatus}</Typography.Text> : null}
        <Sender ref={sender} value={draft.text} className="conversation-sender" placeholder={layer === "task" ? "描述任务要求…" : "输入消息…"} autoSize={{ minRows: 1, maxRows: 5 }} suffix={false}
          onPaste={e => { if (e.clipboardData.files.length) { e.preventDefault(); addFiles(e.clipboardData.files); } }}
          onChange={text => teamChatComposer.edit(draftKey, { text })} onSubmit={() => void send()} submitType="enter"
          onKeyDown={e => { if (e.nativeEvent.isComposing || e.keyCode === 229) return false;
            if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); void send(); return false; } return undefined; }}
          // 操作行与发送按钮放在发送器自己的 footer 里，和正文同属一张输入面板；
          // 摆在面板外面会读成「输入框 + 另一条工具栏」两截。
          footer={<Flex ref={toolsAnchor} align="center" justify="space-between" className="conversation-action-row" style={{ position: "relative" }}>
          <Flex align="center" gap={4}><WandIconButton ref={toolsTrigger} style={{ width: 44, height: 44 }} aria-label={toolsOpen ? "关闭聊天操作" : layer === "task" ? "任务选项" : "更多聊天操作"}
            aria-expanded={toolsOpen} onClick={() => layer === "task" ? setTaskOptionsOpen(!taskOptionsOpen) : setLayer(layer === "closed" ? "menu" : "closed")}><ConversationMorphIcon from="plus" to="close" active={toolsOpen}/></WandIconButton>
            <WandIconButton style={{ width: 44, height: 44 }} aria-label="添加附件" onClick={() => { if (layer === "task") setTaskOptionsOpen(false); else setLayer("closed"); inputFiles.current?.click(); }}><WandIcon name="paperclip"/></WandIconButton>
            <ComposerSpeechButton ownerKey={`${draftKey}:${scope}`} revision={draft.revision} inputPlaceholder={layer === "task" ? "描述任务要求…" : "输入消息…"} disabled={!visible || busy || !!selected?.dissolvedAt || !!selected?.unavailableReason}
              onStatus={setVoiceStatus} onCommit={(text, expectedRevision) => teamChatComposer.edit(draftKey, {
                text: draft.text ? draft.text.replace(/\s+$/, "") + " " + text : text, expectedRevision, persist: true,
              })}/>
            <Typography.Text type="secondary" className="conversation-input-hint">Enter 发送 · Shift+Enter 换行</Typography.Text></Flex>
          <ConversationSubmitButton phase={feedbackAction === "approve" ? "idle" : phase} stops={stops} label={feedbackAction === "approve" ? "发送消息" : primaryLabel} disabled={busy || !!unknown || (feedbackAction === "approve" && phase !== "idle") || !id || !selected || !!selected.unavailableReason || (!stops && !draft.text.trim() && !draft.attachments.length)} onClick={() => void (stops ? act("stop") : send())}/>
          <ConversationPanel open={toolsOpen} owner="conversation-task-panel" focusKey={layer} anchorRef={toolsAnchor} triggerRef={toolsTrigger} direction="up" onClose={() => layer === "task" ? setTaskOptionsOpen(false) : setLayer("closed")}>
            <div hidden={layer !== "menu"}>{selected?.kind === "group" ? <WandButton disabled={!id || !!selected.unavailableReason} onClick={() => taskMode()}>派新任务</WandButton> : null}
              {selected?.kind === "dm" && employee ? <WandButton onClick={event => { setLayer("closed"); employeeProfile.open(employee, event.currentTarget); }}>员工执行配置</WandButton> : null}
              <WandButton disabled={!selected?.communicationSessionId} onClick={() => { setLayer("closed"); if (selected?.communicationSessionId) onOpenSession(selected.communicationSessionId); }}>{selected?.kind === "dm" ? "历史私聊执行窗口" : "会话工具 / 资源设置"}</WandButton>
              <WandInput aria-label="临时聊天目录（本页共用）" placeholder="留空沿用员工或项目目录" value={chatCwd} onChange={e => setChatCwd(e.currentTarget.value)}/>
              <Typography.Text type="secondary">用于本页新消息，可覆盖默认目录；切换联系人仍保留，不修改员工配置。</Typography.Text>
              {chatCwd ? <WandButton onClick={() => setChatCwd("")}>清除临时目录</WandButton> : null}
            </div>
            <div hidden={layer !== "task"}><Typography.Text strong>{continueTaskId ? "确认继续此任务" : "派新任务"}</Typography.Text>
              <WandInput aria-label="任务 title" value={title} disabled={!!continueTaskId} onChange={e => setTitle(e.currentTarget.value)}/>
              {projectsLoading ? <Flex align="center" gap={8} role="status"><Spin size="small"/>正在读取工作项目…</Flex> : projectsError ? <Alert type="error" showIcon title={projectsError} action={<WandButton size="small" onClick={() => void loadProjects()}>只读重试</WandButton>}/> : !projects.some(p => p.kind !== "global" && !!p.cwd) ? <Typography.Text type="secondary" role="status">还没有可用的工作项目，请先在工作区创建项目。</Typography.Text> : null}
              <WandSelect ariaLabel="工作项目" popupOwner="conversation-task-panel" searchable value={projectId} onValueChange={setProjectId} disabled={projectsLoading || !!projectsError}
                options={projects.filter(p => p.kind !== "global" && !!p.cwd).map(p => ({ value: p.id, label: p.name }))}/>
              <Descriptions size="small" column={1} items={[{ key: "members", label: "执行名单", children: selected?.team ? `我 + ${selected.team.members.map(m => m.name).join("、")} · 本轮负责人 ${mentionedLeader?.name ?? leader?.name}` : `我 + ${employee?.name}（负责人 / 执行者）` },
                { key: "version", label: "成员版本", children: capturedVersion }, { key: "approval", label: "计划审批", children: selected?.team?.requirePlanApproval === false ? "沿用团队模板自动开工" : "需用户明确批准" }]}/>
            </div>
          </ConversationPanel>
        </Flex>}/>
        <input ref={inputFiles} hidden type="file" multiple aria-label="选择附件" onChange={e => { if (e.currentTarget.files) addFiles(e.currentTarget.files); e.currentTarget.value = ""; }}/>
      </div>
    </Flex>
    <div className="conversation-directory-surface" data-active={ui.directory} inert={!ui.directory}><ConversationDirectory onSelect={select}/></div>
  </section>;
}
