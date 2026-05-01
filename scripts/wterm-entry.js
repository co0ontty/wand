import { WTerm as BaseWTerm } from "@wterm/dom";
export * from "@wterm/dom";

const SGR_RE = /\x1b\[([0-9;]*)m/g;

export class WTerm extends BaseWTerm {
  write(data) {
    if (typeof data === "string") {
      data = data.replace(SGR_RE, (_m, params) => {
        if (!params) return _m;
        const kept = params.split(";").filter(p => p !== "4" && p !== "24");
        return kept.length ? "\x1b[" + kept.join(";") + "m" : "";
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
    const cols = Math.max(1, Math.floor(innerW / charW));
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
    const newCols = Math.max(1, Math.floor(width / measured.width));
    const newRows = Math.max(1, Math.floor(height / measured.height));
    if (newCols !== this.cols || newRows !== this.rows) {
      this.resize(newCols, newRows);
    } else {
      this._scheduleRender();
    }
  }
}
