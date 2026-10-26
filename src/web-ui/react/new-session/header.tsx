import * as React from "react";
import { Flex } from "antd";
import { QuickTerminalChrome, QuickTerminalButton } from "../quick-terminal/action";
import { WandButton } from "../ui/button";
import { WandIcon } from "../ui/icons";
import { newSessionController, newSessionStore } from "./controller";

export const NewSessionHeaderProvided = React.createContext(false);

/** Eager shell chrome: loading the form/input services must not add a fallback row. */
export function NewSessionHeader() {
  const controller = React.useSyncExternalStore(newSessionStore.subscribe, newSessionStore.getSnapshot, newSessionStore.getSnapshot);
  if (!controller.open) return null;
  return <QuickTerminalChrome><Flex align="center" gap={12} className="new-work-heading unified-new-work-heading">
    <WandButton kind="ghost" aria-label="返回原页面" disabled={!controller.dismissable} onClick={() => newSessionController.close()}><WandIcon name="chevronLeft" size={18}/><span>返回</span></WandButton>
    <span className="new-work-page-label" title={controller.taskName || undefined}>{controller.taskName ? `新建工作 · ${controller.taskName}` : "新建工作"}</span>
    <div className="workbar-spacer"/><QuickTerminalButton/>
  </Flex></QuickTerminalChrome>;
}
