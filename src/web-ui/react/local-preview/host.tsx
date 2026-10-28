import { Alert, Button, Card, Empty, Flex, Form, Segmented, Spin, Typography } from "antd";
import { type FormEvent, useSyncExternalStore } from "react";
import * as React from "react";

import { WandButton, WandDialogSurface, WandInput } from "../ui";
import { localPreviewController, type LocalPreviewMode } from "./controller";
import { HTML_PREVIEW_SANDBOX } from "./inline";
import { NonHtmlPreviewResponse, probeHtmlPreview } from "./repository";

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
  const [revision, retry] = React.useReducer((n: number) => n + 1, 0);
  const [load, setLoad] = React.useState<{ key: string; ready?: boolean; error?: string; file?: boolean }>({ key: "" });
  const loadKey = `${snapshot.previewUrl}:${revision}:${snapshot.open}`;
  React.useEffect(() => {
    if (!snapshot.open || !snapshot.previewUrl) return;
    const abort = new AbortController();
    setLoad({ key: loadKey });
    void probeHtmlPreview(snapshot.previewUrl, abort.signal).then(() => {
      if (!abort.signal.aborted) setLoad({ key: loadKey, ready: true });
    }).catch(error => {
      if (!abort.signal.aborted) setLoad({ key: loadKey, file: error instanceof NonHtmlPreviewResponse, error: error instanceof Error ? error.message : "无法加载预览" });
    });
    return () => abort.abort();
  }, [snapshot.open, snapshot.previewUrl, loadKey]);
  const current = load.key === loadKey ? load : { key: loadKey };

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    localPreviewController.submit();
    retry();
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
        current.file ? <Alert type="info" showIcon title="文件已就绪" description="这个链接返回的是文件，可下载后用对应应用打开。" action={<Button size="small" href={snapshot.previewUrl} download>下载文件</Button>}/>
        : current.error ? <Alert className="wand-local-preview-load-error" type="error" showIcon title="预览未能打开" description={current.error} action={<WandButton size="small" onClick={retry}>重试</WandButton>} /> : current.ready ? <iframe
          key={loadKey}
          className="wand-local-preview-frame"
          style={{ flex: 1, minHeight: 0, width: "100%", border: 0 }}
          src={snapshot.previewUrl}
          title={`本地预览：${snapshot.sourceLabel}`}
          sandbox={HTML_PREVIEW_SANDBOX}
          referrerPolicy="no-referrer"
        /> : <Flex role="status" align="center" justify="center" gap="small" style={{ flex: 1 }}><Spin size="small"/><Typography.Text type="secondary">正在加载预览…</Typography.Text></Flex>
      ) : (
        <Card className="wand-local-preview-empty" style={{ flex: 1, minHeight: 0 }} styles={{ body: { display: "grid", placeItems: "center", height: "100%" } }}>
          <Empty description={<Typography.Text type="secondary">输入开发服务端口，例如 <Typography.Text code>3000</Typography.Text>；也可以选择一个包含 <Typography.Text code>index.html</Typography.Text> 的目录。</Typography.Text>} />
        </Card>
      )}
    </WandDialogSurface>
  );
}
