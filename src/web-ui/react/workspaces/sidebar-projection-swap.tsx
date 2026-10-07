import * as React from "react";
import { installSidebarStyles } from "../shell/sidebar-styles";
import { useReducedMotion } from "../ui/motion-tokens";
import { SidebarPresentationContext, type SidebarPresentation } from "./sidebar-display-mode";

/** Both list sections change in the same place; the old projection is inert during exit. */
export function SidebarProjectionSwap({ value, children }: {
  value: string;
  children: React.ReactNode;
}): React.ReactElement {
  React.useLayoutEffect(() => { installSidebarStyles(); }, []);
  const scope = React.useContext(SidebarPresentationContext);
  const reduced = useReducedMotion();
  const previous = React.useRef({ value, children, scope });
  const [ghost, setGhost] = React.useState<{
    children: React.ReactNode;
    scope: SidebarPresentation | null;
  } | null>(null);
  const [entering, setEntering] = React.useState(false);
  React.useLayoutEffect(() => {
    let frame = 0;
    if (reduced) {
      setGhost(null);
      setEntering(false);
    } else if (previous.current.value !== value) {
      setGhost(previous.current);
      setEntering(true);
      frame = requestAnimationFrame(() => setEntering(false));
    }
    return () => cancelAnimationFrame(frame);
  }, [value, reduced]);
  React.useLayoutEffect(() => { previous.current = { value, children, scope }; });
  return <div className="sidebar-projection-swap" data-entering={entering}>
    <div className="sidebar-projection-current">{children}</div>
    {ghost ? <div className="sidebar-projection-old" aria-hidden="true" inert
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && event.propertyName === "opacity") setGhost(null);
      }}>
      <SidebarPresentationContext.Provider value={ghost.scope}>{ghost.children}</SidebarPresentationContext.Provider>
    </div> : null}
  </div>;
}
