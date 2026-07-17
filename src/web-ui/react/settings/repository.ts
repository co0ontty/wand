import { wandOverlay } from "../overlay-controller";
import type {
  SettingsAbout,
  SettingsAutoUpdate,
  SettingsCapabilities,
  SettingsCommand,
  SettingsCommandResult,
  SettingsConfig,
  SettingsDistribution,
  SettingsDistributionAsset,
  SettingsExecuteOptions,
  SettingsLoadOptions,
  SettingsModelCatalog,
  SettingsNotificationPermission,
  SettingsNotificationPreferences,
  SettingsPlatformSnapshot,
  SettingsProvider,
  SettingsRepository,
  SettingsSnapshot,
  SettingsSystemAi,
} from "./types";

type JsonRecord = Record<string, unknown>;

export interface SettingsRuntimeAdapter {
  notificationPreferencesChanged(preferences: SettingsNotificationPreferences): void;
  configSaved(config: SettingsConfig): void;
}

export class BrowserSettingsRuntimeAdapter implements SettingsRuntimeAdapter {
  notificationPreferencesChanged(preferences: SettingsNotificationPreferences): void {
    window.dispatchEvent(new CustomEvent("wand-settings-notifications-changed", { detail: preferences }));
  }

  configSaved(config: SettingsConfig): void {
    window.dispatchEvent(new CustomEvent("wand-settings-config-saved", { detail: config }));
  }
}

const EMPTY_DISTRIBUTION: SettingsDistribution = {
  enabled: false,
  hasArtifact: false,
  fileName: null,
  version: null,
  size: null,
  updatedAt: null,
  downloadUrl: null,
  source: null,
  local: null,
  github: null,
};

const EMPTY_SYSTEM_AI: SettingsSystemAi = {
  enabled: false,
  protocol: "openai",
  baseUrl: "",
  apiKey: "",
  hasApiKey: false,
  model: "",
  authHeader: "bearer",
  source: "custom",
};

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeAsset(value: unknown): SettingsDistributionAsset | null {
  const input = record(value);
  const fileName = stringValue(input.fileName);
  const downloadUrl = stringValue(input.downloadUrl);
  if (!fileName || !downloadUrl) return null;
  return {
    fileName,
    downloadUrl,
    version: nullableString(input.version),
    size: numberValue(input.size, 0),
    updatedAt: nullableString(input.updatedAt),
    releaseNotes: stringValue(input.releaseNotes) || undefined,
  };
}

function normalizeDistribution(value: unknown): SettingsDistribution {
  const input = record(value);
  const local = normalizeAsset(input.local);
  const github = normalizeAsset(input.github);
  return {
    ...EMPTY_DISTRIBUTION,
    enabled: input.enabled !== false,
    hasArtifact: booleanValue(input.hasArtifact, Boolean(local || github || input.fileName)),
    fileName: nullableString(input.fileName),
    version: nullableString(input.version),
    size: typeof input.size === "number" ? input.size : null,
    updatedAt: nullableString(input.updatedAt),
    downloadUrl: nullableString(input.downloadUrl),
    source: input.source === "github" || input.source === "local" ? input.source : null,
    local,
    github,
  };
}

function normalizeSystemAi(value: unknown): SettingsSystemAi {
  const input = record(value);
  const source = input.source === "claude" || input.source === "codex" || input.source === "opencode"
    ? input.source
    : "custom";
  return {
    ...EMPTY_SYSTEM_AI,
    enabled: input.enabled === true,
    protocol: input.protocol === "anthropic" ? "anthropic" : "openai",
    baseUrl: stringValue(input.baseUrl),
    apiKey: "",
    hasApiKey: input.hasApiKey === true,
    model: stringValue(input.model),
    authHeader: input.authHeader === "x-api-key" ? "x-api-key" : "bearer",
    source,
  };
}

function normalizeConfig(value: unknown): SettingsConfig {
  const input = record(value);
  const defaults = record(input.defaultModels);
  const cards = record(input.cardDefaults);
  const presets = Array.isArray(input.commandPresets) ? input.commandPresets : [];
  const defaultMode = [
    "default", "assist", "agent", "agent-max", "auto-edit", "full-access", "native", "managed",
  ].includes(stringValue(input.defaultMode))
    ? stringValue(input.defaultMode) as SettingsConfig["defaultMode"]
    : "default";
  const commitCli = input.commitCli === "codex" || input.commitCli === "opencode" ? input.commitCli : "claude";
  const claude = stringValue(defaults.claude, stringValue(input.defaultModel));
  const codex = stringValue(defaults.codex, stringValue(input.defaultCodexModel));
  const opencode = stringValue(defaults.opencode, stringValue(input.defaultOpenCodeModel));
  const grok = stringValue(defaults.grok, stringValue(input.defaultGrokModel));
  return {
    host: stringValue(input.host, "127.0.0.1"),
    port: numberValue(input.port, 3000),
    https: input.https === true,
    defaultMode,
    defaultCwd: stringValue(input.defaultCwd),
    shell: stringValue(input.shell, "/bin/bash"),
    language: stringValue(input.language),
    structuredRunner: input.structuredRunner === "sdk" ? "sdk" : "cli",
    inheritEnv: input.inheritEnv !== false,
    defaultModel: claude,
    defaultCodexModel: codex,
    defaultOpenCodeModel: opencode,
    defaultGrokModel: grok,
    defaultModels: { claude, codex, opencode, grok },
    commitCli,
    commitModel: stringValue(input.commitModel),
    commitAiSource: input.commitAiSource === "api" ? "api" : "cli",
    systemAi: normalizeSystemAi(input.systemAi),
    commandPresets: presets.map((item) => {
      const preset = record(item);
      return {
        label: stringValue(preset.label),
        command: stringValue(preset.command),
        mode: stringValue(preset.mode) || undefined,
      };
    }).filter((preset) => preset.label || preset.command),
    cardDefaults: {
      editCards: cards.editCards === true,
      inlineTools: cards.inlineTools === true,
      terminal: cards.terminal === true,
      thinking: cards.thinking === true,
      toolGroup: cards.toolGroup === true,
    },
  };
}

function normalizeAbout(value: unknown): SettingsAbout {
  const input = record(value);
  const build = record(input.build);
  return {
    packageName: stringValue(input.packageName, "wand-local"),
    version: stringValue(input.version, "-"),
    nodeVersion: stringValue(input.nodeVersion, "-"),
    repoUrl: stringValue(input.repoUrl),
    updateAvailable: input.updateAvailable === true,
    latestVersion: nullableString(input.latestVersion),
    updateChannel: input.updateChannel === "beta" ? "beta" : "stable",
    build: {
      commit: nullableString(build.commit),
      shortCommit: nullableString(build.shortCommit),
      builtAt: nullableString(build.builtAt),
      channel: nullableString(build.channel),
    },
    androidApk: normalizeDistribution(input.androidApk),
    macosDmg: normalizeDistribution(input.macosDmg),
  };
}

function normalizeModels(value: unknown): SettingsModelCatalog {
  const input = record(value);
  const models = (key: string) => Array.isArray(input[key]) ? input[key] as SettingsModelCatalog["models"] : [];
  const defaults = record(input.defaultModels);
  return {
    models: models("models"),
    codexModels: models("codexModels"),
    opencodeModels: models("opencodeModels"),
    grokModels: models("grokModels"),
    claudeVersion: nullableString(input.claudeVersion),
    opencodeVersion: nullableString(input.opencodeVersion),
    refreshedAt: nullableString(input.refreshedAt),
    defaultModel: stringValue(input.defaultModel),
    defaultCodexModel: stringValue(input.defaultCodexModel),
    defaultOpenCodeModel: stringValue(input.defaultOpenCodeModel),
    defaultGrokModel: stringValue(input.defaultGrokModel),
    defaultModels: {
      claude: stringValue(defaults.claude, stringValue(input.defaultModel)),
      codex: stringValue(defaults.codex, stringValue(input.defaultCodexModel)),
      opencode: stringValue(defaults.opencode, stringValue(input.defaultOpenCodeModel)),
      grok: stringValue(defaults.grok, stringValue(input.defaultGrokModel)),
    },
  };
}

function storedBoolean(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key);
    return value == null ? fallback : value === "true";
  } catch {
    return fallback;
  }
}

function storedNumber(key: string, fallback: number): number {
  try {
    const parsed = Number(window.localStorage.getItem(key));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function nativeBridge(): typeof WandNative | null {
  try {
    return typeof WandNative !== "undefined" ? WandNative : null;
  } catch {
    return null;
  }
}

function notificationPermission(bridge: typeof WandNative | null): SettingsNotificationPermission {
  if (bridge?.getPermission) {
    try {
      const permission = bridge.getPermission();
      if (permission === "granted" || permission === "denied" || permission === "default") return permission;
    } catch { /* native bridge is best effort */ }
  }
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

function platformSnapshot(): SettingsPlatformSnapshot {
  const bridge = nativeBridge();
  const ua = navigator.userAgent || "";
  const kind = /WandPlatform\/Android/.test(ua)
    ? "android"
    : /WandPlatform\/iOS/.test(ua)
      ? "ios"
      : /WandPlatform\/macOS/.test(ua) || (window as Window & { __wandMacNative?: boolean }).__wandMacNative === true
        ? "macos"
        : "browser";
  let appIcon: string | null = null;
  if (bridge?.getAppIcon) {
    try { appIcon = bridge.getAppIcon() || null; } catch { /* noop */ }
  }
  const appVersion = ua.match(/WandApp\/([^\s]+)/)?.[1] || null;
  return {
    kind,
    appVersion,
    appIcon,
    canSetAppIcon: typeof bridge?.setAppIcon === "function",
    canInstallDistribution: typeof bridge?.downloadUpdate === "function",
    hasNativeNotifications: typeof bridge?.sendNotification === "function",
  };
}

function notificationSnapshot(): SettingsNotificationPreferences {
  const bridge = nativeBridge();
  let nativeSounds: Array<{ id: string; name: string }> = [];
  let nativeSound: string | null = null;
  let hapticsEnabled: boolean | null = null;
  try {
    if (bridge?.getAvailableSounds) nativeSounds = JSON.parse(bridge.getAvailableSounds()) as Array<{ id: string; name: string }>;
    if (bridge?.getNotificationSound) nativeSound = bridge.getNotificationSound();
    if (bridge?.isHapticEnabled) hapticsEnabled = bridge.isHapticEnabled();
  } catch { /* malformed native payload falls back to browser preferences */ }
  const volume = bridge?.getNotificationVolume
    ? (() => { try { return bridge.getNotificationVolume(); } catch { return storedNumber("wand-notif-volume", 80); } })()
    : storedNumber("wand-notif-volume", 80);
  return {
    sound: storedBoolean("wand-notif-sound", true),
    volume: Math.max(0, Math.min(100, volume)),
    bubble: storedBoolean("wand-notif-bubble", true),
    permission: notificationPermission(bridge),
    permissionSource: bridge ? "native" : typeof Notification === "undefined" ? "none" : "browser",
    nativeSounds,
    nativeSound,
    hapticsEnabled,
  };
}

function capabilities(access: "admin" | "read-only", platform: SettingsPlatformSnapshot): SettingsCapabilities {
  const admin = access === "admin";
  return {
    manageSettings: admin,
    revealEnvironment: admin,
    manageSecurity: admin,
    manageUpdates: admin,
    manageConnectCode: admin,
    nativeSounds: platform.hasNativeNotifications,
    haptics: notificationSnapshot().hapticsEnabled !== null,
    appIcon: platform.canSetAppIcon,
    installDistribution: platform.canInstallDistribution,
  };
}

async function responseJson(response: Response): Promise<JsonRecord> {
  let body: JsonRecord = {};
  try { body = record(await response.json()); } catch { /* preserve HTTP status error */ }
  if (!response.ok || typeof body.error === "string") {
    const error = new Error(stringValue(body.error, `请求失败（${response.status}）`));
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return body;
}

async function request(path: string, init: RequestInit = {}): Promise<JsonRecord> {
  return responseJson(await fetch(path, { credentials: "same-origin", ...init }));
}

async function post(path: string, body?: unknown, signal?: AbortSignal): Promise<JsonRecord> {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
}

function aboutSnapshot(input: JsonRecord, access: "admin" | "read-only"): SettingsSnapshot {
  const platform = platformSnapshot();
  const config = access === "admin" ? normalizeConfig(input.config) : null;
  return {
    access,
    capabilities: capabilities(access, platform),
    about: normalizeAbout(input),
    config,
    desiredConfig: access === "admin" ? normalizeConfig(input.desiredConfig || input.config) : null,
    activeConfig: access === "admin" ? normalizeConfig(input.activeConfig || input.config) : null,
    restartRequired: input.restartRequired === true,
    hasCert: input.hasCert === true,
    autoUpdate: {
      web: record(input.autoUpdate).web === true,
      apk: record(input.autoUpdate).apk === true,
      dmg: record(input.autoUpdate).dmg === true,
      cli: record(input.autoUpdate).cli === true,
    },
    models: null,
    providerCliUpdates: null,
    connectCode: null,
    notifications: notificationSnapshot(),
    platform,
  };
}

function updateNotificationPreference(value: Partial<Pick<SettingsNotificationPreferences, "sound" | "volume" | "bubble">>): SettingsNotificationPreferences {
  const bridge = nativeBridge();
  try {
    if (typeof value.sound === "boolean") window.localStorage.setItem("wand-notif-sound", String(value.sound));
    if (typeof value.bubble === "boolean") window.localStorage.setItem("wand-notif-bubble", String(value.bubble));
    if (typeof value.volume === "number") window.localStorage.setItem("wand-notif-volume", String(value.volume));
  } catch { /* storage may be unavailable */ }
  if (typeof value.volume === "number" && bridge?.setNotificationVolume) {
    try { bridge.setNotificationVolume(value.volume); } catch { /* noop */ }
  }
  return notificationSnapshot();
}

function playPreviewSound(): boolean {
  const bridge = nativeBridge();
  if (bridge?.previewSound && bridge.getNotificationSound) {
    try { bridge.previewSound(bridge.getNotificationSound()); return true; } catch { return false; }
  }
  try {
    const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return false;
    const context = new AudioContextCtor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    gain.gain.value = notificationSnapshot().volume / 100 * 0.08;
    oscillator.frequency.value = 660;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.12);
    return true;
  } catch { return false; }
}

async function requestPermission(): Promise<SettingsNotificationPermission> {
  const bridge = nativeBridge();
  if (bridge?.requestPermission) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (permission: SettingsNotificationPermission) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        delete window._onNativePermissionResult;
        resolve(permission);
      };
      const timeout = window.setTimeout(() => finish(notificationPermission(bridge)), 3000);
      window._onNativePermissionResult = (result: string) => {
        finish(result === "granted" || result === "denied" ? result : "default");
      };
      try { bridge.requestPermission(); } catch { finish(notificationPermission(bridge)); }
    });
  }
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.requestPermission();
}

function systemNotification(): "passed" | "denied" | "unsupported" | "failed" {
  const bridge = nativeBridge();
  const permission = notificationPermission(bridge);
  if (permission === "denied" || permission === "default") return "denied";
  if (permission === "unsupported") return "unsupported";
  try {
    if (bridge?.sendNotification) {
      bridge.sendNotification("Wand 测试通知", "系统通知已正常工作。", "wand-test");
    } else {
      new Notification("Wand 测试通知", { body: "系统通知已正常工作。", tag: "wand-test" });
    }
    return "passed";
  } catch { return "failed"; }
}

export class HttpSettingsRepository implements SettingsRepository {
  constructor(private readonly runtime: SettingsRuntimeAdapter = new BrowserSettingsRuntimeAdapter()) {}

  async load(options: SettingsLoadOptions = {}): Promise<SettingsSnapshot> {
    if (options.canManageSettings === false) {
      return aboutSnapshot(await request("/api/settings/about", { signal: options.signal }), "read-only");
    }

    let admin: JsonRecord;
    try {
      admin = await request("/api/settings", { signal: options.signal });
    } catch (error) {
      if ((error as Error & { status?: number }).status === 403) {
        return aboutSnapshot(await request("/api/settings/about", { signal: options.signal }), "read-only");
      }
      throw error;
    }

    const snapshot = aboutSnapshot(admin, "admin");
    const origin = window.location?.origin ? `?origin=${encodeURIComponent(window.location.origin)}` : "";
    const [models, cliUpdates, connectCode] = await Promise.all([
      request("/api/models", { signal: options.signal }).catch(() => null),
      request("/api/provider-cli-updates", { signal: options.signal }).catch(() => null),
      request(`/api/app-connect-code${origin}`, { signal: options.signal }).catch(() => null),
    ]);
    snapshot.models = models ? normalizeModels(models) : null;
    snapshot.providerCliUpdates = cliUpdates as SettingsSnapshot["providerCliUpdates"];
    snapshot.connectCode = connectCode ? {
      code: stringValue(connectCode.code),
      url: stringValue(connectCode.url),
    } : null;
    return snapshot;
  }

  async execute<C extends SettingsCommand>(command: C, options: SettingsExecuteOptions = {}): Promise<SettingsCommandResult<C>> {
    let result: unknown;
    switch (command.type) {
      case "general.save":
        result = await post("/api/settings/config", command.value, options.signal);
        this.runtime.configSaved(normalizeConfig(record(result).config));
        break;
      case "ai.save":
        result = await post("/api/settings/config", {
          ...command.value,
          defaultModels: {
            claude: command.value.defaultModel,
            codex: command.value.defaultCodexModel,
            opencode: command.value.defaultOpenCodeModel,
            grok: command.value.defaultGrokModel,
          },
        }, options.signal);
        this.runtime.configSaved(normalizeConfig(record(result).config));
        break;
      case "display.save":
        result = await post("/api/settings/config", { cardDefaults: command.value }, options.signal);
        this.runtime.configSaved(normalizeConfig(record(result).config));
        break;
      case "password.change":
        result = await post("/api/set-password", { password: command.password }, options.signal);
        break;
      case "certificate.upload": {
        const response = await post("/api/settings/upload-cert", { key: command.key, cert: command.cert }, options.signal);
        result = { ...response, hasCert: true };
        break;
      }
      case "environment.load":
        result = await request(`/api/settings/env-preview${command.reveal ? "?reveal=1" : ""}`, { signal: options.signal });
        break;
      case "models.refresh":
        result = normalizeModels(await post("/api/models/refresh", undefined, options.signal));
        break;
      case "systemAi.import":
        result = await post("/api/settings/system-ai/import", { source: command.source }, options.signal);
        break;
      case "webUpdate.check":
        result = await request("/api/check-update", { signal: options.signal });
        break;
      case "webUpdate.install":
        result = await post("/api/update", undefined, options.signal);
        break;
      case "server.restart":
        result = await post("/api/restart", undefined, options.signal);
        break;
      case "cliUpdates.load":
        result = await request(`/api/provider-cli-updates${command.force ? "?refresh=1" : ""}`, { signal: options.signal });
        break;
      case "cliUpdates.install":
        result = await post("/api/provider-cli-updates", { ids: command.ids || [] }, options.signal);
        break;
      case "autoUpdate.set": {
        const body: Partial<SettingsAutoUpdate> = { [command.target]: command.enabled };
        result = await post("/api/auto-update", body, options.signal);
        break;
      }
      case "updateChannel.set": {
        const channel = await post("/api/update-channel", { channel: command.channel }, options.signal);
        const update = await request("/api/check-update", { signal: options.signal });
        result = { channel: channel.channel, update };
        break;
      }
      case "connectCode.load": {
        const origin = window.location?.origin ? `?origin=${encodeURIComponent(window.location.origin)}` : "";
        result = await request(`/api/app-connect-code${origin}`, { signal: options.signal });
        break;
      }
      case "distribution.download": {
        const bridge = nativeBridge();
        if (bridge?.downloadUpdate) {
          bridge.downloadUpdate(command.url, command.fileName, command.source);
          result = { started: true, native: true };
        } else if (command.source === "local") {
          const probe = await fetch(command.url, { method: "HEAD", credentials: "same-origin", signal: options.signal });
          if (!probe.ok) throw new Error(`安装包不可用（${probe.status}）。`);
          const anchor = document.createElement("a");
          anchor.href = command.url;
          anchor.download = command.fileName;
          anchor.rel = "noopener";
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          result = { started: true, native: false };
        } else {
          window.open(command.url, "_blank", "noopener");
          result = { started: true, native: false };
        }
        break;
      }
      case "clipboard.copy": {
        const bridge = nativeBridge();
        if (bridge?.copyToClipboard) bridge.copyToClipboard(command.text);
        else await navigator.clipboard.writeText(command.text);
        result = { copied: true };
        break;
      }
      case "notification.preferences.set":
        result = updateNotificationPreference(command.value);
        this.runtime.notificationPreferencesChanged(result as SettingsNotificationPreferences);
        break;
      case "notification.sound.preview":
        result = { played: playPreviewSound() };
        break;
      case "notification.permission.request":
        result = { permission: await requestPermission() };
        break;
      case "notification.test": {
        if (command.delayMs) await new Promise<void>((resolve) => window.setTimeout(resolve, command.delayMs));
        const prefs = notificationSnapshot();
        const played = playPreviewSound();
        if (prefs.bubble) wandOverlay.toast("测试通知", { description: "这是一条测试通知。" });
        result = {
          sound: played ? "passed" : "failed",
          bubble: prefs.bubble ? "passed" : "disabled",
          system: systemNotification(),
        };
        break;
      }
      case "notification.nativeSound.set": {
        nativeBridge()?.setNotificationSound?.(command.sound);
        result = { sound: command.sound };
        break;
      }
      case "notification.nativeSound.preview": {
        let played = false;
        try { nativeBridge()?.previewSound?.(command.sound); played = true; } catch { /* noop */ }
        result = { played };
        break;
      }
      case "notification.haptics.set": {
        nativeBridge()?.setHapticEnabled?.(command.enabled);
        if (command.enabled) nativeBridge()?.vibrate?.("medium");
        result = { enabled: command.enabled };
        break;
      }
      case "appIcon.set":
        nativeBridge()?.setAppIcon?.(command.icon);
        result = { icon: command.icon };
        break;
    }
    return result as SettingsCommandResult<C>;
  }
}

export const httpSettingsRepository = new HttpSettingsRepository();

export function cloneSettingsSnapshot(snapshot: SettingsSnapshot): SettingsSnapshot {
  return typeof structuredClone === "function"
    ? structuredClone(snapshot)
    : JSON.parse(JSON.stringify(snapshot)) as SettingsSnapshot;
}
