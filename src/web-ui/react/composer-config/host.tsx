import { useSyncExternalStore } from "react";
import * as React from "react";
import { createPortal } from "react-dom";
import { Flex } from "antd";
import { WandIcon, WandIconButton } from "../ui";
import { composerConfigController, type ComposerConfigMount, type ComposerConfigScope } from "./controller";

function ariaLabelFor(scope: ComposerConfigScope): string {
  if (scope === "mode") return "权限模式";
  if (scope === "runtime") return "模型与思考设置";
  return "会话设置";
}

function selectHost(scope: ComposerConfigScope, control: "mode" | "model" | "thinking") {
  return (
    <span
      className="composer-config-select-host"
      data-composer-select-host=""
      data-composer-select-key={`${scope}-${control}`}
      data-composer-select-scope={scope}
      data-mode-control={control}
    />
  );
}

export function ComposerConfigControl({ mount }: { mount: ComposerConfigMount }): React.ReactElement {
  const { scope } = mount;
  const showMode = scope !== "runtime";
  const showRuntime = scope !== "mode";
  const showModelRefresh = scope !== "mode";

  return (
    <Flex align="center" gap={6} wrap style={{ flex: showRuntime ? 1 : undefined, minWidth: 0 }}
      className={`composer-config-controls composer-config-controls-${scope}`}
      data-config-scope={scope}
      role="group"
      aria-label={ariaLabelFor(scope)}
      title={mount.groupTitle}
    >
      {showMode && (
        <span
          data-mode-control-pill="mode"
          title={`模式：${mount.modeLabel}`}
        >
          {selectHost(scope, "mode")}
        </span>
      )}
      {showRuntime && (
        <>
          <span
            data-mode-control-pill="model"
            style={{ minWidth: 144 }}
            title={`模型：${mount.modelFullLabel}`}
          >
            {selectHost(scope, "model")}
          </span>
          {showModelRefresh && (
            <WandIconButton
              type="button"
              data-models-refresh=""
              data-models-refresh-scope={scope}
              aria-label={mount.modelRefreshing ? "正在刷新模型列表" : "刷新模型列表"}
              title={mount.modelRefreshing ? "正在刷新模型列表" : "刷新模型列表"}
              aria-busy={mount.modelRefreshing ? "true" : "false"}
              disabled={mount.modelRefreshing}
              onClick={mount.onRefreshModels}
            >
              <WandIcon name="refresh" size={13} strokeWidth={1.9} />
            </WandIconButton>
          )}
          <span
            data-mode-control-pill="thinking"
            style={{ minWidth: 80 }}
            data-thinking={mount.thinkingValue}
            title={`思考深度：${mount.thinkingLabel}`}
          >
            {selectHost(scope, "thinking")}
          </span>
        </>
      )}
    </Flex>
  );
}

export function ComposerConfigHost(): React.ReactElement[] {
  const snapshot = useSyncExternalStore(
    composerConfigController.subscribe,
    composerConfigController.getSnapshot,
    composerConfigController.getSnapshot,
  );

  return snapshot.mounts.map((mount) => createPortal(
    <ComposerConfigControl mount={mount} />,
    mount.target,
    mount.key,
  ));
}
