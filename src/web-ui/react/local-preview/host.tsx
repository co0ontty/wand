import { Alert, Card, Empty, Flex, Form, Segmented, Typography } from "antd";
import { type FormEvent, useSyncExternalStore } from "react";
import * as React from "react";

import { WandButton, WandDialogSurface, WandInput } from "../ui";
import { localPreviewController, type LocalPreviewMode } from "./controller";

const PREVIEW_MODES: ReadonlyArray<{ value: LocalPreviewMode; label: string }> = [
  { value: "url", label: "Web 服务" },
  { value: "file", label: "本地文件" },
];

function ModeToggle({
  mode,
  onMode,
}: {
  mode: LocalPreviewMode;
  onMode(mode: LocalPreviewMode): void;
}) {
  return (
    <Segmented
      className="wand-local-preview-modes"
      aria-label="预览类型"
      value={mode}
      options={PREVIEW_MODES.map((item) => ({ value: item.value, label: item.label }))}
      onChange={(value) => onMode(value as LocalPreviewMode)}
    />
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
      width={{ xs: "calc(100vw - 16px)", md: 960, xl: 1180 }}
      styles={{ body: { display: "flex", flexDirection: "column", gap: 12, height: "min(75dvh, 760px)", minHeight: 0 } }}
      closeLabel="关闭预览"
    >
      <Form noValidate layout="vertical" className="wand-local-preview-form" onSubmitCapture={submit}>
        <ModeToggle
          mode={snapshot.mode}
          onMode={(mode) => localPreviewController.setMode(mode)}
        />
        <Form.Item className="wand-local-preview-field" label={snapshot.mode === "url" ? "端口或地址" : "文件 / 目录"} style={{ marginBlock: 12 }}>
          <WandInput
            aria-label={snapshot.mode === "url" ? "端口或地址" : "文件 / 目录"}
            data-wand-autofocus
            value={snapshot.value}
            placeholder={snapshot.mode === "url" ? "3000 或 localhost:3000/path" : "/path/to/dist/index.html"}
            onChange={(event) => localPreviewController.setValue(event.currentTarget.value)}
          />
        </Form.Item>
        {snapshot.error && (
          <Alert className="wand-local-preview-error" type="error" showIcon title={snapshot.error} />
        )}
        <Flex className="wand-local-preview-actions" gap="small">
          <WandButton kind="primary" type="submit" size="small">
            {snapshot.previewUrl ? "重新打开" : "打开预览"}
          </WandButton>
        </Flex>
      </Form>
      {snapshot.previewUrl ? (
        <iframe
          key={snapshot.previewUrl}
          className="wand-local-preview-frame"
          style={{ flex: 1, minHeight: 0, width: "100%", border: 0 }}
          src={snapshot.previewUrl}
          title={`本地预览：${snapshot.sourceLabel}`}
          sandbox="allow-scripts allow-forms allow-popups allow-modals"
        />
      ) : (
        <Card className="wand-local-preview-empty" style={{ flex: 1, minHeight: 0 }} styles={{ body: { display: "grid", placeItems: "center", height: "100%" } }}>
          <Empty description={<Typography.Text type="secondary">输入开发服务端口，例如 <Typography.Text code>3000</Typography.Text>；也可以选择一个包含 <Typography.Text code>index.html</Typography.Text> 的目录。</Typography.Text>} />
        </Card>
      )}
    </WandDialogSurface>
  );
}
