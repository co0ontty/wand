import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { Collapse } from "antd";
import { WandUiProvider } from "../react/theme.js";
import { SubtaskPanel, type ChatSubtask } from "../react/chat/subtasks/panel.js";
import { patchChatContents } from "./chat-render-focus.js";
import { presentChat } from "../react/chat/presentation.js";
import { mountBrowserButtons } from "./library-buttons.js";
import { captureChatSubtaskReading, type ChatSubtaskReadingLease } from "./chat-subtask-layout.js";
import { installSubtaskStyles, SUBTASK_DISCLOSURE_STYLES } from "../react/chat/subtasks/styles.js";

export interface BrowserChatSubtask extends Omit<ChatSubtask, "detail"> { render(): string }
const islands = new Map<HTMLElement, { root: Root; sessionId: string; open(id?: string): void }>();
const boundOutputs = new WeakSet<HTMLElement>();
const preparedReading = new WeakMap<HTMLElement, ChatSubtaskReadingLease>();
function prepareReading(output: HTMLElement): void {
  const previous = preparedReading.get(output);
  if (previous?.active()) return;
  previous?.cancel();
  preparedReading.set(output, captureChatSubtaskReading(output));
}

/** Legacy DOM/data adaptation lives here; the panel never reaches into the chat or composer. */
export function openChatSubtasks(output: HTMLElement, id?: string): void { islands.get(output)?.open(id); }

export function paintChatSubtasks(output: HTMLElement, sessionId: string | null, tasks: BrowserChatSubtask[]): void {
  for (const [owner, island] of islands) if (!owner.isConnected || owner === output && !sessionId) {
    island.root.unmount(); owner.querySelector(":scope > .chat-subtasks-host")?.remove();
    owner.removeAttribute("data-subtasks-open"); islands.delete(owner);
  }
  if (!sessionId) return;
  installSubtaskStyles();
  let island = islands.get(output);
  if (!island) {
    const host = document.createElement("div"); host.className = "chat-subtasks-host"; output.prepend(host);
    island = { root: createRoot(host), sessionId, open() {} }; islands.set(output, island);
    host.addEventListener("click", event => event.stopPropagation());
  }
  if (!boundOutputs.has(output)) {
    boundOutputs.add(output);
    // Capture before the browser blurs/collapses the composer, not after the
    // resulting height transition has already moved its reading viewport.
    output.addEventListener("pointerdown", event => {
      if ((event.target as Element).closest('.chat-subtasks-trigger, [data-open-subtask], [aria-label="关闭子任务详情"]')) prepareReading(output);
    }, true);
    output.addEventListener("click", event => {
      const link = (event.target as Element).closest<HTMLElement>("[data-open-subtask]");
      if (link) { event.preventDefault(); openChatSubtasks(output, link.dataset.openSubtask); }
    });
  }
  island.sessionId = sessionId;
  const activeIsland = island;
  // 子 Agent 胶囊与待办、待发送同属输入框上方那排；宿主不在时退回阅读区自带工具栏。
  const triggerHost = document.getElementById("composer-agent-capsule-host");
  island.root.render(<WandUiProvider><SubtaskPanel key={sessionId} triggerHost={triggerHost}
    tasks={tasks.map(task => ({ ...task, detail: <SubtaskBody task={task}/> }))}
    registerOpen={open => { activeIsland.open = open; }}
    hasNestedPopup={() => Array.from(document.querySelectorAll<HTMLElement>('.ant-modal-wrap, .ant-select-dropdown:not(.ant-select-dropdown-hidden), [role="dialog"][aria-modal="true"]'))
      .some(node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden")}
    prepareOpenChange={() => prepareReading(output)}
    onOpenChange={open => {
      // Composer details float above their capsule; they never shrink the reading column.
      if (triggerHost) { output.dataset.subtasksOpen = "false"; return () => {}; }
      if ((output.dataset.subtasksOpen === "true") === open) {
        preparedReading.get(output)?.cancel(); preparedReading.delete(output);
        output.dataset.subtasksOpen = String(open);
        return () => {};
      }
      const reading = preparedReading.get(output) || captureChatSubtaskReading(output);
      preparedReading.delete(output);
      output.dataset.subtasksOpen = String(open);
      reading.restore();
      return reading.cancel;
    }}/></WandUiProvider>);
}

function SubtaskHtml({ html }: { html: string }): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const root = ref.current!;
    patchChatContents(root, html);
    mountBrowserButtons(root); presentChat(root);
  }, [html]);
  return <div ref={ref} className="chat-subtask-body"/>;
}

function SubtaskBody({ task }: { task: BrowserChatSubtask }): React.ReactElement {
  // Keep the canonical business renderers; Ant owns only the disclosure chrome.
  const template = document.createElement("template");
  template.innerHTML = task.render();
  const body = template.content.querySelector(".agent-run-agent-body")!;
  const result = body.querySelector(".agent-run-result");
  const receipt = body.querySelector(".agent-run-receipt");
  // The inspector disclosure already labels the result; keep its canonical body,
  // not a second "final result" heading nested inside another container.
  const resultHtml = result?.querySelector(".agent-run-result-content")?.outerHTML || result?.outerHTML || "";
  const diagnosticHtml = receipt?.outerHTML || "";
  result?.remove(); receipt?.remove();
  body.querySelector(".agent-run-waiting")?.remove();
  return <>
    {resultHtml ? <Collapse ghost bordered={false} styles={SUBTASK_DISCLOSURE_STYLES} defaultActiveKey={["result"]} destroyOnHidden={false}
      items={[{ key: "result", label: "结果", forceRender: true, children: <SubtaskHtml html={resultHtml}/> }]}/>
      : <p className="chat-subtasks-empty-result">尚未收到结果</p>}
    <SubtaskHtml html={body.innerHTML}/>
    <Collapse ghost bordered={false} styles={SUBTASK_DISCLOSURE_STYLES} className="chat-subtasks-secondary" destroyOnHidden={false} items={[
      { key: "instruction", label: "任务说明", forceRender: true, children: <p className="chat-subtasks-instruction">{task.instruction}</p> },
      ...(diagnosticHtml ? [{ key: "diagnostic", label: "诊断信息 · 派发回执", forceRender: true, children: <SubtaskHtml html={diagnosticHtml}/> }] : []),
    ]}/>
  </>;
}

