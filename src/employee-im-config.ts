import { EMPLOYEE_IM_EVENTS, type EmployeeImConfig, type EmployeeImConfigInput, type EmployeeImEvent } from "./employee-im-types.js";

/** Server-only write-only credentials, never included in employee/session projections. */
export interface EmployeeImCredentials { botToken?: string; webhook?: string; secret?: string }
export interface EmployeeImSettings { config: EmployeeImConfig; credentials: EmployeeImCredentials }
export class EmployeeImConfigError extends Error {}
const knownEvents = new Set<string>(EMPLOYEE_IM_EVENTS.map(event => event.value));
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EmployeeImConfigError("IM 配置必须是对象。");
  return value as Record<string, unknown>;
}
function credential(value: unknown, previous: string | undefined, label: string, max: number): string | undefined {
  if (value === undefined || value === "") return previous;
  if (value === null) return undefined;
  if (typeof value !== "string" || value.length > max || /[\x00-\x20\x7f]/.test(value)) throw new EmployeeImConfigError(`${label}格式无效。`);
  return value;
}
export function dingTalkWebhook(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new EmployeeImConfigError("请填写有效的钉钉机器人 Webhook。"); }
  const token = url.searchParams.get("access_token");
  if (url.protocol !== "https:" || url.hostname !== "oapi.dingtalk.com" || url.port || url.username || url.password
    || url.pathname !== "/robot/send" || url.hash || !token || !/^[A-Za-z0-9_-]{8,256}$/.test(token)
    || [...url.searchParams.keys()].some(key => key !== "access_token") || url.searchParams.getAll("access_token").length !== 1) {
    throw new EmployeeImConfigError("仅支持 https://oapi.dingtalk.com/robot/send?access_token=… 官方机器人地址。");
  }
  return url;
}
/** Older draft configs had per-channel events. Read them as one union without rewriting storage on GET. */
export function normalizeStoredEmployeeImConfig(value: unknown): EmployeeImConfig {
  const raw = object(value), telegram = object(raw.telegram), dingtalk = object(raw.dingtalk);
  const source = Array.isArray(raw.events) ? raw.events
    : [...(Array.isArray(telegram.events) ? telegram.events : []), ...(Array.isArray(dingtalk.events) ? dingtalk.events : [])];
  return {
    events: [...new Set(source.filter((event): event is EmployeeImEvent => typeof event === "string" && knownEvents.has(event)))],
    telegram: { enabled: telegram.enabled === true, chatId: typeof telegram.chatId === "string" ? telegram.chatId : "", botTokenConfigured: telegram.botTokenConfigured === true },
    dingtalk: { enabled: dingtalk.enabled === true, webhookConfigured: dingtalk.webhookConfigured === true, secretConfigured: dingtalk.secretConfigured === true },
  };
}

export function parseEmployeeImConfig(input: EmployeeImConfigInput | unknown, previous: EmployeeImSettings): EmployeeImSettings {
  const body = object(input);
  const events = body.events === undefined ? previous.config.events : body.events;
  if (!Array.isArray(events) || events.length > EMPLOYEE_IM_EVENTS.length
    || events.some(event => typeof event !== "string" || !knownEvents.has(event))) throw new EmployeeImConfigError("通知节点无效。");
  const config = { events: [...new Set(events)] as EmployeeImEvent[] } as EmployeeImConfig;
  const credentials = { ...previous.credentials };
  for (const provider of ["telegram", "dingtalk"] as const) {
    const raw = object(body[provider]);
    if (typeof raw.enabled !== "boolean") throw new EmployeeImConfigError("请选择是否启用 IM 通知。");
    config[provider] = { enabled: raw.enabled };
    if (provider === "telegram") {
      if (raw.chatId !== undefined && typeof raw.chatId !== "string") throw new EmployeeImConfigError("Telegram Chat ID 格式无效。");
      const chatId = (raw.chatId as string | undefined)?.trim() ?? previous.config.telegram.chatId ?? "";
      if (chatId && !/^(?:-?\d{1,24}|@[A-Za-z0-9_]{5,32})$/.test(chatId)) throw new EmployeeImConfigError("Telegram Chat ID 格式无效。");
      config.telegram.chatId = chatId;
      credentials.botToken = credential(raw.botToken, credentials.botToken, "Telegram Bot Token", 256);
      if (credentials.botToken && !/^\d{5,20}:[A-Za-z0-9_-]{20,200}$/.test(credentials.botToken)) throw new EmployeeImConfigError("Telegram Bot Token 格式无效。");
      if (raw.enabled && (!credentials.botToken || !chatId)) throw new EmployeeImConfigError("启用 Telegram 前请填写 Bot Token 和 Chat ID。");
    } else {
      credentials.webhook = credential(raw.webhook, credentials.webhook, "钉钉 Webhook", 1024);
      credentials.secret = credential(raw.secret, credentials.secret, "钉钉签名密钥", 512);
      if (credentials.webhook) dingTalkWebhook(credentials.webhook);
      if (raw.enabled && !credentials.webhook) throw new EmployeeImConfigError("启用钉钉前请填写机器人 Webhook。");
    }
  }
  config.telegram.botTokenConfigured = !!credentials.botToken;
  config.dingtalk.webhookConfigured = !!credentials.webhook;
  config.dingtalk.secretConfigured = !!credentials.secret;
  return { config, credentials };
}
