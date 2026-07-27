import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, randomUUID, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { createSecureContext } from "node:tls";

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

function readPair(keyPath: string, certPath: string): { key: Buffer; cert: Buffer } | null {
  try {
    if (!existsSync(keyPath) || !existsSync(certPath)) return null;
    return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
  } catch {
    return null;
  }
}

function validateCertificatePair(pair: { key: Buffer; cert: Buffer }): string | null {
  try {
    // createSecureContext performs OpenSSL's full PEM parsing and key/certificate
    // consistency checks. checkPrivateKey keeps the mismatch failure explicit.
    createSecureContext({ key: pair.key, cert: pair.cert });
    const certificate = new X509Certificate(pair.cert);
    const privateKey = createPrivateKey(pair.key);
    if (!certificate.checkPrivateKey(privateKey)) return "证书与私钥不匹配";

    const now = Date.now();
    const validFrom = Date.parse(certificate.validFrom);
    const validTo = Date.parse(certificate.validTo);
    if (!Number.isFinite(validFrom) || !Number.isFinite(validTo)) return "证书有效期无法解析";
    if (now < validFrom) return "证书尚未生效";
    if (now >= validTo) return "证书已过期";
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function hardenGeneratedPair(paths: CertificatePaths): void {
  chmodSync(paths.keyPath, 0o600);
  chmodSync(paths.certPath, 0o600);
}

/**
 * 收集本机所有可外部访问的 IPv4 地址 + hostname，作为自签证书的 SAN。
 * 之前 SAN 只有 `localhost,127.0.0.1`，从手机/局域网用 `https://192.168.x.x` 访问
 * 时浏览器会直接拒绝（NET::ERR_CERT_COMMON_NAME_INVALID），连页面都打不开。
 */
function collectSanEntries(): { dns: string[]; ip: string[] } {
  const dns = new Set<string>(["localhost"]);
  const ip = new Set<string>(["127.0.0.1", "::1"]);
  const rawHostname = os.hostname().trim().toLowerCase().replace(/\.$/, "");
  // Hostnames originate outside this process and become part of OpenSSL's
  // extension grammar. Keep only RFC-style ASCII DNS labels.
  const hostname = rawHostname.length <= 253
    && rawHostname.split(".").every((label) => (
      label.length >= 1
      && label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    ))
    ? rawHostname
    : "";
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
        const address = entry.address.split("%")[0]; // 去掉 zone-id
        if (isIP(address) !== 0) ip.add(address);
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
function generateWithOpenSSL(paths: CertificatePaths): { key: Buffer; cert: Buffer } {
  const dir = path.dirname(paths.keyPath);
  ensurePrivateDirectory(dir);

  const suffix = `${process.pid}-${randomUUID()}`;
  const temporaryKeyPath = path.join(dir, `.server.key.${suffix}.tmp`);
  const temporaryCertPath = path.join(dir, `.server.crt.${suffix}.tmp`);
  const execOptions = {
    stdio: "pipe" as const,
    timeout: 15_000,
    windowsHide: true,
  };

  try {
    // Pre-create with private modes. OpenSSL truncates existing output files and
    // preserves their mode, so neither artifact is briefly world-readable.
    writeFileSync(temporaryKeyPath, "", { flag: "wx", mode: 0o600 });
    writeFileSync(temporaryCertPath, "", { flag: "wx", mode: 0o600 });

    execFileSync("openssl", ["version"], execOptions);
    execFileSync("openssl", ["genrsa", "-out", temporaryKeyPath, "2048"], execOptions);
    execFileSync("openssl", [
      "req",
      "-new",
      "-x509",
      "-key", temporaryKeyPath,
      "-out", temporaryCertPath,
      "-days", "825",
      "-subj", "/CN=wand-local/O=Wand Local Development",
      "-addext", `subjectAltName=${buildSanArg()}`,
      "-addext", "extendedKeyUsage=serverAuth",
      "-addext", "basicConstraints=critical,CA:FALSE",
    ], execOptions);

    chmodSync(temporaryKeyPath, 0o600);
    chmodSync(temporaryCertPath, 0o600);
    const pair = {
      key: readFileSync(temporaryKeyPath),
      cert: readFileSync(temporaryCertPath),
    };
    const validationError = validateCertificatePair(pair);
    if (validationError) {
      throw new Error(`OpenSSL 生成了不可用的证书：${validationError}`);
    }

    renameSync(temporaryKeyPath, paths.keyPath);
    renameSync(temporaryCertPath, paths.certPath);
    hardenGeneratedPair(paths);
    return pair;
  } finally {
    rmSync(temporaryKeyPath, { force: true });
    rmSync(temporaryCertPath, { force: true });
  }
}

/**
 * 主入口：装载 TLS 证书。优先级（高 → 低）：
 *   1. options.userCertPath / userKeyPath（config.tls）
 *   2. 配置目录下已存在的 server.crt + server.key
 *   3. 用 openssl 现场生成自签
 * 无法可靠生成时明确失败；绝不写入无效或与私钥不匹配的占位证书。
 */
export function ensureCertificates(
  configDir: string,
  options: EnsureCertificatesOptions = {},
): SSLConfig {
  // 1. 用户自备证书
  if (options.userCertPath && options.userKeyPath) {
    const pair = readPair(options.userKeyPath, options.userCertPath);
    if (pair) {
      const validationError = validateCertificatePair(pair);
      if (!validationError) {
        const fingerprint = computeFingerprint(pair.cert);
        process.stdout.write(
          `[wand] 使用 config.tls 指定的证书：${options.userCertPath}\n` +
            `[wand] SHA-256 指纹: ${fingerprint}\n`
        );
        return { ...pair, certPath: options.userCertPath, fingerprint, userProvided: true };
      }
      process.stderr.write(
        `\x1b[33m[wand] 警告：config.tls 指向的证书不可用（${validationError}），回退到默认自签流程。\x1b[0m\n`
      );
    } else {
      process.stderr.write(
        `\x1b[33m[wand] 警告：config.tls 指向的证书文件无法读取（cert=${options.userCertPath}, key=${options.userKeyPath}），回退到默认自签流程。\x1b[0m\n`
      );
    }
  }

  const paths = getCertificatePaths(configDir);

  // 2. 已存在的自签
  const existing = readPair(paths.keyPath, paths.certPath);
  if (existing) {
    const validationError = validateCertificatePair(existing);
    if (!validationError) {
      ensurePrivateDirectory(path.dirname(paths.keyPath));
      hardenGeneratedPair(paths);
      return {
        ...existing,
        certPath: paths.certPath,
        fingerprint: computeFingerprint(existing.cert),
        userProvided: false,
      };
    }
    process.stderr.write(
      `\x1b[33m[wand] 警告：已有自签证书不可用（${validationError}），正在重新生成。\x1b[0m\n`
    );
  }

  process.stdout.write("[wand] 正在生成 self-signed HTTPS 证书…\n");

  // 3. OpenSSL
  try {
    const ssl = generateWithOpenSSL(paths);
    const fingerprint = computeFingerprint(ssl.cert);
    process.stdout.write(
      `[wand] 证书已写入 ${paths.certPath}\n` +
        `[wand] SHA-256 指纹: ${fingerprint}\n` +
        `[wand] 注意：自签证书浏览器会标红；可将它导入受信任根证书以消除警告。\n` +
        `[wand] HTTPS 启用后可通过 GET /cert/server.crt 在客户端下载安装。\n`
    );
    return { ...ssl, certPath: paths.certPath, fingerprint, userProvided: false };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      "无法生成 HTTPS 证书：需要可用的 OpenSSL，或在 config.tls 中配置有效且匹配的 certPath/keyPath。" +
      ` OpenSSL 错误：${detail}`,
      { cause: error },
    );
  }
}
