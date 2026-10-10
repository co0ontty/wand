import * as React from "react";
import { XProvider } from "@ant-design/x";
import zhCN from "antd/locale/zh_CN";
import xZhCN from "@ant-design/x/locale/zh_CN";
import type { ThemeConfig } from "antd";
import { theme as antTheme } from "antd";
import { useReducedMotion } from "./ui/motion-tokens";
import { usePortalContainer } from "./ui/portal-context";
import { paletteThemeConfig, themeAliases, themeCss, wandPalette, type WandThemeId } from "./theme-palettes";
import { wandThemeStore } from "./theme-preference";

const ThemeInstalled = React.createContext(false);

/** Shared theme adapter. Palette roles remain canonical in theme-palettes.ts. */
export function getWandTheme(id: WandThemeId): ThemeConfig {
  return paletteThemeConfig(wandPalette(id), antTheme.darkAlgorithm);
}
export const wandTheme = getWandTheme("warm");

export function getWandTerminalTheme(id = wandThemeStore.getSnapshot()) {
  const p = wandPalette(id);
  return { background: p.terminal, foreground: p.terminalText, cursor: p.terminalCursor,
    selectionBackground: p.dark ? "#364965" : "#49413d" };
}

/** Update a single stylesheet in place; independently mounted roots share one owner. */
export function installWandThemeTokens(target: Document = document): void {
  const id = wandThemeStore.getSnapshot();
  const p = wandPalette(id);
  const token = antTheme.getDesignToken(getWandTheme(id));
  let sheet = target.getElementById("wand-theme-tokens");
  if (!sheet) { sheet = target.createElement("style"); sheet.id = "wand-theme-tokens"; target.head.appendChild(sheet); }
  sheet.textContent = themeCss(themeAliases(token, p));
  target.documentElement.dataset.wandTheme = id;
  target.documentElement.style.colorScheme = p.dark ? "dark" : "light";
  target.querySelector('meta[name="theme-color"]')?.setAttribute("content", p.background);
}
if (typeof document !== "undefined") {
  installWandThemeTokens();
  wandThemeStore.subscribe(() => installWandThemeTokens());
}

/** Install at each React root, including roots created for legacy-owned host nodes. */
export function WandUiProvider({ children }: { children: React.ReactNode }) {
  const themeId = React.useSyncExternalStore(wandThemeStore.subscribe, wandThemeStore.getSnapshot, wandThemeStore.getServerSnapshot);
  const paletteTheme = React.useMemo(() => getWandTheme(themeId), [themeId]);
  const portal = usePortalContainer();
  const reduced = useReducedMotion();
  const theme = React.useMemo<ThemeConfig>(() => {
    const styles = typeof document === "undefined" ? null : getComputedStyle(document.documentElement);
    const cssToken = (name: string, fallback: string): string => styles?.getPropertyValue(name).trim() || fallback;
    return { ...paletteTheme,
      // Independent legacy roots use the same theme. Ant's generated per-root
      // CSS-variable keys otherwise inject hundreds of identical styles on a
      // long timeline. Keep reduced motion in its own namespace during updates.
      cssVar: { key: reduced ? "wand-ui-reduced" : "wand-ui" },
      token: {
        // rc-trigger needs the motion lifecycle to complete popup alignment. Keep
        // that lifecycle with instantaneous durations; the reduced-motion sheet
        // removes visual translation/scale without disabling alignment callbacks.
        ...paletteTheme.token, motion: true,
        motionDurationFast: reduced ? "0.00001s" : cssToken("--motion-fast", "0.12s"),
        motionDurationMid: reduced ? "0.00001s" : cssToken("--motion-normal", "0.22s"),
        motionDurationSlow: reduced ? "0.00001s" : cssToken("--motion-normal", "0.22s"),
        motionEaseInOut: cssToken("--ease-in-out-smooth", "ease-in-out"),
        motionEaseOut: cssToken("--ease-out-expo", "ease-out"),
      },
    };
  }, [reduced, paletteTheme]);
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
  const id = React.useSyncExternalStore(wandThemeStore.subscribe, wandThemeStore.getSnapshot, wandThemeStore.getServerSnapshot);
  const current = getWandTheme(id);
  return <ThemeInstalled.Provider value={true}>
    <XProvider locale={{ ...zhCN, ...xZhCN }} theme={{ ...current,
      cssVar: { key: "wand-ui-measurement" }, token: { ...current.token, motion: false },
    }}>
      {children}
    </XProvider>
  </ThemeInstalled.Provider>;
}
