import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { Alert, Button, Card, Flex, List, Tooltip, Typography } from "../react/design-library";
import type { ComposerDraft } from "./composer.js";
import { WandUiProvider } from "../react/theme";
import { WandIcon, WandPopover } from "../react/ui";
import { ComposerWorkPanel, ComposerWorkSummary, ComposerWorkText } from "../react/composer-work-panel.js";
import { DownOutlined, EditOutlined, HolderOutlined, SendOutlined } from "@ant-design/icons";
import { WandDropdownMenu, WandDropdownMenuTrigger, WandDropdownMenuContent, WandDropdownMenuItem, WandDropdownMenuSeparator } from "../react/ui/dropdown-menu.js";

const roots = new Map<HTMLElement, Root>();
function paint(host: HTMLElement, view: React.ReactNode): void {
  for (const [node, root] of roots) if (!node.isConnected) { root.unmount(); roots.delete(node); }
  let root = roots.get(host);
  if (!root) { root = createRoot(host); roots.set(host, root); }
  flushSync(() => root.render(<WandUiProvider>{view}</WandUiProvider>));
}
export function clearQueueView(host: HTMLElement): void {
  const root = roots.get(host);
  if (root) { root.unmount(); roots.delete(host); }
  host.replaceChildren();
}
export type QueueViewAction = "edit" | "promote-item" | "delete" | "clear-all" | "move-up" | "move-down" | "restore-retrieved" | "dismiss-retrieved" | "restore-removed" | "dismiss-removed";
interface QueueOptions {
  expanded: boolean; onExpandedChange(expanded: boolean): void; busy: boolean;
  retrieval: ComposerDraft["queueRetrieval"]; removal: ComposerDraft["queueRemoval"]; steering: boolean;
  onAction(action: QueueViewAction, index: number, expected: readonly string[]): void;
  onDragStart(event: PointerEvent, row: HTMLElement): void;
}
function QueueIconAction({ label, onClick, ...props }: { label: string } & React.ComponentProps<typeof Button>) {
  const [tip, setTip] = React.useState(false);
  return <Tooltip title={label} trigger={["hover", "focus"]} open={tip} onOpenChange={setTip} styles={{ root: { pointerEvents: "none" } }}>
    <Button {...props} type="text" size="small" className={`queue-icon-action ${props.className ?? ""}`} aria-label={label} onClick={event => { setTip(false); onClick?.(event); }}/>
  </Tooltip>;
}
/** Presentation only. Mutations retain the controller's clicked queue snapshot. */
function QueueMessageRow({ text, index, count, options, onPromote, action }: {
  text: string; index: number; count: number; options: QueueOptions; onPromote(): void; action(name: QueueViewAction, index: number): void;
}) {
  const [full, setFull] = React.useState(false);
  const [overflow, setOverflow] = React.useState(false);
  const [height, setHeight] = React.useState(0);
  const paragraph = React.useRef<HTMLParagraphElement>(null);
  const textId = React.useId();
  React.useLayoutEffect(() => {
    const node = paragraph.current;
    if (!node) return;
    const measure = () => {
      const limit = parseFloat(getComputedStyle(node).lineHeight) * 2;
      setOverflow(node.scrollHeight > limit + 1);
      setHeight(full ? node.scrollHeight : Math.min(node.scrollHeight, limit));
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [text, full]);
  return <li className="queue-bar-item" data-index={index} aria-label={`第 ${index + 1} 条待发送消息`}>
    <Button type="text" size="small" className="queue-drag-handle" data-action="drag" aria-label={`拖动第 ${index + 1} 条待发送消息排序`}
      title="拖动排序；键盘请使用更多中的上移、下移" disabled={options.busy || count < 2} icon={<HolderOutlined/>}
      onPointerDown={event => { if (event.button === 0 && event.isPrimary !== false) { event.stopPropagation(); options.onDragStart(event.nativeEvent, event.currentTarget.closest("li")!); } }}/>
    <span className="queue-bar-item-index" aria-hidden="true">{index + 1}</span>
    <div id={textId} className="queue-bar-item-text" data-full={full} style={{ height: height || undefined }}><p ref={paragraph}>{text}</p></div>
    <div className="queue-item-actions" role="group" aria-label={`第 ${index + 1} 条操作`}>
      <QueueIconAction label={`取回第 ${index + 1} 条到输入框`} disabled={options.busy || !!options.retrieval} data-action="edit" icon={<EditOutlined/>} onClick={() => action("edit", index)}/>
      <QueueIconAction label={`立即发送第 ${index + 1} 条`} disabled={options.busy} data-action="request-promote" className="queue-bar-item-promote" icon={<SendOutlined/>} onClick={onPromote}/>
      <span className="queue-expand-slot">{overflow && <QueueIconAction label={`${full ? "收起" : "展开"}第 ${index + 1} 条全文`} aria-expanded={full} aria-controls={textId}
        icon={<DownOutlined className="queue-text-chevron" data-open={full}/>} onClick={() => setFull(value => !value)}/>}</span>
      <WandDropdownMenu>
        <WandDropdownMenuTrigger render={<Button type="text" size="small" className="queue-icon-action" data-action="more" aria-label={`第 ${index + 1} 条的更多操作`} icon={<WandIcon name="more" size={16}/>}/>}/>
        <WandDropdownMenuContent align="end" popupOwner="composer-queue" className="queue-extra-actions">
          <WandDropdownMenuItem disabled={options.busy || index === 0} onSelect={() => action("move-up", index)}>上移</WandDropdownMenuItem>
          <WandDropdownMenuItem disabled={options.busy || index === count - 1} onSelect={() => action("move-down", index)}>下移</WandDropdownMenuItem>
          <WandDropdownMenuSeparator/>
          <WandDropdownMenuItem disabled={options.busy || !!options.removal} tone="danger" data-action="delete" className="queue-bar-item-delete" onSelect={() => action("delete", index)}>移除</WandDropdownMenuItem>
        </WandDropdownMenuContent>
      </WandDropdownMenu>
    </div>
  </li>;
}
function QueueBar({ items, inFlight, atCapacity, options }: { items: readonly string[]; inFlight: boolean; atCapacity: boolean; options: QueueOptions }) {
  const [confirm, setConfirm] = React.useState<{ action: "promote-item" | "clear-all"; index: number; expected: readonly string[] } | null>(null);
  const signature = JSON.stringify(items);
  React.useEffect(() => { setConfirm(null); }, [signature, options.expanded]);
  React.useEffect(() => {
    const other = (event: Event) => { if ((event as CustomEvent).detail !== "queue") options.onExpandedChange(false); };
    document.addEventListener("wand-composer-work-popup", other);
    return () => document.removeEventListener("wand-composer-work-popup", other);
  }, [options.onExpandedChange]);
  const change = (next: boolean) => {
    if (next) document.dispatchEvent(new CustomEvent("wand-composer-work-popup", { detail: "queue" }));
    options.onExpandedChange(next);
  };
  const action = (name: QueueViewAction, index = -1) => options.onAction(name, index, items.slice());
  const retrieval = options.retrieval, removal = options.removal;
  return <div className={`queue-bar${atCapacity ? " queue-bar-capacity" : ""}`} data-queue-bar="1">
    <WandPopover side="top" align="center" open={options.expanded} onOpenChange={change} className="composer-work-popover"
      contentId="queue-work-panel" popupOwner="composer-queue" contentRole="dialog" ariaLabel="待发送消息"
      trigger={ComposerWorkSummary({ label: "待发送", count: String(items.length), preview: items[0] || (removal ? "已移除原文保留" : "取回结果待核对"), icon: "history", expanded: options.expanded, className: "queue-bar-toggle" })}>
      <ComposerWorkPanel title="待发送消息" className="composer-queue-panel" description={`${items.length} 条${atCapacity ? "（已满）" : ""} · ${options.steering ? "下一安全边界追加" : "当前轮结束后按顺序发送"}`}
        onClose={() => change(false)} actions={items.length > 0 && <Button size="small" type="text" disabled={options.busy || !!removal} data-action="request-clear" onClick={() => setConfirm({ action: "clear-all", index: -1, expected: items.slice() })}>清空</Button>}
        footer="取回会保留已有草稿；移除后仅可恢复到草稿，不会自动重发。">
        {confirm && <div className="composer-work-confirm" role="group" aria-label="确认队列操作"><p>{confirm.action === "clear-all" ? `移除全部 ${confirm.expected.length} 条待发送消息？` : inFlight ? "立即发送会中断当前回复，确定继续？" : "立即发送这条消息？"}</p>
          <Flex gap={8} justify="end"><Button size="small" onClick={() => setConfirm(null)}>取消</Button><Button size="small" type="primary" disabled={options.busy} danger={confirm.action === "clear-all"} data-action="confirm-queue" onClick={() => { options.onAction(confirm.action, confirm.index, confirm.expected); setConfirm(null); }}>{confirm.action === "clear-all" ? "确认清空" : "确认发送"}</Button></Flex></div>}
        {retrieval && <Alert className="queue-retrieval" type={retrieval.status === "unknown" ? "warning" : "info"}
          title={retrieval.status === "pending" ? "正在取回到输入框…" : retrieval.status === "confirmed" ? "已取回，输入法确认后可继续编辑" : retrieval.status === "rejected" ? "未取回，请核对最新队列" : "取回结果未知；原文已保留，未自动重试"}
          description={retrieval.status !== "pending" && <><ComposerWorkText text={retrieval.text}/>{retrieval.status === "confirmed" && <Button size="small" data-action="restore-retrieved" onClick={() => action("restore-retrieved")}>加入当前输入继续编辑</Button>}<Button size="small" type="text" data-action="dismiss-retrieved" onClick={() => action("dismiss-retrieved")}>关闭保留</Button></>}/>}
        {removal && <Alert className="queue-removal" type={removal.status === "unknown" ? "warning" : "info"}
          title={removal.status === "pending" ? "正在移除…" : removal.status === "confirmed" ? "已移除，原文暂存于本会话" : removal.status === "rejected" ? "未移除，请核对队列" : "移除结果未知，请核对队列；未自动重试"}
          description={removal.status !== "pending" && <><ComposerWorkText text={removal.text}/><Flex gap={8}>{removal.status === "confirmed" && <Button size="small" data-action="restore-removed" onClick={() => action("restore-removed")}>恢复到草稿</Button>}<Button size="small" type="text" data-action="dismiss-removed" onClick={() => action("dismiss-removed")}>关闭保留</Button></Flex></>}/>}
        <ol className="queue-bar-list" data-queue-list="1">
          {items.map((text, index) => <QueueMessageRow key={`${index}:${text}`} text={text} index={index} count={items.length} options={options} action={action}
            onPromote={() => setConfirm({ action: "promote-item", index, expected: items.slice() })}/>)}
        </ol>
        {!items.length && !retrieval && !removal && <p className="composer-work-empty">没有待发送消息</p>}
      </ComposerWorkPanel>
    </WandPopover>
  </div>;
}
export function paintQueueBar(host: HTMLElement, items: readonly string[], inFlight: boolean, atCapacity: boolean, options: QueueOptions): void {
  paint(host, <QueueBar items={items} inFlight={inFlight} atCapacity={atCapacity} options={options}/>);
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
