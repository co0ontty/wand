import * as React from "react";
import type { AiTeamRunDetail, AiTeamStep } from "../../../ai-team-types";
import { failureMessage } from "../errors";
import { RUN_STATUS } from "../issues/team-run-panel";
import { taskBoardController } from "../issues/task-board-controller";
import { SidebarToggleIcon } from "../shell/sidebar-toggle-icon";
import { WandBadge, WandBreadcrumb, WandButton, WandIcon, WandIconButton } from "../ui";
import { TeamAvatar, type TeamAvatarState } from "./avatar";
import { aiTeamsRepository, subscribeAiTeamDefinitionChanges, subscribeAiTeamRunChanges } from "./repository";
import { displayTeamOf, mergeTeamChatDetail, TeamChatView } from "./team-chat-view";

const STEP_LABEL: Record<AiTeamStep["status"], string> = {
  queued: "排队",
  running: "进行中",
  done: "完成",
  failed: "失败",
  skipped: "跳过",
};

/**
 * 同一个群聊会话上更新的运行；没有就返回 null。跟随失败（网络抖动）不影响当前这一轮的显示。
 */
async function newerRunIdOnSameChat(detail: AiTeamRunDetail): Promise<string | null> {
  const chatSessionId = detail.run.chatSessionId;
  if (!chatSessionId) return null;
  try {
    const sameChat = await aiTeamsRepository.runsForChat(detail.run.taskId, chatSessionId);
    const newest = sameChat[0];
    return newest && newest.id !== detail.run.id ? newest.id : null;
  } catch {
    return null;
  }
}

/** 步骤状态 → 头像状态环：目录里的二级只表达这一步此刻的进展。 */
function stepAvatarState(status: AiTeamStep["status"]): TeamAvatarState {
  if (status === "running") return "working";
  if (status === "done") return "done";
  if (status === "failed") return "failed";
  return "idle";
}

/**
 * 对话区下方的「工作任务」二级目录：一级是本次运行派发给成员的工作步骤（AiTeamStep，kind=work），
 * 二级展开显示归属成员（头像/名字/职责）、状态、报告文件，并复用群聊页的成员跳转打开该步骤会话。
 * 数据来自 detail.steps / displayTeam（执行仍用 run.team 快照），运行推进靠服务端通知重拉。
 */
function WorkTaskTree({
  detail,
  onOpenSession,
}: {
  detail: AiTeamRunDetail;
  onOpenSession?: (sessionId: string) => void;
}): React.ReactElement {
  const [openIds, setOpenIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const steps = detail.steps.filter((step) => step.kind === "work");
  const done = steps.filter((step) => step.status === "done").length;
  const toggle = (id: string): void => {
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  return <section className="wand-team-work-tasks" aria-label="工作任务">
    <div className="wand-team-work-tasks-inner">
      <header className="wand-team-work-tasks-head">
        <h2>工作任务</h2>
        <small>{steps.length ? `${done}/${steps.length} 完成` : "等待派工"}</small>
      </header>
      {steps.length ? <ol className="wand-team-work-list">
        {steps.map((step) => {
          const member = displayTeamOf(detail).members.find((item) => item.id === step.memberId);
          const open = openIds.has(step.id);
          return <li key={step.id} className="wand-team-work-item" data-status={step.status} data-open={open || undefined}>
            <button type="button" className="wand-team-work-head" aria-expanded={open} onClick={() => toggle(step.id)}>
              <span className="wand-team-work-seq">#{step.seq}</span>
              <span className="wand-team-work-title">{step.title || "成员步骤"}</span>
              <span className="wand-team-work-status">{STEP_LABEL[step.status]}</span>
              <WandIcon name="chevronDown" size={14}/>
            </button>
            <div className="wand-team-work-body" data-open={open || undefined} inert={!open}>
              <div className="wand-team-work-body-inner">
                <div className="wand-team-work-member">
                  {member ? <TeamAvatar member={member} size="sm" state={stepAvatarState(step.status)}/> : null}
                  <span className="wand-team-work-member-name">{member?.name ?? step.memberId}</span>
                  {member?.duty ? <small className="wand-team-work-member-duty">{member.duty}</small> : null}
                </div>
                <dl className="wand-team-work-meta">
                  <div><dt>状态</dt><dd>{STEP_LABEL[step.status]}</dd></div>
                  {step.reportPath ? <div><dt>报告文件</dt><dd><code>{step.reportPath}</code></dd></div> : null}
                </dl>
                {step.report ? <p className="wand-team-work-report">{step.report}</p> : null}
                {step.sessionId && onOpenSession ? <WandButton kind="ghost" size="small" onClick={() => onOpenSession(step.sessionId!)}>
                  <WandIcon name="terminal" size={14} slot="start"/>打开会话
                </WandButton> : null}
              </div>
            </div>
          </li>;
        })}
      </ol> : <p className="wand-team-empty-line">负责人还没有派发工作任务。</p>}
    </div>
  </section>;
}

/**
 * 独立群聊页：从侧栏点群聊条目进入（`?view=teamchat&run=<runId>`），
 * 以 IM 形式渲染 TeamChatView（头像 + 发言人分层），推进靠 ai-team-run 通知，不轮询。
 * 顶部沿用看板页的 header 体系，返回按钮 / Esc 一步回到原会话视图。
 */
export interface TeamChatPageProps {
  runId: string;
  sidebarOpen?: boolean;
  onBack?(): void;
  onOpenSidebar?(): void;
  onOpenSession?(sessionId: string): void;
}

export function TeamChatPage({
  runId,
  sidebarOpen = false,
  onBack,
  onOpenSidebar,
  onOpenSession,
}: TeamChatPageProps): React.ReactElement {
  const [detail, setDetail] = React.useState<AiTeamRunDetail | null>(null);
  const [error, setError] = React.useState("");
  const currentRunRef = React.useRef(runId);
  currentRunRef.current = runId;
  const loadEpochRef = React.useRef(0);
  // 跟随同一 relay 的新运行时保留视图实例，草稿和上滚位置由它继续持有。
  const continuingRunRef = React.useRef("");
  const visibleDetail = detail && (detail.run.id === runId || continuingRunRef.current === runId)
    ? detail : null;
  const showingPreviousRun = !!visibleDetail && visibleDetail.run.id !== runId;
  const taskId = visibleDetail?.run.taskId ?? "";

  React.useEffect(() => () => { loadEpochRef.current++; }, []);

  const load = React.useCallback(async () => {
    const epoch = ++loadEpochRef.current;
    if (!runId) {
      setError("没有要打开的群聊。");
      return;
    }
    setError("");
    try {
      const next = await aiTeamsRepository.detail(runId);
      if (epoch !== loadEpochRef.current || currentRunRef.current !== runId) return;
      // 群聊绑的是 chat 会话，不是某一次运行：用户在群里接着说话时服务端会在同一个群聊上开新一轮，
      // 这里原地跟着切过去（地址栏 replace，返回键行为仍是一步回到原会话），
      // 否则状态条、工作任务和步骤报告都停在旧的一轮，新一轮的活根本看不到。
      const newer = await newerRunIdOnSameChat(next);
      if (epoch !== loadEpochRef.current || currentRunRef.current !== runId) return;
      if (newer) {
        continuingRunRef.current = newer;
        taskBoardController.open("", "", "teamchat", newer);
        return;
      }
      setDetail((current) => mergeTeamChatDetail(current, next));
      continuingRunRef.current = "";
      setError("");
    } catch (cause) {
      if (epoch !== loadEpochRef.current || currentRunRef.current !== runId) return;
      const message = failureMessage(cause, "群聊加载失败。");
      setError(continuingRunRef.current === runId
        ? `新一轮加载失败，当前显示上一轮记录。${message}` : message);
    }
  }, [runId]);

  React.useEffect(() => {
    if (continuingRunRef.current !== runId) {
      continuingRunRef.current = "";
      setDetail(null);
    }
    setError("");
    void load();
  }, [load]);

  React.useEffect(() => subscribeAiTeamRunChanges((change) => {
    // 新一轮的 runId 和当前页不同，所以还要按任务 id 收通知，才跟得上「接着开一轮」。
    if (change.runId === runId || (taskId && change.taskId === taskId)) void load();
  }), [load, runId, taskId]);
  React.useEffect(() => subscribeAiTeamDefinitionChanges((teamId) => {
    if (teamId === visibleDetail?.run.teamId) void load();
  }), [load, visibleDetail?.run.teamId]);

  const onDetailChange = React.useCallback((next: AiTeamRunDetail): void => {
    // 发送后的旧 run 重拉可能晚于导航，不能将新一轮的标题、状态和任务拉回旧版。
    if (next.run.id === currentRunRef.current) {
      setDetail((current) => mergeTeamChatDetail(current, next));
    }
  }, []);

  const back = React.useCallback(() => {
    if (onBack) onBack();
    else taskBoardController.close();
  }, [onBack]);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true'], [role='dialog']")) return;
      back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back]);

  const status = visibleDetail && !showingPreviousRun
    ? RUN_STATUS[visibleDetail.run.status] : null;
  return <section className="task-board-native-page wand-team-chat-page" aria-label="群聊">
    <header className="task-board-workspace-header">
      <div className="task-board-kicker">
        {onOpenSidebar ? <WandIconButton
          className="task-board-icon-button"
          aria-label={sidebarOpen ? "关闭任务列表" : "打开任务"}
          onClick={onOpenSidebar}
        >
          <SidebarToggleIcon open={sidebarOpen} size={16}/>
        </WandIconButton> : null}
        <WandIconButton
          className="task-board-icon-button"
          aria-label="返回上一会话"
          title="返回上一会话"
          onClick={back}
        >
          <WandIcon name="chevronLeft"/>
        </WandIconButton>
        <div className="task-board-heading-copy">
          <WandBreadcrumb
            variant="title"
            className="wand-team-chat-crumb"
            ariaLabel="群聊导航"
            items={[
              { label: "任务看板", onNavigate: () => taskBoardController.open("", "", "board") },
              { label: visibleDetail ? displayTeamOf(visibleDetail).name : "群聊" },
            ]}
          />
          <p>{showingPreviousRun
            ? error ? "上一轮记录 · 新一轮加载失败" : "上一轮记录 · 正在接入新一轮…"
            : visibleDetail ? `${displayTeamOf(visibleDetail).members.length} 位成员 · 团队群聊`
              : error || "正在加载群聊…"}</p>
        </div>
      </div>
      {visibleDetail && status ? <div className="task-board-header-actions wand-team-chat-head-meta">
        <WandBadge tone={status.tone}>{status.label}</WandBadge>
      </div> : null}
    </header>
    {error ? <div className="task-board-native-banner is-error" role="alert">
      <span>{error}</span>
      {runId ? <WandButton kind="ghost" size="small" onClick={() => void load()}>重新加载</WandButton> : null}
    </div> : null}
    <div className="wand-team-chat-body">
      {visibleDetail ? <TeamChatView
        detail={visibleDetail}
        staleRun={showingPreviousRun}
        onChange={onDetailChange}
        onOpenSession={onOpenSession}
        details={<>
          <WorkTaskTree detail={visibleDetail} onOpenSession={onOpenSession}/>
          {visibleDetail.run.chatSessionId && onOpenSession ? <WandButton
            kind="ghost"
            size="small"
            onClick={() => onOpenSession(visibleDetail.run.chatSessionId!)}
          >查看完整会话记录</WandButton> : null}
        </>}
      />
        : !error ? <p className="wand-team-empty-line">正在加载…</p> : null}
    </div>
  </section>;
}
