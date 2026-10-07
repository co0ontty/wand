import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { Alert, Badge, Button, Card, Collapse, Flex, Spin, Tag, Timeline, Typography, theme } from "antd";
import { Bubble, FileCard, Think, ThoughtChain } from "@ant-design/x";
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
  const { token } = theme.useToken();
  const user = element.dataset.role === "user";
  const usage = slots.get("turn-usage-summary");
  const timing = slots.get("chat-message-time");
  const clock = timing?.querySelector("time");
  const duration = textOf(timing, ".chat-message-duration");
  const stats = usage || timing;
  const smallText = { fontSize: token.fontSizeSM, color: token.colorText };
  const values = Array.from(usage?.querySelectorAll<HTMLElement>(".turn-usage-value") || []);
  return <Bubble placement={user ? "end" : "start"} variant={user ? "filled" : "borderless"} shape="corner"
    styles={{ body: { minWidth: 0, width: user ? undefined : "100%", maxWidth: user ? "min(85%, 72ch)" : "min(100%, 72ch)" },
      content: { background: user ? token.colorPrimaryBg : "transparent", overflowWrap: "anywhere", ...(user ? {} : { padding: 0 }) },
      footer: { marginBlockStart: token.marginXS, fontVariantNumeric: "tabular-nums" } }}
    content={businessBody(slots.get("chat-message-content") || slots.get("chat-message-text"))}
    footerPlacement={user ? "inner-end" : "inner-start"}
    footer={stats ? <Flex className="chat-message-stats" align="center" wrap gap="middle" justify={usage ? "space-between" : "flex-end"}>
      {usage ? <Flex className={usage.className} align="center" wrap gap="small" role="status" aria-live="polite" aria-label={usage.getAttribute("aria-label") || undefined}>
        {values.length ? values.map(value => <Typography.Text key={value.dataset.chatKey} type="secondary" style={smallText} title={value.title}>{textOf(value)}</Typography.Text>)
          : <Typography.Text type="secondary" style={smallText}>{textOf(usage)}</Typography.Text>}
      </Flex> : null}
      {timing ? <Flex className="chat-message-time" align="center" wrap gap="small">
        {duration ? <Typography.Text type="secondary" style={smallText}>{duration}</Typography.Text> : null}
        <Typography.Text type="secondary" style={smallText}><time dateTime={clock?.getAttribute("datetime") || undefined}
          title={timing.title} aria-label={clock?.getAttribute("aria-label") || undefined}>{textOf(clock || timing)}</time></Typography.Text>
      </Flex> : null}
    </Flex> : undefined}/>;
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
    const status = kind === "tool" ? element.classList.contains("error") ? "error" : element.classList.contains("success") ? "success" : "pending" : kind === "terminal" ? header?.querySelector(".term-error") ? "error" : header?.querySelector(".term-success") ? "success" : "running" : header?.querySelector(".diff-error") ? "error" : header?.querySelector(".diff-success") ? "success" : "running";
    const expanded = kind === "terminal" ? element.dataset.expanded === "true" : !element.classList.contains("collapsed");
    const toggle = (event: React.MouseEvent<HTMLButtonElement>) => {
      preserveDisclosurePosition(event.currentTarget, () => {
        if (kind === "terminal") (window as any).__terminalExpand(event.currentTarget);
        else if (element.classList.contains("decision-tool-card")) (window as any).__decisionToggle(event, event.currentTarget);
        else (window as any).__tcToggle(event, event.currentTarget);
        renderProjection(element, projection);
      });
    };
    const trigger = <Button type="text" block className={`${headerClass} chat-tool-trigger`} aria-expanded={expanded}
      data-tool-toggle={kind === "tool" && !element.classList.contains("decision-tool-card") ? "" : undefined}
      onClick={toggle}>
      <Badge status={statusColor(status)}/>
      <span className="chat-tool-title" title={title}>{title || "工具调用"}</span>
      {subtitle && <Typography.Text className={`chat-tool-subtitle${element.classList.contains("decision-tool-card") ? " decision-tool-summary" : ""}`} role={element.classList.contains("decision-tool-card") ? "status" : undefined} type="secondary" ellipsis title={subtitle}>{subtitle}</Typography.Text>}
      {!element.classList.contains("decision-tool-card") && <span className={`chat-tool-state${status === "error" ? " chat-activity-error" : ""}`}>{element.classList.contains("ask-user") ? element.classList.contains("ask-user-answered") ? "已回答" : "待回答" : status === "error" ? "失败" : status === "success" ? "完成" : "未返回"}</span>}
      <DisclosureChevron expanded={expanded}/>
    </Button>;
    const body = <DisclosureBody expanded={expanded}>
      {Array.from(slots).filter(([name]) => name !== headerClass && name !== "diff-file-action" && name !== "tool-preview")
        .map(([name, node]) => <React.Fragment key={name}>{businessBody(node)}</React.Fragment>)}
    </DisclosureBody>;
    const interactive = element.classList.contains("ask-user") || element.classList.contains("decision-tool-card");
    content = interactive ? <Card size="small" title={trigger} styles={{ body: { padding: 0 }, header: { paddingInline: 8 } }}>{body}</Card>
      : <Flex vertical className="chat-tool-surface">
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
    const live = element.classList.contains("is-command-running") || element.classList.contains("is-thinking-running");
    content = <><Button type="text" block className="chat-process-summary" aria-expanded={expanded}
      icon={live ? <Spin size="small"/> : undefined}
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
    const preview = thinking ? "" : [seed?.dataset.preview, seed?.dataset.result === stateLabel ? "" : seed?.dataset.result].filter(Boolean).join(" · ");
    content = <ThoughtChain line={false} styles={{ itemHeader: { padding: 0 }, itemContent: { marginTop: 0, marginBottom: 0, padding: 0, background: "transparent" } }} items={[{
      key: element.dataset.entryKey,
      // Only the summary animates. Rows are compact, selectable records, not cards.
      icon: <WandIcon name={thinking ? "spark" : status === "error" ? "close" : status === "complete" ? "check" : "circle"} size={13}/>,
      title: <Button type="text" block className="chat-call-button" aria-expanded={open}
        onClick={event => preserveDisclosurePosition(event.currentTarget, () => { (window as any).__activityEntryToggle(event.currentTarget); renderProjection(element, projection); })}>
        <span className="chat-call-copy"><span className="chat-call-label" title={seed?.dataset.label}>{seed?.dataset.label || "工具调用"}</span>
          {preview && <span className="chat-call-preview" title={preview}>{preview}</span>}
        </span>
        <span className="chat-call-meta"><span className={status === "error" ? "chat-activity-error" : ""}>{stateLabel}</span>
          {seed?.dataset.time && <time dateTime={seed.dataset.occurredAt}>{seed.dataset.time}</time>}
        </span><DisclosureChevron expanded={open}/>
      </Button>,
      content: <DisclosureBody expanded={open}>{businessBody(detail)}</DisclosureBody>,
      collapsible: false,
    }]}/>;
  } else if (projection.kind === "agent") {
    const seed = slots.get("agent-run-summary");
    const expanded = element.dataset.expanded === "true";
    content = <Card size="small" styles={{ body: expanded ? undefined : { display: "none" } }} title={<Button type="text" block className="agent-run-summary" aria-expanded={expanded}
      aria-label={element.getAttribute("aria-label") || undefined} aria-controls={slots.get("agent-run-body")?.id}
      onClick={event => preserveDisclosurePosition(event.currentTarget, () => (window as any).__agentRunToggle(event, event.currentTarget))}>
      <Flex vertical gap="small" align="start"><Flex gap="small" align="center" wrap><Badge status={statusColor(element.dataset.status)}/>
        <Typography.Text strong>{textOf(seed, ".agent-run-title")}</Typography.Text>
        {textOf(seed, ".agent-run-topic") && <Typography.Text type="secondary">{textOf(seed, ".agent-run-topic")}</Typography.Text>}
        {textOf(seed, ".agent-run-type-chip") && <Tag>{textOf(seed, ".agent-run-type-chip")}</Tag>}
        {textOf(seed, ".agent-run-status-label") && <Tag color={statusColor(element.dataset.status)}>{textOf(seed, ".agent-run-status-label")}</Tag>}
        <WandIcon name={expanded ? "chevronUp" : "chevronDown"} size={13}/></Flex>
        {textOf(seed, ".agent-run-latest") && <Typography.Text type="secondary">{textOf(seed, ".agent-run-latest")}</Typography.Text>}
      </Flex>
    </Button>}><OwnedNode node={slots.get("agent-run-body")}/></Card>;
  } else if (projection.kind === "agent-rail") {
    const selected = element.closest(".agent-run")?.querySelector<HTMLElement>(".agent-run-detail-panel.is-selected")?.dataset.agentTaskId;
    content = <Flex gap="small" wrap>{Array.from(slots).map(([key, seed]) => {
      const active = selected === key;
      const label = textOf(seed, ".agent-run-agent-copy strong") || textOf(seed);
      const status = Array.from(seed.querySelector(".agent-run-agent-status")?.classList || []).find(name => name.startsWith("is-"))?.slice(3);
      return <Button key={key} size="small" type={active ? "primary" : "default"} className={"agent-run-agent" + (active ? " is-selected" : "")}
        id={seed.id} role="tab" aria-controls={seed.getAttribute("aria-controls") || undefined} aria-selected={active} tabIndex={active ? 0 : -1}
        data-agent-task-id={key} data-agent-run-id={element.closest<HTMLElement>(".agent-run")?.dataset.agentRunId}
        onClick={event => (window as any).__agentRunSelect(event, event.currentTarget)}
        onKeyDown={event => (window as any).__agentRunSelect(event, event.currentTarget)}>
        <Flex gap="small" align="center"><Badge status={statusColor(status)} color={seed.style.getPropertyValue("--agent-color") || undefined}/>{label}{textOf(seed, ".agent-run-agent-type") && <Tag>{textOf(seed, ".agent-run-agent-type")}</Tag>}
          {textOf(seed, ".agent-run-agent-status") && <Tag color={statusColor(status)}>{textOf(seed, ".agent-run-agent-status")}</Tag>}</Flex>
      </Button>;
    })}</Flex>;
  } else if (projection.kind === "agent-detail") {
    const head = slots.get("agent-run-detail-head");
    const state = head?.querySelector(".agent-run-detail-state");
    const status = Array.from(state?.classList || []).find(name => name.startsWith("is-"))?.slice(3);
    content = <Flex vertical gap="middle"><Flex gap="small" align="center" wrap><Badge status={statusColor(status)}/>
      <Typography.Text strong>{textOf(head, ".agent-run-detail-task")}</Typography.Text>
      {textOf(head, ".agent-run-type-chip") && <Tag>{textOf(head, ".agent-run-type-chip")}</Tag>}
      {head?.querySelector<HTMLElement>(".pi-execution-open") && <Button size="small" className="pi-execution-open" data-tool-id={head.querySelector<HTMLElement>(".pi-execution-open")?.dataset.toolId}
        onClick={event => (window as any).__piExecutionOpen(event, event.currentTarget)}>{textOf(head, ".pi-execution-open")}</Button>}
    </Flex><OwnedNode node={slots.get("agent-run-agent-body")}/></Flex>;
  } else if (projection.kind === "agent-process") {
    projection.expanded ??= element.dataset.expanded === "true";
    element.dataset.expanded = String(projection.expanded);
    content = <Collapse size="small" activeKey={projection.expanded ? ["process"] : []} destroyOnHidden={false}
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
    content = <Card size="small" title={<Typography.Text type={element.classList.contains("is-error") ? "danger" : undefined}>
      {textOf(slots.get("agent-run-result-label"))}</Typography.Text>}>
      {receipt ? <>{businessBody(slots.get("agent-run-receipt-rows"))}{businessBody(slots.get("agent-run-receipt-body"))}</> : businessBody(slots.get("agent-run-result-content"))}
    </Card>;
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
export function presentAssistantReply(element: HTMLElement, key: string, preview: string, expanded: boolean, toggle: (expanded: boolean) => void): void {
  let host = Array.from(element.children).find(child => child.classList.contains("assistant-reply-host")) as HTMLElement | undefined;
  if (!host) {
    host = document.createElement("div"); host.className = "assistant-reply-host";
    element.prepend(host);
  }
  let root = replies.get(host);
  if (!root) { root = createRoot(host); replies.set(host, root); }
  flushSync(() => root!.render(<WandUiProvider><Button type="text" block className="assistant-reply-disclosure"
    data-expand-key={key} aria-expanded={expanded} onClick={event => preserveDisclosurePosition(event.currentTarget, () => {
      toggle(!expanded); presentAssistantReply(element, key, preview, !expanded, toggle);
    })}>
    <Flex gap="small" align="center" style={{ width: "100%", minWidth: 0 }}>
      <Typography.Text strong>回复</Typography.Text>
      <Typography.Text type="secondary" ellipsis title={preview} style={{ flex: 1, minWidth: 0, textAlign: "left" }}>{expanded ? "" : preview}</Typography.Text>
      <DisclosureChevron expanded={expanded}/>
    </Flex>
  </Button></WandUiProvider>));
}

/** Read native business state after a disclosure/tab delegate, without owning it again. */
export function refreshChatPresentation(root: HTMLElement): void {
  presentChat(root);
  for (const [element, projection] of projections) if (root === element || root.contains(element)) renderProjection(element, projection);
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

export function presentChat(root: HTMLElement): void {
  installStyleSheet("wand-chat-library-layout", `
    .chat-message[data-x-presentation="bubble"], .chat-activity[data-x-presentation] { display:block; width:100%; min-width:0; padding:0; }
    .chat-message.assistant-reply-collapsed > :not(.assistant-reply-host) { display:none; }
    .chat-message-text, .chat-activity-thinking-content { white-space:pre-wrap; overflow-wrap:anywhere; }
    .chat-process-summary.ant-btn { height:auto; min-height:36px; padding:6px 0; text-align:left; justify-content:flex-start; white-space:normal; color:var(--text-secondary); font-size:var(--font-size-xs); }
    .chat-process-summary.ant-btn > div { flex:1; min-width:0; }
    .chat-activity-meta { display:inline-flex; flex-wrap:wrap; align-items:baseline; gap:6px; }
    .chat-activity-command-time { color:var(--text-secondary); font-variant-numeric:tabular-nums; }
    .chat-activity-error { color:color-mix(in srgb,var(--ant-color-error-text-active,var(--danger)) 80%,var(--text-primary)); }
    .chat-activity-menu { display:block; opacity:1; pointer-events:auto; }
    .chat-activity-menu-inner { overflow:visible; }
    .chat-activity-timeline { height:240px; max-height:50dvh; box-sizing:border-box; overflow:auto; overscroll-behavior:contain; overflow-anchor:none; scrollbar-gutter:stable; padding:4px 0 4px 12px; border-inline-start:1px solid var(--border-subtle); }
    .chat-call .ant-thought-chain-node-box { flex:1; min-width:0; }
    .chat-call-detail { min-width:0; overflow-wrap:anywhere; }
    .chat-call-button.ant-btn { height:auto; min-height:36px; padding:6px 4px; text-align:left; justify-content:flex-start; white-space:normal; gap:8px; }
    .chat-call-copy { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
    .chat-call-label, .chat-call-preview { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .chat-call-label { font-size:var(--font-size-sm); font-weight:var(--font-weight-medium); }
    .chat-call-preview, .chat-call-meta { font-size:var(--font-size-xs); color:var(--text-secondary); font-weight:400; }
    .chat-call-meta { display:flex; flex-direction:column; align-items:flex-end; flex-shrink:0; font-variant-numeric:tabular-nums; }
    .chat-call[data-thinking-entry] .chat-call-meta { flex-direction:row; gap:8px; }
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
    .inline-tool-image-thumb { max-height:320px; object-fit:contain; object-position:left center; }
    .chat-tool-card, .inline-terminal, .inline-diff, .agent-run { width:100%; min-width:0; }
    .chat-tool-trigger.ant-btn { height:40px; min-width:0; justify-content:flex-start; text-align:left; gap:8px; padding:6px 8px; }
    .chat-tool-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .chat-tool-subtitle { flex:1; min-width:0; text-align:left; font-size:var(--font-size-xs); }
    .chat-tool-state { margin-inline-start:auto; font-size:var(--font-size-xs); color:var(--text-secondary); flex-shrink:0; }
    .chat-tool-error-preview { padding-inline:8px; font-size:var(--font-size-xs); }
    .decision-result-load { width:12em; max-width:100%; }
    .decision-tool-card[data-decision-result-window="true"] .tool-use-result-content { height:160px; overflow:auto; }
    .chat-tool-surface { border-bottom:1px solid var(--border-subtle); }
    .ant-btn.agent-run-summary, .ant-btn.agent-run-agent { height:auto; text-align:left; white-space:normal; }
    .assistant-reply-host { font-size:var(--font-size-sm); max-width:min(100%,72ch); }
    .assistant-reply-disclosure.ant-btn { height:28px; padding-inline:0; font-size:var(--font-size-xs); color:var(--text-secondary); }
    .chat-resource-selection { font-size:var(--font-size-xs); overflow-wrap:anywhere; }
    .chat-process-summary.ant-btn, .chat-activity-command-time, .chat-call-preview, .chat-call-meta, .chat-tool-subtitle.ant-typography, .chat-tool-state:not(.chat-activity-error), .chat-resource-selection { color:color-mix(in srgb,var(--text-secondary) 88%,var(--text-primary)); }
    @media (max-width:640px) { .chat-process-summary.ant-btn, .chat-call-button.ant-btn, .chat-tool-trigger.ant-btn { min-height:44px; } .chat-activity-timeline { padding-inline-start:8px; } }
    @media (prefers-reduced-motion:reduce) { .chat-disclosure-body, .chat-disclosure-chevron { transition:none; } }
    .agent-run-detail, .agent-run-agent-body { display:grid; gap:12px; }
    .agent-run-body-inner { display:grid; gap:12px; }
    .ask-user-options { display:grid; gap:8px; }
    .diff-columns { display:flex; overflow:auto; }
    .diff-col { flex:1; min-width:0; white-space:pre-wrap; font-family:monospace; }
    .diff-remove { color:var(--danger); } .diff-add { color:var(--success); }
    .term-output { white-space:pre-wrap; overflow-wrap:anywhere; font-family:monospace; }
    .chat-messages img { max-width:100%; height:auto; }
    [data-composer-sender] { width:100%; min-width:0; }
  `);
  for (const [host, root] of replies) if (!host.isConnected) { root.unmount(); replies.delete(host); }
  for (const [element, projection] of projections) if (!element.isConnected) { projection.root.unmount(); projections.delete(element); }
  const targets = root.querySelectorAll<HTMLElement>(".chat-message[data-role], .chat-activity, .chat-call, .chat-tool-card, .chat-thinking, .chat-file-attachment, .agent-run, .agent-run-rail, .agent-run-detail-panel, .agent-run-process, .agent-run-timeline, .agent-run-result, .agent-run-receipt, .agent-run-waiting, .ask-user-question-group, .inline-terminal, .inline-diff, .inline-tool, .tool-preview, .chat-activity-detail-section, .chat-activity-thinking-content, .chat-activity-loading, .chat-activity-pending-detail, .tool-content-error, .tool-use-downgrade-chip, .ask-user-option-readonly, .unknown-block");
  for (const element of targets) {
    if (projections.has(element) || element.hidden || !element.isConnected) continue;
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
