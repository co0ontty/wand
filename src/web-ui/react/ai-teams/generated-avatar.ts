import { hashIndex, memberCoatIndex } from "./cat-coats";

/**
 * 默认头像：用户没上传图片、也没挑过毛色时，按员工自身信息生成一张头像。
 *
 * 取值口径与像素猫一致——只有「身份」参与：配色看稳定 id（还没有 id 就看名字），
 * 字形看名字首字。职责、标签、Prompt 不进种子，改这些文案不会换掉员工的脸。
 * 显式 `cat:<n>` 是用户挑过的毛色，仍然走像素猫，不属于这里。
 */
export interface GeneratedAvatarCoat {
  name: string;
  from: string;
  to: string;
}

export const GENERATED_AVATAR_TEXT = "#FFFFFF";

/**
 * 八组渐变，两端与中点对白色文字都不低于 4.5:1（tests 逐组复算，别只改这里不改断言）。
 * 顺序固定：Android / iOS 复刻同一张表，改顺序会换掉所有人的底色。
 */
export const GENERATED_AVATAR_COATS: readonly GeneratedAvatarCoat[] = [
  { name: "赭橙", from: "#A8471F", to: "#7E3214" },
  { name: "湖蓝", from: "#2F6DB5", to: "#1F4E8A" },
  { name: "松绿", from: "#2E7D5B", to: "#1C5B41" },
  { name: "紫棠", from: "#6B4EA8", to: "#4F3883" },
  { name: "靛青", from: "#2C6E7F", to: "#1B4F5E" },
  { name: "绛红", from: "#B03A48", to: "#872633" },
  { name: "芥黄", from: "#8A6A16", to: "#674D0D" },
  { name: "石青", from: "#4A5B8C", to: "#34426A" },
];

export interface GeneratedAvatarFace {
  from: string;
  to: string;
  text: string;
  glyph: string;
}

export interface AvatarIdentity {
  id?: string | null;
  name?: string | null;
  avatar?: string | null;
}

const CAT_MARK = /^cat:(\d+)$/;

/** 配色种子：稳定身份优先，最后才落到同一张「member」底，空身份不会随机漂。 */
export function generatedAvatarSeed({ id, name }: AvatarIdentity): string {
  return (id ?? "").trim() || (name ?? "").trim() || "member";
}

/** 字形：名字首字（拉丁字母大写），没名字就用 id 首字，都没有给「?」。 */
export function generatedAvatarGlyph({ id, name }: AvatarIdentity): string {
  const source = (name ?? "").trim() || (id ?? "").trim();
  const first = Array.from(source)[0] ?? "";
  if (!first) return "?";
  return /^[a-z]$/.test(first) ? first.toUpperCase() : first;
}

export function generatedAvatarFace(identity: AvatarIdentity): GeneratedAvatarFace {
  const coat = GENERATED_AVATAR_COATS[hashIndex(generatedAvatarSeed(identity), GENERATED_AVATAR_COATS.length)]!;
  return { from: coat.from, to: coat.to, text: GENERATED_AVATAR_TEXT, glyph: generatedAvatarGlyph(identity) };
}

export function generatedAvatarBackground(face: GeneratedAvatarFace): { background: string; color: string } {
  return { background: `linear-gradient(135deg, ${face.from}, ${face.to})`, color: face.text };
}

export type AvatarFace =
  | { kind: "upload"; src: string }
  | { kind: "cat"; coat: number }
  | { kind: "generated"; face: GeneratedAvatarFace };

/**
 * 头像取值：上传图 > 显式毛色 > 按身份生成 > 没有身份（返回 null，调用方决定回落成什么）。
 * 与旧口径一致：没有 id 也没有名字时，连 `cat:<n>` 都不认——那种发言定位不到人。
 */
export function avatarFace(identity: AvatarIdentity): AvatarFace | null {
  const avatar = identity.avatar ?? "";
  if (avatar.startsWith("data:image/")) return { kind: "upload", src: avatar };
  if (!identity.id && !identity.name) return null;
  if (CAT_MARK.test(avatar)) {
    return { kind: "cat", coat: memberCoatIndex({ id: identity.id ?? "", name: identity.name ?? "", avatar }) };
  }
  return { kind: "generated", face: generatedAvatarFace(identity) };
}
