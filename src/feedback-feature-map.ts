import type { FeedbackFeature } from "./feedback.js";

/** Canonical route-family ownership. Native clients mirror these explicit entries, not error text. */
export const FEEDBACK_API_FEATURES = {
  sessions: "sessions", "structured-sessions": "sessions", commands: "sessions", "session-list": "sessions", "session-directories": "sessions",
  conversations: "conversations",
  "wand-tasks": "tasks", "wand-task-agent-defaults": "tasks", tasks: "tasks", "workspace-tasks": "tasks", workspaces: "tasks", "wand-milestones": "tasks", missions: "tasks", "scheduled-tasks": "tasks",
  files: "files", upload: "files", directory: "files", "session-files": "files", "file-preview": "files", "file-read": "files", "file-write": "files", "recent-paths": "files",
  speech: "speech",
  settings: "settings", config: "settings", "user-profile": "settings", "auto-update": "settings", "update-channel": "settings",
  models: "models", "model-groups": "models", "local-models": "models",
  login: "authentication", logout: "authentication", "app-login": "authentication", "session-check": "authentication", "set-password": "authentication",
  update: "server_update", "update-status": "server_update", "check-update": "server_update",
  "android-apk-update": "app_update", "android-apk": "app_update", "macos-app-update": "app_update", "macos-dmg-update": "app_update", "macos-dmg": "app_update", "ios-ipa-update": "app_update", "ios-ipa": "app_update",
  "provider-cli-updates": "provider_update", "daemon-maintenance": "daemon_update", "storage-cleanup": "storage",
  git: "repository", github: "repository",
} as const satisfies Record<string, FeedbackFeature>;

export function feedbackFeatureForApiPath(pathname: string): FeedbackFeature {
  const family = pathname.split("?")[0]!.split("/")[2] ?? "";
  return Object.prototype.hasOwnProperty.call(FEEDBACK_API_FEATURES, family)
    ? FEEDBACK_API_FEATURES[family as keyof typeof FEEDBACK_API_FEATURES] : "api";
}
