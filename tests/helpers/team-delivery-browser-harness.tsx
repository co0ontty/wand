// Synthetic component harness, not installed-service acceptance.
import * as React from "react";
import { createRoot } from "react-dom/client";
import type { AiTeamRunDetail } from "../../src/ai-team-types.js";
import { ComposerStore } from "../../src/web-ui/browser/composer.js";
import { configureTeamChatComposerRuntime } from "../../src/web-ui/react/ai-teams/composer-bridge.js";
import { mergeTeamChatDetail, TeamChatView } from "../../src/web-ui/react/ai-teams/team-chat-view.js";
import { TeamDeliveryCard } from "../../src/web-ui/react/ai-teams/team-delivery.js";
import { notifyAiTeamRunChanged } from "../../src/web-ui/react/ai-teams/repository.js";
import { TaskTeamRunPanel, TeamRunView } from "../../src/web-ui/react/issues/team-run-panel.js";
import { TeamRuns } from "../../src/web-ui/react/ai-teams/teams-page.js";
import { FilePreviewHost } from "../../src/web-ui/react/file-preview/host.js";
import { installReactUiStyles, installStyleSheet } from "../../src/web-ui/react/styles.js";
import { aiTeamsChunkStyles } from "../../src/web-ui/react/ai-teams/styles.js";
import { WandUiProvider } from "../../src/web-ui/react/theme.js";
import { teamDeliveryFixture } from "./team-delivery-fixture.js";

installReactUiStyles();
installStyleSheet("delivery-harness-styles", aiTeamsChunkStyles);
const composer = new ComposerStore({ storage: () => localStorage, isUnloading: () => false,
  disposeAttachment: () => {} });
configureTeamChatComposerRuntime({ read: (id) => composer.read(id), edit: (id, change) => composer.edit(id, change),
  subscribe: (listener) => composer.subscribe(listener), submit: (id, text, deliver) => composer.submit(id, text, deliver) });

function Harness(): React.ReactElement {
  const executionOnly = new URLSearchParams(location.search).has("execution");
  const [detail, setDetail] = React.useState(() => {
    const next = teamDeliveryFixture();
    if (!executionOnly) return next;
    const agent = { kind: "structured" as const, provider: "claude" as const, model: "default", thinkingEffort: "default" };
    next.run.team.members = [{ id: "m-a", name: "实现者", duty: "负责实现", agent, agents: [agent], isLeader: true, avatar: "cat:1" }];
    next.steps = [{ id: "step-live", runId: next.run.id, memberId: "m-a", seq: 1, kind: "work", title: "验证迁移后的步骤", instructions: "保留手动报告草稿与候选跳过原因", status: "running", dependsOn: [], reportPath: "/synthetic/report.md", report: "", sessionId: "step-session", startedAt: next.run.createdAt, endedAt: null,
      dispatchInfo: { usedCandidate: 2, skipped: [{ candidate: 1, agent, reason: "合成候选不可用", errorKind: "host-disabled" }] } }];
    return next;
  });
  const [taskId, setTaskId] = React.useState("task-a");
  const panelOnly = new URLSearchParams(location.search).has("panel");
  const runsOnly = new URLSearchParams(location.search).has("runs");
  (window as unknown as { deliveryHarness: object }).deliveryHarness = {
    setDetail: (next: AiTeamRunDetail) => setDetail((current) => mergeTeamChatDetail(current, next)),
    replaceDetail: setDetail,
    setTaskId,
    refresh: () => notifyAiTeamRunChanged({ taskId, runId: taskId === "task-a" ? "run-a" : "run-b" }),
  };
  return <>
    {executionOnly ? <div id="execution"><TeamRunView detail={detail} onChange={setDetail} onOpenSession={() => {}}/></div> : runsOnly ? <div id="runs"><TeamRuns runs={[{ ...teamDeliveryFixture().run, taskTitle: "合成运行", taskIdentifier: "TEST-1" }]}/></div>
      : panelOnly ? <div id="panel"><TaskTeamRunPanel taskId={taskId}/></div> : <>
      <div id="card"><TeamDeliveryCard delivery={detail.delivery ?? teamDeliveryFixture().delivery!}/></div>
      <div id="chat" className="wand-team-chat-body"><TeamChatView detail={detail} onChange={setDetail}/></div>
    </>}
    <FilePreviewHost/>
  </>;
}
createRoot(document.getElementById("root")!).render(<WandUiProvider><Harness/></WandUiProvider>);
