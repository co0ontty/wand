import { parsePlushAvatar, parsePlushCatAvatar, parsePlushDogAvatar } from "./plush-avatar.js";
import { badRequest } from "./http-error.js";
import { text } from "./server-request.js";

/** One write contract for employee and unbound team-member avatars. */
export function parseStoredAvatar(value: unknown, label: string, maxChars: number): string {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw badRequest(`${label}的头像格式无效。`);
  }
  const avatar = text(value);
  if (!avatar || /^cat:\d{1,2}$/.test(avatar)) return avatar;
  if (parsePlushAvatar(avatar) || parsePlushCatAvatar(avatar) || parsePlushDogAvatar(avatar)) return avatar;
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar)) {
    throw badRequest(`${label}的头像格式无效。`);
  }
  if (avatar.length > maxChars) throw badRequest(`${label}的头像太大。`);
  return avatar;
}
