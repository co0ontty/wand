import * as React from "react";
import { Alert, Card, Flex, List, Typography } from "antd";
import type { WandTaskComment } from "../../../task-types";
import { DeferredMarkdownPreview } from "../file-preview/deferred-markdown";
import { WandButton } from "../ui/button";
import { taskBoardRepository } from "./task-board-repository";

/** Read-only comments stay beside the saved brief, ahead of execution controls. */
export function TaskComments({ taskId, updatedAt }: { taskId: string; updatedAt: string }): React.ReactElement {
  const [result, setResult] = React.useState<{ taskId: string; comments: WandTaskComment[]; failed: boolean; loading: boolean }>({ taskId, comments: [], failed: false, loading: true });
  const [attempt, retry] = React.useReducer(value => value + 1, 0);
  React.useEffect(() => {
    const controller = new AbortController();
    setResult(current => ({ taskId, comments: current.taskId === taskId ? current.comments : [], failed: false, loading: true }));
    void taskBoardRepository.comments(taskId, controller.signal).then(comments => {
      if (!controller.signal.aborted) setResult({ taskId, comments: comments.filter(comment => comment.taskId === taskId), failed: false, loading: false });
    }).catch(() => {
      if (!controller.signal.aborted) setResult(current => ({ taskId, comments: current.taskId === taskId ? current.comments : [], failed: true, loading: false }));
    });
    return () => controller.abort();
  }, [taskId, updatedAt, attempt]);
  const comments = result.taskId === taskId ? result.comments : [];
  const failed = result.taskId === taskId && result.failed;
  const loading = result.taskId !== taskId || result.loading;
  return <Card size="small" title={`评论${comments.length ? ` · ${comments.length}` : ""}`} role="region" aria-label="任务评论" aria-busy={loading}
    extra={<WandButton kind="ghost" size="small" disabled={loading} onClick={retry}>刷新评论</WandButton>}>
    <Flex vertical gap="small" className="task-board-detail-content">
      {failed ? <Alert type="warning" title="评论暂时加载失败" action={<WandButton kind="ghost" size="small" onClick={retry}>重试</WandButton>}/> : null}
      {!comments.length && !failed ? <Typography.Text type="secondary" role="status">{loading ? "正在加载评论…" : "暂无评论，任务背景与要求请查看上方描述。"}</Typography.Text> : null}
      {comments.length ? <>
        <Typography.Text type="secondary">最近 {comments.length} 条 · 最新在前 · 只读</Typography.Text>
        <List size="small" dataSource={comments} renderItem={comment => <List.Item key={comment.id}>
          <Flex vertical gap="small" style={{ width: "100%", minWidth: 0 }}>
            <Flex wrap gap="small" align="center">
              <Typography.Text strong>{comment.authorName}</Typography.Text>
              <Typography.Text type="secondary"><time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time></Typography.Text>
            </Flex>
            <DeferredMarkdownPreview content={comment.body} variant="inline" wrap/>
          </Flex>
        </List.Item>}/>
      </> : null}
    </Flex>
  </Card>;
}
