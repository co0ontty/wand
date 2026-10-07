// 按需脚本 content/ai-teams.js 的入口（scripts/ai-teams-chunk.js 打包）：装上团队页样式，
// 把组件交给主包的 lazy.tsx。共享模块全部经 globalThis.__wandAiTeamsHost 取自主包。
import { AiTeamsPage } from "./teams-page";
import { chatAttachmentPrompt, ConversationMessages, TeamChatView } from "./team-chat-view";
import { TeamChatPage } from "./team-chat-page";
import { aiTeamsChunkStyles } from "./styles";
import { TaskTeamRunPanel } from "../issues/team-run-panel";
import { installStyleSheet } from "../styles";

installStyleSheet("wand-ai-teams-styles", aiTeamsChunkStyles);

(globalThis as { __wandAiTeamsChunk?: unknown }).__wandAiTeamsChunk = {
  AiTeamsPage,
  TaskTeamRunPanel,
  TeamChatView,
  ConversationMessages,
  chatAttachmentPrompt,
  TeamChatPage,
};
