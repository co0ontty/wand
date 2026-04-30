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

  remeasure() {
    if (!this.bridge || !this.renderer) return;
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
