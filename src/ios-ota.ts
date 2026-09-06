import { open } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

export interface IosIpaMetadata {
  bundleId: string;
  bundleVersion: string;
  bundleBuild: string;
  title: string;
  signed: boolean;
}

export type IosOtaBlocker = "unsigned-ipa" | "not-https" | "remote-ipa";

export interface IosOtaManifestInput {
  ipaUrl: string;
  bundleId: string;
  bundleVersion: string;
  title: string;
  displayImageUrl?: string;
  fullSizeImageUrl?: string;
}

const DEFAULT_BUNDLE_ID = "com.wand.app";
const DEFAULT_TITLE = "Wand";

export function publicOriginFromRequest(req: {
  protocol?: string;
  headers: Record<string, string | string[] | undefined>;
}): string | null {
  const forwardedProto = firstHeader(req.headers["x-forwarded-proto"])
    ?? forwardedParam(firstHeader(req.headers.forwarded), "proto");
  const proto = normalizeProtocol(forwardedProto)
    ?? (firstHeader(req.headers["x-forwarded-ssl"])?.toLowerCase() === "on" ? "https" : undefined)
    ?? (firstHeader(req.headers["x-forwarded-scheme"])?.toLowerCase() === "https" ? "https" : undefined)
    ?? normalizeProtocol(req.protocol);
  const host = firstHeader(req.headers["x-forwarded-host"])
    ?? forwardedParam(firstHeader(req.headers.forwarded), "host")
    ?? firstHeader(req.headers.host);
  if (!proto || !host) return null;
  return `${proto}://${host}`;
}

export function normalizePublicOrigin(value: string | undefined | null): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname || parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function absoluteUrl(origin: string, pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const base = origin.endsWith("/") ? origin : `${origin}/`;
  return new URL(pathOrUrl.startsWith("/") ? pathOrUrl.slice(1) : pathOrUrl, base).href;
}

export function buildItmsServicesUrl(manifestUrl: string): string {
  return `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;
}

export function collectIosOtaBlockers(options: {
  signed: boolean;
  origin: string | null;
  source: "local" | "github";
}): IosOtaBlocker[] {
  const blockers: IosOtaBlocker[] = [];
  if (options.source !== "local") blockers.push("remote-ipa");
  if (!options.signed) blockers.push("unsigned-ipa");
  if (!options.origin?.startsWith("https://")) blockers.push("not-https");
  return blockers;
}

export function buildIosOtaManifest(input: IosOtaManifestInput): string {
  const assets = [
    dictEntries([
      ["kind", "software-package"],
      ["url", input.ipaUrl],
    ]),
  ];
  if (input.displayImageUrl) {
    assets.push(dictEntries([
      ["kind", "display-image"],
      ["url", input.displayImageUrl],
    ]));
  }
  if (input.fullSizeImageUrl) {
    assets.push(dictEntries([
      ["kind", "full-size-image"],
      ["url", input.fullSizeImageUrl],
    ]));
  }
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `<key>items</key>`,
    `<array>`,
    `<dict>`,
    `<key>assets</key>`,
    `<array>`,
    assets.join("\n"),
    `</array>`,
    `<key>metadata</key>`,
    dictEntries([
      ["bundle-identifier", input.bundleId],
      ["bundle-version", input.bundleVersion],
      ["kind", "software"],
      ["title", input.title],
    ]),
    `</dict>`,
    `</array>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

export function buildIosInstallPage(options: {
  title: string;
  version: string;
  sizeLabel: string;
  installUrl: string;
  downloadUrl: string;
  signed: boolean;
  https: boolean;
}): string {
  const warnings: string[] = [];
  if (!options.https) {
    warnings.push("当前页面不是 HTTPS。iOS 系统安装器会拒绝安装，请用受信任证书的公开地址打开。");
  }
  if (!options.signed) {
    warnings.push("当前 IPA 未签名。系统安装会失败；签发后再放到更新目录即可 OTA 覆盖安装。");
  }
  const warningHtml = warnings.length
    ? `<div class="warn">${warnings.map((item) => `<p>${escapeHtml(item)}</p>`).join("")}</div>`
    : "";
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>安装 ${escapeHtml(options.title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 32px 20px; }
    main { max-width: 420px; margin: 0 auto; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    p { margin: 0 0 12px; color: #5c564f; }
    .meta { color: #7a7168; font-size: 14px; margin-bottom: 20px; }
    a.install { display: block; text-align: center; background: #c5653d; color: #fff; text-decoration: none; padding: 14px 16px; border-radius: 12px; font-weight: 650; }
    a.secondary { display: block; text-align: center; margin-top: 12px; color: #c5653d; }
    .warn { background: rgba(197,101,61,.12); border-radius: 12px; padding: 12px 14px; margin-bottom: 18px; }
    .hint { font-size: 13px; color: #7a7168; margin-top: 18px; }
  </style>
</head>
<body>
  <main>
    <h1>安装 ${escapeHtml(options.title)}</h1>
    <div class="meta">版本 ${escapeHtml(options.version)} · ${escapeHtml(options.sizeLabel)}</div>
    ${warningHtml}
    <a class="install" href="${escapeHtml(options.installUrl)}">在 iPhone 上安装</a>
    <a class="secondary" href="${escapeHtml(options.downloadUrl)}">下载 IPA</a>
    <p class="hint">请用 Safari 打开本页。安装后如提示未受信任，到 设置 → 通用 → VPN 与设备管理 中信任，iOS 18 企业包可能需要重启。</p>
  </main>
</body>
</html>
`;
}

export async function inspectIpa(
  filePath: string,
  fallback: { version?: string | null } = {},
): Promise<IosIpaMetadata> {
  const entries = await listZipEntries(filePath);
  const signed = entries.some((entry) =>
    entry.name.endsWith("embedded.mobileprovision")
    || entry.name.includes("_CodeSignature/")
  );
  const infoEntry = entries.find((entry) => /^Payload\/[^/]+\.app\/Info\.plist$/i.test(entry.name));
  let bundleId = DEFAULT_BUNDLE_ID;
  let bundleVersion = fallback.version?.trim() || "";
  let bundleBuild = bundleVersion;
  let title = DEFAULT_TITLE;
  if (infoEntry) {
    try {
      const plist = parseIosInfoPlist(await readZipEntry(filePath, infoEntry));
      bundleId = stringValue(plist.CFBundleIdentifier) || bundleId;
      bundleVersion = stringValue(plist.CFBundleShortVersionString) || bundleVersion;
      bundleBuild = stringValue(plist.CFBundleVersion) || bundleVersion;
      title = stringValue(plist.CFBundleDisplayName) || stringValue(plist.CFBundleName) || title;
    } catch {
      // 解析失败时用文件名版本和默认 bundle id，仍允许检查更新。
    }
  }
  if (!bundleVersion) bundleVersion = fallback.version?.trim() || "0.0.0";
  if (!bundleBuild) bundleBuild = bundleVersion;
  return { bundleId, bundleVersion, bundleBuild, title, signed };
}

interface ZipEntry {
  name: string;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

async function listZipEntries(filePath: string): Promise<ZipEntry[]> {
  const handle = await open(filePath, "r");
  try {
    const stat = await handle.stat();
    const tailSize = Math.min(stat.size, 64 * 1024);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, stat.size - tailSize);
    const eocd = findEocd(tail);
    if (!eocd) throw new Error("IPA 不是有效的 zip。");
    const cd = Buffer.alloc(eocd.cdSize);
    await handle.read(cd, 0, eocd.cdSize, eocd.cdOffset);
    const entries: ZipEntry[] = [];
    let offset = 0;
    while (offset + 46 <= cd.length) {
      if (cd.readUInt32LE(offset) !== 0x02014b50) break;
      const compression = cd.readUInt16LE(offset + 10);
      const compressedSize = cd.readUInt32LE(offset + 20);
      const uncompressedSize = cd.readUInt32LE(offset + 24);
      const nameLength = cd.readUInt16LE(offset + 28);
      const extraLength = cd.readUInt16LE(offset + 30);
      const commentLength = cd.readUInt16LE(offset + 32);
      const localHeaderOffset = cd.readUInt32LE(offset + 42);
      const nameStart = offset + 46;
      const nameEnd = nameStart + nameLength;
      if (nameEnd > cd.length) break;
      entries.push({
        name: cd.subarray(nameStart, nameEnd).toString("utf8"),
        compression,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
      offset = nameEnd + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

async function readZipEntry(filePath: string, entry: ZipEntry): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(30);
    await handle.read(header, 0, 30, entry.localHeaderOffset);
    if (header.readUInt32LE(0) !== 0x04034b50) throw new Error("IPA 本地文件头无效。");
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
    const compressed = Buffer.alloc(entry.compressedSize);
    if (entry.compressedSize > 0) {
      await handle.read(compressed, 0, entry.compressedSize, dataOffset);
    }
    if (entry.compression === 0) return compressed;
    if (entry.compression === 8) return inflateRawSync(compressed);
    throw new Error(`不支持的 IPA 压缩方式：${entry.compression}`);
  } finally {
    await handle.close();
  }
}

function findEocd(tail: Buffer): { cdOffset: number; cdSize: number } | null {
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) !== 0x06054b50) continue;
    const commentLength = tail.readUInt16LE(i + 20);
    if (i + 22 + commentLength !== tail.length) continue;
    return {
      cdSize: tail.readUInt32LE(i + 12),
      cdOffset: tail.readUInt32LE(i + 16),
    };
  }
  return null;
}

function parseIosInfoPlist(buffer: Buffer): Record<string, unknown> {
  if (buffer.subarray(0, 8).toString("ascii") === "bplist00") {
    const parsed = parseBinaryPlist(buffer);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  }
  return parseXmlPlistStrings(buffer.toString("utf8"));
}

function parseXmlPlistStrings(xml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const pattern = /<key>([^<]+)<\/key>\s*<(string|integer)>([^<]*)<\/\2>/g;
  for (const match of xml.matchAll(pattern)) {
    result[match[1]] = match[3];
  }
  return result;
}

function parseBinaryPlist(buffer: Buffer): unknown {
  const trailer = buffer.subarray(buffer.length - 32);
  const offsetSize = trailer[6];
  const objectRefSize = trailer[7];
  const objectCount = Number(trailer.readBigUInt64BE(8));
  const topObject = Number(trailer.readBigUInt64BE(16));
  const offsetTableOffset = Number(trailer.readBigUInt64BE(24));
  const offsetTable = buffer.subarray(offsetTableOffset);
  const readOffset = (index: number): number => readSizedInt(offsetTable, index * offsetSize, offsetSize);
  const cache = new Array<unknown>(objectCount);
  const seen = new Set<number>();

  const parseObject = (index: number): unknown => {
    if (index < 0 || index >= objectCount) throw new Error("bplist 对象引用越界。");
    if (seen.has(index)) return cache[index];
    seen.add(index);
    let cursor = readOffset(index);
    const marker = buffer[cursor];
    cursor += 1;
    const nibble = marker & 0x0f;
    const readLength = (): number => {
      if (nibble !== 0x0f) return nibble;
      const lengthMarker = buffer[cursor];
      cursor += 1;
      const lengthSize = 1 << (lengthMarker & 0x0f);
      const length = readSizedInt(buffer, cursor, lengthSize);
      cursor += lengthSize;
      return length;
    };

    switch (marker & 0xf0) {
      case 0x00:
        cache[index] = marker === 0x08 ? false : marker === 0x09 ? true : null;
        return cache[index];
      case 0x10: {
        const size = 1 << nibble;
        cache[index] = readSizedInt(buffer, cursor, size);
        return cache[index];
      }
      case 0x20: {
        const size = 1 << nibble;
        cache[index] = size === 4 ? buffer.readFloatBE(cursor) : buffer.readDoubleBE(cursor);
        return cache[index];
      }
      case 0x30:
        cache[index] = new Date(978307200000 + buffer.readDoubleBE(cursor) * 1000);
        return cache[index];
      case 0x40: {
        const length = readLength();
        cache[index] = buffer.subarray(cursor, cursor + length);
        return cache[index];
      }
      case 0x50: {
        const length = readLength();
        cache[index] = buffer.subarray(cursor, cursor + length).toString("ascii");
        return cache[index];
      }
      case 0x60: {
        const length = readLength();
        const utf16 = buffer.subarray(cursor, cursor + length * 2);
        const swapped = Buffer.alloc(utf16.length);
        for (let i = 0; i + 1 < utf16.length; i += 2) {
          swapped[i] = utf16[i + 1];
          swapped[i + 1] = utf16[i];
        }
        cache[index] = swapped.toString("utf16le");
        return cache[index];
      }
      case 0xa0: {
        const length = readLength();
        const values = [];
        for (let i = 0; i < length; i += 1) {
          values.push(parseObject(readSizedInt(buffer, cursor + i * objectRefSize, objectRefSize)));
        }
        cache[index] = values;
        return cache[index];
      }
      case 0xd0: {
        const length = readLength();
        const record: Record<string, unknown> = {};
        for (let i = 0; i < length; i += 1) {
          const key = parseObject(readSizedInt(buffer, cursor + i * objectRefSize, objectRefSize));
          const value = parseObject(readSizedInt(buffer, cursor + (length + i) * objectRefSize, objectRefSize));
          record[String(key)] = value;
        }
        cache[index] = record;
        return cache[index];
      }
      default:
        cache[index] = null;
        return null;
    }
  };

  return parseObject(topObject);
}

function readSizedInt(buffer: Buffer, offset: number, size: number): number {
  if (size === 1) return buffer.readUInt8(offset);
  if (size === 2) return buffer.readUInt16BE(offset);
  if (size === 4) return buffer.readUInt32BE(offset);
  if (size === 8) return Number(buffer.readBigUInt64BE(offset));
  let value = 0;
  for (let i = 0; i < size; i += 1) value = value * 256 + buffer[offset + i];
  return value;
}

function dictEntries(entries: Array<[string, string]>): string {
  return [
    `<dict>`,
    ...entries.flatMap(([key, value]) => [`<key>${escapeXml(key)}</key>`, `<string>${escapeXml(value)}</string>`]),
    `</dict>`,
  ].join("\n");
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim();
}

function forwardedParam(header: string | undefined, key: string): string | undefined {
  if (!header) return undefined;
  const target = `${key}=`;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.toLowerCase().startsWith(target)) continue;
    return trimmed.slice(target.length).replace(/^"|"$/g, "");
  }
  return undefined;
}

function normalizeProtocol(value: string | undefined): "http" | "https" | undefined {
  const proto = value?.trim().toLowerCase();
  if (proto === "http" || proto === "https") return proto;
  return undefined;
}

function stringValue(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeHtml(value: string): string {
  return escapeXml(value);
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "未知大小";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function formatIosAssetSize(size: number): string {
  return formatBytes(size);
}
