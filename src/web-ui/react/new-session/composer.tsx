import * as React from "react";
import { Sender } from "@ant-design/x";
import { useImeGuard } from "../composer-sender/ime-guard";

export interface NewWorkComposerHandle { inputElement: HTMLTextAreaElement | null; }
export interface NewWorkComposerProps {
  text: string;
  onTextChange(text: string): void;
  onSubmit(): void;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  expanded?: boolean;
  footer?: React.ReactNode;
  header?: React.ReactNode;
  /** Files on the clipboard. Sender's own onPasteFile skips pastes that also carry text. */
  onPaste?: React.ClipboardEventHandler<HTMLElement>;
  children?: React.ReactNode;
}

/** Task plans and immediate work share one input, keyboard policy and visual surface. */
export const NewWorkComposer = React.forwardRef<NewWorkComposerHandle, NewWorkComposerProps>(function NewWorkComposer({
  text, onTextChange, onSubmit, disabled, placeholder, ariaLabel = "工作内容", expanded = false, footer, header, onPaste, children,
}, ref) {
  const sender = React.useRef<React.ComponentRef<typeof Sender>>(null);
  const ime = useImeGuard();
  React.useImperativeHandle(ref, () => ({ get inputElement() { return sender.current?.inputElement as HTMLTextAreaElement | null; } }), []);
  const submit = (): void => { if (!disabled && !ime.isComposing()) onSubmit(); };
  return <div className="conversation-input-wrap" data-composer-expanded="true" data-editor-expanded={expanded}
    onCompositionStartCapture={ime.onCompositionStart} onCompositionEndCapture={ime.onCompositionEnd}>
    {children}
    <Sender ref={sender} className="conversation-sender" value={text} readOnly={disabled} placeholder={placeholder}
      aria-label={ariaLabel} suffix={false} autoSize={{ minRows: 2, maxRows: expanded ? 24 : 10 }}
      onChange={onTextChange} onSubmit={submit} submitType="enter" header={header} footer={footer} onPaste={onPaste}
      onKeyDown={event => {
        if (ime.shouldIgnore(event)) return false;
        if (event.key !== "Enter") return undefined;
        // Modified Enter belongs to editing (Shift inserts a newline), never a second submit path.
        if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
        event.preventDefault();
        submit();
        return false;
      }}/>
  </div>;
});
