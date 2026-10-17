import * as React from "react";
import { Form, Input } from "antd";
import type { TextAreaRef } from "antd/es/input/TextArea";

/** Keep the native textarea ref used by selection, autofocus and submit shortcuts. */
export const TaskTextArea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement> & { autoSize?: boolean | { minRows?: number; maxRows?: number } }>(function TaskTextArea(props, ref) {
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
