import * as React from "react";
import { Collapse } from "antd";
import { WandButton, WandIconButton, WandIcon } from "../../ui/index.js";
import { SUBTASK_DISCLOSURE_STYLES } from "./styles.js";

export interface ChatSubtask {
  id: string;
  title: string;
  status: string;
  latest: string;
  instruction: string;
  detail: React.ReactNode;
}
export interface SubtaskPanelProps {
  tasks: ChatSubtask[];
  registerOpen(open: (id?: string) => void): void;
  prepareOpenChange(): void;
  onOpenChange(open: boolean): () => void;
  hasNestedPopup(): boolean;
}
interface PanelMemory { scroll: Map<string, number> }
export function SubtaskPanel({ tasks, registerOpen, prepareOpenChange, onOpenChange, hasNestedPopup }: SubtaskPanelProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState(tasks[0]?.id || "");
  const [listOpen, setListOpen] = React.useState(true);
  const [visited, setVisited] = React.useState<Set<string>>(new Set());
  const trigger = React.useRef<HTMLButtonElement>(null);
  const memory = React.useRef<PanelMemory>({ scroll: new Map() });
  const selectedId = tasks.some(task => task.id === selected) ? selected : tasks[0]?.id;
  const panelId = React.useId();
  const select = (id: string): void => { setSelected(id); setVisited(previous => new Set([...previous, id])); };
  const changeOpen = (next: boolean): void => {
    prepareOpenChange();
    setOpen(next);
    if (!next) trigger.current?.focus({ preventScroll: true });
  };
  React.useLayoutEffect(() => {
    registerOpen(id => { if (id) select(id); else if (selectedId) select(selectedId); changeOpen(true); });
  });
  React.useLayoutEffect(() => onOpenChange(open && tasks.length > 0), [open, tasks.length > 0]);
  React.useEffect(() => {
    const close = (event: KeyboardEvent): void => {
      if (!open || event.key !== "Escape" || event.isComposing) return;
      // A nested popup gets first refusal; do not close both layers.
      if (hasNestedPopup()) return;
      event.preventDefault(); event.stopPropagation(); changeOpen(false);
    };
    document.addEventListener("keydown", close, true);
    return () => document.removeEventListener("keydown", close, true);
  }, [open]);
  const counts = new Map<string, number>();
  tasks.forEach(task => counts.set(task.status, (counts.get(task.status) || 0) + 1));
  const summary = Array.from(counts, ([label, count]) => `${count}${label}`).join(" · ");
  return <>
    <div className="chat-subtasks-toolbar" hidden={!tasks.length}>
      <WandButton ref={trigger} className="chat-subtasks-trigger" style={{ visibility: tasks.length ? "visible" : "hidden" }}
        aria-expanded={open} aria-controls={panelId} title={summary} onClick={() => { if (selectedId) select(selectedId); changeOpen(!open); }}>
        <WandIcon name="splitHorizontal" size={14}/><span>子任务 {tasks.length}</span><span className="chat-subtasks-counts">{summary}</span>
      </WandButton>
    </div>
    <aside id={panelId} className="chat-subtasks-panel" aria-label="子任务详情" aria-hidden={!open} inert={!open}>
      <header><strong>子任务 <span className="chat-subtasks-panel-count">{tasks.length}</span></strong><WandIconButton aria-label="关闭子任务详情" onClick={() => changeOpen(false)}><WandIcon name="close" size={16}/></WandIconButton></header>
      <Collapse ghost bordered={false} styles={SUBTASK_DISCLOSURE_STYLES} activeKey={listOpen ? ["list"] : []} onChange={keys => setListOpen(keys.includes("list"))} items={[{
        key: "list", label: "任务列表", forceRender: true,
        children: <div className="chat-subtasks-list">{tasks.map(task => <WandButton key={task.id} kind="ghost" className="chat-subtasks-item"
          aria-pressed={selectedId === task.id} onClick={() => select(task.id)}>
          <span className="chat-subtasks-item-copy"><span>{task.title}</span><small>{task.status}</small></span>
          <span className="chat-subtasks-item-check" aria-hidden="true"><WandIcon name="check" size={13}/></span>
        </WandButton>)}</div>,
      }]}/>
      {tasks.filter(task => visited.has(task.id) || open && task.id === selectedId).map(task => <div key={task.id}
        className="chat-subtasks-scroll" hidden={task.id !== selectedId} data-subtask-id={task.id}
        ref={node => { if (node && node.scrollTop === 0) node.scrollTop = memory.current.scroll.get(task.id) || 0; }}
        onScroll={event => memory.current.scroll.set(task.id, event.currentTarget.scrollTop)}>
        <div className="chat-subtasks-current"><strong>{task.title}</strong><span>{task.status}</span></div>
        {task.latest && <p className="chat-subtasks-latest">最新活动 · {task.latest}</p>}
        {task.detail}
      </div>)}
    </aside>
  </>;
}
