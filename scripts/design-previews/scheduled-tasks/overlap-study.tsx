import * as React from "react";
import { createRoot } from "react-dom/client";
import { Calendar, Tooltip } from "antd";
import dayjs from "dayjs";
import { WandUiProvider } from "../../../src/web-ui/react/theme";
import { installReactUiStyles } from "../../../src/web-ui/react/styles";
import { WandButton, WandIconButton } from "../../../src/web-ui/react/ui/button";
import { WandIcon } from "../../../src/web-ui/react/ui/icons";
import { WandPopover } from "../../../src/web-ui/react/ui/popover";
import { usePopupDismiss } from "../../../src/web-ui/react/ui/popup-lifecycle";
import { PlushAvatar } from "../../../src/web-ui/react/avatars/plush-avatar";
import { resolveEmployeeAvatar } from "../../../src/plush-avatar";
import { employees } from "./fixtures";
import { studyClusters, studyDisplay, STUDY_COLUMN_GAP, STUDY_HOUR_PIXELS, STUDY_MARKER_HEIGHT, type StudyTime } from "./overlap-layout";
import "./overlap-study.css";

installReactUiStyles();
interface Item extends StudyTime { title: string; employee: number; status: "planned" | "completed"; }
const labels = { planned: "预计触发", completed: "完成" };
const glyphs = { planned: "history", completed: "check" } as const;
const time = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const allDays: { title: string; caption: string; items: Item[] }[] = [
  { title: "周一 12", caption: "同一时刻 · 并列", items: [
    { key: "same-a", start: 540, title: "整理项目日报", employee: 0, status: "planned" },
    { key: "same-b", start: 540, title: "检查构建状态", employee: 2, status: "planned" },
    { key: "same-c", start: 660, title: "汇总阅读笔记", employee: 1, status: "planned" },
  ] },
  { title: "周二 13", caption: "临近触发 · 不挤字", items: [
    { key: "near-a", start: 540, title: "整理每日变更", employee: 0, status: "planned" },
    { key: "near-b", start: 555, title: "检查待办队列", employee: 1, status: "planned" },
  ] },
  { title: "周三 14", caption: "部分重叠 · 起止已知示意", items: [
    { key: "span-a", start: 540, end: 600, title: "检查测试报告", employee: 2, status: "completed" },
    { key: "span-b", start: 570, end: 630, title: "核对交互说明", employee: 1, status: "completed" },
    { key: "span-c", start: 600, end: 660, title: "整理交付记录", employee: 0, status: "completed" },
    { key: "span-d", start: 690, end: 750, title: "复核下一批计划", employee: 2, status: "completed" },
  ] },
  { title: "周四 15", caption: "无重叠 · 使用整列", items: [
    { key: "clear-a", start: 540, title: "汇总依赖变化", employee: 2, status: "planned" },
    { key: "clear-b", start: 630, title: "整理项目笔记", employee: 1, status: "planned" },
  ] },
  { title: "周五 16", caption: "同刻 8 项 · 原位展开", items: [
    ...["核对待办事项", "汇总提交记录", "检查构建日志", "整理测试报告", "扫描文档差异", "核对更新接口", "整理交付清单", "检查依赖声明"].map((title, i): Item => ({ key: `dense-${i}`, start: 540, title, employee: i % 3, status: "planned" })),
    { key: "dense-after", start: 660, title: "密集时段后恢复整列", employee: 1, status: "planned" },
  ] },
  { title: "周六 17", caption: "", items: [] },
  { title: "周日 18", caption: "", items: [] },
];
function Face({ item }: { item: Item }) {
  const employee = employees[item.employee], config = resolveEmployeeAvatar(employee)!;
  return <span className="overlap-face" role="img" aria-label={`${employee.name}的头像`}><PlushAvatar config={config} size={16}/></span>;
}
function Copy({ item, expanded = false }: { item: Item; expanded?: boolean }) {
  return <><Face item={item}/><span className="overlap-event-meta"><time>{time(item.start)}</time><Tooltip title={labels[item.status]}><span className="overlap-status" role="img" aria-label={labels[item.status]}><WandIcon name={glyphs[item.status]} size={12}/></span></Tooltip></span><span className="overlap-event-title">{item.title}</span>{item.end !== undefined && <span className="overlap-end">至 {time(item.end)}</span>}{expanded && <span className="overlap-member">{employees[item.employee].name} · {labels[item.status]}</span>}</>;
}
function ItemButton({ item, style }: { item: Item; style?: React.CSSProperties }) {
  const [open, setOpen] = React.useState(false);
  return <WandPopover open={open} onOpenChange={setOpen} popupOwner={`overlap-item-${item.key}`} ariaLabel={item.title} className="overlap-record-popover" trigger={<WandButton kind="ghost" className="overlap-event" data-study-item={item.key} data-status={item.status} data-interval={item.end !== undefined} style={style} aria-label={`${time(item.start)} ${item.title} · ${labels[item.status]}`}><Copy item={item}/></WandButton>}>
    <article className="overlap-record"><header><h3>{item.title}</h3><WandIconButton aria-label="关闭任务详情" onClick={() => setOpen(false)}><WandIcon name="close"/></WandIconButton></header><p>{employees[item.employee].name}</p><p>{time(item.start)}{item.end !== undefined ? `–${time(item.end)} · 明确起止的假设示例` : " · 触发时刻，未假定持续时间"}</p><p>仅用于检查日历排布，不连接服务或运行任务。</p></article>
  </WandPopover>;
}
function Overflow({ items, hidden, style, id, dateLabel }: { items: Item[]; hidden: number; style?: React.CSSProperties; id: string; dateLabel?: string }) {
  const [open, setOpen] = React.useState(false), [selected, setSelected] = React.useState<string | null>(null);
  const close = () => { setOpen(false); setSelected(null); };
  usePopupDismiss(open && !!selected, () => setSelected(null));
  return <WandPopover open={open} onOpenChange={next => { setOpen(next); if (!next) setSelected(null); }} popupOwner={`overlap-more-${id}`} ariaLabel={`${dateLabel ? "这一天" : "这个时段"}的${items.length}项任务`} className="overlap-more-popover" sideOffset={0} trigger={<WandButton kind="ghost" className="overlap-more" data-study-overflow={id} style={style} aria-expanded={open} aria-label={`展开${dateLabel ? "这一天" : "这个时段"}的全部${items.length}项任务`}><span className="overlap-face-stack">{items.slice(0, 3).map(item => <Face key={item.key} item={item}/>)}</span><strong>＋{hidden}项</strong><span>{time(Math.min(...items.map(item => item.start)))}</span></WandButton>}>
    <section className="overlap-more-content"><header><div><h3>{dateLabel ?? (items.every(item => item.start === items[0].start) ? time(items[0].start) : `${time(Math.min(...items.map(item => item.start)))}–${time(Math.max(...items.map(item => item.start)))}`)} · {items.length}项任务</h3><p>按时间排列，不按员工分组</p></div><WandIconButton aria-label="收起这个时段的任务" onClick={close}><WandIcon name="close"/></WandIconButton></header>
      <ol>{items.map(item => <li key={item.key}><WandButton kind="ghost" className="overlap-expanded-item" data-selected={selected === item.key} aria-expanded={selected === item.key} onClick={() => setSelected(previous => previous === item.key ? null : item.key)}><Copy item={item} expanded/><WandIcon name="chevronDown" size={12}/></WandButton>
        <div className="overlap-item-expansion" data-open={selected === item.key} inert={selected !== item.key}><div><p>这项计划在 {time(item.start)} 触发。没有预设执行结束时间；正式页面在这里读取所选任务或本次执行的详情。</p></div></div></li>)}</ol>
    </section>
  </WandPopover>;
}
function Day({ day, index }: { day: typeof allDays[number]; index: number }) {
  const ref = React.useRef<HTMLDivElement>(null), [width, setWidth] = React.useState(176);
  React.useLayoutEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width)); observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const groups = studyClusters(day.items);
  return <section className="overlap-day" data-study-day={index}><header><strong>{day.title}</strong><span>{day.caption}</span></header><div ref={ref} className="overlap-day-hours">
    {groups.map(group => {
      const display = studyDisplay(group, width - 8), unit = (width - 8 - STUDY_COLUMN_GAP * (display.columns - 1)) / display.columns;
      return <React.Fragment key={group.key}>{display.visible.map(position => <ItemButton key={position.item.key} item={position.item} style={{ top: (position.item.start - 510) * STUDY_HOUR_PIXELS / 60, height: position.height, left: 4 + position.lane * (unit + STUDY_COLUMN_GAP), width: unit }}/>) }
        {!!display.hidden.length && <Overflow id={`day-${index}`} items={group.positions.map(position => position.item)} hidden={display.hidden.length} style={{ top: (Math.min(...display.hidden.map(position => position.item.start)) - 510) * STUDY_HOUR_PIXELS / 60, left: 4 + (display.columns - 1) * (unit + STUDY_COLUMN_GAP), width: unit, height: STUDY_MARKER_HEIGHT }}/>}</React.Fragment>;
    })}
  </div></section>;
}
function App() {
  return <WandUiProvider><main className="overlap-study"><header className="overlap-page-header"><div><span className="overlap-kicker">Wand · 全局日历 · 重叠场景设计核对</span><h1>同一时间，也要看得清。</h1></div><span className="overlap-study-badge">隔离设计稿 · 全部为假设数据</span></header>
    <section aria-label="周时间轴重叠设计"><div className="overlap-section-heading"><h2>周视图：并列，不互相遮挡</h2><span>2026年10月12日—18日 · 全部员工</span></div><p className="overlap-help">两项可读时并列，拥挤时保留可读宽度并显示“＋N 项”。点开后原位查看全部，不换页。</p>
      <div className="overlap-scroll"><div className="overlap-week"><aside className="overlap-axis"><div/><section>{Array.from({ length: 9 }, (_, i) => <span key={i} style={{ top: i * 32 }}>{time(510 + i * 30)}</span>)}</section></aside>{allDays.map((day, index) => <Day key={day.title} day={day} index={index}/>)}</div></div>
      <div className="overlap-legend"><span><i data-planned/>虚线：触发标记，不代表持续时长</span><span><i/>实色长块：起止已知时的排布示意</span><span>同一结束／开始时刻可复用同一列</span></div>
    </section>
    <section className="overlap-month-section" aria-label="月视图密集任务设计"><div className="overlap-section-heading"><h2>月视图：上下排列，多项原位展开</h2><span>不会把同一日期挤成多根细线</span></div><div className="overlap-month-scroll"><Calendar value={dayjs("2026-10-16")} headerRender={() => null} fullCellRender={(date, info) => {
      if (info.type !== "date") return info.originNode;
      const entries = date.format("YYYY-MM-DD") === "2026-10-16" ? allDays[4].items : [];
      return <div className="overlap-month-cell"><span>{date.date()}</span>{entries.slice(0, 2).map(item => <ItemButton key={item.key} item={item}/>)}{entries.length > 2 && <Overflow id="month" dateLabel="10月16日" items={entries} hidden={entries.length - 2}/>}</div>;
    }}/></div></section>
    <footer>当前定时计划只有触发时刻；部分旧记录的结束字段也可能是结算时间。周三的起止区间仅解释布局规则，不会据此虚构现有任务的耗时。</footer>
  </main></WandUiProvider>;
}
createRoot(document.getElementById("root")!).render(<App/>);
