import * as React from "react";
import type { AgentActivityState } from "../../../mission-types";
import {
  aiTeamsRepository,
  subscribeAiTeamRunChanges,
  type AiTeamMember,
  type AiTeamRun,
  type AiTeamRunDetail,
  type AiTeamStep,
} from "../ai-teams/repository";
import { TeamAvatar, TeamAvatarStack, type TeamAvatarState } from "../ai-teams/avatar";
import { TeamChatView } from "../ai-teams/team-chat-view";
import { failureMessage } from "../errors";
import { issueAgentProviderLabel } from "./task-board-agent";
import { taskBoardController } from "./task-board-controller";
import { MOTION_DWELL_FAILED_MS, MOTION_DWELL_SENT_MS } from "../ui/motion-tokens";
import { WandBadge, WandButton, WandIcon, WandStretchTabs } from "../ui";

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
  const skipped = step.dispatchInfo?.skipped ?? [];
  const live = memberState ? MEMBER_STATE[memberState] : undefined;
  const canComplete = step.kind === "work" && step.status === "running";
  const waitsOn = step.status === "queued"
    ? step.dependsOn.map((id) => steps.find((item) => item.id === id))
      .filter((item): item is AiTeamStep => !!item && item.status !== "done")
      .map((item) => `#${item.seq}`)
    : [];
  return <li
    className="task-board-team-step"
    data-status={step.status}
    data-kind={step.kind}
    data-open={open || undefined}
  >
    {member ? <TeamAvatar member={member} size="sm" state={stepAvatarState(step, memberState)}/> : <span/>}
    <div className="task-board-team-step-card">
      <button type="button" className="task-board-team-step-head" aria-expanded={open} onClick={onToggle}>
        <span className="task-board-team-step-title">
          <small>{who} · #{step.seq}</small>
          <strong>{step.title || (step.kind === "leader" ? "负责人决策" : "成员步骤")}</strong>
        </span>
        <span className="task-board-team-step-status">
          {live ?? (waitsOn.length ? `等待 ${waitsOn.join("、")}` : STEP_STATUS[step.status])}
        </span>
        <WandIcon name="chevronDown" size={14}/>
      </button>
      {step.report && !open ? <p className="task-board-team-step-preview">{step.report}</p> : null}
      <div className="task-board-team-step-body" inert={!open}>
        <div className="task-board-team-step-inner">
          {step.instructions ? <section>
            <h4>{step.kind === "leader" ? "发给负责人" : "任务说明"}</h4>
            <pre>{step.instructions}</pre>
          </section> : null}
          {step.report ? <section>
            <h4>{step.kind === "leader" ? "负责人说明" : "报告"}</h4>
            <pre>{step.report}</pre>
          </section> : null}
          <p className="task-board-team-step-meta">报告文件：<code>{step.reportPath}</code></p>
          {step.sessionId && onOpenSession ? <div className="task-board-native-editor-actions">
            <WandButton kind="ghost" size="small" onClick={() => onOpenSession(step.sessionId!)}>
              <WandIcon name="terminal" size={14} slot="start"/>打开会话
            </WandButton>
          </div> : null}
          {canComplete ? <div className="task-board-team-manual">
            <textarea
              className="resize-none task-board-detail-body"
              rows={3}
              value={report}
              placeholder="成员没有写报告文件时，在这里补一段结果再手动完成"
              aria-label="手动完成的报告"
              onChange={(event) => setReport(event.currentTarget.value)}
            />
            <ActionButton
              id={`complete-${step.id}`}
              state={actions}
              label="手动完成此步"
              pendingLabel="提交中…"
              onClick={() => onComplete(report)}
            />
          </div> : null}
        </div>
      </div>
      {skipped.length ? <div className="task-board-team-step-skips" data-open={skippedOpen || undefined}>
        <button
          type="button"
          className="task-board-team-step-skip-head"
          aria-expanded={skippedOpen}
          onClick={() => setSkippedOpen((current) => !current)}
        >
          <WandIcon name="warning" size={13}/>
          <span>备用候选 {skipped.map((item) => item.candidate).join("、")} 没用上</span>
          <WandIcon name="chevronDown" size={14}/>
        </button>
        <div className="task-board-team-step-skip-body" inert={!skippedOpen}>
          <ul className="task-board-team-step-skip-inner">
            {skipped.map((item) => <li key={item.candidate}>
              <strong>候选 {item.candidate} · {issueAgentProviderLabel(item.agent.provider)}</strong>
              <span>{item.reason}</span>
            </li>)}
          </ul>
        </div>
      </div> : null}
    </div>
  </li>;
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
  const members = [...run.team.members].sort((a, b) => Number(b.isLeader) - Number(a.isLeader));

  // 切到另一次运行，或运行进入新的等待态时，清掉上一轮的输入。
  React.useEffect(() => { setText(""); setError(""); }, [run.id, run.status]);

  const act = (task: () => Promise<AiTeamRunDetail>) => async (): Promise<void> => {
    setError("");
    try {
      onChange(await task());
      setText("");
    } catch (cause) {
      setError(failureMessage(cause, "操作失败。"));
      throw cause;
    }
  };

  const row = (step: AiTeamStep): React.ReactElement => <StepRow
    key={step.id}
    step={step}
    steps={steps}
    member={run.team.members.find((item) => item.id === step.memberId)}
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

  return <div className="task-board-team-run" data-status={run.status}>
    <div className="task-board-team-run-head">
      <span className="task-board-team-run-kicker">团队运行</span>
      <TeamAvatarStack members={run.team.members} size="sm"/>
      <strong>{run.team.name}</strong>
      <WandBadge tone={status.tone}>{status.label}</WandBadge>
      <small>步数 {run.stepsUsed}/{run.stepLimit}</small>
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
    </div>
    <div className="task-board-team-roster" role="group" aria-label="成员">
      {members.map((member) => {
        const own = steps.filter((step) => step.memberId === member.id && step.status !== "skipped");
        const done = own.filter((step) => step.status === "done").length;
        return <button
          key={member.id}
          type="button"
          className="task-board-team-roster-item"
          aria-pressed={focusMember === member.id}
          title={focusMember === member.id ? "显示全部成员" : `只看${member.name}`}
          onClick={() => setFocusMember((current) => current === member.id ? "" : member.id)}
        >
          <TeamAvatar member={member} state={memberAvatarState(member, steps, memberStates)} showProvider/>
          <span>{member.name}</span>
          <small>{own.length ? `${done}/${own.length}` : "待命"}</small>
        </button>;
      })}
    </div>
    {needsYou || run.statusDetail ? <div className="task-board-team-banner" data-attention={needsYou || undefined}>
      {run.statusDetail ? <p>{run.statusDetail}</p> : null}
      {needsYou ? <div className="task-board-team-respond">
        <textarea
          className="resize-none task-board-detail-body"
          rows={3}
          value={text}
          placeholder={run.status === "awaiting_approval" ? "退回时写下修改意见" : "回复负责人的问题或补充要求"}
          aria-label={run.status === "awaiting_approval" ? "退回意见" : "回复负责人"}
          onChange={(event) => setText(event.currentTarget.value)}
        />
        <div className="task-board-native-editor-actions">
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
        </div>
      </div> : null}
    </div> : null}
    {error ? <p className="task-board-team-error" role="alert">{error}</p> : null}
    {focusMember ? null : <WandStretchTabs
      tabs={RUN_VIEWS}
      value={view}
      ariaLabel="运行视图"
      className="task-board-team-views"
      onValueChange={setView}
    />}
    <div className="task-board-team-views-stack">
      {RUN_VIEWS.map((tab) => <div
        key={tab.value}
        className="task-board-team-view"
        data-view={tab.value}
        data-hidden={activeView !== tab.value || undefined}
        inert={activeView !== tab.value}
      >
        {tab.value === "chat" ? <TeamChatView detail={detail} onChange={onChange} onOpenSession={onOpenSession}/> : null}
        {tab.value === "timeline" ? <ol className="task-board-team-steps">{shown.map(row)}</ol> : null}
        {tab.value === "members" ? <div className="task-board-team-groups">
          {members.map((member) => {
            const own = steps.filter((step) => step.memberId === member.id);
            return <section key={member.id} className="task-board-team-group">
              <header>
                <strong>{member.name}</strong>
                <small>{member.duty}</small>
              </header>
              {own.length ? <ol className="task-board-team-steps">{own.map(row)}</ol>
                : <p className="task-board-team-run-detail">还没有分到步骤。</p>}
            </section>;
          })}
        </div> : null}
      </div>)}
    </div>
  </div>;
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

export function TaskTeamRunPanel({
  taskId,
  refreshKey = 0,
  onOpenSession,
}: TaskTeamRunPanelProps): React.ReactElement | null {
  const [detail, setDetail] = React.useState<AiTeamRunDetail | null>(null);
  const latestId = detail?.run.id ?? "";

  const load = React.useCallback(async () => {
    try {
      const runs = await aiTeamsRepository.runsForTask(taskId);
      setDetail(runs[0] ? await aiTeamsRepository.detail(runs[0].id) : null);
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

  if (!detail) return null;
  return <section className="task-board-team" aria-label="AI 团队">
    <TeamRunView detail={detail} onChange={setDetail} onOpenSession={onOpenSession}/>
  </section>;
}
