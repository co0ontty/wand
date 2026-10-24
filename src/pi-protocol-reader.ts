import { getManyValues, none, type Many } from "stream-chain/defs.js";
import * as streamJson from "stream-json/core/parser.js";
import type { ParserOptions, Token } from "stream-json/core/parser.js";
import Assembler from "stream-json/core/assembler.js";
import { MAX_PROTOCOL_LINE_BYTES } from "./bounded-process-output.js";
import { PI_PROTOCOL_FIELDS } from "./pi-event-projection.js";
import { PiToolResultPreview, projectPiToolResult } from "./pi-tool-result-preview.js";

// 3.7.0 exports/documented raw jsonParser at runtime, but its declaration only
// lists the gen wrapper. Keep that upstream typing gap at this verified seam.
type RawTokenizer = (input: string | typeof none) => Many<Token> | typeof none;
const { jsonParser } = streamJson as typeof streamJson & { jsonParser(options: ParserOptions): RawTokenizer };
const CHUNK_CHARS = 16 * 1024;
const MAX_DEPTH = 128;
const MAX_KEY_CHARS = 1024;
const HISTORY_EVENTS = new Set(["agent_end", "turn_end", "message_start", "message_end", "message_update"]);
const TOOL_RESULT_EVENTS = new Set(["tool_execution_end", "tool_execution_update"]);
const failure = (reason: string): Error => new Error(`Pi CLI 协议${reason}；本轮已停止，送达结果未知，不自动重试。`);

/** A single retained value, never the entire history array. Both strings and
 * structural tokens count toward the budget; overflow releases partial objects.
 * Role is tracked separately so a huge non-assistant snapshot can be discarded
 * even when its role property follows its content. */
class BoundedValue {
  private assembler: Assembler | null = new Assembler();
  private bytes = 0;
  private scalar = "";
  private key = "";
  private depth = 0;
  private roleString = false;
  role = "";
  overflow = false;

  consume(token: Token): void {
    this.bytes += "value" in token && typeof token.value === "string" ? Buffer.byteLength(JSON.stringify(token.value)) + 16 : 16;
    if (this.bytes > MAX_PROTOCOL_LINE_BYTES) {
      this.overflow = true;
      this.assembler = null;
      this.scalar = "";
    }
    if (token.name === "keyValue" && this.depth === 1) {
      this.key = token.value;
      if (this.key === "role") this.role = "";
    }
    if (token.name === "startString") {
      this.scalar = "";
      this.roleString = this.depth === 1 && this.key === "role";
      if (this.roleString) this.role = "";
    } else if (token.name === "stringChunk" || token.name === "numberChunk") {
      if (this.assembler) this.scalar += token.value;
      if (this.roleString && token.name === "stringChunk") {
        if (this.role.length + token.value.length > 64) throw failure("消息角色无效");
        this.role += token.value;
      }
    } else if (token.name === "endString" || token.name === "endNumber") {
      this.assembler?.consume({ name: token.name === "endString" ? "stringValue" : "numberValue", value: this.scalar });
      this.scalar = "";
      this.roleString = false;
    } else if (token.name === "startNumber") {
      this.scalar = "";
    } else {
      this.assembler?.consume(token);
    }
    if (token.name === "startObject" || token.name === "startArray") this.depth++;
    if (token.name === "endObject" || token.name === "endArray") this.depth--;
  }

  get value(): unknown { return this.assembler?.current; }
}

/** SAX projection of Pi JSONL. Tokenization validates even discarded history;
 * no regex/type-prefix guessing and no JSON truncation. Field order and chunk
 * boundaries do not matter. The only retained history member is the latest
 * assistant, which reconciles the streamed reply and preserves terminal errors.
 * Tool results get a bounded display preview when their exact value is too
 * large; Pi retains the original for its own model context. Assistant payloads
 * and other providers retain their strict safety limits. */
export class PiProtocolReader {
  private parser: ReturnType<typeof jsonParser> | null = null;
  private event: Record<string, unknown> = {};
  private depth = 0;
  private rootKey = "";
  private key = "";
  private inKey = false;
  private field: BoundedValue | null = null;
  private toolPreview: PiToolResultPreview | null = null;
  private fieldDepth = 0;
  private messages = false;
  private latestAssistant: unknown;
  private rawBytes = 0;
  private noise: string | null = null;
  private truncatedHead: boolean;
  private discardHead = false;

  constructor(private readonly onLine: (line: string) => void, options: { truncatedHead?: boolean } = {}) {
    // Only an explicitly truncated replay may contain an incomplete first
    // record. Never relax syntax validation for subsequent/live events.
    this.truncatedHead = options.truncatedHead === true;
  }

  push(text: string): void {
    // Slice before tokenizing: the library must never receive a giant input
    // buffer that could trigger its whole-string fast path or huge token array.
    for (let start = 0; start < text.length; start += CHUNK_CHARS) {
      const chunk = text.slice(start, start + CHUNK_CHARS);
      const parts = chunk.split("\n");
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index];
        if (!this.discardHead && part && (this.parser || this.noise !== null || part.trim())) {
          // Extensions can write diagnostic noise, and a truncated daemon log
          // can start midway through a line. Preserve bounded non-object lines
          // for the adapter's unparsed-output fact; never treat noise as refusal.
          if (!this.parser && this.noise === null && !part.trimStart().startsWith("{")) this.noise = "";
          this.rawBytes += Buffer.byteLength(part);
          if (this.noise !== null) {
            if (this.rawBytes > MAX_PROTOCOL_LINE_BYTES) throw failure("非协议输出超过 8 MiB 安全容量");
            this.noise += part;
          } else {
            this.parser ??= jsonParser({ packValues: false });
            // SAX validates discarded bodies without retaining them. Envelope
            // size is not a memory budget; retained fields have their own caps.
            this.tokenize(part);
          }
        }
        if (index < parts.length - 1) this.endLine();
      }
    }
  }

  finish(): void { this.endLine(); }

  /** Checkpoints may only advance after complete records, never mid-string. */
  get atBoundary(): boolean { return !this.parser && this.noise === null && !this.discardHead; }

  private tokenize(input: string | typeof none): void {
    let tokens: ReturnType<RawTokenizer>;
    try { tokens = this.parser!(input); }
    catch (error) {
      if (!this.truncatedHead) throw error;
      this.reset();
      this.discardHead = true;
      return;
    }
    this.consume(tokens);
  }

  private consume(tokens: ReturnType<ReturnType<typeof jsonParser>>): void {
    if (tokens === none) return;
    for (const token of getManyValues(tokens)) this.token(token);
  }

  private token(token: Token): void {
    // Keys are unpacked too: a malicious ignored key cannot grow an unbounded
    // tokenizer accumulator. Forward one bounded packed key to our assembler.
    if (token.name === "startKey") { this.inKey = true; this.key = ""; return; }
    if (this.inKey && token.name === "stringChunk") {
      this.key += token.value;
      if (this.key.length > MAX_KEY_CHARS) throw failure("属性名超过安全长度");
      return;
    }
    if (token.name === "endKey") {
      this.inKey = false;
      if (this.depth === 1) this.rootKey = this.key;
      else {
        const keyToken = { name: "keyValue", value: this.key } as const;
        this.field?.consume(keyToken);
        this.toolPreview?.consume(keyToken);
      }
      return;
    }
    const opening = token.name === "startObject" || token.name === "startArray";
    const closing = token.name === "endObject" || token.name === "endArray";
    if (this.depth === 0) {
      if (token.name !== "startObject") throw failure("顶层必须是对象");
      this.depth = 1;
      return;
    }
    if (!this.field && this.depth === 1 && !closing) {
      if (this.rootKey === "messages" && token.name === "startArray") {
        this.messages = true;
        this.latestAssistant = undefined;
      } else if (PI_PROTOCOL_FIELDS.has(this.rootKey)) {
        this.field = new BoundedValue();
        if (this.rootKey === "result" || this.rootKey === "partialResult") this.toolPreview = new PiToolResultPreview();
        this.fieldDepth = 1;
      }
    } else if (!this.field && this.messages && this.depth === 2 && !closing) {
      this.field = new BoundedValue();
      this.fieldDepth = 2;
    }
    this.field?.consume(token);
    this.toolPreview?.consume(token);
    if (opening) {
      this.depth++;
      if (this.depth > MAX_DEPTH) throw failure("嵌套超过安全深度");
    }
    if (closing) this.depth--;
    const valueEnded = closing || token.name === "endString" || token.name === "endNumber"
      || token.name === "trueValue" || token.name === "falseValue" || token.name === "nullValue";
    if (this.field && valueEnded && this.depth === this.fieldDepth) {
      if (this.messages) {
        if (this.field.role === "assistant") {
          if (this.field.overflow) throw failure("assistant 消息超过 8 MiB 安全容量");
          this.latestAssistant = this.field.value;
        }
      } else {
        const transcriptOnly = this.rootKey === "message" && ["user", "toolResult"].includes(this.field.role);
        if (this.field.overflow && !this.toolPreview && !transcriptOnly) {
          throw failure(`有效载荷 ${this.rootKey} 超过 8 MiB 安全容量`);
        }
        this.event[this.rootKey] = transcriptOnly ? { role: this.field.role }
          : this.field.overflow ? this.toolPreview?.value ?? { role: this.field.role } : this.field.value;
      }
      this.field = null;
      this.toolPreview = null;
    }
    if (this.messages && closing && this.depth === 1) {
      this.event.messages = this.latestAssistant ? [this.latestAssistant] : [];
      this.latestAssistant = undefined;
      this.messages = false;
    }
  }

  private endLine(): void {
    if (this.discardHead) {
      this.discardHead = this.truncatedHead = false;
      return;
    }
    if (this.noise !== null) {
      const line = this.noise;
      this.noise = null;
      this.rawBytes = 0;
      this.truncatedHead = false;
      this.onLine(line);
      return;
    }
    if (!this.parser) return;
    try {
      this.tokenize(none);
      if (this.discardHead) return;
      if (this.depth !== 0 || this.field) throw failure("事件不完整");
      if (typeof this.event.type !== "string") throw failure("事件缺少类型");
      if (this.rawBytes > MAX_PROTOCOL_LINE_BYTES && !HISTORY_EVENTS.has(this.event.type) && !TOOL_RESULT_EVENTS.has(this.event.type)) {
        throw failure("非汇总事件超过 8 MiB 安全容量");
      }
      let line = JSON.stringify(this.event);
      if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE_BYTES && TOOL_RESULT_EVENTS.has(this.event.type)) {
        // The aggregate may exceed the transport budget even when each field
        // fits (or when JSON escapes expand a string). Keep the event whole.
        for (const key of ["result", "partialResult"]) {
          if (key in this.event) this.event[key] = projectPiToolResult(this.event[key], true);
        }
        line = JSON.stringify(this.event);
      }
      if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE_BYTES) throw failure("有效载荷超过 8 MiB 安全容量");
      this.onLine(line);
    } catch (error) {
      throw failure(`解析失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.reset();
      this.discardHead = this.truncatedHead = false;
    }
  }

  private reset(): void {
    this.parser = null;
    this.event = {};
    this.depth = 0;
    this.rootKey = this.key = "";
    this.inKey = this.messages = false;
    this.field = null;
    this.toolPreview = null;
    this.latestAssistant = undefined;
    this.rawBytes = 0;
  }
}
