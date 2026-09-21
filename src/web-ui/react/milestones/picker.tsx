// 「里程碑（迭代）」选择器：新建任务时点开下拉，选历史里程碑，或就地新增一个。
// 任务看板与「新建任务」对话框共用这一个组件，保证两处行为一致。
// 传了 `workspaceId` 就只展示该工作区的迭代（含全局的），新增的也归属该工作区。

import * as React from "react";

import { WAND_MILESTONE_NAME_MAX_LENGTH } from "../../../task-types";
import { WandButton, WandIcon, WandPopover } from "../ui";
import { classNames } from "../ui/class-names";
import { milestonesStore, visibleMilestones } from "./controller";
import type { MilestoneOption } from "./repository";
import { failureMessage } from "../errors";

export interface MilestonePickerProps {
  value: string | null;
  onChange(id: string | null): void;
  /** 当前所选工作区；用来按工作区过滤列表，新增的迭代也归到它下面。 */
  workspaceId?: string | null;
  /** 新建成功时回调：宿主要在建完项目后回填工作区时用它记下新迭代的 id。 */
  onCreated?(created: MilestoneOption): void;
  disabled?: boolean;
  /** 已经在外面加载过列表的宿主（例如任务看板）可以把它传进来，省一次订阅渲染。 */
  items?: readonly MilestoneOption[];
  className?: string;
  align?: "start" | "center" | "end";
}

export function MilestonePicker({
  value,
  onChange,
  workspaceId = null,
  onCreated,
  disabled = false,
  items: itemsProp,
  className,
  align = "start",
}: MilestonePickerProps): React.ReactElement {
  const snapshot = React.useSyncExternalStore(
    milestonesStore.subscribe,
    milestonesStore.getSnapshot,
    milestonesStore.getSnapshot,
  );
  // 已选工作区时只留它自己的迭代；外部传进来的列表同样过一层，两处过滤口径一致。
  const items = visibleMilestones(itemsProp ?? snapshot.items, workspaceId);
  const scoped = Boolean(workspaceId?.trim());

  const [open, setOpen] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  // 只在真正展开下拉时拉列表：宿主（例如「新建任务」对话框）可能一直挂载在登录前，
  // 提前请求会拿 401；加载失败后下次展开会自动重试（loaded 仍为 false）。
  // 已经带值（任务详情）时也要拉一次，否则触发按钮只有占位文字，看起来像没设过迭代。
  React.useEffect(() => {
    if (itemsProp || (!open && !value)) return;
    void milestonesStore.load();
  }, [itemsProp, open, value]);

  const selected = value ? items.find((item) => item.id === value) ?? null : null;

  const close = (nextValue?: string | null): void => {
    if (nextValue !== undefined) onChange(nextValue);
    setOpen(false);
    setCreating(false);
    setName("");
    setError("");
  };

  const startCreating = (): void => {
    setCreating(true);
    setError("");
    // 下拉刚切到输入态时聚焦，键盘可以直接输入。
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError("");
    try {
      const created = await milestonesStore.create(trimmed, workspaceId);
      onCreated?.(created);
      close(created.id);
    } catch (cause) {
      setError(failureMessage(cause, "无法新增里程碑。"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <WandPopover
      open={open}
      onOpenChange={(next) => {
        if (disabled) return;
        setOpen(next);
        if (!next) {
          setCreating(false);
          setError("");
        }
      }}
      align={align}
      side="bottom"
      ariaLabel="选择里程碑"
      className="milestone-picker-menu"
      trigger={<button
        type="button"
        className={classNames("milestone-picker-trigger", selected && "is-set", className)}
        aria-label={selected ? `里程碑：${selected.name}` : "里程碑"}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        title={selected ? `里程碑：${selected.name}` : "里程碑"}
      >
        <WandIcon name="milestone" size={13}/>
        <span className="milestone-picker-trigger-label">{selected ? selected.name : "里程碑"}</span>
        <WandIcon name="chevron" size={12} className="milestone-picker-trigger-caret"/>
      </button>}
    >
      <div className="milestone-picker" role="dialog" aria-label="选择里程碑">
        <div className="milestone-picker-head">
          <strong>里程碑</strong>
          {selected ? <button
            type="button"
            className="milestone-picker-clear"
            onClick={() => close(null)}
          >{selected.isDefault ? "回到默认" : "清除"}</button> : null}
        </div>
        {creating ? (
          <div className="milestone-picker-create">
            <input
              ref={inputRef}
              className="milestone-picker-input"
              type="text"
              value={name}
              maxLength={WAND_MILESTONE_NAME_MAX_LENGTH}
              placeholder="里程碑名称，例如：v5.0 发布"
              aria-label="新里程碑名称"
              disabled={busy}
              onChange={(event) => setName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setCreating(false);
                }
              }}
            />
            <div className="milestone-picker-create-actions">
              <button
                type="button"
                className="milestone-picker-create-cancel"
                onClick={() => { setCreating(false); setError(""); }}
                disabled={busy}
              >取消</button>
              <WandButton
                kind="primary"
                size="small"
                type="button"
                disabled={!name.trim() || busy}
                onClick={() => void submit()}
              >{busy ? "新增中…" : "新增"}</WandButton>
            </div>
            {error ? <p className="milestone-picker-error" role="alert">{error}</p> : null}
          </div>
        ) : (
          <>
            {items.length > 0 ? (
              <div className="milestone-picker-list" role="listbox" aria-label="历史里程碑">
                {items.map((item) => <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={item.id === value}
                  className={classNames("milestone-picker-item", item.id === value && "is-selected")}
                  onClick={() => close(item.id)}
                >
                  <WandIcon name="milestone" size={13} className="milestone-picker-item-icon"/>
                  <span className="milestone-picker-item-name">{item.name}</span>
                  {/* 默认迭代：没选迭代的任务都会落到它下面，所以标出来（不可删除）。 */}
                  {item.isDefault ? <span className="milestone-picker-item-default">默认</span> : null}
                  {/* 按工作区过滤时，把跨工作区可见的全局迭代标出来，避免看起来「串台」。 */}
                  {scoped && !item.workspaceId && !item.isDefault ? <span className="milestone-picker-item-scope">全局</span> : null}
                  {item.taskCount > 0 ? <span className="milestone-picker-item-count">{item.taskCount}</span> : null}
                </button>)}
              </div>
            ) : <p className="milestone-picker-empty">{scoped ? "这个工作区还没有迭代，新增一个吧。" : "还没有里程碑，新增一个吧。"}</p>}
            <button type="button" className="milestone-picker-add" onClick={startCreating}>
              <WandIcon name="plus" size={13}/><span>新增里程碑</span>
            </button>
          </>
        )}
      </div>
    </WandPopover>
  );
}
