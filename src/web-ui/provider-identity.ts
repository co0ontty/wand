export const PROVIDER_IDS = ["claude", "codex", "opencode", "grok", "qoder"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  grok: "Grok",
  qoder: "Qoder",
};

const PROVIDER_ALIASES: Readonly<Record<string, ProviderId>> = {
  anthropic: "claude",
  claude: "claude",
  "claude-cli": "claude",
  "claude-cli-print": "claude",
  codex: "codex",
  "codex-cli": "codex",
  "codex-cli-exec": "codex",
  grok: "grok",
  "grok-cli": "grok",
  "grok-cli-headless": "grok",
  "open-code": "opencode",
  open_code: "opencode",
  opencode: "opencode",
  "opencode-cli-run": "opencode",
  qoder: "qoder",
  "qoder-cli": "qoder",
  "qoder-cli-print": "qoder",
  qodercli: "qoder",
};

/** Normalizes a persisted provider id or provider-runner alias. */
export function normalizeProviderId(value: unknown): ProviderId | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized ? PROVIDER_ALIASES[normalized] ?? null : null;
}

/**
 * Infers old sessions from the command's executable only. Arguments and parent
 * directory names must not be allowed to impersonate a different provider.
 */
export function inferProviderIdFromCommand(value: unknown): ProviderId | null {
  if (typeof value !== "string") return null;
  const command = value.trim();
  if (!command) return null;
  const match = command.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const executablePath = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
  const executable = executablePath.split(/[\\/]/).pop()?.replace(/\.(?:cmd|exe)$/i, "") ?? "";
  return normalizeProviderId(executable);
}

export function providerDisplayName(value: unknown): string {
  const provider = normalizeProviderId(value);
  if (provider) return PROVIDER_LABELS[provider];
  return typeof value === "string" && value.trim() ? value.trim() : "AI";
}

// Claude/Codex paths match the existing Android BrandLogos source (simple-icons,
// CC0). Grok uses xAI's mark path already shipped by the Web new-session view.
export const CLAUDE_LOGO_PATH =
  "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z";

export const CODEX_LOGO_PATH =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";

export const GROK_LOGO_PATHS = [
  "M13.2371 21.0407L24.3186 12.8506C24.8619 12.4491 25.6384 12.6057 25.8973 13.2294C27.2597 16.5185 26.651 20.4712 23.9403 23.1851C21.2297 25.8989 17.4581 26.4941 14.0108 25.1386L10.2449 26.8843C15.6463 30.5806 22.2053 29.6665 26.304 25.5601C29.5551 22.3051 30.562 17.8683 29.6205 13.8673L29.629 13.8758C28.2637 7.99809 29.9647 5.64871 33.449.844576C33.5314.730667 33.6139.616757 33.6964.5L29.1113 5.09055V5.07631L13.2343 21.0436Z",
  "M10.9503 23.0313C7.07343 19.3235 7.74185 13.5853 11.0498 10.2763C13.4959 7.82722 17.5036 6.82767 21.0021 8.2971L24.7595 6.55998C24.0826 6.07017 23.215 5.54334 22.2195 5.17313C17.7198 3.31926 12.3326 4.24192 8.67479 7.90126C5.15635 11.4239 4.0499 16.8403 5.94992 21.4622C7.36924 24.9165 5.04257 27.3598 2.69884 29.826C1.86829 30.7002 1.0349 31.5745.36364 32.5L10.9474 23.0341Z",
] as const;

/** Framework-free counterpart used by the legacy Shell rollback path. */
export function renderProviderLogoMarkup(value: unknown): string {
  const provider = normalizeProviderId(value);
  const className = `wand-provider-logo wand-provider-logo-${provider ?? "generic"}`;
  const common = `class="${className}" aria-hidden="true" focusable="false" data-provider-logo="${provider ?? "generic"}"`;

  if (provider === "opencode") {
    return `<svg ${common} viewBox="0 0 512 512"><path d="M0 0H512V512H0Z" fill="#131010"/><path d="M320 224V352H192V224H320Z" fill="#5A5858"/><path d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z" fill="#fff" fill-rule="evenodd"/></svg>`;
  }
  if (provider === "qoder") {
    return `<svg ${common} viewBox="0 0 180 180"><rect width="180" height="180" rx="40" fill="#111113"/><path d="M78 31c18 0 35 6 49 18l8 7c-5-2-10-3-15-3-10 0-19 3-26 9-11 10-17 24-17 40v18c0 12 5 21 13 28l-45-24c-8-4-13-12-13-21V80c0-27 20-49 46-49Z" fill="#fff"/><path d="M126 53c13 4 22 15 22 29v54c0 8-8 13-15 9l-10-5c-6 5-14 8-23 8-14 0-26-7-34-17l-6-9c15-7 26-19 33-33 4-9 6-18 6-28v-8c8-3 18-3 27 0Z" fill="#2ADB5C"/></svg>`;
  }
  if (provider === "grok") {
    return `<svg ${common} viewBox="0 0 34 33" fill="currentColor">${GROK_LOGO_PATHS.map((path) => `<path d="${path}"/>`).join("")}</svg>`;
  }
  if (provider === "claude" || provider === "codex") {
    return `<svg ${common} viewBox="0 0 24 24" fill="currentColor"><path d="${provider === "claude" ? CLAUDE_LOGO_PATH : CODEX_LOGO_PATH}"/></svg>`;
  }
  return `<svg ${common} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="12" r="3"/></svg>`;
}
