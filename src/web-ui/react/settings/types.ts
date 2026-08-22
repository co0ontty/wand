export type SettingsTab =
  | "about"
  | "general"
  | "ai"
  | "notifications"
  | "security"
  | "presets"
  | "display";

type SettingsAccess = "admin" | "read-only";
type SettingsProvider = "claude" | "codex" | "opencode";
/** Providers that have per-session default model preferences. */
type SettingsModelProvider = SettingsProvider | "grok" | "qoder" | "pi";
type SettingsCliProvider = SettingsProvider | "qoder" | "pi";
type SettingsUpdateChannel = "stable" | "beta";
type SettingsAutoUpdateTarget = "web" | "apk" | "dmg" | "cli";
export type SettingsDistributionKind = "apk" | "dmg" | "ipa";
export type SettingsDistributionSource = "github" | "local";
export type SettingsNotificationPermission = "granted" | "denied" | "default" | "unsupported";
type SettingsPlatformKind = "browser" | "android" | "ios" | "macos";

interface SettingsBuildInfo {
  commit: string | null;
  shortCommit: string | null;
  builtAt: string | null;
  channel: string | null;
}

export interface SettingsDistributionAsset {
  fileName: string;
  version: string | null;
  size: number;
  downloadUrl: string;
  updatedAt?: string | null;
  releaseNotes?: string;
}

export interface SettingsDistribution {
  enabled: boolean;
  hasArtifact: boolean;
  fileName: string | null;
  version: string | null;
  size: number | null;
  updatedAt: string | null;
  downloadUrl: string | null;
  source: SettingsDistributionSource | null;
  local: SettingsDistributionAsset | null;
  github: SettingsDistributionAsset | null;
}

export interface SettingsAbout {
  packageName: string;
  version: string;
  nodeVersion: string;
  repoUrl: string;
  updateAvailable: boolean;
  latestVersion: string | null;
  updateChannel: SettingsUpdateChannel;
  build: SettingsBuildInfo;
  androidApk: SettingsDistribution;
  macosDmg: SettingsDistribution;
  iosIpa: SettingsDistribution;
}

interface SettingsCommandPreset {
  label: string;
  command: string;
  mode?: string;
}

export interface SettingsCardDefaults {
  editCards: boolean;
  inlineTools: boolean;
  terminal: boolean;
  thinking: boolean;
  toolGroup: boolean;
}

type SettingsExecutionMode =
  | "default"
  | "assist"
  | "agent"
  | "agent-max"
  | "auto-edit"
  | "full-access"
  | "native"
  | "managed";

export interface SettingsSystemAi {
  id: string;
  enabled: boolean;
  protocol: "openai" | "anthropic";
  baseUrl: string;
  /** The server always returns an empty string here. A non-empty save value rotates the key. */
  apiKey: string;
  /** Explicitly clears a saved key; an empty apiKey alone retains it. */
  clearApiKey?: boolean;
  hasApiKey: boolean;
  model: string;
  authHeader: "bearer" | "x-api-key";
  source: Exclude<SettingsModelProvider, "qoder" | "pi"> | "custom";
  fallbacks?: SettingsSystemAi[];
}

interface SettingsSystemAiTestResult {
  ok: true;
  source: SettingsSystemAi["source"];
  requestedModel: string;
  reasoningEffort: "low" | "disabled";
  latencyMs: number;
}

export interface SettingsConfig {
  host: string;
  port: number;
  https: boolean;
  defaultMode: SettingsExecutionMode;
  defaultCwd: string;
  shell: string;
  language: string;
  structuredRunner: "cli" | "sdk";
  inheritEnv: boolean;
  defaultModel: string;
  defaultCodexModel: string;
  defaultOpenCodeModel: string;
  defaultGrokModel: string;
  defaultQoderModel: string;
  defaultPiModel: string;
  defaultModels: Record<SettingsModelProvider, string>;
  commitCli: SettingsProvider;
  commitModel: string;
  commitAiSource: "cli" | "api";
  systemAi: SettingsSystemAi;
  commandPresets: SettingsCommandPreset[];
  cardDefaults: SettingsCardDefaults;
}

export interface SettingsAutoUpdate {
  web: boolean;
  apk: boolean;
  dmg: boolean;
  cli: boolean;
}

export interface SettingsModelOption {
  id: string;
  label: string;
  note?: string;
  alias?: boolean;
  source?: string;
  availability?: string;
  lastVerifiedAt?: string;
  verifiedWithClaudeVersion?: string;
  reasoningEfforts?: Array<{ effort: string; description?: string }>;
  defaultReasoningEffort?: string;
}

export interface SettingsModelCatalog {
  models: SettingsModelOption[];
  codexModels: SettingsModelOption[];
  opencodeModels: SettingsModelOption[];
  grokModels: SettingsModelOption[];
  qoderModels: SettingsModelOption[];
  piModels: SettingsModelOption[];
  claudeVersion: string | null;
  opencodeVersion: string | null;
  refreshedAt: string | null;
  defaultModel: string;
  defaultCodexModel: string;
  defaultOpenCodeModel: string;
  defaultGrokModel: string;
  defaultQoderModel: string;
  defaultPiModel: string;
  defaultModels: Record<SettingsModelProvider, string>;
}

interface SettingsProviderCliStatus {
  id: SettingsCliProvider;
  label: string;
  command: string;
  executable: string | null;
  installed: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  updateSupported: boolean;
  installKind: "native" | "npm" | "brew" | "legacy" | "unknown";
  error?: string;
}

interface SettingsProviderCliResult {
  id: SettingsCliProvider;
  label: string;
  ok: boolean;
  skipped: boolean;
  fromVersion: string | null;
  toVersion: string | null;
  message: string;
  output?: string;
}

interface SettingsProviderCliUpdates {
  items: SettingsProviderCliStatus[];
  checkedAt: string | null;
  updating: boolean;
  autoUpdate: boolean;
  results?: SettingsProviderCliResult[];
  ok?: boolean;
}

interface SettingsConnectCode {
  code: string;
  url: string;
}

interface SettingsNativeSound {
  id: string;
  name: string;
}

export interface SettingsNotificationPreferences {
  sound: boolean;
  volume: number;
  bubble: boolean;
  permission: SettingsNotificationPermission;
  permissionSource: "native" | "browser" | "none";
  nativeSounds: SettingsNativeSound[];
  nativeSound: string | null;
  hapticsEnabled: boolean | null;
}

export interface SettingsPlatformSnapshot {
  kind: SettingsPlatformKind;
  appVersion: string | null;
  canInstallDistribution: boolean;
  hasNativeNotifications: boolean;
}

export interface SettingsCapabilities {
  manageSettings: boolean;
  revealEnvironment: boolean;
  manageSecurity: boolean;
  manageUpdates: boolean;
  manageConnectCode: boolean;
  nativeSounds: boolean;
  haptics: boolean;
  installDistribution: boolean;
}

export interface SettingsSnapshot {
  access: SettingsAccess;
  capabilities: SettingsCapabilities;
  about: SettingsAbout;
  config: SettingsConfig | null;
  desiredConfig: SettingsConfig | null;
  activeConfig: SettingsConfig | null;
  restartRequired: boolean;
  hasCert: boolean;
  autoUpdate: SettingsAutoUpdate;
  models: SettingsModelCatalog | null;
  providerCliUpdates: SettingsProviderCliUpdates | null;
  connectCode: SettingsConnectCode | null;
  notifications: SettingsNotificationPreferences;
  platform: SettingsPlatformSnapshot;
}

export interface SettingsLoadOptions {
  /** `false` skips the admin endpoint. `undefined` retains the legacy 403 fallback. */
  canManageSettings?: boolean;
  signal?: AbortSignal;
}

export interface SettingsGeneralInput {
  host: string;
  port: number;
  https: boolean;
  defaultMode: SettingsExecutionMode;
  defaultCwd: string;
  shell: string;
  language: string;
  structuredRunner: "cli" | "sdk";
  inheritEnv: boolean;
}

export interface SettingsAiInput {
  defaultModel: string;
  defaultCodexModel: string;
  defaultOpenCodeModel: string;
  defaultGrokModel: string;
  defaultQoderModel: string;
  defaultPiModel: string;
  commitAiSource: "cli" | "api";
  systemAi: SettingsSystemAi;
}

interface SettingsSaveResult {
  ok: boolean;
  config: SettingsConfig;
  desiredConfig: SettingsConfig;
  activeConfig: SettingsConfig;
  restartRequired: boolean;
}

interface SettingsEnvironmentEntry {
  name: string;
  value: string;
  length: number;
  sensitive: boolean;
}

export interface SettingsEnvironmentPreview {
  inheritEnv: boolean;
  total: number;
  reveal: boolean;
  entries: SettingsEnvironmentEntry[];
}

export interface SettingsWebUpdate {
  channel: SettingsUpdateChannel;
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  distTag?: "latest" | "beta";
  installSpec?: string;
  build?: SettingsBuildInfo;
}

interface SettingsWebUpdateInstallResult {
  ok: boolean;
  message: string;
  restartRequired: boolean;
  detachedUpdate: boolean;
  version: string | null;
  previousInstanceId: string | null;
  logPath?: string;
}

interface SettingsNotificationTestResult {
  sound: "passed" | "failed";
  bubble: "passed" | "disabled";
  system: "passed" | "denied" | "unsupported" | "failed";
}

export type SettingsCommand =
  | { type: "admin.login"; password: string }
  | { type: "general.save"; value: SettingsGeneralInput }
  | { type: "ai.save"; value: SettingsAiInput }
  | { type: "display.save"; value: SettingsCardDefaults }
  | { type: "password.change"; password: string }
  | { type: "certificate.upload"; key: string; cert: string }
  | { type: "environment.load"; reveal?: boolean }
  | { type: "models.refresh" }
  | { type: "systemAi.import" }
  | { type: "systemAi.test"; route: SettingsSystemAi }
  | { type: "webUpdate.check" }
  | { type: "webUpdate.install" }
  | { type: "server.restart" }
  | { type: "cliUpdates.load"; force?: boolean }
  | { type: "cliUpdates.install"; ids?: SettingsCliProvider[] }
  | { type: "autoUpdate.set"; target: SettingsAutoUpdateTarget; enabled: boolean }
  | { type: "updateChannel.set"; channel: SettingsUpdateChannel }
  | { type: "connectCode.load" }
  | {
      type: "distribution.download";
      kind: SettingsDistributionKind;
      source: SettingsDistributionSource;
      url: string;
      fileName: string;
    }
  | { type: "clipboard.copy"; text: string }
  | { type: "notification.preferences.set"; value: Partial<Pick<SettingsNotificationPreferences, "sound" | "volume" | "bubble">> }
  | { type: "notification.sound.preview" }
  | { type: "notification.permission.request" }
  | { type: "notification.settings.open" }
  | { type: "notification.test"; delayMs?: number }
  | { type: "notification.nativeSound.set"; sound: string }
  | { type: "notification.nativeSound.preview"; sound: string }
  | { type: "notification.haptics.set"; enabled: boolean };

interface SettingsCommandResultMap {
  "admin.login": { ok: boolean };
  "general.save": SettingsSaveResult;
  "ai.save": SettingsSaveResult;
  "display.save": SettingsSaveResult;
  "password.change": { ok: boolean; reauthenticationRequired: boolean };
  "certificate.upload": { ok: boolean; restartRequired: boolean; hasCert: boolean };
  "environment.load": SettingsEnvironmentPreview;
  "models.refresh": SettingsModelCatalog;
  "systemAi.import": { ok: boolean; count: number; systemAi: SettingsSystemAi };
  "systemAi.test": SettingsSystemAiTestResult;
  "webUpdate.check": SettingsWebUpdate;
  "webUpdate.install": SettingsWebUpdateInstallResult;
  "server.restart": { ok: boolean; message: string };
  "cliUpdates.load": SettingsProviderCliUpdates;
  "cliUpdates.install": SettingsProviderCliUpdates;
  "autoUpdate.set": SettingsAutoUpdate;
  "updateChannel.set": { channel: SettingsUpdateChannel; update: SettingsWebUpdate };
  "connectCode.load": SettingsConnectCode;
  "distribution.download": { started: boolean; native: boolean };
  "clipboard.copy": { copied: boolean };
  "notification.preferences.set": SettingsNotificationPreferences;
  "notification.sound.preview": { played: boolean };
  "notification.permission.request": { permission: SettingsNotificationPermission };
  "notification.settings.open": { opened: boolean; native: boolean };
  "notification.test": SettingsNotificationTestResult;
  "notification.nativeSound.set": { sound: string };
  "notification.nativeSound.preview": { played: boolean };
  "notification.haptics.set": { enabled: boolean };
}

export type SettingsCommandResult<C extends SettingsCommand = SettingsCommand> =
  C extends { type: infer T extends keyof SettingsCommandResultMap }
    ? SettingsCommandResultMap[T]
    : never;

export interface SettingsExecuteOptions {
  signal?: AbortSignal;
}

/**
 * The Settings UI depends on one deep boundary: load a complete snapshot and
 * execute semantic commands. HTTP routes, browser storage and native bridges
 * are intentionally hidden from the React tree.
 */
export interface SettingsRepository {
  load(options?: SettingsLoadOptions): Promise<SettingsSnapshot>;
  execute<C extends SettingsCommand>(
    command: C,
    options?: SettingsExecuteOptions,
  ): Promise<SettingsCommandResult<C>>;
}
