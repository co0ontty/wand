import { createContext, type ReactNode, useContext } from "react";

/** OverlayHost and shell-owned surfaces (task board dialogs/selects) share this root. */
export const REACT_UI_PORTALS_ID = "wand-react-ui-portals";

const PortalContainerContext = createContext<HTMLElement | null>(null);

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

function documentPortalContainer(): HTMLElement | undefined {
  if (typeof document === "undefined") return undefined;
  return document.getElementById(REACT_UI_PORTALS_ID) ?? undefined;
}

export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext) ?? documentPortalContainer();
}
