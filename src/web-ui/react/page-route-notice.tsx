import * as React from "react";
import { Alert } from "antd";
import { updatePageRoute, unknownPageParameters } from "../page-route";
import { usePageSearch } from "./use-page-route";
import { WandButton } from "./ui/button";

let failure = "";
const listeners = new Set<() => void>();
export function reportPageRouteFailure(message: string): void {
  failure = message;
  listeners.forEach(listener => listener());
}
const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = (): string => failure;
const knownViews = ["taskboard", "issues", "teams", "teamchat", "schedules", "calendar", "workspace", "chats", "contacts"];

export function PageRouteNotice(): React.ReactElement | null {
  const search = usePageSearch();
  const error = React.useSyncExternalStore(subscribe, snapshot, snapshot);
  const unknown = unknownPageParameters(search);
  const params = new URLSearchParams(search);
  const invalidView = params.has("view") && !knownViews.includes(params.get("view")!);
  const settings = params.get("settings");
  const invalidSettings = settings && !["directory", "profile", "notifications", "display", "ai", "local-models", "general", "connectors", "security", "presets", "about"].includes(settings);
  const invalid = invalidView || invalidSettings;
  if (!error && !unknown.length && !invalid) return null;
  return <div style={{ flexShrink: 0, padding: 8, zIndex: 30 }}><Alert type="warning" showIcon role="alert" title={error || (invalid ? "链接中的页面或设置项无效" : "链接含有不支持的参数，已忽略")}
    action={<WandButton size="small" onClick={() => {
      reportPageRouteFailure("");
      updatePageRoute(Object.fromEntries([
        ...unknown.map(key => [key, null]),
        ...["view", "settings", "session", "workspace", "workspaceTask", "window", "tab", "conversation", "conversationTask", "conversationRun"].map(key => [key, null]),
        ["view", "workspace"],
      ]));
    }}>返回工作区</WandButton>}/></div>;
}
