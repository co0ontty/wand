import * as React from "react";
import { SidebarPresentationContext } from "./sidebar-display-mode";

/** A sidebar projection owns only its own portalled menus and confirmations. */
export const SidebarPopupOwnerContext = React.createContext<string | undefined>(undefined);
export const SidebarSurfacesContext = React.createContext(true);

/** Close portalled menus when their list leaves the screen or its filter changes. */
export function useSidebarPopupState(): [boolean, React.Dispatch<React.SetStateAction<boolean>>] {
  const enabled = React.useContext(SidebarSurfacesContext);
  const presentation = React.useContext(SidebarPresentationContext);
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => { setOpen(false); }, [enabled, presentation?.mode, presentation?.query]);
  return [enabled && open, setOpen];
}

export function useSidebarPopupOwner(): string | undefined {
  return React.useContext(SidebarPopupOwnerContext);
}
