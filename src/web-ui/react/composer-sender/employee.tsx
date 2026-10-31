import * as React from "react";
import { EmployeeAvatar } from "../agents/employee-avatar.js";
import { WandIconButton, type WandIconButtonProps } from "../ui/button.js";

export interface ComposerEmployeeIdentity { id: string; name: string; avatar?: string; }

/** The actual selected employee sits immediately before the execution tool. */
export function ComposerEmployeeButton({ employee, ...props }: {
  employee: ComposerEmployeeIdentity;
} & Omit<WandIconButtonProps, "children">): React.ReactElement {
  return <WandIconButton {...props} className={`composer-employee-trigger ${props.className ?? ""}`}
    aria-label={props["aria-label"] ?? `查看${employee.name}的资料`} title={props.title ?? employee.name}>
    <EmployeeAvatar employee={employee} provider="" size="toolbar" renderMode="static"/>
  </WandIconButton>;
}
