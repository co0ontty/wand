import { Alert, Card, Collapse, Descriptions, Flex, Input, List, Tabs, Tag, Timeline, Typography } from "antd";
import * as React from "react";
import type { AgentActivityState } from "../../../mission-types";
import {
  aiTeamsRepository,
  subscribeAiTeamRunChanges,
  subscribeAiTeamDefinitionChanges,
  type AiTeamMember,
  type AiTeamRun,
  type AiTeamRunDetail,
  type AiTeamStep,
} from "../ai-teams/repository";
import { TeamAvatar, TeamAvatarStack, type TeamAvatarState } from "../ai-teams/avatar";
import { displayTeamOf, displayChatTurn, mergeTeamChatDetail, ConversationMessages } from "../ai-teams/team-chat-view";
import type { ConversationActivityDetail } from "../conversations/activity-model";
import { useConversationActivity } from "../conversations/activity";
import { TeamDeliveryCard } from "../ai-teams/team-delivery";
import { failureMessage } from "../errors";
import { issueAgentProviderLabel } from "./task-board-agent";
import { taskBoardController } from "./task-board-controller";
import { MOTION_DWELL_FAILED_MS, MOTION_DWELL_SENT_MS } from "../ui/motion-tokens";
import { WandBadge, WandButton, WandIcon } from "../ui";

/** Task details project the same transcript; replying opens its owning conversation. */
function RunConversation({ detail, active, onOpenSession }: { detail: AiTeamRunDetail; active: boolean; onOpenSession?: (id: string) => void }): React.ReactElement {
  const team = displayTeamOf(detail);
  const projection = React.useMemo(() => ({ id: detail.run.conversationId || `run:${detail.run.id}`, kind: "group", title: detail.chatTitle || team.name,
    communicationSessionId: detail.run.chatSessionId, runDetails: [detail],
    messages: (detail.chatTurns ?? []).map(turn => displayChatTurn(turn, team)),
  }) satisfies ConversationActivityDetail, [detail, team]);
  const activity = useConversationActivity({ detail: projection, active });
  return <Flex vertical gap={8} style={{ minHeight: 0 }}>
    <WandButton onClick={() => taskBoardController.open("", "", "teamchat", detail.run.id)}>打开对话并回复</WandButton>
    <div className="conversation-message-scroll" style={{ maxHeight: "60dvh", overflow: "auto" }}>
      <ConversationMessages turns={projection.messages} taskLabels={{ [detail.run.taskId]: detail.chatTitle || "任务" }} active={active}
        mentionNames={team.members.map(member => member.name)} renderActivity={activity.renderActivity}
        onOpenSession={onOpenSession} onOpenConversation={() => taskBoardController.open("", "", "teamchat", detail.run.id)}/>
    </div>{activity.controls}
  </Flex>;
}

type BadgeTone = "neutral" | "accent" | "info" | "success" | "warning";

export const RUN_STATUS: Record<AiTeamRun["status"], { label: string; tone: BadgeTone }> = {
  running: { label: "进行中", tone: "info" },
  awaiting_approval: { label: "等你批准计划", tone: "warning" },
  waiting_user: { label: "等你回复", tone: "warning" },
  done: { label: "已完成", tone: "success" },
  failed: { label: "失败", tone: "neutral" },
  stopped: { label: "已停止", tone: "neutral" },
};

const STEP_STATUS: Record<AiTeamStep["status"], string> = {
  queued: "排队",
  running: "进行中",
  done: "完成",
  failed: "失败",
  skipped: "跳过",
};

const MEMBER_STATE: Partial<Record<AgentActivityState, string>> = {
  needs_input: "等待回答",
  needs_permission: "等待授权",
};

const ACTIVE: ReadonlyArray<AiTeamRun["status"]> = ["running", "awaiting_approval", "waiting_user"];

/** 同一位置依次显示 处理中 → 完成/失败；失败态停留更久。 */
function useActionState(): {
  pending: string;
  flash: { key: string; ok: boolean } | null;
  run(key: string, action: () => Promise<void>): Promise<void>;
} {
  const [pending, setPending] = React.useState("");
  const [flash, setFlash] = React.useState<{ key: string; ok: boolean } | null>(null);
  const timer = React.useRef<number | null>(null);
  React.useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  const run = React.useCallback(async (key: string, action: () => Promise<void>) => {
    setPending(key);
    setFlash(null);
    let ok = true;
    try {
      await action();
    } catch {
      ok = false;
    } finally {
      setPending("");
    }
    setFlash({ key, ok });
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = null; setFlash(null); }, ok ? MOTION_DWELL_SENT_MS : MOTION_DWELL_FAILED_MS);
  }, []);
  return { pending, flash, run };
}

function ActionButton({
  id,
  state,
  label,
  pendingLabel,
  kind = "ghost",
  disabled,
  onClick,
}: {
  id: string;
  state: ReturnType<typeof useActionState>;
  label: string;
  pendingLabel: string;
  kind?: "primary" | "ghost" | "danger" | "soft";
  disabled?: boolean;
  onClick(): Promise<void>;
}): React.ReactElement {
  const flash = state.flash?.key === id ? state.flash : null;
  const pending = state.pending === id;
  return <WandButton
    kind={kind}
    size="small"
    aria-busy={pending || undefined}
    aria-live="polite"
    disabled={disabled || !!state.pending}
    onClick={() => void state.run(id, onClick)}
  >
    {pending ? pendingLabel : flash ? (flash.ok ? "已完成" : "失败") : label}
  </WandButton>;
}

function stepAvatarState(step: AiTeamStep, memberState: AgentActivityState | undefined): TeamAvatarState {
  if (step.status === "running") return memberState && MEMBER_STATE[memberState] ? "waiting" : "working";
  if (step.status === "done") return "done";
  if (step.status === "failed") return "failed";
  return "idle";
}

/** 成员此刻的状态：有在跑的步骤看它，否则看最近一步的结局。 */
function memberAvatarState(
  member: AiTeamMember,
  steps: AiTeamStep[],
  memberStates: Record<string, AgentActivityState>,
): TeamAvatarState {
  const own = steps.filter((step) => step.memberId === member.id);
  const running = own.find((step) => step.status === "running");
  if (running) return stepAvatarState(running, running.sessionId ? memberStates[running.sessionId] : undefined);
  const last = [...own].reverse().find((step) => step.status !== "queued" && step.status !== "skipped");
  return last ? stepAvatarState(last, undefined) : "idle";
}

function StepRow({
  step,
  steps,
  member,
  memberState,
  open,
  onToggle,
  onOpenSession,
  onComplete,
  actions,
}: {
  step: AiTeamStep;
  steps: AiTeamStep[];
  member: AiTeamMember | undefined;
  memberState: AgentActivityState | undefined;
  open: boolean;
  onToggle(): void;
  onOpenSession?: (sessionId: string) => void;
  onComplete(report: string): Promise<void>;
  actions: ReturnType<typeof useActionState>;
}): React.ReactElement {
  const who = member?.name ?? (step.kind === "leader" ? "负责人" : step.memberId);
  const [report, setReport] = React.useState("");
  const [skippedOpen, setSkippedOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const skippedTriggerRef = React.useRef<HTMLButtonElement>(null);
  const skipped = step.dispatchInfo?.skipped ?? [];
  const live = memberState ? MEMBER_STATE[memberState] : undefined;
  const canComplete = step.kind === "work" && step.status === "running";
  const waitsOn = step.status === "queued"
    ? step.dependsOn.map((id) => steps.find((item) => item.id === id))
      .filter((item): item is AiTeamStep => !!item && item.status !== "done")
      .map((item) => `#${item.seq}`)
    : [];
  return <Flex align="start" gap={10} className="task-board-team-step" data-status={step.status} data-kind={step.kind} data-open={open || undefined}
    onKeyDown={(event) => {
      if (event.key !== "Escape" || event.defaultPrevented || !open || actions.pending) return;
      event.preventDefault(); event.stopPropagation(); onToggle(); triggerRef.current?.focus();
    }}>
    {member ? <TeamAvatar member={member} size="sm" state={stepAvatarState(step, memberState)}/> : null}
    <Card size="small" className="task-board-team-step-card" style={{ flex: 1, minWidth: 0 }}>
      <WandButton kind="ghost" type="button" ref={triggerRef} className="task-board-team-step-head" aria-expanded={open}
        style={{ width: "100%", height: "auto", minHeight: 44, textAlign: "start", alignItems: "start", whiteSpace: "normal" }} onClick={onToggle}>
        <Flex vertical className="task-board-team-step-title" style={{ flex: 1, minWidth: 0 }}>
          <Typography.Text type="secondary" ellipsis>{who} · #{step.seq}</Typography.Text>
          <Typography.Text strong ellipsis>{step.title || (step.kind === "leader" ? "负责人决策" : "成员步骤")}</Typography.Text>
        </Flex>
        <Tag className="task-board-team-step-status" color={step.status === "running" ? "processing" : step.status === "done" ? "success" : step.status === "failed" ? "error" : undefined}>
          {live ?? (waitsOn.length ? `等待 ${waitsOn.join("、")}` : STEP_STATUS[step.status])}
        </Tag>
        <WandIcon name={open ? "chevronUp" : "chevronDown"} size={14}/>
      </WandButton>
      {step.report && !open ? <Typography.Paragraph className="task-board-team-step-preview" ellipsis={{ rows: 2 }} style={{ whiteSpace: "pre-wrap", margin: "8px 0 0" }}>{step.report}</Typography.Paragraph> : null}
      <Collapse ghost bordered={false} activeKey={open ? ["step"] : []}
        styles={{ header: { display: "none" }, body: { padding: "8px 0 0" } }}
        items={[{ key: "step", label: "步骤详情", showArrow: false, forceRender: true, children:
          <Flex vertical gap={8} className="task-board-team-step-body" inert={!open}>
            <Descriptions size="small" column={1} layout="vertical" items={[
              ...(step.instructions ? [{ key: "instructions", label: step.kind === "leader" ? "发给负责人" : "任务说明", children: <Typography.Paragraph style={{ maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}>{step.instructions}</Typography.Paragraph> }] : []),
              ...(step.report ? [{ key: "report", label: step.kind === "leader" ? "负责人说明" : "报告", children: <Typography.Paragraph style={{ maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}>{step.report}</Typography.Paragraph> }] : []),
              { key: "file", label: "报告文件", children: <Typography.Text code style={{ overflowWrap: "anywhere" }}>{step.reportPath}</Typography.Text> },
            ]}/>
            {step.sessionId && onOpenSession ? <Flex wrap gap={8}>
              <WandButton kind="ghost" size="small" onClick={() => onOpenSession(step.sessionId!)}>
                <WandIcon name="terminal" size={14} slot="start"/>打开会话
              </WandButton>
            </Flex> : null}
            {canComplete ? <Flex vertical gap={8} className="task-board-team-manual">
              <Input.TextArea rows={3} value={report} placeholder="成员没有写报告文件时，在这里补一段结果再手动完成" aria-label="手动完成的报告" onChange={(event) => setReport(event.currentTarget.value)}/>
              <ActionButton id={`complete-${step.id}`} state={actions} label="手动完成此步" pendingLabel="提交中…" onClick={() => onComplete(report)}/>
            </Flex> : null}
          </Flex> }]}/>
      {skipped.length ? <Flex vertical gap={4} className="task-board-team-step-skips" data-open={skippedOpen || undefined}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented || !skippedOpen) return;
          event.preventDefault(); event.stopPropagation(); setSkippedOpen(false); skippedTriggerRef.current?.focus();
        }}>
        <WandButton kind="ghost" type="button" ref={skippedTriggerRef} className="task-board-team-step-skip-head" aria-expanded={skippedOpen}
          style={{ width: "100%", height: "auto", minHeight: 44, whiteSpace: "normal" }} onClick={() => setSkippedOpen((current) => !current)}>
          <WandIcon name="warning" size={13}/>
          <Typography.Text style={{ flex: 1 }}>备用候选 {skipped.map((item) => item.candidate).join("、")} 没用上</Typography.Text>
          <WandIcon name={skippedOpen ? "chevronUp" : "chevronDown"} size={14}/>
        </WandButton>
        <Collapse ghost bordered={false} activeKey={skippedOpen ? ["skipped"] : []}
          styles={{ header: { display: "none" }, body: { padding: 0 } }}
          items={[{ key: "skipped", label: "备用候选跳过原因", showArrow: false, forceRender: true, children:
            <div className="task-board-team-step-skip-body" inert={!skippedOpen}>
              <List size="small" className="task-board-team-step-skip-inner" dataSource={skipped} renderItem={(item) => <List.Item key={item.candidate}>
                <Flex vertical gap={2}>
                  <Typography.Text strong>候选 {item.candidate} · {issueAgentProviderLabel(item.agent.provider)}</Typography.Text>
                  <Typography.Text style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.reason}</Typography.Text>
                </Flex>
              </List.Item>}/>
            </div> }]}/>
      </Flex> : null}
    </Card>
  </Flex>;
}

const RUN_VIEWS = [
  { value: "chat", label: "群聊" },
  { value: "timeline", label: "时间线" },
  { value: "members", label: "按成员" },
];

/**
 * 一次团队运行：头像条（点头像只看这位成员）、时间线 / 按成员两种视图，
 * 以及批准 / 退回 / 回复 / 停止等动作。任务详情与团队页的运行记录共用。
 */
export function TeamRunView({
  detail,
  onChange,
  onOpenSession,
}: {
  detail: AiTeamRunDetail;
  onChange(detail: AiTeamRunDetail): void;
  onOpenSession?: (sessionId: string) => void;
}): React.ReactElement {
  const { run, steps, memberStates } = detail;
  const actions = useActionState();
  const [openStepId, setOpenStepId] = React.useState("");
  const [focusMember, setFocusMember] = React.useState("");
  const [view, setView] = React.useState("chat");
  const [text, setText] = React.useState("");
  const [error, setError] = React.useState("");
  const status = RUN_STATUS[run.status];
  const active = ACTIVE.includes(run.status);
  const budgetSpent = run.stepsUsed >= run.stepLimit;
  const needsYou = run.status === "awaiting_approval" || run.status === "waiting_user";
  const displayTeam = displayTeamOf(detail);
  const members = [...displayTeam.members].sort((a, b) => Number(b.isLeader) - Number(a.isLeader));

  const inputRevision = React.useRef(0);
  const currentRun = React.useRef(run.id);
  currentRun.current = run.id;
  // Status refreshes must not erase a reply being edited.
  React.useEffect(() => { setText(""); setError(""); }, [run.id]);
  React.useEffect(() => {
    currentRun.current = run.id;
    return () => { currentRun.current = ""; };
  }, [run.id]);

  const act = (task: () => Promise<AiTeamRunDetail>) => async (): Promise<void> => {
    const actionRunId = run.id;
    const revision = inputRevision.current;
    setError("");
    try {
      const next = await task();
      if (currentRun.current !== actionRunId) return;
      onChange(next);
      if (inputRevision.current === revision) setText("");
    } catch (cause) {
      if (currentRun.current === actionRunId) setError(failureMessage(cause, "操作失败。"));
      throw cause;
    }
  };

  const row = (step: AiTeamStep): React.ReactElement => <StepRow
    key={step.id}
    step={step}
    steps={steps}
    member={displayTeam.members.find((item) => item.id === step.memberId)}
    memberState={step.sessionId ? memberStates[step.sessionId] : undefined}
    open={openStepId === step.id}
    onToggle={() => setOpenStepId((current) => current === step.id ? "" : step.id)}
    onOpenSession={onOpenSession}
    onComplete={(report) => act(() => aiTeamsRepository.completeStep(run.id, step.id, report))()}
    actions={actions}
  />;

  const shown = focusMember ? steps.filter((step) => step.memberId === focusMember) : steps;
  // 点头像只看这位成员时，只剩时间线一条视图可看；tabs 收起来，容器不换。
  const activeView = focusMember ? "timeline" : view;

  return <Card size="small" className="task-board-team-run" data-status={run.status}>
    <Flex vertical gap={12}>
    <Flex align="center" wrap gap={8} className="task-board-team-run-head">
      <Typography.Text type="secondary">团队运行</Typography.Text>
      <TeamAvatarStack members={displayTeam.members} size="sm"/>
      <Typography.Text strong>{displayTeam.name}</Typography.Text>
      <WandBadge tone={status.tone}>{status.label}</WandBadge>
      <Typography.Text type="secondary" style={{ marginInlineEnd: "auto" }}>步数 {run.stepsUsed}/{run.stepLimit}</Typography.Text>
      {run.chatSessionId ? <WandButton kind="secondary" size="small" onClick={() => taskBoardController.open("", "", "teamchat", run.id)}>
        打开群聊
      </WandButton> : null}
      {active ? <ActionButton
        id="stop"
        state={actions}
        kind="danger"
        label="停止"
        pendingLabel="停止中…"
        onClick={act(() => aiTeamsRepository.stop(run.id))}
      /> : null}
    </Flex>
    <Flex gap={6} style={{ overflowX: "auto", padding: 2 }} className="task-board-team-roster" role="group" aria-label="成员">
      {members.map((member) => {
        const own = steps.filter((step) => step.memberId === member.id && step.status !== "skipped");
        const done = own.filter((step) => step.status === "done").length;
        return <WandButton kind={focusMember === member.id ? "soft" : "ghost"}
          key={member.id}
          type="button"
          className="task-board-team-roster-item"
          style={{ flexShrink: 0, height: "auto", minWidth: 64 }}
          aria-pressed={focusMember === member.id}
          title={focusMember === member.id ? "显示全部成员" : `只看${member.name}`}
          onClick={() => setFocusMember((current) => current === member.id ? "" : member.id)}
        >
          <Flex vertical align="center" gap={4}>
            <TeamAvatar member={member} state={memberAvatarState(member, steps, memberStates)} showProvider/>
            <Typography.Text ellipsis style={{ maxWidth: 72 }}>{member.name}</Typography.Text>
            <Typography.Text type="secondary">{own.length ? `${done}/${own.length}` : "待命"}</Typography.Text>
          </Flex>
        </WandButton>;
      })}
    </Flex>
    {detail.delivery?.runId === run.id ? <div hidden={activeView === "chat"} inert={activeView === "chat"}>
      <TeamDeliveryCard delivery={detail.delivery}/>
    </div> : null}
    {needsYou || !detail.delivery && run.statusDetail ? <Card size="small" className="task-board-team-banner" data-attention={needsYou || undefined}>
      <Flex vertical gap={8}>
      {!detail.delivery && run.statusDetail ? <Alert type={needsYou ? "warning" : "info"} showIcon title={run.statusDetail}/> : null}
      {needsYou ? <Flex vertical gap={8} className="task-board-team-respond">
        <Input.TextArea
          className="resize-none task-board-detail-body"
          rows={3}
          value={text}
          placeholder={run.status === "awaiting_approval" ? "退回时写下修改意见" : "回复负责人的问题或补充要求"}
          aria-label={run.status === "awaiting_approval" ? "退回意见" : "回复负责人"}
          onChange={(event) => { inputRevision.current++; setText(event.currentTarget.value); }}
        />
        <Flex justify="end" gap={8} wrap>
          {run.status === "awaiting_approval" ? <>
            <ActionButton
              id="reject"
              state={actions}
              label="退回重做"
              pendingLabel="退回中…"
              disabled={!text.trim()}
              onClick={act(() => aiTeamsRepository.reject(run.id, text))}
            />
            <ActionButton
              id="approve"
              state={actions}
              kind="primary"
              label="批准计划"
              pendingLabel="批准中…"
              onClick={act(() => aiTeamsRepository.approve(run.id))}
            />
          </> : <>
            {budgetSpent ? <ActionButton
              id="continue"
              state={actions}
              label="追加 10 步继续"
              pendingLabel="继续中…"
              onClick={act(() => aiTeamsRepository.continueRun(run.id, 10))}
            /> : null}
            <ActionButton
              id="reply"
              state={actions}
              kind="primary"
              label="发送回复"
              pendingLabel="发送中…"
              disabled={!text.trim()}
              onClick={act(() => aiTeamsRepository.reply(run.id, text))}
            />
          </>}
        </Flex>
      </Flex> : null}
      </Flex>
    </Card> : null}
    {error ? <Alert className="task-board-team-error" type="error" showIcon role="alert" title={error}/> : null}
    <Tabs className="task-board-team-views" activeKey={activeView} onChange={setView}
      destroyOnHidden={false} tabBarStyle={focusMember ? { display: "none" } : undefined}
      items={RUN_VIEWS.map((tab) => ({ key: tab.value, label: tab.label, forceRender: true, children:
        <div className="task-board-team-view" data-view={tab.value}
          data-hidden={activeView !== tab.value || undefined} inert={activeView !== tab.value}>
        {tab.value === "chat" ? <RunConversation detail={detail} active={activeView === "chat"} onOpenSession={onOpenSession}/> : null}
        {tab.value === "timeline" ? <Timeline className="task-board-team-steps" items={shown.map((step) => ({ key: step.id, color: step.status === "failed" ? "red" : step.status === "done" ? "green" : "blue", children: row(step) }))}/> : null}
        {tab.value === "members" ? <Flex vertical gap={14} className="task-board-team-groups">
          {members.map((member) => {
            const own = steps.filter((step) => step.memberId === member.id);
            return <Card size="small" key={member.id} className="task-board-team-group" title={member.name}>
              <Flex vertical gap={8}>
              <Typography.Text type="secondary">{member.duty}</Typography.Text>
              {own.length ? <List split={false} className="task-board-team-steps" dataSource={own} renderItem={(step) => <List.Item style={{ display: "block" }}>{row(step)}</List.Item>}/>
                : <Typography.Text type="secondary">还没有分到步骤。</Typography.Text>}
              </Flex>
            </Card>;
          })}
        </Flex> : null}
        </div> }))}/>
    </Flex>
  </Card>;
}

/**
 * 任务详情里的团队运行：只展示最近一次运行。交给团队的入口在指派面板的
 * 「CLI 工具」下拉里（团队与 CLI 并列），这里不再另开启动表单。
 */
export interface TaskTeamRunPanelProps {
  taskId: string;
  /** 指派面板刚把任务交给团队时加一，面板据此立即拉取新运行。 */
  refreshKey?: number;
  onOpenSession?: (sessionId: string) => void;
}

export function TaskTeamRunPanel(props: TaskTeamRunPanelProps): React.ReactElement {
  return <TaskTeamRunPanelContent key={props.taskId} {...props}/>;
}

function TaskTeamRunPanelContent({
  taskId,
  refreshKey = 0,
  onOpenSession,
}: TaskTeamRunPanelProps): React.ReactElement | null {
  const [detail, setDetail] = React.useState<AiTeamRunDetail | null>(null);
  const requestGeneration = React.useRef(0);
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; requestGeneration.current++; };
  }, []);
  const latestId = detail?.run.id ?? "";

  const load = React.useCallback(async () => {
    const generation = ++requestGeneration.current;
    const isCurrent = (): boolean => alive.current && generation === requestGeneration.current;
    try {
      const runs = await aiTeamsRepository.runsForTask(taskId);
      if (!isCurrent()) return;
      const next = runs[0] ? await aiTeamsRepository.detail(runs[0].id) : null;
      if (!isCurrent() || next && next.run.taskId !== taskId) return;
      setDetail((current) => next ? mergeTeamChatDetail(current, next) : null);
    } catch {
      // 拉取失败时保留上一次的内容，下一条通知会再试。
    }
  }, [taskId]);

  React.useEffect(() => {
    setDetail(null);
  }, [taskId]);

  React.useEffect(() => { void load(); }, [load, refreshKey]);

  // 运行推进全靠服务端的 ai-team-run 通知，不轮询。
  React.useEffect(() => subscribeAiTeamRunChanges((change) => {
    if (change.taskId === taskId || change.runId === latestId) void load();
  }), [latestId, load, taskId]);
  React.useEffect(() => subscribeAiTeamDefinitionChanges((teamId) => {
    if (teamId === detail?.run.teamId) void load();
  }), [detail?.run.teamId, load]);

  if (!detail) return null;
  const acceptAction = (next: AiTeamRunDetail): void => {
    if (!alive.current || next.run.taskId !== taskId || next.run.id !== latestId) return;
    // An operation receipt invalidates GETs started before that receipt.
    requestGeneration.current++;
    setDetail((current) => mergeTeamChatDetail(current, next));
  };
  return <Flex component="section" vertical gap={10} style={{ marginTop: 14 }} className="task-board-team" aria-label="AI 团队">
    <TeamRunView key={detail.run.id} detail={detail} onChange={acceptAction} onOpenSession={onOpenSession}/>
  </Flex>;
}
