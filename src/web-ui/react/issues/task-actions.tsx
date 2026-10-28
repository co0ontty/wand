import * as React from "react";
import { Alert, Card, Collapse, Empty, Flex, Skeleton, Tag, Typography } from "antd";
import type { TaskActionItem, TaskActionsSnapshot } from "../../../task-action-types.js";
import { requestJson, HttpResponseError } from "../http-adapter";
import { WandButton, WandStretchTabs } from "../ui";
import { SidebarProjectionSwap } from "../workspaces/sidebar-projection-swap";
import { subscribeTaskChanges } from "../task-changes";
import { subscribeAiTeamRunChanges } from "../ai-teams/repository";
import { taskBoardController } from "./task-board-controller";
import { installStyleSheet } from "../styles";

if (typeof document !== "undefined") installStyleSheet("wand-task-actions", String.raw`
.task-actions .wand-ui-stretch-tabs { align-self:flex-start; max-width:100%; }
.task-actions .ant-segmented-item-label { min-height:44px; display:flex; align-items:center; }
.task-actions-row { display:flex; align-items:center; gap:16px; min-width:0; }
.task-actions-copy { display:flex; flex-direction:column; gap:4px; min-width:0; flex:1; }
.task-actions-title,.task-actions-reason { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.task-actions-next { flex-shrink:0; color:var(--accent); }
.task-actions .ant-collapse-header { min-height:44px; }
.task-actions-detail { white-space:pre-wrap; overflow-wrap:anywhere; }
.task-actions-source { font-size:12px; overflow-wrap:anywhere; color:var(--text-secondary); }
.task-actions .ant-btn { min-height:44px; }
.task-actions-scope { font-size:12px; }
@media (max-width:639px) {
  .task-actions-row { gap:8px; }
  .task-actions-title,.task-actions-reason { white-space:normal; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
  .task-actions-next { max-width:80px; }
}
`);

const labels: Record<TaskActionItem["kind"], string> = { permission: "待授权", question: "待回答", plan: "待批准计划", reply: "待回复负责人", review: "等待你验收", blocker: "验收缺口" };
const summaries: Record<TaskActionItem["kind"], string> = { permission: "查看授权", question: "回答问题", plan: "查看计划", reply: "回复负责人", review: "查看交付", blocker: "核对缺口" };
const actions: Record<TaskActionItem["kind"], string> = { permission: "查看授权请求", question: "定位待答问题", plan: "查看运行请求", reply: "回复负责人", review: "查看交付与验收", blocker: "核对交付缺口" };

/** Navigation only: source owners retain drafts, writes, receipts and acceptance. */
export function TaskActions({ workspaceId = "", active = true, onOpenSession, onOpenAcceptance }: {
  workspaceId?: string; active?: boolean; onOpenSession?(id: string): void; onOpenAcceptance(id: string): void;
}): React.ReactElement {
  const [snapshot, setSnapshot] = React.useState<TaskActionsSnapshot | null>(null);
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [tab, setTab] = React.useState("handle");
  const [expanded, setExpanded] = React.useState<string[]>([]);
  const generation = React.useRef(0);
  const root = React.useRef<HTMLElement>(null);
  const reload = React.useCallback(async () => {
    if (!active) return;
    const captured = ++generation.current;
    setLoading(true);
    try {
      const next = await requestJson<TaskActionsSnapshot>(`/api/wand-task-actions${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`, { cache: "no-store" });
      if (!Array.isArray(next.items) || !Number.isSafeInteger(next.incompleteSources) || next.incompleteSources < 0) throw Error("行动事实响应无效。");
      if (captured !== generation.current) return;
      setSnapshot(next); setError("");
    } catch (cause) {
      if (captured !== generation.current) return;
      if (cause instanceof HttpResponseError && [401, 403].includes(cause.status)) setSnapshot(null);
      setError(cause instanceof Error ? cause.message : "无法读取行动事实。");
    } finally { if (captured === generation.current) setLoading(false); }
  }, [workspaceId, active]);
  React.useEffect(() => {
    setSnapshot(null); setError(""); setExpanded([]);
    void reload();
    const tick = active ? window.setInterval(() => { if (!document.hidden) void reload(); }, 6_000) : undefined;
    const taskChanges = subscribeTaskChanges(() => { void reload(); });
    const runChanges = subscribeAiTeamRunChanges(() => { void reload(); });
    return () => { ++generation.current; window.clearInterval(tick); taskChanges(); runChanges(); };
  }, [reload, active]);
  const items = snapshot?.items ?? [];
  const handle = items.filter(item => !["review", "blocker"].includes(item.kind));
  const review = items.filter(item => item.kind === "review");
  const blockers = items.filter(item => item.kind === "blocker");
  const incomplete = !!error || (snapshot?.incompleteSources ?? 0) > 0;
  const count = (value: number): string => !snapshot ? "—" : incomplete ? `${value} · 未确认` : String(value);
  const open = (item: TaskActionItem): void => {
    if (item.source.sessionId) onOpenSession?.(item.source.sessionId);
    else if (item.source.runId) taskBoardController.open("", "", "teamchat", item.source.runId);
    else onOpenAcceptance(item.taskId);
  };
  const list = (rows: TaskActionItem[]): React.ReactNode => rows.length ? <Collapse ghost activeKey={expanded} onChange={keys => setExpanded(keys as string[])} expandIconPlacement="end"
    items={rows.map(item => ({ key: item.key, label: <div className="task-actions-row" data-task-action={item.key}>
      <div className="task-actions-copy"><Flex align="center" gap={8}><Typography.Text type="secondary">{item.identifier}</Typography.Text><Tag color={item.kind === "blocker" ? undefined : item.kind === "review" ? "blue" : "gold"}>{labels[item.kind]}</Tag></Flex>
        <Typography.Text strong className="task-actions-title">{item.title}</Typography.Text><Typography.Text type="secondary" className="task-actions-reason">{item.reason}</Typography.Text></div><span className="task-actions-next">{summaries[item.kind]}</span>
    </div>, children: <Flex vertical gap="small">
      <Typography.Paragraph className="task-actions-detail">{item.reason}</Typography.Paragraph>
      <Typography.Text className="task-actions-source">{item.source.sessionId ? `源会话 ${item.source.sessionId}` : `任务 ${item.identifier}`}{item.source.requestId ? ` · 请求 ${item.source.requestId}` : ""}{item.source.toolId ? ` · 提问 ${item.source.toolId}` : ""}{item.source.runId ? ` · 运行 ${item.source.runId}` : ""}</Typography.Text>
      {item.kind === "blocker" && <Typography.Text type="secondary">原记录未明确处理人，请先核对归属；这里不提供自动解除或重新执行。</Typography.Text>}
      {item.kind === "review" && <Typography.Text type="secondary">打开仅供核对交付证据，不会自动确认验收。</Typography.Text>}
      <WandButton style={{ alignSelf: "flex-start" }} disabled={!!item.source.sessionId && !onOpenSession} onClick={() => open(item)}>{actions[item.kind]}</WandButton>
    </Flex> }))}/> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={incomplete ? "暂未发现可确认的事项，部分来源仍待核对。" : tab === "handle" ? "暂时没有需要你处理的请求；需要授权、回答或批准计划时会出现在这里。" : "暂时没有待验收的任务；任务明确交付待确认后会出现在这里。打开或已读不会自动验收。"}/>;
  return <section ref={root} aria-label="我的行动" onKeyDown={event => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing || !expanded.length) return;
    event.preventDefault(); event.stopPropagation();
    const key = expanded.at(-1)!;
    root.current?.querySelector(`[data-task-action="${CSS.escape(key)}"]`)?.closest<HTMLElement>("[role=button]")?.focus({ preventScroll: true });
    setExpanded([]);
  }}><Card size="small" className="task-actions"><Flex vertical gap="middle">
    <Flex justify="space-between" gap="small" wrap><div><Typography.Title level={4} style={{ margin: "0 0 4px" }}>先看看需要你做什么</Typography.Title>
      <Typography.Text type="secondary">{snapshot ? `${incomplete ? "已发现 " : ""}${handle.length} 项处理请求 · ${review.length} 项待验收${incomplete ? " · 数量未确认" : ""}` : "正在读取授权、待答与验收事实"}</Typography.Text></div>
      <Typography.Text type="secondary" className="task-actions-scope">{workspaceId ? "当前工作区" : "所有工作区"} · 含子任务</Typography.Text></Flex>
    <WandStretchTabs ariaLabel="行动分流" value={tab} onValueChange={value => { setTab(value); setExpanded([]); }} tabs={[{ value: "handle", label: `等我处理 ${count(handle.length)}` }, { value: "review", label: `待我验收 ${count(review.length)}` }]}/>
    {error && <Alert type="error" showIcon title={snapshot ? "行动刷新失败 · 以下为上次快照，数量未确认" : "行动读取失败，不代表没有待办"} description={error} action={<WandButton disabled={loading} onClick={() => void reload()}>重新读取</WandButton>}/>}
    {!!snapshot?.incompleteSources && <Alert type="warning" showIcon title="部分运行来源暂时无法确认，数量可能不完整" description="已知事项仍可回原入口核对；不会把未知来源当成没有待办。" action={<WandButton disabled={loading} onClick={() => void reload()}>重新读取</WandButton>}/>}
    {!snapshot && loading ? <Skeleton active paragraph={{ rows: 3 }}/> : snapshot ? <SidebarProjectionSwap value={tab}>
      {list(tab === "handle" ? handle : review)}
      {tab === "handle" && blockers.length > 0 && <Flex vertical gap="small"><Typography.Text strong>阻塞记录 {blockers.length} · 先核对归属，不等同于在等你操作</Typography.Text>{list(blockers)}</Flex>}
    </SidebarProjectionSwap> : null}
  </Flex></Card></section>;
}
