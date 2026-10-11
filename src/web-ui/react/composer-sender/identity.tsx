import * as React from "react";
import { EmployeeAvatar } from "../agents/employee-avatar.js";

/** Identity only: draft, focus and send ownership stay with the existing composer. */
export function ComposerIdentity({ employee, fileActivity = "idle" }: {
  employee: React.ComponentProps<typeof EmployeeAvatar>["employee"];
  fileActivity?: import("../../composer-avatar-activity.js").AvatarFileActivity;
}): React.ReactElement {
  return <span className="composer-floating-avatar" role="img" aria-label={`${employee.name}${fileActivity === "reading" ? "，正在查看文件" : fileActivity === "writing" ? "，正在编写文件" : ""}`} data-file-activity={fileActivity}>
    <EmployeeAvatar employee={employee} provider="" size="composer" fileActivity={fileActivity}/>
  </span>;
}
