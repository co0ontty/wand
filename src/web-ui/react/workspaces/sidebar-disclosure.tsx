import * as React from "react";

export function useSidebarCollapsed(
  key: string,
  defaultCollapsed = false,
): [boolean, () => void, (collapsed: boolean) => void] {
  const storageKey = `wand.sidebar.${key}`;
  const [collapsed, setCollapsed] = React.useState(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      return saved === null ? defaultCollapsed : saved === "true";
    } catch {
      return defaultCollapsed;
    }
  });
  const update = React.useCallback((next: boolean): void => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(storageKey, String(next));
    } catch {
      return;
    }
  }, [storageKey]);
  return [collapsed, () => update(!collapsed), update];
}

export function SidebarDisclosure({
  id,
  open,
  children,
}: {
  id: string;
  open: boolean;
  children: React.ReactNode;
}) {
  return (
    <div id={id} className="sidebar-disclosure" data-open={open} inert={!open} aria-hidden={!open}>
      <div className="sidebar-disclosure-inner">{children}</div>
    </div>
  );
}
