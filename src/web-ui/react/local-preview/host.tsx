import { type FormEvent, useSyncExternalStore } from "react";
import * as React from "react";

import { WandButton, WandDialogSurface } from "../ui";
import { classNames } from "../ui/class-names";
import {
  localPreviewController,
  type LocalPreviewMode,
} from "./controller";

function ModeToggle({
  mode,
  onMode,
}: {
  mode: LocalPreviewMode;
  onMode(mode: LocalPreviewMode): void;
}) {
  return (
    <div className="wand-local-preview-modes" role="tablist" aria-label="预览类型">
      {(["url", "file"] as const).map((item) => (
        <button
          key={item}
          className={classNames("wand-local-preview-mode", mode === item && "active")}
          role="tab"
          aria-selected={mode === item}
          type="button"
          onClick={() => onMode(item)}
        >
          {item === "url" ? "Web 服务" : "本地文件"}
        </button>
      ))}
    </div>
  );
}

export function LocalPreviewHost() {
  const snapshot = useSyncExternalStore(
    localPreviewController.subscribe,
    localPreviewController.getSnapshot,
    localPreviewController.getSnapshot,
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    localPreviewController.submit();
  }

  return (
    <WandDialogSurface
      open={snapshot.open}
      onOpenChange={(open) => {
        if (!open) localPreviewController.close();
      }}
      title="本地预览"
      description="把本机 HTTP 服务或 HTML 目录安全地显示在 Wand 当前页面。"
      className="wand-local-preview-content"
      closeLabel="关闭预览"
    >
      <form className="wand-local-preview-form" onSubmit={submit}>
        <ModeToggle
          mode={snapshot.mode}
          onMode={(mode) => localPreviewController.setMode(mode)}
        />
        <label className="wand-local-preview-field">
          <span>{snapshot.mode === "url" ? "端口或地址" : "文件 / 目录"}</span>
          <input
            data-wand-autofocus
            value={snapshot.value}
            placeholder={snapshot.mode === "url" ? "3000 或 localhost:3000/path" : "/path/to/dist/index.html"}
            onChange={(event) => localPreviewController.setValue(event.currentTarget.value)}
          />
        </label>
        {snapshot.error && (
          <p className="wand-local-preview-error" role="alert">{snapshot.error}</p>
        )}
        <div className="wand-local-preview-actions">
          <WandButton kind="primary" type="submit" size="small">
            {snapshot.previewUrl ? "重新打开" : "打开预览"}
          </WandButton>
        </div>
      </form>
      {snapshot.previewUrl ? (
        <iframe
          key={snapshot.previewUrl}
          className="wand-local-preview-frame"
          src={snapshot.previewUrl}
          title={`本地预览：${snapshot.sourceLabel}`}
          sandbox="allow-scripts allow-forms allow-popups allow-modals"
        />
      ) : (
        <div className="wand-local-preview-empty">
          输入开发服务端口，例如 <code>3000</code>；也可以选择一个包含 <code>index.html</code> 的目录。
        </div>
      )}
    </WandDialogSurface>
  );
}
