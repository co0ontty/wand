import { isClientSettingsPage } from "../../page.js";
import { Alert, Collapse, Form, Skeleton } from "antd";
import { WandUiProvider } from "../theme";
import { installSettingsLibraryStyles } from "./styles";
import { SpeechSettingsTab } from "./speech-panel";
import { LocalModelsSettingsTab } from "./local-models-panel";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as React from "react";
import { useSyncExternalStore } from "react";
import { wandOverlay } from "../overlay-controller";
import { WandBadge, WandButton, WandIcon, WandIconButton } from "../ui";
import { hasOpenPopupSurface } from "../ui/popup-lifecycle";
import { settingsController, settingsStore } from "./controller";
import { SettingsDirectory, SETTINGS_SECTIONS } from "./navigation";
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

// Install feature geometry before its first render, as the task-page owner does.
if (typeof document !== "undefined") installSettingsLibraryStyles();

export interface SettingsHostProps {
  repository?: SettingsRepository;
  showRestart?: () => void;
  presentation?: "workspace" | "page";
}

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
        <span>{clientAuth ? "客户端连接" : snapshot.access === "admin" ? "管理员" : "App 连接"} · {PLATFORM_LABELS[snapshot.platform.kind]}</span>
        {snapshot.about.updateChannel === "beta" ? <WandBadge tone="warning">Beta</WandBadge> : null}
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
  presentation = "workspace",
}: SettingsHostProps) {
  const pageRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const directoryRef = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && window.innerWidth < 720);
  const [query, setQuery] = useState("");
  const [visited, setVisited] = useState<SettingsTab[]>([]);
  const controller = useSyncExternalStore(
    settingsStore.subscribe,
    settingsStore.getSnapshot,
    settingsStore.getSnapshot,
  );
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
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

  const contentByTab = useMemo(() => {
    if (!snapshot) return null;
    const props = { snapshot, repository, refresh, setSnapshot, toast, showRestart };
    const panels: Record<SettingsTab, ReactNode> = {
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
    return panels;
  }, [refresh, repository, showRestart, snapshot, toast]);

  const available = snapshot?.access === "admin" ? ADMIN_TAB_ORDER : CONNECTED_APP_TAB_ORDER;

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
  useLayoutEffect(() => {
    if (!isOpen || !pageRef.current) return;
    const page = pageRef.current;
    const sync = (): void => {
      const value = page.clientWidth < 720;
      setCompact(value);
      settingsStore.setCompact(value);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(page);
    return () => observer.disconnect();
  }, [isOpen]);

  useEffect(() => {
    if (!snapshot || (compact && !controller.detail)) return;
    setVisited((current) => current.includes(selectedTab) ? current : [...current, selectedTab]);
  }, [snapshot, compact, controller.detail, selectedTab]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    titleRef.current?.focus({ preventScroll: true });
    return () => {
      if (presentation === "workspace" && (pageRef.current?.contains(document.activeElement) || document.activeElement === document.body)) {
        trigger?.focus({ preventScroll: true });
      }
    };
  }, [isOpen, presentation]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    if (!compact || controller.detail) titleRef.current?.focus({ preventScroll: true });
    else directoryRef.current?.querySelector<HTMLElement>(".ant-menu-item-selected")?.focus({ preventScroll: true });
  }, [isOpen, compact, controller.detail, selectedTab]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      // Inspect nested ownership before the child's Escape handler changes its state.
      if (settingsStore.getSnapshot().nested !== null || hasOpenPopupSurface()) return;
      if (compact && controller.detail) settingsStore.showDirectory();
      else if (presentation === "workspace") settingsController.close();
      else return;
      event.preventDefault();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [isOpen, compact, controller.detail, presentation]);

  const select = (tab: SettingsTab): void => {
    setVisited((current) => current.includes(tab) ? current : [...current, tab]);
    settingsStore.setTab(tab);
  };
  const directoryVisible = !compact || !controller.detail;
  const title = compact && controller.detail ? SETTINGS_SECTIONS[selectedTab].label : "系统设置";
  const Tag = presentation === "page" ? "main" : "section";
  return <WandUiProvider><Tag ref={pageRef} className="wand-settings-library-page" data-testid="settings-page"
    data-presentation={presentation} data-compact={compact} data-detail={controller.detail}
    hidden={!isOpen} inert={!isOpen} aria-labelledby="settings-page-title">
    <header className="wand-settings-library-page-heading">
      <div className="wand-settings-library-page-title">
        {compact && controller.detail ? <WandIconButton aria-label="返回设置目录" title="返回设置目录" onClick={() => settingsStore.showDirectory()}>
          <WandIcon name="chevronLeft" size={18}/>
        </WandIconButton> : presentation === "workspace" ? <WandIconButton aria-label="返回工作台" title="返回工作台" onClick={() => settingsController.close()}>
          <WandIcon name="chevronLeft" size={18}/>
        </WandIconButton> : null}
        <h1 id="settings-page-title" ref={titleRef} tabIndex={-1}>{title}</h1>
      </div>
      {snapshot ? <SettingsOverview snapshot={snapshot} clientAuth={clientAuth}/>
        : <section className="wand-settings-library-overview" aria-label="设置加载状态">
          <span>{loading ? "正在加载设置…" : "连接信息暂不可用"}</span>
        </section>}
    </header>
    {loadError && snapshot ? <div className="wand-settings-library-refresh-error">
      <SettingsStatus tone="error"><span>刷新设置失败，当前内容已保留。{loadError}</span>
        <WandButton size="small" disabled={loading} aria-busy={loading} onClick={() => void refresh()}>重新加载</WandButton>
      </SettingsStatus>
    </div> : null}
    {loginRequired && !clientAuth ? <div className="wand-settings-library-page-content">
      <div className="wand-settings-library-access-page"><ConnectedAppAccess repository={repository} signedOut allowEmptyPassword
        onAuthenticated={onAuthenticated}/></div>
    </div> : snapshot && contentByTab ? <div className="wand-settings-library-page-content">
      <nav ref={directoryRef} className="wand-settings-library-directory" aria-label="设置目录" hidden={!directoryVisible}>
        <SettingsDirectory available={available} selected={selectedTab} query={query} onQuery={setQuery} onSelect={select}/>
        {snapshot.access === "read-only" && !loginRequired && !clientAuth ? <Collapse className="wand-settings-library-access"
          ghost items={[{ key: "admin", label: "登录管理设置", children: <ConnectedAppAccess repository={repository}
            allowEmptyPassword={presentation === "page"} onAuthenticated={onAuthenticated}/> }]}/> : null}
      </nav>
      <div className="wand-settings-library-details" hidden={compact && !controller.detail}>
        {available.filter((tab) => visited.includes(tab) || (!compact || controller.detail) && tab === selectedTab).map((tab) => <div
          key={tab} className="wand-settings-library-detail-scroll" data-settings-panel={tab}
          hidden={tab !== selectedTab} inert={tab !== selectedTab} role="region" aria-label={SETTINGS_SECTIONS[tab].label}>
          <div className="wand-settings-library-detail-content">{contentByTab[tab]}</div>
        </div>)}
      </div>
    </div> : loading ? <div className="wand-settings-library-page-content" aria-busy="true">
      <nav className="wand-settings-library-directory" aria-label="设置目录" hidden={!directoryVisible}>
        <SettingsLoading/>
      </nav>
      <div className="wand-settings-library-details" hidden={compact && !controller.detail}>
        <div className="wand-settings-library-detail-scroll"><div className="wand-settings-library-detail-content">
          <SettingsLoading/>
        </div></div>
      </div>
    </div> : loadError ? <div className="wand-settings-library-page-content">
      <nav className="wand-settings-library-directory" aria-hidden="true" hidden={!directoryVisible}/>
      <div className="wand-settings-library-details"><div className="wand-settings-library-detail-scroll">
        <div className="wand-settings-library-detail-content" role="alert"><p>{loadError}</p>
          <WandButton kind="primary" onClick={() => void load()}>重试加载设置</WandButton>
        </div>
      </div></div>
    </div> : null}
  </Tag></WandUiProvider>;
}
