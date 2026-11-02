import * as React from "react";
import { createPortal } from "react-dom";
import { Flex, Typography } from "antd";
import type { WandTaskAgent } from "../../../task-types";
import { WandButton, WandPopover } from "../ui";
import { AgentFields } from "./agent-fields";
import { useWandModelCatalog } from "../use-model-catalog";
import { AGENT_TOOL_OPTIONS } from "../../provider-identity";

export interface TaskCommentEditorHandle {
  value: string; selectionStart: number; focus(options?: FocusOptions): void;
  setSelectionRange(start: number, end: number): void; contains(node: Node | null): boolean; getBoundingClientRect(): DOMRect;
}
/** One editor owns text, selection and IME; the mention token is an atomic view of its stable employee binding. */
export const TaskCommentEditor = React.forwardRef<TaskCommentEditorHandle, {
  popupOwner: string; value: string; employee?: { id: string; name: string; agents?: WandTaskAgent[] }; agent?: WandTaskAgent | null;
  disabled?: boolean; onAgent(value: WandTaskAgent | null): void;
  onChange(event: { currentTarget: { value: string; selectionStart: number } }): void;
  onSelect(event: { currentTarget: { selectionStart: number } }): void;
  onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void;
  "aria-expanded"?: boolean; "aria-controls"?: string; "aria-activedescendant"?: string;
}>(function TaskCommentEditor({ popupOwner, value, employee, agent, disabled, onAgent, onChange, onSelect, onKeyDown, ...aria }, ref) {
  const element = React.useRef<HTMLDivElement>(null), composing = React.useRef(false);
  const [mount, setMount] = React.useState<HTMLElement | null>(null);
  const [open, setOpen] = React.useState(false), [choice, setChoice] = React.useState<WandTaskAgent | null>(null);
  const catalog = useWandModelCatalog(open);
  const selected = agent ?? employee?.agents?.[0] ?? null;
  const read = (node: Node): string => {
    if (node instanceof HTMLElement && node.dataset.mentionText) return node.dataset.mentionText;
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node.nodeName === "BR") return "\n";
    return Array.from(node.childNodes).map(child => read(child)).join("");
  };
  const caret = (): number => {
    const root = element.current, selection = window.getSelection();
    if (!root || !selection?.rangeCount || !root.contains(selection.anchorNode)) return value.length;
    const range = selection.getRangeAt(0).cloneRange(); range.selectNodeContents(root);
    range.setEnd(selection.anchorNode!, selection.anchorOffset);
    return read(range.cloneContents()).length;
  };
  const place = (start: number, end = start): void => {
    const root = element.current; if (!root) return;
    const locate = (offset: number): [Node, number] => {
      let left = offset;
      const walk = (node: Node): [Node, number] | null => {
        if (node instanceof HTMLElement && node.dataset.mentionText) {
          const length = node.dataset.mentionText.length;
          if (left <= length) return [node.parentNode!, Array.from(node.parentNode!.childNodes).indexOf(node as ChildNode) + (left > 0 ? 1 : 0)];
          left -= length; return null;
        }
        if (node.nodeType === Node.TEXT_NODE) { const length = node.textContent?.length ?? 0; if (left <= length) return [node, left]; left -= length; return null; }
        for (const child of Array.from(node.childNodes)) { const found = walk(child); if (found) return found; }
        return null;
      };
      return walk(root) ?? [root, root.childNodes.length];
    };
    const range = document.createRange(); const a = locate(start), b = locate(end); range.setStart(...a); range.setEnd(...b);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  };
  React.useImperativeHandle(ref, () => ({ get value() { return element.current ? read(element.current) : value; }, get selectionStart() { return caret(); },
    focus: options => element.current?.focus(options), setSelectionRange: place,
    contains: node => element.current?.contains(node) ?? false, getBoundingClientRect: () => element.current!.getBoundingClientRect() }));
  React.useLayoutEffect(() => {
    const root = element.current; if (!root || composing.current) return;
    const token = employee ? `@${employee.name}` : "";
    const at = token ? value.indexOf(token) : -1;
    const expected = at >= 0;
    if (read(root) === value && Boolean(root.querySelector("[data-mention-text]")) === expected) return;
    const active = root.contains(document.activeElement) || document.activeElement === root;
    const position = active ? caret() : value.length;
    root.replaceChildren(); let next: HTMLElement | null = null;
    if (at >= 0) {
      root.append(document.createTextNode(value.slice(0, at)));
      next = document.createElement("span"); next.contentEditable = "false"; next.dataset.mentionText = token; root.append(next);
      root.append(document.createTextNode(value.slice(at + token.length)));
    } else root.textContent = value;
    setMount(next); if (active) place(position);
  }, [value, employee?.id, employee?.name]);
  const change = (): void => { if (!composing.current && element.current) onChange({ currentTarget: { value: read(element.current), selectionStart: caret() } }); };
  return <>
    <div {...aria} ref={element} className="task-comment-rich-editor" contentEditable={!disabled} suppressContentEditableWarning role="textbox" aria-label="任务评论输入" aria-multiline="true"
      data-placeholder="写评论；输入 @ 选择员工，输入 # 引用子任务" onInput={change}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; change(); }}
      onKeyUp={() => onSelect({ currentTarget: { selectionStart: caret() } })} onMouseUp={() => onSelect({ currentTarget: { selectionStart: caret() } })} onKeyDown={onKeyDown}
      onPaste={event => { event.preventDefault(); const text = event.clipboardData.getData("text/plain"); const selection = window.getSelection(); if (!selection?.rangeCount) return; const range = selection.getRangeAt(0); range.deleteContents(); const node = document.createTextNode(text); range.insertNode(node); range.setStartAfter(node); range.collapse(true); selection.removeAllRanges(); selection.addRange(range); change(); }}/>
    {mount && employee && createPortal(<WandPopover open={open} onOpenChange={next => { setOpen(next); if (next) setChoice(selected); }} side="top" align="start" popupOwner={popupOwner}
      ariaLabel="本次指派配置" trigger={<button type="button" className="task-comment-inline-mention" disabled={disabled}>@{employee.name}{agent ? ` · ${agent.provider} / ${agent.model}` : " · 员工默认"}</button>}>
      <div style={{ width: "min(340px, calc(100vw - 48px))" }}><Typography.Text strong>本次执行配置</Typography.Text>
        {choice ? <AgentFields agent={choice} catalog={catalog} providerOptions={AGENT_TOOL_OPTIONS.filter(option => option.engine === "cli").map(option => ({ value: option.id, label: option.label }))} ariaPrefix="评论指派" onChange={setChoice}/>
          : <Typography.Paragraph type="secondary">员工没有可用的默认配置，请先检查员工定义。</Typography.Paragraph>}
        <Flex gap="small" justify="end"><WandButton onClick={() => setOpen(false)}>取消</WandButton><WandButton onClick={() => { onAgent(null); setOpen(false); }}>恢复员工默认</WandButton><WandButton kind="primary" disabled={!choice} onClick={() => { onAgent(choice); setOpen(false); }}>应用</WandButton></Flex>
      </div>
    </WandPopover>, mount)}
  </>;
});
