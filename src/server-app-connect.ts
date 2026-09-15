/**
 * 公开 origin 推导、App 连接码与结构化聊天人设。
 *
 * 这些逻辑原来内联在 `server.ts` 里，占了组合根很大一块，而且和路由注册混在
 * 一起。它们只依赖请求头 / 配置 / 文件系统，跟 Express 组合根无关，因此单独
 * 成模块；`server.ts` 只负责把结果接到 `/api/login`、`/api/config` 等路由上。
 */

import crypto from "node:crypto";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Request } from "express";

import { resolveConfigDir } from "./config.js";
import { normalizePublicOrigin } from "./ios-ota.js";
import {
  firstHeaderListValue,
  firstHeaderValue,
  firstQueryStringValue,
  forwardedParam,
  normalizeProtocol,
} from "./server-request.js";
import type { StructuredChatPersonaConfig, WandConfig } from "./types.js";

// ── App 连接码 ──
//
// 连接码里的 token 是密码派生的（HMAC(password, appSecret)），兼容既有连接码；
// 因此它等价于密码，绝不能写进日志或回显给非登录方。

export function generateAppToken(password: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(password).digest("hex");
}

export function verifyAppToken(token: string, password: string, secret: string): boolean {
  const expected = generateAppToken(password, secret);
  return crypto.timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(expected, "hex"));
}

export function encodeConnectCode(url: string, token: string): string {
  return Buffer.from(`${url}#${token}`).toString("base64");
}

// ── 转发头解析 ──

function getPublicRequestProtocol(req: Request, fallback: "http" | "https"): "http" | "https" {
  return (
    normalizeProtocol(firstHeaderListValue(req.headers["x-forwarded-proto"]))
    ?? normalizeProtocol(forwardedParam(firstHeaderListValue(req.headers.forwarded), "proto"))
    ?? (firstHeaderListValue(req.headers["x-forwarded-ssl"])?.toLowerCase() === "on" ? "https" : undefined)
    ?? (firstHeaderListValue(req.headers["x-forwarded-scheme"])?.toLowerCase() === "https" ? "https" : undefined)
    ?? fallback
  );
}

function getPublicRequestHost(req: Request, config: WandConfig): string {
  return (
    firstHeaderListValue(req.headers["x-forwarded-host"])
    ?? forwardedParam(firstHeaderListValue(req.headers.forwarded), "host")
    ?? req.headers.host
    ?? `${config.host}:${config.port}`
  );
}

// ── 浏览器扩展 origin ──

export function isBrowserExtensionOrigin(value: string | undefined): boolean {
  if (!value) return false;
  return /^chrome-extension:\/\/[a-z]{32}$/i.test(value)
    || /^moz-extension:\/\/[0-9a-f-]+$/i.test(value)
    || /^safari-web-extension:\/\//i.test(value);
}

// ── LAN 地址选择 ──

function isPrivateIpv4(address: string): boolean {
  if (address.startsWith("10.") || address.startsWith("192.168.")) return true;
  const match = address.match(/^172\.(\d+)\./);
  return match ? Number(match[1]) >= 16 && Number(match[1]) <= 31 : false;
}

function preferredLanIpv4(): string | undefined {
  const candidates: Array<{ address: string; score: number }> = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      const family = entry.family as unknown;
      if (entry.internal || (family !== "IPv4" && family !== 4)) continue;
      let score = isPrivateIpv4(entry.address) ? 10 : 0;
      if (/^(en|eth|wlan)\d+$/i.test(name)) score += 10;
      candidates.push({ address: entry.address, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
  return candidates[0]?.address;
}

/**
 * App 连接码用于另一台设备。设置页若从 localhost 打开，直接编码浏览器 origin
 * 会让客户端连接它自己；监听 0.0.0.0 时自动换成本机优先 LAN IPv4。
 */
export function resolveAppConnectOrigin(origin: string, config: WandConfig): string {
  if (config.host !== "0.0.0.0") return origin;
  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.toLowerCase();
    const isLocalOnly = hostname === "localhost"
      || hostname === "127.0.0.1"
      || hostname === "[::1]"
      || hostname === "::1"
      || hostname === "0.0.0.0"
      || hostname === "[::]";
    if (!isLocalOnly) return parsed.origin;
    const lanIp = preferredLanIpv4();
    if (!lanIp) return parsed.origin;
    parsed.hostname = lanIp;
    return parsed.origin;
  } catch {
    return origin;
  }
}

/**
 * 反代场景：配置了 publicOrigin 就优先用它。TLS 在 L4 反代终止时 node 只看到
 * 明文 HTTP，既没有 X-Forwarded-Proto 也没有正确的 scheme，猜不出来。
 */
export function resolveRequestServerUrl(req: Request, config: WandConfig, useHttps: boolean): string {
  const configuredOrigin = normalizePublicOrigin(config.publicOrigin);
  if (configuredOrigin) return resolveAppConnectOrigin(configuredOrigin, config);
  const requestProtocol = getPublicRequestProtocol(req, useHttps ? "https" : "http");
  const requestHost = getPublicRequestHost(req, config);
  const originHeader = firstHeaderValue(req.headers.origin);
  const browserOrigin = isBrowserExtensionOrigin(originHeader)
    ? undefined
    : normalizePublicOrigin(originHeader) ?? undefined;
  return resolveAppConnectOrigin(browserOrigin ?? `${requestProtocol}://${requestHost}`, config);
}

/** 设置页里的连接码：优先显式 origin，其次配置 publicOrigin，最后回落到请求头。 */
export function resolveAppConnectCode(
  req: Request,
  config: WandConfig,
  useHttps: boolean,
  password: string,
): { code: string; url: string } {
  const requestProtocol = getPublicRequestProtocol(req, useHttps ? "https" : "http");
  const requestHost = getPublicRequestHost(req, config);
  const browserOrigin = normalizePublicOrigin(firstQueryStringValue(req.query.origin));
  const serverUrl = resolveAppConnectOrigin(
    normalizePublicOrigin(config.publicOrigin) ?? browserOrigin ?? `${requestProtocol}://${requestHost}`,
    config,
  );
  const token = generateAppToken(password, config.appSecret ?? "");
  return { code: encodeConnectCode(serverUrl, token), url: serverUrl };
}

export function appTokenLoginPayload(
  req: Request,
  config: WandConfig,
  useHttps: boolean,
  password: string,
): { appToken: string; serverUrl: string } {
  return {
    appToken: generateAppToken(password, config.appSecret ?? ""),
    serverUrl: resolveRequestServerUrl(req, config, useHttps),
  };
}

// ── 结构化聊天人设 ──

function isExternalAvatarSource(value: string): boolean {
  return /^(https?:|data:)/i.test(value);
}

/** persona 的 name / avatar 都是「可选非空字符串」：空白与非法类型都当未设置。 */
function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

export function resolveStructuredChatPersona(
  config: WandConfig,
): StructuredChatPersonaConfig | undefined {
  const persona = config.structuredChatPersona;
  if (!persona) return undefined;

  const userName = normalizeOptionalText(persona.user?.name);
  const userAvatar = normalizeOptionalText(persona.user?.avatar);
  const assistantName = normalizeOptionalText(persona.assistant?.name);
  const assistantAvatar = normalizeOptionalText(persona.assistant?.avatar);

  if (!userName && !userAvatar && !assistantName && !assistantAvatar) {
    return undefined;
  }

  return {
    user: userName || userAvatar ? { name: userName, avatar: userAvatar } : undefined,
    assistant: assistantName || assistantAvatar ? { name: assistantName, avatar: assistantAvatar } : undefined,
  };
}

/** 本地头像文件的绝对路径；外链和未配置返回 null。 */
export function resolveStructuredChatAvatarPath(
  configPath: string,
  config: WandConfig,
  role: "user" | "assistant",
): string | null {
  const avatar = role === "user"
    ? config.structuredChatPersona?.user?.avatar
    : config.structuredChatPersona?.assistant?.avatar;
  if (!avatar || isExternalAvatarSource(avatar)) {
    return null;
  }
  const configDir = resolveConfigDir(configPath);
  return path.isAbsolute(avatar) ? avatar : path.resolve(configDir, avatar);
}

/**
 * `/api/config` 用的人设 payload。本地头像存在时替换成 `/api/structured-chat-avatar/:role`，
 * 不把磁盘路径暴露给前端；文件不存在则整条 avatar 字段省略。
 */
export async function buildStructuredChatPersonaPayload(
  configPath: string,
  config: WandConfig,
): Promise<StructuredChatPersonaConfig | undefined> {
  const persona = resolveStructuredChatPersona(config);
  if (!persona) return undefined;

  const buildRole = async (role: "user" | "assistant"): Promise<StructuredChatPersonaConfig["user"] | undefined> => {
    const roleConfig = role === "user" ? persona.user : persona.assistant;
    if (!roleConfig) return undefined;

    let avatar = roleConfig.avatar;
    if (avatar && !isExternalAvatarSource(avatar)) {
      const resolvedPath = resolveStructuredChatAvatarPath(configPath, config, role);
      if (!resolvedPath) {
        avatar = undefined;
      } else {
        try {
          const fileStat = await stat(resolvedPath);
          avatar = fileStat.isFile() ? `/api/structured-chat-avatar/${role}` : undefined;
        } catch {
          avatar = undefined;
        }
      }
    }

    if (!roleConfig.name && !avatar) return undefined;
    return { name: roleConfig.name, avatar };
  };

  const [user, assistant] = await Promise.all([buildRole("user"), buildRole("assistant")]);
  if (!user && !assistant) return undefined;
  return { user, assistant };
}
