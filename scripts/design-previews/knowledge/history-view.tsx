import * as React from "react";
import { Checkbox, Radio, Tag } from "antd";
import { WandButton, WandIconButton } from "../../../src/web-ui/react/ui/button";
import { WandIcon } from "../../../src/web-ui/react/ui/icons";
import { lineDiff, visibleDiff, inlineSegments, type DiffRow } from "./diff-model";
import type { DocumentRevision } from "./history-model";
import "./history.css";

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

export function HistoryView({ documentTitle, currentContent, revisions, onClose, onRestore }: {
  documentTitle: string;
  currentContent: string;
  revisions: DocumentRevision[];
  onClose(): void;
  onRestore(revision: DocumentRevision): void;
}) {
  const [selectedRevId, setSelectedRevId] = React.useState<string>(revisions[0]?.id || "current");
  const [compareMode, setCompareMode] = React.useState<"previous" | "current">("previous");
  const [all, setAll] = React.useState(false);
  const [expanded, setExpanded] = React.useState(new Set<number>());
  const [currentHunk, setCurrentHunk] = React.useState(1);
  const bodyRef = React.useRef<HTMLDivElement>(null);

  const selectedIndex = revisions.findIndex(r => r.id === selectedRevId);
  const selectedRev = revisions[selectedIndex] || revisions[0];

  // Determine what before (left) and after (right) are:
  // If compareMode is 'previous': compare previous revision (left) with selected revision (right)
  // If compareMode is 'current': compare selected revision (left) with current version (right)
  let beforeTitle = "";
  let beforeContent = "";
  let afterTitle = "";
  let afterContent = "";

  if (compareMode === "previous") {
    const prevRev = revisions[selectedIndex + 1];
    if (prevRev) {
      beforeTitle = `${prevRev.timestamp}（${prevRev.summary}）`;
      beforeContent = prevRev.content;
      afterTitle = `${selectedRev?.timestamp || "当前"}（${selectedRev?.summary || "选定版本"}）`;
      afterContent = selectedRev?.content || currentContent;
    } else {
      beforeTitle = "（初始创建前）";
      beforeContent = "";
      afterTitle = `${selectedRev?.timestamp || "初始版本"}（${selectedRev?.summary || "首个版本"}）`;
      afterContent = selectedRev?.content || currentContent;
    }
  } else {
    beforeTitle = `${selectedRev?.timestamp || "历史版本"}（${selectedRev?.summary || "所选历史"}）`;
    beforeContent = selectedRev?.content || "";
    afterTitle = "当前最新版本";
    afterContent = currentContent;
  }

  const model = React.useMemo(() => lineDiff(beforeContent, afterContent), [beforeContent, afterContent]);
  const visible = visibleDiff(model.rows, expanded, all);

  const jump = (offset: number) => {
    const next = Math.max(1, Math.min(model.hunks, currentHunk + offset));
    setCurrentHunk(next);
    const target = bodyRef.current?.querySelector<HTMLElement>(`[data-hunk="${next}"]`);
    if (target && bodyRef.current) bodyRef.current.scrollTo({ top: target.offsetTop - bodyRef.current.offsetTop - 10, behavior: "instant" });
  };

  return <section className="history-view" aria-label="版本历史记录">
    <aside className="history-sidebar" aria-label="版本列表">
      <div className="history-sidebar-header">
        <div className="history-title-row">
          <WandIcon name="history" size={16}/>
          <h3>版本历史</h3>
        </div>
        <span className="history-count">共 {revisions.length} 个版本记录</span>
      </div>
      <div className="history-revision-list" role="listbox" aria-label="历史版本列表">
        {revisions.map((rev, index) => {
          const isSelected = rev.id === selectedRevId;
          const isCurrent = index === 0;
          return <button
            key={rev.id}
            role="option"
            aria-selected={isSelected}
            className={`history-rev-item ${isSelected ? "selected" : ""}`}
            onClick={() => { setSelectedRevId(rev.id); setCurrentHunk(1); }}
          >
            <div className="rev-item-top">
              <span className="rev-timestamp">{rev.timestamp}</span>
              {isCurrent ? <span className="rev-badge current">当前</span> : rev.source === "auto" ? <span className="rev-badge auto">自动更新</span> : null}
            </div>
            <div className="rev-item-summary">{rev.summary}</div>
            <div className="rev-item-meta">
              <span>{rev.author}</span>
              <span className="rev-meta-divider">·</span>
              <span className="rev-chars">{rev.content.replace(/\s/g, "").length} 字</span>
            </div>
          </button>;
        })}
      </div>
    </aside>

    <main className="history-diff-main" aria-label="版本对比区">
      <header className="history-diff-toolbar">
        <div className="diff-meta-left">
          <WandButton kind="ghost" size="small" onClick={onClose}>
            <WandIcon name="chevronLeft" size={15}/>返回文档
          </WandButton>
          <span className="diff-doc-name">{documentTitle}</span>
          <span className="diff-stats">
            <span className="diff-stat-add">+{model.added}</span>
            <span className="diff-stat-del">−{model.removed}</span>
            <span className="diff-stat-hunk">{model.hunks} 处变更</span>
          </span>
        </div>

        <div className="diff-meta-right">
          <Radio.Group
            size="small"
            value={compareMode}
            onChange={e => setCompareMode(e.target.value)}
            options={[
              { label: "与上一版本对比", value: "previous" },
              { label: "与当前版本对比", value: "current" },
            ]}
          />
          <Checkbox checked={all} onChange={e => setAll(e.target.checked)}>显示全文</Checkbox>
          <div className="diff-nav-arrows">
            <span>{model.hunks ? `${currentHunk} / ${model.hunks}` : "无差异"}</span>
            <WandIconButton aria-label="上一处差异" title="上一处差异" disabled={currentHunk <= 1 || !model.hunks} onClick={() => jump(-1)}>
              <WandIcon name="chevronUp" size={14}/>
            </WandIconButton>
            <WandIconButton aria-label="下一处差异" title="下一处差异" disabled={currentHunk >= model.hunks} onClick={() => jump(1)}>
              <WandIcon name="chevronDown" size={14}/>
            </WandIconButton>
          </div>
          {selectedRev && selectedIndex > 0 && (
            <WandButton size="small" kind="primary" onClick={() => onRestore(selectedRev)}>
              <WandIcon name="history" size={13}/>恢复此版本
            </WandButton>
          )}
        </div>
      </header>

      <div className="diff-table-container">
        <div className="diff-column-headers">
          <div className="header-cell left">
            <span className="diff-dot old"/>
            <strong>旧版本：{beforeTitle}</strong>
          </div>
          <div className="header-cell right">
            <span className="diff-dot next"/>
            <strong>新版本：{afterTitle}</strong>
          </div>
        </div>

        <div className="diff-lines" ref={bodyRef} tabIndex={0} aria-label="左右同步的版本差异">
          {!model.hunks ? (
            <div className="diff-no-change">
              <WandIcon name="check" size={18}/>该版本之间无正文变更。
            </div>
          ) : (
            visible.map(item => item.type === "fold" ? (
              <button
                className="diff-fold"
                key={`fold-${item.from}`}
                onClick={() => setExpanded(v => new Set([...v, item.from]))}
              >
                <WandIcon name="plus" size={12}/>
                <span>展开 {item.count} 行未修改内容</span>
              </button>
            ) : (
              <div
                key={item.row.index}
                className={`diff-row ${item.row.changed ? "changed" : ""} ${item.row.changed && item.row.hunk === currentHunk ? "current" : ""}`}
                data-hunk={item.row.changed ? item.row.hunk : undefined}
              >
                <DiffCell row={item.row} side="left"/>
                <DiffCell row={item.row} side="right"/>
              </div>
            ))
          )}
        </div>
      </div>
    </main>
  </section>;
}
