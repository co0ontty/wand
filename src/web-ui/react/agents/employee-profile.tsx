import * as React from "react";
import type { SiliconEmployee } from "../../../ai-team-types.js";
import { employeeConversationId } from "../../../conversation-types.js";
import { conversationUi } from "../conversations/state";
import { ObjectProfilePanel } from "../shell/object-profile-panel";
import { siliconEmployeesRepository } from "./employee-repository";

type Profile = { id: string; name: string; avatar?: string; trigger: HTMLButtonElement | null };
let current: Profile | null = null;
const listeners = new Set<() => void>();
export const employeeProfile = {
  open(employee: { id: string; name: string; avatar?: string }, trigger: HTMLButtonElement | null): void {
    current = { ...employee, trigger }; listeners.forEach(listener => listener());
  },
  close(): void { current = null; listeners.forEach(listener => listener()); },
};
export function EmployeeProfileHost({ mobile }: { mobile: boolean }): React.ReactElement | null {
  const profile = React.useSyncExternalStore(React.useCallback(listener => {
    listeners.add(listener); return () => listeners.delete(listener);
  }, []), () => current, () => null);
  const last = React.useRef<Profile | null>(null);
  if (profile) last.current = profile;
  const displayed = profile ?? last.current;
  const [employee, setEmployee] = React.useState<SiliconEmployee | null>(null);
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [revision, reload] = React.useReducer(value => value + 1, 0);
  const trigger = React.useRef<HTMLButtonElement | null>(null);
  React.useEffect(() => {
    if (!profile) return;
    let active = true; trigger.current = profile.trigger;
    setEmployee(null); setError(""); setLoading(true);
    void siliconEmployeesRepository.get(profile.id).then(value => { if (active) setEmployee(value); })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "员工资料读取失败。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [profile, revision]);
  return displayed ? <ObjectProfilePanel key={displayed.id} open={!!profile} mobile={mobile} employee={employee}
    employeeSnapshot={displayed} loading={loading} error={error} onRetry={reload} triggerRef={trigger}
    onClose={employeeProfile.close} onMessage={() => { conversationUi.select(employeeConversationId(displayed.id), true); employeeProfile.close(); }}/>
    : null;
}
