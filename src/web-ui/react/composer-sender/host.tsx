import * as React from "react";
import { Sender } from "@ant-design/x";

export type ResizeInput = (input: HTMLTextAreaElement) => void;
export interface SenderProjection {
  subscribe(listener: () => void): () => void;
  revision(): number;
  text(): string;
  isComposing(): boolean;
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
    if (input.value !== props.value && !projection.isComposing()) input.value = props.value || "";
    resize(input);
  }, [input, props.value, props.className, resize]);
  return <div ref={slot} style={{ display: "contents" }}/>;
});
const components = { input: ComposerInput };

/** Controlled projection only; the original native handlers own every edit and submit callback. */
export function ComposerSender({ input, resize, projection }: { input: HTMLTextAreaElement; resize: ResizeInput; projection: SenderProjection }): React.ReactElement {
  React.useSyncExternalStore(projection.subscribe, projection.revision, () => 0);
  return <InputContext.Provider value={{ input, resize, projection }}><Sender value={projection.text()}
    placeholder={input.placeholder} components={components} suffix={false} autoSize={false} onKeyDown={() => false}
    styles={{ root: { border: 0, boxShadow: "none", borderRadius: 0, background: "transparent" }, content: { padding: 0 } }}/></InputContext.Provider>;
}
