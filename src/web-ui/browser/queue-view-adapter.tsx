import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { Button, Card, Flex, List, Tag, Typography } from "../react/design-library";
import { WandUiProvider } from "../react/theme";
import { WandIcon } from "../react/ui";

const roots = new Map<HTMLElement, Root>();

function paint(host: HTMLElement, view: React.ReactNode): void {
  for (const [node, root] of roots) if (!node.isConnected) {
    root.unmount(); roots.delete(node);
  }
  let root = roots.get(host);
  if (!root) { root = createRoot(host); roots.set(host, root); }
  // The drag owner can reorder native list nodes between projections. Rebuild
  // after that gesture, just as the original HTML renderer did.
  flushSync(() => root.render(null));
  flushSync(() => root.render(<WandUiProvider>{view}</WandUiProvider>));
}

export function clearQueueView(host: HTMLElement): void {
  const root = roots.get(host);
  if (root) { root.unmount(); roots.delete(host); }
  host.replaceChildren();
}

/** A projection of the existing queue; native event delegates own all actions. */
export function paintQueueBar(host: HTMLElement, items: readonly string[], inFlight: boolean, atCapacity: boolean): void {
  const promoteTitle = inFlight ? "中断当前回复，立即发送这条" : "立即发送这条";
  paint(host, <Card size="small" className={`queue-bar${atCapacity ? " queue-bar-capacity" : ""}${inFlight ? " queue-bar-inflight" : ""}`}
    data-queue-bar="1" title={<Flex align="center" gap="small"><span>{items.length} 条排队</span>{atCapacity && <Tag color="warning">已满</Tag>}</Flex>}
    extra={items.length >= 2 && <Button size="small" type="text" data-action="clear-all" className="queue-bar-clear-all"
      aria-label={`清空全部 ${items.length} 条排队消息`} title="清空全部排队">清空</Button>}>
    <Flex vertical component="ol" gap="small" className="queue-bar-list" data-queue-list="1" style={{ margin: 0, padding: 0, listStyle: "none" }}>
      {items.map((text, index) => <Flex component="li" key={index} align="center" gap="small" className="queue-bar-item"
        data-index={index} data-action="drag" title={`${text}（按住可拖动调序）`}>
        <Tag className="queue-bar-item-index">{index + 1}</Tag>
        <Typography.Text className="queue-bar-item-text" ellipsis style={{ flex: 1, minWidth: 0 }}>{text.replace(/\s+/g, " ").trim()}</Typography.Text>
        <Button size="small" type="text" data-action="edit" title="编辑" aria-label={`编辑第 ${index + 1} 条`}>✎</Button>
        <Button size="small" type="text" className="queue-bar-item-promote" data-action="promote-item" title={promoteTitle}
          aria-label={`立即发送第 ${index + 1} 条`} icon={<WandIcon name="zap" size={13}/>}/>
        <Button size="small" type="text" danger className="queue-bar-item-delete" data-action="delete" title="删除"
          aria-label={`删除第 ${index + 1} 条排队消息`} icon={<WandIcon name="close" size={13}/>}/>
      </Flex>)}
    </Flex>
  </Card>);
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
