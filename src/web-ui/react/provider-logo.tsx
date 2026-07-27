import * as React from "react";

import {
  CLAUDE_LOGO_PATH,
  CODEX_LOGO_PATH,
  GROK_LOGO_PATHS,
  normalizeProviderId,
} from "../provider-identity";

void React;

export interface ProviderLogoProps {
  provider: string | null | undefined;
  className?: string;
}

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function ProviderLogo({ provider, className }: ProviderLogoProps) {
  const normalized = normalizeProviderId(provider);
  const logoClass = classes(
    "wand-provider-logo",
    `wand-provider-logo-${normalized ?? "generic"}`,
    className,
  );

  if (normalized === "qoder") {
    return (
      <svg
        className={logoClass}
        viewBox="0 0 180 180"
        aria-hidden="true"
        focusable="false"
        data-provider-logo="qoder"
      >
        <rect width="180" height="180" rx="40" fill="#111113"/>
        <path
          d="M78 31c18 0 35 6 49 18l8 7c-5-2-10-3-15-3-10 0-19 3-26 9-11 10-17 24-17 40v18c0 12 5 21 13 28l-45-24c-8-4-13-12-13-21V80c0-27 20-49 46-49Z"
          fill="#fff"
        />
        <path
          d="M126 53c13 4 22 15 22 29v54c0 8-8 13-15 9l-10-5c-6 5-14 8-23 8-14 0-26-7-34-17l-6-9c15-7 26-19 33-33 4-9 6-18 6-28v-8c8-3 18-3 27 0Z"
          fill="#2ADB5C"
        />
      </svg>
    );
  }

  if (normalized === "opencode") {
    return (
      <svg
        className={logoClass}
        viewBox="0 0 512 512"
        aria-hidden="true"
        focusable="false"
        data-provider-logo="opencode"
      >
        <path d="M0 0H512V512H0Z" fill="#131010"/>
        <path d="M320 224V352H192V224H320Z" fill="#5A5858"/>
        <path d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z" fill="#fff" fillRule="evenodd"/>
      </svg>
    );
  }

  if (normalized === "grok") {
    return (
      <svg
        className={logoClass}
        viewBox="0 0 34 33"
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
        data-provider-logo="grok"
      >
        {GROK_LOGO_PATHS.map((path) => <path key={path} d={path}/>)}
      </svg>
    );
  }

  if (normalized === "claude" || normalized === "codex") {
    return (
      <svg
        className={logoClass}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
        data-provider-logo={normalized}
      >
        <path d={normalized === "claude" ? CLAUDE_LOGO_PATH : CODEX_LOGO_PATH}/>
      </svg>
    );
  }

  return (
    <svg
      className={logoClass}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-provider-logo="generic"
    >
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  );
}
