import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { Alert, Button, Card, Collapse, Flex, List, Tag, Typography } from "../react/design-library";
import type { ComposerDraft } from "./composer.js";
import { WandUiProvider } from "../react/theme";
import { WandIcon } from "../react/ui";

const roots = new Map<HTMLElement, Root>();

function paint(host: HTMLElement, view: React.ReactNode): void {
  for (const [node, root] of roots) if (!node.isConnected) {
    root.unmount(); roots.delete(node);
  }
  let root = roots.get(host);
  if (!root) { root = createRoot(host); roots.set(host, root); }
  // Dragging only transforms native rows; preserve the library's mounted
  // disclosure, animation and focus across snapshots.
  flushSync(() => root.render(<WandUiProvider>{view}</WandUiProvider>));
}

export function clearQueueView(host: HTMLElement): void {
  const root = roots.get(host);
  if (root) { root.unmount(); roots.delete(host); }
  host.replaceChildren();
}

function QueueDisclosure({ host, expanded, onExpandedChange, children }: { host: HTMLElement; expanded: boolean;
  onExpandedChange: (expanded: boolean) => void; children: React.ReactNode }): React.ReactElement {
  React.useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !host.contains(event.target)) onExpandedChange(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation(); event.preventDefault();
      onExpandedChange(false);
      host.querySelector<HTMLElement>(".ant-collapse-header")?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); };
  }, [host, expanded, onExpandedChange]);
  return <>{children}</>;
}

/** A projection of the durable queue; the shared composer owns recovered text. */
export function paintQueueBar(host: HTMLElement, items: readonly string[], inFlight: boolean, atCapacity: boolean,
  options: { expanded: boolean; onExpandedChange: (expanded: boolean) => void; busy: boolean;
    retrieval: ComposerDraft["queueRetrieval"]; steering: boolean }): void {
  const promoteTitle = inFlight ? "中断当前回复，立即发送这条" : "立即发送这条";
  const retrieval = options.retrieval;
  paint(host, <QueueDisclosure host={host} expanded={options.expanded} onExpandedChange={options.onExpandedChange}><div className={`queue-bar${atCapacity ? " queue-bar-capacity" : ""}${inFlight ? " queue-bar-inflight" : ""}`} data-queue-bar="1">
    {retrieval && <Alert className="queue-retrieval" type={retrieval.status === "unknown" ? "warning" : "info"}
      title={retrieval.status === "pending" ? "正在取回到输入框…" : retrieval.status === "confirmed"
        ? "已取回，保留当前输入后继续编辑" : retrieval.status === "rejected" ? "未取回，请核对最新队列" : "取回结果未知，请先核对队列和对话；未自动重试"}
      description={retrieval.status !== "pending" && <Flex vertical gap="small">
        <Typography.Paragraph copyable style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}>{retrieval.text}</Typography.Paragraph>
        <Flex gap="small">{retrieval.status === "confirmed" && <Button size="small" data-action="restore-retrieved">加入当前输入继续编辑</Button>}
          <Button size="small" type="text" data-action="dismiss-retrieved">关闭保留</Button></Flex>
      </Flex>}/>}
    {items.length > 0 && <Collapse ghost size="small" activeKey={options.expanded ? ["queue"] : []}
      onChange={keys => options.onExpandedChange(keys.includes("queue"))} items={[{ key: "queue",
        label: <span className="queue-summary" title={`${items.length} 条待发消息${atCapacity ? "（已满）" : ""} · ${options.steering ? "下一安全边界追加" : "当前轮结束后发送"}\n${items.join("\n")}`}>
          <span className="queue-summary-label">待发消息</span><span className="queue-summary-count">{items.length}</span>
          <span className="queue-summary-preview" aria-hidden="true">{items.map(text => text.replace(/\s+/g, " ").trim()).join(" · ")}</span>
        </span>,
        children: <Flex vertical gap="small">
          <Flex align="center" justify="space-between" gap="small">
            <Typography.Text type="secondary">{options.steering ? "下一安全边界追加" : "当前轮结束后发送"}</Typography.Text>
            {atCapacity && <Tag color="warning">已满</Tag>}
            {items.length >= 2 && <Button size="small" type="text" data-action="clear-all" className="queue-bar-clear-all"
              disabled={options.busy} aria-label={`清空全部 ${items.length} 条排队消息`} title="清空全部排队">清空</Button>}
          </Flex>
          <Flex vertical component="ol" gap="small" className="queue-bar-list" data-queue-list="1" style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {items.map((text, index) => <Flex component="li" key={index} align="start" gap="small" className="queue-bar-item"
            data-index={index} data-action="drag" title="按住正文可拖动调序">
            <Tag className="queue-bar-item-index">{index + 1}</Tag>
            <Typography.Text className="queue-bar-item-text" style={{ flex: 1, minWidth: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{text}</Typography.Text>
            <Button size="small" type="text" disabled={options.busy || !!retrieval} data-action="edit" title="取回到输入框" aria-label={`取回第 ${index + 1} 条到输入框`}>✎</Button>
            <Button size="small" type="text" disabled={options.busy} className="queue-bar-item-promote" data-action="promote-item" title={promoteTitle}
              aria-label={`立即发送第 ${index + 1} 条`} icon={<WandIcon name="zap" size={13}/>}/>
            <Button size="small" type="text" disabled={options.busy} danger className="queue-bar-item-delete" data-action="delete" title="删除"
              aria-label={`删除第 ${index + 1} 条排队消息`} icon={<WandIcon name="close" size={13}/>}/>
          </Flex>)}
          </Flex>
        </Flex>,
      }]}/>}
  </div></QueueDisclosure>);
}

export function paintCrossSessionQueue(host: HTMLElement, items: readonly { id: string; text: string; age: string }[]): void {
  paint(host, <Card size="small" title={`排队 ${items.length} 条`} extra={items.length > 1 && <Button size="small" type="text"
    id="queue-clear-all" className="queue-header-clear" title="清空排队">清空</Button>}>
    <List dataSource={[...items]} renderItem={item => <List.Item className="queue-item" data-queue-id={item.id}>
      <Flex align="center" gap="small" style={{ width: "100%", minWidth: 0 }}>
        <Typography.Text className="queue-item-text" ellipsis title={item.text} style={{ flex: 1, minWidth: 0 }}>{item.text}</Typography.Text>
        <Typography.Text type="secondary" className="queue-item-age">{item.age}</Typography.Text>
        <Button size="small" className="queue-item-send-now" data-queue-id={item.id} title="立即发送">发送</Button>
        <Button size="small" type="text" danger className="queue-item-cancel" data-queue-id={item.id} title="取消"
          aria-label="取消这条排队消息" icon={<WandIcon name="close" size={13}/>}/>
      </Flex>
    </List.Item>}/>
  </Card>);
}
