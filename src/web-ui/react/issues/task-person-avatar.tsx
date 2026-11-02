import * as React from "react";
import { Avatar } from "antd";
import { EmployeeAvatar } from "../agents/employee-avatar";
import { useSiliconEmployees } from "../agents/employee-repository";
import { ProviderLogo } from "../provider-logo";

/**
 * 任务详情里所有「人」的头像唯一出口：
 * - 员工：优先按稳定 id 取真实头像资料；评论只有作者名时才退回按名字匹配；
 * - 用户：固定「我」；团队/未知身份：首字兜底；纯工具执行：provider 图标。
 * 列表场景一律用静态渲染，避免每行一个常驻动画头像。
 */
export function TaskPersonAvatar({ id, name, avatar, provider, kind }: {
  id?: string; name: string; avatar?: string; provider?: string; kind?: "employee" | "team" | "user" | "tool";
}): React.ReactElement | null {
  const { employees } = useSiliconEmployees();
  if (kind === "user" || (!kind && !id && (name === "用户" || name === "我" || !name))) {
    return <Avatar size={24} shape="square" className="task-person-avatar is-user" aria-label="我">我</Avatar>;
  }
  const employee = kind === "team" || kind === "tool" ? undefined
    : (id ? employees.find(item => item.id === id) : undefined) ?? (name ? employees.find(item => item.name === name) : undefined);
  if (employee) return <EmployeeAvatar employee={employee} size="toolbar" renderMode="static" className="task-person-avatar"/>;
  if (id && kind !== "team" && kind !== "tool" && !provider) {
    return <EmployeeAvatar employee={{ id, name, avatar }} size="toolbar" renderMode="static" className="task-person-avatar"/>;
  }
  if (provider && kind !== "team") return <ProviderLogo provider={provider} className="task-board-agent-logo"/>;
  return <Avatar size={24} shape="square" className="task-person-avatar" aria-hidden="true">{name.trim().slice(0, 1) || "?"}</Avatar>;
}
