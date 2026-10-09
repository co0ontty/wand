import * as React from "react";
import { EmployeeAvatar } from "../agents/employee-avatar";

/** 侧栏头像只表达员工身份，不绑定某一种工具；上传损坏时回退到稳定的员工猫头像。 */
export function SidebarEmployeeAvatar({ employee }: {
  employee: React.ComponentProps<typeof EmployeeAvatar>["employee"];
}): React.ReactElement {
  const [failedAvatar, setFailedAvatar] = React.useState<string | null>(null);
  const avatar = employee.avatar === failedAvatar ? "" : employee.avatar;
  return <span className="sidebar-employee-avatar" onErrorCapture={(event) => {
    if (event.target instanceof HTMLImageElement) setFailedAvatar(employee.avatar ?? "");
  }}>
    <EmployeeAvatar employee={{ ...employee, avatar }} provider="" size="sm"/>
  </span>;
}
