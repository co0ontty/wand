import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, existsSync, chmodSync, writeFileSync, renameSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { buildChildEnv } from "./env-utils.js";

export class DingTalkError extends Error {
  constructor(readonly code: string, message: string, readonly unknownDelivery = false, readonly httpStatus?: number) { super(message); }
}
export const object = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
export const string = (v: unknown): string => typeof v === "string" ? v : "";
export const array = (v: unknown): any[] => Array.isArray(v) ? v : [];

/** The CLI's composite helpers wrap JSON in MCP text content. Never return raw envelopes/errors to a client. */
export function dwsPayload(value: unknown): Record<string, any> {
  const envelope = (v: unknown) => Array.isArray(v) ? { items: v } : object(v);
  let node = envelope(value);
  for (let i = 0; i < 12; i++) {
    if (node.ok === false || node.success === false || node.isError === true || node.error) {
      throw new DingTalkError("provider_rejected", "钉钉拒绝了操作，请核对账号权限与当前资源状态。");
    }
    if (node.response) { node = envelope(node.response); continue; }
    const text = array(node.content).find(x => x?.type === "text")?.text;
    if (typeof text === "string") {
      try { node = envelope(JSON.parse(text)); continue; } catch (error) {
        if (error instanceof DingTalkError) throw error;
        throw new DingTalkError("invalid_response", "钉钉未返回可验证的结构化结果。");
      }
    }
    const key = node.data && !Array.isArray(node.data) ? "data" : node.result && !Array.isArray(node.result) ? "result" : null;
    if (key) { const { [key]: inner, ...rest } = node; node = { ...rest, ...object(inner) }; continue; }
    return node;
  }
  throw new DingTalkError("invalid_response", "钉钉响应层级异常。");
}

export interface DwsTransport {
  call(args: string[], options?: { input?: string; write?: boolean; timeoutMs?: number }): Promise<Record<string, any>>;
  stream(args: string[], onLine: (line: string) => void, onEnd: () => void, onReady?: () => void): { close(): void };
}

export class DwsClient implements DwsTransport {
  private children = new Set<ChildProcessWithoutNullStreams>();
  private closed = false;
  private installation: Promise<void> | undefined;
  readonly configDir: string;
  constructor(private readonly directory: string, private readonly configuredBinary = process.env.WAND_DWS_BINARY) {
    this.configDir = join(directory, "dingtalk", "dws");
  }
  private get binary(): string {
    if (this.configuredBinary) {
      if (!isAbsolute(this.configuredBinary)) throw new DingTalkError("invalid_binary", "WAND_DWS_BINARY 必须是受信任的绝对路径。");
      return this.configuredBinary;
    }
    const local = join(this.directory, "dingtalk", "bin", process.platform === "win32" ? "dws.exe" : "dws");
    return existsSync(local) ? local : "dws";
  }
  private child(args: string[]) {
    // Atomic DWS leaves support @file expansion. Never grant that capability to external values.
    // The unified chat shortcut instead has an explicit --body-stdin / --text - literal-body contract.
    if (args.some(value => value.startsWith("@"))) throw new DingTalkError("literal_argument", "钉钉参数包含文件展开语法，已拒绝；消息正文应通过受限标准输入发送。");
    if (this.closed) throw new DingTalkError("closed", "钉钉连接器已关闭。");
    mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    // No shell; no HTTP-provided executable, env, path, token or command. Each business method owns its argv.
    const child = spawn(this.binary, args, { env: buildChildEnv(false, { DWS_CONFIG_DIR: this.configDir }), stdio: "pipe" });
    this.children.add(child); child.once("close", () => this.children.delete(child));
    return child;
  }
  async call(args: string[], options: { input?: string; write?: boolean; timeoutMs?: number } = {}): Promise<Record<string, any>> {
    const child = this.child([...args, "--format", "json"]);
    return new Promise((resolve, reject) => {
      let output = "", settled = false;
      const fail = (code: string, message: string, unknownDelivery = options.write ?? false) => { if (!settled) { settled = true; reject(new DingTalkError(code, message, unknownDelivery)); } };
      const timer = setTimeout(() => { fail("timeout", "钉钉操作超时，送达状态需核实；不会自动重做。"); child.kill("SIGTERM"); }, options.timeoutMs ?? 30_000);
      timer.unref?.();
      child.stdout.on("data", chunk => { output += chunk.toString(); if (Buffer.byteLength(output) > 2 * 1024 * 1024) { fail("oversize", "钉钉响应超过安全大小。"); child.kill("SIGTERM"); } });
      child.stderr.resume(); // May contain secrets: neither log, echo nor persist it.
      child.once("error", () => { clearTimeout(timer); fail("unavailable", "DWS 不可用，请先安装连接器依赖。", false); });
      child.once("close", code => {
        clearTimeout(timer);
        if (settled) return;
        try {
          if (code !== 0) throw new DingTalkError("cli_failed", "DWS 操作未确认，请检查授权、权限和资源状态。", options.write);
          const result = dwsPayload(JSON.parse(output)); settled = true; resolve(result);
        } catch (error) { settled = true; reject(error instanceof DingTalkError ? new DingTalkError(error.code, error.message, error.unknownDelivery || (!!options.write && error.code === "provider_rejected"), error.httpStatus) : new DingTalkError("invalid_response", "DWS 响应无效，操作状态需核实。", options.write)); }
      });
      child.stdin.end(options.input);
    });
  }
  stream(args: string[], onLine: (line: string) => void, onEnd: () => void, onReady?: () => void): { close(): void } {
    const child = this.child(args); let pending = "", diagnostic = "", ended = false;
    const end = () => { if (!ended) { ended = true; onEnd(); } };
    child.on("error", end); child.on("close", end);
    child.stderr.on("data", chunk => {
      diagnostic = (diagnostic + chunk.toString()).slice(-16_384);
      let newline: number;
      while ((newline = diagnostic.indexOf("\n")) >= 0) {
        const line = diagnostic.slice(0, newline); diagnostic = diagnostic.slice(newline + 1);
        // DWS documents this exact machine contract. Other diagnostic text is discarded, never logged.
        if (line.startsWith("[event] ready ")) onReady?.();
      }
    });
    child.stdout.on("data", chunk => {
      pending += chunk.toString();
      if (Buffer.byteLength(pending) > 1024 * 1024) { child.kill("SIGTERM"); end(); return; }
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) { const line = pending.slice(0, newline); pending = pending.slice(newline + 1); if (line.trim()) onLine(line); }
    });
    // Keep stdin open: DWS treats EOF as a graceful unsubscribe.
    return { close() { child.stdin.end(); child.kill("SIGTERM"); } };
  }
  dispose(): void { this.closed = true; for (const child of this.children) { child.stdin.end(); child.kill("SIGTERM"); } this.children.clear(); }
  /** Explicit admin action. Pinned release + checksum, private executable; never execute an install script. */
  install(): Promise<void> {
    if (this.installation) return this.installation;
    const work = this.installPinned(); this.installation = work;
    void work.finally(() => { if (this.installation === work) this.installation = undefined; }).catch(() => {});
    return work;
  }
  private async installPinned(): Promise<void> {
    if (!(["darwin", "linux"] as string[]).includes(process.platform) || !(["arm64", "x64"] as string[]).includes(process.arch)) throw new DingTalkError("unsupported_platform", "此系统暂不支持自动安装 DWS，请配置受信任的可执行文件。");
    const name = `dws-${process.platform}-${process.arch === "x64" ? "amd64" : "arm64"}.tar.gz`;
    const base = "https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/download/v1.0.65/";
    const checks = await boundedFetch(base + "checksums.txt", {}, 64 * 1024);
    const archive = await boundedFetch(base + name, {}, 32 * 1024 * 1024);
    const expected = checks.toString().split("\n").find(line => line.trim().split(/\s+/).at(-1) === name)?.split(/\s+/)[0];
    if (!expected || createHash("sha256").update(archive).digest("hex") !== expected) throw new DingTalkError("checksum", "DWS 下载校验失败，未安装。");
    const tar = gunzipSync(archive, { maxOutputLength: 96 * 1024 * 1024 }); let executable: Buffer | undefined;
    for (let at = 0; at + 512 <= tar.length;) {
      const header = tar.subarray(at, at + 512); const filename = header.subarray(0, 100).toString().replace(/\0.*$/, "");
      if (!filename) break;
      const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, "").trim(), 8);
      if (!Number.isSafeInteger(size) || size < 0 || at + 512 + size > tar.length) throw new DingTalkError("archive", "DWS 安装包格式无效。");
      if (filename.split("/").at(-1) === "dws" && (header[156] === 0 || header[156] === 48)) {
        if (executable) throw new DingTalkError("archive", "DWS 安装包包含重复程序。");
        executable = tar.subarray(at + 512, at + 512 + size);
      }
      at += 512 + Math.ceil(size / 512) * 512;
    }
    if (!executable?.length) throw new DingTalkError("archive", "安装包中缺少 DWS。");
    const bin = join(this.directory, "dingtalk", "bin"); mkdirSync(bin, { recursive: true, mode: 0o700 });
    const staged = join(bin, `.dws-${randomUUID()}`);
    writeFileSync(staged, executable, { mode: 0o700 }); chmodSync(staged, 0o700);
    renameSync(staged, join(bin, "dws"));
  }
}

export async function boundedFetch(url: string, init: RequestInit = {}, limit = 1024 * 1024): Promise<Buffer> {
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new DingTalkError("http_failed", "钉钉网络请求失败，请稍后核对状态。", false, response.status); }
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = response.body.getReader();
  try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > limit) throw new DingTalkError("oversize", "远端响应超过安全大小。"); chunks.push(next.value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks);
}
