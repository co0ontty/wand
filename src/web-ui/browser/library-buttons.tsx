import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { Button, Flex, Typography } from "antd";
import { WandUiProvider } from "../react/theme";
import { installStyleSheet } from "../react/styles";
import { WandIcon } from "../react/ui";

interface ButtonProjection { root: Root; key: string; source?: HTMLButtonElement; }
const roots = new Map<HTMLElement, ButtonProjection>();

/** Native input owns the phase; Ant owns the single icon/loading state. */
function PhaseButton({ attrs, source }: { attrs: Record<string, string>; source: HTMLButtonElement }): React.ReactElement {
  const ref = React.useRef<HTMLButtonElement>(null);
  const read = (button: HTMLButtonElement) => ({ phase: button.dataset.phase || "idle", queued: button.classList.contains("queue-mode"), disabled: button.disabled,
    label: button.getAttribute("aria-label") || undefined, title: button.title });
  const [snapshot, setSnapshot] = React.useState(() => read(source));
  React.useLayoutEffect(() => {
    const button = ref.current;
    if (!button) return;
    const sync = () => setSnapshot(previous => {
      const next = read(button);
      return previous.phase === next.phase && previous.queued === next.queued && previous.disabled === next.disabled
        && previous.label === next.label && previous.title === next.title ? previous : next;
    });
    const observer = new MutationObserver(() => flushSync(sync));
    observer.observe(button, { attributes: true, attributeFilter: ["data-phase", "class", "disabled", "aria-label", "title"] });
    sync();
    return () => observer.disconnect();
  }, []);
  return <Button {...attrs} ref={ref} htmlType="button" size="small" data-phase={snapshot.phase} aria-label={snapshot.label} title={snapshot.title}
    className={[...Array.from(source.classList).filter(name => name !== "queue-mode" && !name.startsWith("ant-btn")), snapshot.queued && "queue-mode"].filter(Boolean).join(" ")}
    type={snapshot.queued ? "default" : "primary"} danger={snapshot.phase === "running" || snapshot.phase === "failed"}
    disabled={snapshot.disabled} loading={snapshot.phase === "sending"}
    icon={snapshot.phase === "sending" ? undefined : <WandIcon name={snapshot.phase === "running" ? "stop" : snapshot.phase === "sent" ? "check" : "up"} size={15}/>}/>;
}

export function browserButtonKey(element: Element): string | null {
  const projection = roots.get(element as HTMLElement);
  if (projection) return projection.key;
  if (!element.matches("button[data-antd-control]")) return null;
  return JSON.stringify(["library-button", element.id || null,
    Array.from(element.classList).filter(name => !/^(is-|selected$|copied$)/.test(name)),
    element.getAttribute("data-action"), element.getAttribute("data-tool-use-id"),
    element.getAttribute("data-question-index"), element.getAttribute("data-option-index"),
    element.getAttribute("data-agent-run-id"), element.getAttribute("data-agent-task-id"), element.getAttribute("onclick")]);
}
export function isBrowserButtonPair(current: Element, next: Element): boolean {
  return roots.has(current as HTMLElement) && next.matches("button[data-antd-control]");
}
function paint(host: HTMLElement, source: HTMLButtonElement, projection: ButtonProjection): void {
  const previous = host.querySelector("button");
  if (previous?.classList.contains("copied")) {
    source = source.cloneNode(true) as HTMLButtonElement;
    source.classList.add("copied");
    source.textContent = previous.textContent;
  }
  projection.source = source;
  const attrs: Record<string, string> = {};
  for (const attr of Array.from(source.attributes)) {
    if (!["class", "type", "data-antd-control", "style", "disabled"].includes(attr.name) && !attr.name.startsWith("on")) attrs[attr.name] = attr.value;
  }
  const nativeActions = Array.from(source.attributes).filter(attr => attr.name.startsWith("on"));
  if (source.id === "send-input-button") {
    flushSync(() => projection.root.render(<WandUiProvider><PhaseButton attrs={attrs} source={source}/></WandUiProvider>));
    return;
  }
  flushSync(() => projection.root.render(<WandUiProvider><Button {...attrs} htmlType="button" size="small"
    block={source.classList.contains("ask-user-option")}
    type={source.dataset.antdControl === "primary" || source.classList.contains("ask-user-option") && source.classList.contains("selected") ? "primary" : source.id === "todo-progress-toggle" ? "text" : "default"} disabled={source.disabled}
    className={source.className || undefined} ref={button => {
      if (!button) return;
      for (const action of nativeActions) button.setAttribute(action.name, action.value);
      if (source.hasAttribute("style")) button.style.cssText = source.style.cssText;
    }}>{source.classList.contains("ask-user-option") ? <Flex vertical gap="small" align="start">
      <Typography.Text strong>{source.dataset.optionLabel || source.querySelector(".ask-user-option-label")?.textContent}</Typography.Text>
      {source.querySelector(".ask-user-option-desc") && <Typography.Text type="secondary">{source.querySelector(".ask-user-option-desc")?.textContent}</Typography.Text>}
    </Flex> : source.classList.contains("prompt-optimize-btn")
      ? <Flex component="span" align="center" gap={4} dangerouslySetInnerHTML={{ __html: source.innerHTML }}/>
      : <span dangerouslySetInnerHTML={{ __html: source.innerHTML }}/>}</Button></WandUiProvider>));
}

/** Feedback is painted through the same Ant instance, preserving its native listeners. */
export function updateBrowserButtonLabel(button: HTMLElement, label: string, copied: boolean): void {
  const host = button.parentElement;
  const projection = host && roots.get(host);
  if (!host || !projection?.source) {
    button.textContent = label; button.classList.toggle("copied", copied); return;
  }
  button.classList.remove("copied");
  const source = projection.source.cloneNode(true) as HTMLButtonElement;
  source.textContent = label; source.classList.toggle("copied", copied);
  paint(host, source, projection);
}

/** Native delegates retain the exact Ant button through streaming updates. */
export function patchBrowserButton(current: Element, next: Element): boolean {
  const projection = roots.get(current as HTMLElement);
  if (!projection || !next.matches("button[data-antd-control]")) return false;
  paint(current as HTMLElement, next as HTMLButtonElement, projection);
  return true;
}

/** Replace generated ordinary buttons before native delegates bind. IDs and owned glyphs stay stable. */
export function mountBrowserButtons(container: ParentNode): void {
  installStyleSheet("wand-browser-control-motion", `
    /* These actions carry business summaries, not a one-line button label. */
    .ant-btn.agent-run-summary, .ant-btn.agent-run-agent, .ant-btn.ask-user-option { height:auto; white-space:normal; }
    .ant-btn.agent-run-summary > span:not([class]), .ant-btn.agent-run-agent > span:not([class]) { display:flex; align-items:center; gap:8px; width:100%; min-width:0; }
    .ant-btn.code-copy { width:80px; flex-shrink:0; }
  `);
  for (const [host, projection] of roots) if (!host.isConnected) { projection.root.unmount(); roots.delete(host); }
  container.querySelectorAll<HTMLButtonElement>("button[data-antd-control]").forEach(source => {
    const host = document.createElement("span"); host.style.display = "contents";
    const projection = { root: createRoot(host), key: browserButtonKey(source)! };
    source.replaceWith(host); roots.set(host, projection);
    paint(host, source, projection);
  });
}
