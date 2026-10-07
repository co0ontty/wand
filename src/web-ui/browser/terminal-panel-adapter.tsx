import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { Button, Card, Flex } from "../react/design-library";
import { WandUiProvider } from "../react/theme";
import { WandIcon } from "../react/ui";
const roots = new Map<HTMLElement, Root>();

/** Key dispatch, modifiers and pointer capture remain native viewport responsibilities. */
export function paintTerminalPanel(host: HTMLElement, actions: readonly { key: string; label: string }[]): void {
  for (const [node, root] of roots) if (!node.isConnected) { root.unmount(); roots.delete(node); }
  let root = roots.get(host);
  if (!root) { root = createRoot(host); roots.set(host, root); }
  const keyButton = (key: string, label: string) => <Button key={key} className="wjp-key" data-key={key}>{label}</Button>;
  flushSync(() => root.render(<WandUiProvider><Card size="small" title="遥控面板"
    extra={<Button size="small" type="text" className="wjp-close" aria-label="关闭遥控面板" icon={<WandIcon name="close" size={13}/>}/>}>
    <Flex vertical gap="small">
      <Flex justify="center">{keyButton("up", "↑")}</Flex>
      <Flex justify="center" gap="small">{keyButton("left", "←")}{keyButton("down", "↓")}{keyButton("right", "→")}</Flex>
      <Flex wrap justify="center" gap="small">{actions.map(action => keyButton(action.key, action.label))}</Flex>
    </Flex>
  </Card></WandUiProvider>));
}
