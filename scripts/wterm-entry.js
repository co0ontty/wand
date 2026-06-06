// ── Polyfills for old WebView / Chromium < 80 ──
// TextEncoder polyfill (some old Android WebView builds strip it)
if (typeof TextEncoder === "undefined") {
  (function() {
    var TE = function(encoding) {
      this.encoding = encoding || "utf-8";
    };
    TE.prototype.encode = function(str) {
      str = String(str);
      var len = str.length;
      var bytes = [];
      for (var i = 0; i < len; i++) {
        var cp = str.charCodeAt(i);
        if (cp < 0x80) {
          bytes.push(cp);
        } else if (cp < 0x800) {
          bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
        } else if (cp < 0xd800 || cp >= 0xe000) {
          bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        } else {
          // surrogate pair
          i++;
          if (i < len) {
            var cp2 = str.charCodeAt(i);
            var full = 0x10000 + ((cp & 0x3ff) << 10) + (cp2 & 0x3ff);
            bytes.push(
              0xf0 | (full >> 18),
              0x80 | ((full >> 12) & 0x3f),
              0x80 | ((full >> 6) & 0x3f),
              0x80 | (full & 0x3f)
            );
          }
        }
      }
      return new Uint8Array(bytes);
    };
    self.TextEncoder = TE;
  })();
}
// TextDecoder polyfill
if (typeof TextDecoder === "undefined") {
  (function() {
    var TD = function(encoding) {
      this.encoding = encoding || "utf-8";
    };
    TD.prototype.decode = function(buf) {
      var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      var str = "";
      var i = 0;
      var len = bytes.length;
      while (i < len) {
        var b = bytes[i++];
        if (b < 0x80) {
          str += String.fromCharCode(b);
        } else if ((b & 0xe0) === 0xc0) {
          str += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
        } else if ((b & 0xf0) === 0xe0) {
          str += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
        } else {
          var cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
          cp -= 0x10000;
          str += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        }
      }
      return str;
    };
    self.TextDecoder = TD;
  })();
}

import { WTerm as BaseWTerm } from "@wterm/dom";
export * from "@wterm/dom";

const SGR_RE = /\x1b\[([0-9;]*)m/g;

// @wterm/core 的 WASM grid 把 maxCols 硬编码为 256（cellSize=12B 寻址按
// `gridPtr + (row*maxCols + col)*cellSize` 算）。任何高于 256 的 cols 写入
// 会让 renderer 在迭代到 col >= 256 时读到下一行 cell 0 甚至越界内存，表现
// 为"行内容神奇复制到下一行"。wand 在 ResizeObserver/手动 remeasure 路径
// 上无脑按 floor(innerW/charW) 算 cols，4K 全屏 13px 字号下能算出 280+ cols。
// 这里做一个简单的 clamp 防止浏览器 resize 导致 grid OOB。
const HARD_COLS_LIMIT = 256;

class ClampedWTerm extends BaseWTerm {
  open(parent, options) {
    const clamped = { ...options };
    if (typeof clamped.cols === "number" && clamped.cols > HARD_COLS_LIMIT) {
      clamped.cols = HARD_COLS_LIMIT;
    }
    return super.open(parent, clamped);
  }

  resize(cols, rows) {
    if (typeof cols === "number" && cols > HARD_COLS_LIMIT) {
      cols = HARD_COLS_LIMIT;
    }
    return super.resize(cols, rows);
  }
}

export { ClampedWTerm as WTerm };
