import * as React from "react";
import type { AttentionItem } from "../../../attention";
import { taskBoardController } from "../issues/task-board-controller";
import { WandIcon } from "../ui";
import { classNames } from "../ui/class-names";
import { useUiDispatch, useUiStoreSnapshot } from "../shell/ui-store-react";
import { refreshAttention, useAttentionItems } from "./attention-store";

function sessionSignature(groups: ReadonlyArray<{ entries: ReadonlyArray<{ id: string; status: string }> }>): string {
  return groups.map((group) => group.entries.map((entry) => `${entry.id}:${entry.status}`).join(",")).join("|");
}

/** 条数与清单共用同一份快照：拉取跟着会话签名走，报错处理掉后徽标与清单一起消失。 */
function useAttentionItemsLive(): readonly AttentionItem[] {
  const items = useAttentionItems();
  const snapshot = useUiStoreSnapshot();
  const signature = sessionSignature(snapshot.sidebar.groups);

  React.useEffect(() => {
    refreshAttention();
  }, [signature]);

  return items;
}

function openAttention(item: AttentionItem, dispatch: ReturnType<typeof useUiDispatch>, collapse: () => void): void {
  // 展开组件补齐关闭路径：选中任一动作即收起。
  collapse();
  if (item.sessionId) {
    taskBoardController.close();
    void dispatch({ type: "session.select", id: item.sessionId });
    return;
  }
  taskBoardController.open("", "", "teams");
}

function AttentionList({
  items,
  onOpen,
}: {
  items: readonly AttentionItem[];
  onOpen(item: AttentionItem): void;
}): React.ReactElement {
  return (
    <ul className="home-attention-list">
      {items.map((item) => (
        <li key={item.id}>
          <button type="button" className="home-attention-item" onClick={() => onOpen(item)}>
            <strong>{item.title}</strong>
            <span>{item.detail}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * 侧栏头部那枚报错徽标。报错不罗列：这里只显示条数，点开由调用方
 * 在同一个位置的下方就地展开清单（`HomeAttentionPanel`）。
 */
export function HomeAttentionBadge({ open, onToggle }: {
  readonly open: boolean;
  readonly onToggle: () => void;
}): React.ReactElement | null {
  const items = useAttentionItemsLive();
  if (items.length === 0) return null;
  const label = `${items.length} 个报错`;
  const hint = open ? `${label}，收起清单` : `${label}，点开查看`;
  return (
    <button
      type="button"
      className={classNames("sidebar-attention-badge", open && "is-open")}
      title={hint}
      aria-label={hint}
      aria-expanded={open}
      onClick={onToggle}
    >
      <WandIcon name="info" size={12} className="sidebar-attention-badge-icon"/>
      <span className="sidebar-attention-badge-label">{label}</span>
      <WandIcon name="chevronDown" size={11} className="sidebar-attention-badge-chevron"/>
    </button>
  );
}

/**
 * 侧栏里的报错清单：没有自己的触发条，展开由头部徽标控制。
 * 收起用同一段动画倒放，闭合时不占位也不可聚焦。
 */
export function HomeAttentionPanel({ open, onClose }: {
  readonly open: boolean;
  readonly onClose: () => void;
}): React.ReactElement | null {
  const items = useAttentionItemsLive();
  const dispatch = useUiDispatch();
  if (items.length === 0) return null;
  return (
    <div className="home-attention is-sidebar">
      <div
        className={classNames("home-attention-panel", open && "is-open")}
        inert={!open}
      >
        <AttentionList items={items} onOpen={(item) => openAttention(item, dispatch, onClose)}/>
      </div>
    </div>
  );
}

/** 首页（空白对话）的报错入口：默认只显示条数，点开就地向下展开。 */
export function HomeAttention(): React.ReactElement | null {
  const items = useAttentionItemsLive();
  const dispatch = useUiDispatch();
  const [open, setOpen] = React.useState(false);
  const collapse = React.useCallback(() => setOpen(false), []);

  React.useEffect(() => {
    // 报错被处理掉（或刷新后不再有）时收起，不留停在半开的状态。
    if (items.length === 0) setOpen(false);
  }, [items.length]);

  if (items.length === 0) return null;
  const label = `${items.length} 个报错`;
  const hint = open ? `${label}，收起清单` : `${label}，点开查看`;
  return (
    <section className="home-attention" aria-label="需要处理的报错">
      <button
        type="button"
        className="home-attention-trigger"
        aria-expanded={open}
        aria-label={hint}
        title={hint}
        onClick={() => setOpen((value) => !value)}
      >
        <WandIcon name="info" size={13} className="home-attention-trigger-icon"/>
        <span>{label}</span>
        <WandIcon name="chevronDown" size={13} className="home-attention-trigger-chevron"/>
      </button>
      <div
        className={classNames("home-attention-panel", open && "is-open")}
        inert={!open}
      >
        <AttentionList items={items} onOpen={(item) => openAttention(item, dispatch, collapse)}/>
      </div>
    </section>
  );
}
