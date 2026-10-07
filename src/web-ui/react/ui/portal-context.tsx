import { createContext, type ReactNode, useContext } from "react";
import * as React from "react";

/** OverlayHost and shell-owned surfaces (task board dialogs/selects) share this root. */
export const REACT_UI_PORTALS_ID = "wand-react-ui-portals";

const PortalContainerContext = createContext<HTMLElement | null>(null);
const PopupOwnerContext = createContext<string | null>(null);

/** Explicit nested ownership, independent of the DOM location of an Ant Portal. */
export function PopupOwnerProvider({ owner, children }: { owner: string; children: ReactNode }) {
  return <PopupOwnerContext.Provider value={owner}>{children}</PopupOwnerContext.Provider>;
}
export function useParentPopupOwner(): string | null { return useContext(PopupOwnerContext); }

interface PortalContainerProviderProps {
  container: HTMLElement;
  children: ReactNode;
}

export function PortalContainerProvider({ container, children }: PortalContainerProviderProps) {
  return (
    <PortalContainerContext.Provider value={container}>
      {children}
    </PortalContainerContext.Provider>
  );
}

export function documentPortalContainer(): HTMLElement | undefined {
  if (typeof document === "undefined") return undefined;
  return document.getElementById(REACT_UI_PORTALS_ID) ?? undefined;
}

export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext) ?? documentPortalContainer();
}
