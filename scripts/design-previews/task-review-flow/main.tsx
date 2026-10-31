import * as React from "react";
import { createRoot } from "react-dom/client";
import { Alert, Button, Card, Collapse, Flex, Input, Segmented, Tag, Typography } from "antd";
import { WandUiProvider } from "../../../src/web-ui/react/theme";
import { columns, samples, transition, type Action, type DemoTask } from "./model";
import "./style.css";

function Preview() {
  const [tasks, setTasks] = React.useState<DemoTask[]>(samples);
  const [selected, setSelected] = React.useState(samples[0].id);
  const [drafts, setDrafts] = React.useState<Record<string, { evidence: string; gap: string }>>({});
  const [feedback, setFeedback] = React.useState<{ action?: Action; text: string; error?: boolean }>({ text: "" });
  const task = tasks.find(item => item.id === selected)!;
  const draft = drafts[task.id] ?? { evidence: task.evidence, gap: task.gap };
  const label = task.stage === "archived" ? "已归档" : columns.find(column => column.stage === task.stage)!.label;
  const choose = (id: string) => { setSelected(id); setFeedback({ text: "" }); };
  const edit = (patch: Partial<typeof draft>) => { setDrafts({ ...drafts, [task.id]: { ...draft, ...patch } }); setFeedback({ text: "" }); };
  const act = (action: Action) => {
    try {
      const next = transition(task, action, draft.evidence, draft.gap);
      setTasks(tasks.map(item => item.id === task.id ? next : item));
      setFeedback({ action, text: action === "submit" ? "已提交 AI 验收" : action === "pass" ? "已进入待归档" : action === "archive" ? "已确认并归档" : "已退回执行中" });
    } catch (error) { setFeedback({ action, text: (error as Error).message, error: true }); }
  };
  const actions: { action: Action; label: string; enabled: boolean; primary?: boolean }[] = [
    { action: "submit", label: "提交 AI 验收", enabled: task.stage === "doing", primary: true },
    { action: "pass", label: "AI 验收通过", enabled: task.stage === "review" },
    { action: "fail", label: "AI 验收不通过", enabled: task.stage === "review" },
    { action: "archive", label: "确认并归档", enabled: task.stage === "ready", primary: true },
    { action: "return", label: "人工退回", enabled: task.stage === "ready" },
  ];
  return <main className="review-preview">
    <Flex justify="space-between" align="center" wrap gap="small"><Typography.Title level={3}>任务验收链路</Typography.Title><Tag>交互预览 · 非生产功能</Tag></Flex>
    <Alert type="info" showIcon title="执行中 → 待验收（AI）→ 待归档（你确认）→ 已归档" description="AI 不通过或你退回时，回到执行中。所有按钮只修改本页示例，不调用模型、不写真实任务；刷新恢复。"/>
    <section className="review-workbench" aria-label="验收操作演示">
      <Flex gap="small" wrap align="center"><Typography.Text strong>体验任务</Typography.Text><Segmented aria-label="体验任务" value={selected} onChange={value => choose(String(value))} options={tasks.map(item => ({ value: item.id, label: item.id }))}/></Flex>
      <Flex gap="small" wrap align="center"><Typography.Title level={5}>{task.title}</Typography.Title><Tag color={task.aiPassed ? "success" : "processing"} data-testid="stage">{label}</Tag></Flex>
      <Typography.Text type="secondary" data-testid="ownership">AI：{task.aiPassed ? "验收通过" : task.stage === "review" ? "待核验" : "尚未通过"} · 人工：{task.humanAccepted ? "已确认" : "未确认"}</Typography.Text>
      <div className="review-fields">
        <label>交付与验收证据<Input.TextArea aria-label="交付与验收证据" value={draft.evidence} onChange={event => edit({ evidence: event.target.value })} rows={3} placeholder="填写交付范围、版本、报告和实际验证结果（本页仅为演示）"/></label>
        <label>缺口 / 退回原因<Input.TextArea aria-label="缺口或退回原因" value={draft.gap} onChange={event => edit({ gap: event.target.value })} rows={3} placeholder="不通过或无法验证时必填；修复后先清空缺口，再重新提交"/></label>
      </div>
      <div className="review-actions">{actions.map(entry => <Button key={entry.action} data-action={entry.action} type={entry.primary ? "primary" : "default"} disabled={!entry.enabled} onClick={() => act(entry.action)}>{feedback.action === entry.action && !feedback.error ? feedback.text : entry.label}</Button>)}</div>
      <div role="status" className="review-feedback"><Typography.Text type={feedback.error ? "danger" : "secondary"}>{feedback.error ? feedback.text : "状态变化不自动执行、重试或派发；确认并归档仅代表本页的人工作用演示。"}</Typography.Text></div>
      <Collapse items={[{ key: "history", label: `流转记录 · ${task.history.length} 条`, children: <ol>{task.history.map((line, index) => <li key={index}>{line}</li>)}</ol> }]}/>
    </section>
    <Typography.Title level={5}>看板位置随真实流程变化</Typography.Title>
    <div className="review-board-scroll"><div className="review-board">{columns.map(column => <section key={column.stage} className="review-column" aria-label={column.label}>
      <Flex justify="space-between"><strong>{column.label}</strong><span>{tasks.filter(item => item.stage === column.stage).length}</span></Flex><Typography.Text type="secondary">{column.hint}</Typography.Text>
      {tasks.filter(item => item.stage === column.stage).map(item => <Card key={item.id} size="small" className={item.id === selected ? "review-card selected" : "review-card"}><button className="review-card-select" onClick={() => choose(item.id)}><small>{item.id}</small><strong>{item.title}</strong><span>{item.aiPassed ? "AI 已通过 · 人工未确认" : item.stage === "review" ? "等待 AI 验收" : item.gap ? `待修复：${item.gap}` : "尚未提交验收"}</span></button></Card>)}
    </section>)}</div></div>
    <Collapse items={[{ key: "archive", label: `已归档 · ${tasks.filter(item => item.stage === "archived").length} 项`, children: tasks.filter(item => item.stage === "archived").length ? tasks.filter(item => item.stage === "archived").map(item => <p key={item.id}><Button onClick={() => choose(item.id)}>{item.id} · {item.title}</Button> 人工已确认 · 历史保留</p>) : "暂无归档；仅 AI 通过不会进入这里。" }]}/>
    <Typography.Paragraph type="secondary">旧任务兼容：没有可信 AI 验收记录的旧“等待验收”任务，不能仅凭旧列、评论正文或会话结束自动升级。正式落地需单独核对结论；本预览未迁移任何旧数据。</Typography.Paragraph>
  </main>;
}
createRoot(document.getElementById("root")!).render(<WandUiProvider><Preview/></WandUiProvider>);
