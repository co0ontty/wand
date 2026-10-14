import * as React from "react";
import { createPortal } from "react-dom";
import { Card } from "antd";
import { WandButton, WandIcon, isWandPopupOwnedBy } from "../ui";
import { WandUiBoundary } from "../theme";
import { deferredComponent } from "../deferred-feature";
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

/** Pending/error content stays in the existing owned Portal, not a new modal. */
function PendingPanel({ mount, children }: { mount: PiSettingsMount; children: React.ReactNode }): React.ReactElement {
  React.useEffect(() => {
    if (!mount.open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (mount.target.contains(target) || mount.toggleTarget.contains(target)
        || target?.closest("#input-box") || isWandPopupOwnedBy(target, `wand-pi-codemode-${mount.sessionId}`)) return;
      piSettingsController.dismiss();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault(); event.stopPropagation(); piSettingsController.dismiss(); mount.returnFocus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [mount.open, mount.target, mount.toggleTarget, mount.returnFocus, mount.sessionId]);
  return <WandUiBoundary><div className="wand-pi-settings wand-pi-settings-inner is-open" id={panelId(mount)}
    style={{ pointerEvents: "auto" }} role="region" aria-label="会话功能设置" data-wand-popup-owner={`wand-pi-settings-${mount.sessionId}`} data-wand-ui-root="">
    <Card size="small" title="会话功能设置" extra={<WandButton kind="ghost" aria-label="关闭会话功能设置"
      onClick={() => { piSettingsController.dismiss(); mount.returnFocus(); }}><WandIcon name="close" size={15}/></WandButton>}>
      {children}
    </Card>
  </div></WandUiBoundary>;
}

const DeferredPanel = deferredComponent(
  () => import("./panel").then(module => module.PiSettingsPanel),
  { title: "会话功能设置", renderPending: (status, { mount }) => <PendingPanel mount={mount}>{status}</PendingPanel> },
);

export function PiSettingsHost(): React.ReactElement[] {
  const snapshot = React.useSyncExternalStore(piSettingsController.subscribe, piSettingsController.getSnapshot, piSettingsController.getSnapshot);
  return snapshot.mounts.flatMap((mount) => [
    createPortal(<PiSettingsToggle key={`${mount.sessionId}-toggle`} mount={mount}/>, mount.toggleTarget, `${mount.key}-toggle`),
    createPortal(<DeferredPanel key={mount.sessionId} mount={mount} enabled={mount.open}/>, mount.target, mount.key),
  ]);
}
