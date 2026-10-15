import * as React from "react";
import { EmployeeListPage } from "../ai-teams/lazy.js";
import { ISSUE_AGENT_PROVIDERS } from "../issues/task-board-agent.js";
import { useWandModelCatalog } from "../use-model-catalog.js";
import { useProviderUsage, sortProviderOptions } from "../provider-usage.js";
import { ProfileSettingsTab, type SettingsTabProps } from "./tabs.js";

/** 共用员工目录/详情；用户资料仍由 profile.save 保存，不进入员工执行配置。 */
export function EmployeesSettingsTab(props: SettingsTabProps): React.ReactElement {
  const catalog = useWandModelCatalog();
  const usage = useProviderUsage();
  const options = usage === null ? null : sortProviderOptions(ISSUE_AGENT_PROVIDERS, usage, entry => entry.value)
    .map(entry => ({ value: entry.value, label: entry.label }));
  return <EmployeeListPage catalog={catalog} providerOptions={options}
    renderSelf={callbacks => <ProfileSettingsTab {...props} {...callbacks}/>}/>;
}
