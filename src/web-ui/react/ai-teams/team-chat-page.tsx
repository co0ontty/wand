import * as React from "react";
import { Alert, Flex, Typography } from "antd";
import { AI_TEAM_ACTIVE_RUN_STATUSES } from "../../../ai-team-types";
import { failureMessage } from "../errors";
import { taskBoardController } from "../issues/task-board-controller";
import { SidebarToggleIcon } from "../shell/sidebar-toggle-icon";
import { conversationUi } from "../conversations/state";
import { conversationsRepository } from "../conversations/repository";
import { conversationForRun } from "../conversations/run-route";
import { WandButton, WandIcon, WandIconButton } from "../ui";
import { aiTeamsRepository } from "./repository";

/** Old run URLs resolve to the canonical conversation instead of mounting another chat page. */
export interface TeamChatPageProps {
  runId: string;
  sidebarOpen?: boolean;
  onBack?(): void;
  onOpenSidebar?(): void;
  onOpenSession?(sessionId: string): void;
}

export function TeamChatPage({ runId, sidebarOpen = false, onBack, onOpenSidebar, onOpenSession }: TeamChatPageProps): React.ReactElement {
  const [error, setError] = React.useState("");
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [retry, setRetry] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    const selection = conversationUi.selectionRevision();
    setError(""); setSessionId(null);
    void (async () => {
      try {
        const detail = await aiTeamsRepository.detail(runId);
        const id = conversationForRun(detail.run) ?? conversationForRun(detail.run, await conversationsRepository.list());
        if (!active || selection !== conversationUi.selectionRevision()) return;
        if (!id) {
          setSessionId(detail.run.chatSessionId ?? null);
          throw new Error("此运行尚未关联群对话，请核对服务版本后重试。");
        }
        taskBoardController.close();
        conversationUi.openTask(id, detail.run.taskId, AI_TEAM_ACTIVE_RUN_STATUSES.includes(detail.run.status) ? detail.run.id : null);
      } catch (cause) { if (active && selection === conversationUi.selectionRevision()) setError(failureMessage(cause, "对话加载失败。")); }
    })();
    return () => { active = false; };
  }, [runId, retry]);
  const back = React.useCallback(() => { if (onBack) onBack(); else taskBoardController.close(); }, [onBack]);
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key === "Escape" && !event.defaultPrevented && !target?.closest("input, textarea, [contenteditable='true'], [role='dialog']")) back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back]);
  return <Flex component="section" vertical className="task-board-native-page wand-team-chat-page" aria-label="打开任务对话"
    style={{ position: "absolute", inset: 0, zIndex: 8, overflow: "hidden", background: "var(--bg-primary)" }}>
    <Flex component="header" align="center" gap="small" style={{ padding: 16 }}>
      {onOpenSidebar ? <WandIconButton aria-label={sidebarOpen ? "关闭任务列表" : "打开任务"} onClick={onOpenSidebar}><SidebarToggleIcon open={sidebarOpen}/></WandIconButton> : null}
      <WandIconButton aria-label="返回上一会话" onClick={back}><WandIcon name="chevronLeft"/></WandIconButton>
      <Typography.Text strong>任务对话</Typography.Text>
    </Flex>
    {error ? <Alert type="error" showIcon role="alert" title={error} action={<WandButton onClick={() => setRetry(value => value + 1)}>重试</WandButton>}/>
      : <Typography.Text type="secondary" role="status">正在打开对话…</Typography.Text>}
    {error && sessionId && onOpenSession ? <WandButton onClick={() => onOpenSession(sessionId)}>查看原会话记录</WandButton> : null}
  </Flex>;
}
