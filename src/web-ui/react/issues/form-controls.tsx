import * as React from "react";
import { DatePicker, Form, Input } from "antd";
import type { TextAreaRef } from "antd/es/input/TextArea";
import { usePopupDismiss } from "../ui/popup-lifecycle";
import dayjs from "dayjs";

/** Keep the native textarea ref used by selection, autofocus and submit shortcuts. */
export const TaskTextArea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function TaskTextArea(props, ref) {
  const bind = React.useCallback((instance: TextAreaRef | null) => {
    const textarea = instance?.resizableTextArea?.textArea ?? null;
    if (typeof ref === "function") ref(textarea);
    else if (ref) ref.current = textarea;
  }, [ref]);
  return <Input.TextArea {...props} ref={bind}/>;
});

/** Form owns library layout; feature controllers retain native submit and draft ownership. */
export function TaskForm(props: React.FormHTMLAttributes<HTMLFormElement>): React.ReactElement {
  return <Form component={false} layout="vertical"><form {...props} noValidate/></Form>;
}

/** Date-only values never pass through a Date/UTC conversion. */
export function TaskDatePicker({ value, onValueChange, ariaLabel, popupOwner, disabled, className }: {
  value: string; onValueChange(value: string): void; ariaLabel: string;
  popupOwner?: string; disabled?: boolean; className?: string;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const picker = React.useRef<React.ComponentRef<typeof DatePicker>>(null);
  usePopupDismiss(open, () => { setOpen(false); picker.current?.focus(); });
  return <DatePicker ref={picker} open={open} onOpenChange={setOpen}
    value={value ? dayjs(value) : null} format="YYYY-MM-DD"
    aria-label={ariaLabel} disabled={disabled} className={className}
    onChange={(date) => onValueChange(date ? date.format("YYYY-MM-DD") : "")}
    panelRender={(panel) => <div data-wand-popup-owner={popupOwner}>{panel}</div>}/>;
}
