import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

interface CertificatePaths {
  keyPath: string;
  certPath: string;
}

export interface SSLConfig {
  key: Buffer;
  cert: Buffer;
  /** 实际生效的证书路径，用于 `/cert/server.crt` 下载路由。 */
  certPath: string;
  /** SHA-256 指纹（大写 + 冒号分隔），方便用户在浏览器里核对。 */
  fingerprint: string;
  /** 是否走的是用户自备证书。true = 自带，false = wand 自签。 */
  userProvided: boolean;
}

export interface EnsureCertificatesOptions {
  /** 用户自带证书路径（PEM）。配了且存在就直接用。 */
  userCertPath?: string;
  userKeyPath?: string;
}

function getCertificatePaths(configDir: string): CertificatePaths {
  return {
    keyPath: path.join(configDir, "server.key"),
    certPath: path.join(configDir, "server.crt")
  };
}

function certificatesExist(paths: CertificatePaths): boolean {
  return existsSync(paths.keyPath) && existsSync(paths.certPath);
}

function readPair(keyPath: string, certPath: string): { key: Buffer; cert: Buffer } | null {
  try {
    if (!existsSync(keyPath) || !existsSync(certPath)) return null;
    return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
  } catch {
    return null;
  }
}

/**
 * 收集本机所有可外部访问的 IPv4 地址 + hostname，作为自签证书的 SAN。
 * 之前 SAN 只有 `localhost,127.0.0.1`，从手机/局域网用 `https://192.168.x.x` 访问
 * 时浏览器会直接拒绝（NET::ERR_CERT_COMMON_NAME_INVALID），连页面都打不开。
 */
function collectSanEntries(): { dns: string[]; ip: string[] } {
  const dns = new Set<string>(["localhost"]);
  const ip = new Set<string>(["127.0.0.1", "::1"]);
  const hostname = os.hostname();
  if (hostname && hostname !== "localhost") {
    dns.add(hostname);
    // 部分 mDNS 环境下 hostname.local 也能解析
    if (!hostname.endsWith(".local")) dns.add(`${hostname}.local`);
  }
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const entry of list) {
      if (entry.internal) continue;
      // Node 18+ entry.family 是 "IPv4" | "IPv6"，旧版本是 4 | 6
      const fam = entry.family as unknown;
      if (fam === "IPv4" || fam === 4 || fam === "IPv6" || fam === 6) {
        ip.add(entry.address.split("%")[0]); // 去掉 zone-id
      }
    }
  }
  return { dns: [...dns], ip: [...ip] };
}

function buildSanArg(): string {
  const { dns, ip } = collectSanEntries();
  const parts: string[] = [];
  for (const d of dns) parts.push(`DNS:${d}`);
  for (const i of ip) parts.push(`IP:${i}`);
  return parts.join(",");
}

function computeFingerprint(certPem: Buffer | string): string {
  const text = certPem.toString("utf8");
  const match = text.match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/);
  if (!match) return "(unavailable)";
  const der = Buffer.from(match[1].replace(/\s+/g, ""), "base64");
  const hex = createHash("sha256").update(der).digest("hex").toUpperCase();
  return hex.match(/.{2}/g)!.join(":");
}

/**
 * 生成 self-signed 证书（OpenSSL 路径）。SAN 覆盖本机 hostname / LAN IP，
 * 这样从手机/局域网设备访问 `https://<LAN IP>:port/` 时不会撞 SAN 不匹配。
 */
function generateWithOpenSSL(paths: CertificatePaths): { key: Buffer; cert: Buffer } | null {
  try {
    execSync("openssl version", { stdio: "pipe" });

    const dir = path.dirname(paths.keyPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    execSync(`openssl genrsa -out "${paths.keyPath}" 2048`, { stdio: "pipe" });

    const san = buildSanArg();
    execSync(
      `openssl req -new -x509 -key "${paths.keyPath}" -out "${paths.certPath}" -days 825 ` +
        `-subj "/CN=wand-local/O=Wand Local Development" ` +
        `-addext "subjectAltName=${san}" ` +
        `-addext "extendedKeyUsage=serverAuth" ` +
        `-addext "basicConstraints=critical,CA:FALSE"`,
      { stdio: "pipe" }
    );

    return {
      key: readFileSync(paths.keyPath),
      cert: readFileSync(paths.certPath),
    };
  } catch {
    return null;
  }
}

/**
 * 没有 openssl 时的兜底：用 node 内置 crypto 生成 RSA 密钥，证书部分写一个
 * 明显的 placeholder PEM。这条路径产出的证书**无法被浏览器接受**，主要是为了
 * 不让 HTTPS 监听直接崩；启动日志会强烈建议用户装 openssl 或自备证书。
 */
function generateWithoutOpenSSL(paths: CertificatePaths): { key: Buffer; cert: Buffer } {
  const dir = path.dirname(paths.keyPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const { generateKeyPairSync } = require("node:crypto") as typeof import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const cert =
    "-----BEGIN CERTIFICATE-----\n" +
    "MIIBkTCB+wIJAKHBfPOPlvfoMA0GCSqGSIb3DQEBCwUAMBExDzANBgNVBAMMBnNh\n" +
    "bmRib3gwHhcNMjQwMTAxMDAwMDAwWhcNMjUwMTAxMDAwMDAwWjARMQ8wDQYDVQQD\n" +
    "DAZzYW5kYm94MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBALLgGbUPZxEvLPLXZQrz\n" +
    "KxLhP5EoaUuB7V8FYA5JQZbRE6RkxEKkR8jFQHOcQYevGQYEbXvKZ0WxR2BqMJsC\n" +
    "AwEAAaMgMB4wDQYJKoZIhvcNAQELBQADQQBpMq0NweMwF7fh0TiMwFCTzC/wK7fR\n" +
    "e0WxR2BqMJsC\n" +
    "-----END CERTIFICATE-----\n";

  writeFileSync(paths.keyPath, privateKey, { mode: 0o600 });
  writeFileSync(paths.certPath, cert, { mode: 0o644 });

  process.stderr.write(
    "\x1b[33m[wand] 警告：未检测到 openssl，写出的是无效占位证书。\n" +
    "[wand] 请安装 openssl，或在 config.json 里配 tls.certPath / tls.keyPath\n" +
    "[wand] 指向自备证书（推荐 mkcert：mkcert -install && mkcert localhost <hostname> <LAN-IP>）。\x1b[0m\n"
  );

  return { key: Buffer.from(privateKey), cert: Buffer.from(cert) };
}

/**
 * 主入口：装载 TLS 证书。优先级（高 → 低）：
 *   1. options.userCertPath / userKeyPath（config.tls）
 *   2. 配置目录下已存在的 server.crt + server.key
 *   3. 用 openssl 现场生成自签
 *   4. node crypto 兜底（产出非法证书，主要避免崩溃）
 */
export function ensureCertificates(
  configDir: string,
  options: EnsureCertificatesOptions = {},
): SSLConfig {
  // 1. 用户自备证书
  if (options.userCertPath && options.userKeyPath) {
    const pair = readPair(options.userKeyPath, options.userCertPath);
    if (pair) {
      const fingerprint = computeFingerprint(pair.cert);
      process.stdout.write(
        `[wand] 使用 config.tls 指定的证书：${options.userCertPath}\n` +
          `[wand] SHA-256 指纹: ${fingerprint}\n`
      );
      return { ...pair, certPath: options.userCertPath, fingerprint, userProvided: true };
    }
    process.stderr.write(
      `\x1b[33m[wand] 警告：config.tls 指向的证书文件无法读取（cert=${options.userCertPath}, key=${options.userKeyPath}），回退到默认自签流程。\x1b[0m\n`
    );
  }

  const paths = getCertificatePaths(configDir);

  // 2. 已存在的自签
  const existing = readPair(paths.keyPath, paths.certPath);
  if (existing) {
    return {
      ...existing,
      certPath: paths.certPath,
      fingerprint: computeFingerprint(existing.cert),
      userProvided: false,
    };
  }

  process.stdout.write("[wand] 正在生成 self-signed HTTPS 证书…\n");

  // 3. OpenSSL
  const ssl = generateWithOpenSSL(paths);
  if (ssl) {
    const fingerprint = computeFingerprint(ssl.cert);
    process.stdout.write(
      `[wand] 证书已写入 ${paths.certPath}\n` +
        `[wand] SHA-256 指纹: ${fingerprint}\n` +
        `[wand] 注意：自签证书浏览器会标红；PWA / Service Worker 需要把它导入受信任根证书才能工作。\n` +
        `[wand] HTTPS 启用后可通过 GET /cert/server.crt 在客户端下载安装。\n`
    );
    return { ...ssl, certPath: paths.certPath, fingerprint, userProvided: false };
  }

  // 4. 兜底
  process.stdout.write("[wand] 未检测到 openssl，使用 node crypto 兜底（产出占位证书，仅防崩）。\n");
  const fallback = generateWithoutOpenSSL(paths);
  return {
    ...fallback,
    certPath: paths.certPath,
    fingerprint: computeFingerprint(fallback.cert),
    userProvided: false,
  };
}
