import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ResizeInput, SenderProjection } from "../react/composer-sender/host.js";
import { WandUiProvider } from "../react/theme";
import { installStyleSheet } from "../react/styles";
import { composer, state } from "./state.js";
import { ComposerUsage } from "../react/composer-sender/identity.js";
import { ComposerEmployeeButton } from "../react/composer-sender/employee.js";
import { employeeProfile } from "../react/agents/employee-profile-state.js";
import { computeRunningSignal } from "../session-activity.js";
import { latestChatUsage } from "../chat-message-meta.js";
import { renderStructuredStatusBar } from "./utils.js";
interface Mount { root: Root; input: HTMLTextAreaElement; chrome: HTMLElement; }
const roots = new Map<HTMLElement, Mount>();
const avatarRoots = new Map<HTMLElement, Root>();
// Sender 只在结构化会话里出现，而它会把整套 @ant-design/x 拖进首屏 eager runtime。
// 这里按需取：原生输入框、草稿与提交路径都不依赖它，迟到渲染不影响真实状态。
type ComposerHostModule = typeof import("../react/composer-sender/host.js");
let hostModule: ComposerHostModule | null = null;
let hostPending: Promise<ComposerHostModule> | null = null;
let hostRetry: ResizeInput | null = null;
function loadComposerHost(): Promise<ComposerHostModule> {
  if (hostModule) return Promise.resolve(hostModule);
  if (!hostPending) {
    hostPending = import("../react/composer-sender/host.js").then(module => {
      hostModule = module;
      hostPending = null;
      return module;
    }, error => {
      hostPending = null;
      throw error;
    });
  }
  return hostPending;
}
// 旧版 composer 面板（外壳 + 样式）同样只在真正挂载输入区时才需要，
// 它带的 Card 与 composer 样式不该常驻首屏 runtime。
type ComposerSurfacesModule = typeof import("./composer-surface-adapter");
let surfacesModule: ComposerSurfacesModule | null = null;
let surfacesPending: Promise<ComposerSurfacesModule> | null = null;
function loadComposerSurfaces(): Promise<ComposerSurfacesModule> {
  if (surfacesModule) return Promise.resolve(surfacesModule);
  if (!surfacesPending) {
    surfacesPending = import("./composer-surface-adapter").then(module => {
      surfacesModule = module;
      surfacesPending = null;
      return module;
    }, error => {
      surfacesPending = null;
      throw error;
    });
  }
  return surfacesPending;
}
const projection: SenderProjection = {
  subscribe: composer.subscribe.bind(composer),
  revision: () => composer.read(state.selectedId).revision,
  text: () => composer.read(state.selectedId).text,
  isComposing: () => state.composerComposing,
};

export function syncComposerCompanion(): void {
  for (const [host, root] of avatarRoots) if (!host.isConnected) { root.unmount(); avatarRoots.delete(host); }
  const avatarHost = document.querySelector<HTMLElement>("[data-composer-avatar-host]");
  const session = state.sessions.find(session => session.id === state.selectedId);
  const activity = session ? { ...session, ptyRunning: computeRunningSignal(session).ptyRunning,
    turnStartedAt: session.ptyTurnStartedAt, lastActivityAt: session.ptyLastActivityAt } : undefined;
  if (avatarHost) {
    const root = avatarRoots.get(avatarHost) ?? createRoot(avatarHost);
    avatarRoots.set(avatarHost, root);
    flushSync(() => root.render(<ComposerUsage employeeName={session?.employeeId ? session.employeeName || "员工" : undefined}
      usage={latestChatUsage(session?.messages ?? [])} activity={activity} legacyStatus={session?.sessionKind === "structured"}/>));
    renderStructuredStatusBar(null, session);
  }
  const employeeHost = document.querySelector<HTMLElement>("[data-composer-employee-host]");
  if (employeeHost) {
    const root = avatarRoots.get(employeeHost) ?? createRoot(employeeHost);
    avatarRoots.set(employeeHost, root);
    const employee = session?.employeeId ? { id: session.employeeId, name: session.employeeName || "员工", avatar: session.employeeAvatar } : null;
    flushSync(() => root.render(<WandUiProvider>{employee ? <ComposerEmployeeButton employee={employee}
      onClick={event => employeeProfile.open(employee, event.currentTarget)}/> : null}</WandUiProvider>));
  }
}

export function mountComposerSender(resize: ResizeInput): void {
  if (!surfacesModule) {
    // 面板实现还在路上：先挂起这次挂载，到达后按当前会话状态重放一次。
    hostRetry = resize;
    void loadComposerSurfaces().then(() => {
      const pending = hostRetry;
      hostRetry = null;
      if (pending) mountComposerSender(pending);
    }, () => { hostRetry = null; });
    return;
  }
  surfacesModule.mountComposerSurfaces();
  syncComposerCompanion();
  const session = state.sessions.find(session => session.id === state.selectedId);
  installStyleSheet("wand-sender-owned-input", `[data-composer-sender] .ant-sender-input { width:100%; }`);
  for (const [target, mount] of roots) if (!target.isConnected) { mount.root.unmount(); roots.delete(target); }
  const target = document.querySelector<HTMLElement>("[data-composer-sender]");
  if (!target) return;
  const structured = session?.sessionKind === "structured";
  const previous = roots.get(target);
  if (!structured) {
    if (previous) {
      const active = document.activeElement === previous.input;
      const parent = target as HTMLElement & { moveBefore?(node: Node, child: Node | null): void };
      if (parent.moveBefore) parent.moveBefore(previous.input, null);
      else { target.appendChild(previous.input); if (active) previous.input.focus({ preventScroll: true }); }
      previous.root.unmount(); previous.chrome.remove(); roots.delete(target);
      previous.input.className = "input-textarea";
    }
    return;
  }
  if (previous) return;
  if (!hostModule) {
    // 组件还没到：先挂起这次挂载，模块到达后按当前会话状态重放一次。
    hostRetry = resize;
    void loadComposerHost().then(() => {
      const pending = hostRetry;
      hostRetry = null;
      if (pending) mountComposerSender(pending);
    }, () => { hostRetry = null; });
    return;
  }
  const input = target.querySelector<HTMLTextAreaElement>("#input-box");
  if (!input) return;
  const chrome = document.createElement("div"); target.appendChild(chrome);
  const root = createRoot(chrome); roots.set(target, { root, chrome, input });
  const { ComposerSender } = hostModule;
  flushSync(() => root.render(<WandUiProvider><ComposerSender input={input} resize={resize} projection={projection}/></WandUiProvider>));
}
