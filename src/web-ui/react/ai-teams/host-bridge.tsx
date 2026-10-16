import { composerRuntimePreference } from "../conversations/composer-presentation";
import { useConversationActivity } from "../conversations/activity";
import { conversationForRun } from "../conversations/run-route";
import { conversationsRepository } from "../conversations/repository";
import { ChatMessage } from "../chat/message";
import { ChatActivity } from "../chat/activity";
import { TurnNavPanel } from "../chat/navigation/TurnNavPanel.js";
import { buildTurnNavIndex, turnNavRange } from "../chat/navigation/turn-nav-model.js";
import { jumpToChatTurn } from "../chat/navigation/turn-jump.js";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { failureMessage } from "../errors";
import { ComposerAttachmentList } from "../composer-attachments/host";
import { ComposerPopoverAction } from "../composer-popover/action";
import { RunningStatusBar } from "../chat/running-status-bar";
import { filePreviewController } from "../file-preview/controller";
import { MarkdownPreview, MessageFileContext } from "../file-preview/markdown";
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
import { settingsController } from "../settings/controller";
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
  WandPopover,
  WandSearchField,
  WandSelect,
  WandStretchTabs,
} from "../ui";
import { MOTION_DWELL_FAILED_MS, MOTION_DWELL_SENT_MS, useReducedMotion } from "../ui/motion-tokens";
import {
  CAT_COATS, GeneratedAvatarGlyph, TeamAvatar, TeamAvatarStack, avatarFace, avatarFaceParts,
  generatedAvatarBackground, generatedAvatarFace, memberCoatIndex, PixelCat, shrinkAvatarImage,
} from "./avatar";
import { useSiliconEmployees, siliconEmployeesRepository, employeeUpdateInput, notifySiliconEmployeeDefinitionChanged } from "../agents/employee-repository.js";
import { employeeAvatarProvider, employeeCliLabel } from "../agents/employee-identity.js";
import { installAvatarEditorStyles } from "../agents/employee-avatar-styles.js";
import { EmployeeAvatarWorkspace } from "../agents/employee-avatar-workspace.js";
import { installEmployeeProfileStyles } from "../styles/employee-profile.js";
import { EmployeeImEditor } from "../agents/employee-im-editor.js";
import { installEmployeeStyles } from "../agents/styles.js";
import { PlushAvatar } from "../avatars/plush-avatar.js";
import { AvatarThinking } from "../avatars/thinking.js";
import { ProviderLogo } from "../provider-logo.js";
import { teamChatComposer } from "./composer-bridge";
import { aiTeamsRepository, subscribeAiTeamDefinitionChanges, subscribeAiTeamRunChanges } from "./repository";

const AI_TEAMS_HOST: Record<string, object> = {
  "conversations/composer-presentation": { composerRuntimePreference },
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
  "chat/activity": { ChatActivity },
  "chat/navigation/TurnNavPanel": { TurnNavPanel },
  "chat/navigation/turn-nav-model": { buildTurnNavIndex, turnNavRange },
  "chat/navigation/turn-jump": { jumpToChatTurn },
  "file-preview/controller": { filePreviewController },
  "file-preview/markdown": { MarkdownPreview, MessageFileContext },
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
  "agents/employee-repository": { useSiliconEmployees, siliconEmployeesRepository, employeeUpdateInput, notifySiliconEmployeeDefinitionChanged },
  "agents/employee-identity": { employeeAvatarProvider, employeeCliLabel },
  "agents/styles": { installEmployeeStyles },
  "agents/employee-avatar-workspace": { EmployeeAvatarWorkspace },
  "agents/employee-im-editor": { EmployeeImEditor },
  "styles/employee-profile": { installEmployeeProfileStyles },
  "provider-logo": { ProviderLogo },
  "model-catalog": { subscribeWandModelCatalog, wandModelDisplayName },
  "use-model-catalog": { useWandModelCatalog },
  "overlay-controller": { wandOverlay },
  "provider-usage": { sortProviderOptions, useProviderUsage },
  "settings/controller": { settingsController },
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
  "avatars/plush-avatar": { PlushAvatar },
  "avatars/thinking": { AvatarThinking },
  "agents/employee-avatar-styles": { installAvatarEditorStyles },
  "task-changes": { subscribeTaskChanges },
  "conversations/state": { conversationUi },
  "conversations/repository": { conversationsRepository },
  "conversations/run-route": { conversationForRun },
  "conversations/presentation": { appendedConversationKeys, CONVERSATION_TAIL_PX, conversationClock, conversationDay, conversationMessageKey, joinsConversationBubble },
  "user-profile-repository": { currentUserAuthor, selfAuthorFor, userProfileStore, useUserProfile },
  "ui": {
    WandBadge, WandBrandMark, WandBreadcrumb, WandButton, WandDialogSurface,
    WandDropdownMenu, WandDropdownMenuContent, WandDropdownMenuItem, WandDropdownMenuTrigger,
    WandIcon, WandIconButton, WandPopover, WandSearchField, WandSelect, WandStretchTabs,
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

export function installAiTeamsHostBridge(): void {
  (globalThis as typeof globalThis & { __wandAiTeamsHost?: (key: string) => object }).__wandAiTeamsHost = key => {
    const mod = AI_TEAMS_HOST[key];
    if (!mod) throw new Error(`AI 团队脚本要的模块 ${key} 不在主包注册表里`);
    return mod;
  };
}
