import { Tooltip } from "antd";
import * as React from "react";
import { WandButton, WandIconButton, type WandButtonProps } from "./button";
import { usePortalContainer } from "./portal-context";
import { usePopupDismiss } from "./popup-lifecycle";

/** Preserve the button's ref and handlers when used as a popover trigger. */
export function WandHintButton({ hint, iconOnly, ...props }: WandButtonProps & { hint?: string; iconOnly?: boolean }) {
  const portal = usePortalContainer();
  const [open, setOpen] = React.useState(false);
  usePopupDismiss(open && !!hint, () => setOpen(false));
  const button = iconOnly ? <WandIconButton {...props}>{props.children}</WandIconButton> : <WandButton {...props}/>;
  return <Tooltip title={hint} open={!!hint && open} onOpenChange={setOpen} trigger={["hover", "focus"]}
    placement="right" getPopupContainer={() => portal ?? document.body}>
    {React.cloneElement(button, { title: undefined, onPointerDownCapture: (event: React.PointerEvent<HTMLButtonElement>) => {
      setOpen(false); props.onPointerDownCapture?.(event);
    } })}
  </Tooltip>;
}
