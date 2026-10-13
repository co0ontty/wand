import * as React from "react";
import { DatePicker } from "antd";
import { usePopupDismiss } from "../ui/popup-lifecycle";
import dayjs from "dayjs";

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
