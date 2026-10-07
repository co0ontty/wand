import * as React from "react";
import { Select } from "antd";
import { WandUiBoundary } from "../theme";
import { usePortalContainer } from "./portal-context";
import { usePopupDismiss } from "./popup-lifecycle";
import type { WandSelectOption } from "./select";

/** Multi-contact selection shares the same Portal ownership and dismissal protocol as WandSelect. */
export function WandMultiSelect({ value, options, onChange, ariaLabel, popupOwner, disabled }: {
  value: string[]; options: ReadonlyArray<WandSelectOption>; onChange(value: string[]): void;
  ariaLabel: string; popupOwner: string; disabled?: boolean;
}): React.ReactElement {
  const portal = usePortalContainer();
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<React.ComponentRef<typeof Select>>(null);
  usePopupDismiss(open, () => { setOpen(false); ref.current?.focus(); });
  return <WandUiBoundary><Select ref={ref} mode="multiple" showSearch={{ optionFilterProp: "label" }}
    aria-label={ariaLabel} placeholder={ariaLabel} value={value} options={options.slice()} onChange={onChange}
    disabled={disabled} open={open} onOpenChange={setOpen} style={{ width: "100%" }}
    getPopupContainer={() => portal ?? document.body}
    popupRender={menu => <div data-wand-popup-owner={popupOwner}>{menu}</div>}/></WandUiBoundary>;
}
