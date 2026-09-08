import * as React from "react";

export function useSidebarCollapsed(key: string, defaultCollapsed = false): [boolean, () => void] {
  const storageKey = `wand.sidebar.${key}`;
  const [collapsed, setCollapsed] = React.useState(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      return saved === null ? defaultCollapsed : saved === "true";
    } catch {
      return defaultCollapsed;
    }
  });
  const toggle = (): void => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      window.localStorage.setItem(storageKey, String(next));
    } catch {
      return;
    }
  };
  return [collapsed, toggle];
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
