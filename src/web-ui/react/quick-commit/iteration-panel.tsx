// 快捷提交面板的「本次变更输入」区：默认用本轮迭代的提示词标题总结改动，
// 不再每次都把完整 diff 灌给模型。用户可以往回勾历史条目，或整套切回完整 diff。
//
// 交互口径（和服务端一致）：
//   - 勾选集合默认为「上次提交以来」的条目；勾选为空时自动退回读 diff；
//   - 切换输入源会持久化（下次打开面板还是同一个选择）；
//   - 模式只是「谁来读什么」，不影响提交成功后把哪些条目记成已提交。

import * as React from "react";

import { WandSwitch } from "../ui";
import { classNames } from "../ui/class-names";
import { formatTaskRecency } from "../workspaces/sidebar-task-meta";
import type {
  QuickCommitContextMode,
  QuickCommitIterationContext,
  QuickCommitIterationEntry,
} from "./types";

export const ITERATION_CONTEXT_MODES: ReadonlyArray<{
  mode: QuickCommitContextMode;
  label: string;
  hint: string;
}> = [
  { mode: "iteration", label: "迭代提示词", hint: "只用本轮改动期间发过的提示词总结，不读代码" },
  { mode: "diff", label: "完整 diff", hint: "把完整改动交给模型，最准确但更慢、更费 token" },
];

export interface IterationContextPanelProps {
  context: QuickCommitIterationContext;
  mode: QuickCommitContextMode;
  selectedIds: ReadonlySet<string>;
  includeDiff: boolean;
  disabled?: boolean;
  onModeChange(mode: QuickCommitContextMode): void;
  onToggleEntry(id: string, checked: boolean): void;
  /** pending = 上次提交以来的（默认）；all = 全部；none = 清空。 */
  onSelectAll(scope: "pending" | "all" | "none"): void;
  onIncludeDiffChange(value: boolean): void;
}

function entryMeta(entry: QuickCommitIterationEntry, now: number): string {
  const recency = formatTaskRecency(entry.createdAt, now);
  return entry.consumed ? `${recency} · 已提交` : recency;
}

export function IterationContextPanel({
  context,
  mode,
  selectedIds,
  includeDiff,
  disabled = false,
  onModeChange,
  onToggleEntry,
  onSelectAll,
  onIncludeDiffChange,
}: IterationContextPanelProps): React.ReactElement {
  const [now, setNow] = React.useState(() => Date.now());
  // 相对时间只在面板打开时刷新一次，不必按秒重渲染。
  React.useEffect(() => setNow(Date.now()), [context]);
  const selectedCount = context.entries.filter((entry) => selectedIds.has(entry.id)).length;
  const pendingCount = context.entries.filter((entry) => !entry.consumed).length;

  return (
    <section className="wand-quick-iteration" aria-labelledby="wand-quick-iteration-title">
      <div className="wand-quick-section-heading">
        <h3 id="wand-quick-iteration-title">本次变更输入</h3>
        <span title={context.iteration.isDefault ? "没单独选里程碑的任务都归到它" : undefined}>
          {context.iteration.isDefault ? "默认迭代" : context.iteration.name}
        </span>
      </div>

      <div className="wand-quick-iteration-modes" role="radiogroup" aria-label="生成 Commit 信息的输入">
        {ITERATION_CONTEXT_MODES.map((item) => (
          <button
            key={item.mode}
            type="button"
            role="radio"
            aria-checked={mode === item.mode}
            className={classNames("wand-quick-iteration-mode", mode === item.mode && "is-selected")}
            title={item.hint}
            disabled={disabled}
            onClick={() => onModeChange(item.mode)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {mode === "diff" ? (
        <p className="wand-quick-iteration-hint">
          {context.defaultEntryIds.length > 0
            ? `将把完整 diff 交给模型，并照常把本轮未提交的 ${context.defaultEntryIds.length} 条变更记为已提交。`
            : "将把完整 diff 交给模型。"}
        </p>
      ) : context.entries.length === 0 ? (
        <p className="wand-quick-iteration-hint">
          本轮迭代还没有记录到提示词，这次会改读完整 diff。
        </p>
      ) : (
        <>
          <ul className="wand-quick-iteration-list">
            {context.entries.map((entry) => (
              <li key={entry.id}>
                <label title={entry.detail || entry.title}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(entry.id)}
                    disabled={disabled}
                    onChange={(event) => onToggleEntry(entry.id, event.currentTarget.checked)}
                  />
                  <span className="wand-quick-iteration-entry-title">{entry.title}</span>
                  <span className="wand-quick-iteration-entry-meta">
                    {entryMeta(entry, now)}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="wand-quick-iteration-actions">
            <span>
              {selectedCount > 0
                ? `已选 ${selectedCount} 条${pendingCount > 0 ? `（本轮未提交 ${pendingCount} 条）` : ""}`
                : "没有勾选任何条目，这次会改读完整 diff"}
              {context.truncated ? " · 更早的历史未显示" : ""}
            </span>
            <div>
              <button type="button" disabled={disabled} onClick={() => onSelectAll("pending")}>上次提交以来</button>
              <button type="button" disabled={disabled || context.entries.length === selectedCount} onClick={() => onSelectAll("all")}>全选</button>
              <button type="button" disabled={disabled || selectedCount === 0} onClick={() => onSelectAll("none")}>清空</button>
            </div>
          </div>
          <div className="wand-quick-iteration-diff-toggle">
            <div>
              <strong>同时附上完整 diff</strong>
              <span>提示词说不清楚时用它兜底。</span>
            </div>
            <WandSwitch
              id="wand-quick-iteration-diff"
              checked={includeDiff}
              disabled={disabled}
              ariaLabel="同时附上完整 diff"
              onCheckedChange={onIncludeDiffChange}
            />
          </div>
        </>
      )}
    </section>
  );
}
