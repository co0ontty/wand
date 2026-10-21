/** Profile selection is shared by the eager sidebar and the lazy profile host. */
export type EmployeeProfileTarget = { id: string; name: string; avatar?: string; trigger: HTMLButtonElement | null };

let current: EmployeeProfileTarget | null = null;
const listeners = new Set<() => void>();

export const employeeProfile = {
  open(employee: { id: string; name: string; avatar?: string }, trigger: HTMLButtonElement | null): void {
    current = { ...employee, trigger }; listeners.forEach(listener => listener());
  },
  close(): void { current = null; listeners.forEach(listener => listener()); },
};

export const employeeProfileStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  getSnapshot(): EmployeeProfileTarget | null { return current; },
  getServerSnapshot(): EmployeeProfileTarget | null { return null; },
};
