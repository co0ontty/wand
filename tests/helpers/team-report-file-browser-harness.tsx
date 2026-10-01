import * as React from "react";
import { createRoot } from "react-dom/client";
import type { AiTeamRunDetail } from "../../src/ai-team-types";
import { installAiTeamComposerAdapter } from "../../src/web-ui/browser/ai-team-composer-adapter";
import { TeamChatView } from "../../src/web-ui/react/ai-teams/team-chat-view";
import { aiTeamsChunkStyles } from "../../src/web-ui/react/ai-teams/styles";
import { FilePreviewHost } from "../../src/web-ui/react/file-preview/host";
import { installReactUiStyles, installStyleSheet } from "../../src/web-ui/react/styles";

installReactUiStyles();
installStyleSheet("report-file-harness-styles", aiTeamsChunkStyles);
installAiTeamComposerAdapter();
const detail = {
  run: { id: "run-1", status: "done", chatSessionId: "chat-1", objective: "报告文件卡片验收",
    team: { id: "team", name: "测试团队", members: [] }, stepsUsed: 1, stepLimit: 8 },
  chatTurns: [{ role: "assistant", author: { id: "dev", name: "开发", sessionId: "member" },
    content: [{ type: "text", text: "✅ 完成「实现与验证」\n\n正文不应在消息中出现" }],
    reportFile: { stepId: "step-1", path: "/tmp/报告 & 结果.md", name: "报告 & 结果.md", size: 2048,
      preview: { title: "报告文件卡片 · 实现与验证",
        excerpt: "已完成报告文件投递，群聊保留标题与结论预览。\n完整内容在点击后加载，草稿和附件行为未改变。\n桌面与窄屏验证通过。" } } }],
  steps: [], memberStates: {},
} as unknown as AiTeamRunDetail;
function Harness(): React.ReactElement {
  return <><TeamChatView detail={detail} onChange={() => {}}/><FilePreviewHost/></>;
}
createRoot(document.getElementById("root")!).render(<Harness/>);
