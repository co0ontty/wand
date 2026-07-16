import { createContext, type ReactNode, useContext } from "react";

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

export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext) ?? undefined;
}
