import * as React from "react";
import type { AiTeamDeliverySummary } from "../../../ai-team-delivery-types";
import { filePreviewController } from "../file-preview/controller";
import { WandIcon } from "../ui";

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
  return <div className="team-delivery-details">
    {delivery.conclusion ? <section>
      <h4>负责人交付说明</h4><p>{deliveryText(delivery.conclusion, 600)}</p>
    </section> : null}
    {delivery.attention ? <p className="team-delivery-attention">
      待处理：{deliveryText(delivery.attention.message, 600)}
    </p> : null}
    <section aria-label="交付文件">
      <h4>交付文件 · {delivery.totalFiles}</h4>
      <p className="team-delivery-note">历史交付记录，文件当前是否可用以打开结果为准。</p>
      {files.length ? <ul>{files.map((item) => <li key={`${item.stepId}:${item.file.path}`}>
        <button type="button" className="team-delivery-file"
          onClick={() => { void filePreviewController.open(item.file.path); }}>
          <WandIcon name="file" size={16}/>
          <span><strong>{deliveryText(item.file.preview?.title || item.file.name, 100)}</strong>
            {item.file.preview?.excerpt ? <span>{deliveryText(item.file.preview.excerpt, 240)}</span> : null}
            <small>{deliveryText(item.file.name)} · {deliveryText(item.memberName, 80)} · #{item.seq}</small>
          </span>
        </button>
      </li>)}</ul> : <p>无可确认文件。</p>}
      {delivery.totalFiles > files.length ? <p>已显示 {files.length}/{delivery.totalFiles} 个文件，另 {delivery.totalFiles - files.length} 个未列出。</p> : null}
    </section>
    <section aria-label="执行与接力">
      <h4>执行与接力 · {delivery.totalHandoffs}</h4>
      {handoffs.length ? <ul>{handoffs.map((item) => <li key={item.stepId} className="team-delivery-handoff">
        <strong>{deliveryText(item.memberName, 80)} · #{item.seq} {deliveryText(item.title)}</strong>
        <span>{item.status === "running"
          ? item.state === "needs_permission" ? "等待授权" : item.state === "needs_input" ? "等待回答" : "进行中"
          : "排队"}</span>
        {item.waitingFor.length ? <small>等待：{item.waitingFor.slice(0, 6).map((name) => deliveryText(name, 80)).join("、")}</small> : null}
      </li>)}</ul> : <p>暂无接力事项。</p>}
      {delivery.totalHandoffs > handoffs.length ? <p>已显示 {handoffs.length}/{delivery.totalHandoffs} 项接力，另 {delivery.totalHandoffs - handoffs.length} 项未列出。</p> : null}
    </section>
  </div>;
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
  return <section className="team-delivery-card" onKeyDown={(event) => {
    if (event.key === "Escape" && open) { event.stopPropagation(); close(); }
  }}>
    <button ref={trigger} type="button" className="team-delivery-trigger"
      aria-expanded={open} aria-controls={id}
      onClick={() => setChoice({ runId: delivery.runId, open: !open })}>
      <span title={deliverySummaryText(delivery)}>{deliveryResultText(delivery)}</span>
      <small>{delivery.totalFiles} 文件 · {delivery.totalHandoffs} 接力</small>
      <WandIcon name="chevronDown" size={14}/>
    </button>
    <div id={id} className="team-delivery-body" data-open={open || undefined} inert={!open}>
      <div className="team-delivery-inner"><TeamDeliveryDetails delivery={delivery}/></div>
    </div>
  </section>;
}
