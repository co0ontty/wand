import * as React from "react";
import { createRoot } from "react-dom/client";
import { Alert, Flex, Spin } from "antd";
import { WandButton } from "../react/ui/button";
import { WandUiBoundary } from "../react/theme";

/** One transient feedback root; message rendering remains in its canonical owner. */
export function mountChatLoadState(host: HTMLElement, failed: boolean, retry: () => void): () => void {
  const node = document.createElement("div");
  node.dataset.chatLoadState = failed ? "failed" : "loading";
  host.replaceChildren(node);
  const root = createRoot(node);
  root.render(<WandUiBoundary><Flex vertical gap="small" style={{ padding: "var(--wand-page-inset)", minHeight: 144 }} aria-busy={!failed}>
    {failed ? <>
      <Alert type="error" showIcon title="会话组件加载失败，请检查网络；服务更新后可能需要重新加载页面。"/>
      <Flex gap="small"><WandButton onClick={retry}>重试</WandButton>
        <WandButton onClick={() => window.location.reload()}>重新加载页面</WandButton></Flex>
    </> : <Flex align="center" gap="small" role="status"><Spin/>正在加载会话组件…</Flex>}
  </Flex></WandUiBoundary>);
  return () => { root.unmount(); node.remove(); };
}
