import { Tooltip } from "antd";
import * as React from "react";
import { usePortalContainer } from "../ui/portal-context";
import { usePopupDismiss } from "../ui/popup-lifecycle";

/** Full names share the row's existing hover/focus target; no extra tab stop or layout box. */
export function SidebarLabelTooltip({ title, selector, children }: {
  title: string;
  selector: string;
  children: React.ReactElement<React.ComponentPropsWithRef<"button">>;
}): React.ReactElement {
  const trigger = React.useRef<HTMLButtonElement>(null);
  const portal = usePortalContainer();
  const [open, setOpen] = React.useState(false);
  usePopupDismiss(open, () => setOpen(false));
  return <Tooltip title={title} open={open} trigger={["hover", "focus"]} placement="bottom"
    align={{ overflow: { adjustX: true, adjustY: true, shiftX: true, shiftY: true } }}
    getPopupContainer={() => portal ?? document.body}
    onOpenChange={next => {
      const label = trigger.current?.querySelector<HTMLElement>(selector);
      setOpen(next && !!label && label.scrollWidth > label.clientWidth);
    }}>
    {React.cloneElement(children, {
      ref: trigger,
      title: undefined,
      onPointerDownCapture: event => { setOpen(false); children.props.onPointerDownCapture?.(event); },
      onContextMenuCapture: event => { setOpen(false); children.props.onContextMenuCapture?.(event); },
      onKeyDownCapture: event => {
        if (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) setOpen(false);
        children.props.onKeyDownCapture?.(event);
      },
    })}
  </Tooltip>;
}
