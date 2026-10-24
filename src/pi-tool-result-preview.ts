import type { Token } from "stream-json/core/parser.js";
import { MAX_PROTOCOL_LINE_BYTES } from "./bounded-process-output.js";

const GROUP_BYTES = 192 * 1024;
const STRING_CHARS = 16 * 1024;
const NOTICE = "[工具结果较大，Wand 仅展示有界预览；工具执行与后续答复继续。]";
const OMITTED_IMAGE = "[大图片未内嵌到工具结果预览中]";
interface Budget { remaining: number; }
interface Frame {
  value: Record<string, unknown> | unknown[];
  key: string;
  budget: Budget;
  retained: boolean;
  omitted: boolean;
}

/** A display-only fallback, built alongside the exact bounded value. It never
 * changes Pi's own tool result/model context. Independent root-field budgets
 * keep a large content body from swallowing later execution details (or vice
 * versa). All tokens, including omitted subtrees, still pass the JSON parser. */
export class PiToolResultPreview {
  private readonly budgets = new Map<string, Budget>();
  private readonly stack: Frame[] = [];
  private root: unknown;
  private scalar = "";
  private tail = "";
  private scalarOmitted = false;
  private scalarLimit = STRING_CHARS;
  private detailsOmitted = false;

  private budget(): Budget {
    const field = this.stack[0]?.key;
    const group = field === "content" || field === "details" ? field : "other";
    let budget = this.budgets.get(group);
    if (!budget) this.budgets.set(group, budget = { remaining: GROUP_BYTES });
    return this.stack.length > 1 ? this.stack.at(-1)!.budget : budget;
  }

  private attach(value: unknown, omitted: boolean): void {
    const parent = this.stack.at(-1);
    if (!parent) { this.root = value; return; }
    parent.omitted ||= omitted;
    if (this.stack.length === 1 && parent.key === "details") this.detailsOmitted ||= omitted;
    if (!parent.retained || value === undefined) return;
    if (Array.isArray(parent.value)) parent.value.push(value);
    else Object.defineProperty(parent.value, parent.key, { value, enumerable: true, configurable: true, writable: true });
  }

  consume(token: Token): void {
    if (token.name === "keyValue") {
      const parent = this.stack.at(-1);
      if (parent) parent.key = token.value;
      return;
    }
    if (token.name === "startObject" || token.name === "startArray") {
      const budget = this.budget();
      const key = this.stack.at(-1)?.key ?? "";
      const cost = 32 + Buffer.byteLength(JSON.stringify(key));
      const retained = (this.stack.at(-1)?.retained ?? true) && budget.remaining >= cost;
      if (retained) budget.remaining -= cost;
      this.stack.push({ value: token.name === "startArray" ? [] : {}, key: "", budget, retained, omitted: !retained });
      return;
    }
    if (token.name === "endObject" || token.name === "endArray") {
      const frame = this.stack.pop()!;
      let value = frame.retained ? frame.value : undefined;
      // A shortened base64/data URL is not a valid image. Replace its complete
      // part with readable text rather than sending corrupted image data.
      if (frame.omitted && !Array.isArray(value) && (value?.type === "image" || value?.type === "image_url")) {
        value = { type: "text", text: OMITTED_IMAGE };
      }
      this.attach(value, frame.omitted);
      return;
    }
    if (token.name === "startString" || token.name === "startNumber") {
      this.scalar = this.tail = "";
      this.scalarOmitted = false;
      // Worst-case JSON escaping costs six bytes per character. Leave room
      // for the omission marker and key so the assembled fallback stays small.
      this.scalarLimit = Math.min(STRING_CHARS, Math.max(0, Math.floor((this.budget().remaining - 512) / 6)));
      return;
    }
    if (token.name === "stringChunk" || token.name === "numberChunk") {
      const room = this.scalarLimit - this.scalar.length;
      this.scalar += token.value.slice(0, room);
      if (token.value.length > room) {
        this.scalarOmitted = true;
        this.tail = this.scalarLimit ? (this.tail + token.value.slice(room)).slice(-this.scalarLimit) : "";
      }
      return;
    }
    if (token.name === "endString" || token.name === "endNumber") {
      // Prefix/tail cuts may land between the two UTF-16 halves of a scalar.
      const head = this.scalarOmitted && /[\uD800-\uDBFF]$/.test(this.scalar) ? this.scalar.slice(0, -1) : this.scalar;
      const tail = /^[\uDC00-\uDFFF]/.test(this.tail) ? this.tail.slice(1) : this.tail;
      const value = token.name === "endNumber" ? (this.scalarOmitted ? null : Number(this.scalar))
        : this.scalarOmitted ? head + "\n[…预览省略…]\n" + tail : this.scalar;
      this.keep(value, this.scalarOmitted);
      this.scalar = this.tail = "";
      return;
    }
    if (token.name === "trueValue" || token.name === "falseValue" || token.name === "nullValue") {
      this.keep(token.name === "nullValue" ? null : token.name === "trueValue", false);
    }
  }

  private keep(value: unknown, omitted: boolean): void {
    const budget = this.budget();
    const key = this.stack.at(-1)?.key ?? "";
    const bytes = Buffer.byteLength(JSON.stringify(value)) + Buffer.byteLength(JSON.stringify(key)) + 2;
    if (bytes > budget.remaining) { this.attach(undefined, true); return; }
    budget.remaining -= bytes;
    this.attach(value, omitted);
  }

  get value(): Record<string, unknown> {
    const result = this.root && typeof this.root === "object" && !Array.isArray(this.root)
      ? this.root as Record<string, unknown> : {};
    const raw = result.content ?? result.output ?? this.root;
    const text = typeof raw === "string" ? raw : raw === undefined ? "" : JSON.stringify(raw);
    const content = Array.isArray(raw) ? [...raw, { type: "text", text: NOTICE }]
      : [{ type: "text", text: (text ? text + "\n" : "") + NOTICE }];
    // Partial execution inventories must not be advertised as complete.
    const details = result.details && typeof result.details === "object" && !Array.isArray(result.details)
      ? this.detailsOmitted ? { ...result.details, inventoryComplete: false } : result.details : undefined;
    return { content, ...(details ? { details } : {}) };
  }
}

/** Native extension events already exist as objects. Walk them in small scalar
 * slices instead of allocating a second giant JSON string before projection. */
export function projectPiToolResult(value: unknown, forcePreview = false): unknown {
  const preview = new PiToolResultPreview();
  const seen = new Set<object>();
  let bytes = 0;
  const emit = (token: Token): void => {
    bytes += "value" in token && typeof token.value === "string" ? Buffer.byteLength(JSON.stringify(token.value)) + 16 : 16;
    preview.consume(token);
  };
  function visit(raw: unknown, depth: number): void {
    if (depth > 128) throw new Error("Pi 工具结果嵌套超过安全深度");
    if (typeof raw === "string" || typeof raw === "number") {
      const string = typeof raw === "string";
      const text = string ? raw : String(raw);
      if (!string && !Number.isFinite(raw)) { emit({ name: "nullValue", value: null }); return; }
      emit({ name: string ? "startString" : "startNumber" });
      for (let offset = 0; offset < text.length; offset += STRING_CHARS) {
        emit({ name: string ? "stringChunk" : "numberChunk", value: text.slice(offset, offset + STRING_CHARS) });
      }
      emit({ name: string ? "endString" : "endNumber" });
    } else if (typeof raw === "boolean") emit(raw ? { name: "trueValue", value: true } : { name: "falseValue", value: false });
    else if (!raw || typeof raw !== "object") {
      if (typeof raw === "bigint") throw new TypeError("Pi 工具结果包含不可序列化的 bigint");
      emit({ name: "nullValue", value: null });
    } else {
      if (seen.has(raw)) throw new TypeError("Pi 工具结果包含循环引用");
      seen.add(raw);
      if (Array.isArray(raw)) {
        emit({ name: "startArray" });
        for (const item of raw) visit(item, depth + 1);
        emit({ name: "endArray" });
      } else {
        emit({ name: "startObject" });
        for (const key of Object.keys(raw)) {
          const item = (raw as Record<string, unknown>)[key];
          if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
          emit({ name: "keyValue", value: key });
          visit(item, depth + 1);
        }
        emit({ name: "endObject" });
      }
      seen.delete(raw);
    }
  }
  visit(value, 0);
  return forcePreview || bytes > MAX_PROTOCOL_LINE_BYTES ? preview.value : value;
}
