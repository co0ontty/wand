import * as React from "react";
import { EmployeeAvatar } from "../agents/employee-avatar";

/** A damaged upload falls back to the same stable employee cat, only in this sidebar. */
export function SidebarEmployeeAvatar({ employee }: {
  employee: React.ComponentProps<typeof EmployeeAvatar>["employee"];
}): React.ReactElement {
  const [failedAvatar, setFailedAvatar] = React.useState<string | null>(null);
  const avatar = employee.avatar === failedAvatar ? "" : employee.avatar;
  return <span className="sidebar-employee-avatar" onErrorCapture={(event) => {
    if (event.target instanceof HTMLImageElement) setFailedAvatar(employee.avatar ?? "");
  }}>
    <EmployeeAvatar employee={{ ...employee, avatar }} size="sm"/>
  </span>;
}
