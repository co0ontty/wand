import * as React from "react";
import { EmployeeAvatarPicker } from "./employee-avatar.js";

/** 用户只是另一种展示身份；复用员工编辑器，以稳定 user ID 生成默认头像。 */
export function UserAvatarPicker(props: {
  avatar: string; name: string; disabled: boolean;
  onChange(avatar: string): void; onBusyChange?(busy: boolean): void;
}): React.ReactElement {
  return <EmployeeAvatarPicker {...props} employeeId="user"/>;
}
