import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { failureMessage } from "../errors";
import { ComposerAttachmentList } from "../composer-attachments/host";
import { ComposerPopoverAction } from "../composer-popover/action";
import { filePreviewController } from "../file-preview/controller";
import { HttpResponseError, jsonBody, requestJson } from "../http-adapter";
import { AgentFields } from "../issues/agent-fields";
import {
  createDefaultIssueAgent,
  ISSUE_AGENT_DEFAULT_MODEL,
  issueAgentEffortLabel,
  issueAgentProviderLabel,
  issueAgentProviderModelLine,
  ISSUE_AGENT_PROVIDERS,
  normalizeIssueModelCatalog,
} from "../issues/task-board-agent";
import { taskBoardController } from "../issues/task-board-controller";
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
  SettingsTextInput,
  SettingsToggle,
} from "../settings/fields";
import { SidebarToggleIcon } from "../shell/sidebar-toggle-icon";
import { installStyleSheet } from "../styles";
import { WandBadge, WandBrandMark, WandBreadcrumb, WandButton, WandDialogSurface, WandIcon, WandIconButton, WandSearchField, WandSelect, WandStretchTabs } from "../ui";
import { MOTION_DWELL_FAILED_MS, MOTION_DWELL_SENT_MS } from "../ui/motion-tokens";
import { CAT_COATS, memberCoatIndex, PixelCat, shrinkAvatarImage, TeamAvatar, TeamAvatarStack } from "./avatar";
import { teamChatComposer } from "./composer-bridge";
import { aiTeamsRepository, subscribeAiTeamDefinitionChanges, subscribeAiTeamRunChanges } from "./repository";
import type { TeamChatViewProps } from "./team-chat-view";
import type { TeamChatPageProps } from "./team-chat-page";
import type { AiTeamsPageProps } from "./teams-page";

/**
 * 按需脚本 content/ai-teams.js 向主包借的模块。键是相对 src/web-ui/react 的模块路径，
 * 由 scripts/ai-teams-chunk.js 的 aiTeamsHostKey 生成；chunk 里新增 import 时要同步补这里，
 * tests/web-ui-ai-teams.test.ts 会逐个名字核对。
 */
const AI_TEAMS_HOST: Record<string, object> = {
  "react": React,
  "react/jsx-runtime": jsxRuntime,
  "errors": { failureMessage },
  "composer-attachments/host": { ComposerAttachmentList },
  "composer-popover/action": { ComposerPopoverAction },
  "file-preview/controller": { filePreviewController },
  "http-adapter": { HttpResponseError, jsonBody, requestJson },
  "issues/agent-fields": { AgentFields },
  "issues/task-board-agent": {
    createDefaultIssueAgent,
    ISSUE_AGENT_DEFAULT_MODEL,
    issueAgentEffortLabel,
    issueAgentProviderLabel,
    issueAgentProviderModelLine,
    ISSUE_AGENT_PROVIDERS,
    normalizeIssueModelCatalog,
  },
  "issues/task-board-controller": { taskBoardController },
  "issues/task-board-repository": { taskBoardRepository },
  "model-catalog": { subscribeWandModelCatalog, wandModelDisplayName },
  "use-model-catalog": { useWandModelCatalog },
  "overlay-controller": { wandOverlay },
  "provider-usage": { sortProviderOptions, useProviderUsage },
  "settings/fields": {
    SettingsActionButton,
    SettingsField,
    SettingsSaveBar,
    SettingsTextInput,
    SettingsToggle,
  },
  "shell/sidebar-toggle-icon": { SidebarToggleIcon },
  "styles": { installStyleSheet },
  "ui": { WandBadge, WandBrandMark, WandBreadcrumb, WandButton, WandDialogSurface, WandIcon, WandIconButton, WandSearchField, WandSelect, WandStretchTabs },
  "ui/motion-tokens": { MOTION_DWELL_FAILED_MS, MOTION_DWELL_SENT_MS },
  "ai-teams/avatar": { CAT_COATS, memberCoatIndex, PixelCat, shrinkAvatarImage, TeamAvatar, TeamAvatarStack },
  "ai-teams/composer-bridge": { teamChatComposer },
  "ai-teams/repository": { aiTeamsRepository, subscribeAiTeamDefinitionChanges, subscribeAiTeamRunChanges },
};

interface AiTeamsChunk {
  AiTeamsPage: React.ComponentType<AiTeamsPageProps>;
  TaskTeamRunPanel: React.ComponentType<TaskTeamRunPanelProps>;
  TeamChatView: React.ComponentType<TeamChatViewProps>;
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

function useAiTeamsChunk(): { chunk: AiTeamsChunk | null; error: string; retry: () => void } {
  const [chunk, setChunk] = React.useState<AiTeamsChunk | null>(loaded);
  const [error, setError] = React.useState("");
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    if (chunk) return undefined;
    let alive = true;
    loadAiTeamsChunk().then(
      (next) => { if (alive) setChunk(next); },
      (reason: unknown) => { if (alive) setError(failureMessage(reason, "AI 团队加载失败")); },
    );
    return () => { alive = false; };
  }, [chunk, attempt]);
  const retry = React.useCallback(() => {
    setError("");
    setAttempt((value) => value + 1);
  }, []);
  return { chunk, error, retry };
}

/** 团队页：首次打开时拉取 ai-teams.js，期间显示占位，失败可重试。 */
export function AiTeamsPage(props: AiTeamsPageProps): React.ReactElement {
  const { chunk, error, retry } = useAiTeamsChunk();
  if (chunk) return <chunk.AiTeamsPage {...props}/>;
  return <section className="task-board-native-page wand-teams-pending" aria-label="AI 团队" aria-busy={!error}>
    {error ? <>
      <p>{error}</p>
      <WandButton kind="soft" size="small" onClick={retry}>重试</WandButton>
    </> : <p>正在加载 AI 团队…</p>}
  </section>;
}

/** 任务详情里的团队运行：脚本到位前不占位（没有运行时本来也不渲染）。 */
export function TaskTeamRunPanel(props: TaskTeamRunPanelProps): React.ReactElement | null {
  const { chunk } = useAiTeamsChunk();
  return chunk ? <chunk.TaskTeamRunPanel {...props}/> : null;
}

/** 群聊页：侧栏点群聊条目进入，脚本到位前显示占位，失败可重试。 */
export function TeamChatPage(props: TeamChatPageProps): React.ReactElement {
  const { chunk, error, retry } = useAiTeamsChunk();
  if (chunk) return <chunk.TeamChatPage {...props}/>;
  return <section className="task-board-native-page wand-teams-pending" aria-label="群聊" aria-busy={!error}>
    {error ? <>
      <p>{error}</p>
      <WandButton kind="soft" size="small" onClick={retry}>重试</WandButton>
    </> : <p>正在加载群聊…</p>}
  </section>;
}
