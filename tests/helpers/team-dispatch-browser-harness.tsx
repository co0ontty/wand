import * as React from "react";
import { createRoot } from "react-dom/client";
import { TeamDispatchPanel, TeamDispatchTrigger } from "../../src/web-ui/react/ai-teams/team-dispatch.js";
import {
  TeamDispatchActionButton,
  TeamDispatchRoster,
  dispatchStartBlockedReason,
  useTeamDispatchFlow,
} from "../../src/web-ui/react/team-dispatch/roster.js";
import { aiTeamsChunkStyles } from "../../src/web-ui/react/ai-teams/styles.js";
import { installReactUiStyles, installStyleSheet } from "../../src/web-ui/react/styles.js";
import type { IssueWorkspace } from "../../src/web-ui/react/issues/task-board-agent.js";

installReactUiStyles();
installStyleSheet("team-dispatch-harness", aiTeamsChunkStyles);

// 复刻按需脚本的宿主注册表：chunk 面板通过它借主包的派工共享模块。
(globalThis as { __wandAiTeamsHost?: (key: string) => unknown }).__wandAiTeamsHost = (key: string) => (
  key === "team-dispatch/roster"
    ? { useTeamDispatchFlow, TeamDispatchRoster, TeamDispatchActionButton, dispatchStartBlockedReason }
    : undefined
);

const projects = [
  { id: "w1", name: "端到端项目", cwd: "/tmp/project", kind: "project" },
  { id: "g", name: "全局暂存", cwd: "/tmp", kind: "global" },
] as unknown as IssueWorkspace[];

function Harness(): React.ReactElement {
  const [started, setStarted] = React.useState<unknown>(null);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  return <>
    <header id="bar">
      <button id="outside">面板外按钮</button>
      <TeamDispatchTrigger open={open} busy={busy} onToggle={() => setOpen((current) => !current)}/>
    </header>
    <TeamDispatchPanel
      open={open}
      onOpenChange={setOpen}
      onBusyChange={setBusy}
      projects={projects}
      projectsLoaded
      onStarted={(value) => {
        setStarted(value);
        (window as unknown as { startedRun?: unknown }).startedRun = value;
      }}
    />
    <div id="started">{started ? "已开工" : ""}</div>
  </>;
}

createRoot(document.getElementById("root")!).render(<Harness/>);
