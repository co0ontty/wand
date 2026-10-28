import * as React from "react";
import { Alert, Button, Flex, Spin, Typography, theme } from "antd";
import { localPreviewController } from "./controller";
import { probeHtmlPreview } from "./repository";
import { HTML_PREVIEW_SANDBOX } from "../../../html-preview-policy.js";

export { HTML_PREVIEW_SANDBOX };

/** The same HTML surface is used by message projections and the file viewer.
 * Never srcdoc/innerHTML: authenticated static serving preserves relative assets.
 * No allow-same-origin, popups or navigation privileges; the response CSP
 * prevents form navigation while allowing local submit event handlers. */
export function InlineHtmlPreview({ previewUrl, downloadUrl, label = "HTML 预览" }: {
  previewUrl: string; downloadUrl: string; label?: string;
}): React.ReactElement {
  const { token } = theme.useToken();
  const [state, setState] = React.useState<{ url: string; error?: string; ready?: boolean }>({ url: "" });
  const [revision, retry] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    const abort = new AbortController();
    setState({ url: previewUrl });
    void probeHtmlPreview(previewUrl, abort.signal).then(() => {
      if (!abort.signal.aborted) setState({ url: previewUrl, ready: true });
    }).catch(error => {
      if (!abort.signal.aborted) setState({ url: previewUrl, error: error instanceof Error ? error.message : "无法加载预览" });
    });
    return () => abort.abort();
  }, [previewUrl, revision]);
  const current = state.url === previewUrl ? state : { url: previewUrl };
  return <span className="wand-inline-html-preview" style={{ display: "block", maxWidth: "100%", minWidth: 0, marginBlock: token.marginSM }}>
    <Flex align="center" justify="space-between" wrap gap={token.marginXS}>
      <Typography.Text ellipsis title={label} style={{ minWidth: 0, flex: "1 1 120px" }}>{label}</Typography.Text>
      <Flex gap={token.marginXS} wrap>
        <Button className="wand-inline-html-enlarge" size="small" href={previewUrl} onClick={event => { event.preventDefault(); localPreviewController.openPreview(previewUrl, label); }}>放大查看</Button>
        <Button size="small" href={downloadUrl} download>下载 HTML</Button>
      </Flex>
    </Flex>
    <span style={{ display: "grid", height: "min(56dvh, 480px)", minHeight: 240, marginBlockStart: token.marginXS, overflow: "hidden", border: "1px solid " + token.colorBorderSecondary, borderRadius: token.borderRadius }}>
      {current.error ? <Alert type="error" showIcon title="HTML 预览未能打开" description={current.error} action={<Button size="small" onClick={retry}>重试</Button>}/>
        : current.ready ? <iframe key={previewUrl + ":" + revision} title={label} src={previewUrl} sandbox={HTML_PREVIEW_SANDBOX} referrerPolicy="no-referrer" loading="lazy"
          style={{ width: "100%", height: "100%", minWidth: 0, border: 0 }} />
          : <Flex align="center" justify="center" gap={token.marginSM} role="status"><Spin size="small"/><Typography.Text type="secondary">正在加载 HTML 预览…</Typography.Text></Flex>}
    </span>
  </span>;
}
