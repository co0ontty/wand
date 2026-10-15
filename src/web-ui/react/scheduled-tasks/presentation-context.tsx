import * as React from "react";

export interface ScheduledEmployeeIdentity { id: string; name: string; avatar?: string; systemKey?: string; }
interface Presentation {
  employees: readonly ScheduledEmployeeIdentity[];
  now: Date;
  timeZone: string;
}
const ScheduledPresentation = React.createContext<Presentation | null>(null);
export function ScheduledPresentationProvider({ children, ...value }: Presentation & { children: React.ReactNode }) {
  return <ScheduledPresentation.Provider value={value}>{children}</ScheduledPresentation.Provider>;
}
/** Presentation only. Drafts, permissions, reads and writes stay in the page/repository. */
export function useScheduledPresentation(): Presentation {
  const value = React.useContext(ScheduledPresentation);
  if (!value) throw new Error("Scheduled task presentation provider is missing");
  return value;
}
