import { isClientSettingsPage } from "../../page.js";
import { Alert, Form, Skeleton } from "antd";
import { WandUiProvider } from "../theme";
import { installSettingsLibraryStyles } from "./styles";
import { SpeechSettingsTab } from "./speech-panel";
import { LocalModelsSettingsTab } from "./local-models-panel";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import * as React from "react";
import { useSyncExternalStore } from "react";
import { wandOverlay } from "../overlay-controller";
import { WandBadge, WandButton, WandDialogSurface, WandTabs } from "../ui";
import { settingsController, settingsStore } from "./controller";
import { httpSettingsRepository } from "./repository";
import {
  AboutSettingsTab,
  GithubSettingsTab,
  AiSettingsTab,
  DisplaySettingsTab,
  GeneralSettingsTab,
  NotificationSettingsTab,
  PresetSettingsTab,
  ProfileSettingsTab,
  SecuritySettingsTab,
} from "./tabs";
import { SettingsActionButton, SettingsField, SettingsStatus, SettingsTextInput } from "./fields";
import type { SettingsRepository, SettingsSnapshot, SettingsTab } from "./types";

export interface SettingsHostProps {
  repository?: SettingsRepository;
  showRestart?: () => void;
  presentation?: "dialog" | "page";
}

const TAB_LABELS: Record<SettingsTab, string> = {
  profile: "我的资料",
  connectors: "连接器",
  general: "基本配置",
  ai: "AI 与模型",
  speech: "语音输入",
  "local-models": "本地模型",
  notifications: "通知",
  display: "显示",
  security: "安全",
  presets: "命令预设",
  about: "关于",
};

const ADMIN_TAB_ORDER: SettingsTab[] = [
  "profile",
  "connectors",
  "general",
  "ai",
  "local-models",
  "speech",
  "notifications",
  "display",
  "security",
  "presets",
  "about",
];

const CONNECTED_APP_TAB_ORDER: SettingsTab[] = [
  "local-models",
  "speech",
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
function SettingsOverview({ snapshot, clientAuth = false }: { snapshot: SettingsSnapshot; clientAuth?: boolean }) {
  const version = snapshot.platform.appVersion || snapshot.about.version || "未知版本";
  return (
    <section className="wand-settings-library-overview" aria-label="当前设置概览">
      <div className="wand-settings-library-overview-pills">
        <WandBadge tone="success">{clientAuth ? "客户端连接" : snapshot.access === "admin" ? "管理员连接" : "App 连接"}</WandBadge>
        <WandBadge tone={snapshot.about.updateChannel === "beta" ? "warning" : "info"}>
          {snapshot.about.updateChannel === "beta" ? "Beta 通道" : "Stable 通道"}
        </WandBadge>
        <WandBadge tone="accent">{PLATFORM_LABELS[snapshot.platform.kind]}</WandBadge>
      </div>
      <code>v{version.replace(/^v/, "")}</code>
    </section>
  );
}

function SettingsLoading() {
  return <div role="status" aria-label="正在加载设置"><Skeleton active paragraph={{ rows: 8 }} /></div>;
}

function ConnectedAppAccess({
  repository,
  onAuthenticated,
  signedOut = false,
  allowEmptyPassword = false,
}: {
  repository: SettingsRepository;
  onAuthenticated(snapshot: SettingsSnapshot): void;
  signedOut?: boolean;
  allowEmptyPassword?: boolean;
}) {
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [settled, setSettled] = useState<"success" | "error" | null>(null);
  const [error, setError] = useState("");

  async function authenticate() {
    if (!password && !allowEmptyPassword) {
      setError("请输入管理员密码。");
      return;
    }
    setSettled(null);
    setPending(true);
    setError("");
    try {
      await repository.execute({ type: "admin.login", password });
      const snapshot = await repository.load();
      if (snapshot.access !== "admin") throw new Error("登录成功，但当前会话仍没有管理权限。");
      setPassword("");
      setSettled("success");
      onAuthenticated(snapshot);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "管理员登录失败。");
      setSettled("error");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="wand-settings-library-app-access" aria-label="App 连接权限">
      <Alert type="info" showIcon title={signedOut ? "登录完整设置" : "设备功能已可用"}
        description={signedOut
          ? "输入当前服务器的管理员密码，即可在此页面打开全部设置。"
          : "通知、触感、应用图标和客户端下载无需管理权限。要修改服务配置，请使用管理员密码登录此网页。"} />
      <Form noValidate layout="vertical" className="wand-settings-library-app-access-form"
        onFinish={() => void authenticate()}>
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
        <SettingsActionButton
          type="submit"
          kind="primary"
          pending={pending}
          settled={pending ? null : settled}
          pendingLabel="登录中…"
          successLabel="已登录"
          errorLabel="登录失败"
        >
          登录管理设置
        </SettingsActionButton>
      </Form>
      <SettingsStatus tone="warning">
        修改 Host、端口或 HTTPS 可能中断当前 App 连接；修改密码会使现有连接码失效。
      </SettingsStatus>
    </section>
  );
}

export function SettingsHost({
  repository = httpSettingsRepository,
  showRestart = () => {},
  presentation = "dialog",
}: SettingsHostProps) {
  useEffect(() => { installSettingsLibraryStyles(); }, []);
  const [horizontalTabs, setHorizontalTabs] = useState(() => (
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      && window.matchMedia("(max-width: 760px)").matches
  ));
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 760px)");
    const sync = (): void => setHorizontalTabs(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  const controller = useSyncExternalStore(
    settingsStore.subscribe,
    settingsStore.getSnapshot,
    settingsStore.getSnapshot,
  );
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [loginRequired, setLoginRequired] = useState(false);
  const isOpen = presentation === "page" || controller.open;
  const clientAuth = presentation === "page" && isClientSettingsPage();

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const next = await repository.load({ signal });
      if (clientAuth && next.access !== "admin") throw new Error("客户端认证已失效，请返回客户端重新打开完整设置。");
      if (!signal?.aborted) {
        setSnapshot(next);
        setLoginRequired(false);
        setLoadError("");
      }
    } catch (error) {
      if (!signal?.aborted) {
        if (clientAuth && (error as Error & { status?: number }).status === 401) {
          setLoadError("客户端登录已失效，请返回客户端重新连接。");
        } else if (presentation === "page" && (error as Error & { status?: number }).status === 401) {
          setLoginRequired(true);
          setLoadError("");
        } else setLoadError(error instanceof Error ? error.message : "设置加载失败。");
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [clientAuth, presentation, repository]);

  useEffect(() => {
    if (!isOpen) return;
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [isOpen, load]);

  const refresh = useCallback(async () => load(), [load]);
  const toast = useCallback((message: string, tone: "info" | "success" | "warning" | "error" = "info") => {
    wandOverlay.toast(message, { tone });
  }, []);

  const tabs = useMemo(() => {
    if (!snapshot) return [];
    const props = { snapshot, repository, refresh, setSnapshot, toast, showRestart };
    const contentByTab: Record<SettingsTab, ReactNode> = {
      profile: <ProfileSettingsTab {...props} />,
      connectors: <GithubSettingsTab {...props} />,
      general: <GeneralSettingsTab {...props} />,
      ai: <AiSettingsTab {...props} />,
      speech: <SpeechSettingsTab admin={snapshot.access === "admin"} />,
      "local-models": <LocalModelsSettingsTab admin={snapshot.access === "admin"} />,
      notifications: <NotificationSettingsTab {...props} />,
      display: <DisplaySettingsTab {...props} />,
      security: <SecuritySettingsTab {...props} />,
      presets: <PresetSettingsTab {...props} />,
      about: <AboutSettingsTab {...props} />,
    };
    const order = snapshot.access === "admin" ? ADMIN_TAB_ORDER : CONNECTED_APP_TAB_ORDER;
    return order.map((value) => ({
      value,
      label: TAB_LABELS[value],
      content: contentByTab[value],
    }));
  }, [refresh, repository, showRestart, snapshot, toast]);

  const selectedTab = snapshot?.access === "admin"
    ? controller.tab
    : controller.tab === "about" || controller.tab === "speech" || controller.tab === "local-models"
      ? controller.tab
      : "notifications";

  const onAuthenticated = (next: SettingsSnapshot): void => {
    setLoadError("");
    setLoginRequired(false);
    setSnapshot(next);
  };
  const content = (
    <>
          {loginRequired && !clientAuth ? <ConnectedAppAccess repository={repository} signedOut allowEmptyPassword
            onAuthenticated={onAuthenticated} /> : null}
          {snapshot ? (
            <>
              <SettingsOverview snapshot={snapshot} clientAuth={clientAuth} />
              {loadError ? (
                <div className="wand-settings-library-refresh-error">
                  <SettingsStatus tone="error">
                    <span>刷新设置失败，当前内容已保留。{loadError}</span>
                    <WandButton size="small" disabled={loading} aria-busy={loading} onClick={() => void refresh()}>
                      重新加载
                    </WandButton>
                  </SettingsStatus>
                </div>
              ) : null}
              {snapshot.access === "read-only" && !loginRequired && !clientAuth ? (
                <ConnectedAppAccess
                  repository={repository}
                  allowEmptyPassword={presentation === "page"}
                  onAuthenticated={onAuthenticated}
                />
              ) : null}
              <WandTabs
                className="wand-settings-library-tabs"
                ariaLabel="设置分组"
                orientation={horizontalTabs ? "horizontal" : "vertical"}
                value={selectedTab}
                tabs={tabs}
                onValueChange={(value) => settingsStore.setTab(value as SettingsTab)}
              />
            </>
          ) : loading ? (
            <SettingsLoading />
          ) : loadError ? (
            <div className="wand-settings-library-load-error" role="alert">
              <p>{loadError}</p>
              <WandButton kind="primary" onClick={() => void load()}>重试加载设置</WandButton>
            </div>
          ) : null}
    </>
  );
  if (presentation === "page") {
    return <WandUiProvider><main className="wand-settings-library-page" data-testid="settings-page"
      aria-labelledby="settings-page-title">
      <header className="wand-settings-library-page-heading"><h1 id="settings-page-title">系统设置</h1></header>
      <div className="wand-settings-library-page-content">{content}</div>
    </main></WandUiProvider>;
  }
  return (
    <WandUiProvider><WandDialogSurface
      open={controller.open}
      onOpenChange={(open) => { if (!open) settingsController.close(); }}
      title="系统设置"
      className="wand-settings-library-dialog"
      overlayClassName="wand-settings-library-overlay"
      titleClassName="wand-settings-library-title"
      descriptionClassName="wand-settings-library-description"
      headerClassName="wand-settings-library-header"
      closeLabel="关闭设置"
      testId="settings-dialog"
    >{content}</WandDialogSurface></WandUiProvider>
  );
}
