import { WTerm as BaseWTerm } from "@wterm/dom";
export * from "@wterm/dom";

const SGR_RE = /\x1b\[([0-9;]*)m/g;

// @wterm/core 的 WASM grid 把 maxCols 硬编码为 256（cellSize=12B 寻址按
// `gridPtr + (row*maxCols + col)*cellSize` 算）。任何高于 256 的 cols 写入
// 会让 renderer 在迭代到 col >= 256 时读到下一行 cell 0 甚至越界内存，表现
// 为"行内容神奇复制到下一行"。wand 在 ResizeObserver/手动 remeasure 路径
// 上无脑按 floor(innerW/charW) 算 cols，4K 全屏 13px 字号下能算出 280+ cols。
// 这里在每条可写 this.cols 的路径都 clamp 到 WASM_MAX_COLS。
const WASM_MAX_COLS = 256;

// R9: 在 SGR 字节流层剥下划线属性（"4"/"24"）。
// 这是 stripUnderlinePlugin 之外的运行时第二道防线，针对动态 SGR 流。
// 旧实现 `params.split(";").filter(p => p !== "4" && p !== "24")` 简单粗暴地
// 把所有 "4" 子段过滤，破坏 256 色 / 真彩 SGR 序列：
//   \x1b[38;5;4m  (256 色调色板 index=4 蓝色) → \x1b[38;5m  ❌ 残缺序列
//   \x1b[48;5;24m (256 色背景 index=24)        → \x1b[48;5m  ❌ 残缺序列
//   \x1b[38;2;4;0;0m (真彩 RGB(4,0,0))         → \x1b[38;2;0;0m ❌ 错切
// 残缺 SGR 会被 wterm 忽略，导致前景/背景色失效。正确做法：进入
// 38;5 / 48;5（256 色）或 38;2 / 48;2（真彩）子序列后，把后续 N 个参数
// 整体保留，不当 SGR 主参数过滤。
function filterUnderlineSGR(params) {
  if (!params) return null;
  const parts = params.split(";");
  const kept = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if ((p === "38" || p === "48") && parts[i + 1] === "5") {
      // 256-color: 38;5;N or 48;5;N — 把 N 整段透传
      kept.push(parts[i], parts[i + 1], parts[i + 2] ?? "");
      i += 2;
      continue;
    }
    if ((p === "38" || p === "48") && parts[i + 1] === "2") {
      // 24-bit color: 38;2;R;G;B or 48;2;R;G;B — 把 R/G/B 整段透传
      kept.push(parts[i], parts[i + 1], parts[i + 2] ?? "", parts[i + 3] ?? "", parts[i + 4] ?? "");
      i += 4;
      continue;
    }
    if (p === "4" || p === "24") continue; // underline on / off
    kept.push(p);
  }
  return kept.length ? "\x1b[" + kept.join(";") + "m" : "";
}

export class WTerm extends BaseWTerm {
  // 单一汇聚点：所有路径最终都走 super.resize()，在这里 clamp 一次双保险，
  // 兜住未来新增的 cols 写入路径。
  resize(cols, rows) {
    super.resize(Math.min(cols, WASM_MAX_COLS), rows);
  }

  write(data) {
    if (typeof data === "string") {
      data = data.replace(SGR_RE, (_m, params) => {
        const filtered = filterUnderlineSGR(params);
        return filtered === null ? _m : filtered;
      });
    }
    super.write(data);
  }

  reset() {
    if (!this.bridge || !this.renderer) return;
    this.bridge.init(this.cols, this.rows);
    this.renderer.setup(this.cols, this.rows);
    this._scheduleRender();
  }

  // BaseWTerm._setupResizeObserver 在 init() 内部只跑一次，且
  // _measureCharSize() 拿不到非零尺寸时会静默 early-return。
  // wand 的 .terminal-container 默认 display:none、Android WebView
  // 切回前台第一帧 offsetWidth 也可能瞬时为 0，这两种情况下
  // ResizeObserver 永远不会挂上——后续容器变可见时 wterm 还停在
  // 构造时硬编码的 120 cols，渲染就会比可视区宽很多，整行被切掉。
  // 这里在 init 后跟踪重试，直到容器真正可测量再挂 observer；
  // remeasure 也兜底一下，保证显式触发的 fit 同时把 observer 救回来。
  async init() {
    // super.init() 内部的 bridge.init(this.cols, this.rows) /
    // renderer.setup(this.cols, this.rows) 用的是构造时传入的硬编码
    // 默认值（wand 调用方传 120x36）。如果此时容器已可测量，先把
    // this.cols/rows 校准到真实尺寸，让 WASM grid 与 DOM rows 从一开始
    // 就按真实列宽排版——避免"先按 120 cols 写入历史 → ResizeObserver
    // 异步 fire → wterm.resize → softResync 重写"这个时序窗口里出现的
    // 错列宽叠加帧（典型现象：手机首次打开终端 banner 重叠 + 字符错位，
    // 操作一下才恢复）。容器尚不可测量时静默跳过，留给原有的
    // _scheduleObserverSetup / 调用方的 ensureTerminalFit 兜底。
    this._calibrateInitialSize();
    await super.init();
    if (this.autoResize && !this.resizeObserver && !this._destroyed) {
      this._scheduleObserverSetup();
    }
    return this;
  }

  _calibrateInitialSize() {
    if (!this.element || !this._container) return;
    if (!this.element.isConnected) return;
    // Force layout flush so freshly attached / just-shown containers
    // expose real clientWidth instead of a stale 0 from before paint.
    void this.element.offsetHeight;
    const probe = document.createElement("span");
    probe.className = "term-cell";
    probe.style.cssText = "position:absolute;visibility:hidden;left:-9999px;top:0;";
    probe.textContent = "W";
    this._container.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    const charW = rect.width;
    const charH = rect.height;
    probe.remove();
    if (charW <= 0 || charH <= 0) return;
    const cs = getComputedStyle(this.element);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const innerW = this.element.clientWidth - padX;
    const innerH = this.element.clientHeight - padY;
    if (innerW <= 0 || innerH <= 0) return;
    const cols = Math.min(Math.max(1, Math.floor(innerW / charW)), WASM_MAX_COLS);
    const rows = Math.max(1, Math.floor(innerH / charH));
    this.cols = cols;
    this.rows = rows;
  }

  _scheduleObserverSetup() {
    if (this._observerSetupPending) return;
    this._observerSetupPending = true;
    let attempts = 0;
    const maxAttempts = 120; // ~2 秒，覆盖 Android resume / 慢字体加载
    const tick = () => {
      if (this._destroyed || this.resizeObserver) {
        this._observerSetupPending = false;
        return;
      }
      // 强制 layout flush，否则 Android WebView resume 后第一帧
      // offsetWidth 经常残留为 0。
      void this.element.offsetHeight;
      const measured = this._measureCharSize();
      if (measured && this.element.clientWidth > 0 && this.element.clientHeight > 0) {
        this._setupResizeObserver();
        this._observerSetupPending = false;
        return;
      }
      if (++attempts >= maxAttempts) {
        this._observerSetupPending = false;
        return;
      }
      if (attempts <= 8) requestAnimationFrame(tick);
      else setTimeout(tick, 50);
    };
    requestAnimationFrame(tick);
  }

  remeasure() {
    if (!this.bridge || !this.renderer) return;
    if (this.autoResize && !this.resizeObserver && !this._destroyed) {
      // 调用方明确说"现在请重新量"，说明它认为容器已可见——
      // 直接尝试同步挂 observer，挂不上再退回到延迟轮询。
      const probe = this._measureCharSize();
      if (probe && this.element.clientWidth > 0 && this.element.clientHeight > 0) {
        this._setupResizeObserver();
      } else {
        this._scheduleObserverSetup();
      }
    }
    const measured = this._measureCharSize();
    if (!measured) return;
    const cs = getComputedStyle(this.element);
    const width = this.element.clientWidth
      - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    const height = this.element.clientHeight
      - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
    if (width <= 0 || height <= 0) return;
    const newCols = Math.min(Math.max(1, Math.floor(width / measured.width)), WASM_MAX_COLS);
    const newRows = Math.max(1, Math.floor(height / measured.height));
    if (newCols !== this.cols || newRows !== this.rows) {
      this.resize(newCols, newRows);
    } else {
      this._scheduleRender();
    }
  }
}
