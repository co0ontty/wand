import * as React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Alert, Badge, Button, Card, Checkbox, Collapse, Drawer, Empty, Flex, Input, Popover, Progress, Select, Tag, Typography } from "antd";
import { WandUiProvider } from "../../../src/web-ui/react/theme";
import { WandStretchTabs } from "../../../src/web-ui/react/ui/stretch-tabs";
import { WandIcon } from "../../../src/web-ui/react/ui/icons";
import { installReactUiStyles } from "../../../src/web-ui/react/styles";
import { setWandTheme } from "../../../src/web-ui/react/theme-preference";
import { advance, columns, emptyFilters, fixtures, projectGoals, stageNames, summary, TODAY, type Action, type Filters, type Stage, type Task, type View } from "./model";
import "./style.css";
installReactUiStyles();
const viewNames: Record<View, string> = { dashboard: "概览", board: "看板", list: "列表", gantt: "甘特图", archive: "已归档" };
const tones: Record<Stage, string> = { backlog: "var(--text-tertiary)", todo: "var(--preview-purple)", doing: "var(--accent)", review: "var(--preview-blue)", ready: "var(--success)", archived: "var(--text-secondary)" };
const hints: Record<Stage, string> = { backlog: "确认目标与范围", todo: "等待明确指派", doing: "实施与修复", review: "AI 核验交付", ready: "AI 已通过 · 等你确认", archived: "人工已确认 · 历史保留" };
const Status = ({ stage }: { stage: Stage }) => <span className={`pd-status is-${stage}`}><i style={{ background: tones[stage] }}/>{stageNames[stage]}</span>;
const Icon = ({ name }: { name: React.ComponentProps<typeof WandIcon>["name"] }) => <WandIcon name={name} size={16}/>;
function Runtime({ task }: { task: Task }) { return <span className={`pd-runtime is-${task.runtime}`}>{task.runtime === "running" ? "正在执行" : task.runtime === "queued" ? "排队中" : task.gap ? "验收退回 · 待修复" : task.stage === "review" ? "等待 AI 验收" : task.stage === "ready" ? "AI 已通过" : task.stage === "archived" ? "人工已确认" : task.stage === "backlog" ? "尚未立项" : task.stage === "todo" ? "尚未开始" : "等待继续"}</span>; }
function App() {
  const [tasks, setTasks] = React.useState<Task[]>(fixtures);
  const [view, setView] = React.useState<View>("dashboard");
  const [filters, setFilters] = React.useState<Filters>(emptyFilters);
  const [filterOpen, setFilterOpen] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<string[]>([]);
  const [creating, setCreating] = React.useState(false);
  const [newTitle, setNewTitle] = React.useState("");
  const [newDescription, setNewDescription] = React.useState("");
  const [deliveryDrafts, setDeliveryDrafts] = React.useState<Record<string, { evidence: string; gap: string }>>({});
  const selected = tasks.find(task => task.id === selectedId) ?? null;
  const goals = projectGoals(tasks, filters, view === "archive");
  const allGoals = tasks.filter(task => !task.parentId);
  const archiveCount = allGoals.filter(task => task.stage === "archived").length;
  const activeFilters = filters.stages.length + (filters.owner !== "all" ? 1 : 0) + (filters.onlyGaps ? 1 : 0);
  const changeView = (next: View) => {
    setFilterOpen(false); setCreating(false);
    const change = () => { setView(next); };
    if (document.startViewTransition && !matchMedia("(prefers-reduced-motion:reduce)").matches) document.startViewTransition(() => flushSync(change));
    else change();
  };
  const filterStage = (stage: Stage) => { setFilters({ ...emptyFilters, stages: [stage] }); changeView("board"); };
  const toggle = (id: string) => setExpanded(expanded.includes(id) ? expanded.filter(value => value !== id) : [...expanded, id]);
  const filterContent = <div className="pd-filter-panel">
    <strong>状态</strong><Checkbox.Group value={filters.stages} onChange={stages => setFilters({ ...filters, stages: stages as Stage[] })}>{columns.map(column => <Checkbox value={column.stage} key={column.stage}>{column.label}</Checkbox>)}</Checkbox.Group>
    <label>负责人<Select aria-label="筛选负责人" value={filters.owner} onChange={owner => setFilters({ ...filters, owner })} options={["all", "赛博虎妞", "瑞辰", "未指派"].map(value => ({ value, label: value === "all" ? "全部负责人" : value }))}/></label>
    <Checkbox checked={filters.onlyGaps} onChange={event => setFilters({ ...filters, onlyGaps: event.target.checked })}>只看有验收缺口</Checkbox>
    <Button onClick={() => setFilters(emptyFilters)}>清除全部筛选</Button>
  </div>;
  return <div className="pd-app" onKeyDown={event => { if (event.key !== "Escape") return; if (filterOpen) { event.stopPropagation(); setFilterOpen(false); } else if (creating) { event.stopPropagation(); setCreating(false); } }}>
    <header className="pd-header"><div className="pd-brand"><span className="pd-brand-mark"><Icon name="board"/></span><strong>Wand 工作台</strong><span className="pd-header-divider">/</span><span>任务面板</span></div><Flex gap="small" align="center"><span className="pd-design-label">设计预览 · 示例数据</span><Select aria-label="设计稿主题" defaultValue="warm" onChange={setWandTheme} options={[{ value: "warm", label: "暖白" }, { value: "graphite", label: "深色" }]} popupMatchSelectWidth={false}/><Button type="primary" icon={<Icon name="plus"/>} onClick={() => { setCreating(true); setFilterOpen(false); }}>新建任务</Button></Flex></header>
    <div className="pd-toolbar"><WandStretchTabs ariaLabel="任务面板视图" value={view === "archive" ? "" : view} onValueChange={value => changeView(value as View)} tabs={[{ value: "dashboard", label: <><Icon name="sigma"/>概览</> }, { value: "board", label: <><Icon name="board"/>看板</> }, { value: "list", label: <><Icon name="task"/>列表</> }, { value: "gantt", label: <><Icon name="calendar"/>甘特图</> }]}/>
      <div className="pd-toolbar-right"><Input aria-label="搜索任务" placeholder="搜索标题、编号或标签" prefix={<Icon name="search"/>} allowClear value={filters.query} onChange={event => setFilters({ ...filters, query: event.target.value })}/><Popover open={filterOpen} onOpenChange={setFilterOpen} trigger="click" placement="bottomRight" content={filterContent}><Button aria-label="筛选任务" aria-expanded={filterOpen} icon={<Icon name="sliders"/>}>筛选{activeFilters > 0 && <Badge count={activeFilters} color="var(--accent)"/>}</Button></Popover><Button aria-label="查看归档" className={view === "archive" ? "pd-archive-active" : ""} icon={<Icon name="archive"/>} onClick={() => changeView(view === "archive" ? "board" : "archive")}>归档 <span data-testid="archive-count">{archiveCount}</span></Button></div>
    </div>
    {(activeFilters > 0 || filters.query) && <div className="pd-filter-summary"><span>当前结果：{goals.length} 个主目标{tasks.some(task => task.parentId) ? " · 子任务匹配保留主目标上下文" : ""}</span>{filters.stages.map(stage => <Tag key={stage}>{stageNames[stage]}</Tag>)}<Button type="text" size="small" onClick={() => setFilters(emptyFilters)}>清除筛选</Button></div>}
    <main className="pd-content" data-view={view}>
      {creating ? <section className="pd-create"><Button type="text" icon={<Icon name="back"/>} onClick={() => setCreating(false)}>返回{viewNames[view]}</Button><h1>新建任务</h1><p className="pd-muted">先记录目标；创建不代表开始执行。本设计稿仅新增内存中的示例。</p><label>任务标题<Input aria-label="新任务标题" value={newTitle} onChange={event => setNewTitle(event.target.value)} placeholder="希望完成什么？"/></label><label>目标与验收标准<Input.TextArea aria-label="新任务描述" value={newDescription} onChange={event => setNewDescription(event.target.value)} rows={5}/></label><Flex gap="small"><Button onClick={() => setCreating(false)}>取消</Button><Button type="primary" disabled={!newTitle.trim()} onClick={() => { const base = fixtures[0]; setTasks([...tasks, { ...base, id: `DEMO-NEW-${tasks.length + 1}`, title: newTitle.trim(), description: newDescription, history: ["在设计稿中创建待立项任务；没有派发模型。"] }]); setNewTitle(""); setNewDescription(""); setFilters(emptyFilters); setCreating(false); changeView("board"); }}>创建待立项任务</Button></Flex></section>
      : view === "dashboard" ? <Dashboard tasks={tasks} goals={allGoals.filter(task => goals.some(goal => goal.id === task.id) || (task.stage === "archived" && !filters.query && !activeFilters))} onOpen={setSelectedId} onStage={filterStage} onView={changeView}/>
      : view === "board" ? <><ViewHeading title="目标看板" description="五个工作阶段，一个清晰的交付闭环。归档任务单独收纳。" count={goals.length}/><div className="pd-flow-note"><span><Icon name="info"/>执行完成后提交 AI 验收；通过后等待你确认归档。</span><span>不通过 → 回到执行中</span></div><div className="pd-board-scroll"><div className="pd-board">{columns.map(column => <section className={`pd-column is-${column.stage}`} key={column.stage} aria-label={column.label}>
        <header><Status stage={column.stage}/><span data-count={column.stage}>{goals.filter(task => task.stage === column.stage).length}</span></header><p className="pd-column-hint">{hints[column.stage]}</p><div className="pd-column-cards">{goals.filter(task => task.stage === column.stage).map(task => <TaskCard key={task.id} task={task} tasks={tasks} expanded={expanded.includes(task.id)} onToggle={() => toggle(task.id)} onOpen={setSelectedId}/>)}{!goals.some(task => task.stage === column.stage) && <p className="pd-column-empty">{activeFilters || filters.query ? "当前筛选下无匹配" : "暂无任务"}</p>}</div>
      </section>)}</div></div></>
      : view === "gantt" ? <Gantt goals={goals} onOpen={setSelectedId}/>
      : <><ViewHeading title={view === "archive" ? "已归档" : "任务列表"} description={view === "archive" ? "人工确认后的交付记录；归档不删除任务与执行历史。" : "与看板使用相同状态和筛选，按主目标组织。"} count={goals.length}/><TaskList goals={goals} tasks={tasks} onOpen={setSelectedId}/></>}
    </main>
    <footer className="pd-footer"><span>参考 dashi Dashboard · 仅设计稿，不连接生产任务</span><span>样例日期 {TODAY} · 刷新恢复示例</span></footer>
    <Drawer open={Boolean(selected)} onClose={() => setSelectedId(null)} title={selected ? <Flex align="center" gap="small"><span className="pd-muted">{selected.id}</span><Status stage={selected.stage}/></Flex> : "任务详情"} size={640} className="pd-detail-drawer" destroyOnHidden={false}>
      {selected && <TaskDetail task={selected} tasks={tasks} drafts={deliveryDrafts} setDrafts={setDeliveryDrafts} onOpen={setSelectedId} onAction={(action, evidence, gap) => setTasks(advance(tasks, selected.id, action, evidence, gap))} onEnd={() => setTasks(current => current.map(task => task.id === selected.id ? { ...task, runtime: "idle", history: [...task.history, "示例执行已结束；业务状态未自动改变。"] } : task))}/>}
    </Drawer>
  </div>;
}
function ViewHeading({ title, description, count }: { title: string; description: string; count: number }) { return <div className="pd-view-heading"><div><h1>{title}<span>{count}</span></h1><p>{description}</p></div></div>; }
function TaskCard({ task, tasks, expanded, onToggle, onOpen }: { task: Task; tasks: Task[]; expanded: boolean; onToggle(): void; onOpen(id: string): void }) {
  const children = tasks.filter(child => child.parentId === task.id);
  return <Card size="small" className={`pd-task-card ${task.gap ? "has-gap" : ""}`} data-task={task.id}>
    <div className="pd-card-meta"><span>{task.id}</span><span className={task.priority === "高" ? "pd-high" : ""}>{task.priority}优先级</span></div>
    <button className="pd-card-title" onClick={() => onOpen(task.id)}>{task.title}</button>
    <div className="pd-card-tags">{task.tags.slice(0, 2).map(tag => <span key={tag}>{tag}</span>)}</div>
    {task.gap && <p className="pd-card-gap"><Icon name="warning"/>{task.gap}</p>}
    <div className="pd-card-footer"><Runtime task={task}/><span>{task.owner}</span></div>
    {children.length > 0 && <Collapse className="pd-children" activeKey={expanded ? ["children"] : []} onChange={onToggle} items={[{ key: "children", label: `${children.length} 个子任务 · ${children.filter(child => child.humanAccepted).length} 已确认`, children: children.map(child => <button key={child.id} className="pd-child-row" onClick={() => onOpen(child.id)}><span>{child.title}</span><Status stage={child.stage}/></button>) }]}/>}
  </Card>;
}
function Panel({ title, extra, children, className = "" }: { title: string; extra?: React.ReactNode; children: React.ReactNode; className?: string }) { return <section className={`pd-panel ${className}`}><header><h3>{title}</h3>{extra}</header>{children}</section>; }
function Dashboard({ tasks, goals, onOpen, onStage, onView }: { tasks: Task[]; goals: Task[]; onOpen(id: string): void; onStage(stage: Stage): void; onView(view: View): void }) {
  const stats = summary(goals), active = goals.filter(task => task.stage !== "archived"), ready = active.filter(task => task.stage === "ready");
  const reviews = active.filter(task => task.stage === "review"), risks = active.filter(task => task.gap), running = tasks.filter(task => task.runtime === "running" && goals.some(goal => goal.id === task.id || goal.id === task.parentId));
  const due = active.filter(task => task.due).sort((a, b) => a.due!.localeCompare(b.due!)).slice(0, 4);
  const row = (task: Task, copy?: string) => <button className="pd-summary-row" key={task.id} onClick={() => onOpen(task.id)}><span className="pd-row-copy"><strong>{task.title}</strong><small>{copy ?? `${task.id} · ${task.owner}`}</small></span><Icon name="chevron"/></button>;
  return <div className="pd-dashboard">
    <div className="pd-overview"><div className="pd-completion"><p className="pd-eyebrow">项目完成度 · 人工确认口径</p><div><strong data-testid="completion-percent">{stats.percent}<span>%</span></strong><span>{stats.accepted} / {stats.total} 个主目标已确认</span></div></div><div className="pd-overview-copy"><h1>工作进展，一眼看清。</h1><p>当前有 <b>{stats.active}</b> 个主目标推进中，<button onClick={() => onStage("review")}>{reviews.length} 项待 AI 验收</button>，<button onClick={() => onStage("ready")}>{ready.length} 项待你确认归档</button>。{risks.length ? `另有 ${risks.length} 项验收退回，需要继续修复。` : "当前无验收退回。"}</p><small>AI 验收通过 ≠ 人工已接受，不提前计入完成度。</small></div></div>
    <section className="pd-metrics" aria-label="五阶段统计">{columns.map(column => <button className={`pd-metric is-${column.stage}`} key={column.stage} onClick={() => onStage(column.stage)}><Status stage={column.stage}/><div><strong data-metric={column.stage}>{stats.counts[column.stage]}</strong><small>{stats.active ? Math.round(stats.counts[column.stage] / stats.active * 100) : 0}%</small></div><Progress percent={stats.active ? stats.counts[column.stage] / stats.active * 100 : 0} showInfo={false} strokeColor={tones[column.stage]} size="small"/></button>)}</section>
    <div className="pd-section-heading"><h2>先看需要你决定的事</h2><span>AI 做验收，你决定是否交付</span></div>
    <Panel title={`待你确认归档 · ${ready.length}`} className="pd-ready-panel" extra={<Button type="text" size="small" onClick={() => onStage("ready")}>查看全部 <Icon name="chevron"/></Button>}>
      {ready.length ? ready.slice(0, 3).map(task => <div className="pd-ready-row" key={task.id}><span className="pd-ready-check"><Icon name="shieldCheck"/></span><button className="pd-ready-title" onClick={() => onOpen(task.id)}><strong>{task.title}</strong><small>{task.id} · {task.owner} · AI 验收通过</small></button><span className="pd-ready-human">人工未确认</span><Button onClick={() => onOpen(task.id)}>查看交付</Button></div>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前没有等待你确认的交付"/>}
    </Panel>
    <div className="pd-section-heading"><h2>项目分析</h2><span>{stats.running} 项正在执行 · {stats.gaps} 项有缺口 · {stats.overdue} 项已逾期</span></div>
    <div className="pd-analysis-grid">
      <Panel title="AI 验收队列" extra={<span>{reviews.length} 项</span>}>{reviews.length ? reviews.map(task => row(task, `${task.id} · ${task.runtime === "running" ? "正在核验" : "交付已提交，等待核验"}`)) : <p className="pd-empty">暂无待验收任务</p>}</Panel>
      <Panel title="执行与返工" extra={<span>{running.length} 项运行中</span>}>{[...risks, ...running.filter(task => !risks.some(risk => risk.id === task.id))].slice(0, 4).map(task => row(task, task.gap || `${task.id} · ${task.owner}正在执行`))}</Panel>
      <Panel title="优先级分布"><div className="pd-distribution">{(["高", "中", "低"] as const).map(priority => { const count = active.filter(task => task.priority === priority).length; return <div key={priority}><span>{priority}优先级</span><Progress showInfo={false} percent={stats.active ? count / stats.active * 100 : 0} strokeColor={priority === "高" ? "var(--accent)" : priority === "中" ? "var(--preview-blue)" : "var(--text-tertiary)"}/><b>{count}</b></div>; })}</div><p className="pd-panel-caption">按未归档主目标统计，不重复计算子任务。</p></Panel>
      <Panel title="累计人工确认" className="pd-trend-panel" extra={<span>10 月 21 日 — 28 日 · 示例</span>}><CompletionChart goals={goals}/><div className="pd-chart-legend"><span><i/>人工已接受</span><span>AI 通过尚未计入</span></div></Panel>
      <Panel title="近期到期" extra={<Button type="text" size="small" onClick={() => onView("gantt")}>时间线 <Icon name="chevron"/></Button>}>{due.length ? due.map(task => row(task, `${task.id} · ${task.due!.slice(5).replace("-", "月")}日 · ${stageNames[task.stage]}`)) : <p className="pd-empty">没有设置截止日期的任务</p>}</Panel>
      <Panel title="负责人交付"><div className="pd-contributors">{["赛博虎妞", "瑞辰"].map(owner => { const owned = goals.filter(task => task.owner === owner); return <div key={owner}><span className="pd-owner-mark">{owner.slice(0, 1)}</span><div><strong>{owner}</strong><small>{owned.filter(task => task.humanAccepted).length} 项人工确认 · {owned.filter(task => task.stage === "ready").length} 项待归档</small></div><b>{owned.length}</b></div>; })}</div></Panel>
    </div>
  </div>;
}
function CompletionChart({ goals }: { goals: Task[] }) {
  const points = Array.from({ length: 8 }, (_, index) => { const day = `2026-10-${21 + index}`; return { x: 20 + index * 66, count: goals.filter(task => task.humanAccepted && task.acceptedOn && task.acceptedOn <= day).length }; });
  const max = Math.max(4, ...points.map(point => point.count));
  const line = points.map(point => `${point.x},${125 - point.count / max * 90}`).join(" ");
  return <svg className="pd-trend" viewBox="0 0 510 160" role="img" aria-label="示例任务累计人工确认趋势"><line x1="20" x2="490" y1="125" y2="125" stroke="var(--border-subtle)"/><line x1="20" x2="490" y1="35" y2="35" stroke="var(--border-subtle)" strokeDasharray="4 4"/><polygon points={`20,125 ${line} 482,125`} fill="var(--accent-muted)"/><polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="2"/>{points.map((point, index) => <g key={index}><circle cx={point.x} cy={125 - point.count / max * 90} r="3" fill="var(--accent)"/><text x={point.x} y="150" textAnchor="middle" fill="var(--text-secondary)" fontSize="11">{21 + index}日</text></g>)}</svg>;
}
function TaskList({ goals, tasks, onOpen }: { goals: Task[]; tasks: Task[]; onOpen(id: string): void }) {
  return goals.length ? <div className="pd-list">{[...columns, { stage: "archived" as const, label: "已归档" }].filter(column => goals.some(task => task.stage === column.stage)).map(column => <Collapse key={column.stage} defaultActiveKey={[column.stage]} items={[{ key: column.stage, label: <Flex gap="small" align="center"><Status stage={column.stage}/><span>{goals.filter(task => task.stage === column.stage).length} 个主目标</span></Flex>, children: goals.filter(task => task.stage === column.stage).map(task => <div key={task.id} className="pd-list-row"><span className="pd-list-id">{task.id}</span><button onClick={() => onOpen(task.id)}>{task.title}</button><span className="pd-list-owner">{task.owner}</span><Runtime task={task}/>{tasks.some(child => child.parentId === task.id) && <span className="pd-list-children">{tasks.filter(child => child.parentId === task.id).length} 子任务</span>}</div>) }]}/>)}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前筛选下没有匹配的任务"/>;
}
function Gantt({ goals, onOpen }: { goals: Task[]; onOpen(id: string): void }) {
  const dates = Array.from({ length: 14 }, (_, index) => `2026-${index + 21 <= 31 ? `10-${index + 21}` : `11-0${index - 10}`}`);
  const scheduled = goals.filter(task => task.start && task.due), unscheduled = goals.filter(task => !task.start || !task.due);
  return <><ViewHeading title="交付时间线" description="只展示已设置的计划起止日期；无日期任务保留在待排期，不虚构持续时长。" count={goals.length}/><div className="pd-gantt-scroll"><div className="pd-gantt"><div className="pd-gantt-head"><strong>主目标</strong><div>{dates.map(day => <span key={day} className={day === TODAY ? "is-today" : ""}>{day === TODAY ? "今天" : day.slice(5).replace("-", "/")}</span>)}</div></div>{scheduled.map(task => { const start = Math.max(0, dates.indexOf(task.start!) < 0 ? 0 : dates.indexOf(task.start!)); const end = Math.max(start + 1, dates.indexOf(task.due!) + 1); return <div className="pd-gantt-row" key={task.id}><button onClick={() => onOpen(task.id)}><Status stage={task.stage}/><span>{task.title}</span></button><div className="pd-gantt-track"><i className="pd-today-line"/><button onClick={() => onOpen(task.id)} title={`${task.title}：${task.start} 至 ${task.due}`} style={{ gridColumn: `${start + 1} / ${end + 1}`, background: tones[task.stage] }}>{stageNames[task.stage]}</button></div></div>; })}</div></div><Panel title={`待排期 · ${unscheduled.length}`} className="pd-unscheduled"><div>{unscheduled.map(task => <Button key={task.id} onClick={() => onOpen(task.id)}>{task.id} · {task.title}</Button>)}</div></Panel></>;
}
function TaskDetail({ task, tasks, drafts, setDrafts, onAction, onEnd, onOpen }: { task: Task; tasks: Task[]; drafts: Record<string, { evidence: string; gap: string }>; setDrafts(value: Record<string, { evidence: string; gap: string }>): void; onAction(action: Action, evidence: string, gap: string): void; onEnd(): void; onOpen(id: string): void }) {
  const [feedback, setFeedback] = React.useState<{ id: string; action: string; text: string; error?: boolean } | null>(null);
  const draft = drafts[task.id] ?? { evidence: task.evidence, gap: task.gap };
  const edit = (patch: Partial<typeof draft>) => { setDrafts({ ...drafts, [task.id]: { ...draft, ...patch } }); setFeedback(null); };
  const act = (action: Action) => { try { onAction(action, draft.evidence, draft.gap); setFeedback({ id: task.id, action, text: action === "archive" ? "已确认并归档" : action === "pass" ? "已转入待归档" : action === "submit" ? "已提交 AI 验收" : "已退回执行中" }); } catch (error) { setFeedback({ id: task.id, action, text: (error as Error).message, error: true }); } };
  const actions: { action: Action; label: string; allowed: boolean }[] = [{ action: "submit", label: "提交 AI 验收", allowed: task.stage === "doing" }, { action: "pass", label: "模拟 AI 通过", allowed: task.stage === "review" }, { action: "fail", label: "模拟 AI 不通过", allowed: task.stage === "review" }, { action: "archive", label: "确认并归档", allowed: task.stage === "ready" }, { action: "return", label: "退回继续修改", allowed: task.stage === "ready" }];
  return <div className="pd-detail" data-detail-task={task.id}><h2>{task.title}</h2><div className="pd-detail-properties"><span>负责人 <strong>{task.owner}</strong></span><span>优先级 <strong>{task.priority}</strong></span><span>执行 <Runtime task={task}/></span></div><p className="pd-detail-description">{task.description}</p>
    {task.parentId && <Button type="text" onClick={() => onOpen(task.parentId!)}>查看所属主目标 DEMO-07</Button>}
    <div className="pd-detail-state"><div><span>AI 验收</span><strong>{task.aiPassed ? "已通过" : task.stage === "review" ? "待验收" : "尚未通过"}</strong></div><div><span>人工确认</span><strong>{task.humanAccepted ? "已确认" : "未确认"}</strong></div></div>
    <h3>交付与验收</h3><p className="pd-muted">本页只模拟验收回执，不会调用模型或写入真实任务。</p><label>交付证据<Input.TextArea aria-label="任务交付证据" value={draft.evidence} onChange={event => edit({ evidence: event.target.value })} rows={4}/></label><label>验收缺口 / 退回原因<Input.TextArea aria-label="任务退回原因" value={draft.gap} onChange={event => edit({ gap: event.target.value })} rows={3} placeholder="不通过或无法验证时填写具体原因；修复后重新提交"/></label>
    <div className="pd-detail-actions">{actions.map(entry => <Button data-action={entry.action} key={entry.action} type={entry.action === "archive" || entry.action === "submit" ? "primary" : "default"} disabled={!entry.allowed} onClick={() => act(entry.action)}>{feedback?.id === task.id && feedback.action === entry.action && !feedback.error ? feedback.text : entry.label}</Button>)}</div><div className="pd-action-result" role="status">{feedback?.id === task.id && feedback.error ? <Typography.Text type="danger">{feedback.text}</Typography.Text> : <Typography.Text type="secondary">{hints[task.stage]}</Typography.Text>}</div>
    {task.runtime !== "idle" && <Alert type="info" title="示例中仍有执行，不能直接推进验收" action={<Button onClick={() => { onEnd(); setFeedback(null); }}>模拟执行结束</Button>}/>}
    <Collapse className="pd-detail-history" items={[{ key: "history", label: `流转与验收记录 · ${task.history.length}`, children: <ol>{task.history.map((entry, index) => <li key={index}>{entry}</li>)}</ol> }]}/>
    {tasks.some(child => child.parentId === task.id) && <Panel title="业务子任务">{tasks.filter(child => child.parentId === task.id).map(child => <button key={child.id} className="pd-child-row" onClick={() => onOpen(child.id)}><span>{child.title}</span><Status stage={child.stage}/></button>)}</Panel>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<WandUiProvider><App/></WandUiProvider>);
