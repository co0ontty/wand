import { useConversationActivity } from "../conversations/activity";
import { conversationForRun } from "../conversations/run-route";
import { conversationsRepository } from "../conversations/repository";
import { ChatMessage } from "../chat/message";
import { Alert, Flex, Spin } from "antd";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { DECISION_EXPERT_NAME } from "../../../decision-expert-identity.js";
import { AGENT_TOOL_OPTIONS } from "../../provider-identity";
import { failureMessage } from "../errors";
import { ComposerAttachmentList } from "../composer-attachments/host";
import { ComposerPopoverAction } from "../composer-popover/action";
import { RunningStatusBar } from "../chat/running-status-bar";
import { filePreviewController } from "../file-preview/controller";
import { MarkdownPreview } from "../file-preview/markdown";
import { formatFilePreviewSize } from "../file-preview/model";
import { HttpResponseError, jsonBody, requestJson } from "../http-adapter";
import { AgentFields } from "../issues/agent-fields";
import {
  createDefaultIssueAgent,
  ISSUE_AGENT_DEFAULT_MODEL,
  issueAgentEffortLabel,
  issueAgentLabel,
  issueAgentProviderLabel,
  issueAgentProviderModelLine,
  ISSUE_AGENT_PROVIDERS,
  normalizeIssueModelCatalog,
} from "../issues/task-board-agent";
import { taskBoardController, taskBoardStore } from "../issues/task-board-controller";
import { taskBoardRepository } from "../issues/task-board-repository";
import type { TaskTeamRunPanelProps } from "../issues/team-run-panel";
import { subscribeWandModelCatalog, wandModelDisplayName } from "../model-catalog";
import { useWandModelCatalog } from "../use-model-catalog";
import { wandOverlay } from "../overlay-controller";
import { sortProviderOptions, useProviderUsage } from "../provider-usage";
import {
  SettingsActionButton,
  SettingsField,
  SettingsSaveBar,
  SettingsStatus,
  SettingsTextInput,
  SettingsToggle,
} from "../settings/fields";
import { SidebarToggleIcon } from "../shell/sidebar-toggle-icon";
import { installStyleSheet } from "../styles";
import {
  TeamDispatchActionButton,
  TeamDispatchRoster,
  dispatchStartBlockedReason,
  useTeamDispatchFlow,
} from "../team-dispatch/roster";
import { subscribeTaskChanges } from "../task-changes";
import { appendedConversationKeys, CONVERSATION_TAIL_PX, conversationClock, conversationDay, conversationMessageKey, joinsConversationBubble } from "../conversations/presentation";
import { conversationUi } from "../conversations/state";
import { currentUserAuthor, selfAuthorFor, userProfileStore, useUserProfile } from "../user-profile-repository";
import {
  WandBadge,
  WandBrandMark,
  WandBreadcrumb,
  WandButton,
  WandDialogSurface,
  WandDropdownMenu,
  WandDropdownMenuContent,
  WandDropdownMenuItem,
  WandDropdownMenuTrigger,
  WandIcon,
  WandIconButton,
  WandSearchField,
  WandSelect,
  WandStretchTabs,
} from "../ui";
import { MOTION_DWELL_FAILED_MS, MOTION_DWELL_SENT_MS, useReducedMotion } from "../ui/motion-tokens";
import {
  CAT_COATS, GeneratedAvatarGlyph, TeamAvatar, TeamAvatarStack, avatarFace, avatarFaceParts,
  generatedAvatarBackground, generatedAvatarFace, memberCoatIndex, PixelCat, shrinkAvatarImage,
} from "./avatar";
import { useSiliconEmployees, siliconEmployeesRepository, notifySiliconEmployeeDefinitionChanged } from "../agents/employee-repository.js";
import { employeeAvatarProvider, employeeCliLabel } from "../agents/employee-identity.js";
import { installEmployeeStyles } from "../agents/styles.js";
import { ProviderLogo } from "../provider-logo.js";
import { teamChatComposer } from "./composer-bridge";
import { aiTeamsRepository, subscribeAiTeamDefinitionChanges, subscribeAiTeamRunChanges } from "./repository";
import type { ConversationMessagesProps, TeamChatViewProps } from "./team-chat-view";
import type { TeamChatPageProps } from "./team-chat-page";
import type { AiTeamsPageProps } from "./teams-page";
import type { DecisionChainEditorProps } from "../settings/decision-chain-editor";

/**
 * 按需脚本 content/ai-teams.js 向主包借的模块。键是相对 src/web-ui/react 的模块路径，
 * 由 scripts/ai-teams-chunk.js 的 aiTeamsHostKey 生成；chunk 里新增 import 时要同步补这里，
 * tests/web-ui-ai-teams.test.ts 会逐个名字核对。
 */
const AI_TEAMS_HOST: Record<string, object> = {
  "conversations/activity": { useConversationActivity },
  "react": React,
  "react/jsx-runtime": jsxRuntime,
  "errors": { failureMessage },
  "team-dispatch/roster": {
    useTeamDispatchFlow, TeamDispatchRoster, TeamDispatchActionButton, dispatchStartBlockedReason,
  },
  "composer-attachments/host": { ComposerAttachmentList },
  "composer-popover/action": { ComposerPopoverAction },
  "chat/running-status-bar": { RunningStatusBar },
  "chat/message": { ChatMessage },
  "file-preview/controller": { filePreviewController },
  "file-preview/markdown": { MarkdownPreview },
  "file-preview/model": { formatFilePreviewSize },
  "http-adapter": { HttpResponseError, jsonBody, requestJson },
  "issues/agent-fields": { AgentFields },
  "issues/task-board-agent": {
    createDefaultIssueAgent,
    ISSUE_AGENT_DEFAULT_MODEL,
    issueAgentEffortLabel,
    issueAgentLabel,
    issueAgentProviderLabel,
    issueAgentProviderModelLine,
    ISSUE_AGENT_PROVIDERS,
    normalizeIssueModelCatalog,
  },
  "issues/task-board-controller": { taskBoardController, taskBoardStore },
  "issues/task-board-repository": { taskBoardRepository },
  "agents/employee-repository": { useSiliconEmployees, siliconEmployeesRepository, notifySiliconEmployeeDefinitionChanged },
  "agents/employee-identity": { employeeAvatarProvider, employeeCliLabel },
  "agents/styles": { installEmployeeStyles },
  "provider-logo": { ProviderLogo },
  "model-catalog": { subscribeWandModelCatalog, wandModelDisplayName },
  "use-model-catalog": { useWandModelCatalog },
  "overlay-controller": { wandOverlay },
  "provider-usage": { sortProviderOptions, useProviderUsage },
  "settings/fields": {
    SettingsActionButton,
    SettingsField,
    SettingsSaveBar,
    SettingsStatus,
    SettingsTextInput,
    SettingsToggle,
  },
  "shell/sidebar-toggle-icon": { SidebarToggleIcon },
  "styles": { installStyleSheet },
  "task-changes": { subscribeTaskChanges },
  "conversations/state": { conversationUi },
  "conversations/repository": { conversationsRepository },
  "conversations/run-route": { conversationForRun },
  "conversations/presentation": { appendedConversationKeys, CONVERSATION_TAIL_PX, conversationClock, conversationDay, conversationMessageKey, joinsConversationBubble },
  "user-profile-repository": { currentUserAuthor, selfAuthorFor, userProfileStore, useUserProfile },
  "ui": {
    WandBadge, WandBrandMark, WandBreadcrumb, WandButton, WandDialogSurface,
    WandDropdownMenu, WandDropdownMenuContent, WandDropdownMenuItem, WandDropdownMenuTrigger,
    WandIcon, WandIconButton, WandSearchField, WandSelect, WandStretchTabs,
  },
  "ui/motion-tokens": { MOTION_DWELL_FAILED_MS, MOTION_DWELL_SENT_MS, useReducedMotion },
  "ai-teams/cat-coats": { CAT_COATS },
  "ai-teams/avatar": {
    CAT_COATS, GeneratedAvatarGlyph, TeamAvatar, TeamAvatarStack, avatarFace, avatarFaceParts,
    memberCoatIndex, PixelCat, generatedAvatarBackground, generatedAvatarFace, shrinkAvatarImage,
  },
  "ai-teams/composer-bridge": { teamChatComposer },
  "ai-teams/repository": { aiTeamsRepository, subscribeAiTeamDefinitionChanges, subscribeAiTeamRunChanges },
};

interface AiTeamsChunk {
  DecisionChainEditor: React.ComponentType<DecisionChainEditorProps>;
  AiTeamsPage: React.ComponentType<AiTeamsPageProps>;
  TaskTeamRunPanel: React.ComponentType<TaskTeamRunPanelProps>;
  TeamChatView: React.ComponentType<TeamChatViewProps>;
  ConversationMessages: React.ComponentType<ConversationMessagesProps>;
  chatAttachmentPrompt(files: readonly { savedPath: string }[], text: string): string;
  TeamChatPage: React.ComponentType<TeamChatPageProps>;
}

type ChunkGlobals = typeof globalThis & {
  __wandAiTeamsHost?: (key: string) => object;
  __wandAiTeamsChunk?: AiTeamsChunk;
};

let loaded: AiTeamsChunk | null = null;
let pending: Promise<AiTeamsChunk> | null = null;

/** 带内容 hash 的地址：服务端 getScriptContent 与 configPath 一样在下发时替换占位符。 */
const AI_TEAMS_CHUNK_SRC = "${aiTeamsChunkSrc}";

function loadAiTeamsChunk(): Promise<AiTeamsChunk> {
  if (loaded) return Promise.resolve(loaded);
  if (pending) return pending;
  const globals = globalThis as ChunkGlobals;
  globals.__wandAiTeamsHost = (key) => {
    const mod = AI_TEAMS_HOST[key];
    if (!mod) throw new Error(`AI 团队脚本要的模块 ${key} 不在主包注册表里`);
    return mod;
  };
  pending = new Promise<AiTeamsChunk>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = AI_TEAMS_CHUNK_SRC;
    script.async = true;
    script.onload = () => {
      const chunk = globals.__wandAiTeamsChunk;
      if (chunk) resolve(chunk);
      else reject(new Error("AI 团队脚本没有注册组件"));
    };
    script.onerror = () => {
      script.remove();
      reject(new Error("AI 团队脚本下载失败"));
    };
    document.head.appendChild(script);
  }).then((chunk) => {
    loaded = chunk;
    return chunk;
  }, (error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}

function useAiTeamsChunk(enabled = true): { chunk: AiTeamsChunk | null; error: string; retry: () => void } {
  const [chunk, setChunk] = React.useState<AiTeamsChunk | null>(loaded);
  const [error, setError] = React.useState("");
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    if (chunk || !enabled) return undefined;
    let alive = true;
    loadAiTeamsChunk().then(
      (next) => { if (alive) setChunk(next); },
      (reason: unknown) => { if (alive) setError(failureMessage(reason, "AI 团队加载失败")); },
    );
    return () => { alive = false; };
  }, [chunk, attempt, enabled]);
  const retry = React.useCallback(() => {
    setError("");
    setAttempt((value) => value + 1);
  }, []);
  return { chunk, error, retry };
}

/** The settings trigger is eager; candidate editing reuses the existing team chunk. */
export function DecisionChainEditor({ admin }: { admin: boolean }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const { chunk, error, retry } = useAiTeamsChunk(open);
  return <>
    <WandButton kind="secondary" onClick={() => setOpen(true)}>配置「决策专家」调用链</WandButton>
    {chunk ? <chunk.DecisionChainEditor admin={admin} open={open} onOpenChange={setOpen}
      providerOptions={AGENT_TOOL_OPTIONS.filter(option => option.engine !== "sdk").map(option => ({ value: option.provider, label: option.label }))}/>
      : <WandDialogSurface open={open} onOpenChange={setOpen} title={`${DECISION_EXPERT_NAME} · 调用链`}>
        {error ? <SettingsStatus tone="error">调用链编辑器加载失败。<WandButton kind="soft" onClick={retry}>重试</WandButton></SettingsStatus>
          : <div role="status" aria-busy="true"><Spin/>正在加载调用链编辑器…</div>}
      </WandDialogSurface>}
  </>;
}

/** 团队页：首次打开时拉取 ai-teams.js，期间显示占位，失败可重试。 */
export function AiTeamsPage(props: AiTeamsPageProps): React.ReactElement {
  const { chunk, error, retry } = useAiTeamsChunk();
  if (chunk) return <chunk.AiTeamsPage {...props}/>;
  return <Flex vertical gap={12} align="center" justify="center" component="section" style={{ height: "100%" }} className="task-board-native-page" aria-label="AI 团队" aria-busy={!error}>
    {error ? <>
      <Alert type="error" showIcon title={error}/>
      <WandButton kind="soft" size="small" onClick={retry}>重试</WandButton>
    </> : <><Spin/><span role="status">正在加载 AI 团队…</span></>}
  </Flex>;
}

/** 任务详情里的团队运行：脚本到位前不占位（没有运行时本来也不渲染）。 */
export function TaskTeamRunPanel(props: TaskTeamRunPanelProps): React.ReactElement | null {
  const { chunk } = useAiTeamsChunk();
  return chunk ? <chunk.TaskTeamRunPanel {...props}/> : null;
}

export async function formatConversationAttachments(files: readonly { savedPath: string }[], text: string): Promise<string> {
  return (await loadAiTeamsChunk()).chatAttachmentPrompt(files, text);
}

export function ConversationMessages(props: ConversationMessagesProps): React.ReactElement {
  const { chunk, error, retry } = useAiTeamsChunk(props.active !== false);
  if (chunk) return <chunk.ConversationMessages {...props}/>;
  if (props.active === false) return <></>;
  return <div className="conversation-messages-loading" role="status" style={{ minHeight: 144, display: "flex", alignItems: "center" }}>{error || "正在读取消息组件…"}{error ? <WandButton onClick={retry}>重试</WandButton> : null}</div>;
}

/** 群聊页：侧栏点群聊条目进入，脚本到位前显示占位，失败可重试。 */
export function TeamChatPage(props: TeamChatPageProps): React.ReactElement {
  const { chunk, error, retry } = useAiTeamsChunk();
  if (chunk) return <chunk.TeamChatPage {...props}/>;
  return <Flex vertical gap={12} align="center" justify="center" component="section" style={{ height: "100%" }} className="task-board-native-page" aria-label="群聊" aria-busy={!error}>
    {error ? <>
      <Alert type="error" showIcon title={error}/>
      <WandButton kind="soft" size="small" onClick={retry}>重试</WandButton>
    </> : <><Spin/><span role="status">正在加载群聊…</span></>}
  </Flex>;
}
