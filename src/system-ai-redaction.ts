import { getLoginShellEnv } from "./env-utils.js";

/** Preserve diagnostic text, while redacting credentials even when the upstream echoes them. */
export function redactSystemAiText(value: string): string {
  let text = value;
  for (const [key, secret] of Object.entries({ ...getLoginShellEnv(), ...process.env })) {
    if (/(?:KEY|TOKEN|PASSWORD|SECRET|CONNECTION_CODE|AUTH|COOKIE|CREDENTIAL|WEB_LOGIN_PROOF)/i.test(key) && secret && secret.length >= 6) text = text.split(secret).join("[已脱敏]");
  }
  text = text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[私钥已脱敏]")
    .replace(/\bwl[pt]_[A-Za-z0-9_-]{43}\b/g, "[已脱敏]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [已脱敏]")
    .replace(/\b(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{10,}/g, "[已脱敏]")
    .replace(/((?:["']?(?:api[_ -]?key|access[_ -]?token|connection[_ -]?code|password|secret|密钥|密码|口令|连接码)["']?)\s*[:=：]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"'，;\n}]+)/gi,
      (_all, key: string, value: string) => key + (value.startsWith('"') ? '"[已脱敏]"' : value.startsWith("'") ? "'[已脱敏]'" : "[已脱敏]"));
  return text;
}
