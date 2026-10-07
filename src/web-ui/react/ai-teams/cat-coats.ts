import type { AiTeamMember } from "../../../ai-team-types";

/**
 * 团队成员的像素猫毛色。React 头像与聊天气泡（chat-render.ts）共用，
 * 所以这里不依赖 React。
 */
export interface CatCoat {
  name: string;
  base: string;
  dark: string;
  light?: string;
  eye?: string;
}

export const CAT_COATS: readonly CatCoat[] = [
  { name: "橘猫", base: "#F0923A", dark: "#C46A1A", light: "#F0923A" },
  { name: "银渐层", base: "#9EAAB8", dark: "#6B7B8D", light: "#C5CED8", eye: "#3F8F55" },
  { name: "奶牛猫", base: "#F4F1EA", dark: "#2F2F33", light: "#F4F1EA" },
  { name: "黑猫", base: "#3A3A40", dark: "#1E1E22", light: "#55555C", eye: "#E9C63F" },
  { name: "暹罗", base: "#E9DCC4", dark: "#6B4A36", light: "#F4ECDD", eye: "#3F7FD8" },
  { name: "蓝猫", base: "#7C8BA6", dark: "#56627A", light: "#98A6BE", eye: "#E0A43A" },
  { name: "三花", base: "#F2E6D4", dark: "#C46A1A", light: "#3A3A40" },
  { name: "樱粉", base: "#F2B8C6", dark: "#C9788D", light: "#F8D3DC" },
];

const T = "";

/** 10×10 像素格，空串是透明。 */
export function catCoatGrid(coat: number): string[][] {
  const entry = CAT_COATS[coat % CAT_COATS.length]!;
  const b = entry.base;
  const d = entry.dark;
  const l = entry.light ?? entry.base;
  const w = "#FFFFFF";
  const k = entry.eye ?? "#2D2D2D";
  const p = "#F28B9A";
  return [
    [T, d, T, T, T, T, T, T, d, T],
    [d, b, d, T, T, T, T, d, b, d],
    [d, b, b, b, b, b, b, b, b, d],
    [b, b, w, k, b, b, w, k, b, b],
    [b, b, w, w, b, b, w, w, b, b],
    [b, b, b, b, p, p, b, b, b, b],
    [b, d, b, l, b, b, l, b, d, b],
    [T, b, b, b, b, b, b, b, b, T],
    [T, T, b, d, b, b, d, b, T, T],
    [T, T, T, b, T, T, b, T, T, T],
  ];
}

export function hashIndex(seed: string, mod: number): number {
  let hash = 0;
  for (let at = 0; at < seed.length; at += 1) hash = ((hash << 5) - hash + seed.charCodeAt(at)) | 0;
  return Math.abs(hash) % mod;
}

/** 头像取值："cat:<n>" 指定毛色；其余按 id（新成员还没有 id 时按名字）哈希。 */
export function memberCoatIndex(member: Pick<AiTeamMember, "id" | "name" | "avatar">): number {
  const match = /^cat:(\d+)$/.exec(member.avatar ?? "");
  if (match) return Number(match[1]) % CAT_COATS.length;
  return hashIndex(member.id || member.name || "member", CAT_COATS.length);
}
