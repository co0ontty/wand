import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useSyncExternalStore } from "react";
import { wandOverlay } from "../overlay-controller";
import { WandButton, WandDialogSurface, WandTabs } from "../ui";
import { settingsController, settingsStore } from "./controller";
import { httpSettingsRepository } from "./repository";
import {
  AboutSettingsTab,
  AiSettingsTab,
  DisplaySettingsTab,
  GeneralSettingsTab,
  NotificationSettingsTab,
  PresetSettingsTab,
  SecuritySettingsTab,
} from "./tabs";
import { SettingsField, SettingsStatus, SettingsTextInput } from "./fields";
import type { SettingsRepository, SettingsSnapshot, SettingsTab } from "./types";

export interface SettingsHostProps {
  repository?: SettingsRepository;
  showRestart?: () => void;
}

const TAB_LABELS: Record<SettingsTab, { title: string; description: string }> = {
  general: { title: "基本配置", description: "连接、模式与运行环境" },
  ai: { title: "AI 与模型", description: "默认模型、API 路由与 Commit" },
  notifications: { title: "通知", description: "提示音与系统通知" },
  display: { title: "显示", description: "卡片默认展开行为" },
  security: { title: "安全", description: "密码与证书" },
  presets: { title: "命令预设", description: "查看已有预设" },
  about: { title: "关于", description: "版本、更新与连接方式" },
};

const ADMIN_TAB_ORDER: SettingsTab[] = [
  "general",
  "ai",
  "notifications",
  "display",
  "security",
  "presets",
  "about",
];

const CONNECTED_APP_TAB_ORDER: SettingsTab[] = [
  "notifications",
  "about",
];

const PLATFORM_LABELS = {
  browser: "网页控制台",
  android: "Android 原生",
  ios: "iOS 原生",
  macos: "macOS 原生",
} as const;

/** 把当前连接、通道和端形态放在设置入口，而不是埋在各个分组中。 */
function SettingsOverview({ snapshot }: { snapshot: SettingsSnapshot }) {
  const version = snapshot.platform.appVersion || snapshot.about.version || "未知版本";
  return (
    <section className="wand-settings-overview" aria-label="当前设置概览">
      <span className="wand-settings-overview-mark" aria-hidden="true">✦</span>
      <div className="wand-settings-overview-copy">
        <div>
          <strong>系统设置</strong>
          <span>连接、设备和工作流偏好都在这里调整。</span>
        </div>
        <div className="wand-settings-overview-pills">
          <span className="is-success">{snapshot.access === "admin" ? "管理员连接" : "App 连接"}</span>
          <span className={snapshot.about.updateChannel === "beta" ? "is-warning" : "is-info"}>
            {snapshot.about.updateChannel === "beta" ? "Beta 通道" : "Stable 通道"}
          </span>
          <span className="is-accent">{PLATFORM_LABELS[snapshot.platform.kind]}</span>
        </div>
      </div>
      <code>v{version.replace(/^v/, "")}</code>
    </section>
  );
}

function ConnectedAppAccess({
  repository,
  onAuthenticated,
}: {
  repository: SettingsRepository;
  onAuthenticated(snapshot: SettingsSnapshot): void;
}) {
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function authenticate() {
    if (!password) {
      setError("请输入管理员密码。");
      return;
    }
    setPending(true);
    setError("");
    try {
      await repository.execute({ type: "admin.login", password });
      const snapshot = await repository.load();
      if (snapshot.access !== "admin") throw new Error("登录成功，但当前会话仍没有管理权限。");
      setPassword("");
      onAuthenticated(snapshot);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "管理员登录失败。");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="wand-settings-app-access" aria-label="App 连接权限">
      <div className="wand-settings-app-access-copy">
        <strong>设备功能已可用</strong>
        <span>通知、触感、应用图标和客户端下载无需管理权限。要修改服务配置，请使用管理员密码登录此网页。</span>
      </div>
      <form
        className="wand-settings-app-access-form"
        onSubmit={(event) => {
          event.preventDefault();
          void authenticate();
        }}
      >
        <input type="text" name="username" autoComplete="username" value="wand" readOnly hidden />
        <SettingsField label="管理员密码" htmlFor="settings-admin-password" error={error}>
          <SettingsTextInput
            id="settings-admin-password"
            type="password"
            autoComplete="current-password"
            value={password}
            disabled={pending}
            invalid={!!error}
            placeholder="输入密码解锁完整设置"
            onChange={(value) => {
              setPassword(value);
              setError("");
            }}
          />
        </SettingsField>
        <WandButton type="submit" kind="primary" disabled={pending}>
          {pending ? "登录中…" : "登录管理设置"}
        </WandButton>
      </form>
      <SettingsStatus tone="warning">
        修改 Host、端口或 HTTPS 可能中断当前 App 连接；修改密码会使现有连接码失效。
      </SettingsStatus>
    </section>
  );
}

export function SettingsHost({
  repository = httpSettingsRepository,
  showRestart = () => {},
}: SettingsHostProps) {
  const controller = useSyncExternalStore(
    settingsStore.subscribe,
    settingsStore.getSnapshot,
    settingsStore.getSnapshot,
  );
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async (signal?: AbortSignal, quiet = false) => {
    if (!quiet) setLoading(true);
    setLoadError("");
    try {
      const next = await repository.load({ signal });
      if (!signal?.aborted) setSnapshot(next);
    } catch (error) {
      if (!signal?.aborted) setLoadError(error instanceof Error ? error.message : "设置加载失败。");
    } finally {
      if (!signal?.aborted && !quiet) setLoading(false);
    }
  }, [repository]);

  useEffect(() => {
    if (!controller.open) return;
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [controller.open, load]);

  const refresh = useCallback(async () => load(undefined, true), [load]);
  const toast = useCallback((message: string, tone: "info" | "success" | "warning" | "error" = "info") => {
    wandOverlay.toast(message, { tone });
  }, []);

  const tabs = useMemo(() => {
    if (!snapshot) return [];
    const props = { snapshot, repository, refresh, setSnapshot, toast, showRestart };
    const contentByTab: Record<SettingsTab, ReactNode> = {
      general: <GeneralSettingsTab {...props} />,
      ai: <AiSettingsTab {...props} />,
      notifications: <NotificationSettingsTab {...props} />,
      display: <DisplaySettingsTab {...props} />,
      security: <SecuritySettingsTab {...props} />,
      presets: <PresetSettingsTab {...props} />,
      about: <AboutSettingsTab {...props} />,
    };
    const order = snapshot.access === "admin" ? ADMIN_TAB_ORDER : CONNECTED_APP_TAB_ORDER;
    return order.map((value) => ({
      value,
      label: (
        <span className="wand-settings-tab-label">
          <strong>{TAB_LABELS[value].title}</strong>
          <span>{TAB_LABELS[value].description}</span>
        </span>
      ),
      content: contentByTab[value],
    }));
  }, [refresh, repository, showRestart, snapshot, toast]);

  const selectedTab = snapshot?.access === "admin"
    ? controller.tab
    : controller.tab === "about"
      ? "about"
      : "notifications";

  return (
    <WandDialogSurface
      open={controller.open}
      onOpenChange={(open) => { if (!open) settingsController.close(); }}
      title="系统设置"
      description="调整应用配置、通知、安全和显示偏好"
      className="wand-settings-dialog"
      overlayClassName="wand-settings-overlay"
      titleClassName="wand-settings-title"
      descriptionClassName="wand-settings-description"
      headerClassName="wand-settings-header"
      closeLabel="关闭设置"
      testId="settings-dialog"
    >
          {loading ? (
            <div className="wand-settings-loading" role="status" aria-label="正在加载设置">正在加载设置…</div>
          ) : loadError ? (
            <div className="wand-settings-load-error" role="alert">
              <p>{loadError}</p>
              <WandButton kind="primary" onClick={() => void load()}>重试加载设置</WandButton>
            </div>
          ) : snapshot ? (
            <>
              <SettingsOverview snapshot={snapshot} />
              {snapshot.access === "read-only" ? (
                <ConnectedAppAccess
                  repository={repository}
                  onAuthenticated={(next) => {
                    setLoadError("");
                    setSnapshot(next);
                    settingsStore.setTab("general");
                  }}
                />
              ) : null}
              <WandTabs
                className="wand-settings-tabs"
                ariaLabel="设置分组"
                value={selectedTab}
                tabs={tabs}
                onValueChange={(value) => settingsStore.setTab(value as SettingsTab)}
              />
            </>
          ) : null}
    </WandDialogSurface>
  );
}
