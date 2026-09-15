// 终端尺寸计算（主终端 state.terminal 与工作空间分屏池共用）。
//
// 为什么不用 @xterm/addon-fit 的 proposeDimensions：xterm 6 的 FitAddon 只要
// scrollback > 0 就固定预留 14px 给 overview ruler
//   const overviewRulerWidth = scrollback === 0 ? 0 : overviewRuler?.width || 14;
// 而 Wand 从未启用 overviewRuler，xterm 只在 overviewRuler.width 有值时才创建
// ruler 画布（open() 里的 `options.overviewRuler.width && createInstance(...)`），
// 所以那 14px 是白丢的宽度：手机 / iOS 嵌入终端上表现为网格右侧永远空一条、
// 铺不满屏幕。这里复刻同一套算法，只在 ruler 真的渲染出来时才让位。

const MIN_COLS = 2;
const MIN_ROWS = 1;
/** 与 xterm / FitAddon 保持一致的 overview ruler 默认宽度。 */
const OVERVIEW_RULER_DEFAULT_WIDTH = 14;

export interface TerminalFitDimensions {
  cols: number;
  rows: number;
}

/** 读 xterm 私有渲染服务里的字符单元格尺寸（与 FitAddon 同一来源）。 */
function measureCell(term: any): { width: number; height: number } | null {
  try {
    const cell = term && term._core && term._core._renderService
      ? term._core._renderService.dimensions && term._core._renderService.dimensions.css
        ? term._core._renderService.dimensions.css.cell
        : null
      : null;
    const width = Number(cell && cell.width);
    const height = Number(cell && cell.height);
    if (!(width > 0) || !(height > 0)) return null;
    return { width, height };
  } catch {
    return null;
  }
}

function px(value: string | null | undefined): number | null {
  const parsed = parseInt(value || "", 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** ruler 只在画布真实存在时才占宽度，否则返回 0（补回 FitAddon 白扣的 14px）。 */
function overviewRulerWidth(term: any): number {
  if (Number(term && term.options && term.options.scrollback) === 0) return 0;
  try {
    if (!term.element || !term.element.querySelector(".xterm-decoration-overview-ruler")) return 0;
  } catch {
    return 0;
  }
  const configured = Number(term.options && term.options.overviewRuler && term.options.overviewRuler.width);
  return configured > 0 ? configured : OVERVIEW_RULER_DEFAULT_WIDTH;
}

/**
 * 按父容器可用宽高推算 cols/rows。父容器没有确定宽高（布局未稳定）或字符尺寸
 * 尚未测量出来时返回 null，调用方此时应退回 FitAddon。
 */
export function proposeTerminalDimensions(term: any): TerminalFitDimensions | null {
  const element = term && term.element;
  const parent = element && element.parentElement;
  if (!parent || typeof getComputedStyle !== "function") return null;
  const cell = measureCell(term);
  if (!cell) return null;

  const parentStyle = getComputedStyle(parent);
  const elementStyle = getComputedStyle(element);
  const parentWidth = px(parentStyle.getPropertyValue("width"));
  const parentHeight = px(parentStyle.getPropertyValue("height"));
  if (parentWidth === null || parentHeight === null) return null;
  const paddingHorizontal = (px(elementStyle.getPropertyValue("padding-left")) || 0)
    + (px(elementStyle.getPropertyValue("padding-right")) || 0);
  const paddingVertical = (px(elementStyle.getPropertyValue("padding-top")) || 0)
    + (px(elementStyle.getPropertyValue("padding-bottom")) || 0);
  const availableWidth = Math.max(0, parentWidth - paddingHorizontal - overviewRulerWidth(term));
  const availableHeight = parentHeight - paddingVertical;
  if (!(availableHeight > 0)) return null;

  return {
    cols: Math.max(MIN_COLS, Math.floor(availableWidth / cell.width)),
    rows: Math.max(MIN_ROWS, Math.floor(availableHeight / cell.height)),
  };
}

/**
 * 把终端 fit 到父容器。优先用 proposeTerminalDimensions（把白扣的 overview
 * ruler 宽度补回来），内部结构认不出来时退回 FitAddon，保证不会因为 xterm
 * 升级而彻底不再 fit。
 */
export function fitTerminalToContainer(term: any, fitAddon?: { fit?: () => void } | null): void {
  const dims = proposeTerminalDimensions(term);
  if (dims) {
    if (dims.cols !== term.cols || dims.rows !== term.rows) {
      try {
        if (term._core && term._core._renderService) term._core._renderService.clear();
      } catch { /* 私有 API 缺失时忽略，resize 本身仍有效 */ }
      term.resize(dims.cols, dims.rows);
    }
    return;
  }
  if (fitAddon && typeof fitAddon.fit === "function") fitAddon.fit();
}
