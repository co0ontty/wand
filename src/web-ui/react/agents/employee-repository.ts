import * as React from "react";
import type { SiliconEmployee, SiliconEmployeeDraft } from "../../../ai-team-types.js";
import { jsonBody, requestJson } from "../http-adapter.js";

export type SiliconEmployeeInput = Pick<
  SiliconEmployee,
  "name" | "duty" | "prompt" | "avatar" | "agents" | "tags"
>;

type EmployeeListener = (employeeId: string) => void;
const employeeListeners = new Set<EmployeeListener>();
const employeeCacheListeners = new Set<() => void>();

let employeeList: SiliconEmployee[] | null = null;
let employeeListPending: Promise<SiliconEmployee[]> | null = null;
let employeeListVersion = 0;

export function invalidateEmployeeList(): void {
  employeeListVersion++;
  employeeList = null;
  employeeListPending = null;
  for (const listener of employeeCacheListeners) listener();
}

export function cachedSiliconEmployee(id: string): SiliconEmployee | null {
  return employeeList?.find((employee) => employee.id === id) ?? null;
}

export function subscribeSiliconEmployeeCache(listener: () => void): () => void {
  employeeCacheListeners.add(listener);
  return () => { employeeCacheListeners.delete(listener); };
}

export function notifySiliconEmployeeDefinitionChanged(employeeId: string): void {
  invalidateEmployeeList();
  for (const listener of employeeListeners) listener(employeeId);
}

export function subscribeSiliconEmployeeDefinitionChanges(listener: EmployeeListener): () => void {
  employeeListeners.add(listener);
  return () => {
    employeeListeners.delete(listener);
  };
}

export const siliconEmployeesRepository = {
  list(options?: { includeArchived?: boolean }): Promise<SiliconEmployee[]> {
    if (!options?.includeArchived && employeeList) return Promise.resolve(employeeList);
    if (!options?.includeArchived && employeeListPending) return employeeListPending;

    const query = options?.includeArchived ? "?includeArchived=1" : "";
    const version = employeeListVersion;
    const pending = requestJson<{ employees: SiliconEmployee[] }>(`/api/silicon-employees${query}`)
      .then((res) => {
        const list = res.employees ?? [];
        if (!options?.includeArchived && version === employeeListVersion) {
          employeeList = list;
          for (const listener of employeeCacheListeners) listener();
        }
        return list;
      })
      .finally(() => {
        if (!options?.includeArchived && employeeListPending === pending) {
          employeeListPending = null;
        }
      });

    if (!options?.includeArchived) {
      employeeListPending = pending;
    }
    return pending;
  },

  get(id: string): Promise<SiliconEmployee> {
    return requestJson<SiliconEmployee>(`/api/silicon-employees/${encodeURIComponent(id)}`);
  },

  /** 按自然语言期望起草一份配置；仅在用户点「创建员工」或「按期望生成」时调用。 */
  async draft(expectation: string): Promise<SiliconEmployeeDraft> {
    const response = await requestJson<{ draft: SiliconEmployeeDraft }>(
      "/api/silicon-employees/draft",
      jsonBody({ expectation }),
    );
    return response.draft;
  },

  async create(input: SiliconEmployeeInput): Promise<SiliconEmployee> {
    const employee = await requestJson<SiliconEmployee>("/api/silicon-employees", jsonBody(input));
    notifySiliconEmployeeDefinitionChanged(employee.id);
    return employee;
  },

  async update(id: string, input: SiliconEmployeeInput | Pick<SiliconEmployee, "agents">): Promise<SiliconEmployee> {
    const employee = await requestJson<SiliconEmployee>(
      `/api/silicon-employees/${encodeURIComponent(id)}`,
      jsonBody(input, "PUT"),
    );
    notifySiliconEmployeeDefinitionChanged(employee.id);
    return employee;
  },

  async archive(id: string): Promise<void> {
    await requestJson(`/api/silicon-employees/${encodeURIComponent(id)}/archive`, { method: "POST" });
    notifySiliconEmployeeDefinitionChanged(id);
  },

  async unarchive(id: string): Promise<void> {
    await requestJson(`/api/silicon-employees/${encodeURIComponent(id)}/unarchive`, { method: "POST" });
    notifySiliconEmployeeDefinitionChanged(id);
  },

  async remove(id: string): Promise<void> {
    await requestJson(`/api/silicon-employees/${encodeURIComponent(id)}`, { method: "DELETE" });
    notifySiliconEmployeeDefinitionChanged(id);
  },
};

export function useSiliconEmployees(options?: { includeArchived?: boolean; enabled?: boolean }): {
  employees: SiliconEmployee[];
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [employees, setEmployees] = React.useState<SiliconEmployee[]>(() => (!options?.includeArchived && employeeList) || []);
  const enabled = options?.enabled !== false;
  const [loading, setLoading] = React.useState<boolean>(() => enabled && !(!options?.includeArchived && employeeList));
  const [error, setError] = React.useState<string | null>(null);
  const active = React.useRef(false);
  const enabledRef = React.useRef(enabled);
  const generation = React.useRef(0);
  enabledRef.current = enabled;

  const load = React.useCallback(() => {
    if (!active.current || !enabledRef.current) return;
    const request = ++generation.current;
    const current = (): boolean => active.current && enabledRef.current && generation.current === request;
    setLoading(true);
    siliconEmployeesRepository
      .list({ includeArchived: options?.includeArchived })
      .then((list) => {
        if (!current()) return;
        setEmployees(list);
        setError(null);
      })
      .catch((err) => {
        if (current()) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
  }, [options?.includeArchived]);

  React.useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return undefined;
    }
    active.current = true;
    load();
    const unsubscribe = subscribeSiliconEmployeeDefinitionChanges(load);
    return () => {
      active.current = false;
      generation.current++;
      unsubscribe();
    };
  }, [load, enabled]);

  return { employees, loading, error, reload: load };
}
