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
import type { SettingsRepository, SettingsSnapshot, SettingsTab } from "./types";

export interface SettingsHostProps {
  repository?: SettingsRepository;
  showRestart?: () => void;
}

const TAB_LABELS: Record<SettingsTab, { title: string; description: string }> = {
  general: { title: "基本配置", description: "连接、模式与运行环境" },
  ai: { title: "AI 与模型", description: "默认模型、系统 API 与 Commit" },
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
    const order = snapshot.access === "admin" ? ADMIN_TAB_ORDER : ["about" as const];
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

  return (
    <WandDialogSurface
      open={controller.open}
      onOpenChange={(open) => { if (!open) settingsController.close(); }}
      title="设置"
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
              {snapshot.access === "read-only" ? (
                <div className="wand-settings-readonly" role="note">
                  当前是 App 连接会话，仅展示版本与客户端下载信息。管理设置需要管理员登录。
                </div>
              ) : null}
              <WandTabs
                className="wand-settings-tabs"
                ariaLabel="设置分组"
                value={snapshot.access === "read-only" ? "about" : controller.tab}
                tabs={tabs}
                onValueChange={(value) => settingsStore.setTab(value as SettingsTab)}
              />
            </>
          ) : null}
    </WandDialogSurface>
  );
}
