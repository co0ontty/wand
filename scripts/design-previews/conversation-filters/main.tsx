import * as React from "react";
import { createRoot } from "react-dom/client";
import { Button, ConfigProvider, Popover, Radio, Switch } from "antd";
import { WandUiProvider } from "../../../src/web-ui/react/theme";
import { installReactUiStyles } from "../../../src/web-ui/react/styles";
import { WandSearchField } from "../../../src/web-ui/react/ui/search-field";
import { usePopupDismiss } from "../../../src/web-ui/react/ui/popup-lifecycle";
import "./style.css";

const stages = ["全部状态", "待立项", "等待认领", "执行中", "待验收", "待归档", "已归档", "未关联任务"];
const spaces = ["全部工作区", "Wand", "DiPlay", "个人实验室", "未分配工作区"];
const examples = [
  { person: "赛博虎妞", avatar: "虎", color: "#e8e2d9", title: "对话列表筛选设计", stage: "待验收", space: "Wand", time: "14:32", preview: "四端方案已整理，等待 AI 核验", running: false },
  { person: "赛博虎妞", avatar: "虎", color: "#e8e2d9", title: "输入区布局优化", stage: "执行中", space: "Wand", time: "14:20", preview: "正在核对窄屏布局", running: true },
  { person: "勤劳的初二", avatar: "初", color: "#ead6c1", title: "更新接口一致性检查", stage: "待验收", space: "Wand", time: "13:48", preview: "检查报告已提交", running: false },
  { person: "勤劳的初二", avatar: "初", color: "#ead6c1", title: "车机连接体验", stage: "待归档", space: "DiPlay", time: "昨天", preview: "AI 已通过，等你确认", running: false },
  { person: "产品伙伴", avatar: "产", color: "#dbe5e0", title: "相册整理思路", stage: "未关联任务", space: "个人实验室", time: "昨天", preview: "先梳理目标与边界", running: false },
  { person: "产品伙伴", avatar: "产", color: "#dbe5e0", title: "下周的界面探索", stage: "待立项", space: "未分配工作区", time: "周一", preview: "等待确认需求", running: false },
  { person: "代码伙伴", avatar: "码", color: "#dddfee", title: "整理回归测试", stage: "等待认领", space: "Wand", time: "周一", preview: "尚未指派执行对象", running: false },
  { person: "代码伙伴", avatar: "码", color: "#dddfee", title: "历史图标更新", stage: "已归档", space: "Wand", time: "周日", preview: "交付记录已保留", running: false },
];
const platforms = [
  { id: "web", name: "Web", subtitle: "288px 列表 + 56px 导航轨", note: "复用 WandSearchField / Popover / Radio" },
  { id: "mac", name: "macOS", subtitle: "原生侧栏 · 同一套筛选语义", note: "原生搜索框 + 锚定 Popover" },
  { id: "ios", name: "iOS", subtitle: "390pt 手机 · 44pt 触控目标", note: "搜索同排入口，不跳新页、不弹全屏" },
  { id: "android", name: "Android", subtitle: "390dp 手机 · 48dp 触控目标", note: "Material 控件 + 锚定筛选面板" },
];
type Filters = { stage: string; space: string; active: boolean };
const defaults: Filters = { stage: stages[0], space: spaces[0], active: false };
function Funnel() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg>; }
function PreviewList({ platform, mode }: { platform: typeof platforms[number]; mode: string }) {
  const mobile = platform.id === "ios" || platform.id === "android";
  const [filters, setFilters] = React.useState<Filters>(mode === "filtered" ? { ...defaults, stage: "待验收", space: "Wand" } : defaults);
  const [draft, setDraft] = React.useState(filters);
  const [query, setQuery] = React.useState("");
  const [workspaceQuery, setWorkspaceQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  usePopupDismiss(open, () => { setOpen(false); document.querySelector<HTMLButtonElement>(`[data-filter=${platform.id}]`)?.focus({ preventScroll: true }); });
  const [expanded, setExpanded] = React.useState<string[]>(["赛博虎妞", "勤劳的初二"]);
  const count = Number(filters.stage !== stages[0]) + Number(filters.space !== spaces[0]) + Number(filters.active);
  const matching = examples.filter(row => (filters.stage === stages[0] || row.stage === filters.stage)
    && (filters.space === spaces[0] || row.space === filters.space) && (!filters.active || row.running)
    && [row.person, row.title, row.space, row.preview].join(" ").toLowerCase().includes(query.trim().toLowerCase()));
  const people = [...new Set(matching.map(row => row.person))];
  const changeOpen = (value: boolean) => { if (value) { setDraft(filters); setWorkspaceQuery(""); } setOpen(value); };
  const reset = () => { setFilters(defaults); setDraft(defaults); };
  const panel = <div className={`filter-panel ${mobile ? "touch-panel" : ""}`}>
    <header><strong>筛选对话</strong><Button type="text" size="small" onClick={() => setDraft(defaults)}>重置</Button></header>
    <div className="filter-body"><fieldset><legend>任务状态</legend><Radio.Group value={draft.stage} onChange={event => setDraft({ ...draft, stage: event.target.value })}>
      {stages.map(stage => <Radio.Button key={stage} value={stage}>{stage}</Radio.Button>)}
    </Radio.Group></fieldset>
    <label className="field-label">工作区 · {draft.space}</label>
    <WandSearchField label={`${platform.name} 查找工作区`} placeholder="查找工作区" value={workspaceQuery} onValueChange={setWorkspaceQuery}/>
    <div className="workspace-options"><Radio.Group value={draft.space} onChange={event => setDraft({ ...draft, space: event.target.value })}>{spaces.filter(space => space.toLowerCase().includes(workspaceQuery.toLowerCase())).map(space => <Radio key={space} value={space}>{space}</Radio>)}</Radio.Group>{!spaces.some(space => space.toLowerCase().includes(workspaceQuery.toLowerCase())) && <p>没有匹配的工作区</p>}</div>
    <div className="active-switch"><span>只看活动会话<small>运行、排队或等你响应</small></span><Switch aria-label="只看活动会话" checked={draft.active} onChange={active => setDraft({ ...draft, active })}/></div>
    <p className="panel-hint">任务阶段不等于运行状态。</p></div>
    <footer><Button onClick={() => setOpen(false)}>取消</Button><Button type="primary" data-apply={platform.id} onClick={() => { setFilters(draft); setOpen(false); }}>应用筛选</Button></footer>
  </div>;
  return <ConfigProvider theme={{ token: { colorPrimary: mobile ? "#0076d6" : "#6a5486" } }}><section className={`platform ${platform.id}`} data-platform={platform.id}>
    <div className="platform-caption"><strong>{platform.name}</strong><span>{platform.subtitle}</span></div>
    <div className={`device ${mobile ? "phone" : "desktop"}`}>
      <div className="device-bar">{mobile ? <><b>9:41</b><span>▰ ▰ ▰</span></> : <><span className="traffic"><i/><i/><i/></span><span>Wand</span></>}</div>
      <div className="device-body">
        {!mobile && <aside className="rail"><b>W</b><span className="current">▤<small>对话</small></span><span>▱<small>工作区</small></span><span>▥<small>任务</small></span><span className="rail-bottom">⚙<small>设置</small></span></aside>}
        <div className="conversation-pane">
          <div className="list-title"><h2>{mobile ? "聊天" : "对话"}</h2><span>{mobile ? "建群　更多" : "‹"}</span></div>
          <div className="tools">
            <div className="search-row"><WandSearchField label={`${platform.name} 搜索对话或任务`} placeholder="搜索对话或任务" value={query} onValueChange={setQuery}/>
              <Popover open={open} onOpenChange={changeOpen} placement="bottomRight" trigger="click" arrow={false} destroyOnHidden content={panel} getPopupContainer={() => document.getElementById("wand-react-ui-portals")!}>
                <Button data-filter={platform.id} aria-label={`${platform.name} 筛选${count ? `，${count} 个条件` : ""}`} aria-expanded={open} className={`filter-trigger ${count ? "selected" : ""}`}><Funnel/><span>{count || "筛选"}</span></Button></Popover>
            </div>
            <div className="filter-summary"><span title={count ? [filters.stage, filters.space, filters.active ? "活动" : ""].filter(Boolean).join(" · ") : "全部任务状态 · 全部工作区"}>{count ? `${filters.stage === stages[0] ? "全部状态" : filters.stage} · ${filters.space === spaces[0] ? "全部工作区" : filters.space}${filters.active ? " · 活动" : ""}` : "全部状态 · 全部工作区"}</span>{count ? <Button size="small" type="text" data-reset={platform.id} onClick={reset}>清除</Button> : null}</div>
          </div>
          <div className="result-count" role="status">{people.length} 个对话 · {matching.length} 条关联会话{count || query ? "匹配" : ""}</div>
          <div className="conversation-list">
            {!matching.length && <div className="empty"><Funnel/><strong>没有符合条件的对话</strong><p>试试其他状态或工作区</p><Button onClick={reset}>清除筛选</Button>{query && <Button type="text" onClick={() => setQuery("")}>清空搜索</Button>}</div>}
            {people.map(person => {
              const rows = matching.filter(row => row.person === person), first = rows[0];
              const isExpanded = expanded.includes(person);
              return <div className="person-group" key={person}>
                <button className="person-row" aria-expanded={isExpanded} onClick={() => setExpanded(expanded.includes(person) ? expanded.filter(name => name !== person) : [...expanded, person])}>
                  <span className="avatar" style={{ background: first.color }}>{first.avatar}</span><span className="person-copy"><strong>{person}</strong><span>{count || query ? `${rows.length} 条会话符合条件` : first.preview}</span></span><span className="time">{first.time}<small>{isExpanded ? "⌄" : "›"}</small></span>
                </button>
                {isExpanded && <div className="task-rows">{rows.map(row => <div className="task-row" key={row.title}><div className="task-title"><span title={row.title}>{row.title}</span></div><div className="task-meta"><span className={`stage stage-${stages.indexOf(row.stage)}`}>{row.stage}</span><span className="workspace-name">{row.space}</span></div></div>)}</div>}
              </div>;
            })}
          </div>
          {mobile && <nav className="bottom-nav"><span className="active">▤<small>聊天</small></span><span>▱<small>工作区</small></span><span>▧<small>知识库</small></span><span>▥<small>任务</small></span></nav>}
        </div>
      </div>
      {mobile && <div className="home-indicator"/>}
    </div>
    <p className="platform-note">{platform.note}</p>
  </section></ConfigProvider>;
}
function App() {
  const [mode, setMode] = React.useState("default");
  return <main className="design-board">
    <header className="board-heading"><div><p>WAND / CONVERSATION FILTERS</p><h1>少一行控件，多一点专注。</h1><span>搜索 + 筛选同排 · 状态与工作区组合筛选 · 不离开当前对话</span></div><div className="board-controls"><span className="board-disclaimer">交互设计稿 · 示例数据 · 非实机截图</span><Radio.Group optionType="button" buttonStyle="solid" value={mode} onChange={e => setMode(e.target.value)} options={[{ label: "默认列表", value: "default" }, { label: "已筛选", value: "filtered" }]}/></div></header>
    <div className="platforms">{platforms.map(platform => <PreviewList key={`${platform.id}-${mode}`} platform={platform} mode={mode}/>)}</div>
    <section className="design-notes"><div><b>01 / 入口不挪位</b><p>默认显示“筛选”，生效后显示条件数。点击从按钮下方展开，不挤占搜索框，不跳页。</p></div><div><b>02 / 归属不猜测</b><p>状态只标在具体任务上；员工保留身份与匹配数。工作区按会话真实归属筛选。</p></div><div><b>03 / 筛选不改变工作</b><p>两个维度取交集，不改任务状态、不启动执行。清除筛选保留搜索和当前已打开对话。</p></div></section>
    <p className="footnote">Web 使用现有组件与主题；原生端为布局模拟，落地使用 SwiftUI / Material 原生控件。点击任意“筛选”可体验状态、工作区搜索及清除路径。</p>
  </main>;
}
installReactUiStyles();
createRoot(document.getElementById("root")!).render(<WandUiProvider><ConfigProvider theme={{ token: { motion: !window.matchMedia("(prefers-reduced-motion: reduce)").matches } }}><App/></ConfigProvider></WandUiProvider>);
