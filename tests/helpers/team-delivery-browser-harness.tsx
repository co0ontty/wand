// Synthetic component harness, not installed-service acceptance.
import * as React from "react";
import { createRoot } from "react-dom/client";
import type { AiTeamRunDetail } from "../../src/ai-team-types.js";
import { ComposerStore } from "../../src/web-ui/browser/composer.js";
import { configureTeamChatComposerRuntime } from "../../src/web-ui/react/ai-teams/composer-bridge.js";
import { mergeTeamChatDetail, TeamChatView } from "../../src/web-ui/react/ai-teams/team-chat-view.js";
import { TeamDeliveryCard } from "../../src/web-ui/react/ai-teams/team-delivery.js";
import { notifyAiTeamRunChanged } from "../../src/web-ui/react/ai-teams/repository.js";
import { TaskTeamRunPanel } from "../../src/web-ui/react/issues/team-run-panel.js";
import { TeamRuns } from "../../src/web-ui/react/ai-teams/teams-page.js";
import { FilePreviewHost } from "../../src/web-ui/react/file-preview/host.js";
import { installReactUiStyles, installStyleSheet } from "../../src/web-ui/react/styles.js";
import { aiTeamsChunkStyles } from "../../src/web-ui/react/ai-teams/styles.js";
import { teamDeliveryFixture } from "./team-delivery-fixture.js";

installReactUiStyles();
installStyleSheet("delivery-harness-styles", aiTeamsChunkStyles);
const composer = new ComposerStore({ storage: () => localStorage, isUnloading: () => false,
  disposeAttachment: () => {} });
configureTeamChatComposerRuntime({ read: (id) => composer.read(id), edit: (id, change) => composer.edit(id, change),
  subscribe: (listener) => composer.subscribe(listener), submit: (id, text, deliver) => composer.submit(id, text, deliver) });

function Harness(): React.ReactElement {
  const [detail, setDetail] = React.useState(teamDeliveryFixture());
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
    {runsOnly ? <div id="runs"><TeamRuns runs={[{ ...teamDeliveryFixture().run, taskTitle: "合成运行", taskIdentifier: "TEST-1" }]}/></div>
      : panelOnly ? <div id="panel"><TaskTeamRunPanel taskId={taskId}/></div> : <>
      <div id="card"><TeamDeliveryCard delivery={detail.delivery ?? teamDeliveryFixture().delivery!}/></div>
      <div id="chat" className="wand-team-chat-body"><TeamChatView detail={detail} onChange={setDetail}/></div>
    </>}
    <FilePreviewHost/>
  </>;
}
createRoot(document.getElementById("root")!).render(<Harness/>);
