import * as React from "react";
import { normalizeUserProfile, type UserProfileConfig } from "../../user-profile.js";
import { loadConfigSnapshot, peekConfigSnapshot, subscribeConfigSnapshot } from "./config-snapshot";

/**
 * 当前用户资料（显示名 + 头像）在 React 侧的只读投影。
 *
 * 真源是服务端 `/api/config` 与设置保存回执；这里只缓存一份给「还没有服务端回合」的
 * 本地临时行用，避免临时行先显示成默认的「我」、落库后才换名字。
 */

export interface UserProfileView {
  name: string;
  avatar: string;
  loaded: boolean;
}

const listeners = new Set<() => void>();
let current: UserProfileView = { name: "", avatar: "", loaded: false };

function publish(next: UserProfileView): void {
  if (next.name === current.name && next.avatar === current.avatar && next.loaded === current.loaded) return;
  current = next;
  for (const listener of listeners) listener();
}

function view(value: unknown): UserProfileView {
  const profile = normalizeUserProfile(value);
  return { name: profile?.name ?? "", avatar: profile?.avatar ?? "", loaded: true };
}

function publishFromSnapshot(): void {
  const config = peekConfigSnapshot();
  if (config) publish(view(config.userProfile));
}

const cachedConfig = peekConfigSnapshot();
if (cachedConfig) current = view(cachedConfig.userProfile);
subscribeConfigSnapshot(publishFromSnapshot);

function load(): Promise<unknown> {
  return loadConfigSnapshot()
    // 读不到就继续用默认值：署名回落到「我」不该让聊天界面报错。
    .then(publishFromSnapshot, () => {});
}

// 设置保存后服务端会广播整份配置，署名立刻跟着变，不用等下次拉取。
// 有已提交快照时由 config snapshot 合并后统一发布；没有快照时（设置页刚启动）
// 直接采用本次保存的资料，并让 snapshot 丢弃更早的在途读取。
if (typeof window !== "undefined") {
  window.addEventListener("wand-settings-config-saved", (event) => {
    if (peekConfigSnapshot()) return;
    publish(view((event as CustomEvent<{ userProfile?: unknown }>).detail?.userProfile));
  });
}

export const userProfileStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  getSnapshot(): UserProfileView {
    return current;
  },
  refresh(): void {
    void load();
  },
};

export function useUserProfile(): UserProfileView {
  const snapshot = React.useSyncExternalStore(
    userProfileStore.subscribe,
    userProfileStore.getSnapshot,
    userProfileStore.getSnapshot,
  );
  React.useEffect(() => { userProfileStore.refresh(); }, []);
  return snapshot;
}

/**
 * 纯函数形态，供非组件路径（本地临时行、文档弹层）取当前署名与头像。
 *
 * 服务端回合只带署名（`author.id === "user"`），头像一律从这里补：
 * data URL 有几十 KB，跟着每条消息传会撑大 relay 快照和会话详情。
 */
export function currentUserAuthor(): { id: string; name: string; avatar?: string } {
  return {
    id: "user",
    name: current.name || "我",
    ...(current.avatar ? { avatar: current.avatar } : {}),
  };
}

/**
 * 合并回合署名与当前资料：名字以服务端投影为准（它就是当前设置），
 * 头像用本地资料补全；回合没有 author 时回落到默认署名。
 */
export function selfAuthorFor(turn: { role: string; author?: { id: string; name: string; avatar?: string } | null } | null | undefined
): { id: string; name: string; avatar?: string } {
  const fallback = currentUserAuthor();
  if (turn?.role !== "user") return { id: "", name: "", avatar: fallback.avatar };
  const author = turn.author;
  if (!author || author.id !== "user") return fallback;
  return { ...fallback, name: current.loaded ? fallback.name : author.name || fallback.name };
}

export type { UserProfileConfig };