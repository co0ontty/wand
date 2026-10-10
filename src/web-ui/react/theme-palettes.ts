import type { GlobalToken, ThemeConfig } from "antd";

/** Canonical device-local palette roles. Ant retains component geometry/state ownership. */
export const THEME_STORAGE_KEY = "wand-theme";
export interface WandPalette {
  id: "warm" | "blue" | "forest" | "mauve" | "graphite";
  name: string;
  dark: boolean;
  primary: string;
  primaryHover: string;
  primaryActive: string;
  link: string;
  focus: string;
  text: string;
  secondary: string;
  background: string;
  surface: string;
  sidebar: string;
  selected: string;
  hover: string;
  border: string;
  terminal: string;
  terminalText: string;
  terminalCursor: string;
}

export const WAND_PALETTES: readonly WandPalette[] = [
  { id: "warm", name: "暖白铜色", dark: false, primary: "#b8562f", primaryHover: "#9e4b29", primaryActive: "#873e23", link: "#9e4b29", focus: "#b8562f", text: "#29241f", secondary: "#6b5e54", background: "#faf8f5", surface: "#fffdfa", sidebar: "#f4f0e9", selected: "#ebe0d3", hover: "#ece6dd", border: "#ebe5dd", terminal: "#17120f", terminalText: "#f4eee6", terminalCursor: "#d88d60" },
  { id: "blue", name: "石墨蓝", dark: false, primary: "#395f87", primaryHover: "#2e4f73", primaryActive: "#24415f", link: "#395f87", focus: "#395f87", text: "#252d36", secondary: "#546477", background: "#f6f8fa", surface: "#fcfdff", sidebar: "#edf1f6", selected: "#dee7f1", hover: "#e6ecf3", border: "#dfe6ee", terminal: "#141b24", terminalText: "#e5edf7", terminalCursor: "#93b9e6" },
  { id: "forest", name: "森林绿", dark: false, primary: "#3c6750", primaryHover: "#2f5441", primaryActive: "#254534", link: "#3c6750", focus: "#3c6750", text: "#253029", secondary: "#526759", background: "#f7f9f6", surface: "#fcfdfa", sidebar: "#edf2eb", selected: "#dfe9dd", hover: "#e7eee4", border: "#dfe7dc", terminal: "#142019", terminalText: "#e7f0e5", terminalCursor: "#a0cba4" },
  { id: "mauve", name: "雾紫", dark: false, primary: "#735583", primaryHover: "#604570", primaryActive: "#50395e", link: "#735583", focus: "#735583", text: "#302934", secondary: "#675b6d", background: "#f9f7fa", surface: "#fefcfe", sidebar: "#f1edf4", selected: "#e8dfed", hover: "#eee7f1", border: "#e7dfea", terminal: "#201923", terminalText: "#f0e7f5", terminalCursor: "#c7a9dc" },
  { id: "graphite", name: "深色石墨", dark: true, primary: "#47678e", primaryHover: "#4f7399", primaryActive: "#3c587a", link: "#b0c9e9", focus: "#a5c5ef", text: "#e5e9ef", secondary: "#b0b9c7", background: "#191d23", surface: "#232830", sidebar: "#1e232a", selected: "#303f51", hover: "#2c333e", border: "#3b4452", terminal: "#11151a", terminalText: "#e5e9ef", terminalCursor: "#a5c5ef" },
];
export type WandThemeId = WandPalette["id"];
export function normalizeWandTheme(value: unknown): WandThemeId {
  return WAND_PALETTES.find(p => p.id === value)?.id ?? "warm";
}
export function wandPalette(id: WandThemeId): WandPalette {
  return WAND_PALETTES.find(p => p.id === id) ?? WAND_PALETTES[0]!;
}

/** Algorithm is supplied by the Ant adapter; this module is also consumed at build time. */
export function paletteThemeConfig(p: WandPalette, darkAlgorithm?: ThemeConfig["algorithm"]): ThemeConfig {
  return {
    ...(p.dark ? { algorithm: darkAlgorithm } : {}),
    token: {
      colorPrimary: p.primary, colorPrimaryHover: p.primaryHover, colorPrimaryActive: p.primaryActive,
      colorPrimaryText: p.link, colorPrimaryTextHover: p.dark ? "#c5d8f1" : p.primaryHover,
      colorPrimaryTextActive: p.dark ? "#dbe6f5" : p.primaryActive,
      colorPrimaryBg: p.selected, colorPrimaryBgHover: p.hover,
      colorPrimaryBorder: p.focus, colorLink: p.link,
      colorLinkHover: p.dark ? "#c5d8f1" : p.primaryHover,
      colorLinkActive: p.dark ? "#dbe6f5" : p.primaryActive,
      lineWidthFocus: 2, controlOutline: p.focus, controlOutlineWidth: 2,
      colorInfo: p.primary, colorInfoText: p.link, colorInfoBg: p.selected,
      colorSuccess: "#4f7a58", colorSuccessText: p.dark ? "#9acda5" : "#456d4e",
      colorSuccessTextHover: p.dark ? "#b3dfbc" : "#3b5f43", colorSuccessTextActive: p.dark ? "#c7e8cd" : "#2f5036",
      colorSuccessBg: p.dark ? "#24392d" : "#eff6ed",
      colorWarning: "#8b640d", colorWarningText: p.dark ? "#ddbc72" : "#8b640d",
      colorWarningBg: p.dark ? "#3b3221" : "#fff6dd",
      colorError: "#b7342e", colorErrorHover: "#9f2a25", colorErrorActive: "#87201d",
      colorErrorBg: p.dark ? "#3c2728" : "#fff1ee", colorErrorBgHover: p.dark ? "#4b2c2e" : "#ffe9e4",
      colorErrorBgFilledHover: p.dark ? "#4b2c2e" : "#ffe7e2", colorErrorBgActive: p.dark ? "#522e30" : "#ffddd6",
      colorErrorBorder: p.dark ? "#ae645f" : "#d87c70", colorErrorBorderHover: p.dark ? "#f3978e" : "#b7342e",
      colorErrorText: p.dark ? "#f3978e" : "#b7342e", colorErrorTextHover: p.dark ? "#ffb7af" : "#9f2a25", colorErrorTextActive: p.dark ? "#ffd1cb" : "#87201d",
      colorText: p.text, colorTextSecondary: p.secondary, colorTextDescription: p.secondary,
      colorTextPlaceholder: p.secondary, colorBgLayout: p.background, colorBgContainer: p.surface,
      colorBgElevated: p.surface, colorBorderSecondary: p.border, borderRadius: 8,
      fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
      fontSize: 14, fontSizeSM: 12, zIndexPopupBase: 20010,
    },
    components: {
      Layout: { siderBg: p.sidebar, headerBg: p.surface, bodyBg: p.background },
      Menu: { itemBg: "transparent", subMenuItemBg: "transparent", itemSelectedBg: p.selected, itemSelectedColor: p.link, itemHoverBg: p.hover },
      Tree: { nodeHoverBg: p.hover, directoryNodeSelectedBg: p.selected, directoryNodeSelectedColor: p.link },
      Button: { primaryShadow: "none" },
    },
  };
}

/** Stable aliases shared by React, imperative hosts and the blocking first-paint asset. */
export function themeAliases(token: GlobalToken, p: WandPalette): Record<string, string | number> {
  return {
    "bg-primary": token.colorBgLayout, "bg-secondary": token.colorFillAlter,
    "bg-tertiary": token.colorFillSecondary, "bg-elevated": token.colorBgContainer,
    "bg-surface": token.colorBgContainer, "bg-sidebar": p.sidebar, "bg-terminal": p.terminal,
    "bg-hover": p.hover, "bg-active": p.selected,
    "border-subtle": token.colorBorderSecondary, "border-default": token.colorBorder,
    "border-strong": token.colorTextTertiary, "border": token.colorBorder, "border-focus": p.focus,
    "text-primary": token.colorText, "text-secondary": token.colorTextSecondary,
    "text-tertiary": token.colorTextTertiary, "text-muted": token.colorTextSecondary,
    "text-inverse": token.colorTextLightSolid, "text-link": token.colorLink,
    "accent": p.link, "accent-solid": token.colorPrimary, "accent-hover": token.colorPrimaryTextHover,
    "accent-solid-hover": token.colorPrimaryHover, "accent-active": token.colorPrimaryTextActive,
    "accent-strong": token.colorPrimaryTextActive, "accent-muted": p.selected, "accent-soft": token.colorPrimaryBorder,
    "success": token.colorSuccessText, "success-hover": token.colorSuccessTextHover, "success-muted": token.colorSuccessBg,
    "warning": token.colorWarningText, "warning-muted": token.colorWarningBg,
    "danger": token.colorErrorText, "danger-hover": token.colorErrorTextHover, "danger-muted": token.colorErrorBg,
    "info": token.colorInfoText, "info-muted": token.colorInfoBg,
    "permission": token.colorWarningText, "permission-muted": token.colorWarningBg, "thinking": token.colorTextSecondary,
    "syntax-keyword": p.dark ? "#cfb4ed" : "#8250df", "syntax-string": p.dark ? "#9acda5" : "#0a7d37",
    "syntax-number": p.dark ? "#ddbc72" : "#965100", "syntax-comment": p.secondary,
    "syntax-operator": p.dark ? "#f1a9ce" : "#b2085f", "selection-bg": p.dark ? "#364965" : p.selected,
    "find-highlight-bg": p.dark ? "#54461b" : "#fff5bd", "find-active-bg": p.dark ? "#644324" : "#ffdbc0",
    "font-sans": token.fontFamily, "font-mono": token.fontFamilyCode,
    "font-size-2xs": "12px", "font-size-xs": `${token.fontSizeSM}px`, "font-size-sm": `${token.fontSize}px`,
    "font-size-base": `${token.fontSize}px`, "font-size-lg": `${token.fontSizeLG}px`, "font-size-xl": `${token.fontSizeHeading3}px`,
    "font-weight-regular": 400, "font-weight-medium": 500, "font-weight-semibold": token.fontWeightStrong, "font-weight-bold": token.fontWeightStrong,
    "line-height-tight": token.lineHeightHeading3, "line-height-base": token.lineHeight, "line-height-relaxed": token.lineHeight,
    "radius-xs": `${token.borderRadiusSM}px`, "radius-sm": `${token.borderRadius}px`, "radius-md": `${token.borderRadiusLG}px`,
    "radius-lg": `${token.borderRadiusLG}px`, "radius-full": "9999px", "control-radius": `${token.borderRadius}px`,
    "shadow-xs": token.boxShadowTertiary, "shadow-sm": token.boxShadowTertiary, "shadow-md": token.boxShadowSecondary,
    "shadow-lg": token.boxShadowSecondary, "shadow-xl": token.boxShadow, "shadow-elevated": token.boxShadowSecondary,
    "float-bg": token.colorBgElevated, "float-border": token.colorBorderSecondary, "float-radius": `${token.borderRadiusLG}px`, "float-shadow": token.boxShadowSecondary,
    "scrollbar-thumb": token.colorTextQuaternary, "scrollbar-hover": token.colorTextTertiary,
    "scrollbar-active": token.colorTextSecondary, "scrollbar-track": "transparent",
  };
}
export function themeCss(aliases: Record<string, string | number>): string {
  return `:root { ${Object.entries(aliases).map(([name, value]) => `--${name}: ${value};`).join(" ")} }`;
}
