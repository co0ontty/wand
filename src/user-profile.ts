import type { ConversationAuthor, WandConfig } from "./types.js";

/**
 * 用户自己的资料：会话里显示的名字与头像。
 *
 * 只放展示信息，不进模型输入的身份、权限或凭据。真源是 DB 里的 `pref:userProfile`
 * （见 `PREFERENCE_KEYS`），改完热生效，不需要重启。
 */
export interface UserProfileConfig {
  /** 会话里的署名。留空回落 `DEFAULT_USER_DISPLAY_NAME`，不做多套默认。 */
  name?: string;
  /** `""`（按名字生成）、`"cat:<n>"`（像素猫毛色）或 `data:image/*;base64,…`（上传图）。 */
  avatar?: string;
}

/** 未设置资料时的唯一默认署名。历史数据、客户端兜底与文案都用这一个值。 */
export const DEFAULT_USER_DISPLAY_NAME = "我";

/** 与硅基员工头像同一条白名单与上限，避免两套大小口径。 */
export const USER_AVATAR_MAX_CHARS = 60_000;
const AVATAR_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const AVATAR_CAT = /^cat:(\d{1,2})$/;

export const USER_PROFILE_NAME_MAX = 24;

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 只接受像素猫毛色与白名单 data URL；其他写法当没配，不猜也不静默改写。 */
function normalizeAvatar(value: unknown): string {
  const avatar = clean(value);
  if (!avatar || AVATAR_CAT.test(avatar) || (avatar.length <= USER_AVATAR_MAX_CHARS && AVATAR_DATA_URL.test(avatar))) {
    return avatar;
  }
  return "";
}

/** 读端归一：坏值退回未设置，绝不因为一份脏数据换出另一张脸。 */
export function normalizeUserProfile(input: unknown): UserProfileConfig | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const name = clean(raw.name).slice(0, USER_PROFILE_NAME_MAX);
  const avatar = normalizeAvatar(raw.avatar);
  if (!name && !avatar) return undefined;
  return { ...(name ? { name } : {}), ...(avatar ? { avatar } : {}) };
}

/** 写端校验：名字超长或头像格式不对都明确报错，由路由回 400，不静默吞掉。 */
export function parseUserProfile(input: unknown): UserProfileConfig | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const name = clean(raw.name);
  if (name.length > USER_PROFILE_NAME_MAX) {
    throw new Error(`名字不能超过 ${USER_PROFILE_NAME_MAX} 个字符。`);
  }
  if (name.includes("\n")) throw new Error("名字不能包含换行。");
  const avatarInput = raw.avatar;
  const avatar = clean(avatarInput);
  if (avatar) {
    if (!AVATAR_CAT.test(avatar) && !AVATAR_DATA_URL.test(avatar)) {
      throw new Error("头像格式无效，请重新选择或上传图片。");
    }
    if (avatar.length > USER_AVATAR_MAX_CHARS) throw new Error("头像太大，请换一张小一点的图片。");
  }
  if (!name && !avatar) return undefined;
  return { ...(name ? { name } : {}), ...(avatar ? { avatar } : {}) };
}

/** 会话署名：只用于展示，不改变任何执行身份或权限。 */
export function userDisplayName(profile: UserProfileConfig | null | undefined): string {
  return clean(profile?.name) || DEFAULT_USER_DISPLAY_NAME;
}

/**
 * 会话里「我自己」这条发言的作者投影。
 *
 * 稳定 id 固定是 `user`；显示信息跟随当前设置解析，历史回合不批量改写
 * （员工身份与展示信息的分层与 AGENTS.md 的约定一致）。
 */
export function userAuthor(profile: UserProfileConfig | null | undefined): ConversationAuthor {
  return { id: "user", name: userDisplayName(profile) };
}

/** 从运行时配置取当前用户资料，供服务端拼预览与群内上下文时复用同一口径。 */
export function configUserProfile(config: Pick<WandConfig, "userProfile"> | null | undefined): UserProfileConfig | undefined {
  return normalizeUserProfile(config?.userProfile);
}