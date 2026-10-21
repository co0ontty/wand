import * as React from "react";
import { Card } from "antd";
import { WandButton } from "../ui/button";
import { WandIcon } from "../ui/icons";
import { isWandPopupOwnedBy } from "../ui/popup-lifecycle";
import { WandUiBoundary } from "../theme";
import { deferredComponent } from "../deferred-feature";
import { piSettingsController, type PiSettingsMount } from "./controller";

const panelId = (mount: PiSettingsMount): string => `wand-pi-settings-panel-${mount.sessionId}`;

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

export function PiSettingsPanelHost({ mount }: { mount: PiSettingsMount }): React.ReactElement {
  return <DeferredPanel mount={mount} enabled={mount.open}/>;
}
