import * as React from "react";
import { Alert, Card, Collapse, Descriptions, Flex, List, Tag, Typography } from "antd";
import type { AiTeamRunDetail, AiTeamStep } from "../../../ai-team-types";
import { failureMessage } from "../errors";
import { RUN_STATUS } from "../issues/team-run-panel";
import { taskBoardController } from "../issues/task-board-controller";
import { SidebarToggleIcon } from "../shell/sidebar-toggle-icon";
import { subscribeTaskChanges } from "../task-changes";
import { conversationUi } from "../conversations/state";
import { WandBadge, WandBreadcrumb, WandButton, WandIcon, WandIconButton } from "../ui";
import { TeamAvatar, TeamAvatarStack, type TeamAvatarState } from "./avatar";
import { aiTeamsRepository, subscribeAiTeamDefinitionChanges, subscribeAiTeamRunChanges } from "./repository";
import { displayTeamOf, mergeTeamChatDetail, TeamChatView } from "./team-chat-view";

const STEP_TAG_COLOR: Record<AiTeamStep["status"], string | undefined> = {
  queued: undefined,
  running: "processing",
  done: "success",
  failed: "error",
  skipped: undefined,
};

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
  return <Card size="small" className="wand-team-work-tasks" aria-label="工作任务"
    title="工作任务" extra={<Typography.Text type="secondary">{steps.length ? `${done}/${steps.length} 完成` : "等待派工"}</Typography.Text>}>
    {steps.length ? <List className="wand-team-work-list" split={false} dataSource={steps}
      renderItem={(step) => {
        const member = displayTeamOf(detail).members.find((item) => item.id === step.memberId);
        const open = openIds.has(step.id);
        return <List.Item key={step.id} style={{ display: "block" }}>
          <Card size="small" className="wand-team-work-item" data-status={step.status} data-open={open || undefined}>
            <WandButton kind="ghost" type="button" className="wand-team-work-head" aria-expanded={open}
              style={{ width: "100%", height: "auto", minHeight: 44, textAlign: "start" }} onClick={() => toggle(step.id)}>
              <Typography.Text type="secondary" className="wand-team-work-seq">#{step.seq}</Typography.Text>
              <Typography.Text ellipsis className="wand-team-work-title" style={{ flex: 1, minWidth: 0 }}>{step.title || "成员步骤"}</Typography.Text>
              <Tag className="wand-team-work-status" color={STEP_TAG_COLOR[step.status]}>{STEP_LABEL[step.status]}</Tag>
              <WandIcon name={open ? "chevronUp" : "chevronDown"} size={14}/>
            </WandButton>
            <Collapse ghost bordered={false} activeKey={open ? ["step"] : []}
              styles={{ header: { display: "none" }, body: { padding: "8px 0 0" } }}
              items={[{ key: "step", label: "工作任务详情", showArrow: false, forceRender: true, children:
                <Flex vertical gap={8} className="wand-team-work-body" data-open={open || undefined} inert={!open}>
                  <Flex align="center" gap={8} wrap className="wand-team-work-member">
                    {member ? <TeamAvatar member={member} size="sm" state={stepAvatarState(step.status)}/> : null}
                    <Typography.Text className="wand-team-work-member-name">{member?.name ?? step.memberId}</Typography.Text>
                    {member?.duty ? <Typography.Text type="secondary" className="wand-team-work-member-duty">{member.duty}</Typography.Text> : null}
                  </Flex>
                  <Descriptions size="small" column={1} className="wand-team-work-meta" items={[
                    { key: "status", label: "状态", children: STEP_LABEL[step.status] },
                    ...(step.reportPath ? [{ key: "report", label: "报告文件", children: <Typography.Text code style={{ overflowWrap: "anywhere" }}>{step.reportPath}</Typography.Text> }] : []),
                  ]}/>
                  {step.report ? <Typography.Paragraph className="wand-team-work-report" style={{ maxHeight: 180, margin: 0, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{step.report}</Typography.Paragraph> : null}
                  {step.sessionId && onOpenSession ? <WandButton kind="ghost" size="small" onClick={() => onOpenSession(step.sessionId!)}>
                    <WandIcon name="terminal" size={14} slot="start"/>打开会话
                  </WandButton> : null}
                </Flex> }]}/>
          </Card>
        </List.Item>;
      }}
    /> : <Typography.Text type="secondary">负责人还没有派发工作任务。</Typography.Text>}
  </Card>;
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
      if (next.run.conversationId) {
        taskBoardController.close();
        conversationUi.select(next.run.conversationId);
        return;
      }
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
  React.useEffect(() => subscribeTaskChanges(() => { void load(); }), [load]);

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
  return <Flex component="section" vertical className="task-board-native-page wand-team-chat-page" aria-label="群聊" style={{ position: "absolute", inset: 0, zIndex: 8, overflow: "hidden", minWidth: 0, minHeight: 0, background: "var(--bg-primary)" }}>
    <Flex component="header" wrap align="center" justify="space-between" gap="small" className="task-board-workspace-header" style={{ flexShrink: 0, padding: 16 }}>
      <Flex align="center" gap="small" className="task-board-kicker" style={{ minWidth: 0 }}>
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
        {visibleDetail ? <span className="wand-team-chat-heading-avatar" aria-hidden="true">
          <TeamAvatarStack members={displayTeamOf(visibleDetail).members} max={2} size="sm" />
        </span> : null}
        <div className="task-board-heading-copy">
          <WandBreadcrumb
            variant="title"
            className="wand-team-chat-crumb"
            ariaLabel="群聊导航"
            items={[
              { label: "任务看板", onNavigate: () => taskBoardController.open("", "", "board") },
              { label: visibleDetail?.chatTitle || "任务处理群" },
            ]}
          />
          <Typography.Paragraph type="secondary" style={{ margin: 0 }}>{showingPreviousRun
            ? error ? "上一轮记录 · 新一轮加载失败" : "上一轮记录 · 正在接入新一轮…"
            : visibleDetail ? `${displayTeamOf(visibleDetail).members.length} 位成员 · 团队群聊`
              : error || "正在加载群聊…"}</Typography.Paragraph>
        </div>
      </Flex>
      {visibleDetail && status ? <Flex align="center" gap="small" className="task-board-header-actions wand-team-chat-head-meta">
        <WandBadge tone={status.tone}>{status.label}</WandBadge>
      </Flex> : null}
    </Flex>
    {error ? <Alert type="error" showIcon role="alert" title={error}
      action={runId ? <WandButton kind="ghost" size="small" onClick={() => void load()}>重新加载</WandButton> : undefined}/> : null}
    <div className="wand-team-chat-body" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
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
        : !error ? <Typography.Text type="secondary">正在加载…</Typography.Text> : null}
    </div>
  </Flex>;
}
