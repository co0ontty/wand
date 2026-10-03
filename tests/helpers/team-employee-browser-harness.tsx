import * as React from "react";
import { createRoot } from "react-dom/client";
import type { AiTeam } from "../../src/ai-team-types.js";
import type { WandTaskAgent } from "../../src/task-types.js";
import { notifySiliconEmployeeDefinitionChanged } from "../../src/web-ui/react/agents/employee-repository.js";
import { TeamEditor } from "../../src/web-ui/react/ai-teams/teams-page.js";
import { aiTeamsChunkStyles } from "../../src/web-ui/react/ai-teams/styles.js";
import { installReactUiStyles, installStyleSheet } from "../../src/web-ui/react/styles.js";

installReactUiStyles();
installStyleSheet("employee-invite-harness", aiTeamsChunkStyles);
const agent: WandTaskAgent = { provider: "codex", model: "default", mode: "default", thinkingEffort: "default", kind: "structured" };
const team: AiTeam = { id: "t_fixture", name: "原团队", description: "", instructions: "保留协作草稿",
  maxSteps: 30, requirePlanApproval: true, createdAt: "", updatedAt: "", members: [
    { id: "m_leader", employeeId: new URLSearchParams(location.search).has("missing") ? "e_missing" : "e_one",
      name: "旧员工快照", avatar: "cat:0", duty: "负责验收", role: "verify", isLeader: true, agents: [agent], agent },
    { id: "m_manual", name: "手工成员", duty: "实现", isLeader: false, agents: [agent], agent },
  ] };
function Harness(): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(false);
  return <>
    <button id="mount-editor" onClick={() => setOpen(true)}>编辑团队</button>
    <button id="outside">表单外按钮</button>
    <button id="show-runs" onClick={() => setActive(false)}>运行记录</button>
    <button id="show-members" onClick={() => setActive(true)}>成员与设置</button>
    <button id="notify-employee" onClick={() => notifySiliconEmployeeDefinitionChanged("e_one")}>员工资料变更</button>
    {open ? <div hidden={!active} inert={!active}><TeamEditor active={active} team={team} initial={team} catalog={null} providerOptions={null}
      defaultAgent={agent} onSaved={(saved) => { (window as any).savedTeam = saved; }} onDeleted={() => {}}
      onDirtyChange={(dirty, pending) => { (window as any).draftState = { dirty, pending }; }}/></div>
      : null}
  </>;
}
createRoot(document.getElementById("root")!).render(<Harness/>);
