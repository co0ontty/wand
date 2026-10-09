import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { Alert, Badge, Button, Card, Collapse, Flex, Tag, Timeline, Typography, theme } from "antd";
import { Bubble, FileCard, Think, ThoughtChain } from "@ant-design/x";
import { EmployeeAvatar } from "../agents/employee-avatar";
import { WandIcon } from "../ui";
import { WandUiProvider } from "../theme";
import { installStyleSheet } from "../styles";
import { readMotionTokenMs } from "../ui/motion-tokens";

type Kind = "bubble" | "call" | "activity" | "tool" | "thinking" | "file" | "agent" | "agent-detail" | "agent-rail" | "agent-process" | "agent-timeline" | "agent-result" | "agent-receipt" | "question" | "section" | "terminal" | "diff" | "inline" | "preview" | "typography" | "notice" | "answer" | "unknown";
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
function DisclosureChevron({ expanded }: { expanded: boolean }): React.ReactElement {
  return <span className="chat-disclosure-chevron" data-expanded={expanded} aria-hidden="true"><WandIcon name="chevronDown" size={13}/></span>;
}
function DisclosureBody({ expanded, children }: { expanded: boolean; children: React.ReactNode }): React.ReactElement {
  return <div className="chat-disclosure-body" data-expanded={expanded} inert={!expanded} aria-hidden={!expanded}>
    <div>{children}</div>
  </div>;
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
  if (kind === "bubble") {
    const body = slots.get("chat-message-content") || slots.get("chat-message-text");
    const usage = body?.querySelector<HTMLElement>(":scope > .turn-usage-summary");
    // Capture on BOTH initial mount and every patch. The body being morphed must
    // not contain a second usage node once its statistics belong to the footer.
    if (usage) { usage.remove(); slots.set("turn-usage-summary", usage); }
  }
  return slots;
}

/** Ant owns message chrome; detached, non-interactive metadata stays a patchable source. */
function ChatBubble({ element, slots }: { element: HTMLElement; slots: Map<string, HTMLElement> }): React.ReactElement {
  const user = element.dataset.role === "user";
  const usage = slots.get("turn-usage-summary");
  const timing = slots.get("chat-message-time");
  const clock = timing?.querySelector("time");
  const duration = textOf(timing, ".chat-message-duration");
  const values = Array.from(usage?.querySelectorAll<HTMLElement>(".turn-usage-value") || []);
  const usageKey = usage?.dataset.expandKey || "";
  const [usageExpanded, setUsageExpanded] = React.useState(usage?.dataset.expanded === "true");
  React.useEffect(() => setUsageExpanded(usage?.dataset.expanded === "true"), [usageKey, usage?.dataset.expanded]);
  // Android ChatMessageTime：时间行在正文之上，自己的发言靠右；等宽字体、次要色。
  const timeRow = timing ? <span className="chat-message-time">
    {duration ? <span className="chat-message-duration">{duration}</span> : null}
    <time dateTime={clock?.getAttribute("datetime") || undefined} title={timing.title}
      aria-label={clock?.getAttribute("aria-label") || undefined}>{textOf(clock || timing)}</time>
  </span> : null;
  // Token details remain available without taking a full statistics row on every reply.
  const usageValues = usage ? <span className="turn-usage-summary" role="status" aria-live="polite"
    aria-label={usage.getAttribute("aria-label") || undefined}>
    <span className="turn-usage-icon" aria-hidden="true"><WandIcon name="sigma" size={13}/></span>
    {values.length ? values.map(value => <span key={value.dataset.chatKey} className="turn-usage-value" title={value.title}>
      <span className="turn-usage-label">{textOf(value, ".turn-usage-label")}</span>{" "}
      <span className="turn-usage-number">{textOf(value, ".turn-usage-number") || textOf(value)}</span>
    </span>)
      : <span className="turn-usage-value">{textOf(usage)}</span>}
  </span> : null;
  const usageRow = usage ? <Collapse ghost size="small" className="turn-usage-disclosure"
    activeKey={usageExpanded ? ["usage"] : []}
    onChange={keys => {
      const expanded = keys.includes("usage");
      setUsageExpanded(expanded);
      usage.dataset.expanded = String(expanded);
      (window as any).__turnUsageSetExpanded?.(usageKey, expanded);
    }}
    items={[{ key: "usage", label: "本轮用量", children: usageValues }]}/> : null;
  return <Bubble placement={user ? "end" : "start"} variant={user ? "filled" : "borderless"} shape="corner"
    // 助手的回复头部（时间 + 署名 + 收起）由 presentAssistantReply 持有，这里不再重复一份时间行。
    header={user ? timeRow : undefined}
    // 助手回复不设阅读栏宽：横向用满可用宽度（对齐 Android 回复正文），只有自己的发言按气泡收口。
    styles={{ body: { minWidth: 0, width: user ? undefined : "100%", maxWidth: user ? "calc(100% - 44px)" : "100%", marginInlineStart: user ? "auto" : undefined },
      content: { overflowWrap: "anywhere", ...(user ? {} : { padding: 0 }) },
      footer: { marginBlockStart: 8, fontVariantNumeric: "tabular-nums", textAlign: "start" } }}
    content={businessBody(slots.get("chat-message-content") || slots.get("chat-message-text"))}
    footerPlacement="outer-start"
    footer={usageRow || undefined}/>;
}

function renderProjection(element: HTMLElement, projection: Projection): void {
  const slots = projection.slots;
  let content: React.ReactNode;
  if (projection.kind === "bubble") {
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
    content = <><Button type="text" block className="chat-process-summary" aria-expanded={expanded}
      onClick={event => preserveDisclosurePosition(event.currentTarget, () => { (window as any).__activityToggle(event.currentTarget); renderProjection(element, projection); })}>
      <OwnedNode node={summary}/><DisclosureChevron expanded={expanded}/>
    </Button><DisclosureBody expanded={expanded}><OwnedNode node={slots.get("chat-activity-menu")}/></DisclosureBody></>;
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
    content = <ThoughtChain line={false} styles={{ itemHeader: { padding: 0 }, itemIcon: { width: 12, minWidth: 12, marginInlineEnd: 8, alignSelf: "flex-start", marginTop: 14 }, itemContent: { marginTop: 0, marginBottom: 0, padding: 0, background: "transparent" } }} items={[{
      key: element.dataset.entryKey,
      // Only the summary animates. Rows carry a static status dot, and the state is read from colour.
      icon: <span className="chat-call-mark" data-status={status} aria-hidden="true"/>,
      title: <Button type="text" block className="chat-call-button" aria-expanded={open}
        aria-label={`${seed?.dataset.label || "工具调用"}，${stateLabel}`}
        onClick={event => preserveDisclosurePosition(event.currentTarget, () => { (window as any).__activityEntryToggle(event.currentTarget); renderProjection(element, projection); })}>
        <span className="chat-call-copy"><span className="chat-call-line">
          {seed?.dataset.time && <time className="chat-call-time" dateTime={seed.dataset.occurredAt}>{seed.dataset.time}</time>}
          <span className="chat-call-label" title={seed?.dataset.label}>{seed?.dataset.label || "工具调用"}</span></span>
          {showsToolRows ? <span className="chat-call-preview" title={inputPreview || undefined}>{inputPreview}</span>
            : inputPreview ? <span className="chat-call-preview" title={inputPreview}>{inputPreview}</span> : null}
          {showsToolRows ? <span className="chat-call-result" data-error={status === "error" ? "" : undefined} title={resultPreview || undefined}>{resultPreview}</span> : null}
        </span><DisclosureChevron expanded={open}/>
      </Button>,
      content: <DisclosureBody expanded={open}>{businessBody(detail)}</DisclosureBody>,
      collapsible: false,
    }]}/>;
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
export function presentAssistantReply(element: HTMLElement, key: string, preview: string, expanded: boolean, toggle: (expanded: boolean) => void, meta?: { time?: string; dateTime?: string; duration?: string; author?: string; employee?: { id: string; name?: string; avatar?: string; provider?: string } }): void {
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
            ? <EmployeeAvatar employee={{ id: employee.id, name: employee.name || employee.id, avatar: employee.avatar }} provider={employee.provider} size="sm"/>
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

let chatSurfaceInstalled = false;

/** 会话表面样式只装一份：详情层（presentChat）与 IM 层的转录渲染共用同一批 class，
 *  样式表在模块里保持单一来源，IM 层不再另写一套工具行/卡片。 */
export function installChatSurfaceStyles(): void {
  if (chatSurfaceInstalled) return;
  chatSurfaceInstalled = true;
  installStyleSheet("wand-chat-library-layout", CHAT_SURFACE_STYLES);
}

const CHAT_SURFACE_STYLES = `
    .chat-message[data-x-presentation="bubble"], .chat-activity[data-x-presentation] { display:block; width:100%; min-width:0; padding:0; }
    .chat-message.assistant-reply-collapsed > :not(.assistant-reply-host) { display:none; }
    .chat-message-text, .chat-activity-thinking-content { white-space:pre-wrap; overflow-wrap:anywhere; }
    .chat-process-summary.ant-btn { height:auto; min-height:52px; padding:11px 4px; text-align:left; justify-content:flex-start; white-space:normal; color:var(--text-secondary); font-size:var(--font-size-xs); }
    .chat-process-summary.ant-btn > div { flex:1; min-width:0; }
    .chat-process-summary:not(.ant-btn) { display:inline-flex; align-items:center; gap:6px; min-width:0; }
    /* 运行标记：静态是一枚实心点，运行态在同一个实例里展开成 3×3 并相位流动。
       几何对齐 Android ToolActivityMark（12dp 标记盒 / 6dp 点 / 步进 4dp）：折叠时九点
       在中心重合放大成一点，展开时只平移不缩放。动画只由运行态驱动，不做演示用定时。 */
    .chat-process-summary-dot { flex:0 0 12px; width:12px; height:12px; display:grid; grid-template-columns:repeat(3,2px); grid-template-rows:repeat(3,2px); place-content:center; gap:2px; --mark-x:0px; --mark-y:0px; }
    .chat-process-summary-dot i { width:2px; height:2px; border-radius:50%; background:currentColor; transform:translate(var(--mark-x),var(--mark-y)) scale(2); transition:transform var(--motion-morph) var(--ease-out-expo); }
    .chat-process-summary-dot i:nth-child(3n + 1) { --mark-x:4px; }
    .chat-process-summary-dot i:nth-child(3n) { --mark-x:-4px; }
    .chat-process-summary-dot i:nth-child(-n + 3) { --mark-y:4px; }
    .chat-process-summary-dot i:nth-child(n + 7) { --mark-y:-4px; }
    .chat-activity[data-live="true"] .chat-process-summary-dot,
    .chat-activity.is-command-running .chat-process-summary-dot,
    .chat-activity.is-thinking-running .chat-process-summary-dot { color:var(--accent); }
    .chat-activity[data-live="true"] .chat-process-summary-dot i,
    .chat-activity.is-command-running .chat-process-summary-dot i,
    .chat-activity.is-thinking-running .chat-process-summary-dot i { transform:none; animation:wand-activity-mark-flow var(--motion-spin) var(--ease-in-out-smooth) infinite; }
    .chat-process-summary-dot i:nth-child(3n + 2) { animation-delay:calc(var(--motion-spin) / -3); }
    .chat-process-summary-dot i:nth-child(3n) { animation-delay:calc(var(--motion-spin) * -2 / 3); }
    /* Android: 呼吸是 1600ms 单程 + Reverse（3.2s 一周）；这里沿用 Web 既有的持续周期 token。 */
    @keyframes wand-activity-mark-flow { 0%, 100% { opacity:.3; } 50% { opacity:1; } }
    .chat-activity-meta { display:inline-flex; flex-wrap:wrap; align-items:baseline; gap:6px; }
    .chat-activity-command-time { color:var(--text-secondary); font-variant-numeric:tabular-nums; }
    .chat-activity-error { color:color-mix(in srgb,var(--ant-color-error-text-active,var(--danger)) 80%,var(--text-primary)); }
    .chat-activity-menu { display:block; opacity:1; pointer-events:auto; }
    .chat-activity-menu-inner { overflow:visible; }
    /* Android：摘要下方按内容长高，最多占聊天视口的 1/3（120–240px），内部滚动。 */
    .chat-activity-timeline { max-height:var(--chat-activity-panel-height,240px); box-sizing:border-box; overflow:auto; overscroll-behavior:contain; overflow-anchor:none; scrollbar-gutter:stable; padding:4px; --chat-call-dot-center:17px; }
    .chat-call .ant-thought-chain-node-box { flex:1; min-width:0; }
    .chat-call-detail { min-width:0; overflow-wrap:anywhere; }
    /* 时间线竖线只连接首末状态点：单条活动不画贯穿整卡的长线（对齐 Android activityTimelineRailBounds）。 */
    .chat-call { position:relative; }
    .chat-call::before { content:""; position:absolute; inset-block:0; inset-inline-start:6px; width:1px; background:var(--border-subtle); }
    /* 17px = 首行上边距（8px）+ 行高的一半（9px），首末行按点心收口。 */
    .chat-call:first-child::before { top:var(--chat-call-dot-center,15px); }
    .chat-call:last-child::before { bottom:calc(100% - var(--chat-call-dot-center,15px)); }
    /* 左侧状态点：颜色承担状态（失败/运行/完成/未返回），右侧不再写状态字样。 */
    .chat-call-mark { display:block; width:6px; height:6px; margin-inline-start:3px; border-radius:50%; background:var(--text-muted); }
    .chat-call[data-status="error"] .chat-call-mark { background:var(--danger); }
    .chat-call[data-status="running"] .chat-call-mark { background:var(--accent); }
    .chat-call[data-status="complete"] .chat-call-mark { background:var(--success); }
    /* 行高按内容档位固定：调用行留出「标签 + 输入 + 结果」三行，思考轮次单行紧凑
       （对齐 Android 的 ACTIVITY_CALL_ROW_MIN_HEIGHT / ACTIVITY_THINKING_ROW_MIN_HEIGHT）。 */
    .chat-call-button.ant-btn { height:auto; min-height:44px; padding:8px 0; text-align:left; justify-content:flex-start; align-items:flex-start; white-space:normal; gap:8px; transition:background-color var(--motion-fast) var(--ease-in-out-smooth); }
    .chat-call[data-tool-ids] .chat-call-button.ant-btn { min-height:78px; }
    /* 行高亮：运行中与已展开用品牌色 5%，失败行用危险色 5%（对齐 Android activityEntryHighlight）。 */
    .chat-call[data-status="running"] .chat-call-button, .chat-call[data-expanded="true"] .chat-call-button { background:color-mix(in srgb,var(--accent) 5%,transparent); }
    .chat-call[data-status="error"] .chat-call-button { background:color-mix(in srgb,var(--danger) 5%,transparent); }
    .chat-call-copy { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
    .chat-call-line { display:flex; align-items:baseline; gap:6px; min-width:0; line-height:18px; }
    .chat-call-time, .chat-call-preview, .chat-call-result { font-family:var(--font-mono); font-size:var(--font-size-2xs); line-height:16px; color:var(--text-muted); }
    .chat-call-label, .chat-call-preview, .chat-call-result { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    /* 摘录行常驻：没有内容时也占一行，迟到结果不会把行撑高。 */
    .chat-call-preview, .chat-call-result { min-height:16px; }
    .chat-call-line .chat-call-label { flex:1; min-width:0; }
    .chat-call-label { font-size:var(--font-size-xs); font-weight:var(--font-weight-medium); color:var(--text-secondary); }
    .chat-call[data-status="running"] .chat-call-label, .chat-call[data-expanded="true"] .chat-call-label { color:var(--text-primary); }
    .chat-call-result[data-error] { color:var(--danger); }
    .chat-call[data-thinking-entry] .chat-call-preview, .chat-call[data-thinking-entry] .chat-call-result { white-space:normal; -webkit-line-clamp:2; -webkit-box-orient:vertical; display:-webkit-box; }
    .chat-disclosure-chevron { display:inline-flex; flex-shrink:0; margin-inline-start:auto; transition:transform var(--motion-normal) var(--ease-out-expo); }
    .chat-disclosure-chevron[data-expanded="true"] { transform:rotate(180deg); }
    .chat-disclosure-body { display:grid; grid-template-rows:0fr; opacity:0; transition:grid-template-rows var(--motion-normal) var(--ease-out-expo),opacity var(--motion-fast) var(--ease-in-out-smooth); }
    .chat-disclosure-body[data-expanded="true"] { grid-template-rows:1fr; opacity:1; }
    .chat-disclosure-body > div { min-height:0; overflow:hidden; }
    .chat-disclosure-body .chat-tool-body, .chat-disclosure-body .diff-body { padding:12px; }
    .chat-activity-detail-content { padding:8px 4px 12px; }
    .chat-activity-detail-section h4 { margin:0 0 6px; font-size:var(--font-size-xs); color:var(--text-secondary); font-weight:500; }
    .chat-activity-detail-section pre, .tool-use-content, .tool-use-result-content { white-space:pre-wrap; overflow-wrap:anywhere; font-family:var(--font-mono); max-height:320px; overflow:auto; font-size:var(--font-size-xs); }
    .chat-activity-thinking-content { font-size:var(--font-size-sm); line-height:1.65; }
    .agent-run-body[aria-hidden="true"] { display:none; }
    /* 内联工具图片（Read 读图 / 工具结果截图）：图片拿到真实尺寸前是 0×0，所以加载期间由占位行
       给出反馈，加载完收掉、失败整块隐藏（对齐 Android WandAsyncToolImage 的 onError 不渲染）。
       图片是本地文件或内联 base64，没有可信的字节进度，转圈只表示「正在取图」。 */
    .inline-tool-image { display:block; min-width:0; margin:8px 0; }
    .inline-tool-image[data-image-state="error"] { display:none; }
    .inline-tool-image-loading { display:inline-flex; align-items:center; gap:8px; padding:8px 12px; border:1px dashed var(--border-subtle); border-radius:var(--radius-md); color:var(--text-secondary); font-size:var(--font-size-2xs); }
    .inline-tool-image-spinner { width:12px; height:12px; border-radius:50%; border:2px solid color-mix(in srgb,currentColor 22%,transparent); border-top-color:currentColor; animation:wand-tool-icon-spin var(--motion-spin) linear infinite; }
    .inline-tool-image[data-image-state="ready"] .inline-tool-image-loading { display:none; }
    .inline-tool-image-thumb { max-width:100%; max-height:320px; object-fit:contain; object-position:left center; cursor:pointer; }
    .inline-tool-image-thumb:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
    .chat-tool-card, .inline-terminal, .inline-diff, .agent-run { width:100%; min-width:0; }
    .chat-tool-trigger.ant-btn { height:40px; min-width:0; justify-content:flex-start; text-align:left; gap:8px; padding:6px 8px; }
    /* Android ToolCard 头部：34dp 状态图标槽 + 标题/摘要两行 + 箭头，去掉右侧状态字样。 */
    .chat-tool-trigger-card.ant-btn { height:auto; min-height:54px; padding:10px 12px; gap:10px; align-items:center; }
    .chat-tool-icon-slot { position:relative; flex:none; width:34px; height:34px; border-radius:9px; display:grid; place-items:center; background:color-mix(in srgb,var(--text-muted) 11%,transparent); color:var(--text-secondary); transition:background-color var(--motion-fast) var(--ease-in-out-smooth), color var(--motion-fast) var(--ease-in-out-smooth); }
    .chat-tool-icon-slot[data-status="running"] { background:color-mix(in srgb,var(--accent) 11%,transparent); color:var(--accent); }
    .chat-tool-icon-slot[data-status="success"] { background:color-mix(in srgb,var(--success) 11%,transparent); color:var(--success); }
    .chat-tool-icon-slot[data-status="error"] { background:color-mix(in srgb,var(--danger) 11%,transparent); color:var(--danger); }
    .chat-tool-icon-progress, .chat-tool-icon-glyph { position:absolute; inset:0; display:grid; place-items:center; transition:opacity var(--motion-morph) var(--ease-out-expo), transform var(--motion-morph) var(--ease-out-expo); }
    .chat-tool-icon-progress { opacity:0; transform:rotate(90deg) scale(.78); }
    .chat-tool-icon-progress::before { content:""; box-sizing:border-box; width:16px; height:16px; border-radius:50%; border:2px solid color-mix(in srgb,currentColor 22%,transparent); border-top-color:currentColor; }
    /* 运行态：进度环淡入并转响，工具图标旋转缩小淡出；结果到达后沿同一曲线倒放（同一个实例）。 */
    .chat-tool-icon-slot[data-status="running"] .chat-tool-icon-progress { opacity:1; transform:none; }
    .chat-tool-icon-slot[data-status="running"] .chat-tool-icon-progress::before { animation:wand-tool-icon-spin var(--motion-spin) linear infinite; }
    .chat-tool-icon-slot[data-status="running"] .chat-tool-icon-glyph { opacity:0; transform:rotate(90deg) scale(.78); }
    @keyframes wand-tool-icon-spin { to { transform:rotate(360deg); } }
    .chat-tool-head { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; text-align:start; }
    .chat-tool-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .chat-tool-summary { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; font-family:var(--font-mono); font-size:var(--font-size-2xs); line-height:1.4; color:var(--text-secondary); }
    .chat-tool-subtitle { flex:1; min-width:0; text-align:left; font-size:var(--font-size-xs); }
    .chat-tool-error-preview { padding-inline:8px; font-size:var(--font-size-xs); }
    .decision-result-load { width:12em; max-width:100%; }
    .decision-tool-card[data-decision-result-window="true"] .tool-use-result-content { height:160px; overflow:auto; }
    .chat-tool-surface { border-bottom:1px solid var(--border-subtle); }
    /* Android 工具卡是一张 14dp 圆角的描边卡，不是只有一条分隔线的裸行。 */
    .chat-tool-surface.chat-tool-card-surface { border:1px solid var(--border-subtle); border-radius:var(--radius-lg); background:var(--bg-surface); overflow:hidden; }
    .ant-btn.agent-run-summary, .ant-btn.agent-run-agent { height:auto; text-align:left; white-space:normal; }
    /* 头部（时间 + 署名）与正文都占满整行；正文不再压成窄阅读栏。 */
    .assistant-reply-host { font-size:var(--font-size-sm); width:100%; min-width:0; }
    /* Metadata shares one compact row; full time/duration stays available on the clock. */
    .assistant-reply-head { display:flex; flex-direction:column; gap:6px; width:100%; min-width:0; }
    .chat-message-time { display:inline-flex; align-items:center; gap:8px; padding:2px 8px; font-family:var(--font-mono); font-size:var(--font-size-2xs); font-weight:var(--font-weight-medium); color:var(--text-secondary); font-variant-numeric:tabular-nums; }
    .chat-message.user .ant-bubble-header { display:flex; justify-content:flex-end; }
    .assistant-reply-disclosure.ant-btn { height:auto; min-height:44px; padding:5px 8px; border-radius:var(--radius-md); justify-content:flex-start; gap:8px; text-align:left; color:var(--text-primary); }
    /* 收起态用弱底色交代「这里折起来了」，展开态回到透明标题行（对齐 Android AssistantReplyHeader）。 */
    .chat-message.assistant-reply-collapsed .assistant-reply-disclosure.ant-btn { background:color-mix(in srgb,var(--bg-secondary) 58%,transparent); }
    .assistant-author { display:inline-flex; align-items:center; gap:8px; flex:0 1 auto; min-width:0; }
    .assistant-author-avatar { display:grid; place-items:center; width:26px; height:26px; flex:none; }
    .assistant-author-avatar .ant-avatar { border-radius:50%; }
    .assistant-author-spark { display:grid; place-items:center; width:26px; height:26px; border-radius:50%; background:color-mix(in srgb,var(--accent) 14%,transparent); color:var(--accent); }
    .assistant-author-name { font-size:var(--font-size-xs); font-weight:var(--font-weight-semibold); color:var(--text-primary); max-width:16em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .assistant-author-preview { flex:1; min-width:0; font-size:var(--font-size-2xs); font-weight:400; color:var(--text-secondary); text-align:start; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .assistant-author-space { flex:1; min-width:0; }
    .assistant-reply-action { flex:none; font-size:var(--font-size-2xs); font-weight:var(--font-weight-semibold); color:var(--text-primary); }
    /* Android UsageSummaryRow：回复尾部独立一行的小字用量（等宽、次要色、左对齐）。 */
    .turn-usage-summary { display:inline-flex; align-items:center; flex-wrap:wrap; gap:4px 14px; padding:4px 0; font-size:var(--font-size-xs); color:var(--text-secondary); font-variant-numeric:tabular-nums; }
    .turn-usage-icon { display:inline-flex; flex:none; width:13px; height:13px; color:var(--text-secondary); }
    .turn-usage-value { display:inline-flex; align-items:baseline; gap:5px; white-space:nowrap; }
    .turn-usage-number { font-family:var(--font-mono); color:var(--text-primary); }
    .turn-usage-disclosure.ant-collapse { width:100%; }
    .turn-usage-disclosure.ant-collapse > .ant-collapse-item > .ant-collapse-header { padding:4px 0; color:var(--text-secondary); font-size:var(--font-size-xs); }
    .turn-usage-disclosure.ant-collapse > .ant-collapse-item > .ant-collapse-content > .ant-collapse-content-box { padding:0; }
    @media (pointer:coarse) {
      .turn-usage-disclosure.ant-collapse > .ant-collapse-item > .ant-collapse-header { min-height:44px; box-sizing:border-box; align-items:center; }
      .chat-message-time { padding-inline:0; }
    }
    .agent-run-surface .ant-card-head { min-height:0; padding:0; }
    .agent-run-surface .ant-card-head-title { padding:0; }
    .agent-run-summary.ant-btn { padding:10px 12px; gap:8px; align-items:flex-start; border-radius:var(--radius-md); }
    .agent-run-summary > .ant-badge { padding-block-start:3px; }
    .agent-run-summary-copy { display:flex; flex-direction:column; gap:4px; flex:1; min-width:0; }
    .agent-run-summary-line { display:flex; align-items:baseline; gap:8px; min-width:0; }
    .agent-run-title { flex:1; min-width:0; overflow-wrap:anywhere; font-size:var(--font-size-xs); font-weight:500; }
    .agent-run-status-label, .agent-run-agent-status { flex:none; font-size:var(--font-size-xs); }
    .agent-run-context { display:flex; gap:8px; flex-wrap:wrap; font-size:var(--font-size-2xs); font-weight:400; color:var(--text-secondary); }
    .agent-run-latest { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:var(--font-size-xs); font-weight:400; }
    .agent-run-summary .chat-disclosure-chevron { padding-block-start:3px; }
    .agent-run-agent.ant-btn { padding:6px 8px; gap:8px; align-items:center; }
    .agent-run-agent.is-selected { background:var(--bg-secondary); }
    .agent-run-agent-copy { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; text-align:start; }
    .agent-run-agent-name { font-size:var(--font-size-xs); overflow-wrap:anywhere; }
    .agent-run-agent-type, .agent-run-output-label { font-size:var(--font-size-2xs); color:var(--text-secondary); }
    .agent-run-detail-task { min-width:0; overflow-wrap:anywhere; font-size:var(--font-size-xs); }
    .agent-run-output { min-width:0; overflow-wrap:anywhere; }
    .agent-run-process .ant-collapse-header { padding:6px 0 !important; color:var(--text-secondary); font-size:var(--font-size-xs); }
    .agent-run-process .ant-collapse-content-box { padding-inline:0 !important; }
    .agent-run-receipt-row { display:flex; flex-wrap:wrap; gap:4px 8px; font-size:var(--font-size-xs); }
    .agent-run-receipt-row code { overflow-wrap:anywhere; }
    /* 自己的发言：品牌色 13% 拼接底 + 品牌色 24% 描边 + 右下小圆角尾巴（对齐 Android UserBubble）。 */
    .chat-message.user .ant-bubble-content { padding:8px 13px; /* 15px/21px：与 Android UserBubble 同一档正文 */ border-radius:20px 20px 6px 20px; border:1px solid color-mix(in srgb,var(--accent) 24%,transparent); background:color-mix(in srgb,var(--accent) 13%,var(--bg-surface)); font-size:15px; line-height:21px; }
    .chat-resource-selection { font-size:var(--font-size-xs); overflow-wrap:anywhere; }
    .chat-process-summary.ant-btn, .chat-activity-command-time, .chat-call-time, .chat-tool-subtitle.ant-typography, .chat-resource-selection { color:color-mix(in srgb,var(--text-secondary) 88%,var(--text-primary)); }
    @media (max-width:640px) { .chat-tool-trigger.ant-btn { min-height:44px; } }
    /* reduce-motion：不流动、不旋转，只保留状态色，和 Android WandStatusIconSlot / ToolActivityMark 一致。 */
    @media (prefers-reduced-motion:reduce) { .chat-disclosure-body, .chat-disclosure-chevron { transition:none; } .inline-tool-image-spinner { animation:none; } .chat-process-summary-dot i, .chat-tool-icon-progress, .chat-tool-icon-glyph, .chat-call-button.ant-btn { transition:none; }
      .chat-activity[data-live="true"] .chat-process-summary-dot i,
      .chat-activity.is-command-running .chat-process-summary-dot i,
      .chat-activity.is-thinking-running .chat-process-summary-dot i { animation:none; transform:translate(var(--mark-x),var(--mark-y)) scale(2); }
      .chat-tool-icon-slot[data-status="running"] .chat-tool-icon-progress { opacity:0; }
      .chat-tool-icon-slot[data-status="running"] .chat-tool-icon-progress::before { animation:none; }
      .chat-tool-icon-slot[data-status="running"] .chat-tool-icon-glyph { opacity:1; transform:none; } }
    .agent-run-detail, .agent-run-agent-body { display:grid; gap:12px; }
    .agent-run-body-inner { display:grid; gap:12px; }
    .ask-user-options { display:grid; gap:8px; }
    .diff-columns { display:flex; overflow:auto; }
    .diff-col { flex:1; min-width:0; white-space:pre-wrap; font-family:monospace; }
    .diff-remove { color:var(--danger); } .diff-add { color:var(--success); }
    .term-output { white-space:pre-wrap; overflow-wrap:anywhere; font-family:monospace; }
    .chat-messages img { max-width:100%; height:auto; }
    [data-composer-sender] { width:100%; min-width:0; }
    /* IM 层的转录（conversations/activity.tsx）直接铺在消息气泡里：与详情层共用同一批
       .chat-call / .chat-process-summary / .chat-tool-* 规则，只少一层有界内滚动与缩进。 */
    .chat-activity-inline { display:flex; flex-direction:column; gap:2px; }
    .chat-activity-rows { display:flex; flex-direction:column; gap:2px; padding-inline-start:20px; }
    .chat-call-inline { display:flex; align-items:flex-start; gap:8px; }
    .chat-process-summary-plain { display:flex; align-items:center; gap:6px; width:100%; min-width:0; padding:6px 0; border:0; background:transparent; text-align:left; font:inherit; color:color-mix(in srgb,var(--text-secondary) 88%,var(--text-primary)); font-size:var(--font-size-xs); cursor:pointer; }
    .chat-call-button-plain { display:flex; align-items:flex-start; gap:8px; width:100%; min-width:0; padding:6px 4px; border:0; border-radius:var(--radius-md); background:transparent; text-align:left; font:inherit; color:inherit; cursor:pointer; }
    .chat-call-inline .chat-call-copy { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
    .chat-call-inline .chat-disclosure-chevron { margin-inline-start:auto; }
    .chat-call-inline .chat-disclosure-body { flex-basis:100%; }
  `;

export function presentChat(root: HTMLElement): void {
  installChatSurfaceStyles();
  for (const [host, root] of replies) if (!host.isConnected) { root.unmount(); replies.delete(host); }
  for (const [element, projection] of projections) if (!element.isConnected) { projection.root.unmount(); projections.delete(element); }
  const targets = root.querySelectorAll<HTMLElement>(".chat-message[data-role], .chat-activity, .chat-call, .chat-tool-card, .chat-thinking, .chat-file-attachment, .agent-run, .agent-run-rail, .agent-run-detail-panel, .agent-run-process, .agent-run-timeline, .agent-run-result, .agent-run-receipt, .agent-run-waiting, .ask-user-question-group, .inline-terminal, .inline-diff, .inline-tool, .tool-preview, .chat-activity-detail-section, .chat-activity-thinking-content, .chat-activity-loading, .chat-activity-pending-detail, .tool-content-error, .tool-use-downgrade-chip, .ask-user-option-readonly, .unknown-block");
  for (const element of targets) {
    if (projections.has(element) || element.hidden || !element.isConnected || isDeferredChatContent(element)) continue;
    const kind = kindOf(element);
    if (kind === "unknown") element.removeAttribute("onclick");
    if (kind === "inline") for (const name of ["onclick", "onkeydown", "role", "tabindex", "aria-expanded"]) element.removeAttribute(name);
    const slots = captureSlots(element, kind);
    if (kind === "bubble" && !slots.has("chat-message-text") && !slots.has("chat-message-content")) continue;
    const host = document.createElement("div");
    // The first projection happens before interaction. Subsequent morphs keep these exact nodes attached.
    for (const node of slots.values()) node.remove();
    element.prepend(host);
    const projection: Projection = { root: createRoot(host), slots, kind };
    projections.set(element, projection); element.dataset.xPresentation = kind;
    renderProjection(element, projection);
  }
}
