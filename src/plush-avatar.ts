/** Shared, versioned employee avatar contract. Keep v1 option IDs and seed rules stable across clients. */
export const PLUSH_SHAPES = [
  { id: "heart", label: "心形" },
  { id: "triangle", label: "圆角三角" },
  { id: "diamond", label: "菱形" },
  { id: "round", label: "圆形" },
  { id: "square", label: "圆角方形" },
  { id: "capsule", label: "胶囊" },
] as const;

export const PLUSH_COLORS = [
  { id: "coral", label: "珊瑚", color: "#E99589" },
  { id: "sage", label: "灰绿", color: "#A9BDA7" },
  { id: "lavender", label: "淡紫", color: "#BFB0D9" },
  { id: "cream", label: "奶油", color: "#E8D8B8" },
  { id: "blue", label: "雾蓝", color: "#A9C6D5" },
  { id: "ochre", label: "赭黄", color: "#D4AE65" },
] as const;

export const PLUSH_GLASSES = [
  { id: "none", label: "无眼镜" },
  { id: "gold", label: "金框眼镜" },
  { id: "ink", label: "黑框眼镜" },
] as const;

export const PLUSH_HATS = [
  { id: "none", label: "无帽子" },
  { id: "beanie", label: "针织帽" },
  { id: "beret", label: "贝雷帽" },
] as const;

export type PlushShape = typeof PLUSH_SHAPES[number]["id"];
export type PlushColor = typeof PLUSH_COLORS[number]["id"];
export type PlushGlasses = typeof PLUSH_GLASSES[number]["id"];
export type PlushHat = typeof PLUSH_HATS[number]["id"];

export interface PlushAvatarConfig {
  version: 1;
  shape: PlushShape;
  color: PlushColor;
  glasses: PlushGlasses;
  hat: PlushHat;
}

export interface PlushAvatarIdentity {
  id?: string | null;
  name?: string | null;
  avatar?: string | null;
}

function hasId<T extends string>(options: ReadonlyArray<{ id: T }>, id: string): id is T {
  return options.some(option => option.id === id);
}

/** Only the exact known v1 contract is accepted for explicit configuration; no URL or future-version guessing. */
export function parsePlushAvatar(value: string): PlushAvatarConfig | null {
  const parts = value.split(":");
  if (parts.length !== 6 || parts[0] !== "plush" || parts[1] !== "v1") return null;
  const [, , shape, color, glasses, hat] = parts;
  if (!hasId(PLUSH_SHAPES, shape) || !hasId(PLUSH_COLORS, color)
    || !hasId(PLUSH_GLASSES, glasses) || !hasId(PLUSH_HATS, hat)) return null;
  return { version: 1, shape, color, glasses, hat };
}

export function encodePlushAvatar(config: PlushAvatarConfig): string {
  const value = `plush:v${config.version}:${config.shape}:${config.color}:${config.glasses}:${config.hat}`;
  if (!parsePlushAvatar(value)) throw new Error("毛绒头像配置无效。");
  return value;
}

/** FNV-1a followed by an avalanche: fixed 32-bit integer math, shared by Node and browsers. */
function seedHash(seed: string): number {
  let hash = 0x811c9dc5;
  for (let at = 0; at < seed.length; at += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(at), 0x01000193);
  }
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** Pure presentation default; never persist this from a GET, a render, or a preview. */
export function defaultPlushAvatar({ id, name }: Pick<PlushAvatarIdentity, "id" | "name">): PlushAvatarConfig {
  const identity = (id ?? "").trim() || (name ?? "").trim() || "member";
  const pick = <T extends string>(field: string, options: ReadonlyArray<{ id: T }>): T =>
    options[seedHash(`plush:v1:${identity}:${field}`) % options.length]!.id;
  return {
    version: 1,
    shape: pick("shape", PLUSH_SHAPES),
    color: pick("color", PLUSH_COLORS),
    glasses: pick("glasses", PLUSH_GLASSES),
    hat: pick("hat", PLUSH_HATS),
  };
}

/** Uploaded photos and explicit legacy cats keep their renderer; corrupt old values fall back without migration. */
export function resolvePlushAvatar(identity: PlushAvatarIdentity): PlushAvatarConfig | null {
  const avatar = identity.avatar ?? "";
  if (avatar.startsWith("data:image/") || /^cat:\d+$/.test(avatar)) return null;
  return parsePlushAvatar(avatar) ?? defaultPlushAvatar(identity);
}
