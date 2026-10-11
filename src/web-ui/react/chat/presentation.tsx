import * as React from "react";
import { ChatMessage } from "./message";
import { ChatActivity, ChatActivityEntry, ChatDisclosureBody as DisclosureBody, ChatDisclosureChevron as DisclosureChevron } from "./activity";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { Alert, Badge, Button, Card, Collapse, Flex, Tag, Timeline, Typography, theme } from "antd";
import { FileCard, Think, ThoughtChain } from "@ant-design/x";
import { EmployeeAvatar } from "../agents/employee-avatar";
import { WandIcon } from "../ui";
import { WandUiProvider } from "../theme";
import { installChatSurfaceStyles } from "./styles";
export { installChatSurfaceStyles } from "./styles";
import { registerChatPresentation } from "./presentation-runtime";
import { readMotionTokenMs } from "../ui/motion-tokens";
import { InlineHtmlPreview } from "../local-preview/inline";

type Kind = "html" | "bubble" | "call" | "activity" | "tool" | "thinking" | "file" | "agent" | "agent-detail" | "agent-rail" | "agent-process" | "agent-timeline" | "agent-result" | "agent-receipt" | "question" | "section" | "terminal" | "diff" | "inline" | "preview" | "typography" | "notice" | "answer" | "unknown";
interface Projection { root: Root; slots: Map<string, HTMLElement>; kind: Kind; expanded?: boolean; }
const projections = new Map<HTMLElement, Projection>();
const replies = new Map<HTMLElement, Root>();
const slotNames: Partial<Record<Kind, string[]>> = {
  bubble: ["chat-message-text", "chat-message-content", "chat-message-time"],
  activity: ["chat-process-summary", "chat-activity-menu"],
  tool: ["chat-tool-header", "tool-preview", "chat-tool-body", "tool-use-downgrade-chip", "decision-tool-details"],
  call: ["chat-call-button", "chat-call-detail"],
  agent: ["agent-run-summary", "agent-run-body"],
  "agent-detail": ["agent-run-detail-head", "agent-run-agent-body"],
  "agent-process": ["agent-run-process-summary", "agent-run-timeline"],
  "agent-result": ["agent-run-result-label", "agent-run-result-content"],
  "agent-receipt": ["agent-run-result-label", "agent-run-receipt-rows", "agent-run-receipt-body"],
  question: ["ask-user-title", "ask-user-options"],
  terminal: ["term-header", "tool-preview", "term-body"],
  diff: ["diff-header", "diff-file-action", "tool-preview", "diff-body"],
  inline: ["inline-tool-row", "tool-preview", "inline-tool-image", "inline-tool-expanded"],
  preview: ["tool-preview-input", "tool-preview-output"],
  unknown: ["unknown-block-header", "unknown-block-body"],
};

/** Only the business-owned body crosses the DOM seam; library chrome is owned by React. */
function OwnedNode({ node }: { node?: HTMLElement }): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => { if (node && ref.current && node.parentElement !== ref.current) ref.current.replaceChildren(node); }, [node]);
  return <div ref={ref}/>;
}

/** 固定形状的业务节点（工具图标）：每次重渲染 imperative 层都会给新实例，形状没变就保留
 *  已挂载的那一个 —— 迟到结果只更新正文，不重造头部图标。 */
function StableOwnedNode({ node }: { node?: HTMLElement }): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const host = ref.current;
    if (!node || !host) return;
    const mounted = host.firstElementChild;
    if (!mounted || !mounted.isEqualNode(node)) host.replaceChildren(node);
  }, [node]);
  return <div ref={ref}/>;
}
function textOf(node: Element | null | undefined, selector?: string): string {
  return (selector ? node?.querySelector(selector)?.textContent : node?.textContent)?.trim() || "";
}
function statusColor(status?: string): "error" | "processing" | "warning" | "success" | "default" {
  return status === "failed" || status === "error" ? "error" : status === "running" || status === "background" ? "processing" : status === "interrupted" ? "warning" : status === "complete" || status === "completed" || status === "success" || status === "done" ? "success" : "default";
}
const disclosureAnchors = new WeakMap<HTMLElement, () => void>();
const disclosurePadding = new WeakMap<HTMLElement, string>();
/** Keep the trigger stationary through the library disclosure's height transition.
 * Explicit scrolling cancels the anchor immediately; it never follows new output. */
function preserveDisclosurePosition(control: HTMLElement, change: () => void): void {
  const scroller = control.closest<HTMLElement>(".chat-messages");
  const before = control.getBoundingClientRect();
  const bounds = scroller?.getBoundingClientRect();
  const visible = !!bounds && before.bottom > bounds.top && before.top < bounds.bottom;
  disclosureAnchors.get(scroller!)?.();
  const closing = control.getAttribute("aria-expanded") === "true";
  const owner = control.closest(".chat-message");
  let expectedScroll = scroller?.scrollTop;
  let expectedHeight = owner?.getBoundingClientRect().height;
  const restore = () => {
    if (scroller && visible && control.isConnected) {
      scroller.scrollTop += control.getBoundingClientRect().top - before.top;
      const remaining = control.getBoundingClientRect().top - before.top;
      // A bottom-aligned short conversation has no scroll range yet. Reserve
      // reading space ABOVE it so disclosure can grow below its trigger rather
      // than lifting that trigger. The reserve is capped by viewport + detail.
      if (remaining < -1) {
        if (!disclosurePadding.has(scroller)) disclosurePadding.set(scroller, scroller.style.paddingTop);
        const css = getComputedStyle(scroller);
        const rows = Array.from(scroller.children).filter(node => node.getBoundingClientRect().height > 0);
        const used = rows.reduce((sum, node) => sum + node.getBoundingClientRect().height, 0)
          + Math.max(0, rows.length - 1) * (parseFloat(css.rowGap) || 0) + parseFloat(css.paddingTop) + parseFloat(css.paddingBottom);
        scroller.style.paddingTop = (parseFloat(css.paddingTop) + Math.max(0, scroller.clientHeight - used) - remaining) + "px";
        scroller.scrollTop += control.getBoundingClientRect().top - before.top;
      }
      expectedScroll = scroller.scrollTop;
      expectedHeight = owner?.getBoundingClientRect().height;
    }
  };
  change(); restore();
  if (!scroller || !visible || !owner) return;
  const observer = new ResizeObserver(restore);
  observer.observe(owner);
  let frame = requestAnimationFrame(function anchorFrame() { restore(); frame = requestAnimationFrame(anchorFrame); });
  const cancel = () => {
    observer.disconnect(); cancelAnimationFrame(frame); clearTimeout(timer);
    for (const event of ["wheel", "touchstart", "pointerdown", "keydown", "focusin"]) scroller.removeEventListener(event, cancel);
    scroller.removeEventListener("scroll", onScroll);
    disclosureAnchors.delete(scroller);
  };
  const onScroll = () => {
    if (Math.abs(scroller.scrollTop - (expectedScroll || 0)) > 1 && Math.abs(owner.getBoundingClientRect().height - (expectedHeight || 0)) < 1) cancel();
  };
  scroller.addEventListener("scroll", onScroll, { passive: true });
  const timer = setTimeout(() => {
    if (closing && disclosurePadding.has(scroller) && !scroller.querySelector('.chat-activity[data-expanded="true"], .chat-tool-card:not(.collapsed), .inline-terminal[data-expanded="true"], .inline-tool-open')) {
      scroller.style.paddingTop = disclosurePadding.get(scroller)!;
      disclosurePadding.delete(scroller);
      restore();
    }
    cancel();
  }, readMotionTokenMs("--motion-normal") + readMotionTokenMs("--motion-fast"));
  for (const event of ["wheel", "touchstart", "pointerdown", "keydown", "focusin"]) scroller.addEventListener(event, cancel, { passive: true });
  disclosureAnchors.set(scroller, cancel);
}
function businessBody(node?: HTMLElement): React.ReactNode {
  return <Typography><OwnedNode node={node}/></Typography>;
}
function captureSlots(element: Element, kind: Kind): Map<string, HTMLElement> {
  const slots = new Map<string, HTMLElement>();
  const names = slotNames[kind];
  if (names) {
    for (const name of names) {
      const nodes = Array.from(element.children).flatMap(child => {
        if (child.classList.contains(name)) return [child as HTMLElement];
        // Copy handlers may have mounted ordinary Ant buttons before this richer projection.
        const control = child.firstElementChild;
        if (control?.matches("button." + name)) {
          const seed = control.cloneNode(true) as HTMLElement;
          child.remove();
          return [seed];
        }
        return [];
      });
      nodes.forEach((node, index) => slots.set(index ? name + ":" + index : name, node));
    }
  } else if (kind === "agent-rail" || kind === "agent-timeline") {
    Array.from(element.children).forEach((node, index) => {
      if (!(node instanceof HTMLElement)) return;
      const mounted = kind === "agent-rail" && node.firstElementChild?.matches("button.agent-run-agent") ? node.firstElementChild : null;
      const seed = mounted ? mounted.cloneNode(true) as HTMLElement : node;
      if (mounted) node.remove();
      slots.set(kind === "agent-rail" ? seed.dataset.agentTaskId || String(index) : String(index), seed);
    });
  } else if (kind === "section" || kind === "typography" || kind === "notice" || kind === "answer") {
    const body = document.createElement("div");
    while (element.firstChild) body.append(element.firstChild);
    slots.set("body", body);
  }
  return slots;
}

/** Ant owns message chrome; detached, non-interactive metadata stays a patchable source. */
function ChatBubble({ element, slots }: { element: HTMLElement; slots: Map<string, HTMLElement> }): React.ReactElement {
  const user = element.dataset.role === "user";
  const timing = slots.get("chat-message-time");
  const clock = timing?.querySelector("time");
  const duration = textOf(timing, ".chat-message-duration");
  // Android ChatMessageTime：时间行在正文之上，自己的发言靠右；等宽字体、次要色。
  const timeRow = timing ? <span className="chat-message-time">
    {duration ? <span className="chat-message-duration">{duration}</span> : null}
    <time dateTime={clock?.getAttribute("datetime") || undefined} title={timing.title}
      aria-label={clock?.getAttribute("aria-label") || undefined}>{textOf(clock || timing)}</time>
  </span> : null;
  return <ChatMessage own={user}
    // 助手的回复头部（时间 + 署名 + 收起）由 presentAssistantReply 持有，这里不再重复一份时间行。
    header={user ? timeRow : undefined}
    // 助手回复不设阅读栏宽：横向用满可用宽度（对齐 Android 回复正文），只有自己的发言按气泡收口。
    styles={{ body: { minWidth: 0, width: user ? undefined : "100%", maxWidth: user ? "calc(100% - 44px)" : "100%", marginInlineStart: user ? "auto" : undefined },
      content: { overflowWrap: "anywhere", ...(user ? {} : { padding: 0 }) } }}
    content={businessBody(slots.get("chat-message-content") || slots.get("chat-message-text"))}/>;
}

function renderProjection(element: HTMLElement, projection: Projection): void {
  const slots = projection.slots;
  let content: React.ReactNode;
  if (projection.kind === "html") {
    content = <InlineHtmlPreview previewUrl={element.dataset.htmlPreviewUrl!} downloadUrl={element.dataset.htmlDownloadUrl!} label={element.dataset.htmlLabel}/>;
  } else if (projection.kind === "bubble") {
    content = <ChatBubble element={element} slots={slots}/>;
  } else if (projection.kind === "file") {
    const open = () => (window as any).__openFilePreview?.(element.dataset.path);
    content = <FileCard name={element.dataset.fileName || "附件"} size="small" role="button" tabIndex={0}
      aria-label={`查看附件 ${element.dataset.fileName || ""}`} onClick={open}
      onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } }}/>
  } else if (projection.kind === "thinking") {
    const expanded = element.classList.contains("expanded");
    content = <Think loading={element.dataset.loading === "true"} expanded={expanded}
      title={<Button type="text" aria-expanded={expanded}>深度思考</Button>}
      onExpand={() => { (window as any).__thinkingToggle(element); renderProjection(element, projection); }}>
      {element.dataset.thinking}
    </Think>;
  } else if (projection.kind === "tool" || projection.kind === "terminal" || projection.kind === "diff") {
    const kind = projection.kind;
    const headerClass = kind === "tool" ? "chat-tool-header" : kind === "terminal" ? "term-header" : "diff-header";
    const header = slots.get(headerClass);
    const title = textOf(header, kind === "tool" ? ".tool-use-name" : kind === "terminal" ? ".term-cmd-preview" : ".diff-file-name");
    const subtitle = kind === "tool" ? [textOf(header, ".tool-use-summary"), textOf(header, ".tool-use-file"), textOf(header, ".decision-tool-summary")].filter(Boolean).join(" · ") : kind === "diff" ? element.dataset.path : "";
    const status = kind === "tool" ? element.classList.contains("error") ? "error" : element.classList.contains("success") ? "success" : "running" : kind === "terminal" ? header?.querySelector(".term-error") ? "error" : header?.querySelector(".term-success") ? "success" : "running" : header?.querySelector(".diff-error") ? "error" : header?.querySelector(".diff-success") ? "success" : "running";
    const expanded = kind === "terminal" ? element.dataset.expanded === "true" : !element.classList.contains("collapsed");
    const toggle = (event: React.MouseEvent<HTMLButtonElement>) => {
      preserveDisclosurePosition(event.currentTarget, () => {
        if (kind === "terminal") (window as any).__terminalExpand(event.currentTarget);
        else if (element.classList.contains("decision-tool-card")) (window as any).__decisionToggle(event, event.currentTarget);
        else (window as any).__tcToggle(event, event.currentTarget);
        renderProjection(element, projection);
      });
    };
    const decision = element.classList.contains("decision-tool-card");
    // 工具图标由 imperative 层提供（tool-identity），这里只把它放进状态图标槽，不另建一套图标表。
    const iconNode = header?.querySelector<HTMLElement>(".tool-use-icon") || undefined;
    const stateLabel = element.classList.contains("ask-user") ? element.classList.contains("ask-user-answered") ? "已回答" : "待回答" : status === "error" ? "失败" : status === "success" ? "完成" : "运行中";
    // Android ToolCard：左侧状态图标槽（状态色 11% 底 + 运行态与工具图标交叉变形），
    // 中间标题/摘录两行，右侧箭头；状态不再写成文字，只留在语义与槽位颜色里。
    const trigger = <Button type="text" block className={`${headerClass} chat-tool-trigger${kind === "tool" && !decision ? " chat-tool-trigger-card" : ""}`} aria-expanded={expanded}
      aria-label={`${title || "调用工具"}，${stateLabel}`}
      data-tool-toggle={kind === "tool" && !decision ? "" : undefined}
      onClick={toggle}>
      {kind === "tool" && !decision
        ? <span className="chat-tool-icon-slot" data-status={status} aria-hidden="true">
          <span className="chat-tool-icon-progress"/>
          <span className="chat-tool-icon-glyph">{iconNode ? <StableOwnedNode node={iconNode}/> : <WandIcon name="wrench" size={16}/>}</span>
        </span>
        : <Badge status={statusColor(status)}/>}
      <span className="chat-tool-head">
        <span className="chat-tool-title" title={title}>{title || "工具调用"}</span>
        {subtitle && <span className={`chat-tool-summary${decision ? " decision-tool-summary" : ""}`} role={decision ? "status" : undefined} title={subtitle}>{subtitle}</span>}
      </span>
      <DisclosureChevron expanded={expanded}/>
    </Button>;
    const body = <DisclosureBody expanded={expanded}>
      {Array.from(slots).filter(([name]) => name !== headerClass && name !== "diff-file-action" && name !== "tool-preview")
        .map(([name, node]) => <React.Fragment key={name}>{businessBody(node)}</React.Fragment>)}
    </DisclosureBody>;
    const interactive = element.classList.contains("ask-user") || element.classList.contains("decision-tool-card");
    content = interactive ? <Card size="small" title={trigger} styles={{ body: { padding: 0 }, header: { paddingInline: 8 } }}>{body}</Card>
      : <Flex vertical className={`chat-tool-surface${kind === "tool" ? " chat-tool-card-surface" : ""}`}>
        <Flex align="center" style={{ minWidth: 0 }}>{trigger}{kind === "diff" && <OwnedNode node={slots.get("diff-file-action")}/>}</Flex>
        {status === "error" && !expanded && <Typography.Text type="danger" className="chat-tool-error-preview" ellipsis>
          {textOf(slots.get("tool-preview"), ".tool-preview-output") || "工具执行失败，展开查看详情"}
        </Typography.Text>}
        {body}
      </Flex>;
  } else if (projection.kind === "activity") {
    const summary = slots.get("chat-process-summary");
    const expanded = element.dataset.expanded === "true";
    // 缩略统计行是全段唯一的动态 loading，展开时也不让位；时间线行不再另起一份。
    // 运行标记是业务标记（九点流动标记）而不是库的 Spin：标记随 imperative 标记一起进出，
    // 运行态由 .chat-activity.is-*-running 表达，同一实例里展开，不做两套图标切换。
    content = <ChatActivity expanded={expanded} summary={<OwnedNode node={summary}/>}
      onToggle={event => preserveDisclosurePosition(event.currentTarget, () => { (window as any).__activityToggle(event.currentTarget); renderProjection(element, projection); })}>
      <OwnedNode node={slots.get("chat-activity-menu")}/>
    </ChatActivity>;
  } else if (projection.kind === "call") {
    const seed = slots.get("chat-call-button");
    const detail = slots.get("chat-call-detail");
    const open = element.dataset.expanded === "true";
    const status = element.dataset.status;
    const thinking = element.dataset.thinkingEntry === "true";
    const stateLabel = status === "error" ? "失败" : status === "running" ? thinking ? "思考中" : "运行中" : status === "complete" ? thinking ? "已结束" : "完成" : "未返回";
    const inputPreview = thinking ? "" : seed?.dataset.preview || "";
    const resultPreview = thinking || !seed?.dataset.result || seed.dataset.result === stateLabel ? "" : seed.dataset.result;
    // 输入/结果两行摘录对工具调用**常驻**（哪怕还没结果），每行还留一行高度：
    // 迟到的结果只补文字，不把行撑出来（对齐 Android ToolActivityEntryRow 的触发区几何）。
    const showsToolRows = !thinking && element.hasAttribute("data-tool-ids");
    content = <ChatActivityEntry expanded={open} status={status} label={seed?.dataset.label || "工具调用"} stateLabel={stateLabel}
      clock={seed?.dataset.time} occurredAt={seed?.dataset.occurredAt} preview={inputPreview} result={resultPreview} tool={showsToolRows}
      onToggle={event => preserveDisclosurePosition(event.currentTarget, () => { (window as any).__activityEntryToggle(event.currentTarget); renderProjection(element, projection); })}>
      {businessBody(detail)}
    </ChatActivityEntry>;
  } else if (projection.kind === "agent") {
    const seed = slots.get("agent-run-summary");
    const expanded = element.dataset.expanded === "true";
    content = <Card size="small" className="agent-run-surface" styles={{ body: expanded ? undefined : { display: "none" } }} title={<Button type="text" block className="agent-run-summary" aria-expanded={expanded}
      aria-label={element.getAttribute("aria-label") || undefined} aria-controls={slots.get("agent-run-body")?.id}
      onClick={event => preserveDisclosurePosition(event.currentTarget, () => (window as any).__agentRunToggle(event, event.currentTarget))}>
      <Badge status={statusColor(element.dataset.status)}/>
      <span className="agent-run-summary-copy">
        <span className="agent-run-summary-line"><Typography.Text strong className="agent-run-title">{textOf(seed, ".agent-run-title")}</Typography.Text>
          {textOf(seed, ".agent-run-status-label") && <Typography.Text type={element.dataset.status === "failed" ? "danger" : "secondary"} className="agent-run-status-label">{textOf(seed, ".agent-run-status-label")}</Typography.Text>}
        </span>
        {(textOf(seed, ".agent-run-topic") || textOf(seed, ".agent-run-type-chip")) && <span className="agent-run-context">
          {textOf(seed, ".agent-run-topic") && <span>{textOf(seed, ".agent-run-topic")}</span>}
          {textOf(seed, ".agent-run-type-chip") && <span>{textOf(seed, ".agent-run-type-chip")}</span>}
        </span>}
        {textOf(seed, ".agent-run-latest") && <Typography.Text type="secondary" className="agent-run-latest" title={textOf(seed, ".agent-run-latest")}>{textOf(seed, ".agent-run-latest")}</Typography.Text>}
      </span>
      <DisclosureChevron expanded={expanded}/>
    </Button>}><OwnedNode node={slots.get("agent-run-body")}/></Card>;
  } else if (projection.kind === "agent-rail") {
    const selected = element.closest(".agent-run")?.querySelector<HTMLElement>(".agent-run-detail-panel.is-selected")?.dataset.agentTaskId;
    content = <Flex vertical gap={4}>{Array.from(slots).map(([key, seed]) => {
      const active = selected === key;
      const label = textOf(seed, ".agent-run-agent-copy strong") || textOf(seed);
      const status = Array.from(seed.querySelector(".agent-run-agent-status")?.classList || []).find(name => name.startsWith("is-"))?.slice(3);
      return <Button key={key} size="small" type="text" block className={"agent-run-agent" + (active ? " is-selected" : "")}
        id={seed.id} role="tab" aria-controls={seed.getAttribute("aria-controls") || undefined} aria-selected={active} tabIndex={active ? 0 : -1}
        data-agent-task-id={key} data-agent-run-id={element.closest<HTMLElement>(".agent-run")?.dataset.agentRunId}
        onClick={event => (window as any).__agentRunSelect(event, event.currentTarget)}
        onKeyDown={event => (window as any).__agentRunSelect(event, event.currentTarget)}>
        <Badge status={statusColor(status)} color={status === "running" || status === "background" ? seed.style.getPropertyValue("--agent-color") || undefined : undefined}
          aria-label={seed.querySelector(".agent-run-agent-status")?.getAttribute("aria-label") || undefined}/>
        <span className="agent-run-agent-copy"><span className="agent-run-agent-name" title={label}>{label}</span>
          {textOf(seed, ".agent-run-agent-type") && <span className="agent-run-agent-type">{textOf(seed, ".agent-run-agent-type")}</span>}
        </span>
        {textOf(seed, ".agent-run-agent-status") && <Typography.Text type={status === "failed" ? "danger" : "secondary"} className="agent-run-agent-status">{textOf(seed, ".agent-run-agent-status")}</Typography.Text>}
      </Button>;
    })}</Flex>;
  } else if (projection.kind === "agent-detail") {
    const head = slots.get("agent-run-detail-head");
    const state = head?.querySelector(".agent-run-detail-state");
    content = <Flex vertical gap="small"><Flex className="agent-run-detail-heading" gap="small" align="center" wrap aria-label={state?.getAttribute("aria-label") || undefined}>
      <Typography.Text strong className="agent-run-detail-task">{textOf(head, ".agent-run-detail-task")}</Typography.Text>
      {head?.querySelector<HTMLElement>(".pi-execution-open") && <Button size="small" className="pi-execution-open" data-tool-id={head.querySelector<HTMLElement>(".pi-execution-open")?.dataset.toolId}
        onClick={event => (window as any).__piExecutionOpen(event, event.currentTarget)}>{textOf(head, ".pi-execution-open")}</Button>}
    </Flex><OwnedNode node={slots.get("agent-run-agent-body")}/></Flex>;
  } else if (projection.kind === "agent-process") {
    projection.expanded ??= element.dataset.expanded === "true";
    element.dataset.expanded = String(projection.expanded);
    content = <Collapse size="small" ghost activeKey={projection.expanded ? ["process"] : []} destroyOnHidden={false}
      classNames={{ header: "agent-run-process-summary" }} onChange={keys => {
        const control = element.querySelector<HTMLElement>(".agent-run-process-summary")!;
        preserveDisclosurePosition(control, () => { projection.expanded = keys.includes("process"); renderProjection(element, projection); });
      }} items={[{ key: "process", label: textOf(slots.get("agent-run-process-summary")), forceRender: true,
        children: <OwnedNode node={slots.get("agent-run-timeline")}/> }]}/>;
  } else if (projection.kind === "agent-timeline") {
    content = <Timeline items={Array.from(slots).map(([key, seed]) => ({ key,
      icon: seed.classList.contains("is-thinking") ? <WandIcon name="spark" size={13}/> : undefined,
      children: businessBody(seed),
    }))}/>;
  } else if (projection.kind === "agent-result" || projection.kind === "agent-receipt") {
    const receipt = projection.kind === "agent-receipt";
    content = <Flex vertical gap={6} className="agent-run-output"><Typography.Text className="agent-run-output-label" type={element.classList.contains("is-error") ? "danger" : "secondary"}>
      {textOf(slots.get("agent-run-result-label"))}</Typography.Text>
      {receipt ? <>{businessBody(slots.get("agent-run-receipt-rows"))}{businessBody(slots.get("agent-run-receipt-body"))}</> : businessBody(slots.get("agent-run-result-content"))}
    </Flex>;
  } else if (projection.kind === "question") {
    content = <Card size="small" title={textOf(slots.get("ask-user-title"))}><Flex vertical gap="small"><OwnedNode node={slots.get("ask-user-options")}/></Flex></Card>;
  } else if (projection.kind === "answer") {
    const body = slots.get("body");
    content = <Flex vertical gap="small"><Flex gap="small" align="center">
      {element.classList.contains("ask-user-option-chosen") && <Badge status="success"/>}
      <Typography.Text strong>{textOf(body, ".ask-user-option-label")}</Typography.Text></Flex>
      {textOf(body, ".ask-user-option-desc") && <Typography.Text type="secondary">{textOf(body, ".ask-user-option-desc")}</Typography.Text>}
    </Flex>;
  } else if (projection.kind === "unknown") {
    content = <Collapse size="small" items={[{ key: "raw", label: textOf(slots.get("unknown-block-header"), ".unknown-block-label"),
      children: businessBody(slots.get("unknown-block-body")) }]}/>;
  } else if (projection.kind === "inline") {
    const row = slots.get("inline-tool-row");
    const expanded = element.classList.contains("inline-tool-open");
    const title = textOf(row, ".inline-tool-title");
    content = <Flex vertical className="chat-tool-surface">
      <Button type="text" block className="inline-tool-row chat-tool-trigger" aria-expanded={expanded}
        onClick={event => preserveDisclosurePosition(event.currentTarget, () => { (window as any).__inlineToolToggle(element); renderProjection(element, projection); })}>
        <Badge status={statusColor(element.dataset.status)}/><span className="chat-tool-title" title={title}>{title || "查看内容"}</span>
        <Typography.Text type="secondary" className="chat-tool-subtitle" ellipsis>{textOf(row, ".inline-tool-meta")}</Typography.Text>
        <DisclosureChevron expanded={expanded}/>
      </Button>
      {Array.from(slots).filter(([name]) => name.startsWith("inline-tool-image")).map(([name, node]) => <OwnedNode key={name} node={node}/>)}
      <DisclosureBody expanded={expanded}>{businessBody(slots.get("inline-tool-expanded"))}</DisclosureBody>
    </Flex>;
  } else if (projection.kind === "preview") {
    content = <Flex vertical gap="small">{slots.get("tool-preview-input") && <Typography.Text type="secondary">{textOf(slots.get("tool-preview-input"))}</Typography.Text>}
      {slots.get("tool-preview-output") && <Typography.Text type={element.classList.contains("is-error") ? "danger" : "secondary"}>{textOf(slots.get("tool-preview-output"))}</Typography.Text>}</Flex>;
  } else if (projection.kind === "notice") {
    content = <Alert type={element.classList.contains("is-error") || element.classList.contains("tool-content-error") ? "error" : "info"} showIcon title={<OwnedNode node={slots.get("body")}/>}/>;
  } else if (projection.kind === "section") {
    content = businessBody(slots.get("body"));
  } else {
    content = businessBody(slots.get("body"));
  }
  flushSync(() => projection.root.render(<WandUiProvider>{content}</WandUiProvider>));
}


/** The message owner keeps the fold choice; Ant owns its single keyboard control. */
export function presentAssistantReply(element: HTMLElement, key: string, preview: string, expanded: boolean, toggle: (expanded: boolean) => void, meta?: { time?: string; dateTime?: string; duration?: string; author?: string; employee?: { id: string; name?: string; avatar?: string; provider?: string; engine?: "cli" | "sdk" | "core" } }): void {
  // 署名只是「谁在做这件事」的说明：会话自带员工快照就署员工，团队 relay 的 msg.author 次之，
  // 都取不到才回落品牌标记 + Wand（与 Android AssistantReplyHeader 同一套优先级）。
  const employee = meta?.employee?.id ? meta.employee : null;
  const authorName = employee?.name || meta?.author || "Wand";
  let host = Array.from(element.children).find(child => child.classList.contains("assistant-reply-host")) as HTMLElement | undefined;
  if (!host) {
    host = document.createElement("div"); host.className = "assistant-reply-host";
    element.prepend(host);
  }
  let root = replies.get(host);
  if (!root) { root = createRoot(host); replies.set(host, root); }
  // One reply metadata row keeps the body prominent; the source owner keeps its fold preference.
  flushSync(() => root!.render(<WandUiProvider><div className="assistant-reply-head">
    <Button type="text" block className="assistant-reply-disclosure"
      data-expand-key={key} aria-expanded={expanded} aria-label={`${authorName} 的回复，${expanded ? "收起" : "展开"}`}
      onClick={event => preserveDisclosurePosition(event.currentTarget, () => {
        toggle(!expanded); presentAssistantReply(element, key, preview, !expanded, toggle, meta);
      })}>
      <span className="assistant-author">
        <span className="assistant-author-avatar" aria-hidden="true">
          {employee
            ? <EmployeeAvatar employee={{ id: employee.id, name: employee.name || employee.id, avatar: employee.avatar }} provider={employee.provider} engine={employee.engine} size="lg"/>
            : <span className="assistant-author-spark"><WandIcon name="sparkle" size={14}/></span>}
        </span>
        <span className="assistant-author-name">{authorName}</span>
      </span>
      {!expanded && preview ? <span className="assistant-author-preview" title={preview}>{preview}</span> : <span className="assistant-author-space"/>}
      {meta?.time ? <span className="chat-message-time" title={meta.duration ? `耗时 ${meta.duration}` : undefined}>
        {meta.duration ? <span className="chat-message-duration">耗时 {meta.duration}</span> : null}
        <time dateTime={meta.dateTime || undefined}>{meta.time}</time>
      </span> : null}
      <span className="assistant-reply-action">{expanded ? "收起" : "展开"}</span>
      <DisclosureChevron expanded={expanded}/>
    </Button>
  </div></WandUiProvider>));
}

/** Keep closed timeline/detail bodies as business DOM until their owner opens.
 * A long turn can contain hundreds of hidden calls; mounting an Ant root for
 * every row on session load forces synchronous style/layout work for no visible UI.
 * No geometry reads: restored expansion and the existing disclosure delegates
 * decide when these nodes need presentation, without changing history or focus. */
function isDeferredChatContent(element: HTMLElement): boolean {
  return !!element.closest('.chat-activity[data-expanded="false"] .chat-activity-menu, .chat-call[data-expanded="false"] .chat-call-detail, .agent-run[data-expanded="false"] .agent-run-body, .agent-run-process[data-expanded="false"] .agent-run-timeline');
}

/** Read native business state after a disclosure/tab delegate, without owning it again. */
export function refreshChatPresentation(root: HTMLElement): void {
  presentChat(root);
  for (const [element, projection] of projections) {
    if ((root === element || root.contains(element)) && !isDeferredChatContent(element)) renderProjection(element, projection);
  }
}

/** Morph business nodes in place. Never reconcile React chrome or move a focused owned subtree. */
export function patchChatPresentation(current: Element, next: Element, morph: (current: Node, next: Node) => void): boolean {
  const projection = projections.get(current as HTMLElement);
  if (!projection) return false;
  if (projection.kind === "unknown") current.removeAttribute("onclick");
  if (projection.kind === "inline") for (const name of ["onclick", "onkeydown", "role", "tabindex", "aria-expanded"]) current.removeAttribute(name);
  if (projection.kind === "html") {
    for (const key of ["htmlPreviewUrl", "htmlDownloadUrl", "htmlLabel"]) (current as HTMLElement).dataset[key] = (next as HTMLElement).dataset[key];
    renderProjection(current as HTMLElement, projection);
    return true;
  }
  const fresh = captureSlots(next, projection.kind);
  for (const [name, node] of fresh) {
    const old = projection.slots.get(name);
    if (old) morph(old, node);
    else projection.slots.set(name, node);
  }
  for (const [name, old] of projection.slots) if (!fresh.has(name)) { old.remove(); projection.slots.delete(name); }
  renderProjection(current as HTMLElement, projection);
  if (projection.kind === "agent") {
    const rail = current.querySelector<HTMLElement>(".agent-run-rail");
    const child = rail && projections.get(rail);
    if (rail && child) renderProjection(rail, child);
  }
  return true;
}

function kindOf(element: HTMLElement): Kind {
  if (element.classList.contains("chat-html-preview")) return "html";
  if (element.classList.contains("chat-file-attachment")) return "file";
  if (element.classList.contains("chat-thinking")) return "thinking";
  if (element.classList.contains("chat-tool-card")) return "tool";
  if (element.classList.contains("chat-activity")) return "activity";
  if (element.classList.contains("chat-call")) return "call";
  if (element.classList.contains("agent-run")) return "agent";
  if (element.classList.contains("agent-run-rail")) return "agent-rail";
  if (element.classList.contains("agent-run-detail-panel")) return "agent-detail";
  if (element.classList.contains("agent-run-process")) return "agent-process";
  if (element.classList.contains("agent-run-timeline")) return "agent-timeline";
  if (element.classList.contains("agent-run-result")) return "agent-result";
  if (element.classList.contains("agent-run-receipt")) return "agent-receipt";
  if (element.classList.contains("ask-user-question-group")) return "question";
  if (element.classList.contains("ask-user-option-readonly")) return "answer";
  if (element.classList.contains("unknown-block")) return "unknown";
  if (element.classList.contains("inline-terminal")) return "terminal";
  if (element.classList.contains("inline-diff")) return "diff";
  if (element.classList.contains("inline-tool")) return "inline";
  if (element.classList.contains("tool-preview")) return "preview";
  if (element.classList.contains("chat-activity-detail-section")) return "section";
  if (element.classList.contains("chat-message")) return "bubble";
  if (element.matches(".chat-activity-loading, .chat-activity-pending-detail, .tool-content-error, .tool-use-downgrade-chip, .agent-run-waiting")) return "notice";
  return "typography";
}



/** 会话表面样式只装一份：详情层（presentChat）与 IM 层的转录渲染共用同一批 class，
 *  样式表在模块里保持单一来源，IM 层不再另写一套工具行/卡片。 */




export function presentChat(root: HTMLElement): void {
  installChatSurfaceStyles();
  for (const [host, root] of replies) if (!host.isConnected) { root.unmount(); replies.delete(host); }
  for (const [element, projection] of projections) if (!element.isConnected) { projection.root.unmount(); projections.delete(element); }
  const targets = root.querySelectorAll<HTMLElement>(".chat-html-preview, .chat-message[data-role], .chat-activity, .chat-call, .chat-tool-card, .chat-thinking, .chat-file-attachment, .agent-run, .agent-run-rail, .agent-run-detail-panel, .agent-run-process, .agent-run-timeline, .agent-run-result, .agent-run-receipt, .agent-run-waiting, .ask-user-question-group, .inline-terminal, .inline-diff, .inline-tool, .tool-preview, .chat-activity-detail-section, .chat-activity-thinking-content, .chat-activity-loading, .chat-activity-pending-detail, .tool-content-error, .tool-use-downgrade-chip, .ask-user-option-readonly, .unknown-block");
  for (const element of targets) {
    if (projections.has(element) || element.hidden || !element.isConnected || isDeferredChatContent(element)) continue;
    const kind = kindOf(element);
    if (kind === "unknown") element.removeAttribute("onclick");
    if (kind === "inline") for (const name of ["onclick", "onkeydown", "role", "tabindex", "aria-expanded"]) element.removeAttribute(name);
    const slots = captureSlots(element, kind);
    if (kind === "bubble" && !slots.has("chat-message-text") && !slots.has("chat-message-content")) continue;
    const host = document.createElement(kind === "html" ? "span" : "div");
    if (kind === "html") element.replaceChildren();
    // The first projection happens before interaction. Subsequent morphs keep these exact nodes attached.
    for (const node of slots.values()) node.remove();
    element.prepend(host);
    const projection: Projection = { root: createRoot(host), slots, kind };
    projections.set(element, projection); element.dataset.xPresentation = kind;
    renderProjection(element, projection);
  }
}

registerChatPresentation({ presentChat, refreshChatPresentation, patchChatPresentation });
