import * as React from "react";
import { Checkbox } from "antd";
import { WandButton, WandIconButton } from "../ui/button";
import { WandIcon } from "../ui/icons";
import { lineDiff, visibleDiff, inlineSegments, type DiffRow } from "./diff-model";

export interface ReviewChange {
  documentId: string;
  title: string;
  oldTitle: string;
  before: string;
  after: string;
  source: "manual" | "generated";
}

function DiffCell({ row, side }: { row: DiffRow; side: "left" | "right" }) {
  const value = row[side];
  const tone = row.changed ? value ? side === "left" ? "deleted" : "added" : "gap" : "unchanged";
  const segments = value && row.changed && row.left && row.right ? inlineSegments(row.left.text, row.right.text, side) : null;
  return <div className={`diff-cell ${tone}`} data-side={side}>
    <span className="diff-number" aria-label={value ? `${side === "left" ? "旧" : "新"}第 ${value.number} 行` : undefined}>{value?.number ?? ""}</span>
    <span className="diff-sign" aria-hidden="true">{tone === "deleted" ? "−" : tone === "added" ? "+" : ""}</span>
    <code>{value ? segments ? segments.map((part, index) => part.changed ? <mark key={index}>{part.text}</mark> : <React.Fragment key={index}>{part.text}</React.Fragment>) : value.text || "\u00a0" : "\u00a0"}</code>
  </div>;
}

export function DiffReview({ change, onCancel, onApply, onBack }: {
  change: ReviewChange; onCancel(): void; onApply(): void; onBack(): void;
}) {
  const model = React.useMemo(() => lineDiff(change.before, change.after), [change.before, change.after]);
  const [all, setAll] = React.useState(false);
  const [expanded, setExpanded] = React.useState(new Set<number>());
  const [current, setCurrent] = React.useState(1);
  const [applied, setApplied] = React.useState(false);
  const body = React.useRef<HTMLDivElement>(null);
  const visible = visibleDiff(model.rows, expanded, all);
  const titleChanged = change.oldTitle !== change.title;
  const hasChanges = !!model.hunks || titleChanged;
  const jump = (offset: number) => {
    const next = Math.max(1, Math.min(model.hunks, current + offset));
    setCurrent(next);
    const target = body.current?.querySelector<HTMLElement>(`[data-hunk="${next}"]`);
    if (target && body.current) body.current.scrollTo({ top: target.offsetTop - body.current.offsetTop - 10, behavior: "instant" });
  };
  return <section className="diff-review" aria-label="修改对比" data-review-source={change.source}>
    <header className="diff-heading"><div><span className="diff-overline">{change.source === "generated" ? "重新生成的内容" : "待保存的修改"}</span><h1>核对修改</h1><p>左侧是已保存版本，右侧是本次修改。</p></div><div className="diff-summary"><span className="diff-add-count">+{model.added}</span><span className="diff-del-count">−{model.removed}</span><span>{model.hunks} 处差异</span></div></header>
    <div className="diff-filebar"><div className="diff-file-name"><WandIcon name="file" size={15}/><strong>{change.title}.md</strong><span className="diff-source">{change.source === "generated" ? "AI 生成" : "手动修改"}</span></div><div className="diff-tools"><Checkbox checked={all} onChange={event => setAll(event.target.checked)}>显示全文</Checkbox><div className="diff-navigation"><span>{model.hunks ? `${current} / ${model.hunks}` : "无差异"}</span><WandIconButton aria-label="上一处差异" title="上一处差异" disabled={current <= 1 || !model.hunks} onClick={() => jump(-1)}><WandIcon name="chevronUp" size={16}/></WandIconButton><WandIconButton aria-label="下一处差异" title="下一处差异" disabled={current >= model.hunks} onClick={() => jump(1)}><WandIcon name="chevronDown" size={16}/></WandIconButton></div></div></div>
    <div className="diff-scroll-frame"><div className="diff-columns"><div><span className="diff-version-dot old"/><strong>旧内容</strong><span>已保存</span><WandIcon name="lock" size={12}/></div><div><span className="diff-version-dot next"/><strong>新内容</strong><span>{applied ? "已更新" : "待确认"}</span></div></div>
      {titleChanged && <div className="diff-title-change"><div><small>标题</small><del>{change.oldTitle || "（新建文档）"}</del></div><div><small>标题</small><ins>{change.title}</ins></div></div>}
      <div className="diff-lines" ref={body} tabIndex={0} aria-label="左右同步的文档差异">
        {!hasChanges && <div className="diff-no-change"><WandIcon name="check" size={18}/>新旧内容一致，无需替换。</div>}
        {visible.map(item => item.type === "fold" ? <button className="diff-fold" key={`fold-${item.from}`} onClick={() => setExpanded(value => new Set([...value, item.from]))}><WandIcon name="plus" size={12}/><span>展开 {item.count} 行未修改内容</span></button>
          : <div key={item.row.index} className={`diff-row ${item.row.changed ? "changed" : ""} ${item.row.changed && item.row.hunk === current ? "current" : ""}`} data-hunk={item.row.changed ? item.row.hunk : undefined}><DiffCell row={item.row} side="left"/><DiffCell row={item.row} side="right"/></div>)}
      </div>
    </div>
    <footer className="diff-confirm"><div className="diff-confirm-note" role="status"><WandIcon name={applied ? "check" : "info"} size={15}/><span>{applied ? "已更新，当前文档已采用新内容。" : "确认后替换当前文档，其他知识保持不变。"}</span></div><div className="diff-confirm-actions"><WandButton kind="ghost" onClick={onBack}>{applied ? "返回文档" : change.source === "manual" ? "继续编辑" : "返回文档"}</WandButton><WandButton disabled={applied} onClick={onCancel}>保留旧内容</WandButton><WandButton kind="primary" className="diff-confirm-primary" disabled={applied || !hasChanges} onClick={() => { onApply(); setApplied(true); }}>{applied ? <><WandIcon name="check" size={14}/>已更新</> : "确认更新"}</WandButton></div></footer>
  </section>;
}
