/**
 * 侧栏两种形态的统一判定：停靠（推开主内容）⟷ 抽屉（覆盖主内容）。
 *
 * 历史实现只看视口宽度 ≤ 768：iPad 竖屏（768）、安卓平板竖屏（712）以及
 * 640–768 宽的桌面窗口都被当成手机，侧栏变成覆盖式抽屉 + 全屏模糊背板，
 * 右边区域整块被盖住（用户反馈「打开侧边栏，右边的区域直接被盖住了，没有压缩」）。
 *
 * 现在的规则与原生端一致（ios/Wand/NativeRootView.swift 的 `usesWideListDetail`、
 * android/…/ui/WandApp.kt 的 `WideLayoutMinWidth/MinHeight` 同为 640×480）：
 * 宽度够（≥ 640px）就停靠，把主内容按侧栏宽度推开；更窄的才是手机抽屉。
 * 触摸设备另加高度门槛——横屏手机高度不足 480px，两栏都放不下，仍然走抽屉；
 * 桌面上的矮窗口（例如分屏出来的 1200×420）不受影响，依旧停靠。
 *
 * 涉及布局宽度的 CSS 断点必须与此保持一致（`src/web-ui/content/styles.css`）：
 * `.main-layout.sidebar-pinned` 的 padding 在 `min-width: 640px` 生效、
 * 在 `max-width: 639.98px` 归零，成对出现，不能各自为政——否则会出现
 * 「JS 认为停靠、CSS 不补 padding」的覆盖态。
 */

/** 停靠所需的最小宽度，与 CSS `min-width: 640px` 断点一致。 */
export const SIDEBAR_PUSH_MIN_WIDTH = 640;

/** 触摸设备停靠所需的最小高度，与原生端 `usesWideListDetail` 一致。 */
export const SIDEBAR_PUSH_MIN_HEIGHT = 480;

export interface SidebarLayoutViewport {
  readonly width: number;
  readonly height: number;
  /** `(pointer: coarse)`：触摸优先设备。 */
  readonly coarsePointer: boolean;
}

/** true = 抽屉（覆盖主内容）；false = 停靠（推开主内容）。 */
export function usesSidebarDrawer(viewport: SidebarLayoutViewport): boolean {
  if (!(viewport.width >= SIDEBAR_PUSH_MIN_WIDTH)) return true;
  return viewport.coarsePointer && viewport.height < SIDEBAR_PUSH_MIN_HEIGHT;
}
