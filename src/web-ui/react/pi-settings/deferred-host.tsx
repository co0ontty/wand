import * as React from "react";
import { createPortal } from "react-dom";
import { WandButton } from "../ui/button";
import { WandIcon } from "../ui/icons";
import { piSettingsController, type PiSettingsMount } from "./controller";

const panelId = (mount: PiSettingsMount): string => `wand-pi-settings-panel-${mount.sessionId}`;

function PiSettingsToggle({ mount }: { mount: PiSettingsMount }): React.ReactElement {
  const open = mount.open;
  return <WandButton kind="ghost" type="button" className="btn-circle btn-circle-action composer-pi-settings-toggle"
    data-open={open ? "true" : "false"} aria-expanded={open} aria-controls={panelId(mount)}
    aria-label={open ? "收起会话功能设置" : "会话功能设置：CodeMode / Skills / MCP"}
    title={open ? "收起会话功能设置" : "会话功能设置：CodeMode / Skills / MCP"}
    onClick={() => { piSettingsController.toggle(mount.sessionId); }}>
    <WandIcon name={open ? "close" : "gear"} size={17} strokeWidth={1.9}/>
  </WandButton>;
}

/**
 * 会话功能设置：开关按钮常驻，面板本体（antd Card）只在真的打开时才下载。
 */
export function PiSettingsHost(): React.ReactElement[] {
  const snapshot = React.useSyncExternalStore(piSettingsController.subscribe, piSettingsController.getSnapshot, piSettingsController.getSnapshot);
  const [PanelHost, setPanelHost] = React.useState<React.ComponentType<{ mount: PiSettingsMount }> | null>(null);
  const opened = snapshot.mounts.some(mount => mount.open);
  React.useEffect(() => {
    if (!opened || PanelHost) return;
    let alive = true;
    void import("./panel-host").then(module => {
      if (alive) setPanelHost(() => module.PiSettingsPanelHost);
    });
    return () => { alive = false; };
  }, [opened, PanelHost]);
  return snapshot.mounts.flatMap((mount) => [
    createPortal(<PiSettingsToggle key={`${mount.sessionId}-toggle`} mount={mount}/>, mount.toggleTarget, `${mount.key}-toggle`),
    ...(PanelHost ? [createPortal(<PanelHost key={mount.sessionId} mount={mount}/>, mount.target, mount.key)] : []),
  ]);
}
