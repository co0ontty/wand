import type { ReactElement } from "react";
import { WandIcon } from "../ui";

/** Rail icon while the drawer is closed; it turns into a close icon when open. */
export function SidebarToggleIcon({
  open,
  size = 18,
}: {
  open: boolean;
  size?: number;
}): ReactElement {
  return (
    <span className="sidebar-toggle-morph" data-open={open ? "true" : "false"} aria-hidden="true">
      <WandIcon name="rail" size={size} className="sidebar-toggle-morph-rail"/>
      <WandIcon name="close" size={size} className="sidebar-toggle-morph-close"/>
    </span>
  );
}
