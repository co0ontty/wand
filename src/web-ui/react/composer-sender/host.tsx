import * as React from "react";
import { Sender } from "@ant-design/x";
import { createPortal } from "react-dom";
import { useEditorExpansion } from "./editor-expansion.js";
import { FilePathSuggestions } from "../file-path-suggestions.js";
import { ComposerAttachmentList } from "../composer-attachments/host.js";

export type ResizeInput = (input: HTMLTextAreaElement) => void;
export interface SenderProjectionAttachment {
  readonly name: string;
  readonly size: number;
  readonly previewUrl?: string | null;
}
export interface SenderProjection {
  subscribe(listener: () => void): () => void;
  revision(): number;
  text(): string;
  cwd?(): string;
  identity?(): string;
  isComposing(): boolean;
  attachments?(): readonly SenderProjectionAttachment[];
  addAttachment?(file: File): void;
  removeAttachment?(index: number): void;
}
function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
const InputContext = React.createContext<{ input: HTMLTextAreaElement; resize: ResizeInput; projection: SenderProjection } | null>(null);

/** Sender's input slot adopts the existing textarea so native IME/paste/focus listeners stay attached. */
const ComposerInput = React.forwardRef<any, any>((props, ref) => {
  const { input, resize, projection } = React.useContext(InputContext)!;
  const slot = React.useRef<HTMLDivElement>(null);
  React.useImperativeHandle(ref, () => ({ resizableTextArea: { textArea: input },
    focus: (options?: FocusOptions) => input.focus(options), blur: () => input.blur() }), [input]);
  React.useLayoutEffect(() => {
    if (slot.current && input.parentElement !== slot.current) {
      const active = document.activeElement === input;
      const start = input.selectionStart, end = input.selectionEnd;
      const parent = slot.current as HTMLElement & { moveBefore?(node: Node, child: Node | null): void };
      if (parent.moveBefore) parent.moveBefore(input, null);
      else { parent.appendChild(input); if (active) { input.focus({ preventScroll: true }); input.setSelectionRange(start, end); } }
    }
    input.classList.add("input-textarea", ...String(props.className || "").split(/\s+/).filter(Boolean));
    // The native input handler already sizes user edits. Only an external
    // projection (restore/clear/transform) needs another layout measurement.
    if (input.value !== props.value && !projection.isComposing()) {
      input.value = props.value || "";
      resize(input);
    }
  }, [input, props.value, props.className, resize]);
  // This adopted node keeps its native paste listener; never invoke Sender’s
  // onPasteFile as a second owner for the same bubbling clipboard event.
  return <div ref={slot} style={{ display: "contents" }}/>;
});
const components = { input: ComposerInput };

/** Controlled projection only; the original native handlers own every edit and submit callback. */
export function ComposerSender({ input, resize, projection, structured = true }: { input: HTMLTextAreaElement; resize: ResizeInput; projection: SenderProjection; structured?: boolean }): React.ReactElement {
  React.useSyncExternalStore(projection.subscribe, projection.revision, () => 0);
  const editor = useEditorExpansion(input.dataset.sessionId ?? "workspace", () => input);
  React.useLayoutEffect(() => {
    const wrapper = input.closest<HTMLElement>(".composer-input-wrap");
    if (!wrapper) return;
    wrapper.dataset.editorExpanded = String(editor.expanded); resize(input);
    return () => { delete wrapper.dataset.editorExpanded; };
  }, [input, resize, editor.expanded]);
  const controls = document.querySelector("#composer-plus-popover [data-composer-editor-control]");
  const attachments = projection.attachments?.() ?? [];
  const header = attachments.length ? (
    <ComposerAttachmentList
      items={attachments.map((item, index) => ({
        index,
        name: item.name,
        sizeLabel: formatBytes(item.size),
        size: item.size,
        previewUrl: item.previewUrl ?? null,
      }))}
      onRemove={index => projection.removeAttachment?.(index)}
    />
  ) : null;
  if (!structured) return <InputContext.Provider value={{ input, resize, projection }}><FilePathSuggestions cwd={projection.cwd?.()} identity={projection.identity?.()} terminal><ComposerInput value={projection.text()} className="" /></FilePathSuggestions></InputContext.Provider>;
  return <InputContext.Provider value={{ input, resize, projection }}><FilePathSuggestions cwd={projection.cwd?.()} identity={projection.identity?.()}><Sender value={projection.text()}
    placeholder={input.placeholder} components={components} suffix={false} autoSize={false} onKeyDown={() => false}
    header={header}
    styles={{ root: { border: 0, boxShadow: "none", borderRadius: 0, background: "transparent" }, content: { padding: 0 } }}/></FilePathSuggestions>{controls ? createPortal(editor.control, controls) : null}</InputContext.Provider>;
}
