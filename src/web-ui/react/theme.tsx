import * as React from "react";
import { XProvider } from "@ant-design/x";
import zhCN from "antd/locale/zh_CN";
import xZhCN from "@ant-design/x/locale/zh_CN";
import type { ThemeConfig } from "antd";
import { theme as antTheme } from "antd";
import { useReducedMotion } from "./ui/motion-tokens";
import { usePortalContainer } from "./ui/portal-context";

const ThemeInstalled = React.createContext(false);

/** The approved demo palette; ordinary control geometry remains library-owned. */
const SECONDARY_TEXT_COLOR = "#6b5e54";

export const wandTheme: ThemeConfig = {
  token: {
    colorPrimary: "#b8562f", colorInfo: "#b8562f", colorSuccess: "#4f7a58",
    // Keep native danger text, light surfaces and solid white labels readable.
    colorError: "#b7342e", colorErrorHover: "#9f2a25", colorErrorActive: "#87201d",
    colorErrorBg: "#fff1ee", colorErrorBgHover: "#ffe9e4",
    colorErrorBgFilledHover: "#ffe7e2", colorErrorBgActive: "#ffddd6",
    colorErrorBorder: "#d87c70", colorErrorBorderHover: "#b7342e",
    colorErrorText: "#b7342e", colorErrorTextHover: "#9f2a25", colorErrorTextActive: "#87201d",
    colorText: "#29241f", colorTextSecondary: SECONDARY_TEXT_COLOR,
    colorTextDescription: SECONDARY_TEXT_COLOR, colorTextPlaceholder: SECONDARY_TEXT_COLOR,
    colorBgLayout: "#faf8f5",
    colorBgContainer: "#fffdfa", colorBorderSecondary: "#ebe5dd", borderRadius: 8,
    fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
    fontSize: 14, fontSizeSM: 12, zIndexPopupBase: 20010,
  },
  components: {
    Layout: { siderBg: "#f4f0e9", headerBg: "#fffdfa", bodyBg: "#faf8f5" },
    Menu: { itemBg: "transparent", subMenuItemBg: "transparent", itemSelectedBg: "#ebe0d3", itemSelectedColor: "#9e4b29" },
    Tree: { nodeHoverBg: "#ece6dd", directoryNodeSelectedBg: "#eadfd2", directoryNodeSelectedColor: "#9e4b29" },
    Button: { primaryShadow: "none" },
  },
};

/** Compatibility names for the imperative terminal/editor and native hosts.
 * All ordinary surface and control values come from the same Ant theme. */
export function installWandThemeTokens(target: Document = document): void {
  if (target.getElementById("wand-theme-tokens")) return;
  const token = antTheme.getDesignToken(wandTheme);
  const aliases: Record<string, string | number> = {
    "bg-primary": token.colorBgLayout, "bg-secondary": token.colorFillAlter,
    "bg-tertiary": token.colorFillSecondary, "bg-elevated": token.colorBgContainer,
    "bg-surface": token.colorBgContainer, "bg-terminal": "#17120f",
    "bg-hover": token.colorFillTertiary, "bg-active": token.colorFillSecondary,
    "border-subtle": token.colorBorderSecondary, "border-default": token.colorBorder,
    "border-strong": token.colorTextTertiary, "border": token.colorBorder,
    "border-focus": token.colorPrimaryBorder,
    "text-primary": token.colorText, "text-secondary": token.colorTextSecondary,
    "text-tertiary": token.colorTextTertiary, "text-muted": token.colorTextSecondary,
    "text-inverse": token.colorTextLightSolid, "text-link": token.colorLink,
    "accent": token.colorPrimary, "accent-solid": token.colorPrimary,
    "accent-hover": token.colorPrimaryHover, "accent-solid-hover": token.colorPrimaryHover,
    "accent-active": token.colorPrimaryActive, "accent-strong": token.colorPrimaryActive,
    "accent-muted": token.colorPrimaryBg, "accent-soft": token.colorPrimaryBorder,
    "success": token.colorSuccess, "success-hover": token.colorSuccessHover,
    "success-muted": token.colorSuccessBg, "warning": token.colorWarning,
    "warning-muted": token.colorWarningBg, "danger": token.colorError,
    "danger-hover": token.colorErrorHover, "danger-muted": token.colorErrorBg,
    "info": token.colorInfo, "info-muted": token.colorInfoBg,
    "permission": token.colorWarning, "permission-muted": token.colorWarningBg,
    "thinking": token.colorTextSecondary,
    "font-sans": token.fontFamily, "font-mono": token.fontFamilyCode,
    "font-size-2xs": "12px", "font-size-xs": `${token.fontSizeSM}px`,
    "font-size-sm": `${token.fontSize}px`, "font-size-base": `${token.fontSize}px`,
    "font-size-lg": `${token.fontSizeLG}px`, "font-size-xl": `${token.fontSizeHeading3}px`,
    "font-weight-regular": 400, "font-weight-medium": 500,
    "font-weight-semibold": token.fontWeightStrong, "font-weight-bold": token.fontWeightStrong,
    "line-height-tight": token.lineHeightHeading3, "line-height-base": token.lineHeight,
    "line-height-relaxed": token.lineHeight,
    "radius-xs": `${token.borderRadiusSM}px`, "radius-sm": `${token.borderRadius}px`,
    "radius-md": `${token.borderRadiusLG}px`, "radius-lg": `${token.borderRadiusLG}px`,
    "radius-full": "9999px", "control-radius": `${token.borderRadius}px`,
    "shadow-xs": token.boxShadowTertiary, "shadow-sm": token.boxShadowTertiary,
    "shadow-md": token.boxShadowSecondary, "shadow-lg": token.boxShadowSecondary,
    "shadow-xl": token.boxShadow, "shadow-elevated": token.boxShadowSecondary,
    "float-bg": token.colorBgElevated, "float-border": token.colorBorderSecondary,
    "float-radius": `${token.borderRadiusLG}px`, "float-shadow": token.boxShadowSecondary,
    "scrollbar-thumb": token.colorTextQuaternary, "scrollbar-hover": token.colorTextTertiary,
    "scrollbar-active": token.colorTextSecondary, "scrollbar-track": "transparent",
  };
  const sheet = target.createElement("style");
  sheet.id = "wand-theme-tokens";
  sheet.textContent = `:root { ${Object.entries(aliases).map(([name, value]) => `--${name}: ${value};`).join(" ")} }`;
  target.head.appendChild(sheet);
}

/** Install at each React root, including roots created for legacy-owned host nodes. */
export function WandUiProvider({ children }: { children: React.ReactNode }) {
  React.useInsertionEffect(() => installWandThemeTokens(), []);
  const portal = usePortalContainer();
  const reduced = useReducedMotion();
  const theme = React.useMemo<ThemeConfig>(() => {
    const styles = typeof document === "undefined" ? null : getComputedStyle(document.documentElement);
    const cssToken = (name: string, fallback: string): string => styles?.getPropertyValue(name).trim() || fallback;
    return { ...wandTheme,
      // Independent legacy roots use the same theme. Ant's generated per-root
      // CSS-variable keys otherwise inject hundreds of identical styles on a
      // long timeline. Keep reduced motion in its own namespace during updates.
      cssVar: { key: reduced ? "wand-ui-reduced" : "wand-ui" },
      token: {
        // rc-trigger needs the motion lifecycle to complete popup alignment. Keep
        // that lifecycle with instantaneous durations; the reduced-motion sheet
        // removes visual translation/scale without disabling alignment callbacks.
        ...wandTheme.token, motion: true,
        motionDurationFast: reduced ? "0.00001s" : cssToken("--motion-fast", "0.12s"),
        motionDurationMid: reduced ? "0.00001s" : cssToken("--motion-normal", "0.22s"),
        motionDurationSlow: reduced ? "0.00001s" : cssToken("--motion-normal", "0.22s"),
        motionEaseInOut: cssToken("--ease-in-out-smooth", "ease-in-out"),
        motionEaseOut: cssToken("--ease-out-expo", "ease-out"),
      },
    };
  }, [reduced]);
  return <ThemeInstalled.Provider value={true}>
    <XProvider locale={{ ...zhCN, ...xZhCN }} theme={theme}
      getPopupContainer={() => portal ?? document.body}>
      {children}
    </XProvider>
  </ThemeInstalled.Provider>;
}

/** Public primitives remain usable in independently mounted legacy React roots. */
export function WandUiBoundary({ children }: { children: React.ReactNode }) {
  return React.useContext(ThemeInstalled) ? children : <WandUiProvider>{children}</WandUiProvider>;
}

/** Static hidden geometry projections use the same tokens without media subscriptions. */
export function WandUiMeasurementProvider({ children }: { children: React.ReactNode }) {
  return <ThemeInstalled.Provider value={true}>
    <XProvider locale={{ ...zhCN, ...xZhCN }} theme={{ ...wandTheme,
      cssVar: { key: "wand-ui-measurement" }, token: { ...wandTheme.token, motion: false },
    }}>
      {children}
    </XProvider>
  </ThemeInstalled.Provider>;
}
