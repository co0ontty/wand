import * as React from "react";
import { Tag } from "antd";
import {
  SYSTEM_EMPLOYEE_ID,
  SYSTEM_EMPLOYEE_NAME,
  SYSTEM_EMPLOYEE_TAG,
  type SiliconEmployee,
} from "../../../ai-team-types.js";
import { EmployeeAvatar } from "../agents/employee-avatar.js";
import { agentToolDisplayName } from "../../provider-identity.js";

/**
 * 设置页里「系统 AI」的执行者投影：Wand 自有 AI 调用由内置「系统运维」员工执行，
 * 这里只读展示它的候选链，候选与顺序在员工页维护。
 */
export function SystemAiOwnerSummary({
  employee,
}: {
  employee: SiliconEmployee | null;
}): React.ReactElement {
  const name = employee?.name ?? SYSTEM_EMPLOYEE_NAME;
  const agents = employee?.agents ?? [];
  return (
    <div className="wand-settings-library-system-ai-owner" aria-label="系统 AI 执行者">
      <EmployeeAvatar
        employee={employee ?? { id: SYSTEM_EMPLOYEE_ID, name: SYSTEM_EMPLOYEE_NAME, avatar: "" }}
        size="sm"
      />
      <div className="wand-settings-library-system-ai-owner-copy">
        <strong>
          {name}
          <Tag>{SYSTEM_EMPLOYEE_TAG}</Tag>
        </strong>
        <ol className="wand-settings-library-system-ai-chain" aria-label="执行候选顺序">
          {agents.length > 0 ? agents.map((agent, index) => (
            <li key={`${agent.provider}-${agent.model}-${index}`}>
              <span className="wand-settings-library-route-rank" aria-label={`优先 ${index + 1}`}>
                {String(index + 1).padStart(2, "0")}
              </span>
              {agentToolDisplayName(agent.provider, agent.engine)}
              {agent.model && agent.model !== "default" ? ` · ${agent.model}` : " · 默认模型"}
              {agent.engine === "sdk" ? <Tag>系统 AI 跳过</Tag> : null}
            </li>
          )) : <li className="wand-settings-library-system-ai-chain-empty">{employee ? "尚未配置执行候选，请到「团队 → 员工」添加。" : "正在读取执行候选…"}</li>}
        </ol>
        <span className="wand-settings-library-system-ai-hint">
          系统 AI 内部调用会跳过 SDK 候选；候选与顺序在「团队 → 员工」列表的「{name}」中调整。
        </span>
      </div>
    </div>
  );
}
