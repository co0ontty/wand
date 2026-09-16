import { useSyncExternalStore } from "react";
import * as React from "react";
import { createPortal } from "react-dom";
import { WandIcon } from "../ui";
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
    <div
      className={`composer-config-controls composer-config-controls-${scope}`}
      data-config-scope={scope}
      role="group"
      aria-label={ariaLabelFor(scope)}
      title={mount.groupTitle}
    >
      {showMode && (
        <span
          className="composer-config-chip composer-config-chip-mode"
          data-mode-control-pill="mode"
          title={`模式：${mount.modeLabel}`}
        >
          <WandIcon name="sliders" size={13} strokeWidth={1.8} className="composer-config-icon" />
          {selectHost(scope, "mode")}
        </span>
      )}
      {showRuntime && (
        <>
          <span
            className="composer-config-chip composer-config-model"
            data-mode-control-pill="model"
            title={`模型：${mount.modelFullLabel}`}
          >
            <WandIcon name="cpu" size={13} strokeWidth={1.8} className="composer-config-icon" />
            {selectHost(scope, "model")}
          </span>
          {showModelRefresh && (
            <button
              className={`model-refresh-button composer-model-refresh-button${mount.modelRefreshing ? " is-refreshing" : ""}`}
              type="button"
              data-models-refresh=""
              data-models-refresh-scope={scope}
              aria-label={mount.modelRefreshing ? "正在刷新模型列表" : "刷新模型列表"}
              title={mount.modelRefreshing ? "正在刷新模型列表" : "刷新模型列表"}
              aria-busy={mount.modelRefreshing ? "true" : "false"}
              disabled={mount.modelRefreshing}
              onClick={mount.onRefreshModels}
            >
              <WandIcon name="refresh" size={13} strokeWidth={1.9} className="model-refresh-icon" />
              <span className="model-refresh-label">刷新模型列表</span>
            </button>
          )}
          <span
            className="composer-config-chip composer-config-thinking"
            data-mode-control-pill="thinking"
            data-thinking={mount.thinkingValue}
            title={`思考深度：${mount.thinkingLabel}`}
          >
            <WandIcon name="brain" size={13} strokeWidth={1.8} className="composer-config-icon" />
            {selectHost(scope, "thinking")}
          </span>
        </>
      )}
      {scope === "all" && mount.skillsVisible && (
        <button
          className="composer-config-chip composer-config-skills"
          type="button"
          data-claude-skills-trigger=""
          aria-haspopup="dialog"
          aria-expanded={mount.skillsExpanded ? "true" : "false"}
          title={mount.skillsTitle}
          onClick={(event) => mount.onOpenSkills(event.currentTarget)}
        >
          {mount.skillsLabel}
        </button>
      )}
    </div>
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
