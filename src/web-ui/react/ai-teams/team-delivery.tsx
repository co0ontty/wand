import * as React from "react";
import { Alert, Card, Collapse, Flex, List, Tag, Typography } from "antd";
import { FileCard } from "@ant-design/x";
import type { AiTeamDeliverySummary } from "../../../ai-team-delivery-types";
import { filePreviewController } from "../file-preview/controller";
import { WandButton, WandIcon } from "../ui";

/** Bound unknown server text without deriving new delivery facts. */
export function deliveryText(text: string | null | undefined, limit = 160): string {
  const value = text?.trim() ?? "";
  return value.length > limit ? `${value.slice(0, limit).trimEnd()}…` : value;
}

export function deliveryResultText(delivery: AiTeamDeliverySummary): string {
  return [deliveryText(delivery.headline, 80),
    delivery.conclusion ? `负责人交付说明：${deliveryText(delivery.conclusion)}` : "",
    delivery.attention ? `待处理：${deliveryText(delivery.attention.message)}` : "",
  ].filter(Boolean).join(" · ");
}

export function deliverySummaryText(delivery: AiTeamDeliverySummary): string {
  return `${deliveryResultText(delivery)} · ${delivery.totalFiles} 个文件 · ${delivery.totalHandoffs} 项接力`;
}

/** Frozen file identities and existing assignments only; opening this list performs no IO. */
export function TeamDeliveryDetails({ delivery }: {
  delivery: AiTeamDeliverySummary;
}): React.ReactElement {
  const files = delivery.files.slice(0, 20);
  const handoffs = delivery.handoffs.slice(0, 6);
  return <Flex vertical gap={12} className="team-delivery-details" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
    {delivery.conclusion ? <Flex vertical gap={6}>
      <Typography.Text strong>负责人交付说明</Typography.Text>
      <Typography.Paragraph style={{ margin: 0 }}>{deliveryText(delivery.conclusion, 600)}</Typography.Paragraph>
    </Flex> : null}
    {delivery.attention ? <Alert
      className="team-delivery-attention"
      type="warning"
      showIcon
      title={`待处理：${deliveryText(delivery.attention.message, 600)}`}
    /> : null}
    <Flex vertical gap={6} role="group" aria-label="交付文件">
      <Typography.Text strong>交付文件 · {delivery.totalFiles}</Typography.Text>
      <Typography.Text type="secondary" className="team-delivery-note">
        历史交付记录，文件当前是否可用以打开结果为准。
      </Typography.Text>
      {files.length ? <Flex className="team-delivery-files" gap={8} wrap>
        {files.map((item) => <FileCard
          key={`${item.stepId}:${item.file.path}`}
          name={deliveryText(item.file.preview?.title || item.file.name, 100)}
          byte={item.file.size}
          icon="markdown"
          // 交付列表是历史记录：卡片只给文件身份，打开前不读文件流、不预载图片。
          type="file"
          description={[item.file.preview?.excerpt ? deliveryText(item.file.preview.excerpt, 240) : "",
            `${deliveryText(item.file.name)} · ${deliveryText(item.memberName, 80)} · #${item.seq}`]
            .filter(Boolean).join(" · ")}
          onClick={() => { void filePreviewController.open(item.file.path); }}
        />)}
      </Flex> : <Typography.Text type="secondary">无可确认文件。</Typography.Text>}
      {delivery.totalFiles > files.length
        ? <Typography.Text type="secondary">
          已显示 {files.length}/{delivery.totalFiles} 个文件，另 {delivery.totalFiles - files.length} 个未列出。
        </Typography.Text>
        : null}
    </Flex>
    <Flex vertical gap={6} role="group" aria-label="执行与接力">
      <Typography.Text strong>执行与接力 · {delivery.totalHandoffs}</Typography.Text>
      {handoffs.length ? <List
        size="small"
        dataSource={handoffs}
        renderItem={(item) => <List.Item key={item.stepId} className="team-delivery-handoff">
          <Flex vertical gap={4}>
          <Typography.Text strong>{deliveryText(item.memberName, 80)} · #{item.seq} {deliveryText(item.title)}</Typography.Text>
          <Tag>{item.status === "running"
            ? item.state === "needs_permission" ? "等待授权" : item.state === "needs_input" ? "等待回答" : "进行中"
            : "排队"}</Tag>
          {item.waitingFor.length
            ? <Typography.Text type="secondary">
              等待：{item.waitingFor.slice(0, 6).map((name) => deliveryText(name, 80)).join("、")}
            </Typography.Text>
            : null}
          </Flex>
        </List.Item>}
      /> : <Typography.Text type="secondary">暂无接力事项。</Typography.Text>}
      {delivery.totalHandoffs > handoffs.length
        ? <Typography.Text type="secondary">
          已显示 {handoffs.length}/{delivery.totalHandoffs} 项接力，另 {delivery.totalHandoffs - handoffs.length} 项未列出。
        </Typography.Text>
        : null}
    </Flex>
  </Flex>;
}

/** Task timeline/member context; the chat uses its existing announcement trigger instead. */
export function TeamDeliveryCard({ delivery }: {
  delivery: AiTeamDeliverySummary;
}): React.ReactElement {
  const [choice, setChoice] = React.useState({ runId: delivery.runId, open: false });
  const open = choice.runId === delivery.runId && choice.open;
  React.useEffect(() => { setChoice({ runId: delivery.runId, open: false }); }, [delivery.runId]);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const id = React.useId();
  const close = (): void => { setChoice({ runId: delivery.runId, open: false }); trigger.current?.focus(); };
  return <Card
    size="small"
    className="team-delivery-card"
    style={{ minWidth: 0 }}
    onKeyDown={(event) => {
      if (event.key === "Escape" && open) { event.stopPropagation(); close(); }
    }}
  >
    <WandButton kind="ghost" ref={trigger} type="button" className="team-delivery-trigger" style={{ width: "100%", minHeight: 44, height: "auto", textAlign: "start" }}
      aria-expanded={open} aria-controls={id}
      onClick={() => setChoice({ runId: delivery.runId, open: !open })}>
      <Typography.Text ellipsis style={{ flex: 1, minWidth: 0 }} className="team-delivery-headline" title={deliverySummaryText(delivery)}>{deliveryResultText(delivery)}</Typography.Text>
      <Typography.Text type="secondary" className="team-delivery-meta" style={{ flexShrink: 0 }}>{delivery.totalFiles} 文件 · {delivery.totalHandoffs} 接力</Typography.Text>
      <WandIcon name={open ? "chevronUp" : "chevronDown"} size={14}/>
    </WandButton>
    <Collapse ghost bordered={false} activeKey={open ? ["delivery"] : []}
      styles={{ header: { display: "none" }, body: { padding: "12px 0 0" } }}
      items={[{ key: "delivery", label: "交付详情", showArrow: false, forceRender: true, children:
        <div id={id} className="team-delivery-body" data-open={open || undefined} inert={!open}>
          <TeamDeliveryDetails delivery={delivery}/>
        </div> }]}/>
  </Card>;
}
