import * as React from "react";
import type { AttentionItem } from "../../../attention";
import { taskBoardController } from "../issues/task-board-controller";
import { WandIcon } from "../ui";
import { useUiDispatch, useUiStoreSnapshot } from "../shell/ui-store-react";
import { refreshAttention, useAttentionItems } from "./attention-store";

function sessionSignature(groups: ReadonlyArray<{ entries: ReadonlyArray<{ id: string; status: string }> }>): string {
  return groups.map((group) => group.entries.map((entry) => `${entry.id}:${entry.status}`).join(",")).join("|");
}

function openAttention(item: AttentionItem, dispatch: ReturnType<typeof useUiDispatch>): void {
  if (item.sessionId) {
    taskBoardController.close();
    void dispatch({ type: "session.select", id: item.sessionId });
    return;
  }
  taskBoardController.open("", "", "teams");
}

export function HomeAttention({ variant }: { variant: "home" | "sidebar" }): React.ReactElement | null {
  const items = useAttentionItems();
  const dispatch = useUiDispatch();
  const snapshot = useUiStoreSnapshot();
  const narrow = variant === "sidebar"
    && !snapshot.layout.sidebarDrawer
    && snapshot.layout.sidebarPinned
    && snapshot.layout.sidebarCollapsed;
  const signature = sessionSignature(snapshot.sidebar.groups);
  const [open, setOpen] = React.useState(true);

  React.useEffect(() => {
    refreshAttention();
  }, [signature]);

  if (items.length === 0) return null;

  const openItem = (item: AttentionItem): void => {
    openAttention(item, dispatch);
  };

  if (variant === "home") {
    return (
      <section className="home-attention" aria-label="需要处理的报错">
        <h2 className="home-attention-title">{items.length} 个报错</h2>
        <AttentionList items={items} onOpen={openItem}/>
      </section>
    );
  }

  return (
    <section className="home-attention is-sidebar" aria-label="需要处理的报错">
      <button
        type="button"
        className="home-attention-trigger"
        aria-expanded={open}
        title={`${items.length} 个报错，点开处理`}
        onClick={() => {
          if (narrow) {
            void dispatch({ type: "layout.drawer.collapse" });
            setOpen(true);
            return;
          }
          setOpen((value) => !value);
        }}
      >
        <WandIcon name="info" size={16}/>
        <span>{items.length} 个报错</span>
      </button>
      <div className={open ? "home-attention-panel is-open" : "home-attention-panel"}>
        <AttentionList items={items} onOpen={openItem}/>
      </div>
    </section>
  );
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
